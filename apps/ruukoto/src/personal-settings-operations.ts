import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { createSession, ROOT_CONVERSATION_ID, type Session, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PersonalError } from "./personal-error.ts";
import { LEGACY_PERSONAL_FORMAT, PERSONAL_FORMAT } from "./personal-profile.ts";
import { mcpServiceDraft, parsePersonalSettingsDraft, parsePersonalSettingsRequest, personalSettingsIdentity, type PersonalSettingsContext } from "./personal-settings.ts";
import { parsePersonalModel } from "./personal-model.ts";
import { parsePersonalMcp, readPersonalMcp, validatePersonalMcpCredentials } from "./personal-mcp-config.ts";
import { personalSkillStore } from "./personal-skills.ts";
import { parsePersonalSkills, personalSkillsDirectory } from "./personal-skills-config.ts";
import { PersonalCommandsDoc, personalCommandLegacyVersion } from "./personal-command-work.ts";
import { parsePersonalCommands, verifyPersonalCommandConfig } from "./personal-command-config.ts";
import { PersonalServiceDoc, personalServiceLegacyVersion } from "./personal-services.ts";
import { parsePersonalServices } from "./personal-service-config.ts";
import { parsePersonalWebSearch } from "./personal-tools-config.ts";
import { parsePersonalTelegram } from "./personal-telegram-config.ts";
import { parsePersonalQq } from "./personal-qq-config.ts";
import {
  advancePersonalSettingsOperation, appendPersonalConfiguration, assertPersonalConfigurationStorage, effectivePersonalConfiguration, initializePersonalSettings, PERSONAL_CONFIGURATION_FILES,
  PersonalConfigurationDoc, PersonalFormatDoc, personalConfigurationContentRevision, personalConfigurationVersions, personalSettingsOperation,
  readPersonalConfigurationFile, readPersonalConfigurationRevision, recordPersonalSettingsOperation, replacePersonalConfigurationFile, selectPersonalConfiguration,
  type PersonalConfigurationTarget, type PersonalConfigurationVersion, type PersonalSettingsReceipt, type PersonalSettingsFileIssue,
} from "./personal-settings-records.ts";

type SettingsWriteOperation = { kind: "config.save"; target: Exclude<PersonalConfigurationTarget, "managed-skills">; value: unknown }
  | { kind: "mcp.save-service"; service: unknown } | { kind: "mcp.set-enabled"; id: string; enabled: boolean } | { kind: "mcp.remove"; id: string } | { kind: "mcp.migrate" }
  | { kind: "skills.import"; id: string; directory: string; contentRevision: string } | { kind: "skills.set-enabled"; id: string; enabled: boolean } | { kind: "skills.remove"; id: string }
  | { kind: "settings.withdraw"; id: string };
export type PersonalSettingsWriteRequest = { v: 2; id: string } | { v: 2; id: string; profile: { directory: string; id: string }; expectedRevision: string; op: SettingsWriteOperation };
const context = BACKGROUND_CONTEXT;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = () => new PersonalError("settings_request_invalid", "配置操作无效，请更新管理客户端并读取原操作。");
const writes = ["config.save", "mcp.save-service", "mcp.set-enabled", "mcp.remove", "mcp.migrate", "skills.import", "skills.set-enabled", "skills.remove", "settings.withdraw"];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function parsePersonalSettingsWriteRequest(value: unknown): PersonalSettingsWriteRequest {
  if (!object(value) || value.v !== 2 || typeof value.id !== "string" || !uuid.test(value.id)) throw invalid();
  if (Object.keys(value).sort().join(",") === "id,v") return value as PersonalSettingsWriteRequest;
  if (Object.keys(value).sort().join(",") !== "expectedRevision,id,op,profile,v" || !object(value.op) || typeof value.op.kind !== "string" || !writes.includes(value.op.kind)) throw invalid();
  const { kind, ...fields } = value.op;
  if (kind === "settings.withdraw") {
    if (Object.keys(fields).join(",") !== "id" || typeof fields.id !== "string" || !uuid.test(fields.id)) throw invalid();
    parsePersonalSettingsRequest({ v: 1, op: "config.preflight", profile: value.profile, expectedRevision: value.expectedRevision, target: "model", value: null });
  } else if (kind === "config.save" && ["web-search", "telegram", "qq", "commands", "services"].includes(String(fields.target))) {
    if (Object.keys(fields).sort().join(",") !== "target,value") throw invalid();
    parsePersonalSettingsRequest({ v: 1, op: "config.preflight", profile: value.profile, expectedRevision: value.expectedRevision, target: "model", value: null });
  } else parsePersonalSettingsRequest({ v: 1, profile: value.profile, expectedRevision: value.expectedRevision, op: kind, ...fields });
  return value as PersonalSettingsWriteRequest;
}

