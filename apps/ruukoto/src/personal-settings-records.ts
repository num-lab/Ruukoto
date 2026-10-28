import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, ROOT_CONVERSATION_ID, type Tx, type Session, type Storage, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ServiceManagerConfig } from "./service-helper.ts";
import { PersonalError } from "./personal-error.ts";
import { LEGACY_PERSONAL_FORMAT, PERSONAL_FORMAT, type PersonalConfigurationMigration, type PersonalProfileLock } from "./personal-profile.ts";

export type PersonalConfigurationTarget = "model" | "skills" | "managed-skills" | "mcp" | "web-search" | "telegram" | "qq" | "commands" | "services";
export type PersonalConfigurationVersion = { origin?: "host"; legacyThrough?: EntryId | null; legacyOperations?: TaskId[]; hostService?: Pick<ServiceManagerConfig, "useSudo" | "timeouts">; version: string; target: PersonalConfigurationTarget; revision: string; previousRevision: string | null; previousVersion: string | null; config: JsonValue | null; content: string | null };
export type PersonalSettingsFileIssue = { target: PersonalConfigurationTarget; code: "settings_file_unverified"; expectedRevision: string; actualRevision: string | null };
export type PersonalSettingsReceipt = {
  v: 2; id: string; profile: { directory: string; id: string }; target: PersonalConfigurationTarget; scope: string; requestDigest: string;
  status: "rejected" | "saved" | "waiting" | "active" | "failed" | "unknown" | "superseded";
  savedRevision: string | null; effectiveRevision: string | null; code: string; relatedOperations: { kind: string; id: string }[];
  supersededBy?: string;
};
type SettingsOperation = { receipt: PersonalSettingsReceipt; candidate: PersonalConfigurationVersion; expectedRevision: string; facts: { status: PersonalSettingsReceipt["status"]; code: string; savedRevision: string | null; effectiveRevision: string | null }[] };
type ConfigurationIndex = { versions: { target: PersonalConfigurationTarget; version: string }[]; operations: string[]; effective: { target: PersonalConfigurationTarget; scope: string; version: string }[]; initializedWithoutRoot: boolean; migrationId: string | null };
export const PersonalConfigurationDoc = defineDoc<ConfigurationIndex>({ kind: "ruukoto.settings", scope: "session", version: 1, initial: () => ({ versions: [], operations: [], effective: [], initializedWithoutRoot: false, migrationId: null }) });
export const PersonalConfigurationVersionDoc = defineDocFamily<{ value?: PersonalConfigurationVersion }, null>({ kind: "ruukoto.configuration-version", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalSettingsOperationDoc = defineDocFamily<{ operation?: SettingsOperation }, null>({ kind: "ruukoto.settings-operation", scope: "session", version: 1, family: true, initial: () => ({}) });
export const personalConfigurationDigest = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
export const PersonalFormatDoc = defineDoc({ kind: "ruukoto.format", scope: "session", version: 1, initial: () => ({ ...PERSONAL_FORMAT }) });
export const PERSONAL_CONFIGURATION_FILES: Record<PersonalConfigurationTarget, string> = { model: "model.json", skills: "skills.json", "managed-skills": "managed-skills/state.json", mcp: "mcp.json", "web-search": "web-search.json", telegram: "telegram.json", qq: "qq.json", commands: "command.json", services: "service.json" };
export const PERSONAL_ACTIVE_CONFIGURATION_TARGETS: readonly PersonalConfigurationTarget[] = ["model", "mcp", "web-search", "telegram", "qq", "commands", "services"];
const invalid = () => new PersonalError("settings_history_invalid", "配置保存历史无法核实，请保留档案并核实原操作；未发布候选配置。");
function validConfigurationOrigin(value: PersonalConfigurationVersion, previous: PersonalConfigurationVersion | undefined) {
  if (value.origin === undefined) return (value.content !== null || value.config === null) && (value.hostService === undefined || value.target === "services" && previous?.hostService !== undefined && isDeepStrictEqual(value.hostService, previous.hostService));
  return value.origin === "host" && (value.legacyThrough === null || typeof value.legacyThrough === "number" && Number.isSafeInteger(value.legacyThrough) && value.legacyThrough > 0) && (value.target === "commands" || value.target === "services" && !!value.hostService && typeof value.hostService.useSudo === "boolean" && Array.isArray(value.legacyOperations) && value.legacyOperations.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0) && new Set(value.legacyOperations).size === value.legacyOperations.length) && value.content === null && value.config !== null && value.revision === "missing" && previous?.content === null && previous.config === null && previous.revision === "missing" && previous.previousVersion === null;
}

export function personalConfigurationContentRevision(target: PersonalConfigurationTarget, content: string | null): string {
  if (target !== "managed-skills") return content === null ? "missing" : personalConfigurationDigest(content);
  const value = content === null ? { version: 1, packages: [] } : JSON.parse(content) as { version: number; packages: JsonValue; revision: string };
  const revision = personalConfigurationDigest(JSON.stringify({ version: value.version, packages: value.packages }));
  if ("revision" in value && value.revision !== revision) throw invalid();
  return revision;
}

function readConfigurationContent(profile: PersonalProfileLock, target: PersonalConfigurationTarget): string | null {
  const filename = path.join(profile.directory, PERSONAL_CONFIGURATION_FILES[target]), before = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o077) throw invalid();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let content: string;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile() || stat.nlink !== 1) throw invalid();
    content = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd), located = fs.lstatSync(filename);
    if (Buffer.byteLength(content) !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.dev !== located.dev || stat.ino !== located.ino) throw invalid();
  } finally { fs.closeSync(fd); }
  return content;
}

