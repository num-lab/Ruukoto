import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MAX_ATTACHMENTS } from "@ruukoto/core/attachments.ts";
import { isSessionDefaultMode, type ModelSelection, type Project, type Session } from "@ruukoto/core/types.ts";
import { parseModelSelection } from "@ruukoto/core/model-selection.ts";
import type { OpParams } from "@ruukoto/control/ops.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { DesktopChatCreation, DesktopChatDraft } from "../shared/bridge.ts";
import type { CodeController } from "./controller.ts";
import { readAttachmentBytes, type StagedAttachment } from "./attachments.ts";
import { DesktopError } from "./environment.ts";

interface ChatData {
  draft: DesktopChatDraft;
  files: Array<StagedAttachment & { hash?: string }>;
  creation: { op: "create_session"; params: OpParams<"create_session"> } | { op: "create_managed_session"; params: OpParams<"create_managed_session"> };
}
type ChatSource = Pick<CodeController, "request" | "instanceId" | "status">;
const key = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const model = (value: unknown): value is ModelSelection => { try { parseModelSelection(value); return true; } catch { return false; } };
const attachment = (value: unknown): boolean => object(value) && key(value.id) && typeof value.name === "string" && !!value.name && !/[/\\\x00-\x1f]/.test(value.name) && Number.isSafeInteger(value.size) && Number(value.size) >= 0 && Number(value.size) <= 8 * 1024 * 1024;

function chatData(record: PendingRequest): ChatData {
  const { draft, files, creation } = record.params;
  if (!object(draft) || !Array.isArray(draft.attachments)) throw new DesktopError("chat_draft_invalid", "首条消息记录无法读取，请检查应用数据目录后重试。");
  const attachments = draft.attachments;
  if (record.op !== "desktop_start_chat" || draft.requestId !== record.requestId || draft.instanceId !== record.instanceId || typeof draft.workspaceId !== "string" || typeof draft.text !== "string" || !isSessionDefaultMode(draft.mode) || !model(draft.modelSelection) || !key(draft.submissionRequestId) || draft.sessionId !== null && !key(draft.sessionId) || attachments.length > MAX_ATTACHMENTS || attachments.some(item => !attachment(item)) || !Array.isArray(files) || !object(creation) || !["create_session", "create_managed_session"].includes(String(creation.op)) || !object(creation.params) || creation.params.request_id !== record.requestId || !isSessionDefaultMode(creation.params.mode) || !model(creation.params.model_selection) || Object.keys(creation.params).some(field => !["request_id", "mode", "model_selection", ...(creation.op === "create_session" ? ["project_id", "cwd"] : [])].includes(field)) || files.length !== attachments.length || files.some((file, index) => !object(file) || !key(file.token) || typeof file.path !== "string" || !path.isAbsolute(file.path) || !attachment({ ...file, id: file.token }) || !isDeepStrictEqual(attachments[index], { id: file.token, name: file.name, size: file.size })) || draft.uploadedAttachments !== null && (!Array.isArray(draft.uploadedAttachments) || draft.uploadedAttachments.length > MAX_ATTACHMENTS || draft.uploadedAttachments.some(item => !attachment(item)))) throw new DesktopError("chat_draft_invalid", "首条消息记录无法读取，请检查应用数据目录后重试。");
  if (creation.op === "create_session" ? creation.params.project_id !== draft.workspaceId || typeof creation.params.cwd !== "string" || !path.isAbsolute(creation.params.cwd) : draft.workspaceId !== "") throw new DesktopError("chat_draft_invalid", "首条消息工作区记录无法读取，请检查应用数据目录后重试。");
  // This is the native JSON journal boundary; private file paths never enter renderer updates.
  return record.params as unknown as ChatData;
}

// Note: See .agents/notes/implemented/feature/2026-11-07-managed-coding-workspaces.md
/** Retain first-send creation and uploads until the original submission is accepted. */
export class DesktopChatDrafts {
  private readonly directory: string;
  constructor(private readonly store: PendingRequestStore, private readonly source: () => ChatSource | null, private readonly workspace: (id: string) => Project | undefined, private readonly staged: Map<string, StagedAttachment>) { this.directory = fs.realpathSync(store.dir); }