const saving = new Map<string, Promise<void>>();
async function serialize<T>(directory: string, change: () => Promise<T>): Promise<T> {
  const previous = saving.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), next = previous.then(() => held);
  saving.set(directory, next);
  await previous;
  try { return await change(); }
  finally { release(); if (saving.get(directory) === next) saving.delete(directory); }
}

export async function withPersonalSettingsSession<T>(current: PersonalSettingsContext, action: (session: Session) => Promise<T>): Promise<T> {
  if (current.instance) return action(current.instance.harness);
  const filename = path.join(current.profile.directory, "personal.sqlite"), existing = fs.existsSync(filename);
  if (!existing) for (const target of Object.keys(PERSONAL_CONFIGURATION_FILES) as PersonalConfigurationTarget[]) readPersonalConfigurationFile(current.profile, target);
  let storage: Storage;
  try { storage = await openNodeSqliteStorage(filename); } catch (error) { throw new PersonalError("settings_storage_unavailable", "个人配置档案无法打开，未保存配置；请保留档案并检查数据库。", { cause: error }); }
  const session = createSession(storage);
  try {
    await assertPersonalConfigurationStorage(current.profile, storage, existing);
    return await action(session);
  } finally { await session.close(context); }
}

async function candidate(current: PersonalSettingsContext, session: Session, request: Extract<PersonalSettingsWriteRequest, { op: SettingsWriteOperation }>): Promise<{ target: PersonalConfigurationTarget; scope: string; content: string; config: JsonValue; supersedes?: string }> {
  const op = request.op, profile = current.profile;
  if (op.kind === "settings.withdraw") {
    const previous = await session.commit(tx => personalSettingsOperation(tx, op.id), context);
    if (!previous || previous.receipt.status !== "waiting" && previous.receipt.status !== "saved") throw new PersonalError("settings_withdraw_unavailable", "请先核实原操作；仅可撤回已证明保存且尚未生效的更改。");
    const effective = await session.commit(async tx => await effectivePersonalConfiguration(tx, previous.candidate.target, previous.receipt.scope) ?? await effectivePersonalConfiguration(tx, previous.candidate.target, "*"), context);
    if (effective?.version === previous.candidate.version) throw new PersonalError("settings_withdraw_unavailable", "原更改可能已经发布，请先查询原操作完成生效核实。");
    if (!effective) throw new PersonalError("settings_withdraw_unavailable", "原生效配置无法核实，请保留原操作并恢复配置记录。");
    let content = effective.content;
    let config: JsonValue = effective.config;
    if (previous.candidate.target === "mcp") {
      const latest = readPersonalMcp(profile);
      if (!latest) throw invalid();
      const original = effective.config === null ? [] : parsePersonalMcp(effective.config).services;
      const selected = original.map(service => ({ ...service, ...(latest.version !== 1 && service.enabled === undefined ? { enabled: true } : {}) }));
      config = { ...latest, generation: randomUUID(), services: previous.receipt.scope === "*" ? selected : [...latest.services.filter(service => service.id !== previous.receipt.scope), ...selected.filter(service => service.id === previous.receipt.scope)] } as JsonValue;
      content = JSON.stringify(config) + "\n";
    }
    if ((previous.candidate.target === "commands" || previous.candidate.target === "services") && config === null) {
      const baseline = (await session.commit(tx => personalConfigurationVersions(tx, previous.candidate.target), context))[0];
      if (!baseline || baseline.content !== null || baseline.revision !== "missing" || baseline.previousVersion !== null) throw new PersonalError("settings_withdraw_unavailable", "原未配置状态缺少初始化证明，请保留原操作并核实配置历史。");
      content = "null\n";
    }
    if (effective.origin === "host" && config !== null && (previous.candidate.target === "commands" || previous.candidate.target === "services")) content = JSON.stringify(config) + "\n";
    if (content === null || config === null && previous.candidate.target !== "commands" && previous.candidate.target !== "services") throw new PersonalError("settings_withdraw_unavailable", "原设置尚未配置，此能力暂不支持恢复到未配置；请保留原操作，先查询生效状态后再选择配置。");
    return { target: previous.candidate.target, scope: previous.receipt.scope, content, config, supersedes: op.id };
  }
  if (op.kind.startsWith("skills.")) {
    const store = personalSkillStore(profile);
    const prepared = op.kind === "skills.import" ? store.prepareImport({ id: op.id, sourceDir: op.directory, contentRevision: op.contentRevision, expectedRevision: request.expectedRevision }) : op.kind === "skills.set-enabled" ? store.prepareSetEnabled({ ...op, expectedRevision: request.expectedRevision }) : op.kind === "skills.remove" ? store.prepareRemove({ ...op, expectedRevision: request.expectedRevision }) : undefined;
    if (!prepared) throw invalid();
    return { target: "managed-skills", scope: "managed", content: prepared.content, config: JSON.parse(prepared.content) as JsonValue };
  }
  let target: PersonalConfigurationTarget, scope = "*", value: unknown;
  if (op.kind === "config.save") { target = op.target; value = op.value; }
  else {
    target = "mcp";
    if (op.kind === "mcp.save-service") { value = mcpServiceDraft(profile, op.service); if (!object(op.service) || typeof op.service.id !== "string") throw invalid(); scope = op.service.id; }
    else {
      const previous = readPersonalMcp(profile);
      if (!previous) throw new PersonalError("mcp_service_missing", "原 MCP 服务不存在，请刷新配置。");
      if (op.kind === "mcp.migrate") value = { ...previous, version: previous.version === 1 ? 2 : previous.version, generation: randomUUID(), services: previous.services.map(service => ({ ...service, enabled: service.enabled !== false })) };
      else if (op.kind === "mcp.set-enabled" || op.kind === "mcp.remove") {
        if (!previous.services.some(service => service.id === op.id)) throw new PersonalError("mcp_service_missing", "原 MCP 服务不存在，请刷新配置。");
        if (op.kind === "mcp.set-enabled" && previous.version === 1) throw new PersonalError("mcp_migration_required", "请先迁入支持服务启停的格式，再修改服务。");
        scope = op.id; value = { ...previous, generation: randomUUID(), services: op.kind === "mcp.remove" ? previous.services.filter(service => service.id !== op.id) : previous.services.map(service => service.id === op.id ? { ...service, enabled: op.enabled } : service) };
      } else throw invalid();
    }
  }
  let config: JsonValue;
  if (target === "model" || target === "skills" || target === "mcp") {
    config = (target === "mcp" && op.kind !== "config.save" ? parsePersonalMcp(value) : parsePersonalSettingsDraft(profile, target, value)) as JsonValue;
    if (target === "skills") personalSkillsDirectory(parsePersonalSkills(config));
    if (target === "mcp") {
      const parsed = parsePersonalMcp(config), previous = readPersonalMcp(profile);
      if (previous && isDeepStrictEqual({ ...parsed, generation: previous.generation }, previous)) config = previous as JsonValue;
      if (previous?.generation === parsed.generation && !isDeepStrictEqual(previous, parsed)) throw new PersonalError("mcp_generation_reused", "原 MCP 代次不能用于不同配置，请重新保存当前草稿。");
      await validatePersonalMcpCredentials(parsed, previous);
    }
  } else if (target === "commands") {
    const current = await session.snapshot(PersonalCommandsDoc, context), versions = await session.commit(tx => personalConfigurationVersions(tx, "commands"), context);
    if (current?.fingerprint && !current.configVersion && !personalCommandLegacyVersion(versions)) throw new PersonalError("command_config_baseline_missing", "原宿主命令配置尚未记录，未保存更改；请用原可信宿主打开一次以核实原配置，再保存。");
    const parsed = parsePersonalCommands(value); verifyPersonalCommandConfig(parsed, profile.directory); config = parsed;
  }
  else if (target === "services") {
    const current = await session.snapshot(PersonalServiceDoc, context), versions = await session.commit(tx => personalConfigurationVersions(tx, "services"), context);
    if (current?.fingerprint && !current.configVersion && !personalServiceLegacyVersion(versions)) throw new PersonalError("service_config_baseline_missing", "原宿主服务配置尚未记录，未保存更改；请用原可信宿主打开一次以核实原配置，再保存。");
    config = parsePersonalServices(value);
  }
  else if (target === "telegram") config = parsePersonalTelegram(value);
  else if (target === "qq") config = parsePersonalQq(value);
  else {
    if (!object(value)) throw invalid();
    config = parsePersonalWebSearch({ ...value, generation: randomUUID() });
  }
  return { target, scope, config, content: JSON.stringify(config) + "\n" };
}

