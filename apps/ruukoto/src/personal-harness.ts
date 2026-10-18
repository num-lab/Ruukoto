import { personalMedia, PERSONAL_MEDIA, PersonalMediaDoc, PersonalMediaMessageDoc, PersonalImageDoc } from "./personal-media.ts";
import { personalBrowser, PERSONAL_BROWSER, PersonalBrowserDoc, PersonalBrowserOperationDoc, configureBrowser, verifyBrowser, browserRequestAllowed } from "./personal-browser.ts";
import type { PersonalBrowserConfig } from "./personal-browser-config.ts";
import { personalBrowserControl, verifyBrowserControls } from "./personal-browser-controls.ts";
import { PERSONAL_TOOLS, PERSONAL_TOOL_NAMES, PersonalToolsDoc, PersonalToolDoc, personalTools, personalArtifactReader, configureTools, verifyTools } from "./personal-tools.ts";
import { personalLocalInput, personalLocalPermission } from "./personal-local-records.ts";
import type { PersonalToolsConfig } from "./personal-tools-config.ts";
import { personalToolControl, verifyToolControls } from "./personal-tools-controls.ts";
import * as path from "node:path";
import { closeSync, existsSync, openSync, mkdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, AssistantEntry, configure, createRegistry, LiveDoc, defineDoc, defineExtension, Harness, ProviderDoc, ROOT_CONVERSATION_ID, section, type ConversationId, type EntryId, type Cursor, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Provider } from "@earendil-works/pi-ai/models";
import { PersonalError } from "./personal-error.ts";
import { recordedModels, type RequestEvidence } from "./personal-model.ts";
import { lockPersonalProfile, PERSONAL_FORMAT, type PersonalProfileLock } from "./personal-profile.ts";
import { PersonalServiceDoc, personalServiceConfig, personalServices, personalSubAgentServices } from "./personal-services.ts";
import type { ServiceManagerConfig } from "./service-helper.ts";
import { personalWorkNotes, verifyPersonalWorkNotes, PersonalAgentsDoc, personalBackgroundWork, PersonalWorkDoc, personalWork, PersonalWorkTask, personalSubAgent, requirePersonalWorkRequest } from "./personal-work.ts";
import { PersonalServiceOperationDoc, PersonalServiceOperationsDoc, PersonalServiceGrantsDoc, personalServiceOperations, verifyServiceOperationRecords, verifyServiceGrants, type PersonalServiceOperationRef, PERSONAL_SERVICE_WORK } from "./personal-service-operations.ts";
import { personalServiceWork } from "./personal-service-work.ts";
import { personalTelegram, PersonalTelegramDoc, PersonalTelegramReceiptDoc, verifyPersonalTelegram } from "./personal-telegram.ts";
import { parsePersonalTelegram, telegramToken, type PersonalTelegramConfig } from "./personal-telegram-config.ts";
import { PersonalPermissionsDoc, personalPermissions, permissionSnapshot } from "./personal-permissions.ts";
import { personalTelegramApi } from "./personal-telegram-api.ts";
import { personalWorkTools } from "./personal-work-tools.ts";
import { personalWorkControls, verifyWorkMenu, verifyDelegationMenu } from "./personal-work-controls.ts";
import { PersonalDelegationDoc, personalAnalysisDelegations, verifyPersonalDelegations } from "./personal-delegation.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc, personalInspectionControl, personalInspectionExtension, recheckServiceInspection, verifyServiceInspections } from "./personal-service-inspection.ts";
import { personalDelegationReports, personalReportRequest, verifyPersonalReports } from "./personal-report.ts";
import { personalInspectionControls, telegramInspectionControl, verifyInspectionControls, type PersonalInspectionRef } from "./personal-inspection-controls.ts";

import { personalServiceControls, verifyServiceControls } from "./personal-service-controls.ts";
import { PERSONAL_COMMAND_WORK, PersonalCommandDoc, PersonalCommandsDoc, personalCommandWork, personalCommandsFingerprint, verifyPersonalCommands, personalCommandsIn } from "./personal-command-work.ts";
import type { PersonalCommandConfig } from "./personal-command-config.ts";

import { PERSONAL_MCP, PERSONAL_MCP_TOOLS, PersonalMcpConfigDoc, PersonalMcpDoc, configureMcp, mcpOperations, mcpUnresolved, mcpList, mcpDetail, mcpDecide, mcpResolve, personalMcp, verifyMcp } from "./personal-mcp.ts";
import { parsePersonalMcp, type PersonalMcpConfig } from "./personal-mcp-config.ts";
import type { McpTimeouts } from "@ruukoto/agent/mcp/transport.ts";
import { personalMcpControl, verifyMcpControls } from "./personal-mcp-controls.ts";

