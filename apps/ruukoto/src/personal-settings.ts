import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createModels, type Provider } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { ManagedSkillsError, ManagedSkillsStore } from "@ruukoto/agent/managed-skills.ts";
import type { SkillId } from "@ruukoto/agent/skills.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { discoverCuaTargets } from "@ruukoto/agent/mcp/cua-discovery.ts";
import { restrictCuaTool } from "@ruukoto/agent/mcp/cua.ts";
import { ROOT_CONVERSATION_ID, type TaskId, type EntryId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { hasPendingPersonalWork } from "./personal-config-idle.ts";
import { readPersonalConfig } from "./personal-config.ts";
import { PersonalError } from "./personal-error.ts";
import type { PersonalHarness } from "./personal-harness.ts";
import { discoverPersonalMcp, parsePersonalMcp, personalMcpCredential, readPersonalMcp, resolvePersonalMcpToken, validatePersonalMcpCredentials, type PersonalMcpConfig, type PersonalMcpService } from "./personal-mcp-config.ts";
import { PERSONAL_CONFIGURATION_FILES, PersonalConfigurationDoc, PersonalSettingsOperationDoc, PersonalConfigurationVersionDoc, readPersonalConfigurationFile, readPersonalConfigurationRevision, type PersonalConfigurationTarget, type PersonalSettingsFileIssue } from "./personal-settings-records.ts";
import { personalSettingsExternalBlockers, type PersonalExternalSettingsBlocker } from "./personal-settings-blockers.ts";
import { mcpEnd, mcpList, mcpDetail } from "./personal-mcp.ts";
import { parsePersonalModel, personalProvider, type PersonalModelConfig } from "./personal-model.ts";
import { PERSONAL_FORMAT, PERSONAL_PENDING_FILE, PERSONAL_QUESTION_PENDING_FILE, PERSONAL_SCHEDULE_PENDING_FILE, lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";
import { parsePersonalSkills, personalSkillsDirectory, readPersonalSkills } from "./personal-skills-config.ts";
import { personalSkillStore } from "./personal-skills.ts";
import type { PersonalCommandConfig } from "./personal-command-config.ts";
import type { PersonalServiceConfig } from "./personal-service-config.ts";
import type { PersonalSkillsConfig } from "./personal-skills-config.ts";
import type { PersonalSettingsWriteRequest } from "./personal-settings-operations.ts";
import { readPersonalWebSearch, type PersonalWebSearchConfig } from "./personal-tools-config.ts";
import type { PersonalSettingsReceipt } from "./personal-settings-records.ts";

export const PERSONAL_SETTINGS_LIMITS = { requestBytes: 128 * 1024, responseBytes: 256 * 1024, modelTestMs: 30_000 } as const;
export type PersonalSettingsTarget = "model" | "skills" | "mcp";
export type PersonalSettingsIdentity = { directory: string; id: string };
export type PersonalSettingsBlocker = { kind: "pending-input" | "pending-work" } | PersonalExternalSettingsBlocker;
type PersonalSkillSettingsRequest = { v: 1; profile: PersonalSettingsIdentity; expectedRevision: string } & (
  { op: "skills.list"; offset?: number; limit?: number }
  | { op: "skills.get"; id: SkillId }
  | { op: "skills.select-directory"; purpose: "library" | "import"; directory: string; offset?: number; limit?: number }
  | { op: "skills.preview-import"; directory: string }
  | { op: "skills.import"; id: SkillId; directory: string; contentRevision: string }
  | { op: "skills.set-enabled"; id: SkillId; enabled: boolean }
  | { op: "skills.remove"; id: SkillId });
export type PersonalSettingsRequest = { v: 1; op: "settings.read" | "lifecycle.status"; offset?: number; limit?: number; operationsOffset?: number; effectiveOffset?: number }
  | { v: 1; op: "config.save" | "config.preflight"; profile: PersonalSettingsIdentity; target: PersonalSettingsTarget; expectedRevision: string; value: unknown }
  | { v: 1; op: "model.test"; profile: PersonalSettingsIdentity; expectedRevision: string; value: unknown }
  | { v: 1; op: "mcp.cua-targets" | "mcp.cua-status"; profile: PersonalSettingsIdentity; expectedRevision: string }
  | { v: 1; op: "mcp.cua-control"; profile: PersonalSettingsIdentity; expectedRevision: string; action: "pause" | "resume" | "stop" | "observe" | "accept"; operation?: number; observation?: number }
  | { v: 1; op: "mcp.cua-image"; profile: PersonalSettingsIdentity; expectedRevision: string; operation: number; observation: number; image: string; offset?: number }
  | { v: 1; op: "mcp.discover"; profile: PersonalSettingsIdentity; expectedRevision: string; service: unknown }
  | { v: 1; op: "mcp.migrate"; profile: PersonalSettingsIdentity; expectedRevision: string }
  | { v: 1; op: "mcp.operations"; profile: PersonalSettingsIdentity; expectedRevision: string; offset?: number }
  | { v: 1; op: "mcp.operation"; profile: PersonalSettingsIdentity; expectedRevision: string; operation: number; offset?: number }
  | { v: 1; op: "mcp.end"; profile: PersonalSettingsIdentity; expectedRevision: string; operation: number }
  | { v: 1; op: "mcp.get"; profile: PersonalSettingsIdentity; expectedRevision: string; id: string; offset?: number; limit?: number }
  | { v: 1; op: "mcp.set-enabled"; profile: PersonalSettingsIdentity; expectedRevision: string; id: string; enabled: boolean }
  | { v: 1; op: "mcp.remove"; profile: PersonalSettingsIdentity; expectedRevision: string; id: string }
  | { v: 1; op: "mcp.save-service"; profile: PersonalSettingsIdentity; expectedRevision: string; service: unknown }
  | PersonalSkillSettingsRequest;
export type PersonalSettingsContext = { profile: PersonalProfileLock; instance?: PersonalHarness; development?: boolean; checkpoint?: (stage: "intent" | "file" | "saved" | "published") => void | Promise<void> };
type PersonalMcpSummary = Omit<PersonalMcpConfig, "services"> & { services: (Omit<PersonalMcpService, "tools"> & { tools: { name: string; description?: string }[] })[]; offset: number; hasMore: boolean };
export type PersonalSettingsSnapshot = { profile: PersonalSettingsIdentity; online: boolean; settingsProtocol: 2; revisions: Record<Exclude<PersonalConfigurationTarget, "managed-skills">, string>; revisionsUnknown: PersonalConfigurationTarget[]; fileIssues: PersonalSettingsFileIssue[]; operations: PersonalSettingsReceipt[]; operationsNextOffset?: number; effective: { target: PersonalConfigurationTarget; scope: string; version: string; revision: string | null }[]; effectiveNextOffset?: number; commands: PersonalCommandConfig | null; "web-search": PersonalWebSearchConfig | null; services: PersonalServiceConfig | null; model: { config: PersonalModelConfig } | null; skills: { config: PersonalSkillsConfig | null; revision: string; skills: { name: string; description: string; disableModelInvocation?: boolean }[]; diagnostics: string[] }; mcp: PersonalMcpSummary | null };

export async function readPersonalSettings(target: string | PersonalProfileLock): Promise<PersonalSettingsSnapshot> {
  return await executePersonalSettings(target, { v: 1, op: "settings.read" }) as PersonalSettingsSnapshot;
}

export async function savePersonalSettings(target: string | PersonalProfileLock, snapshot: Pick<PersonalSettingsSnapshot, "profile">, expectedRevision: string, op: Extract<PersonalSettingsWriteRequest, { op: unknown }>["op"]): Promise<PersonalSettingsReceipt> {
  return await executePersonalSettings(target, { v: 2, id: randomUUID(), profile: snapshot.profile, expectedRevision, op }) as PersonalSettingsReceipt;
}

export function personalSettingsMessage(receipt: PersonalSettingsReceipt): string {
  return receipt.status === "active" ? "配置已保存并生效。" : receipt.status === "saved" ? "配置已保存，后台启动时应用。" : receipt.status === "waiting" ? "配置已保存，等待相关操作结束；请查询原更改或撤回待生效更改。" : receipt.status === "failed" ? "配置已保存，生效失败；请查询原更改并检查对应配置。" : receipt.status === "superseded" ? "原更改已被取代，保存记录保留。" : receipt.status === "rejected" ? "配置未保存，请刷新并比较草稿。" : "保存结果待核实，请查询原更改；不要重复保存。";
}

async function settingsFacts(current: PersonalSettingsContext, request: { operationsOffset?: number; effectiveOffset?: number }) {
  if (!current.instance && !fs.existsSync(path.join(current.profile.directory, "personal.sqlite"))) return { operations: [], effective: [] };
  const { withPersonalSettingsSession } = await import("./personal-settings-operations.ts");
  return withPersonalSettingsSession(current, async session => {
    const index = await session.snapshot(PersonalConfigurationDoc, context);
    if (!index) return { operations: [], effective: [] };
    const operationsOffset = request.operationsOffset ?? 0, effectiveOffset = request.effectiveOffset ?? 0;
    const receipts: PersonalSettingsReceipt[] = [];
    for (const id of index.operations.slice(operationsOffset, operationsOffset + 32)) {
      const operation = (await session.snapshot(PersonalSettingsOperationDoc, id, context))?.operation;
      if (!operation || operation.receipt.id !== id) throw new PersonalError("settings_history_invalid", "原配置回执缺失，请保留档案并核实原更改。");
      receipts.push(structuredClone(operation.receipt));
    }
    const effective = [];
    for (const ref of index.effective.slice(effectiveOffset, effectiveOffset + 32)) {
      const value = (await session.snapshot(PersonalConfigurationVersionDoc, `${ref.target}:${ref.version}`, context))?.value;
      if (!value || value.target !== ref.target || value.version !== ref.version) throw new PersonalError("settings_history_invalid", "原生效配置缺失，请保留档案并核实原更改。");
      effective.push({ ...ref, revision: value.revision === "missing" ? null : value.revision });
    }
    return { operations: receipts, ...(operationsOffset + 32 < index.operations.length ? { operationsNextOffset: operationsOffset + 32 } : {}), effective, ...(effectiveOffset + 32 < index.effective.length ? { effectiveNextOffset: effectiveOffset + 32 } : {}) };
  });
}
const context = BACKGROUND_CONTEXT;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const invalid = () => new PersonalError("settings_request_invalid", "设置请求无效，请更新管理客户端并重新读取原档案。");
const redacted = "__RUUKOTO_REDACTED__";
const skillOperations = ["skills.list", "skills.get", "skills.select-directory", "skills.preview-import", "skills.import", "skills.set-enabled", "skills.remove"];
const revision = (value: unknown) => typeof value === "string" && /^(missing|sha256:[0-9a-f]{64})$/.test(value);
function checkPage(value: Record<string, unknown>) {
  for (const key of ["offset", "limit"]) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < (key === "offset" ? 0 : 1) || key === "limit" && Number(value[key]) > 50)) throw invalid();
}