async function publish(current: PersonalSettingsContext, session: Session, original: NonNullable<Awaited<ReturnType<typeof personalSettingsOperation>>>): Promise<PersonalSettingsReceipt> {
  const known = await session.commit(tx => personalSettingsOperation(tx, original.receipt.id), context);
  if (!known) throw invalid();
  let operation = known;
  if (["active", "superseded", "rejected", "unknown"].includes(operation.receipt.status)) return operation.receipt;
  const instance = current.instance;
  if (!instance) return operation.receipt;
  const { candidate: selected, receipt } = operation;
  const superseding = await session.commit(async tx => {
    const versions = await personalConfigurationVersions(tx, selected.target), selectedIndex = versions.findIndex(value => value.version === selected.version);
    if (selectedIndex < 0) throw invalid();
    const index = await tx.doc(PersonalConfigurationDoc), scopes = index.effective.filter(value => value.target === selected.target);
    const applicable = receipt.scope === "*" ? scopes : [scopes.find(value => value.scope === receipt.scope) ?? scopes.find(value => value.scope === "*")].filter(value => value !== undefined);
    const later = applicable.find(value => versions.findIndex(version => version.version === value.version) > selectedIndex);
    if (!later) return;
    for (const id of index.operations) { const operation = await personalSettingsOperation(tx, id); if (operation?.candidate.version === later.version) return operation.receipt.id; }
    throw invalid();
  }, context);
  if (superseding) {
    operation = advancePersonalSettingsOperation(operation, { status: "superseded", supersededBy: superseding, code: "settings_superseded" });
    await session.commit(tx => recordPersonalSettingsOperation(tx, operation), context);
    await serialize(current.profile.directory, () => refreshSuspension(current, session, selected.target));
    return operation.receipt;
  }
  let outcome: { effectiveRevision: string | null; code: string; relatedOperations: { kind: string; id: string }[] } = { effectiveRevision: selected.revision, code: "settings_active", relatedOperations: [] };
  let closing = false;
  const unsubscribeClose = session.subscribeClose(() => { closing = true; });
  try {
    if (selected.target === "model") await instance.updateModel(parsePersonalModel(selected.config), selected.version);
    else if (selected.target === "mcp") outcome = await instance.updateMcp(parsePersonalMcp(selected.config), receipt.scope, selected.version, selected.revision);
    else if (selected.target === "commands") outcome = await instance.updateCommands(selected.config === null ? null : parsePersonalCommands(selected.config), selected.version, selected.revision);
    else if (selected.target === "services") outcome = await instance.updateServices(selected.config === null ? null : parsePersonalServices(selected.config), selected.version, selected.revision);
    else if (selected.target === "web-search") outcome = await instance.updateWebSearch(parsePersonalWebSearch(selected.config), selected.version, selected.revision);
    else if (selected.target === "telegram" || selected.target === "qq") outcome = await instance.updateIm(selected.target, selected.config, selected.version, selected.revision);
  } catch (error) {
    if (closing || !(error instanceof PersonalError)) throw error;
    operation = advancePersonalSettingsOperation(operation, { status: "failed", code: error.code });
    await session.commit(tx => recordPersonalSettingsOperation(tx, operation), context);
    await serialize(current.profile.directory, () => refreshSuspension(current, session, selected.target));
    return operation.receipt;
  } finally { unsubscribeClose(); }
  await current.checkpoint?.("published");
  operation = advancePersonalSettingsOperation(operation, { status: outcome.effectiveRevision === selected.revision ? "active" : "waiting", effectiveRevision: outcome.effectiveRevision === "missing" ? null : outcome.effectiveRevision ?? receipt.effectiveRevision, code: outcome.code, relatedOperations: outcome.relatedOperations.slice(0, 32) });
  await session.commit(async tx => {
    if (operation.receipt.status === "active") await selectPersonalConfiguration(tx, selected.target, receipt.scope, selected.version);
    await recordPersonalSettingsOperation(tx, operation);
  }, context);
  await serialize(current.profile.directory, () => refreshSuspension(current, session, selected.target));
  return operation.receipt;
}