const context = BACKGROUND_CONTEXT;
export const PersonalFormatDoc = defineDoc({ kind: "ruukoto.format", scope: "session", version: 1, initial: () => ({ ...PERSONAL_FORMAT }) });
export const PERSONAL_PROMPT = "你是拥有者的个人助手。根据已有对话回答；可用 background_work 委派独立后台分析，子 Agent 只能使用宿主提供的工具。安排好同一委托的全部分析后调用 report，宿主等待成员停止后请你汇总，并固定回报原入口。未安排 report 的委托可跨轮继续。宿主汇总参考只提供查询资格；读取完整结果、如实汇总失败与下一步，不从参考取得新操作授权。外部操作仅使用宿主提供的工具；不可用的能力如实说明。";

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md
export async function openPersonalHarness(options: ({ directory: string; profile?: never } | { profile: PersonalProfileLock; directory?: never }) & {
  provider: Provider;
  modelId: string;
  openStorage?: (filename: string) => Promise<Storage>;
  beforeUnlock?: () => Promise<void>;
  service?: ServiceManagerConfig;
  serviceOperations?: boolean;
  telegram?: PersonalTelegramConfig;
  commands?: PersonalCommandConfig;
  mcp?: PersonalMcpConfig;
  tools?: PersonalToolsConfig;
  browser?: PersonalBrowserConfig;
  mcpTimeouts?: McpTimeouts;
}) {
  const lock = options.profile ?? lockPersonalProfile(options.directory);
  let harness: Harness | undefined;
  let storage: Storage | undefined;
  let unlocked: Promise<void> | undefined;
  let browser: ReturnType<typeof personalBrowser> | undefined;
  try {
    if (!options.provider.getModels().some(model => model.id === options.modelId)) throw new PersonalError("model_unavailable", "所选模型不在个人模型配置中，请重新配置后启动。");
    const service = options.service && personalServiceConfig(options.service);
    const services = service && personalServices(service.config, () => harness!);
    if (options.serviceOperations && !service) throw new PersonalError("service_config_missing", "服务操作需要宿主配置的 helper，请先核实部署配置。");
    const operations = options.serviceOperations && service ? personalServiceOperations(service.config, () => harness!) : undefined;
    const serviceWork = operations && personalServiceWork(operations.request);
    const commands = options.commands && personalCommandWork(lock.directory, options.commands);
    const mcp = options.mcp && personalMcp(options.mcp, () => harness!, options.mcpTimeouts);
    const media = personalMedia(lock.directory, () => harness!, () => options.provider.getModels().find(model => model.id === options.modelId)?.input.includes("image") === true, !options.tools && !options.browser ? personalArtifactReader(lock.directory) : undefined);
    const general = options.tools && personalTools(lock.directory, options.tools, options.provider, options.modelId, () => harness!, media);
    browser = options.browser && personalBrowser(lock.directory, options.browser, () => harness!, { supportsImages: media.supportsImages, registerImage: media.registerImage, ...(!general ? { artifactReader: personalArtifactReader(lock.directory) } : {}) });
    const telegramConfig = options.telegram && parsePersonalTelegram(options.telegram);
    const inspectionControls = personalInspectionControls(service?.config, () => harness!);
    const serviceControls = personalServiceControls(() => harness!, () => operations?.api(harness!));
    const telegram = personalTelegram(telegramConfig, telegramConfig?.enabled ? personalTelegramApi(telegramConfig.apiBase, telegramToken(telegramConfig)) : undefined, async (tx, value) => await personalBrowserControl(tx, value, browser?.requestStop) || await personalToolControl(tx, value, general ? lock.directory : undefined) || await personalMcpControl(tx, value, mcp?.requestRecheck) || await serviceControls.control(tx, value) || await telegramInspectionControl(tx, value, inspectionControls.request) || !!await operations?.control(tx, value), media);
    const registry = createRegistry();
    const workTools = personalWorkTools(() => harness!);
    const personal = defineExtension({ name: "personal", sections: [section("personal", () => PERSONAL_PROMPT + (services ? "主会话与子 Agent 均可检查宿主白名单内的服务状态，不代表业务健康。" + (serviceWork ? "子 Agent 可用 service_restart 完成原工作要求的受控服务重启；审批与未知效果由宿主处理。" : "") : "") + (commands ? "子 Agent 可用 run_command 以已配置目录执行命令，沿原工作权限；完全访问使用后台账户环境且免逐次审批，未知效果仍须在本机命令管理核实。" : ""), { tag: false })] });
    registry.install(personal);
    registry.install(media.extension);
    if (browser) registry.install(browser.extension);
    registry.install(personalPermissions);
    registry.install(personalBackgroundWork);
    registry.install(personalSubAgent);
    registry.install(workTools);
    registry.install(personalWorkControls);
    registry.install(personalWorkNotes);
    registry.install(personalAnalysisDelegations);
    registry.install(personalDelegationReports);
    registry.install(telegram.extension);
    registry.install(inspectionControls.extension);
    registry.install(serviceControls.extension);
    if (services) { registry.install(services); registry.install(personalInspectionExtension); registry.install(personalSubAgentServices); }
    if (operations) registry.install(operations.extension);
    if (serviceWork) registry.install(serviceWork);
    if (commands) registry.install(commands.extension);
    if (mcp) registry.install(mcp.extension);
    if (general) registry.install(general.extension);
    const requestConversation = async (sessionId: string) => {
      if (!harness) throw new PersonalError("model_source_missing", "模型请求缺少已打开的个人会话，已停止请求。");
      let target: ConversationId | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await harness.commit(tx => tx.scanConversations({}, 256, cursor), context);
        for (const conversation of page.items) {
          if ((await harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId !== sessionId) continue;
          if (target !== undefined) throw new PersonalError("model_source_ambiguous", "模型请求的会话来源不唯一，已停止请求；请保留档案并检查存储。");
          target = conversation.id;
        }
        cursor = page.next;
      } while (cursor);
      if (target === undefined) throw new PersonalError("model_source_missing", "模型请求的会话来源缺失，已停止请求；请保留档案并检查存储。");
      return target;
    };
    const record = async (evidence: RequestEvidence) => {
      const target = await requestConversation(evidence.sessionId);
      const conversationId = target;
      const blocked = await harness!.commit(async tx => {
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
    const commandsRecord = await storage.findDocument({ kind: PersonalCommandsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedCommands = commandsRecord && await storage.document(commandsRecord.id, "current", context);
    if (savedCommands && (!commands || savedCommands.version !== 1 || savedCommands.value.fingerprint !== personalCommandsFingerprint(commands.config))) throw new PersonalError("command_config_changed", "档案的原命令配置缺失或不符，已停止恢复；请恢复原配置。");
    const commandKeys: string[] = [];
    let commandCursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments({ kind: PersonalCommandDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, commandCursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!savedCommands || !saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("command_record_invalid", "命令缺少原配置或版本不符，已停止恢复。");
        // 未接纳的空 family document 不持有执行权。
        if (saved.value.command) commandKeys.push(record.key);
      }
      commandCursor = page.next;
    } while (commandCursor);
    const mcpRecord = await storage.findDocument({ kind: PersonalMcpConfigDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const loadedMcp = mcpRecord && await storage.document(mcpRecord.id, "current", context);
    if (loadedMcp && (loadedMcp.version !== 1 || !Array.isArray(loadedMcp.value.operations) || !Array.isArray(loadedMcp.value.generations) || (!loadedMcp.value.config && (loadedMcp.value.operations.length || loadedMcp.value.generations.length)))) throw new PersonalError("mcp_record_invalid", "MCP 配置索引版本或原记录不符，已停止恢复。");
    const savedMcp = loadedMcp?.value.config ? loadedMcp : undefined;
    if (savedMcp && (!mcp || savedMcp.version !== 1 || !Array.isArray(savedMcp.value.generations))) throw new PersonalError("mcp_config_changed", "档案的 MCP 原配置缺失或版本不符，已停止恢复；请保留档案并恢复原配置。");
    if (savedMcp) parsePersonalMcp(savedMcp.value.config);
    const mcpKeys: string[] = [];
    let mcpCursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments({ kind: PersonalMcpDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, mcpCursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!savedMcp || !saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("mcp_record_invalid", "MCP 调用缺少原配置或版本不符，已停止恢复。");
        if (saved.value.operation) mcpKeys.push(record.key);
      }
      mcpCursor = page.next;
    } while (mcpCursor);
    const toolsRecord = await storage.findDocument({ kind: PersonalToolsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const loadedTools = toolsRecord && await storage.document(toolsRecord.id, "current", context);
    if (loadedTools && (loadedTools.version !== 1 || !Array.isArray(loadedTools.value.operations) || !Array.isArray(loadedTools.value.grants))) throw new PersonalError("tool_record_invalid", "工具索引版本或记录不符，已停止恢复。");
    const savedTools = loadedTools?.value.config ? loadedTools : undefined;
    if (savedTools && !general) throw new PersonalError("tools_config_missing", "档案的原通用工具配置缺失，已停止恢复；请恢复原配置。");
    const toolKeys: string[] = [];
    let toolCursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments({ kind: PersonalToolDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, toolCursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!savedTools || !saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("tool_record_invalid", "原工具调用缺少配置或版本不符，已停止恢复。");
        if (saved.value.operation) toolKeys.push(record.key);
      }
      toolCursor = page.next;
    } while (toolCursor);
    const browserRecord = await storage.findDocument({ kind: PersonalBrowserDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const loadedBrowser = browserRecord && await storage.document(browserRecord.id, "current", context);
    if (loadedBrowser && (loadedBrowser.version !== 1 || !Array.isArray(loadedBrowser.value.operations))) throw new PersonalError("browser_record_invalid", "浏览器索引版本或记录不符，已停止恢复。");
    if (loadedBrowser && !loadedBrowser.value.config && (loadedBrowser.value.stateJson !== undefined || loadedBrowser.value.bindingEntry !== undefined || loadedBrowser.value.pause !== undefined || (Array.isArray(loadedBrowser.value.operations) && loadedBrowser.value.operations.length))) throw new PersonalError("browser_config_missing", "浏览器原绑定缺少配置，已停止恢复；请保留档案。");
    const savedBrowser = loadedBrowser?.value.config ? loadedBrowser : undefined;
    if (savedBrowser && !browser) throw new PersonalError("browser_config_missing", "档案的原浏览器配置缺失，已停止恢复；请恢复原配置。");
    const browserKeys: string[] = [];
    let browserCursor: Cursor | undefined;
    do {
      const page = await storage.scanDocuments({ kind: PersonalBrowserOperationDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, browserCursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("browser_record_invalid", "浏览器原操作缺失或版本不符，已停止恢复。");
        if (saved.value.operation) { if (!savedBrowser) throw new PersonalError("browser_config_missing", "浏览器操作缺少原配置，已停止恢复。"); browserKeys.push(record.key); }
      }
      browserCursor = page.next;
    } while (browserCursor);
    const mediaRecord = await storage.findDocument({ kind: PersonalMediaDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedMedia = mediaRecord && await storage.document(mediaRecord.id, "current", context);
    if (savedMedia && (savedMedia.version !== 1 || !Array.isArray(savedMedia.value.keys) || !Array.isArray(savedMedia.value.images))) throw new PersonalError("media_record_invalid", "媒体索引版本或记录不符，已停止恢复。");
    for (const [kind, field, index] of [[PersonalMediaMessageDoc.definition.kind, "message", "keys"], [PersonalImageDoc.definition.kind, "image", "images"]] as const) {
      const keys: string[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanDocuments({ kind, scope: { kind: "session" }, at: "current" }, 256, cursor, context);
        for (const record of page.items) {
          const saved = await storage.document(record.id, "current", context);
          if (!saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("media_record_invalid", "原媒体记录版本不符，已停止恢复。");
          if (saved.value[field]) keys.push(record.key);
        }
        cursor = page.next;
      } while (cursor);
      const savedKeys = savedMedia?.value[index];
      if (keys.length && !savedMedia || savedMedia && (!Array.isArray(savedKeys) || savedKeys.length !== keys.length || new Set(savedKeys).size !== keys.length || keys.some(key => !savedKeys.includes(key)))) throw new PersonalError("media_record_invalid", "媒体记录与原索引不符，已停止恢复。");
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
    const inspectionKeys: string[] = [];
    let inspectionCursor: Cursor | undefined;
    const pendingRecord = await storage.findDocument({ kind: PersonalPendingInspectionsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
    const savedPending = pendingRecord && await storage.document(pendingRecord.id, "current", context);
    if (savedPending && (savedPending.version !== 1 || !Array.isArray(savedPending.value.tasks) || (savedPending.value.tasks.length > 0 && (!service || !savedService)))) throw new PersonalError("service_inspection_invalid", "服务检查占用缺少配置或版本不符，已停止恢复；请保留档案。");
    do {
      const page = await storage.scanDocuments({ kind: PersonalInspectionDoc.definition.kind, scope: { kind: "session" }, at: "current" }, 256, inspectionCursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        if (!service || !savedService || !savedPending || !saved || saved.version !== 1 || record.key === undefined) throw new PersonalError("service_inspection_invalid", "服务检查记录缺少配置、占用或版本不符，已停止恢复；请保留档案。");
        inspectionKeys.push(record.key);
      }
      inspectionCursor = page.next;
    } while (inspectionCursor);
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
        if (conversation.id === ROOT_CONVERSATION_ID && savedBrowser && !extensions.includes(PERSONAL_BROWSER)) throw new PersonalError("browser_config_missing", "主会话缺少原浏览器扩展，已停止恢复。");
        if (extensions.includes(PERSONAL_BROWSER) && (conversation.id !== ROOT_CONVERSATION_ID || !savedBrowser)) throw new PersonalError("browser_record_invalid", "浏览器会话身份或原配置不符，已停止恢复。");
        if (conversation.id === ROOT_CONVERSATION_ID && savedMedia && !extensions.includes(PERSONAL_MEDIA)) throw new PersonalError("media_record_invalid", "主会话缺少原媒体扩展，已停止恢复。");
        if (conversation.id === ROOT_CONVERSATION_ID && savedPermissions && !extensions.includes(personalPermissions.name)) throw new PersonalError("permissions_version", "主会话缺少已登记的权限扩展，已停止恢复；请使用对应程序。");
        if (extensions.includes("personal-service-inspect")) serviceConversation = true;
        if (conversation.id === ROOT_CONVERSATION_ID && operationConfig && !extensions.includes("personal-service-operations")) throw new PersonalError("service_operations_config", "主会话缺少已登记的服务操作扩展，已停止恢复；请保留档案。");
        if (conversation.id === ROOT_CONVERSATION_ID && savedCommands && !extensions.includes(PERSONAL_COMMAND_WORK)) throw new PersonalError("command_config_changed", "主会话缺少原命令扩展，已停止恢复。");
        if (extensions.includes(PERSONAL_TOOLS) && !savedTools) throw new PersonalError("tool_record_invalid", "会话缺少原工具配置，已停止恢复。");
        if (extensions.includes(PERSONAL_MCP) && !savedMcp) throw new PersonalError("mcp_config_changed", "会话缺少原 MCP 配置记录，已停止恢复。");
        if (extensions.includes(PERSONAL_COMMAND_WORK) && !savedCommands) throw new PersonalError("command_config_changed", "会话缺少原命令配置记录，已停止恢复。");
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
    harness = await Harness.open(storage, { models: recordedModels(options.provider, record, media.modelMedia, async (input, settings) => {
      const conversationId = await requestConversation(settings!.sessionId!);
      const live = await harness!.snapshot(LiveDoc, conversationId, context);
      const source = live?.run?.inputs.length === 1 ? await harness!.submission(live.run.inputs[0], context) : undefined;
      const requestId = (await source?.status(context))?.requestId;
      const allowed = browser && await harness!.commit(tx => browserRequestAllowed(tx, conversationId, requestId), context);
      if (allowed) return input;
      return { ...input, messages: input.messages.map(message => message.role === "system" && message.toolsAdded ? { ...message, toolsAdded: message.toolsAdded.filter(tool => tool.name !== "browser") } : message) };
    }), registry, settings: { followUpMode: "one-at-a-time", steeringMode: "one-at-a-time" }, onReport: () => process.stderr.write("[ruukoto:personal] 持久执行出现错误，请查询状态并检查档案；未自动重启。\n") }, context);
    // Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-local-management.md
    unlocked = harness.closed.then(async () => { if (browser) await browser.close(); if (options.beforeUnlock) await options.beforeUnlock(); lock.release(); });
    void unlocked.catch(() => process.stderr.write("[ruukoto:personal] 本机管理接口未能停止，实例锁仍保留；请检查后台并核实停止。\n"));
    const inspection = await harness.inspect(context);
    const savedMain = await harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context);
    const modelWorkEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(workTools.name);
    const workControlsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalWorkControls.name);
    const workNotesEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalWorkNotes.name);
    const delegationsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalAnalysisDelegations.name);
    const reportsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalDelegationReports.name);
    const childServicesEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(personalSubAgentServices.name);
    const childWritesEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(PERSONAL_SERVICE_WORK);
    const mediaEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(PERSONAL_MEDIA);
    const browserEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(PERSONAL_BROWSER);
    const toolsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(PERSONAL_TOOLS);
    const mcpEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(PERSONAL_MCP);
    const childCommandsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(PERSONAL_COMMAND_WORK);
    const serviceControlsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(serviceControls.extension.name);
    const inspectionControlsEnabled = Array.isArray(savedMain?.extensions) && savedMain.extensions.includes(inspectionControls.extension.name);
    if (savedMain && !mediaEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("media_config_pending", "原档案仍有未完成输入或工作，请先用原程序完成处理后启用图片。");
    if (savedMain && browser && !browserEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("browser_config_pending", "原档案仍有未完成输入或工作，请先用原配置完成处理后启用浏览器。");
    if (savedMain && general && !toolsEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("tools_config_pending", "仍有未完成输入或工作，请先用原配置完成处理，再启用通用工具。");
    if (savedMain && !modelWorkEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("work_tools_pending", "档案仍有未完成输入或工作，请先用原版本完成处理，再启用模型委派。");
    if (savedMain && !delegationsEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("delegation_config_pending", "档案仍有未完成输入或分析，请先用原版本完成处理，再启用整项委托。");
    if (savedMain && !reportsEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("report_config_pending", "档案仍有未完成输入或分析，请先用原版本完成处理，再启用委托汇报。");
    if (inspection.tasks.some(task => task.state.kind === "blocked" || registry.snapshot().task(task.record.kind)?.definition.version !== task.record.version)) throw new PersonalError("task_version", "档案中有当前程序无法恢复的任务，已停止恢复，请使用对应版本。");
    // 首次启用检查先于新授权记录提交，拒绝后仍能用原配置恢复。
    if (((service && !savedService) || (operations && !operationConfig)) && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("service_config_pending", "个人档案仍有未完成输入，请先用原配置完成处理，再启用服务能力。");
    if (services && savedMain && !childServicesEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("work_services_pending", "档案仍有未完成输入或工作，请先用原版本完成处理，再启用子检查工具。");
    if (serviceWork && savedMain && !childWritesEnabled && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("work_services_pending", "档案仍有未完成输入或工作，请先用原版本完成处理，再启用子服务操作。");
    if (commands && !savedCommands && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("command_config_pending", "档案仍有未完成输入或工作，请先用原配置完成处理，再启用命令。");
    if (mcp && (!savedMcp || !isDeepStrictEqual(savedMcp.value.config, mcp.config) || (savedMain && !mcpEnabled)) && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("mcp_config_pending", "档案仍有未完成输入或工作，不能启用或改变 MCP 代次；请恢复原配置完成处理。");
    await harness.commit(tx => verifyMcp(tx, mcpKeys), context);
    if (mcp && savedMcp && !isDeepStrictEqual(savedMcp.value.config, mcp.config) && await harness.commit(async tx => (await mcpOperations(tx)).some(mcpUnresolved), context)) throw new PersonalError("mcp_config_pending", "MCP 原调用效果或远端结束未核实，不能更换配置；请恢复原配置并核实原调用。");
    await harness.commit(tx => verifyMcpControls(tx, telegramKeys, mcpEnabled), context);
    if (commands && savedCommands) await harness.commit(tx => verifyPersonalCommands(tx, commandKeys, commands.config, commands.workerPath), context);
    await harness.commit(tx => verifyPersonalTelegram(tx, telegramKeys, telegramConfig), context);
    await harness.commit(async tx => { for (const key of telegramKeys) await verifyWorkMenu(tx, (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!, workControlsEnabled); }, context);
    await harness.commit(tx => verifyServiceInspections(tx, inspectionKeys), context);
    await harness.commit(tx => verifyInspectionControls(tx, telegramKeys, inspectionControlsEnabled), context);
    for (const key of inspectionKeys) {
      const value = (await harness.snapshot(PersonalInspectionDoc, key, context))!.inspection!;
      for (const id of value.sources) {
        const source = await storage.submission(id, context);
        if (!source || source.type !== "input" || source.conversationId !== ROOT_CONVERSATION_ID || source.entry === undefined || source.entry >= value.admission) throw new PersonalError("service_inspection_invalid", "服务检查缺少原输入，已停止恢复；请保留档案。");
      }
    }
    await harness.commit(tx => verifyServiceOperationRecords(tx, operationKeys, inspectionKeys, childWritesEnabled), context);
    if (operations) await harness.commit(tx => verifyServiceGrants(tx, operationKeys), context);
    await harness.commit(tx => verifyServiceControls(tx, telegramKeys, serviceControlsEnabled), context);
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
        const localPermission = !work.telegram && await personalLocalPermission(tx, work.source.requestId);
        if (localPermission && !isDeepStrictEqual(work.permission, localPermission)) throw new PersonalError("work_record_missing", "后台工作与原本机输入权限不符，已停止恢复；请保留档案。");
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
        const expectedTools = [...(childServicesEnabled ? ["service_inspect", "read_service_inspection"] : []), ...(childWritesEnabled ? ["service_restart", "read_service_operation"] : []), ...(childCommandsEnabled ? ["run_command", "read_command_output"] : []), ...(mcpEnabled ? PERSONAL_MCP_TOOLS : []), ...(toolsEnabled ? PERSONAL_TOOL_NAMES : [])];
        const expectedExtensions = [personalSubAgent.name, personalBackgroundWork.name, ...(mediaEnabled ? [PERSONAL_MEDIA] : []), ...(childServicesEnabled ? ["personal-service-inspect", personalSubAgentServices.name] : []), ...(childWritesEnabled ? [PERSONAL_SERVICE_WORK] : []), ...(childCommandsEnabled ? [PERSONAL_COMMAND_WORK] : []), ...(mcpEnabled ? [PERSONAL_MCP] : []), ...(toolsEnabled ? [PERSONAL_TOOLS] : [])];
        if (!isDeepStrictEqual(config.tools, expectedTools) || !Array.isArray(config.extensions) || !isDeepStrictEqual([...config.extensions].sort(), expectedExtensions.sort())) throw new PersonalError("work_config_changed", "子 Agent 的固定工具配置无法核实，已停止恢复；请检查档案。");
        if (!agent.work) continue;
        const work = await tx.doc(PersonalWorkDoc, agent.work.requestId, null);
        const task = await tx.task(agent.work.taskId);
        if (!work.ref || work.ref.taskId !== agent.work.taskId || work.ref.agentId !== agent.id || !task || task.state.status === "terminal") throw new PersonalError("work_ownership", "子 Agent 的工作占用无法核实，已停止恢复；请检查原工作和档案。");
      }
    }, context);
    await harness.commit(tx => verifyBrowser(tx, browserKeys, lock.directory, browser?.extension.tools), context);
    await harness.commit(tx => verifyBrowserControls(tx, telegramKeys, browserEnabled), context);
    await harness.commit(tx => verifyTools(tx, toolKeys, lock.directory, general?.extension.tools), context);
    await harness.commit(tx => verifyToolControls(tx, telegramKeys, toolsEnabled), context);
    await harness.commit(tx => verifyPersonalDelegations(tx, delegationKeys, workKeys, delegationsEnabled), context);
    await harness.commit(tx => verifyPersonalReports(tx, delegationKeys, reportsEnabled), context);
    await harness.commit(async tx => { for (const key of telegramKeys) await verifyDelegationMenu(tx, (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt!, delegationsEnabled); }, context);
    await harness.commit(tx => tx.doc(PersonalFormatDoc), context);
    const extensions = [personal, media.extension, ...(browser ? [browser.extension] : []), personalPermissions, personalBackgroundWork, workTools, personalWorkControls, personalWorkNotes, personalAnalysisDelegations, personalDelegationReports, telegram.extension, inspectionControls.extension, serviceControls.extension, ...(services ? [services, personalInspectionExtension, personalSubAgentServices] : []), ...(operations ? [operations.extension] : []), ...(serviceWork ? [serviceWork] : []), ...(commands ? [commands.extension] : []), ...(mcp ? [mcp.extension] : []), ...(general ? [general.extension] : [])];
    const tools = [...(media.extension.tools ?? []), ...(browser?.extension.tools ?? []), ...(services?.tools ?? []), ...workTools.tools!, ...(mcp?.extension.tools ?? []), ...(general?.extension.tools ?? [])];
    if (service) await harness.commit(async tx => { (await tx.doc(PersonalServiceDoc)).fingerprint = service.fingerprint; }, context);
    const main = await harness.root(context, { agent: { model: { provider: options.provider.id, modelId: options.modelId }, thinkingLevel: "off", extensions, tools }, init: async tx => { await tx.doc(PersonalAgentsDoc); await tx.doc(PersonalPermissionsDoc); if (operations) { await tx.doc(PersonalServiceOperationsDoc); await tx.doc(PersonalServiceGrantsDoc); } } });
    if (mcp) await harness.commit(tx => configureMcp(tx, mcp.config), context);
    if (general) await harness.commit(tx => configureTools(tx, general.config), context);
    if (browser) await harness.commit(tx => configureBrowser(tx, browser!.config), context);
    const agent = await main.agent(context);
    if (!savedIndex && (inspection.tasks.length || inspection.submissions.length)) throw new PersonalError("work_config_pending", "个人档案仍有未完成输入，请先用原版本完成处理后再启用后台工作。");
    await harness.commit(async tx => {
      await tx.doc(PersonalAgentsDoc);
      await tx.doc(PersonalPermissionsDoc);
      if (operations) await tx.doc(PersonalServiceOperationsDoc);
      if (extensions.some(expected => !agent.extensions.some(extension => extension.name === expected.name))) await configure(tx, main.id, { extensions, tools });
      if (services && (!childServicesEnabled || (serviceWork && !childWritesEnabled))) for (const child of (await tx.doc(PersonalAgentsDoc)).agents) await configure(tx, child.id, { extensions: [personalSubAgent, personalBackgroundWork, services, personalSubAgentServices, ...(serviceWork ? [serviceWork] : []), ...(commands && childCommandsEnabled ? [commands.extension] : []), ...(mcp && mcpEnabled ? [mcp.extension] : []), ...(general && toolsEnabled ? [general.extension] : [])], tools: [...services.tools!, ...(serviceWork?.tools ?? []), ...(commands && childCommandsEnabled ? commands.extension.tools! : []), ...(mcp && mcpEnabled ? mcp.extension.tools! : []), ...(general && toolsEnabled ? general.extension.tools! : [])] });
      if (general && !toolsEnabled) for (const child of (await tx.doc(PersonalAgentsDoc)).agents) {
        const config = await tx.doc(AgentDoc, child.id);
        if (!Array.isArray(config.extensions) || !Array.isArray(config.tools)) throw new PersonalError("work_config_changed", "子会话工具配置无法核实，请保留档案。");
        config.extensions.push(PERSONAL_TOOLS); config.tools.push(...PERSONAL_TOOL_NAMES);
      }
      if (mcp && !mcpEnabled) for (const child of (await tx.doc(PersonalAgentsDoc)).agents) {
        const config = await tx.doc(AgentDoc, child.id);
        if (!Array.isArray(config.extensions) || !Array.isArray(config.tools)) throw new PersonalError("work_config_changed", "子会话的工具配置无法核实，请保留档案。");
        config.extensions.push(PERSONAL_MCP); config.tools.push(...PERSONAL_MCP_TOOLS);
      }
      if (commands) {
        (await tx.doc(PersonalCommandsDoc)).fingerprint = personalCommandsFingerprint(commands.config);
        if (!childCommandsEnabled) for (const child of (await tx.doc(PersonalAgentsDoc)).agents) {
          const config = await tx.doc(AgentDoc, child.id);
          if (!Array.isArray(config.extensions) || !Array.isArray(config.tools)) throw new PersonalError("work_config_changed", "子会话的工具配置无法核实，请保留档案。");
          config.extensions.push(commands.extension.name);
          config.tools.push("run_command", "read_command_output");
        }
      }
      for (const child of (await tx.doc(PersonalAgentsDoc)).agents) {
        const config = await tx.doc(AgentDoc, child.id);
        config.extensions = [personalSubAgent.name, personalBackgroundWork.name, PERSONAL_MEDIA, ...(services ? ["personal-service-inspect", personalSubAgentServices.name] : []), ...(serviceWork ? [PERSONAL_SERVICE_WORK] : []), ...(commands ? [PERSONAL_COMMAND_WORK] : []), ...(mcp ? [PERSONAL_MCP] : []), ...(general ? [PERSONAL_TOOLS] : [])];
        config.tools = [...(services ? ["service_inspect", "read_service_inspection"] : []), ...(serviceWork ? ["service_restart", "read_service_operation"] : []), ...(commands ? ["run_command", "read_command_output"] : []), ...(mcp ? PERSONAL_MCP_TOOLS : []), ...(general ? PERSONAL_TOOL_NAMES : [])];
      }
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
    if (commands) {
      mkdirSync(commands.directory, { recursive: true, mode: 0o700 });
      const refs = await instance.commit(async tx => (await personalCommandsIn(tx)).filter(op => op.started).map(op => ({ ...op.ref })), context);
      for (const ref of refs) await commands.reconcile(instance, ref, context);
      await instance.commit(tx => verifyPersonalCommands(tx, commandKeys, commands.config, commands.workerPath), context);
    }
    if (service) for (const taskId of (await instance.snapshot(PersonalPendingInspectionsDoc, context))?.tasks ?? []) await recheckServiceInspection(instance, service.config, taskId);
    await media.recover();
    if (browser) await browser.recover();
    if (general) await general.recover();
    instance.resume();
    return {
      harness: instance,
      main,
      tools: general,
      browser,
      media,
      work: personalWork(instance, { provider: options.provider.id, modelId: options.modelId }),
      service: operations?.api(instance),
      mcp: mcp && {
        list: (offset = 0) => instance.commit(tx => mcpList(tx, offset), context),
        detail: (operation: import("@earendil-works/pi-durable").TaskId, offset = 0) => instance.commit(tx => mcpDetail(tx, operation, offset), context),
        decide: (operation: import("@earendil-works/pi-durable").TaskId, decision: "approved" | "rejected") => instance.commit(tx => mcpDecide(tx, operation, decision), context),
        resolve: (operation: import("@earendil-works/pi-durable").TaskId, effect: "applied" | "not_applied", evidence: string) => instance.commit(tx => mcpResolve(tx, operation, effect, evidence), context),
        async requestRecheck(operation: import("@earendil-works/pi-durable").TaskId) { const id = await instance.commit(tx => mcp.requestRecheck(tx, operation), context); instance.resume(); return id; },
      },
      commands: commands && {
        async list(offset = 0) { return instance.commit(async tx => { const all = (await personalCommandsIn(tx)).reverse(); return { items: all.slice(offset, offset + 8).map(op => ({ ref: { ...op.ref }, command: op.command.slice(0, 160), result: op.result && { ...op.result }, stopped: op.stopped })), ...(offset + 8 < all.length ? { nextOffset: offset + 8 } : {}) }; }, context); },
        detail: (ref: import("./personal-command-work.ts").PersonalCommandRef, stream: "stdout" | "stderr", offset = 0) => commands.detail(instance, ref, stream, offset),
        async stop(ref: import("./personal-command-work.ts").PersonalCommandRef) { const id = await instance.commit(tx => commands.requestStop(tx, ref), context); instance.resume(); return id; },
      },
      inspections: service && personalInspectionControl(instance, service.config),
      async requestServiceStop(ref: PersonalServiceOperationRef) {
        const id = await instance.commit(tx => serviceControls.request(tx, ref), context);
        instance.resume();
        return id;
      },
      async requestInspectionStop(ref: PersonalInspectionRef) {
        const id = await instance.commit(tx => inspectionControls.request(tx, ref), context);
        instance.resume();
        return id;
      },
      telegram: telegram.api(instance),
      async submit(input: string, requestId: string) {
        await instance.commit(tx => personalLocalInput(tx, requestId, input), context);
        return main.submit({ type: "input", content: input, requestId, whenBusy: "followUp" }, context);
      },
      async answer(input: string, requestId: string) {
        await instance.commit(tx => personalLocalInput(tx, requestId, input), context);
        const submission = await main.submit({ type: "input", content: input, requestId, whenBusy: "followUp" }, context);
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.type !== "input") throw new PersonalError("input_unanswered", "本次输入未获得完整回答，请查看工作状态后决定下一步。");
        const entry = await main.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
        const message = entry?.model?.[0];
        if (message?.role !== "assistant") throw new PersonalError("answer_missing", "已结束输入的回答记录缺失，请保留档案并检查存储。");
        return message.content.filter(part => part.type === "text").map(part => part.text).join("");
      },
      async close() { await browser?.close(); await instance.close(context); await unlocked; },
    };
  } catch (error) {
    try {
      if (harness) { await browser?.close(); await harness.close(context); await unlocked; }
      else if (storage) await storage.close(context);
    } catch {
      // 保留启动的原异常；管理接口清理失败时仍保留锁，避免下一实例覆盖旧 socket。
      process.stderr.write("[ruukoto:personal] 初始化清理失败，已停止启动；请保留档案并检查存储。\n");
    } finally { if (!unlocked) lock.release(); }
    throw error;
  }
}

export type PersonalHarness = Awaited<ReturnType<typeof openPersonalHarness>>;