export function parsePersonalSettingsRequest(value: unknown): PersonalSettingsRequest {
  if (!object(value) || value.v !== 1 || typeof value.op !== "string") throw invalid();
  if (!["settings.read", "lifecycle.status", "config.save", "config.preflight", "model.test", "mcp.discover", "mcp.cua-targets", "mcp.cua-status", "mcp.cua-control", "mcp.cua-image", "mcp.get", "mcp.migrate", "mcp.operations", "mcp.operation", "mcp.end", "mcp.set-enabled", "mcp.remove", "mcp.save-service", ...skillOperations].includes(value.op)) throw new PersonalError("settings_operation_unsupported", "此设置操作不受支持，请更新管理客户端；未执行其他命令。");
  let allowed: string[];
  if (value.op === "settings.read" || value.op === "lifecycle.status") {
    allowed = ["v", "op", "offset", "limit"];
    checkPage(value);
    if (value.op === "settings.read") {
      allowed.push("operationsOffset", "effectiveOffset");
      for (const key of ["operationsOffset", "effectiveOffset"]) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw invalid();
    }
  } else {
    allowed = ["v", "op", "profile", "expectedRevision"];
    if (!object(value.profile) || Object.keys(value.profile).sort().join(",") !== "directory,id" || typeof value.profile.directory !== "string" || !path.isAbsolute(value.profile.directory) || path.resolve(value.profile.directory) !== value.profile.directory || typeof value.profile.id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.profile.id) || typeof value.expectedRevision !== "string" || !/^(missing|sha256:[0-9a-f]{64})$/.test(value.expectedRevision)) throw invalid();
    if (value.op === "config.save" || value.op === "config.preflight") {
      allowed.push("target", "value");
      if ((value.target !== "model" && value.target !== "skills" && value.target !== "mcp") || !("value" in value)) throw invalid();
    } else if (value.op === "model.test") { allowed.push("value"); if (!("value" in value)) throw invalid(); }
    else if (value.op === "mcp.cua-control" || value.op === "mcp.cua-image") {
      allowed.push("operation", "observation");
      if (value.op === "mcp.cua-control") { allowed.push("action"); if (!["pause", "resume", "stop", "observe", "accept"].includes(String(value.action))) throw invalid(); }
      else { allowed.push("image", "offset"); if (typeof value.image !== "string" || !/^[0-9a-f-]{36}$/.test(value.image) || value.offset !== undefined && (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0)) throw invalid(); }
      const recovery = value.op === "mcp.cua-image" || !["pause", "resume"].includes(String(value.action));
      if (recovery && (!Number.isSafeInteger(value.operation) || Number(value.operation) < 1) || value.observation !== undefined && (!Number.isSafeInteger(value.observation) || Number(value.observation) < 1) || (value.op === "mcp.cua-image" || value.action === "accept") && value.observation === undefined || !recovery && (value.operation !== undefined || value.observation !== undefined)) throw invalid();
    }
    else if (value.op === "mcp.operations") { allowed.push("offset"); checkPage(value); }
    else if (value.op === "mcp.end" || value.op === "mcp.operation") { allowed.push("operation"); if (!Number.isSafeInteger(value.operation) || Number(value.operation) < 1) throw invalid(); if (value.op === "mcp.operation") { allowed.push("offset"); checkPage(value); } }
    else if (value.op === "mcp.discover" || value.op === "mcp.save-service") { allowed.push("service"); if (!object(value.service)) throw invalid(); }
    else if (value.op === "mcp.get" || value.op === "mcp.set-enabled" || value.op === "mcp.remove") {
      allowed.push("id"); if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id)) throw invalid();
      if (value.op === "mcp.get") { allowed.push("offset", "limit"); checkPage(value); }
      if (value.op === "mcp.set-enabled") { allowed.push("enabled"); if (typeof value.enabled !== "boolean") throw invalid(); }
    }
    else if (skillOperations.includes(value.op)) {
      if (["skills.list", "skills.select-directory"].includes(value.op)) { allowed.push("offset", "limit"); checkPage(value); }
      if (["skills.get", "skills.import", "skills.set-enabled", "skills.remove"].includes(value.op)) {
        allowed.push("id");
        if (typeof value.id !== "string" || !/^(?:external:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value.id)) throw invalid();
      }
      if (["skills.select-directory", "skills.preview-import", "skills.import"].includes(value.op)) {
        allowed.push("directory");
        if (typeof value.directory !== "string" || value.directory.length > 4096 || !path.isAbsolute(value.directory) || path.resolve(value.directory) !== value.directory || /[\x00-\x1f\x7f]/.test(value.directory)) throw invalid();
      }
      if (value.op === "skills.select-directory") { allowed.push("purpose"); if (value.purpose !== "library" && value.purpose !== "import") throw invalid(); }
      if (value.op === "skills.import") { allowed.push("contentRevision"); if (!revision(value.contentRevision) || value.contentRevision === "missing") throw invalid(); }
      if (value.op === "skills.set-enabled") { allowed.push("enabled"); if (typeof value.enabled !== "boolean") throw invalid(); }
    } else if (!["mcp.migrate", "mcp.cua-targets", "mcp.cua-status"].includes(value.op)) throw invalid();
  }
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
  return value as PersonalSettingsRequest;
}

