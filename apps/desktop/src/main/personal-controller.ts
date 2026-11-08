import * as https from "node:https";
import * as http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WebSocket } from "ws";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { serializeFailure } from "./controller.ts";
import { DesktopError } from "./environment.ts";
import { savePersonalConfig, validatePersonalConfig, personalProfile, personalPendingFile, readPersonalRecord, writePersonalRecord, type PersonalTargetConfig } from "./personal-config.ts";
import type { PersonalCredentialStorage } from "./personal-credentials.ts";
import { personalOutputMetadata, readPersonalOutput, verifyPersonalOutputAccess } from "./personal-outputs.ts";
import { personalAttachments, uploadPersonalAttachments } from "./attachments.ts";
import type { DesktopUpdate } from "../shared/bridge.ts";
import type { PersonalDesktopApproval } from "@ruukoto/view/personal-protocol.ts";
import type { PersonalDesktopFrame, PersonalRemoteIdentity, PersonalPendingInput, PersonalInputDraft, PersonalInputReceipt, PersonalPendingDecision, PersonalDesktopAction, PersonalDesktopActionReceipt } from "../shared/personal-desktop.ts";
import type { PersonalDesktopAttachment } from "@ruukoto/view/personal-protocol.ts";

type Secret = { id: string; secret: string; origin: string };
type Active = Secret & { remoteId: string; profile: PersonalRemoteIdentity["profile"] };
type Candidate = Secret & { request: { v: 1; code: string; label: string }; rejected?: true };
type Credentials = { v: 1; active?: Active; candidate?: Candidate };
type Pending = { v: 1; input: PersonalPendingInput | null; draft?: PersonalInputDraft; decisions?: PersonalPendingDecision[]; actions?: PersonalDesktopAction[]; maintenance?: { id: string; requestDigest: string }; settings?: { id: string; requestDigest: string; target: string; scope: string }[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const failed = (code: string, message: string, outcome: "not_sent" | "unknown" | "rejected" = "not_sent") => new ControlClientError(code, message, outcome);
const bindingMatches = (identity: PersonalRemoteIdentity, binding: { remoteId: string; profile: PersonalRemoteIdentity["profile"] }) => identity.remoteId === binding.remoteId && isDeepStrictEqual(identity.profile, binding.profile);
const READ_PATHS = ["/status", "/timeline", "/history/entry", "/desktop/state", "/desktop/operation", "/desktop/action", "/desktop/input", "/delegations", "/delegation", "/delegation/report", "/input", "/permissions", "/questions", "/question", "/question/receipt", "/works", "/work", "/tools/operations", "/tools/operation", "/mcp/operations", "/mcp/operation", "/app-data/operations", "/app-data/operation", "/services", "/service"];
const WRITE_PATHS = ["/permissions", "/desktop/action", "/question/answer", "/question/cancel", "/work/cancel", "/delegation/cancel", "/tools/decide", "/mcp/decide", "/mcp/end", "/app-data/decide", "/service/decide"];
const FAMILIES = ["tools", "mcp", "app-data", "services", "inspections", "commands", "browser", "background", "questions"];
const ACTIONS = ["approve", "reject", "answer", "cancel_question", "check", "cleanup", "claim_applied", "claim_not_applied", "end_unknown", "resume", "observe", "accept", "stop_sandbox"];
const DECISION_PATHS = new Map<string, PersonalPendingDecision["kind"]>([["/tools/decide", "tools"], ["/mcp/decide", "mcp"], ["/app-data/decide", "app-data"], ["/service/decide", "services"]]);
const DETAIL_PATHS = new Map<string, PersonalPendingDecision["kind"]>([["/tools/operation", "tools"], ["/mcp/operation", "mcp"], ["/app-data/operation", "app-data"], ["/service", "services"]]);
const KNOWN_REJECTIONS = new Set(["remote_request_invalid", "remote_maintenance_request_invalid", "remote_maintenance_pending", "settings_pending", "settings_revision_changed", "settings_revision_conflict", "settings_target_pending", "settings_request_conflict", "settings_request_invalid", "settings_upgrade_required", "settings_profile_changed", "settings_file_unverified", "skills_revision_conflict", "settings_stop_required", "profile_busy", "maintenance_read_only", "model_environment_unverified", "input_invalid", "input_conflict", "mcp_end_unavailable", "mcp_end_invalid", "mcp_missing", "mcp_original_entry", "desktop_action_invalid", "desktop_action_stale", "desktop_action_original_entry", "desktop_action_conflict", "desktop_action_unavailable"]);
const ATTACHMENT_REJECTIONS = new Set(["attachment_invalid", "attachment_incomplete", "attachment_conflict", "attachment_offset", "attachment_hash", "attachment_bound", "media_input_conflict", "image_input_unsupported", "mime_mismatch", "mime_unsupported", "too_many_files", "file_too_large"]);
const authorization = (value: Secret) => `Bearer ${value.id}.${value.secret}`;
function parseCredentials(raw: string | null): Credentials {
  if (raw === null) return { v: 1 };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw failed("personal_credentials_invalid", "The secure-storage record is corrupt; keep the original record and verify the original pairing on the server."); }
  if (!object(value) || value.v !== 1 || Object.keys(value).some(key => !["v", "active", "candidate"].includes(key))) throw failed("personal_credentials_invalid", "The secure-storage record version is invalid; keep the original pairing record and check the client version.");
  for (const key of ["active", "candidate"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    if (!object(item) || typeof item.id !== "string" || !UUID.test(item.id) || typeof item.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(item.secret) || Buffer.from(item.secret, "base64url").toString("base64url") !== item.secret || typeof item.origin !== "string" || validatePersonalConfig({ origin: item.origin }).origin !== item.origin) throw failed("personal_credentials_invalid", "The original credential in secure storage can't be verified; check the original pairing on the server.");
    if (key === "active" && (typeof item.remoteId !== "string" || !UUID.test(item.remoteId) || !personalProfile(item.profile)) || key === "candidate" && (item.rejected !== undefined && item.rejected !== true || !object(item.request) || item.request.v !== 1 || typeof item.request.code !== "string" || !/^[A-Z2-7]{12}$/.test(item.request.code) || typeof item.request.label !== "string" || !item.request.label.trim() || item.request.label.length > 80)) throw failed("personal_credentials_invalid", "The original pairing association in secure storage is invalid; keep the original record and verify it on the server.");
  }
  return value as Credentials;
}
function parseIdentity(value: unknown, origin: string): PersonalRemoteIdentity {
  if (!object(value) || value.v !== 1 || value.product !== "ruukoto" || value.origin !== origin || typeof value.remoteId !== "string" || !UUID.test(value.remoteId) || !personalProfile(value.profile) || typeof value.online !== "boolean" || value.online && typeof value.runId !== "string" || value.runId !== undefined && (typeof value.runId !== "string" || !value.runId || value.runId.length > 128)) throw failed("personal_protocol", "The remote entry's product, protocol or ownership doesn't match and the connection stopped; verify the address and version.");
  return value as PersonalRemoteIdentity;
}
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const desktopModel = (value: unknown) => object(value) && typeof value.provider === "string" && typeof value.modelId === "string";
function desktopBlock(value: unknown): boolean {
  return object(value) && typeof value.truncated === "boolean" && (["text", "thinking"].includes(String(value.type)) && typeof value.text === "string" || value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string" && typeof value.arguments === "string");
}
function desktopMessage(value: unknown): boolean {
  return object(value) && ["user", "assistant", "toolResult"].includes(String(value.role)) && typeof value.text === "string" && typeof value.partial === "boolean" && typeof value.truncated === "boolean" && timestamp(value.timestamp) && (value.thinking === undefined || typeof value.thinking === "string") && (value.toolCallId === undefined || typeof value.toolCallId === "string") && (value.toolName === undefined || typeof value.toolName === "string") && (value.isError === undefined || typeof value.isError === "boolean") && (value.blocks === undefined || Array.isArray(value.blocks) && value.blocks.every(block => object(block) && integer(block.index) && desktopBlock(block))) && (value.toolCalls === undefined || Array.isArray(value.toolCalls) && value.toolCalls.every(call => object(call) && typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string" && typeof call.truncated === "boolean"));
}
function desktopEntry(value: unknown): boolean { return object(value) && integer(value.entry) && integer(value.conversation) && typeof value.kind === "string" && desktopMessage(value) && (value.attachments === undefined || personalAttachments(value.attachments)) && (value.outputs === undefined || Array.isArray(value.outputs) && value.outputs.length <= 8 && value.outputs.every(output => personalOutputMetadata(output) && output.publication === value.entry)) && (value.input === undefined || object(value.input) && typeof value.input.requestId === "string" && integer(value.input.submission) && ["queued", "placed", "done", "unanswered"].includes(String(value.input.status)) && (value.input.historyEntry === undefined || integer(value.input.historyEntry))); }
function desktopApproval(value: unknown): boolean {
  return object(value) && [value.operation, value.occurrence, value.admission].every(integer) && ["read_file", "write_file", "http_request", "web_search", "list_files", "search_files", "service_restart", "service_inspect", "app_data", "run_command", "browser", "cua", "process"].includes(String(value.kind)) && (value.family === undefined || FAMILIES.includes(String(value.family))) && typeof value.target === "string" && value.target.length <= 512 && ["pending", "approved", "rejected", "unneeded"].includes(String(value.approval)) && ["returned", "not_executed", "no_write", "effect_unknown", "committed", "not_committed"].includes(String(value.effect)) && typeof value.code === "string" && [value.observed, value.started, value.stopped, value.canDecide, value.targetTruncated].every(item => typeof item === "boolean") && (value.notice === undefined || typeof value.notice === "string") && (value.work === undefined || integer(value.work)) && (value.decisionEntry === undefined || integer(value.decisionEntry)) && (value.actions === undefined || Array.isArray(value.actions) && value.actions.length <= ACTIONS.length && value.actions.every(action => ACTIONS.includes(String(action)))) && (value.check === undefined || desktopCheck(value.check)) && (value.claim === undefined || object(value.claim) && integer(value.claim.entry) && ["applied", "not_applied"].includes(String(value.claim.effect)) && timestamp(value.claim.at)) && (value.observation === undefined || integer(value.observation)) && (value.images === undefined || Array.isArray(value.images) && value.images.length <= 8 && value.images.every(image => object(image) && typeof image.id === "string" && ["image/png", "image/jpeg", "image/webp"].includes(String(image.mime)) && typeof image.sha256 === "string" && /^[0-9a-f]{64}$/.test(image.sha256) && integer(image.bytes) && Number(image.bytes) <= 8 * 1024 * 1024 && typeof image.partial === "boolean"));
}
function desktopCheck(value: unknown): boolean { return object(value) && integer(value.entry) && ["receipt", "observation"].includes(String(value.kind)) && typeof value.code === "string" && typeof value.text === "string" && value.text.length <= 4096; }
function desktopQuestion(value: unknown): boolean { return object(value) && typeof value.id === "string" && /^[1-9][0-9]*$/.test(value.id) && integer(value.version) && Number(value.version) > 0 && ["pending", "answered", "canceled", "stale"].includes(String(value.status)) && typeof value.question === "string" && value.question.length <= 512 && typeof value.canAnswer === "boolean" && typeof value.canCancel === "boolean" && integer(value.admission) && integer(value.occurrence) && (value.work === undefined || integer(value.work)); }
function desktopAction(value: unknown): value is PersonalDesktopAction {
  if (!object(value) || Object.keys(value).some(key => !["v", "requestId", "family", "operation", "admission", "occurrence", "action", "questionVersion", "answers", "observation", "check"].includes(key)) || value.v !== 1 || typeof value.requestId !== "string" || !UUID.test(value.requestId) || !FAMILIES.includes(String(value.family)) || ![value.operation, value.admission, value.occurrence].every(item => integer(item) && Number(item) > 0) || !ACTIONS.includes(String(value.action))) return false;
  if ((value.action === "answer" || value.action === "cancel_question") !== (value.family === "questions") || value.family === "questions" && (!integer(value.questionVersion) || Number(value.questionVersion) < 1) || value.family !== "questions" && value.questionVersion !== undefined) return false;
  if (value.action === "answer") {
    if (!Array.isArray(value.answers) || !value.answers.length || value.answers.length > 3 || value.answers.some(answer => !object(answer) || Object.keys(answer).some(key => !["text", "option", "options"].includes(key)) || typeof answer.text !== "string" || answer.text.length > 4096 || answer.option !== undefined && !integer(answer.option) || answer.options !== undefined && (!Array.isArray(answer.options) || answer.options.length > 5 || !answer.options.every(integer)))) return false;
  } else if (value.answers !== undefined) return false;
  return (value.observation === undefined || value.action === "accept" && integer(value.observation) && Number(value.observation) > 0) && (value.action !== "accept" || value.observation !== undefined) && (value.check === undefined || ["claim_applied", "claim_not_applied"].includes(String(value.action)) && integer(value.check) && Number(value.check) > 0);
}
function desktopActionReceipt(value: unknown): value is PersonalDesktopActionReceipt { return object(value) && value.v === 1 && desktopAction(value.request) && integer(value.entry) && Number(value.entry) > 0 && ["admitted", "completed", "failed", "effect_unknown"].includes(String(value.state)) && (value.code === undefined || typeof value.code === "string") && (value.check === undefined || desktopCheck(value.check)); }
function desktopWork(value: unknown): boolean {
  return object(value) && object(value.ref) && [value.ref.taskId, value.ref.agentId].every(integer) && typeof value.ref.requestId === "string" && [value.label, value.content, value.state].every(item => typeof item === "string") && [value.cancelRequested, value.stopVerified, value.closed].every(item => typeof item === "boolean") && object(value.progress) && [value.progress.accepted, value.progress.modelRead, value.progress.completed, value.progress.accounted].every(integer) && (value.delegation === undefined || integer(value.delegation));
}
function desktopDelegation(value: unknown): boolean {
  return object(value) && object(value.ref) && integer(value.ref.entryId) && typeof value.content === "string" && typeof value.state === "string" && [value.total, value.active, value.unverified].every(integer) && typeof value.cancelRequested === "boolean" && typeof value.paused === "boolean" && (value.report === undefined || object(value.report) && typeof value.report.delivery === "string" && typeof value.report.state === "string" && (value.report.publication === undefined || integer(value.report.publication)));
}
function desktopPage(value: unknown, item: (value: unknown) => boolean): boolean { return object(value) && Array.isArray(value.items) && value.items.length <= 8 && value.items.every(item) && integer(value.total) && Number(value.total) >= value.items.length && (value.nextOffset === undefined || integer(value.nextOffset)); }
function desktopState(value: unknown): boolean { return object(value) && value.v === 1 && integer(value.revision) && desktopPage(value.approvals, desktopApproval) && desktopPage(value.works, desktopWork) && desktopPage(value.delegations, desktopDelegation) && (value.questions === undefined || desktopPage(value.questions, desktopQuestion)) && (value.approvalUpdates === undefined || Array.isArray(value.approvalUpdates) && value.approvalUpdates.length <= 8 && value.approvalUpdates.every(desktopApproval)) && (value.questionUpdates === undefined || Array.isArray(value.questionUpdates) && value.questionUpdates.length <= 8 && value.questionUpdates.every(desktopQuestion)); }
function decisionSummary(value: unknown, kind: PersonalPendingDecision["kind"]): boolean {
  if (!object(value) || typeof value.canDecide !== "boolean") return false;
  if (kind === "services") return object(value.ref) && integer(value.ref.taskId) && typeof value.ref.requestId === "string" && typeof value.unit === "string" && typeof value.status === "string" && typeof value.canResolve === "boolean" && typeof value.canRecheck === "boolean";
  if (!integer(value.operation) || typeof value.code !== "string") return false;
  if (kind === "tools") return ["read_file", "write_file", "http_request", "web_search", "list_files", "search_files"].includes(String(value.kind)) && typeof value.target === "string" && typeof value.stopped === "boolean" && ["pending", "approved", "rejected", "unneeded"].includes(String(value.approval)) && ["returned", "not_executed", "no_write", "effect_unknown"].includes(String(value.effect));
  if (!["pending", "approved", "rejected", "unneeded"].includes(String(value.decision))) return false;
  return kind === "mcp" ? typeof value.service === "string" && typeof value.tool === "string" && typeof value.started === "boolean" && typeof value.remoteEnded === "boolean" && ["returned", "not_executed", "no_write", "effect_unknown"].includes(String(value.effect)) : typeof value.name === "string" && typeof value.canRecheck === "boolean" && ["committed", "not_committed", "effect_unknown"].includes(String(value.effect));
}
function desktopEvent(value: unknown): boolean {
  if (!object(value) || typeof value.type !== "string") return false;
  if (value.type === "personal_state") return desktopState(value.state);
  if (value.type === "message_start") return desktopMessage(value.message);
  if (value.type === "message_end" || value.type === "entry_appended") return desktopEntry(value.entry);
  if (value.type === "message_update") return Array.isArray(value.changes) && value.changes.every(change => {
    if (!object(change)) return false;
    if (change.type === "message") return desktopMessage(change.message);
    if (!integer(change.contentIndex)) return false;
    if (["text_start", "thinking_start", "toolcall_start", "block"].includes(String(change.type))) return desktopBlock(change.block);
    return ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(change.type)) && typeof change.delta === "string" && typeof change.truncated === "boolean" && (change.type !== "toolcall_delta" || Array.isArray(change.path) && change.path.every(part => typeof part === "string" || integer(part)));
  });
  if (value.type === "run_start" || value.type === "run_end") return Array.isArray(value.inputs) && value.inputs.every(integer) && integer(value.total);
  if (value.type === "inbox_update") return Array.isArray(value.items) && value.items.every(item => object(item) && integer(item.id) && typeof item.mode === "string") && integer(value.total);
  if (value.type === "submission") return object(value.record) && integer(value.record.id) && typeof value.record.status === "string" && (value.record.entry === undefined || integer(value.record.entry)) && (value.record.answer === undefined || integer(value.record.answer));
  if (value.type.startsWith("tool_execution_")) {
    if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string" || value.taskId !== undefined && !integer(value.taskId) || value.parentToolCallId !== undefined && typeof value.parentToolCallId !== "string" || value.parentTaskId !== undefined && !integer(value.parentTaskId)) return false;
    if (value.type === "tool_execution_start") return typeof value.arguments === "string" && typeof value.truncated === "boolean";
    if (value.type === "tool_execution_update") return typeof value.truncated === "boolean" && (value.output === undefined || object(value.output) && (value.output.set === undefined || typeof value.output.set === "string") && (value.output.append === undefined || typeof value.output.append === "string") && (value.output.trimStart === undefined || integer(value.output.trimStart)));
    return value.type === "tool_execution_end" && (value.entry === undefined || desktopEntry(value.entry)) && (value.result === undefined || object(value.result) && typeof value.result.text === "string" && typeof value.result.truncated === "boolean" && typeof value.result.isError === "boolean");
  }
  if (value.type === "agent_changed") return value.model === undefined || desktopModel(value.model);
  if (value.type === "task_failed") return integer(value.taskId) && typeof value.message === "string" && typeof value.kind === "string";
  if (value.type === "auto_retry_start") return integer(value.attempt) && timestamp(value.at) && typeof value.errorMessage === "string";
  if (value.type === "auto_retry_end") return integer(value.attempt);
  if (value.type === "deferred_poll") return timestamp(value.pollAt);
  if (value.type === "compaction_start" || value.type === "compaction_end") return integer(value.taskId) && typeof value.reason === "string" && (value.type === "compaction_start" ? typeof value.blocking === "boolean" : value.error === undefined || typeof value.error === "string");
  return value.type === "turn_start" || value.type === "turn_end";
}
function desktopSnapshot(value: Record<string, unknown>): boolean {
  if (!object(value.timeline) || !integer(value.timeline.through) || !Array.isArray(value.timeline.items) || !value.timeline.items.every(desktopEntry) || value.timeline.nextCursor !== undefined && typeof value.timeline.nextCursor !== "string" || !object(value.live) || value.state !== undefined && !desktopState(value.state)) return false;
  const live = value.live;
  return Array.isArray(live.tools) && live.tools.every(tool => object(tool) && typeof tool.callId === "string" && typeof tool.name === "string" && ["pending", "running", "done"].includes(String(tool.status)) && typeof tool.truncated === "boolean" && (tool.output === undefined || typeof tool.output === "string") && (tool.taskId === undefined || integer(tool.taskId)) && (tool.entry === undefined || integer(tool.entry)) && (tool.parentCallId === undefined || typeof tool.parentCallId === "string") && (tool.parentTaskId === undefined || integer(tool.parentTaskId))) && integer(live.toolCount) && Array.isArray(live.inbox) && live.inbox.every(item => object(item) && integer(item.id) && typeof item.mode === "string") && integer(live.inboxCount) && (live.model === undefined || desktopModel(live.model)) && (live.run === undefined || object(live.run) && Array.isArray(live.run.inputs) && live.run.inputs.every(integer) && integer(live.run.total)) && (live.generation === undefined || object(live.generation) && integer(live.generation.attempt) && (live.generation.message === undefined || desktopMessage(live.generation.message)) && (live.generation.retry === undefined || object(live.generation.retry) && timestamp(live.generation.retry.at) && typeof live.generation.retry.error === "string") && (live.generation.deferred === undefined || object(live.generation.deferred) && timestamp(live.generation.deferred.pollAt)));
}

// Note: See .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
// Note: See .agents/notes/implemented/feature/2026-11-04-personal-desktop-file-loop.md
// Note: See .agents/notes/implemented/feature/2026-11-05-personal-desktop-decisions.md
// Note: See .agents/notes/implemented/architecture/2026-11-07-personal-inbound-attachments.md
export class PersonalController {
  config: PersonalTargetConfig;
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "closed", detail: "Not connected" };
  private identity: PersonalRemoteIdentity | null = null;
  private credentials: Credentials = { v: 1 };
  private ws: WebSocket | null = null;
  private readonly requests = new Set<http.ClientRequest>();
  private generation = 0;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private pong: NodeJS.Timeout | null = null;
  private delay = 500;
  private connecting: Promise<void> | null = null;
  private credentialOperation: Promise<unknown> | null = null;
  private switching = false;
  private inspectingActions: Promise<void> | null = null;
  private inputOperation = false;
  private attachmentSelection: { id: string; generation: number; identity: PersonalRemoteIdentity | null; draft: PersonalInputDraft } | null = null;
  constructor(config: PersonalTargetConfig, private readonly userData: string, private readonly publish: (update: DesktopUpdate) => void, private readonly storage: PersonalCredentialStorage | undefined, private readonly deps: { agent?: https.Agent } = {}) { this.config = validatePersonalConfig(config); }
  private current(generation: number): boolean { return !this.closed && generation === this.generation; }
  private state(value: Extract<DesktopUpdate, { type: "state" }>): void { this.status = value; this.publish(value); }
  private stopObservation(): void {
    if (this.retry) clearTimeout(this.retry); if (this.heartbeat) clearInterval(this.heartbeat); if (this.pong) clearTimeout(this.pong);
    this.retry = null; this.heartbeat = null; this.pong = null;
    const ws = this.ws; this.ws = null; ws?.terminate();
  }
  private terminal(error: unknown): void {
    this.stopObservation(); ++this.generation;
    const failure = serializeFailure(error);
    for (const item of [this.credentials.active, this.credentials.candidate]) if (item) failure.message = failure.message.replaceAll(item.secret, "[credential hidden]");
    this.state({ type: "state", state: "failed", error: failure, detail: failure.message });
  }
  private fatal(error: unknown): boolean {
    return error instanceof ControlClientError && (error.code.startsWith("remote_auth") || error.code.startsWith("remote_backend") || error.code.startsWith("remote_credential") || error.code.startsWith("remote_source") || error.code.startsWith("remote_binding") || error.code.startsWith("remote_profile") || error.code.startsWith("personal_protocol") || error.code.startsWith("personal_identity") || error.code.startsWith("personal_tls") || error.code === "personal_redirect");
  }
  private disconnected(generation: number): void {
    if (!this.current(generation)) return;
    ++this.generation; this.stopObservation();
    this.state({ type: "state", state: "reconnecting", detail: "Connection lost; backend work continues. Restoring observation." });
    const delay = this.delay; this.delay = Math.min(delay * 2, 8000);
    this.retry = setTimeout(() => { this.retry = null; void this.reconnect(); }, Math.round(delay * (0.8 + Math.random() * 0.4)));
  }
  private async readCredentials(): Promise<Credentials> {
    if (!this.storage) throw failed("personal_credentials_unavailable", "This desktop has no usable secure storage; use an app build that supports secure pairing.");
    let raw: string | null;
    try { raw = await this.storage.read(); } catch { throw failed("personal_credentials_unavailable", "Secure storage is temporarily unreadable; unlock it or restore app authorization and reconnect. The original record is kept."); }
    return parseCredentials(raw);
  }
  private async saveCredentials(value: Credentials): Promise<void> {
    if (!this.storage) throw failed("personal_credentials_unavailable", "This desktop has no usable secure storage; the pairing request wasn't sent.");
    const raw = JSON.stringify(value);
    try { await this.storage.write(raw); } catch { throw failed("personal_credentials_unavailable", "Secure storage couldn't save; restore authorization and verify the original pairing. No new pairing request was sent."); }
    let saved: string | null;
    try { saved = await this.storage.read(); } catch { throw failed("personal_credentials_unavailable", "The secure-storage read-back is unverified; keep the original record and restore authorization. No new pairing request was sent."); }
    if (saved !== raw) throw failed("personal_credentials_invalid", "The secure-storage read-back differs from the original record and no pairing request was sent; verify the original pairing on the server.");
    this.credentials = value;
  }
  private exchange(method: "GET" | "POST", route: string, body: unknown, secret: Secret, bound = true): Promise<unknown> {
    if (this.closed || secret.origin !== this.config.origin) return Promise.reject(failed("personal_identity_changed", "The secure credential doesn't belong to the current address and the request wasn't sent; pair again."));
    const url = new URL(route, this.config.origin);
    if (!route.startsWith("/") || route.startsWith("//") || url.origin !== this.config.origin || url.hash) return Promise.reject(failed("op_not_allowed", "This remote path isn't open to the desktop."));
    const raw = body === undefined ? method === "POST" ? "{}" : undefined : JSON.stringify(body);
    if (raw !== undefined && Buffer.byteLength(raw) > 128 * 1024) return Promise.reject(failed("personal_request_large", "The request exceeds the limit; shrink the body or configuration."));
    const identity = this.identity;
    const generation = this.generation;
    if (bound && (!identity || !("remoteId" in secret) || !bindingMatches(identity, secret as Active))) return Promise.reject(failed("personal_identity_changed", "The original archive isn't verified yet; the business request wasn't sent."));
    return new Promise((resolve, reject) => {
      let sent = false;
      const req = https.request(url, { method, agent: this.deps.agent, headers: { authorization: authorization(secret), "content-type": "application/json", ...(bound && identity ? { "x-ruukoto-remote-id": identity.remoteId, "x-ruukoto-profile-id": identity.profile.id } : {}) } });
      this.requests.add(req);
      const fail = (error: ControlClientError) => { const safe = new ControlClientError(error.code, error.message.replaceAll(secret.secret, "[credential hidden]"), error.outcome); reject(safe); if (this.fatal(safe) && this.current(generation) && this.identity === identity) this.terminal(safe); };
      req.once("finish", () => { sent = true; });
      req.once("close", () => this.requests.delete(req));
      req.setTimeout(method === "POST" ? 35_000 : 10_000, () => req.destroy(new Error("timeout")));
      req.once("error", (error: NodeJS.ErrnoException) => {
        const tls = /^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED)/.test(error.code ?? "");
        fail(failed(tls ? "personal_tls" : "personal_connection_lost", tls ? "TLS certificate verification failed and the connection stopped; verify the address and system trust configuration." : "No remote response; verify the original request. It won't resend automatically.", tls || !sent ? "not_sent" : "unknown"));
      });
      req.on("response", res => {
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { res.resume(); fail(failed("personal_redirect", "The remote entry returned a redirect and the connection stopped; enter the final HTTPS address.", method === "POST" ? "unknown" : "not_sent")); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) { res.destroy(); fail(failed("personal_response_large", "The remote response exceeds the limit; verify the original request. It won't resend automatically.", method === "POST" ? "unknown" : "not_sent")); } else chunks.push(chunk); });
        res.once("error", () => fail(failed("personal_connection_lost", "The remote response was interrupted; verify the original request. It won't resend automatically.", method === "POST" ? "unknown" : "not_sent")));
        res.once("end", () => {
          let value: unknown;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(failed("personal_protocol", "The remote response can't be parsed; verify the original request and version.", method === "POST" ? "unknown" : "not_sent")); return; }
          if (!object(value) || value.v !== 1 || value.product !== "ruukoto" || typeof value.ok !== "boolean") { fail(failed("personal_protocol", "The remote product or protocol doesn't match and the connection stopped; verify the original request and version.", method === "POST" ? "unknown" : "not_sent")); return; }
          if (value.ok === false && typeof value.code === "string" && typeof value.message === "string") {
            const rejected = KNOWN_REJECTIONS.has(value.code) || ["/desktop/attachment", "/desktop/inputs"].includes(route) && ATTACHMENT_REJECTIONS.has(value.code);
            fail(failed(value.code, value.message, (res.statusCode ?? 0) >= 500 || method === "POST" && !rejected || value.code.includes("unverified") || value.code.includes("response_lost") || value.code.includes("response_large") || value.code.includes("internal") ? "unknown" : "rejected")); return;
          }
          if (!value.ok || !Object.hasOwn(value, "result") || ![200, 202].includes(res.statusCode ?? 0)) { fail(failed("personal_protocol", "The remote response status is invalid; verify the original request.", method === "POST" ? "unknown" : "not_sent")); return; }
          resolve(value.result);
        });
      });
      req.end(raw);
    });
  }
  private checkIdentity(value: unknown, secret: Active | Candidate): PersonalRemoteIdentity {
    const identity = parseIdentity(value, this.config.origin);
    if ("remoteId" in secret && (!bindingMatches(identity, secret) || this.config.binding && !bindingMatches(identity, this.config.binding))) throw failed("personal_identity_changed", "The remote instance or archive ownership changed and the connection stopped; verify on the server and pair again.");
    return identity;
  }
  private persistBinding(identity: PersonalRemoteIdentity): void {
    const binding = { remoteId: identity.remoteId, profile: identity.profile };
    if (isDeepStrictEqual(this.config.binding, binding)) return;
    if (this.config.binding && (this.pending().input || this.pending().maintenance || this.pending().settings?.length || this.pending().decisions?.length || this.pending().actions?.length)) throw failed("personal_pending", "The original archive still has unverified requests; verify the original input, decisions and maintenance first.");
    this.config = savePersonalConfig(this.userData, { v: 1, origin: this.config.origin, binding });
  }
  private adopt(identity: PersonalRemoteIdentity): void {
    this.persistBinding(identity);
    this.identity = identity;
    this.publish({ type: "personal_identity", identity });
    this.publish({ type: "personal_draft", draft: this.inputDraft() });
    this.publish({ type: "personal_decisions", items: this.pending().decisions ?? [] });
    this.publish({ type: "personal_actions", items: this.pending().actions ?? [] });
  }
  reconnect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const generation = ++this.generation; this.stopObservation();
    this.state({ type: "state", state: "connecting" });
    this.connecting = (async () => {
      try {
        this.credentials = await this.readCredentials();
        const candidate = this.credentials.candidate;
        if (candidate?.origin === this.config.origin && !candidate.rejected) await this.credentialExclusive(() => this.completeCandidate(candidate));
        const active = this.credentials.active;
        if (!active || active.origin !== this.config.origin) throw failed(this.credentials.candidate?.origin === this.config.origin ? "personal_pairing_pending" : "personal_pairing_required", this.credentials.candidate?.origin === this.config.origin ? "The original pairing outcome is unverified; verify the original candidate credential — a new one won't be generated." : "Open a pairing window on the server, then enter the pairing code.");
        const identity = this.checkIdentity(await this.exchange("GET", "/handshake", undefined, active, false), active);
        if (!this.current(generation)) return;
        this.adopt(identity); this.delay = 500;
        this.state({ type: "state", state: "online", detail: identity.online ? "Connected to the Personal Agent" : "Connected to the remote entry; the personal backend is currently offline." });
        if (identity.online) await this.reconcileInput();
        else this.publish({ type: "personal_pending", record: this.pending().input });
        if (!this.current(generation)) return;
        if (identity.online) this.observe(generation, active, identity);
        else this.retry = setTimeout(() => { this.retry = null; void this.reconnect(); }, 2000);
        if (identity.online) void this.reconcileActions();
      } catch (error) {
        if (!this.current(generation)) return;
        if (error instanceof ControlClientError && error.code === "personal_connection_lost") this.disconnected(generation);
        else this.terminal(error);
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private observe(generation: number, active: Active, identity: PersonalRemoteIdentity): void {
    const ws = new WebSocket(this.config.origin.replace(/^https:/, "wss:") + "/events", { agent: this.deps.agent, headers: { authorization: authorization(active), "x-ruukoto-remote-id": identity.remoteId, "x-ruukoto-profile-id": identity.profile.id }, handshakeTimeout: 10_000, maxPayload: 256 * 1024, followRedirects: false });
    this.ws = ws;
    let subscription: string | null = null, seq = -1;
    ws.on("error", (error: NodeJS.ErrnoException) => { if (this.current(generation) && /^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED)/.test(error.code ?? "")) this.terminal(failed("personal_tls", "TLS certificate verification failed and observation stopped; verify the address and system trust configuration.")); });
    ws.on("unexpected-response", (_request, res) => { res.resume(); if (this.current(generation)) this.terminal(failed("personal_protocol", "The remote observation handshake was rejected and the connection stopped; verify the app credentials and protocol.")); });
    ws.on("open", () => {
      if (!this.current(generation)) { ws.terminate(); return; }
      this.heartbeat = setInterval(() => { if (ws.readyState !== WebSocket.OPEN) return; ws.ping(); this.pong = setTimeout(() => ws.terminate(), 10_000); }, 30_000);
    });
    ws.on("pong", () => { if (this.pong) clearTimeout(this.pong); this.pong = null; });
    ws.on("message", (data, binary) => {
      if (!this.current(generation) || this.ws !== ws) return;
      let value: unknown;
      try { value = JSON.parse(data.toString()); } catch { this.terminal(failed("personal_protocol", "The remote observation frame can't be parsed; check the version and reconnect.")); return; }
      if (binary || !object(value) || value.v !== 1 || typeof value.runId !== "string" || typeof value.subscription !== "string" || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0 || value.type !== "snapshot" && value.type !== "events" || value.type === "snapshot" && !desktopSnapshot(value) || value.type === "events" && (!Array.isArray(value.events) || !value.events.every(desktopEvent))) { this.terminal(failed("personal_protocol", "The remote observation protocol is invalid; check the version and reconnect.")); return; }
      if (value.runId !== identity.runId || subscription !== null && (value.subscription !== subscription || value.seq !== seq + 1) || subscription === null && value.type !== "snapshot") { this.disconnected(generation); return; }
      subscription = value.subscription; seq = Number(value.seq);
      const frame = value as PersonalDesktopFrame;
      try {
        if (frame.type === "snapshot" && frame.state) this.inspectDesktopDecisions([...frame.state.approvals.items, ...(frame.state.approvalUpdates ?? [])]);
        if (frame.type === "events") for (const event of frame.events) if (event.type === "personal_state") this.inspectDesktopDecisions([...event.state.approvals.items, ...(event.state.approvalUpdates ?? [])]);
      } catch (error) { this.terminal(error); return; }
      this.publish({ type: "personal_frame", frame });
      if (frame.type === "snapshot" || frame.events.some(event => event.type === "personal_state")) void this.reconcileActions();
    });
    ws.on("close", () => { if (this.ws === ws) this.disconnected(generation); });
  }
  async request(method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
    if (!this.credentials.active || !this.identity || this.status.state !== "online") throw failed("connection_unavailable", "The personal connection isn't verified yet; connect the original entry first.");
    const generation = this.generation, identity = this.identity;
    let result: unknown;
    try { result = await this.exchange(method, route, body, this.credentials.active); }
    catch (error) {
      if (this.identity === identity && error instanceof ControlClientError && error.outcome === "not_sent") throw error;
      if (!this.current(generation) || this.identity !== identity) throw failed("personal_identity_changed", "The connection or backend generation changed; verify the original request.", method === "POST" ? "unknown" : "not_sent");
      throw error;
    }
    if (!this.current(generation) || this.identity !== identity) throw failed("personal_identity_changed", "The connection or backend generation changed; verify the original request. The late result wasn't applied.", method === "POST" ? "unknown" : "not_sent");
    return result;
  }
  async output(input: Record<string, unknown>) {
    if (Object.keys(input).sort().join(",") !== "origin,output,profileId,publication,remoteId" || !integer(input.publication) || Number(input.publication) < 1 || !integer(input.output) || Number(input.output) < 1) throw failed("personal_output_invalid", "Choose a final file from the original chat.");
    const generation = this.generation, identity = this.identity;
    const check = () => { if (!this.current(generation) || this.switching || this.credentialOperation || this.status.state !== "online" || !identity?.online || this.identity !== identity || input.origin !== identity.origin || input.remoteId !== identity.remoteId || input.profileId !== identity.profile.id) throw failed("personal_output_identity_changed", "The original file connection changed; return to the original chat and download again. The original operation wasn't redone."); };
    check();
    const read = async (offset: number) => {
      check();
      const value = await this.request("GET", `/desktop/output?publication=${input.publication}&output=${input.output}&offset=${offset}`);
      check();
      return value;
    };
    const file = await readPersonalOutput(Number(input.publication), Number(input.output), read);
    return { ...file, check, revalidate: async () => { verifyPersonalOutputAccess(file, await read(0)); check(); } };
  }
  async business(method: unknown, route: unknown, body?: unknown): Promise<unknown> {
    if ((method !== "GET" && method !== "POST") || typeof route !== "string") throw failed("op_not_allowed", "This personal operation isn't open yet.");
    const url = new URL(route, this.config.origin);
    if (!route.startsWith("/") || route.startsWith("//") || url.origin !== this.config.origin || !(method === "GET" ? READ_PATHS : WRITE_PATHS).includes(url.pathname)) throw failed("op_not_allowed", "This personal operation isn't open yet.");
    const kind = method === "POST" ? DECISION_PATHS.get(url.pathname) : undefined;
    let decision: PersonalPendingDecision | undefined;
    let action: PersonalDesktopAction | undefined;
    if (url.pathname === "/desktop/action") {
      if (method === "POST") {
        if (url.search || !desktopAction(body)) throw failed("personal_action_invalid", "Choose an operation from the original card.");
        if (this.closed || this.switching || this.credentialOperation) throw failed("personal_pending", "The personal connection is closed, pairing or switching; wait and verify the original decision.");
        action = structuredClone(body);
        const pending = this.pending();
        if (pending.actions?.some(item => item.family === action!.family && item.operation === action!.operation)) { this.publish({ type: "personal_actions", items: pending.actions }); throw failed("personal_action_pending", "The original selection's outcome is unverified; query the original card.", "unknown"); }
        this.record({ ...pending, actions: [...(pending.actions ?? []), action] });
      } else if ([...url.searchParams.keys()].some(key => key !== "requestId") || !UUID.test(url.searchParams.get("requestId") ?? "")) throw failed("personal_action_invalid", "Use the original selection's request ID to verify the receipt.");
    }
    if (kind) {
      if (this.closed || this.switching || this.credentialOperation) throw failed("personal_pending", "The personal connection is closed, pairing or switching; wait and verify the original decision.");
      const operation = kind === "tools" && object(body) ? body.operation : Number(url.searchParams.get(kind === "services" ? "service" : "operation"));
      if (!integer(operation) || Number(operation) < 1 || !object(body) || body.decision !== "approved" && body.decision !== "rejected") throw failed("personal_decision_invalid", "Choose approve-once or reject for the original operation.");
      decision = { kind, operation: Number(operation), decision: body.decision };
      const pending = this.pending();
      if (pending.decisions?.some(item => item.kind === kind && item.operation === operation)) { this.publish({ type: "personal_decisions", items: pending.decisions }); throw failed("personal_decision_pending", "The original decision's outcome is unverified; query the original operation.", "unknown"); }
      this.record({ ...pending, decisions: [...(pending.decisions ?? []), decision] });
    }
    let value: unknown;
    try { value = await this.request(method, route, body); }
    catch (error) {
      if (decision && error instanceof ControlClientError && ["not_sent", "rejected"].includes(error.outcome)) this.clearDecision(decision);
      if (action && error instanceof ControlClientError && ["not_sent", "rejected"].includes(error.outcome)) this.clearAction(action.requestId);
      throw error;
    }
    if (url.pathname === "/desktop/action") {
      const original = action ?? this.pending().actions?.find(item => item.requestId === url.searchParams.get("requestId"));
      if (value === null && method === "GET") return value;
      if (!desktopActionReceipt(value) || value.request.requestId !== (action?.requestId ?? url.searchParams.get("requestId")) || original && !isDeepStrictEqual(value.request, original)) throw failed("personal_protocol", "The original selection's receipt can't be verified; keep the original card and verify the original request.", "unknown");
      if (value.state !== "admitted") this.clearAction(value.request.requestId);
    }
    if (method === "GET" && url.pathname === "/desktop/input" && (!object(value) || value.v !== 1 || !integer(value.revision) || value.entry !== null && (!desktopEntry(value.entry) || !object(value.entry) || !object(value.entry.input) || value.entry.input.requestId !== url.searchParams.get("requestId")))) throw failed("personal_protocol", "The original message's display record can't be verified; reconnect to the original backend.", "rejected");
    if (method === "GET" && (url.pathname === "/desktop/state" && !desktopState(value) || url.pathname === "/desktop/operation" && (!object(value) || value.v !== 1 || !integer(value.revision) || !integer(value.operation) || !integer(value.admission) || !object(value.summary) || !desktopApproval(value.summary) || value.summary.operation !== value.operation || value.summary.admission !== value.admission || typeof value.text !== "string" || value.text.length > 4096 || !integer(value.offset) || value.nextOffset !== undefined && (!integer(value.nextOffset) || Number(value.nextOffset) <= Number(value.offset))))) throw failed("personal_protocol", "The original work projection can't be verified; reconnect to the original backend.", "rejected");
    if (method === "GET" && url.pathname === "/desktop/operation" && object(value) && (value.operation !== Number(url.searchParams.get("operation")) || value.offset !== Number(url.searchParams.get("offset") ?? 0))) throw failed("personal_protocol", "The original operation projection doesn't match the read request; reconnect to the original backend.", "rejected");
    if (method === "GET" && url.pathname === "/desktop/operation" && object(value) && object(value.summary) && (value.summary.family ?? "tools") !== (url.searchParams.get("family") ?? "tools")) throw failed("personal_protocol", "The original operation family doesn't match the read request; verify the original card again.", "rejected");
    if (method === "GET" && object(value)) {
      if (url.pathname === "/desktop/state" && object(value.approvals)) this.inspectDesktopDecisions([...value.approvals.items as PersonalDesktopApproval[], ...(Array.isArray(value.approvalUpdates) ? value.approvalUpdates as PersonalDesktopApproval[] : [])]);
      if (url.pathname === "/desktop/operation") this.inspectDesktopDecisions([value.summary as PersonalDesktopApproval]);
      const inspectedKind = DETAIL_PATHS.get(url.pathname);
      if (inspectedKind) {
        if (!decisionSummary(value.summary, inspectedKind) || !object(value.summary) || (inspectedKind === "services" ? !object(value.summary.ref) || value.summary.ref.taskId !== Number(url.searchParams.get("service")) : value.summary.operation !== Number(url.searchParams.get("operation")))) throw failed("personal_protocol", "The original decision's state can't be verified; reconnect to the original backend.", "rejected");
        this.inspectDecisions(inspectedKind, [value.summary]);
      }
    }
    return value;
  }
  private inspectDecisions(kind: PersonalPendingDecision["kind"], summaries: unknown[]): void {
    const pending = this.pending(), decisions = pending.decisions ?? [];
    const remaining = decisions.filter(item => item.kind !== kind || !summaries.some(summary => decisionSummary(summary, kind) && object(summary) && summary.canDecide === false && (kind === "services" ? object(summary.ref) && summary.ref.taskId === item.operation : summary.operation === item.operation)));
    if (remaining.length === decisions.length) return;
    if (remaining.length) pending.decisions = remaining; else delete pending.decisions;
    this.record(pending);
  }
  private inspectDesktopDecisions(summaries: PersonalDesktopApproval[]): void {
    const pending = this.pending(), decisions = pending.decisions ?? [];
    const remaining = decisions.filter(item => !summaries.some(summary => (summary.family ?? "tools") === item.kind && summary.operation === item.operation && !summary.canDecide));
    if (remaining.length === decisions.length) return;
    if (remaining.length) pending.decisions = remaining; else delete pending.decisions;
    this.record(pending);
  }
  private clearDecision(decision: PersonalPendingDecision): void {
    const pending = this.pending(), remaining = (pending.decisions ?? []).filter(item => item.kind !== decision.kind || item.operation !== decision.operation);
    if (remaining.length) pending.decisions = remaining; else delete pending.decisions;
    this.record(pending);
  }
  private clearAction(requestId: string): void {
    const pending = this.pending(), remaining = (pending.actions ?? []).filter(item => item.requestId !== requestId);
    if (remaining.length === (pending.actions ?? []).length) return;
    if (remaining.length) pending.actions = remaining; else delete pending.actions;
    this.record(pending);
  }
  reconcileActions(): Promise<void> {
    if (this.inspectingActions) return this.inspectingActions;
    const generation = this.generation;
    const inspecting = (async () => {
      const actions = this.pending().actions ?? [];
      for (let index = 0; index < actions.length && this.current(generation) && this.status.state === "online"; index += 4) {
        const results = await Promise.allSettled(actions.slice(index, index + 4).map(action => this.business("GET", `/desktop/action?requestId=${action.requestId}`)));
        if (results.some(result => result.status === "rejected")) return;
      }
    })().catch(() => { process.stderr.write("[ruukoto:desktop] The original card selection isn't verified yet; reopen the original card to query.\n"); }).finally(() => {
      if (this.inspectingActions === inspecting) this.inspectingActions = null;
      if (generation !== this.generation && !this.closed && this.status.state === "online") void this.reconcileActions();
    });
    this.inspectingActions = inspecting; return inspecting;
  }
  private credentialExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.switching || this.credentialOperation) return Promise.reject(failed("personal_pairing_busy", "The personal connection is closed, switching or pairing; wait and verify the original outcome."));
    const result = operation(); this.credentialOperation = result;
    return result.finally(() => { this.credentialOperation = null; });
  }
  private async completeCandidate(candidate: Candidate): Promise<PersonalRemoteIdentity> {
    const identity = this.checkIdentity(await this.exchange("GET", "/handshake", undefined, candidate, false), candidate);
    const active: Active = { id: candidate.id, secret: candidate.secret, origin: candidate.origin, remoteId: identity.remoteId, profile: identity.profile };
    const unverified = (error: unknown) => failed(error instanceof ControlClientError ? error.code : "personal_pairing_pending", error instanceof ControlClientError ? error.message : "The original pairing is registered but the local binding isn't verified; check the app data directory and verify the original candidate credential.", "unknown");
    try { this.persistBinding(identity); } catch (error) { throw unverified(error); }
    try { await this.saveCredentials({ v: 1, active }); } catch (error) { throw unverified(error); }
    this.adopt(identity);
    return identity;
  }
  private async redeemCandidate(candidate: Candidate): Promise<PersonalRemoteIdentity> {
    candidate = { ...candidate }; delete candidate.rejected;
    await this.saveCredentials({ ...this.credentials, candidate });
    try { await this.exchange("POST", "/pair", candidate.request, candidate, false); }
    catch (error) {
      if (error instanceof ControlClientError && ["remote_pairing_rejected", "remote_pairing_closed"].includes(error.code)) {
        await this.saveCredentials({ ...this.credentials, candidate: { ...candidate, rejected: true } });
        throw failed(error.code, error.message, "rejected");
      }
      throw error;
    }
    const identity = await this.completeCandidate(candidate);
    await this.reconnect();
    return identity;
  }
  pair(code: string, label: string): Promise<PersonalRemoteIdentity> {
    return this.credentialExclusive(async () => {
      if (!/^[A-Z2-7]{12}$/.test(code) || !label.trim() || label.trim() !== label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw failed("personal_pairing_invalid", "Enter the pairing code shown by the server and the desktop name.");
      this.credentials = await this.readCredentials();
      let candidate = this.credentials.candidate;
      if (candidate && candidate.origin !== this.config.origin) throw failed("personal_pairing_pending", "Another address's original candidate credential is still unverified; query the original pairing first. No other credential was generated.");
      if (candidate) {
        try { const identity = await this.completeCandidate(candidate); await this.reconnect(); return identity; }
        catch (error) {
          if (!(error instanceof ControlClientError) || !["remote_credential_invalid", "remote_credential_revoked"].includes(error.code)) throw error;
          if (error.code === "remote_credential_revoked") candidate = undefined;
        }
        if (candidate && !candidate.rejected && (candidate.request.code !== code || candidate.request.label !== label)) throw failed("personal_pairing_pending", "The original exchange outcome is unknown and the pairing parameters can't change; verify or explicitly restore the original request first.");
      }
      if (!candidate) {
        candidate = { id: randomUUID(), secret: randomBytes(32).toString("base64url"), origin: this.config.origin, request: { v: 1, code, label } };
      }
      return this.redeemCandidate({ ...candidate, request: { v: 1, code, label } });
    });
  }
  reconcilePairing(): Promise<PersonalRemoteIdentity> {
    return this.credentialExclusive(async () => {
      this.credentials = await this.readCredentials();
      const candidate = this.credentials.candidate;
      if (!candidate) throw failed("personal_pairing_missing", "No original candidate credential awaiting verification; open pairing on the server.");
      const identity = await this.completeCandidate(candidate); await this.reconnect(); return identity;
    });
  }
  restorePairing(): Promise<PersonalRemoteIdentity> {
    return this.credentialExclusive(async () => {
      this.credentials = await this.readCredentials();
      const candidate = this.credentials.candidate;
      if (!candidate) throw failed("personal_pairing_missing", "No original candidate credential awaiting restore; verify the original pairing first.");
      try { const identity = await this.completeCandidate(candidate); await this.reconnect(); return identity; }
      catch (error) { if (!(error instanceof ControlClientError) || error.code !== "remote_credential_invalid") throw error; }
      return this.redeemCandidate(candidate);
    });
  }
  private pending(): Pending {
    const value = readPersonalRecord(personalPendingFile(this.userData, this.config));
    if (value === null) return { v: 1, input: null };
    if (!object(value) || value.v !== 1 || value.input !== null && (!object(value.input) || value.input.v !== 1 || value.input.origin !== this.config.origin || value.input.remoteId !== this.config.binding?.remoteId || !isDeepStrictEqual(value.input.profile, this.config.binding?.profile) || typeof value.input.requestId !== "string" || !UUID.test(value.input.requestId) || typeof value.input.input !== "string" || Buffer.byteLength(value.input.input) > 16 * 1024) || value.maintenance !== undefined && (!object(value.maintenance) || typeof value.maintenance.id !== "string" || !UUID.test(value.maintenance.id) || typeof value.maintenance.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.maintenance.requestDigest))) throw new DesktopError("personal_pending_invalid", "The original personal request record can't be verified and sending stopped; keep the file and check the original archive.");
    if (value.settings !== undefined && (!Array.isArray(value.settings) || value.settings.some(item => !object(item) || Object.keys(item).sort().join(",") !== "id,requestDigest,scope,target" || typeof item.id !== "string" || !UUID.test(item.id) || typeof item.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.requestDigest) || !["model", "skills", "mcp", "web-search", "telegram", "qq", "commands", "services"].includes(String(item.target)) || typeof item.scope !== "string" || !item.scope || item.scope.length > 128) || new Set(value.settings.map(item => item.id)).size !== value.settings.length)) throw new DesktopError("personal_pending_invalid", "The original configuration request association can't be verified; keep the record and query the original archive.");
    if (value.decisions !== undefined && (!Array.isArray(value.decisions) || value.decisions.some(item => !object(item) || Object.keys(item).sort().join(",") !== "decision,kind,operation" || !["tools", "mcp", "app-data", "services"].includes(String(item.kind)) || !integer(item.operation) || Number(item.operation) < 1 || !["approved", "rejected"].includes(String(item.decision))) || new Set(value.decisions.map(item => `${item.kind}:${item.operation}`)).size !== value.decisions.length)) throw new DesktopError("personal_pending_invalid", "The original decision record can't be verified; keep the record and check the original operation.");
    if (value.actions !== undefined && (!Array.isArray(value.actions) || value.actions.some(item => !desktopAction(item)) || new Set(value.actions.map(item => `${item.family}:${item.operation}`)).size !== value.actions.length || new Set(value.actions.map(item => item.requestId)).size !== value.actions.length)) throw new DesktopError("personal_pending_invalid", "The original card selection record can't be verified; keep the record and query the original card.");
    if (value.input !== null && object(value.input) && value.input.attachments !== undefined && !personalAttachments(value.input.attachments)) throw new DesktopError("personal_pending_invalid", "The original input attachments can't be verified; keep the original record and check the archive.");
    if (value.draft !== undefined && (!object(value.draft) || value.draft.v !== 1 || typeof value.draft.id !== "string" || !UUID.test(value.draft.id) || value.draft.origin !== this.config.origin || value.draft.remoteId !== this.config.binding?.remoteId || !isDeepStrictEqual(value.draft.profile, this.config.binding?.profile) || typeof value.draft.input !== "string" || Buffer.byteLength(value.draft.input) > 16 * 1024 || !personalAttachments(value.draft.attachments) || typeof value.draft.failed !== "boolean")) throw new DesktopError("personal_draft_invalid", "The original draft record can't be verified and sending stopped; keep the record and check the original archive.");
    return value as Pending;
  }
  private record(value: Pending, result?: PersonalInputReceipt): void { writePersonalRecord(personalPendingFile(this.userData, this.config), value); this.publish({ type: "personal_pending", record: value.input, ...(result ? { result } : {}) }); this.publish({ type: "personal_decisions", items: value.decisions ?? [] }); this.publish({ type: "personal_actions", items: value.actions ?? [] }); }
  inputDraft(): PersonalInputDraft {
    const pending = this.pending();
    if (!this.config.binding || !this.identity) throw failed("personal_identity_changed", "Connect the original Personal Agent before reading the draft.");
    if (pending.draft) return structuredClone(pending.draft);
    const draft: PersonalInputDraft = { v: 1, id: randomUUID(), origin: this.config.origin, remoteId: this.identity.remoteId, profile: this.identity.profile, input: "", attachments: [], failed: false };
    this.record({ ...pending, draft });
    return draft;
  }
  saveDraft(id: string, input: string): PersonalInputDraft {
    if (this.closed || this.switching || this.inputOperation || typeof input !== "string" || Buffer.byteLength(input) > 16 * 1024) throw failed("personal_input_busy", "The draft is still processing or exceeds 16 KiB; wait and verify the original input.");
    const draft = this.inputDraft();
    if (draft.id !== id) throw failed("personal_draft_changed", "The original draft changed; read it again.");
    draft.input = input; this.record({ ...this.pending(), draft }); return draft;
  }
  discardDraft(id: string): PersonalInputDraft {
    if (this.closed || this.switching || this.inputOperation || this.pending().input) throw failed("personal_input_busy", "The original input is still processing; verify the original request first.");
    const draft = this.inputDraft();
    if (draft.id !== id) throw failed("personal_draft_changed", "The original draft changed; read it again.");
    const next = { ...draft, id: randomUUID(), input: "", attachments: [], failed: false };
    this.record({ ...this.pending(), draft: next }); this.publish({ type: "personal_draft", draft: next }); return next;
  }
  connectionIdentity(): object | null { return this.identity?.online && this.status.state === "online" ? this.identity : null; }
  beginAttachmentSelection(id: string): void {
    if (this.closed || this.switching || this.inputOperation || this.pending().input) throw failed("personal_input_busy", "The original input is still processing; verify the original request first.");
    const draft = this.inputDraft();
    if (draft.id !== id) throw failed("personal_draft_changed", "The original draft changed; read it again.");
    if (!this.identity?.online || this.status.state !== "online") throw failed("attachment_instance_changed", "Restore the original connection before choosing attachments.");
    const blocked = { ...draft, failed: true };
    this.record({ ...this.pending(), draft: blocked });
    this.inputOperation = true;
    this.attachmentSelection = { id, generation: this.generation, identity: this.identity, draft };
    this.publish({ type: "personal_draft", draft: blocked });
  }
  async pickAttachments(id: string, pick: () => Promise<string[]>, reserved = false): Promise<PersonalDesktopAttachment[]> {
    if (!reserved) this.beginAttachmentSelection(id);
    const selection = this.attachmentSelection;
    if (!selection || selection.id !== id) throw failed("attachment_instance_changed", "The original attachment selection changed and this input wasn't sent; choose the attachments again.");
    const check = () => { if (!this.current(selection.generation) || this.identity !== selection.identity || this.status.state !== "online" || !selection.identity?.online || this.pending().draft?.id !== id) throw failed("attachment_instance_changed", "The original attachment connection changed and this input wasn't sent; choose the attachments again."); };
    try {
      check();
      const draft = selection.draft;
      const files = await pick(); check();
      if (files.length + draft.attachments.length > 4) throw failed("attachment_limit", "Each input allows at most 4 files; remove or reselect attachments.");
      const uploaded = await uploadPersonalAttachments(files, check, value => this.request("POST", "/desktop/attachment", value));
      check();
      const next = { ...draft, attachments: [...draft.attachments, ...uploaded], failed: draft.failed && files.length === 0 };
      this.record({ ...this.pending(), draft: next }); this.publish({ type: "personal_draft", draft: next });
      return uploaded;
    } finally { if (this.attachmentSelection === selection) { this.inputOperation = false; this.attachmentSelection = null; } }
  }
  removeAttachment(id: string, attachmentId: string): PersonalInputDraft {
    if (this.closed || this.switching || this.inputOperation || this.pending().input) throw failed("personal_input_busy", "The original input is still processing; verify the original request first.");
    const draft = this.inputDraft();
    if (draft.id !== id || !draft.attachments.some(item => item.id === attachmentId)) throw failed("personal_draft_changed", "The original attachments changed; read them again.");
    draft.attachments = draft.attachments.filter(item => item.id !== attachmentId);
    this.record({ ...this.pending(), draft }); this.publish({ type: "personal_draft", draft }); return draft;
  }
  /** A successful check holds switching until the caller saves the address and closes this connection. */
  async assertSwitchable(): Promise<() => void> {
    if (this.closed || this.switching || this.credentialOperation) throw failed("personal_pending", "The original connection is closed, pairing or switching; wait and verify. The address wasn't changed.");
    this.switching = true;
    try {
      const credentials = await this.readCredentials(), pending = this.config.binding ? this.pending() : null;
      if (pending?.input || pending?.maintenance || pending?.settings?.length || pending?.decisions?.length || pending?.actions?.length || credentials.candidate) throw failed("personal_pending", "The original connection still has unverified requests; verify the original input, decisions, maintenance and pairing first.");
      return () => { this.switching = false; };
    } catch (error) { this.switching = false; throw error; }
  }
  maintenance(): Pending["maintenance"] { return this.pending().maintenance; }
  recordMaintenance(value: Pending["maintenance"]): void { if (this.closed || this.switching && value) throw failed("personal_pending", "The personal connection is closed or switching; the new maintenance wasn't admitted."); const pending = this.pending(); if (value) pending.maintenance = value; else delete pending.maintenance; this.record(pending); }
  settingsOperations(): NonNullable<Pending["settings"]> { return this.pending().settings ?? []; }
  recordSettingsOperation(id: string, value?: NonNullable<Pending["settings"]>[number]): void {
    if (this.closed || this.switching && value) throw failed("personal_pending", "The personal connection is closed or switching; the configuration change wasn't admitted.");
    const pending = this.pending(), settings = (pending.settings ?? []).filter(item => item.id !== id);
    if (value) settings.push(value);
    if (settings.length) pending.settings = settings; else delete pending.settings;
    this.record(pending);
  }
  private inputReceipt(requestId: string, value: unknown): PersonalInputReceipt {
    if (!object(value) || !["queued", "placed", "done", "unanswered", "missing"].includes(String(value.status)) || value.answer !== undefined && typeof value.answer !== "string" || value.truncated !== undefined && typeof value.truncated !== "boolean") throw failed("personal_protocol", "The original input's response can't be verified; query the original request — it won't resend under a new key.", "unknown");
    return { kind: value.status === "missing" ? "missing" : "accepted", requestId, ...(value.status === "missing" ? {} : { status: value.status as "queued" | "placed" | "done" | "unanswered" }), ...(typeof value.answer === "string" ? { answer: value.answer } : {}), ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}) };
  }
  private async sendInput(record: PersonalPendingInput): Promise<PersonalInputReceipt> {
    try {
      const result = this.inputReceipt(record.requestId, await this.request("POST", record.attachments?.length ? "/desktop/inputs" : "/inputs", { requestId: record.requestId, input: record.input, ...(record.attachments?.length ? { attachments: record.attachments } : {}) }));
      const current = this.pending();
      if (result.kind === "accepted" && current.input?.requestId === record.requestId) this.finishInput(current, record, result);
      return result;
    } catch (error) {
      if (error instanceof ControlClientError && (error.outcome === "unknown" || error.outcome === "disconnected")) return { kind: "pending", requestId: record.requestId };
      if (error instanceof ControlClientError && error.outcome === "rejected" && record.attachments?.length && ATTACHMENT_REJECTIONS.has(error.code) && !["attachment_conflict", "attachment_bound", "media_input_conflict"].includes(error.code)) {
        const current = this.pending();
        if (current.input?.requestId === record.requestId) {
          const draft = current.draft?.input === record.input && isDeepStrictEqual(current.draft.attachments, record.attachments) ? { ...current.draft, failed: true } : current.draft;
          this.record({ ...current, input: null, ...(draft ? { draft } : {}) });
          if (draft) this.publish({ type: "personal_draft", draft });
        }
      }
      throw error;
    }
  }
  private finishInput(current: Pending, record: PersonalPendingInput, result: PersonalInputReceipt): void {
    const draft = current.draft;
    const cleared = draft && draft.input === record.input && isDeepStrictEqual(draft.attachments, record.attachments ?? []) ? { ...draft, id: randomUUID(), input: "", attachments: [], failed: false } : draft;
    this.record({ ...current, input: null, ...(cleared ? { draft: cleared } : {}) }, result);
    if (cleared) this.publish({ type: "personal_draft", draft: cleared });
  }
  async submitInput(input: string, attachments: PersonalDesktopAttachment[] = [], draftId?: string): Promise<PersonalInputReceipt> {
    if (this.closed || this.switching) throw failed("personal_pending", "The personal connection is closed or switching; the new input wasn't sent.");
    if (this.inputOperation) throw failed("personal_input_busy", "The original input is still sending; wait and verify the original request.");
    if (!personalAttachments(attachments) || !input.trim() && !attachments.length || Buffer.byteLength(input) > 16 * 1024 || !this.identity || !this.config.binding) throw failed("personal_input_invalid", "Connect the Personal Agent before entering a message or choosing attachments; text is limited to 16 KiB and attachments to 4.");
    const pending = this.pending();
    if (pending.input) return { kind: "pending", requestId: pending.input.requestId };
    if (pending.draft?.failed || draftId !== undefined && (pending.draft?.id !== draftId || pending.draft.input !== input || !isDeepStrictEqual(pending.draft.attachments, attachments))) throw failed("personal_attachment_failed", "This input's attachments weren't fully prepared; choose again or discard the draft before sending.");
    const record: PersonalPendingInput = { v: 1, origin: this.config.origin, remoteId: this.identity.remoteId, profile: this.identity.profile, requestId: randomUUID(), input, ...(attachments.length ? { attachments: structuredClone(attachments) } : {}) };
    this.record({ ...pending, input: record }); this.inputOperation = true;
    try { return await this.sendInput(record); } finally { this.inputOperation = false; }
  }
  async reconcileInput(): Promise<PersonalInputReceipt | null> {
    const pending = this.pending(); this.publish({ type: "personal_pending", record: pending.input });
    if (!pending.input || this.inputOperation) return null;
    const record = pending.input, result = this.inputReceipt(record.requestId, await this.request("GET", `/input?requestId=${encodeURIComponent(record.requestId)}`));
    const current = this.pending();
    if (current.input?.requestId !== record.requestId) return null;
    if (result.kind === "accepted") this.finishInput(current, record, result);
    else this.publish({ type: "personal_pending", record, result });
    return result;
  }
  async restoreInput(): Promise<PersonalInputReceipt> {
    if (this.closed || this.switching) throw failed("personal_pending", "The personal connection is closed or switching; wait and verify the original input.");
    if (this.inputOperation) throw failed("personal_input_busy", "The original input is still being verified; wait before continuing.");
    const previous = await this.reconcileInput();
    if (!previous || previous.kind !== "missing") throw failed("personal_input_not_restorable", "The original input was admitted or is still unverified; check the original request.");
    if (this.inputOperation) throw failed("personal_input_busy", "The original input is still processing; wait and verify.");
    const record = this.pending().input;
    if (!record || record.requestId !== previous.requestId) throw failed("personal_input_not_restorable", "The original input record changed; read it again.");
    this.inputOperation = true;
    try { return await this.sendInput(record); } finally { this.inputOperation = false; }
  }
  instanceId(): string | null { return this.identity?.remoteId ?? null; }
  async close(): Promise<void> {
    this.closed = true; ++this.generation; this.stopObservation();
    for (const request of this.requests) request.destroy();
    await Promise.allSettled([this.connecting, this.credentialOperation]);
    this.state({ type: "state", state: "closed", detail: "Personal connection disconnected; backend work continues." });
  }
}
