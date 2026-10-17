import * as path from "node:path";
import { closeSync, existsSync, openSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, AssistantEntry, configure, createRegistry, defineDoc, defineExtension, Harness, ProviderDoc, ROOT_CONVERSATION_ID, section, type ConversationId, type EntryId, type Cursor, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Provider } from "@earendil-works/pi-ai/models";
import { PersonalError } from "./personal-error.ts";
import { recordedModels, type RequestEvidence } from "./personal-model.ts";
import { lockPersonalProfile, PERSONAL_FORMAT, type PersonalProfileLock } from "./personal-profile.ts";
import { PersonalServiceDoc, personalServiceConfig, personalServices } from "./personal-services.ts";
import type { ServiceManagerConfig } from "./service-helper.ts";
import { personalWorkNotes, verifyPersonalWorkNotes, PersonalAgentsDoc, personalBackgroundWork, PersonalWorkDoc, personalWork, PersonalWorkTask, personalSubAgent, requirePersonalWorkRequest } from "./personal-work.ts";
import { PersonalServiceOperationDoc, PersonalServiceOperationsDoc, PersonalServiceGrantsDoc, personalServiceOperations, verifyServiceOperationRecords, verifyServiceGrants } from "./personal-service-operations.ts";
import { personalTelegram, PersonalTelegramDoc, PersonalTelegramReceiptDoc, verifyPersonalTelegram } from "./personal-telegram.ts";
import { parsePersonalTelegram, telegramToken, type PersonalTelegramConfig } from "./personal-telegram-config.ts";
import { PersonalPermissionsDoc, personalPermissions, permissionSnapshot } from "./personal-permissions.ts";
import { personalTelegramApi } from "./personal-telegram-api.ts";
import { personalWorkTools } from "./personal-work-tools.ts";
import { personalWorkControls, verifyWorkMenu, verifyDelegationMenu } from "./personal-work-controls.ts";
import { PersonalDelegationDoc, personalAnalysisDelegations, verifyPersonalDelegations } from "./personal-delegation.ts";
import { personalDelegationReports, personalReportRequest, verifyPersonalReports } from "./personal-report.ts";