function publicationKey(current: PersonalSettingsContext, operation: NonNullable<Awaited<ReturnType<typeof personalSettingsOperation>>>) {
  return `publish:${current.profile.directory}:${operation.candidate.target}:${operation.receipt.scope}`;
}

async function publishScoped(current: PersonalSettingsContext, session: Session, operation: NonNullable<Awaited<ReturnType<typeof personalSettingsOperation>>>) {
  return serialize(publicationKey(current, operation), () => publish(current, session, operation));
}

async function verifySaved(current: PersonalSettingsContext, session: Session, operation: NonNullable<Awaited<ReturnType<typeof personalSettingsOperation>>>): Promise<NonNullable<Awaited<ReturnType<typeof personalSettingsOperation>>>> {
  if (["active", "superseded", "rejected"].includes(operation.receipt.status)) { await refreshSuspension(current, session, operation.candidate.target); return operation; }
  let currentRevision: string | null = null;
  try { currentRevision = readPersonalConfigurationRevision(current.profile, operation.candidate.target); }
  catch { /* 文件无法安全读取时保留原操作未知，恢复其他目标。 */ }
  const versions = await session.commit(tx => personalConfigurationVersions(tx, operation.candidate.target), context);
  const saved = versions.findIndex(value => value.version === operation.candidate.version);
  if (saved >= 0 && versions.at(-1)?.revision === currentRevision) {
    if (operation.receipt.status === "unknown" || operation.receipt.savedRevision === null) {
      operation = advancePersonalSettingsOperation(operation, { status: "saved", savedRevision: operation.candidate.revision, code: current.instance ? "settings_saved" : "settings_saved_offline" });
      await session.commit(tx => recordPersonalSettingsOperation(tx, operation), context);
    }
    return operation;
  }
  if (currentRevision === operation.candidate.revision && (saved < 0 || saved === versions.length - 1)) {
    operation = advancePersonalSettingsOperation(operation, { status: "saved", savedRevision: operation.candidate.revision, code: current.instance ? "settings_saved" : "settings_saved_offline" });
    await session.commit(async tx => { await appendPersonalConfiguration(tx, operation.candidate); await recordPersonalSettingsOperation(tx, operation); }, context);
    return operation;
  }
  operation = advancePersonalSettingsOperation(operation, { status: currentRevision === operation.expectedRevision && saved < 0 ? "rejected" : "unknown", code: currentRevision === operation.expectedRevision && saved < 0 ? "settings_not_saved" : "settings_file_unverified" });
  await session.commit(tx => recordPersonalSettingsOperation(tx, operation), context);
  await refreshSuspension(current, session, operation.candidate.target);
  return operation;
}