export function readPersonalConfigurationRevision(profile: PersonalProfileLock, target: PersonalConfigurationTarget): string {
  return personalConfigurationContentRevision(target, readConfigurationContent(profile, target));
}

export function readPersonalConfigurationFile(profile: PersonalProfileLock, target: PersonalConfigurationTarget): { content: string | null; config: JsonValue | null; revision: string } {
  const content = readConfigurationContent(profile, target);
  if (content === null) return { content, config: null, revision: personalConfigurationContentRevision(target, content) };
  let config: JsonValue;
  try { config = JSON.parse(content) as JsonValue; } catch (error) { throw new PersonalError("settings_config_invalid", "配置文件无法解析，未保存更改；请保留档案并修复原配置文件。", { cause: error }); }
  return { content, config, revision: personalConfigurationContentRevision(target, content) };
}

export function replacePersonalConfigurationFile(profile: PersonalProfileLock, filename: string, content: string): void {
  const destination = path.join(profile.directory, filename), temporary = `${destination}.tmp`;
  const before = fs.lstatSync(temporary, { throwIfNoEntry: false });
  if (before && (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o077)) throw invalid();
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || before && (stat.dev !== before.dev || stat.ino !== before.ino)) throw invalid();
    fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, content); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, destination);
  const directory = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export async function assertPersonalConfigurationStorage(profile: PersonalProfileLock, storage: Storage, existing: boolean): Promise<void> {
  const ref = await storage.findDocument({ kind: PersonalFormatDoc.definition.kind, scope: { kind: "session" } }, "current", BACKGROUND_CONTEXT);
  const saved = ref && await storage.document(ref.id, "current", BACKGROUND_CONTEXT);
  if (saved) {
    if (saved.version !== 1 || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT) && !isDeepStrictEqual(saved.value, LEGACY_PERSONAL_FORMAT)) throw new PersonalError("extension_version", "个人业务格式与当前程序不兼容，已停止；请保留档案并使用对应程序。");
    return;
  }
  if (!existing) return;
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(profile.directory, "profile.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("configurationMigration" in manifest)) throw invalid();
  const conversations = await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT), documents = await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 1, undefined, BACKGROUND_CONTEXT);
  if (conversations.items.length || documents.items.length) throw invalid();
}

export async function initializePersonalSettings(profile: PersonalProfileLock, session: Pick<Session, "commit" | "snapshot">): Promise<void> {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(profile.directory, "profile.json"), "utf8"));
  const index = await session.snapshot(PersonalConfigurationDoc, BACKGROUND_CONTEXT), format = await session.snapshot(PersonalFormatDoc, BACKGROUND_CONTEXT);
  const root = await session.commit(async tx => !!await tx.conversation(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT);
  if (!format && (index || root)) throw invalid();
  if (format && !root && !index?.initializedWithoutRoot) throw invalid();
  if (index?.migrationId && isDeepStrictEqual(manifest, PERSONAL_FORMAT)) {
    if (!isDeepStrictEqual(format, PERSONAL_FORMAT) || !root && !index.initializedWithoutRoot) throw invalid();
    return;
  }
  const existingMigration = manifest && typeof manifest === "object" && "configurationMigration" in manifest ? manifest.configurationMigration as PersonalConfigurationMigration : undefined;
  const targets = existingMigration ? existingMigration.revisions.map(value => value.target as PersonalConfigurationTarget) : PERSONAL_ACTIVE_CONFIGURATION_TARGETS;
  const files = targets.map(target => ({ target, ...readPersonalConfigurationFile(profile, target) }));
  const revisions = files.map(({ target, revision }) => ({ target, revision }));
  const migration: PersonalConfigurationMigration = existingMigration ?? { from: LEGACY_PERSONAL_FORMAT, to: PERSONAL_FORMAT, id: randomUUID(), revisions };
  if (!isDeepStrictEqual(migration.revisions, revisions) || index?.migrationId && index.migrationId !== migration.id || format && !isDeepStrictEqual(format, PERSONAL_FORMAT) && !isDeepStrictEqual(format, LEGACY_PERSONAL_FORMAT)) throw invalid();
  if (!existingMigration) replacePersonalConfigurationFile(profile, "profile.json", JSON.stringify({ ...LEGACY_PERSONAL_FORMAT, configurationMigration: migration }) + "\n");
  if (!index?.migrationId) await session.commit(async tx => {
    const index = await tx.doc(PersonalConfigurationDoc), format = await tx.doc(PersonalFormatDoc);
    for (const file of files) {
      const value = { ...file, version: `baseline-${migration.id}`, previousRevision: null, previousVersion: null };
      await appendPersonalConfiguration(tx, value);
      await selectPersonalConfiguration(tx, file.target, "*", value.version);
    }
    Object.assign(format, PERSONAL_FORMAT); index.migrationId = migration.id; index.initializedWithoutRoot = !root;
  }, BACKGROUND_CONTEXT);
  replacePersonalConfigurationFile(profile, "profile.json", JSON.stringify(PERSONAL_FORMAT) + "\n");
}