  private records(): Array<{ record: PendingRequest; data: ChatData }> {
    const { records, corrupt } = this.store.list(true);
    if (corrupt.length) throw new DesktopError("chat_draft_invalid", "首条消息记录无法读取，请检查应用数据目录后重试。");
    return records.filter(record => record.op === "desktop_start_chat").map(record => {
      const data = chatData(record);
      if (data.files.some(file => file.path !== path.join(this.directory, `${record.requestId}-files`, file.token, file.name) || typeof file.hash !== "string" || !/^[a-f0-9]{64}$/.test(file.hash))) throw new DesktopError("chat_draft_invalid", "首条消息附件记录无法读取，请检查应用数据目录后重试。");
      return { record, data };
    });
  }
  private save(record: PendingRequest, data: ChatData): void { this.store.save({ ...record, params: { ...data } }); }
  private verifyFiles(data: ChatData): void {
    for (const file of data.files) {
      try {
        const bytes = readAttachmentBytes(file.path);
        if (fs.realpathSync(file.path) !== file.path || bytes.length !== file.size || !file.hash || createHash("sha256").update(bytes).digest("hex") !== file.hash) throw new Error("Changed snapshot");
      }
      catch { throw new DesktopError("chat_attachment_unavailable", "首条消息附件快照无法核实，请检查原应用数据后重试。"); }
    }
  }
  private snapshot(record: PendingRequest, data: ChatData): void {
    for (const file of data.files) {
      const directory = path.join(this.directory, `${record.requestId}-files`, file.token);
      const destination = path.join(directory, file.name);
      if (file.path === destination) continue;
      const bytes = readAttachmentBytes(file.path);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.snapshot-${randomUUID()}`);
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      const fileFd = fs.openSync(temporary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fileFd); } finally { fs.closeSync(fileFd); }
      fs.renameSync(temporary, destination);
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      file.path = destination;
      file.size = bytes.length;
      file.hash = createHash("sha256").update(bytes).digest("hex");
      const attachment = data.draft.attachments.find(item => item.id === file.token);
      if (attachment) attachment.size = bytes.length;
    }
  }
  private connection() {
    const source = this.source(), instanceId = source?.instanceId();
    if (!source || source.status.state !== "online" || !instanceId) throw new DesktopError("connection_unavailable", "请等待连接恢复后再发送。");
    return { source, instanceId };
  }
  private same(source: ChatSource, instanceId: string): void {
    if (source !== this.source() || source.instanceId() !== instanceId) throw new DesktopError("chat_instance_changed", "首条消息属于原数据实例，请连回原实例后重试。");
  }
  async list(): Promise<DesktopChatDraft[]> {
    const { source, instanceId } = this.connection();
    const drafts: DesktopChatDraft[] = [];
    for (const { record, data } of this.records()) {
      if (record.instanceId !== instanceId) continue;
      if (data.draft.sessionId) {
        const result = await source.request("find_task", { session_id: data.draft.sessionId, request_id: data.draft.submissionRequestId });
        this.same(source, instanceId);
        if (result.task) { this.store.remove(record.requestId); continue; }
      }
      if (!data.draft.uploadedAttachments) this.verifyFiles(data);
      for (const file of data.files) this.staged.set(file.token, file);
      drafts.push(data.draft);
    }
    return drafts;
  }
  async start(input: Record<string, unknown>): Promise<DesktopChatCreation> {
    const { source, instanceId } = this.connection();
    if (Object.keys(input).some(field => !["request_id", "workspace_id", "text", "mode", "model_selection", "tokens"].includes(field)) || !key(input.request_id) || typeof input.workspace_id !== "string" || typeof input.text !== "string" || !isSessionDefaultMode(input.mode) || !model(input.model_selection) || !Array.isArray(input.tokens) || input.tokens.length > MAX_ATTACHMENTS || input.tokens.some(token => !key(token)) || !input.text.trim() && !input.tokens.length) throw new DesktopError("invalid_params", "首条消息无效，请保留正文和附件后重试。");
    const prior = this.records().find(item => item.record.requestId === input.request_id);
    let record: PendingRequest, data: ChatData;
    if (prior) {
      ({ record, data } = prior);
      if (record.instanceId !== instanceId) throw new DesktopError("chat_instance_changed", "首条消息属于原数据实例，请连回原实例后重试。");
      if (data.draft.workspaceId !== input.workspace_id || data.draft.text !== input.text || data.draft.mode !== input.mode || !isDeepStrictEqual(data.draft.modelSelection, input.model_selection) || !isDeepStrictEqual(data.files.map(file => file.token), input.tokens)) throw new DesktopError("request_conflict", "首条消息仍使用原记录，请恢复原草稿后重试，或新建对话。");
    } else {
      const files = input.tokens.map(token => {
        const file = this.staged.get(String(token));
        if (!file) throw new DesktopError("attachment_expired", "附件已失效，请重新选择。");
        return { ...file };
      });
      const selected = input.workspace_id ? this.workspace(input.workspace_id) : undefined;
      if (input.workspace_id && (!selected?.rootDir || selected.managed)) throw new DesktopError("workspace_unavailable", "所选工作区已不可用，请重新选择。");
      const settings = { request_id: input.request_id, mode: input.mode, model_selection: input.model_selection };
      data = {
        draft: { requestId: input.request_id, instanceId, workspaceId: input.workspace_id, text: input.text, mode: input.mode, modelSelection: input.model_selection, attachments: files.map(file => ({ id: file.token, name: file.name, size: file.size })), submissionRequestId: randomUUID(), sessionId: null, uploadedAttachments: null },
        files,
        creation: selected?.rootDir ? { op: "create_session", params: { ...settings, project_id: selected.id, cwd: selected.rootDir.cwdReal } } : { op: "create_managed_session", params: settings },
      };
      record = { requestId: input.request_id, instanceId, op: "desktop_start_chat", params: { ...data }, createdAt: new Date().toISOString() };
      try { this.snapshot(record, data); this.save(record, data); }
      catch (error) { throw new DesktopError("chat_not_created", error instanceof Error ? error.message : "附件尚未保存，请重新选择。"); }
    }
    if (!data.draft.uploadedAttachments) this.verifyFiles(data);
    for (const file of data.files) this.staged.set(file.token, file);
    let result: Omit<DesktopChatCreation, "draft">;
    if (data.creation.op === "create_managed_session") {
      try { result = await source.request(data.creation.op, data.creation.params); }
      catch (error) {
        if (error instanceof ControlClientError && error.outcome === "rejected") {
          const found = await source.request("find_managed_session", { request_id: record.requestId });
          this.same(source, instanceId);
          if (found.status === "not_found") {
            this.store.remove(record.requestId);
            throw new DesktopError("chat_not_created", error.message);
          }
        }
        throw error;
      }
    }
    else {
      let session: Session;
      try { session = await source.request(data.creation.op, data.creation.params); }
      catch (error) {
        if (error instanceof ControlClientError && error.outcome === "rejected") {
          const found = await source.request("find_created_session", { request_id: record.requestId });
          this.same(source, instanceId);
          if (!found) { this.store.remove(record.requestId); throw new DesktopError("chat_not_created", error.message); }
          session = found;
        } else throw error;
      }
      const project = this.workspace(session.projectId);
      if (!project) throw new DesktopError("workspace_unavailable", "会话已创建，请恢复连接后核实其工作区。");
      result = { session, project };
    }
    this.same(source, instanceId);
    data.draft.sessionId = result.session.id;
    if (!data.files.length) data.draft.uploadedAttachments = [];
    this.save(record, data);
    return { ...result, draft: data.draft };
  }
  uploaded(instanceId: string, sessionId: string, tokens: string[], attachments: DesktopChatDraft["attachments"]): void {
    for (const { record, data } of this.records()) {
      if (record.instanceId === instanceId && data.draft.sessionId === sessionId && isDeepStrictEqual(data.files.map(file => file.token), tokens)) {
        data.draft.uploadedAttachments = attachments;
        this.save(record, data);
      }
    }
  }
  verifyUpload(instanceId: string, sessionId: string, tokens: string[]): void {
    const data = this.records().find(({ record, data }) => record.instanceId === instanceId && data.draft.sessionId === sessionId && isDeepStrictEqual(data.files.map(file => file.token), tokens))?.data;
    if (data) this.verifyFiles(data);
  }
  upload(instanceId: string, sessionId: string, tokens: string[]): DesktopChatDraft["attachments"] | null {
    return this.records().find(({ record, data }) => record.instanceId === instanceId && data.draft.sessionId === sessionId && isDeepStrictEqual(data.files.map(file => file.token), tokens))?.data.draft.uploadedAttachments ?? null;
  }
  async finish(requestId: unknown): Promise<void> {
    if (!key(requestId)) throw new DesktopError("invalid_params", "首条消息记录无效，请恢复连接后重试。");
    const { source, instanceId } = this.connection();
    const item = this.records().find(({ record }) => record.requestId === requestId && record.instanceId === instanceId);
    if (!item?.data.draft.sessionId) return;
    const result = await source.request("find_task", { session_id: item.data.draft.sessionId, request_id: item.data.draft.submissionRequestId });
    this.same(source, instanceId);
    if (result.task) this.store.remove(requestId);
  }
  async prepareSubmission(params: Record<string, unknown>): Promise<{ accepted: boolean }> {
    const { source, instanceId } = this.connection();
    if (Object.keys(params).some(field => !["creation_request_id", "session_id", "request_id", "input", "access_mode", "model_selection", "attachments", "guidance"].includes(field)) || !key(params.creation_request_id) || !key(params.session_id) || !key(params.request_id) || typeof params.input !== "string" || !isSessionDefaultMode(params.access_mode) || !model(params.model_selection) || params.attachments !== undefined && (!Array.isArray(params.attachments) || params.attachments.length > MAX_ATTACHMENTS || params.attachments.some(item => !attachment(item)))) throw new DesktopError("invalid_params", "首条消息无效，请保留草稿后重试。");
    const item = this.records().find(({ record }) => record.requestId === params.creation_request_id && record.instanceId === instanceId);
    if (!item || item.data.draft.sessionId !== params.session_id || item.data.draft.submissionRequestId !== params.request_id) throw new DesktopError("request_conflict", "首条消息身份已变化，请恢复原会话后重试。");
    const found = await source.request("find_task", { session_id: params.session_id, request_id: params.request_id });
    this.same(source, instanceId);
    if (found.task) { this.store.remove(item.record.requestId); return { accepted: true }; }
    item.data.draft.text = params.input;
    item.data.draft.mode = params.access_mode;
    item.data.draft.modelSelection = params.model_selection;
    item.data.draft.uploadedAttachments = params.attachments as DesktopChatDraft["attachments"] ?? [];
    this.save(item.record, item.data);
    return { accepted: false };
  }
}