export async function dispatchPersonalConfiguration(current: PersonalSettingsContext, value: unknown): Promise<PersonalSettingsReceipt | null> {
  const request = parsePersonalSettingsWriteRequest(value);
  if (!("op" in request) && !current.instance && !fs.existsSync(path.join(current.profile.directory, "personal.sqlite"))) return null;
  return withPersonalSettingsSession(current, async session => {
    if (!("op" in request)) {
      if (!await session.snapshot(PersonalConfigurationDoc, context)) return null;
      const operation = await serialize(current.profile.directory, async () => {
        const original = await session.commit(tx => personalSettingsOperation(tx, request.id), context);
        return original ? verifySaved(current, session, original) : undefined;
      });
      return operation ? publishScoped(current, session, operation) : null;
    }
    if (!isDeepStrictEqual(request.profile, personalSettingsIdentity(current.profile))) throw new PersonalError("settings_profile_changed", "所选档案身份已变化，未保存；请重新选择原档案。");
    const requestDigest = createHash("sha256").update(canonical(request)).digest("hex");
    const save = async (publicationLocked: boolean) => {
    const admitted = await serialize(current.profile.directory, async () => {
      await initializePersonalSettings(current.profile, session);
      const previous = await session.commit(tx => personalSettingsOperation(tx, request.id), context);
      if (previous) {
        if (previous.receipt.requestDigest !== requestDigest) throw new PersonalError("settings_request_conflict", "原操作参数不同，请查询原保存结果；未重复保存。");
        return verifySaved(current, session, previous);
      }
      const op = request.op;
      const target = op.kind === "settings.withdraw" ? (await session.commit(tx => personalSettingsOperation(tx, op.id), context))?.candidate.target : op.kind.startsWith("skills.") ? "managed-skills" : op.kind.startsWith("mcp.") ? "mcp" : op.kind === "config.save" ? op.target : undefined;
      if (target) {
        await refreshSuspension(current, session, target);
        if ((await configurationFileIssues(current, session, [target])).length) throw new PersonalError("settings_file_unverified", "配置文件与保存历史不符，已暂停此目标的新操作；请保留档案并恢复原文件后查询。");
      }
      const draft = await candidate(current, session, request), file = readPersonalConfigurationFile(current.profile, draft.target);
      if (file.revision !== request.expectedRevision) throw new PersonalError("settings_revision_changed", "配置已变化，未覆盖；请刷新并比较草稿。");
      const outstanding = await session.commit(async tx => {
        const ids = [...(await tx.doc(PersonalConfigurationDoc)).operations], operations = [];
        for (const id of ids) { const operation = await personalSettingsOperation(tx, id); if (operation) operations.push(operation); }
        return operations;
      }, context);
      for (const operation of outstanding) {
        if (operation.candidate.target !== draft.target || ["active", "rejected", "superseded"].includes(operation.receipt.status) || operation.receipt.id === draft.supersedes) continue;
        if (operation.receipt.status === "unknown" || current.instance && (operation.receipt.scope === "*" || draft.scope === "*" || operation.receipt.scope === draft.scope)) throw new PersonalError("settings_target_pending", "该配置仍有原操作待核实或等待生效，请查询原操作或撤回已保存更改。");
      }
      const versions = await session.commit(tx => personalConfigurationVersions(tx, draft.target), context), latest = versions.at(-1);
      if (latest?.revision !== file.revision) throw new PersonalError("settings_file_unverified", "配置文件与保存历史不符，请保留档案并核实原操作。");
      const selected: PersonalConfigurationVersion = latest?.content === draft.content ? latest : { target: draft.target, version: request.id, revision: personalConfigurationContentRevision(draft.target, draft.content), previousRevision: latest?.revision ?? null, previousVersion: latest?.version ?? null, config: draft.config, content: draft.content, ...(draft.target === "services" && latest?.hostService ? { hostService: structuredClone(latest.hostService) } : {}) };
      const effective = await session.commit(async tx => await effectivePersonalConfiguration(tx, draft.target, draft.scope) ?? await effectivePersonalConfiguration(tx, draft.target, "*"), context);
      const receipt: PersonalSettingsReceipt = { v: 2, id: request.id, profile: request.profile, target: draft.target === "managed-skills" ? "skills" : draft.target, scope: draft.scope, requestDigest, status: "unknown", savedRevision: null, effectiveRevision: effective?.revision === "missing" ? null : effective?.revision ?? null, code: "settings_save_in_progress", relatedOperations: [] };
      let operation = advancePersonalSettingsOperation({ receipt, candidate: selected, expectedRevision: request.expectedRevision, facts: [] }, {});
      await session.commit(tx => recordPersonalSettingsOperation(tx, operation), context);
      current.instance?.suspendSettings(draft.target, "*");
      await current.checkpoint?.("intent");
      if (selected.version === request.id) replacePersonalConfigurationFile(current.profile, PERSONAL_CONFIGURATION_FILES[draft.target], draft.content);
      await current.checkpoint?.("file");
      operation = advancePersonalSettingsOperation(operation, { status: "saved", savedRevision: selected.revision, code: current.instance ? "settings_saved" : "settings_saved_offline" });
      await session.commit(async tx => {
        await appendPersonalConfiguration(tx, selected);
        await recordPersonalSettingsOperation(tx, operation);
        if (!current.instance) for (const previous of outstanding) {
          if (previous.candidate.target === draft.target && (previous.receipt.scope === draft.scope || draft.scope === "*") && ["saved", "waiting", "failed"].includes(previous.receipt.status)) await recordPersonalSettingsOperation(tx, advancePersonalSettingsOperation(previous, { status: "superseded", supersededBy: request.id, code: "settings_superseded" }));
        }
        if (draft.supersedes) {
          const original = await personalSettingsOperation(tx, draft.supersedes);
          if (!original) throw invalid();
          await recordPersonalSettingsOperation(tx, advancePersonalSettingsOperation(original, { status: "superseded", supersededBy: request.id, code: "settings_superseded" }));
        }
        if (await tx.conversation(ROOT_CONVERSATION_ID)) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.settings-saved", data: { id: request.id, target: receipt.target, scope: receipt.scope, revision: selected.revision } });
      }, context);
      await refreshSuspension(current, session, draft.target);
      await current.checkpoint?.("saved");
      return operation;
    });
    return publicationLocked ? publish(current, session, admitted) : publishScoped(current, session, admitted);
    };
    if (request.op.kind !== "settings.withdraw") return save(false);
    const withdrawnId = request.op.id;
    const previous = await session.commit(tx => personalSettingsOperation(tx, withdrawnId), context);
    if (!previous) throw new PersonalError("settings_withdraw_unavailable", "原设置操作不存在，请先查询原操作。");
    return serialize(publicationKey(current, previous), () => save(true));
  });
}