// Note: 见 .agents/notes/proposed/architecture/2026-10-25-operation-scoped-configuration.md
export async function personalConfigurationVersions(tx: Tx, target: PersonalConfigurationTarget): Promise<PersonalConfigurationVersion[]> {
  const index = await tx.doc(PersonalConfigurationDoc), values: PersonalConfigurationVersion[] = [];
  const seen = new Set<string>();
  for (const ref of index.versions.filter(ref => ref.target === target)) {
    const value = (await tx.doc(PersonalConfigurationVersionDoc, `${target}:${ref.version}`, null)).value;
    const previous = values.at(-1);
    if (!value || !validConfigurationOrigin(value, previous) || value.target !== target || value.version !== ref.version || seen.has(value.version) || value.revision !== personalConfigurationContentRevision(target, value.content) || value.previousVersion !== (previous?.version ?? null) || value.previousRevision !== (previous?.revision ?? null)) throw invalid();
    if (value.content !== null && !isDeepStrictEqual(JSON.parse(value.content), value.config)) throw invalid();
    seen.add(value.version); values.push(copyJson(value) as PersonalConfigurationVersion);
  }
  return values;
}

export async function personalConfigurationVersion(tx: Tx, target: PersonalConfigurationTarget, revision: string): Promise<PersonalConfigurationVersion | undefined> {
  return (await personalConfigurationVersions(tx, target)).findLast(value => value.revision === revision);
}

export async function loadPersonalConfigurationSelection(storage: Storage, target: PersonalConfigurationTarget): Promise<{ versions: PersonalConfigurationVersion[]; effective: { scope: string; value: PersonalConfigurationVersion }[] } | undefined> {
  const address = await storage.findDocument({ kind: PersonalConfigurationDoc.definition.kind, scope: { kind: "session" } }, "current", BACKGROUND_CONTEXT);
  if (!address) return;
  const saved = await storage.document(address.id, "current", BACKGROUND_CONTEXT);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.value.versions) || !Array.isArray(saved.value.effective) || typeof saved.value.migrationId !== "string") throw invalid();
  const index = saved.value as ConfigurationIndex;
  const versions: PersonalConfigurationVersion[] = [];
  for (const ref of index.versions.filter(ref => ref.target === target)) {
    const record = await storage.findDocument({ kind: PersonalConfigurationVersionDoc.definition.kind, scope: { kind: "session" }, key: `${target}:${ref.version}` }, "current", BACKGROUND_CONTEXT);
    const saved = record && await storage.document(record.id, "current", BACKGROUND_CONTEXT), value = saved?.value.value as PersonalConfigurationVersion | undefined;
    const previous = versions.at(-1);
    if (!saved || saved.version !== 1 || !value || !validConfigurationOrigin(value, previous) || value.target !== target || value.version !== ref.version || versions.some(item => item.version === value.version) || value.previousVersion !== (previous?.version ?? null) || value.previousRevision !== (previous?.revision ?? null) || value.revision !== personalConfigurationContentRevision(target, value.content) || value.content !== null && !isDeepStrictEqual(JSON.parse(value.content), value.config)) throw invalid();
    versions.push(structuredClone(value));
  }
  const effective = index.effective.filter(ref => ref.target === target).map(ref => {
    const value = versions.find(value => value.version === ref.version);
    if (!value) throw invalid();
    return { scope: ref.scope, value };
  });
  return { versions, effective };
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-25-personal-settings-versions.md
export async function personalBootstrapConfigurations(profile: PersonalProfileLock): Promise<Map<PersonalConfigurationTarget, JsonValue | null>> {
  const filename = path.join(profile.directory, "personal.sqlite"), configurations = new Map<PersonalConfigurationTarget, JsonValue | null>();
  if (!fs.existsSync(filename)) return configurations;
  let storage: Storage;
  try { storage = await openNodeSqliteStorage(filename); }
  catch (error) { throw new PersonalError("settings_storage_unavailable", "个人配置档案无法打开，已停止启动；请保留档案并检查数据库。", { cause: error }); }
  try {
    await assertPersonalConfigurationStorage(profile, storage, true);
    for (const target of ["model", "mcp", "telegram", "qq", "commands", "services"] as const) {
      const selection = await loadPersonalConfigurationSelection(storage, target), latest = selection?.versions.at(-1);
      if (!selection || !latest) continue;
      let matches = false;
      try { matches = readPersonalConfigurationRevision(profile, target) === latest.revision; }
      catch {
        // 文件无法核实时由恢复阶段暂停该目标，启动只使用已核实的持久选择。
      }
      if (matches) continue;
      const effective = selection.effective.find(value => value.scope === "*")?.value;
      if (!effective) throw invalid();
      const config = target === "model" && effective.config === null ? selection.versions.findLast(value => value.config !== null)?.config : effective.config;
      if (config === undefined) throw invalid();
      configurations.set(target, config);
    }
    return configurations;
  } finally { await storage.close(BACKGROUND_CONTEXT); }
}