export function personalSettingsIdentity(profile: PersonalProfileLock): PersonalSettingsIdentity {
  return personalSettingsDirectoryIdentity(profile.directory);
}

export function personalSettingsDirectoryIdentity(source: string): PersonalSettingsIdentity {
  const directory = fs.realpathSync(source), stat = fs.statSync(directory, { bigint: true });
  return { directory, id: digest(JSON.stringify([directory, stat.dev.toString(), stat.ino.toString()])) };
}

export function personalSettingsRevision(profile: PersonalProfileLock, target: PersonalSettingsTarget): string {
  const filename = path.join(profile.directory, `${target}.json`), before = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!before) return "missing";
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077)) throw new PersonalError("settings_config_invalid", "设置文件不是私有普通文件，请保留档案并恢复原配置。");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new PersonalError("settings_config_invalid", "设置文件在读取期间变化，请保留档案并重新读取。");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (let count = fs.readSync(fd, buffer); count; count = fs.readSync(fd, buffer)) { hash.update(buffer.subarray(0, count)); bytes += count; }
    const after = fs.fstatSync(fd), located = fs.lstatSync(filename);
    if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || located.dev !== stat.dev || located.ino !== stat.ino) throw new PersonalError("settings_config_invalid", "设置文件在读取期间变化，请保留档案并重新读取。");
    return `sha256:${hash.digest("hex")}`;
  } finally { fs.closeSync(fd); }
}