async function configurationFileIssues(current: PersonalSettingsContext, session: Session, targets: PersonalConfigurationTarget[]): Promise<PersonalSettingsFileIssue[]> {
  const latest = await session.commit(async tx => {
    const values = [];
    for (const target of targets) { const value = (await personalConfigurationVersions(tx, target)).at(-1); if (value) values.push(value); }
    return values;
  }, context);
  const issues: PersonalSettingsFileIssue[] = [];
  for (const value of latest) {
    let actualRevision: string | null = null;
    try { actualRevision = readPersonalConfigurationRevision(current.profile, value.target); }
    catch { /* 文件身份、读取或托管清单解析失败统一封闭该文件，不影响共享存储。 */ }
    if (actualRevision !== value.revision) issues.push({ target: value.target, code: "settings_file_unverified", expectedRevision: value.revision, actualRevision });
  }
  return issues;
}

export async function personalSettingsFileIssues(current: PersonalSettingsContext): Promise<PersonalSettingsFileIssue[]> {
  if (!current.instance && !fs.existsSync(path.join(current.profile.directory, "personal.sqlite"))) return [];
  return withPersonalSettingsSession(current, session => serialize(current.profile.directory, async () => {
    if (!await session.snapshot(PersonalConfigurationDoc, context)) return [];
    const targets = Object.keys(PERSONAL_CONFIGURATION_FILES) as PersonalConfigurationTarget[];
    const issues = await configurationFileIssues(current, session, targets);
    for (const target of targets) await refreshSuspension(current, session, target, issues);
    return issues;
  }));
}