export async function appendPersonalConfiguration(tx: Tx, value: PersonalConfigurationVersion): Promise<void> {
  const versions = await personalConfigurationVersions(tx, value.target), index = await tx.doc(PersonalConfigurationDoc);
  const doc = await tx.doc(PersonalConfigurationVersionDoc, `${value.target}:${value.version}`, null);
  if (doc.value) { if (!isDeepStrictEqual(doc.value, value)) throw invalid(); return; }
  const previous = versions.at(-1);
  if (!validConfigurationOrigin(value, previous) || value.previousVersion !== (previous?.version ?? null) || value.previousRevision !== (previous?.revision ?? null) || value.revision !== personalConfigurationContentRevision(value.target, value.content)) throw invalid();
  doc.value = structuredClone(value); index.versions.push({ target: value.target, version: value.version });
}

export async function personalSettingsOperation(tx: Tx, id: string): Promise<SettingsOperation | undefined> {
  const index = await tx.doc(PersonalConfigurationDoc);
  if (!index.operations.includes(id)) return;
  const operation = (await tx.doc(PersonalSettingsOperationDoc, id, null)).operation;
  if (!operation) throw invalid();
  if (!index.operations.includes(id) || operation.receipt.id !== id || !operation.facts.length || !isDeepStrictEqual(operation.facts.at(-1), { status: operation.receipt.status, code: operation.receipt.code, savedRevision: operation.receipt.savedRevision, effectiveRevision: operation.receipt.effectiveRevision })) throw invalid();
  return copyJson(operation) as SettingsOperation;
}

export async function recordPersonalSettingsOperation(tx: Tx, operation: SettingsOperation): Promise<void> {
  const previous = await personalSettingsOperation(tx, operation.receipt.id), index = await tx.doc(PersonalConfigurationDoc), doc = await tx.doc(PersonalSettingsOperationDoc, operation.receipt.id, null);
  if (previous && (!isDeepStrictEqual(previous.candidate, operation.candidate) || previous.receipt.requestDigest !== operation.receipt.requestDigest || !isDeepStrictEqual(previous.facts, operation.facts.slice(0, previous.facts.length)))) throw invalid();
  doc.operation = structuredClone(operation);
  if (!previous) index.operations.push(operation.receipt.id);
}

export function advancePersonalSettingsOperation(operation: SettingsOperation, change: Partial<PersonalSettingsReceipt>): SettingsOperation {
  const receipt = { ...operation.receipt, ...change };
  return { ...operation, receipt, facts: [...operation.facts, { status: receipt.status, code: receipt.code, savedRevision: receipt.savedRevision, effectiveRevision: receipt.effectiveRevision }] };
}

export async function effectivePersonalConfiguration(tx: Tx, target: PersonalConfigurationTarget, scope: string): Promise<PersonalConfigurationVersion | undefined> {
  const ref = (await tx.doc(PersonalConfigurationDoc)).effective.find(ref => ref.target === target && ref.scope === scope);
  if (!ref) return;
  const versions = await personalConfigurationVersions(tx, target), value = versions.find(value => value.version === ref.version);
  if (!value) throw invalid();
  return value;
}

export async function selectPersonalConfiguration(tx: Tx, target: PersonalConfigurationTarget, scope: string, version: string): Promise<void> {
  if (!(await personalConfigurationVersions(tx, target)).some(value => value.version === version)) throw invalid();
  const index = await tx.doc(PersonalConfigurationDoc), current = index.effective.find(ref => ref.target === target && ref.scope === scope);
  if (current) current.version = version;
  else index.effective.push({ target, scope, version });
}