const context = BACKGROUND_CONTEXT;
export const PersonalFormatDoc = defineDoc({ kind: "ruukoto.format", scope: "session", version: 1, initial: () => ({ ...PERSONAL_FORMAT }) });
export const PERSONAL_PROMPT = "你是拥有者的个人助手。根据已有对话回答；可用 background_work 委派独立后台分析，子 Agent 没有外部工具。安排好同一委托的全部分析后调用 report，宿主等待成员停止后请你汇总，并固定回报原入口。未安排 report 的委托可跨轮继续。宿主汇总参考只提供查询资格；读取完整结果、如实汇总失败与下一步，不从参考取得新操作授权。需要外部写操作时说明尚不可用。";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md
export async function openPersonalHarness(options: ({ directory: string; profile?: never } | { profile: PersonalProfileLock; directory?: never }) & {
  provider: Provider;
  modelId: string;
  openStorage?: (filename: string) => Promise<Storage>;
  beforeUnlock?: () => Promise<void>;
  service?: ServiceManagerConfig;
  serviceOperations?: boolean;
  telegram?: PersonalTelegramConfig;
}) {
  const lock = options.profile ?? lockPersonalProfile(options.directory);
  let harness: Harness | undefined;
  let storage: Storage | undefined;
  let unlocked: Promise<void> | undefined;
  try {
    if (!options.provider.getModels().some(model => model.id === options.modelId)) throw new PersonalError("model_unavailable", "所选模型不在个人模型配置中，请重新配置后启动。");
    const service = options.service && personalServiceConfig(options.service);
    const services = service && personalServices(service.config);
    if (options.serviceOperations && !service) throw new PersonalError("service_config_missing", "服务操作需要宿主配置的 helper，请先核实部署配置。");
    const operations = options.serviceOperations && service ? personalServiceOperations(service.config) : undefined;
    const telegramConfig = options.telegram && parsePersonalTelegram(options.telegram);
    const telegram = personalTelegram(telegramConfig, telegramConfig?.enabled ? personalTelegramApi(telegramConfig.apiBase, telegramToken(telegramConfig)) : undefined, operations?.control);
    const registry = createRegistry();
    const workTools = personalWorkTools(() => harness!);
    const personal = defineExtension({ name: "personal", sections: [section("personal", () => PERSONAL_PROMPT + (services ? "服务检查仅观察宿主白名单内的状态，不代表业务健康。" : ""), { tag: false })] });
    registry.install(personal);
    registry.install(personalPermissions);
    registry.install(personalBackgroundWork);
    registry.install(personalSubAgent);
    registry.install(workTools);
    registry.install(personalWorkControls);
    registry.install(personalWorkNotes);
    registry.install(personalAnalysisDelegations);
    registry.install(personalDelegationReports);
    registry.install(telegram.extension);
    if (services) registry.install(services);
    if (operations) registry.install(operations.extension);
    const record = async (evidence: RequestEvidence) => {
      if (!harness) throw new PersonalError("model_source_missing", "模型请求缺少已打开的个人会话，已停止请求。");
      let target: ConversationId | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await harness.commit(tx => tx.scanConversations({}, 256, cursor), context);
        for (const conversation of page.items) {
          if ((await harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId !== evidence.sessionId) continue;
          if (target !== undefined) throw new PersonalError("model_source_ambiguous", "模型请求的会话来源不唯一，已停止请求；请保留档案并检查存储。");
          target = conversation.id;
        }
        cursor = page.next;
      } while (cursor);
      if (target === undefined) throw new PersonalError("model_source_missing", "模型请求的会话来源缺失，已停止请求；请保留档案并检查存储。");
      const conversationId = target;
      const blocked = await harness.commit(async tx => {
        await requirePersonalWorkRequest(tx, conversationId);
        if (conversationId === ROOT_CONVERSATION_ID) { const error = await personalReportRequest(tx); if (error) return error; }
        await tx.appendEntry(conversationId, { kind: "ruukoto.model-request", data: evidence });
      }, context);
      if (blocked) throw blocked;
    };
    const filename = path.join(lock.directory, "personal.sqlite");
    const existing = existsSync(filename);
    closeSync(openSync(filename, "a", 0o600));
    storage = await (options.openStorage ?? openNodeSqliteStorage)(filename);
    const formatRecord = await storage.findDocument({ kind: PersonalFormatDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const saved = formatRecord && await storage.document(formatRecord.id, "current", context);
    if ((existing && !saved) || (saved && (saved.version !== PersonalFormatDoc.definition.version || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)))) {
      throw new PersonalError("extension_version", "个人业务扩展版本不受支持，已停止恢复，请使用与档案对应的程序。");
    }
    const serviceRecord = await storage.findDocument({ kind: PersonalServiceDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedService = serviceRecord && await storage.document(serviceRecord.id, "current", context);
    if (savedService && (!service || savedService.version !== PersonalServiceDoc.definition.version || savedService.value.fingerprint !== service.fingerprint)) {
      throw new PersonalError("service_config_changed", "档案依赖的服务检查配置缺失或已变更，已停止恢复；请恢复原宿主配置后启动。");
    }
    const operationConfigRecord = await storage.findDocument({ kind: PersonalServiceOperationsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const operationConfig = operationConfigRecord && await storage.document(operationConfigRecord.id, "current", context);
    if (operationConfig && (!operations || operationConfig.version !== 1 || operationConfig.value.enabled !== true)) throw new PersonalError("service_operations_config", "档案依赖的服务操作配置缺失或版本不符，已停止恢复；请使用原配置。");
    const telegramRecord = await storage.findDocument({ kind: PersonalTelegramDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedTelegram = telegramRecord && await storage.document(telegramRecord.id, "current", context);
    if (savedTelegram && savedTelegram.version !== 1) throw new PersonalError("telegram_version", "Telegram 业务记录版本不受支持，已停止恢复；请使用对应版本。");
    const permissionsRecord = await storage.findDocument({ kind: PersonalPermissionsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedPermissions = permissionsRecord && await storage.document(permissionsRecord.id, "current", context);
    if (savedPermissions && (savedPermissions.version !== 1 || !["auto-review", "confirm", "full_access"].includes(String(savedPermissions.value.mode)) || !Number.isSafeInteger(savedPermissions.value.version) || Number(savedPermissions.value.version) < 1)) throw new PersonalError("permissions_version", "权限记录缺失或版本不受支持，已停止恢复；请保留档案。");
    const grantsRecord = await storage.findDocument({ kind: PersonalServiceGrantsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedGrants = grantsRecord && await storage.document(grantsRecord.id, "current", context);
    if (savedGrants && !savedPermissions) throw new PersonalError("permissions_version", "长期授权依赖的权限记录缺失，已停止恢复；请保留档案。");
    if (savedGrants && (!operations || savedGrants.version !== 1)) throw new PersonalError("service_grant_invalid", "长期授权配置缺失或版本不受支持，已停止恢复；请保留档案。");
    const telegramKeys: string[] = [];
    let telegramCursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments({ kind: PersonalTelegramReceiptDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, telegramCursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!savedTelegram || !saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("telegram_version", "Telegram 收件缺少配置或版本不受支持，已停止恢复；请保留档案。");
        const value = saved.value.receipt;
        if (value && typeof value === "object" && !Array.isArray(value) && (value.permission || value.control) && !savedPermissions) throw new PersonalError("permissions_version", "Telegram 原输入的权限记录缺失，已停止恢复；请保留档案。");
        telegramKeys.push(record.key);
      }
      telegramCursor = page.next;
    } while (telegramCursor);
    const operationKeys: string[] = [];
    let operationCursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments({ kind: PersonalServiceOperationDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, operationCursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!operations || !operationConfig || !saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("service_operations_config", "服务操作记录缺少配置或版本不受支持，已停止恢复；请保留档案。");
        operationKeys.push(record.key);
      }
      operationCursor = page.next;
    } while (operationCursor);
    let cursor: Cursor | undefined;
    let serviceConversation = false;
    let workConversation = false;
    const childIds: ConversationId[] = [];
    do {
      const page = await storage.scanConversations({}, 256, cursor, context);
      for (const conversation of page.items) {
        const record = await storage.findDocument({ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId: conversation.id } }, "current", context);
        const agent = record && await storage.document(record.id, "current", context);
        const extensions = agent?.value.extensions;
        if (!agent || agent.version !== AgentDoc.definition.version || !Array.isArray(extensions) || extensions.some(name => typeof name !== "string" || !registry.snapshot().extension(name))) {
          throw new PersonalError("extension_missing", "会话依赖的个人扩展缺失，已停止恢复，请使用与档案对应的程序。");
        }
        if (conversation.id === ROOT_CONVERSATION_ID && savedPermissions && !extensions.includes(personalPermissions.name)) throw new PersonalError("permissions_version", "主会话缺少已登记的权限扩展，已停止恢复；请使用对应程序。");
        if (extensions.includes("personal-service-inspect")) serviceConversation = true;
        if (conversation.id === ROOT_CONVERSATION_ID && operationConfig && !extensions.includes("personal-service-operations")) throw new PersonalError("service_operations_config", "主会话缺少已登记的服务操作扩展，已停止恢复；请保留档案。");
        if (extensions.includes("personal-service-operations") && !operationConfig) throw new PersonalError("service_operations_config", "会话依赖的服务操作配置记录缺失，已停止恢复；请保留档案。");
        if (conversation.id === ROOT_CONVERSATION_ID && telegramKeys.length && !extensions.includes(telegram.extension.name)) throw new PersonalError("telegram_version", "主会话缺少 Telegram 执行扩展，已停止恢复；请保留档案。");
        if (extensions.includes(personalBackgroundWork.name) || extensions.includes(personalSubAgent.name)) workConversation = true;
        if (extensions.includes(personalSubAgent.name)) childIds.push(conversation.id);
      }
      cursor = page.next;
    } while (cursor);
    if (serviceConversation && !savedService) throw new PersonalError("service_config_missing", "会话依赖的服务检查配置记录缺失，已停止恢复；请保留档案并检查存储。");
    const indexRecord = await storage.findDocument({ kind: PersonalAgentsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedIndex = indexRecord && await storage.document(indexRecord.id, "current", context);
    const workKeys: string[] = [];
    do {
      const page = await storage.scanDocuments({ kind: PersonalWorkDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, cursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!saved || saved.version !== PersonalWorkDoc.definition.version || record.key === undefined) throw new PersonalError("work_version", "后台工作记录版本不受支持，已停止恢复；请使用对应版本。");
        workKeys.push(record.key);
      }
      cursor = page.next;
    } while (cursor);
    if ((workConversation || workKeys.length) && !savedIndex) throw new PersonalError("work_index_missing", "后台工作的身份索引缺失，已停止恢复；请保留档案并检查存储。");
    if (savedIndex && savedIndex.version !== PersonalAgentsDoc.definition.version) throw new PersonalError("work_version", "子 Agent 索引版本不受支持，已停止恢复；请使用对应版本。");
    const delegationKeys: string[] = [];
    do {
      const page = await storage.scanDocuments({ kind: PersonalDelegationDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, cursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("delegation_record_invalid", "分析委托版本不受支持，已停止恢复；请保留档案。");
        delegationKeys.push(record.key);
      }
      cursor = page.next;
    } while (cursor);
    harness = await Harness.open(storage, { models: recordedModels(options.provider, record), registry, settings: { followUpMode: "one-at-a-time", steeringMode: "one-at-a-time" }, onReport: () => process.stderr.write("[ruukoto:personal] 持久执行出现错误，请查询状态并检查档案；未自动重启。\n") }, context);
    // Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
    unlocked = harness.closed.then(async () => { if (options.beforeUnlock) await options.beforeUnlock(); lock.release(); });
    void unlocked.catch(() => process.stderr.write("[ruukoto:personal] 本机管理接口未能停止，实例锁仍保留；请检查后台并核实停止。\n"));
    const inspection = await harness.inspect(context);
    const savedMain = await harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context);
    const modelWorkEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(workTools.name);
    const workControlsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalWorkControls.name);
    const workNotesEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalWorkNotes.name);
    const delegationsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalAnalysisDelegations.name);
    const reportsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalDelegationReports.name);
    if (savedMain && !modelWorkEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("work_tools_pending", "档案仍有未完成输入或工作，请先用原版本完成处理，再启用模型委派。");
    if (savedMain && !delegationsEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("delegation_config_pending", "档案仍有未完成输入或分析，请先用原版本完成处理，再启用整项委托。");
    if (savedMain && !reportsEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("report_config_pending", "档案仍有未完成输入或分析，请先用原版本完成处理，再启用委托汇报。");
    if (inspection.tasks.some(task => task.state.kind === "blocked" || registry.snapshot().task(task.record.kind)?.definition.version !== task.record.version)) throw new PersonalError("task_version", "档案中有当前程序无法恢复的任务，已停止恢复，请使用对应版本。");
    // 首次启用检查先于新授权记录提交，拒绝后仍能用原配置恢复。
    if (((service && !savedService) || (operations && !operationConfig)) && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("service_config_pending", "个人档案仍有未完成输入，请先用原配置完成处理，再启用服务能力。");
    await harness.commit(tx => verifyPersonalTelegram(tx, telegramKeys, telegramConfig), context);
    await harness.commit(async tx => { for (const key of telegramKeys) await verifyWorkMenu(tx, (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!, workControlsEnabled); }, context);
    await harness.commit(tx => verifyServiceOperationRecords(tx, operationKeys), context);
    if (operations) await harness.commit(tx => verifyServiceGrants(tx, operationKeys), context);
    if (savedIndex) await harness.commit(async tx => {
      const index = await tx.doc(PersonalAgentsDoc);
      if (new Set(index.agents.map(agent => agent.id)).size !== index.agents.length || childIds.length !== index.agents.length || childIds.some(id => !index.agents.some(agent => agent.id === id))) throw new PersonalError("work_index_missing", "长期子会话与身份索引不符，已停止恢复；请保留档案并检查存储。");
      for (const key of workKeys) {
        const work = await tx.doc(PersonalWorkDoc, key, null);
        const task = work.ref && await tx.task(work.ref.taskId);
        if (!work.ref || !work.source || !task || task.kind !== PersonalWorkTask.definition.name || !index.agents.some(agent => agent.id === work.ref?.agentId)) throw new PersonalError("work_record_missing", "后台工作的来源、执行或身份记录缺失，已停止恢复；请检查档案。");
        const input = task.input;
        if (work.ref.requestId !== key || task.version !== PersonalWorkTask.definition.version || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !input || typeof input !== "object" || Array.isArray(input) || input.requestId !== key || input.agentId !== work.ref.agentId || typeof input.content !== "string") throw new PersonalError("work_ownership", "后台工作与原生执行的归属不符，已停止恢复；请检查档案。");
        const source = await tx.submissionByRequest(ROOT_CONVERSATION_ID, work.source.requestId);
        if (source?.id !== work.source.submissionId || source.entry !== work.source.entryId || (await tx.entry(work.source.entryId))?.kind !== "pi.user") throw new PersonalError("work_record_missing", "后台工作的拥有者来源无法核实，已停止恢复；请检查档案。");
        if (work.modelCall !== undefined || key.startsWith("personal-tool:")) {
          const call = work.modelCall && await tx.task(work.modelCall);
          const callInput = call && call.input;
          const assistant = callInput && typeof callInput === "object" && !Array.isArray(callInput) && typeof callInput.assistant === "number" ? await tx.entry(callInput.assistant as EntryId) : undefined;
          if (key !== `personal-tool:${work.modelCall}` || !call || call.kind !== "pi.tool" || call.conversationId !== ROOT_CONVERSATION_ID || !callInput || typeof callInput !== "object" || Array.isArray(callInput) || callInput.kind !== "model" || !assistant || assistant.conversationId !== ROOT_CONVERSATION_ID || assistant.id <= work.source.entryId || !assistant.model?.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === callInput.callId && part.name === "background_work")) || !modelWorkEnabled || !work.permission) throw new PersonalError("work_record_missing", "模型后台工作的工具或权限来源无法核实，已停止恢复；请保留档案。");
        }
        if (work.permission && (!["auto-review", "confirm", "full_access"].includes(work.permission.mode) || !Number.isSafeInteger(work.permission.version) || work.permission.version < 1)) throw new PersonalError("work_record_missing", "后台工作的原权限记录无效，已停止恢复；请保留档案。");
        if (work.telegram) {
          const receipt = (await tx.doc(PersonalTelegramReceiptDoc, work.source.requestId, null)).receipt;
          if (!receipt || receipt.submissionId !== source.id || !isDeepStrictEqual(permissionSnapshot(receipt), work.telegram) || !isDeepStrictEqual(work.permission, { mode: work.telegram.mode, version: work.telegram.version })) throw new PersonalError("work_record_missing", "后台工作的原 Telegram 权限无法核实，已停止恢复；请保留档案。");
        } else if (work.modelCall !== undefined && work.source.requestId.startsWith("telegram:")) throw new PersonalError("work_record_missing", "模型后台工作缺少原 Telegram 绑定，已停止恢复；请保留档案。");
        if (work.submissionId !== undefined && (await tx.submissionByRequest(work.ref.agentId, `personal-work:${task.id}`))?.id !== work.submissionId) throw new PersonalError("work_record_missing", "后台工作引用的原输入缺失，已停止恢复；请保留档案并检查存储。");
        await verifyPersonalWorkNotes(tx, work.ref, workNotesEnabled);
        if (task.state.status !== "terminal" && !index.agents.some(agent => agent.id === work.ref?.agentId && agent.work?.taskId === task.id)) throw new PersonalError("work_ownership", "未结束工作的占用记录缺失，已停止恢复；请检查档案。");
      }
      for (const { record } of inspection.tasks) if (record.kind === PersonalWorkTask.definition.name && !index.agents.some(agent => agent.work?.taskId === record.id)) throw new PersonalError("work_ownership", "后台执行缺少身份占用，已停止恢复；请检查档案。");
      for (const agent of index.agents) {
        if (!await tx.conversation(agent.id)) throw new PersonalError("work_agent_missing", "长期子会话缺失，已停止恢复；请保留档案。");
        const config = await tx.doc(AgentDoc, agent.id);
        if (!Array.isArray(config.tools) || config.tools.length !== 0 || !Array.isArray(config.extensions) || config.extensions.length !== 2 || !config.extensions.includes(personalSubAgent.name) || !config.extensions.includes(personalBackgroundWork.name)) throw new PersonalError("work_config_changed", "子 Agent 的空工具配置无法核实，已停止恢复；请检查档案。");
        if (!agent.work) continue;
        const work = await tx.doc(PersonalWorkDoc, agent.work.requestId, null);
        const task = await tx.task(agent.work.taskId);
        if (!work.ref || work.ref.taskId !== agent.work.taskId || work.ref.agentId !== agent.id || !task || task.state.status === "terminal") throw new PersonalError("work_ownership", "子 Agent 的工作占用无法核实，已停止恢复；请检查原工作和档案。");
      }
    }, context);
    await harness.commit(tx => verifyPersonalDelegations(tx, delegationKeys, workKeys, delegationsEnabled), context);
    await harness.commit(tx => verifyPersonalReports(tx, delegationKeys, reportsEnabled), context);
    await harness.commit(async tx => { for (const key of telegramKeys) await verifyDelegationMenu(tx, (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!, delegationsEnabled); }, context);
    await harness.commit(tx => tx.doc(PersonalFormatDoc), context);
    const extensions = [personal, personalPermissions, personalBackgroundWork, workTools, personalWorkControls, personalWorkNotes, personalAnalysisDelegations, personalDelegationReports, telegram.extension, ...(services ? [services] : []), ...(operations ? [operations.extension] : [])];
    const tools = [...(services?.tools ?? []), ...workTools.tools!];
    if (service) await harness.commit(async tx => { (await tx.doc(PersonalServiceDoc)).fingerprint = service.fingerprint; }, context);
    const main = await harness.root(context, { agent: { model: { provider: options.provider.id, modelId: options.modelId }, thinkingLevel: "off", extensions, tools }, init: async tx => { await tx.doc(PersonalAgentsDoc); await tx.doc(PersonalPermissionsDoc); if (operations) { await tx.doc(PersonalServiceOperationsDoc); await tx.doc(PersonalServiceGrantsDoc); } } });
    const agent = await main.agent(context);
    if (!savedIndex && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("work_config_pending", "个人档案仍有未完成输入，请先用原版本完成处理后再启用后台工作。");
    await harness.commit(async tx => {
      await tx.doc(PersonalAgentsDoc);
      await tx.doc(PersonalPermissionsDoc);
      if (operations) await tx.doc(PersonalServiceOperationsDoc);
      if (extensions.some(expected => !agent.extensions.some(extension => extension.name === expected.name))) await configure(tx, main.id, { extensions, tools });
    }, context);
    if (agent.model?.provider !== options.provider.id || agent.model.modelId !== options.modelId) {
      if (inspection.tasks.length || inspection.submissions.length) throw new PersonalError("model_changed_pending", "个人档案仍有未完成输入，模型已变更；请恢复原模型完成处理后再切换。");
      await main.configure({ model: { provider: options.provider.id, modelId: options.modelId } }, context);
    }
    for (const child of (await harness.snapshot(PersonalAgentsDoc, context))!.agents) {
      const conversation = (await harness.conversation(child.id, context))!;
      const childAgent = await conversation.agent(context);
      if (childAgent.model?.provider !== options.provider.id || childAgent.model.modelId !== options.modelId) {
        if (inspection.tasks.length || inspection.submissions.length) throw new PersonalError("model_changed_pending", "个人档案仍有未完成工作，模型已变更；请恢复原模型后再切换。");
        await conversation.configure({ model: { provider: options.provider.id, modelId: options.modelId } }, context);
      }
    }
    const instance = harness;
    instance.resume();
    return {
      harness: instance,
      main,
      work: personalWork(instance, { provider: options.provider.id, modelId: options.modelId }),
      service: operations?.api(instance),
      telegram: telegram.api(instance),
      async submit(input: string, requestId: string) {
        return main.submit({ type: "input", content: input, requestId, whenBusy: "followUp" }, context);
      },
      async answer(input: string, requestId: string) {
        const submission = await main.submit({ type: "input", content: input, requestId, whenBusy: "followUp" }, context);
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.type !== "input") throw new PersonalError("input_unanswered", "本次输入未获得完整回答，请查看工作状态后决定下一步。");
        const entry = await main.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
        const message = entry?.model?.[0];
        if (message?.role !== "assistant") throw new PersonalError("answer_missing", "已结束输入的回答记录缺失，请保留档案并检查存储。");
        return message.content.filter(part => part.type === "text").map(part => part.text).join("");
      },
      async close() { await instance.close(context); await unlocked; },
    };
  } catch (error) {
    try {
      if (harness) { await harness.close(context); await unlocked; }
      else if (storage) await storage.close(context);
    } catch {
      // 保留启动的原异常；管理接口清理失败时仍保留锁，避免下一实例覆盖旧 socket。
      process.stderr.write("[ruukoto:personal] 初始化清理失败，已停止启动；请保留档案并检查存储。\n");
    } finally { if (!unlocked) lock.release(); }
    throw error;
  }
}

export type PersonalHarness = Awaited<ReturnType<typeof openPersonalHarness>>;