function checkTarget(profile: PersonalProfileLock, request: Exclude<PersonalSettingsRequest, { op: "settings.read" | "lifecycle.status" }>, target: PersonalSettingsTarget) {
  if (!isDeepStrictEqual(personalSettingsIdentity(profile), request.profile)) throw new PersonalError("settings_profile_changed", "所选个人档案身份已变化，未保存；请重新选择原档案。");
  if (personalSettingsRevision(profile, target) !== request.expectedRevision) throw new PersonalError("settings_revision_changed", "设置已被其他入口修改，未覆盖；请刷新当前配置并比较草稿。");
}

function pendingFiles(profile: PersonalProfileLock): PersonalSettingsBlocker[] {
  return fs.readdirSync(profile.directory).some(name => PERSONAL_PENDING_FILE.test(name) || PERSONAL_SCHEDULE_PENDING_FILE.test(name) || PERSONAL_QUESTION_PENDING_FILE.test(name) || name === "pending-background-end.json") ? [{ kind: "pending-input" }] : [];
}

export async function personalSettingsBlockers(profile: PersonalProfileLock): Promise<PersonalSettingsBlocker[]> {
  const blockers = pendingFiles(profile), filename = path.join(profile.directory, "personal.sqlite");
  if (!fs.existsSync(filename)) return blockers;
  const storage = await openNodeSqliteStorage(filename);
  try {
    const record = await storage.findDocument({ kind: "ruukoto.format", scope: { kind: "session" } }, "current", context), saved = record && await storage.document(record.id, "current", context);
    if (!saved || saved.version !== 1 || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw new PersonalError("extension_version", "个人业务格式无法核实，未更改设置；请保留档案并使用对应程序。");
    if (await hasPendingPersonalWork(storage)) blockers.push({ kind: "pending-work" });
    blockers.push(...await personalSettingsExternalBlockers({ storage }));
    return blockers.slice(0, 32);
  } finally { await storage.close(context); }
}

export async function assertPersonalSettingsIdle(profile: PersonalProfileLock): Promise<void> {
  if ((await personalSettingsBlockers(profile)).length) throw new PersonalError("settings_pending", "仍有待核实输入、未完成工作或未核实外部占用，未更改设置；请先用原配置处理后再保存。");
}


function safeEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  if (!url.search) return endpoint;
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, redacted);
  return url.toString();
}
async function safeService(service: PersonalMcpService) {
  if (service.cua) return { ...service, credentialStatus: "not-applicable" };
  const endpoint = safeEndpoint(service.endpoint!);
  let credentialStatus: "anonymous" | "valid" | "missing" | "invalid" = "anonymous";
  if (service.credential) {
    try {
      if (!fs.lstatSync(service.credential.path, { throwIfNoEntry: false })) credentialStatus = "missing";
      else { await resolvePersonalMcpToken(service); credentialStatus = "valid"; }
    } catch { credentialStatus = "invalid"; }
  }
  return { ...service, endpoint, endpointRedacted: endpoint !== service.endpoint, credentialStatus };
}
function restoreEndpoint(service: Record<string, unknown>, previous: PersonalMcpConfig | undefined) {
  if (typeof service.endpoint !== "string" || !service.endpoint.includes(redacted)) return service.endpoint;
  const original = previous?.services.find(item => item.id === service.id);
  if (!original || original.cua || safeEndpoint(original.endpoint!) !== service.endpoint) throw new PersonalError("mcp_endpoint_redacted", "原端点的隐藏字段无法核实，未保存；请刷新原服务或明确输入新的完整端点。");
  return original.endpoint;
}
function mcpDraft(profile: PersonalProfileLock, value: unknown) {
  if (!object(value) || !Array.isArray(value.services) || Object.keys(value).some(key => !["version", "generation", "services"].includes(key))) throw invalid();
  const previous = readPersonalMcp(profile);
  if (previous && Number(value.version) < previous.version) throw new PersonalError("mcp_config_downgrade", "MCP 已迁入新格式，不能降回旧配置；请刷新当前服务。");
  if (previous?.version === 1 && value.version === 2) throw new PersonalError("mcp_migration_required", "原 MCP 配置需先显式迁入新格式，再编辑单服务启停；未覆盖原配置。");
  return parsePersonalMcp({ ...value, generation: randomUUID(), services: value.services.map(service => {
    if (!object(service)) throw invalid();
    const { endpointRedacted: _redacted, credentialStatus: _status, authentication, credentialPath, credentialRebind, ...raw } = service;
    if (raw.cua !== undefined) { if (authentication !== undefined || credentialPath !== undefined || credentialRebind !== undefined) throw invalid(); return raw; }
    if (authentication !== undefined && authentication !== "anonymous" && authentication !== "credential" || credentialPath !== undefined && typeof credentialPath !== "string" || credentialRebind !== undefined && typeof credentialRebind !== "boolean") throw invalid();
    const original = previous?.services.find(item => item.id === raw.id);
    if (credentialRebind && (value.version !== 4 || typeof credentialPath !== "string")) throw invalid();
    const credential = typeof credentialPath === "string" ? original?.credential?.path === credentialPath && !credentialRebind ? original.credential : personalMcpCredential(credentialPath) : object(raw.credential) && original && raw.credential.path === original.credential?.path ? original.credential : raw.credential;
    if (authentication === "anonymous" && credential || authentication !== "anonymous" && !credential && !(original && !original.credential)) throw new PersonalError("mcp_credentials_required", "请选择私有凭据文件或明确匿名连接，未保存服务。");
    return { ...raw, endpoint: restoreEndpoint(raw, previous), ...(credential ? { credential } : {}) };
  }) });
}
export function parsePersonalSettingsDraft(profile: PersonalProfileLock, target: PersonalSettingsTarget, value: unknown) {
  return target === "model" ? parsePersonalModel(value) : target === "skills" ? parsePersonalSkills(value) : mcpDraft(profile, value);
}
export function mcpServiceDraft(profile: PersonalProfileLock, value: unknown) {
  if (!object(value) || typeof value.id !== "string") throw invalid();
  const previous = readPersonalMcp(profile), original = previous?.services.find(service => service.id === value.id);
  if (previous && previous.version !== 4 && value.cua === undefined && !original?.cua) throw new PersonalError("mcp_migration_required", "请先迁入 MCP 工具效果分类，再修改服务。");
  const service: Record<string, unknown> = { ...(original ?? { tools: [], enabled: true }), ...value };
  if (value.authentication === "anonymous" && !("credential" in value) && !("credentialPath" in value)) delete service.credential;
  const services = original ? previous!.services.map(item => item.id === value.id ? service : item) : [...(previous?.services ?? []), service];
  if (previous?.version === 4 || !previous) for (const item of services) if (item.cua === undefined && item.toolEffects === undefined) item.toolEffects = Object.fromEntries((item.tools as PersonalMcpService["tools"]).map(tool => [tool.name, "unknown"]));
  return mcpDraft(profile, { version: previous?.version ?? 4, services });
}
async function credentialState(config: PersonalModelConfig, online: boolean) {
  return { reference: config.apiKeyEnv, state: online ? process.env[config.apiKeyEnv] ? "available" : "missing" : "unverified" };
}