async function refreshSuspension(current: PersonalSettingsContext, session: Session, target: PersonalConfigurationTarget, knownIssues?: PersonalSettingsFileIssue[]): Promise<void> {
  if (!current.instance) return;
  const issues = knownIssues ?? await configurationFileIssues(current, session, [target]);
  const operations = await session.commit(async tx => {
    const index = await tx.doc(PersonalConfigurationDoc), operations = [];
    for (const id of index.operations) { const operation = await personalSettingsOperation(tx, id); if (operation?.candidate.target === target) operations.push(operation); }
    return operations;
  }, context);
  for (const scope of new Set(["*", ...operations.map(value => value.receipt.scope)])) current.instance.resumeSettings(target, scope);
  for (const operation of operations) if (!["active", "superseded", "rejected"].includes(operation.receipt.status)) current.instance.suspendSettings(target, operation.receipt.status === "unknown" ? "*" : operation.receipt.scope);
  if (issues.some(issue => issue.target === target)) current.instance.suspendSettings(target, "*");
}

export async function recoverPersonalSettings(current: PersonalSettingsContext): Promise<PersonalSettingsReceipt[]> {
  if (!current.instance) throw new PersonalError("settings_offline", "配置生效恢复需要原后台，离线仅可查询保存事实。");
  const session = current.instance.harness;
  await personalSettingsFileIssues(current);
  const pending = await session.commit(async tx => {
    const index = await tx.doc(PersonalConfigurationDoc), operations = [];
    for (const id of index.operations) { const operation = await personalSettingsOperation(tx, id); if (operation && !["active", "superseded", "rejected"].includes(operation.receipt.status)) operations.push(operation); }
    return operations;
  }, context);
  for (const operation of pending) current.instance.suspendSettings(operation.candidate.target, operation.receipt.status === "unknown" ? "*" : operation.receipt.scope);
  const receipts: PersonalSettingsReceipt[] = [];
  for (const original of pending) {
    const verified = await serialize(current.profile.directory, async () => {
      const operation = await session.commit(tx => personalSettingsOperation(tx, original.receipt.id), context);
      if (!operation) throw invalid();
      return verifySaved(current, session, operation);
    });
    receipts.push(await publishScoped(current, session, verified));
  }
  await personalSettingsFileIssues(current);
  return receipts;
}

export async function waitPersonalSettings(current: Pick<PersonalSettingsContext, "profile">): Promise<void> {
  const directory = current.profile.directory;
  while (true) {
    const pending = [...saving].filter(([key]) => key === directory || key.startsWith(`publish:${directory}:`)).map(([, promise]) => promise);
    if (!pending.length) return;
    await Promise.all(pending);
  }
}