function settingsSkillLibrary(profile: PersonalProfileLock, page: { offset?: number; limit?: number } = {}) {
  const config = readPersonalSkills(profile) ?? null;
  let store: ManagedSkillsStore, externalAvailable = true;
  try { store = personalSkillStore(profile); }
  catch (error) {
    if (!(error instanceof PersonalError) || error.code !== "skills_directory_unavailable") throw error;
    externalAvailable = false;
    store = new ManagedSkillsStore(profile.directory, []);
  }
  const library = store.list(page);
  return { sourceHost: "personal", config, externalAvailable, ...library, diagnostics: [...(externalAvailable ? [] : ["外部技能库不可用；请恢复原目录或停机修改技能库配置。"]), ...library.diagnostics].slice(0, 100), diagnosticsTruncated: library.diagnosticsTruncated || !externalAvailable && library.diagnostics.length === 100 };
}

function selectSkillDirectory(request: Extract<PersonalSkillSettingsRequest, { op: "skills.select-directory" }>) {
  const directory = request.directory;
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new PersonalError("skills_directory_invalid", "请选择远端真实普通目录，链接目录请改选原路径。");
  const handle = fs.opendirSync(directory), names: string[] = [];
  let scanned = 0, truncated = false;
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++scanned > 1000) { truncated = true; break; }
      if (entry.isDirectory() && !/[\x00-\x1f\x7f]/.test(entry.name)) names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  names.sort();
  const offset = request.offset ?? 0, limit = request.limit ?? 20, candidate = path.join(directory, request.purpose === "library" ? "skills" : "SKILL.md");
  const stat = request.purpose === "library" ? fs.statSync(candidate, { throwIfNoEntry: false }) : fs.lstatSync(candidate, { throwIfNoEntry: false });
  return { purpose: request.purpose, directory, selectable: request.purpose === "library" ? !!stat?.isDirectory() : !!stat?.isFile(), directories: names.slice(offset, offset + limit).map(name => ({ name, directory: path.join(directory, name) })), offset, hasMore: offset + limit < names.length, truncated };
}

function isSkillSettings(request: PersonalSettingsRequest): request is PersonalSkillSettingsRequest { return skillOperations.includes(request.op); }

async function skillSettings(profile: PersonalProfileLock, request: PersonalSkillSettingsRequest) {
  const state = new ManagedSkillsStore(profile.directory, []).list({ limit: 1 });
  if (state.revision !== request.expectedRevision) throw new PersonalError("skills_revision_conflict", "托管技能清单已变化，未更改技能；请刷新原后台并比较后重新选择。");
  if (request.op === "skills.select-directory") {
    try { return selectSkillDirectory(request); }
    catch (error) {
      if (error instanceof PersonalError) throw error;
      throw new PersonalError("skills_directory_unavailable", "所选远端目录无法列出，请核实配置来源或技能导入目录后重新选择。", { cause: error });
    }
  }
  if (request.op === "skills.list") return settingsSkillLibrary(profile, request);
  const store = personalSkillStore(profile);
  if (request.op === "skills.get") return store.get(request.id);
  if (request.op === "skills.preview-import") return store.preview(request.directory);
  throw new PersonalError("settings_upgrade_required", "配置写入需要新版管理客户端，请升级后读取原配置；未执行保存。");
}

type ModelTestEvidence = { version: 1; requestId: string; config: PersonalModelConfig; input: { messages: { role: "user"; content: string; timestamp: number }[] }; maxTokens: 1; payload?: JsonValue };
export async function testPersonalModel(config: PersonalModelConfig, options: { provider?: Provider; timeoutMs?: number; record?: (evidence: ModelTestEvidence) => Promise<void> } = {}) {
  if (!process.env[config.apiKeyEnv]) return { status: "failed" as const, code: "model_credentials_missing", message: "后台没有所选模型凭据，请配置原启动环境后重试。" };
  const models = createModels(); models.setProvider(options.provider ?? personalProvider(config));
  const model = models.getModel("personal", config.modelId);
  if (!model) throw new PersonalError("model_config_invalid", "无法解析所选模型，请重新读取模型配置。");
  const controller = new AbortController(), timeoutMs = options.timeoutMs ?? PERSONAL_SETTINGS_LIMITS.modelTestMs;
  const evidence: ModelTestEvidence = { version: 1, requestId: randomUUID(), config, input: { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, maxTokens: 1 };
  let evidenceFailed = false;
  const record = async (value: ModelTestEvidence) => {
    try { await options.record?.(value); }
    catch (error) { evidenceFailed = true; throw new PersonalError("model_test_evidence_failed", "模型测试证据未保存，未发送请求；请保留档案并检查存储。", { cause: error }); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, timeoutMs); });
  try {
    await record(evidence);
    const reply = await Promise.race([models.completeSimple(model, evidence.input, { maxTokens: 1, signal: controller.signal, onPayload: async payload => { await record({ ...evidence, payload: JSON.parse(JSON.stringify(payload)) as JsonValue }); } }), timedOut]);
    if (reply && reply.stopReason !== "error" && reply.stopReason !== "aborted" && !controller.signal.aborted) return { status: "passed" as const, code: "model_connection_ok", message: "模型连接测试成功。" };
  } catch {
    // SDK 失败可能包含请求、响应或凭据，只返回固定诊断。
  } finally { clearTimeout(timer); }
  if (evidenceFailed) return { status: "failed" as const, code: "model_test_evidence_failed", message: "模型测试证据未保存，未发送请求；请保留档案并检查存储。" };
  return { status: "failed" as const, code: controller.signal.aborted ? "model_test_timeout" : "model_connection_failed", message: controller.signal.aborted ? "模型连接测试超时，请检查服务后显式重试。" : "模型连接测试失败，请检查地址、API 类型与后台凭据。" };
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-settings.md
export async function dispatchPersonalSettings(current: PersonalSettingsContext, value: unknown): Promise<unknown> {
  if (object(value) && typeof value.op === "string" && value.op.startsWith("im.pair-")) {
    const { parsePersonalImPairingRequest, dispatchPersonalImPairing } = await import("./personal-im-pairing.ts");
    const request = parsePersonalImPairingRequest(value);
    if (!current.instance) throw new PersonalError("im_pairing_online_required", "入口配对需要原后台在线，以后台实际凭据核实身份；当前未验证，未启动后台。");
    return dispatchPersonalImPairing(current.instance, request);
  }
  if (object(value) && value.v === 2) {
    const { dispatchPersonalConfiguration } = await import("./personal-settings-operations.ts");
    return dispatchPersonalConfiguration(current, value);
  }
  const request = parsePersonalSettingsRequest(value), { profile } = current, online = !!current.instance;
  if (["config.save", "mcp.migrate", "mcp.save-service", "mcp.set-enabled", "mcp.remove", "skills.import", "skills.set-enabled", "skills.remove"].includes(request.op)) throw new PersonalError("settings_upgrade_required", "配置写入需要 v2 客户端，请升级后读取原配置；未执行停存启。");
  const identity = personalSettingsIdentity(profile), base = { product: "ruukoto", profile: identity, online };
  if (request.op === "lifecycle.status") return { ...base, lifecycle: { state: online ? "running" : "stopped", ...(online ? { pid: process.pid } : {}), managedDevelopment: !!current.development, automaticRestart: false, originalEnvironment: "unverified" } };
  if (request.op === "settings.read") {
    const { personalSettingsFileIssues } = await import("./personal-settings-operations.ts");
    const fileIssues = await personalSettingsFileIssues(current), affected = new Set(fileIssues.map(issue => issue.target));
    const revisions = Object.fromEntries((Object.keys(PERSONAL_CONFIGURATION_FILES) as PersonalConfigurationTarget[]).filter(target => target !== "managed-skills").map(target => { const issue = fileIssues.find(issue => issue.target === target); return [target, issue ? issue.actualRevision ?? "unverified" : readPersonalConfigurationRevision(profile, target)]; }));
    const revisionsUnknown = fileIssues.filter(issue => issue.actualRevision === null).map(issue => issue.target);
    const model = affected.has("model") || revisions.model === "missing" ? undefined : readPersonalConfig(profile), mcp = affected.has("mcp") ? undefined : readPersonalMcp(profile), offset = request.offset ?? 0, limit = request.limit ?? 20;
    const config = (target: PersonalConfigurationTarget) => affected.has(target) ? null : readPersonalConfigurationFile(profile, target).config;
    return { ...base, settingsProtocol: 2, ...await settingsFacts(current, request), revisions, revisionsUnknown, fileIssues, commands: config("commands"), services: config("services"), "web-search": affected.has("web-search") ? null : readPersonalWebSearch(profile) ?? null, telegram: config("telegram"), qq: config("qq"), model: model ? { config: model, credential: await credentialState(model, online) } : null, skills: affected.has("skills") || affected.has("managed-skills") ? { config: null, revision: "unverified", skills: [], diagnostics: ["技能配置文件与保存历史不符，已暂停新接纳；请恢复原文件后刷新。"] } : settingsSkillLibrary(profile, { offset, limit }),
      mcp: mcp ? { version: mcp.version, generation: mcp.generation, services: await Promise.all(mcp.services.slice(offset, offset + limit).map(async service => ({ ...await safeService(service), tools: service.tools.map(tool => ({ name: tool.name, description: tool.description?.slice(0, 1024) })) }))), offset, hasMore: offset + limit < mcp.services.length } : null,
      blockers: [], lifecycle: { managedDevelopment: !!current.development, automaticRestart: false, originalEnvironment: "unverified" } };
  }
  if (!("profile" in request)) throw invalid();
  if (isSkillSettings(request)) {
    if (!isDeepStrictEqual(identity, request.profile)) throw new PersonalError("settings_profile_changed", "所选个人档案身份已变化，未更改技能；请重新选择原档案。");
    return { ...base, sourceHost: "personal", ...await skillSettings(profile, request) };
  }
  const target = request.op === "model.test" ? "model" : request.op === "config.save" || request.op === "config.preflight" ? request.target : "mcp";
  checkTarget(profile, request, target);
  if (request.op === "mcp.cua-targets") return { ...base, revision: request.expectedRevision, ...await discoverCuaTargets("cua-linux") };
  if (request.op === "mcp.operations" || request.op === "mcp.operation" || request.op === "mcp.end") {
    const { withPersonalSettingsSession } = await import("./personal-settings-operations.ts");
    if (request.op === "mcp.operations") return withPersonalSettingsSession(current, async session => { const page = await session.commit(tx => mcpList(tx, request.offset ?? 0), context); return { ...base, operations: page.items, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) }; });
    if (request.op === "mcp.operation") return withPersonalSettingsSession(current, async session => ({ ...base, ...await session.commit(tx => mcpDetail(tx, request.operation as TaskId, request.offset ?? 0), context) }));
    if (current.instance?.mcp) await current.instance.mcp.end(request.operation as TaskId);
    else await withPersonalSettingsSession(current, session => session.commit(tx => mcpEnd(tx, request.operation as TaskId), context));
    return { ...base, operation: request.operation, ended: true };
  }
  if (request.op === "mcp.cua-status") return { ...base, revision: request.expectedRevision, available: !!current.instance?.mcp && !!readPersonalMcp(profile)?.services.some(service => service.cua), ...(current.instance?.mcp ? await current.instance.mcp.cuaStatus() : { paused: true, busy: false, operations: [] }) };
  if (request.op === "mcp.cua-control" || request.op === "mcp.cua-image") {
    const mcp = current.instance?.mcp;
    if (!mcp) throw new PersonalError("cua_offline", "电脑管理需要原个人后台在线，请先启动原服务后刷新。");
    if (request.op === "mcp.cua-image") return { ...base, ...await mcp.cuaImage(request.operation as TaskId, request.observation as EntryId, request.image, request.offset) };
    if (request.action === "pause" || request.action === "resume") await mcp.pauseCua(request.action === "pause");
    else await mcp.recoverCua(request.operation as TaskId, request.action, request.observation as EntryId | undefined);
    return { ...base, saved: true, ...await mcp.cuaStatus() };
  }
  if (request.op === "model.test") {
    const config = parsePersonalModel(request.value);
    return { ...base, revision: request.expectedRevision, test: online ? await testPersonalModel(config, { record: async evidence => { await current.instance!.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.settings-model-test", data: evidence }), context); } }) : { status: "unverified", code: "model_environment_unverified", message: "后台已停机，无法核实原服务凭据环境；请启动原后台后显式测试。" } };
  }
  if (request.op === "mcp.get") {
    const service = readPersonalMcp(profile)?.services.find(service => service.id === request.id);
    if (!service) throw new PersonalError("mcp_service_missing", "原 MCP 服务不存在，请刷新服务列表。");
    const offset = request.offset ?? 0, limit = request.limit ?? 1;
    return { ...base, revision: request.expectedRevision, service: await safeService({ ...service, tools: service.tools.slice(offset, offset + limit) }), toolsOffset: offset, toolsHasMore: offset + limit < service.tools.length };
  }
  if (request.op === "mcp.discover") {
    if (!object(request.service)) throw invalid();
    if (Object.keys(request.service).some(key => !["id", "label", "endpoint", "endpointRedacted", "authentication", "credential", "credentialPath", "cua"].includes(key))) throw invalid();
    const raw = request.service, previous = readPersonalMcp(profile), endpoint = restoreEndpoint(raw, previous);
    if (raw.cua !== undefined) {
      if (Object.keys(raw).some(key => !["id", "label", "cua"].includes(key))) throw invalid();
      const config = parsePersonalMcp({ version: 3, generation: randomUUID(), services: [{ id: raw.id ?? randomUUID(), label: raw.label ?? "电脑", cua: raw.cua, enabled: true, tools: [] }] });
      try { const service = config.services[0]; return { ...base, revision: request.expectedRevision, tools: (await discoverPersonalMcp(service)).filter(tool => restrictCuaTool(service.cua!, tool)) }; }
      catch (error) { if (error instanceof PersonalError) throw error; throw new PersonalError("mcp_discovery_failed", "电脑工具发现失败，请检查固定程序与目标；未调用业务工具。"); }
    }
    if (raw.authentication !== undefined && raw.authentication !== "anonymous" && raw.authentication !== "credential" || raw.credentialPath !== undefined && typeof raw.credentialPath !== "string") throw invalid();
    const credential = typeof raw.credentialPath === "string" ? personalMcpCredential(raw.credentialPath) : raw.credential;
    if (raw.authentication === "anonymous" && credential || raw.authentication !== "anonymous" && !credential) throw new PersonalError("mcp_credentials_required", "请选择私有凭据文件或明确匿名连接，未发送发现请求。");
    const config = parsePersonalMcp({ version: 4, generation: randomUUID(), services: [{ id: raw.id ?? randomUUID(), label: raw.label ?? "MCP", endpoint, enabled: true, ...(credential ? { credential } : {}), tools: [], toolEffects: {} }] });
    let tools;
    try { tools = await discoverPersonalMcp(config.services[0]); }
    catch (error) { if (error instanceof PersonalError) throw error; throw new PersonalError("mcp_discovery_failed", "MCP 工具发现失败，请检查端点与凭据后显式重试；未调用业务工具。"); }
    return { ...base, revision: request.expectedRevision, service: await safeService(config.services[0]), tools };
  }
  if (request.op !== "config.preflight") throw invalid();
  const draft = parsePersonalSettingsDraft(profile, target, request.value);
  if (request.op === "config.preflight") {
    if (target === "skills") personalSkillsDirectory(parsePersonalSkills(draft));
    if (target === "mcp") await validatePersonalMcpCredentials(parsePersonalMcp(draft), readPersonalMcp(profile));
    return { ...base, revision: request.expectedRevision, blockers: [], ...(target === "model" ? { credential: await credentialState(parsePersonalModel(draft), online) } : {}), connection: "untested" };
  }
  throw invalid();
}

export async function executePersonalSettings(target: string | PersonalProfileLock, value: unknown): Promise<unknown> {
  if (typeof target !== "string") return dispatchPersonalSettings({ profile: target }, value);
  const directory = target;
  const request = object(value) && value.v === 2 ? (await import("./personal-settings-operations.ts")).parsePersonalSettingsWriteRequest(value) : object(value) && typeof value.op === "string" && value.op.startsWith("im.pair-") ? (await import("./personal-im-pairing.ts")).parsePersonalImPairingRequest(value) : parsePersonalSettingsRequest(value);
  const { personalControl } = await import("./personal-control.ts");
  try { return await personalControl(directory, "POST", "/settings", request); }
  catch (error) {
    if (!(error instanceof PersonalError) || !["control_unavailable", "control_response_lost"].includes(error.code)) throw error;
  }
  const profile = lockPersonalProfile(directory);
  try { return await dispatchPersonalSettings({ profile }, request); }
  finally { profile.release(); }
}

export async function runPersonalSettingsMachine(directory: string, input: AsyncIterable<Buffer | string>, write: (value: string) => void): Promise<number> {
  let response: unknown, status = 0;
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > PERSONAL_SETTINGS_LIMITS.requestBytes) throw new PersonalError("settings_request_large", "设置请求过大，请缩小本次表单后重新提交。");
      chunks.push(buffer);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw invalid(); }
    const result = await executePersonalSettings(directory, value);
    response = { v: 1, product: "ruukoto", ok: true, result };
    if (Buffer.byteLength(JSON.stringify(response)) > PERSONAL_SETTINGS_LIMITS.responseBytes) throw new PersonalError("settings_response_large", "设置查询结果过大，请缩小分页或选择单个服务后查询。");
  } catch (error) {
    status = 1;
    const known = error instanceof PersonalError || error instanceof ManagedSkillsError;
    response = { v: 1, product: "ruukoto", ok: false, code: known ? error.code : "settings_internal", message: known ? error.message : "设置结果无法核实，请保留档案并重新读取原配置；未自动重试。" };
  }
  write(JSON.stringify(response) + "\n");
  return status;
}
