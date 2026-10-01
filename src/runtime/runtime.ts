/**
 * 后台运行时：调度、任务生命周期、恢复与占用管理。
 *
 * - 每会话 FIFO：同一会话一次执行一个任务，新消息持久化后排队；
 * - 目录互斥：dev+ino 占用（覆盖符号链接与挂载别名），不同目录可并行；
 * - 恢复：running/awaiting_confirmation → interrupted（backend_restart），
 *   未执行 queued 保留顺序并暂停自动调度，等待拥有者 resume_queue；
 * - 停止：先拒新任务、暂停调度，中断活动任务、回收工具进程，落盘后关闭；
 *   进程信号与控制面 stop 走同一路径。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Db } from "../core/db.ts";
import { Store, StoreConflictError } from "../core/store.ts";
import {
  ACTIVE_TASK_STATUSES,
  AGENT_ROLE_IDS,
  isAccessMode,
  isTerminalTaskStatus,
  normalizeIsoInstant,
  SESSION_DEFAULT_MODES,
  type AccessMode,
  type AgentRoleId,
  type Artifact,
  type ConfirmationRequest,
  type ContextCheckpoint,
  type GrantedPath,
  type ModelSelection,
  type PersistentEvent,
  type Project,
  type Session,
  type SessionKind,
  type InboundEvent,
  type Task,
  type ToolOp,
  randomId,
} from "../core/types.ts";
import { acquireConfigLock, acquireInstanceLock, type AcquiredLock } from "../core/instance-lock.ts";
import { resolveDirIdentity, verifyDirIdentity, DirIdentityError } from "../core/dir-identity.ts";
import { createModelCatalog, type ModelCatalog, type ModelOption } from "../agent/model-selection.ts";
import {
  configRevision,
  configSecrets,
  resolveConfiguredModel,
  loadAuthFile,
  loadDefaultModel,
  loadModelCatalogFile,
  loadSummaryModel,
  removeProviderCredential,
  restoreCatalogSecrets,
  restoreConfigFiles,
  sanitizeCatalog,
  saveDefaultModel,
  saveModelCatalogFile,
  saveSummaryModel,
  setProviderApiKey,
  snapshotConfigFiles,
  validateApiKey,
  validateModelCatalog,
  type SummaryModel,
} from "../agent/model-config.ts";
import { createApprovalReviewer, type ApprovalReviewer } from "../agent/review.ts";
import { Driver } from "../agent/driver.ts";
import { createMockTools } from "../agent/mock-tools.ts";
import { createCodingTools } from "../agent/tool-router.ts";
import { ArtifactStore } from "../agent/artifacts.ts";
import { CredentialStore } from "../agent/execution/credentials.ts";
import { getProjectJevConfig, jevConfigKey, jevCredentialHost, JEV_CREDENTIAL_PURPOSE, type JevConfig } from "../agent/jev-config.ts";
import {
  createLauncherFor,
  ExecutionError,
  type ExecutionBackendConfig,
} from "../agent/execution/launchers.ts";
import { sessionsDirFor } from "../agent/session-factory.ts";
import { fileURLToPath } from "node:url";
import { assertGrantNotProtected } from "../agent/execution/approved-ops.ts";
import { grantCoversPath, resolveWorktreeCommonGitDir } from "../core/worktree.ts";
import { AccessScope, AccessDeniedError } from "../core/access.ts";
import { isPlanInput } from "../agent/plan-mode.ts";
import { HistoryIndex, readRawEntryAt, searchHistory, type HistorySearchOptions } from "../core/history-index.ts";
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryStore,
  MemoryValidationError,
  type MemoryWithContent,
} from "../core/memory.ts";
import type { DataCategory, DataGrant, Memory, MemorySourceRef, MemoryVersion, SelectionRecord } from "../core/types.ts";
import type { SelectorBudgetConfig } from "../agent/context-selector.ts";
import { selectionBreakdown, SelectionRecordCorrupt, type ContextBreakdown } from "../agent/context-selector.ts";
import { McpStore, McpVersionConflictError, allowlistEffectFor, normalizeToolAllowlist, type McpServiceConfig, type McpToolEffect } from "../agent/mcp/store.ts";
import { connectMcpService, parseMcpEndpoint, MCP_CREDENTIAL_PURPOSE, type McpConnection, type McpTimeouts } from "../agent/mcp/client.ts";
import { validateRemoteTool } from "../agent/mcp/tools.ts";
import { retireGitHubModule } from "./github-retirement.ts";
import { GitHubWebhook, GITHUB_SOURCE } from "../github/webhook.ts";
import { GitHubEvents, parseGitHubEventsConfig, webhookSecret, type GitHubEventsConfig } from "../github/events.ts";
import { Orchestrator } from "./orchestrator.ts";
import { AppDataStore, AppDataError } from "../agent/app-data/store.ts";
import { AppDataQueryRunner } from "../agent/app-data/query.ts";
import { appDataOpCheck } from "../agent/app-data/tools.ts";
import { ToolOpLedger } from "../agent/tool-op-ledger.ts";
import { SchedulerStore, SchedulerConflictError, type NotificationStatus, type ScheduleStatus } from "../scheduler/store.ts";
import { Scheduler, type NotifyChannel } from "../scheduler/runtime.ts";
import { searchTavily, WebSearchError } from "../agent/web-search.ts";
import { loadSkillLibrary, skillsDirFor } from "../agent/skills.ts";
import { createSourceResolver, schedulerOpCheck, type SourceResolver } from "../agent/scheduler-tools.ts";
import { PRODUCT_META_KEY, type ProductType } from "../core/product.ts";
import { delegationOpCheck } from "../agent/delegation-tools.ts";
import { chatResultOpCheck } from "../agent/chat-result-tools.ts";
import { QqAdapter, filterRecalledQqMessages, QQ_CREDENTIAL_PURPOSE, QQ_PRIVATE_SOURCE, qqPrivateExternalId, type QqAdapterTimeouts } from "../qq/adapter.ts";
import { QQ_GROUP_SOURCE, QqStore, QqVersionConflictError, type QqConfig, type QqInboxRow, type QqOutboxRow } from "../qq/store.ts";
import {
  capReply,
  TelegramAdapter,
  TelegramStore,
  TelegramVersionConflictError,
  telegramExternalId,
  TELEGRAM_CREDENTIAL_PURPOSE,
  TELEGRAM_DEFAULT_API,
  TELEGRAM_SOURCE,
  type TelegramConfig,
} from "../telegram/adapter.ts";
import type { ChildOutcome } from "./orchestrator.ts";
import {
  readHistoryEntryText,
  readToolResult,
  readHistoryPage,
  sliceTextByBytes,
  tailTextByBytes,
  HistoryReadError,
  type HistoryEntryView,
  type HistoryPage,
} from "../core/history.ts";
import {
  capEventForWire,
  frameBytes,
  confirmationToView,
  toolOpToView,
  FRAGMENT_TEXT_CAP,
  SEGMENT_DEFAULT_BYTES,
  SEGMENT_MAX_BYTES,
  type BoundedText,
  type ConfirmationRequestView,
  type OutputPreview,
  type ToolOpView,
} from "../core/views.ts";

/** 快照中每个会话保留的近期已结束任务数（更早的经 list_tasks 分页查询）。 */
const SNAPSHOT_ENDED_TASKS_PER_SESSION = 20;
/** 快照/get_task 中输出预览的字节上限。 */
const FRAGMENT_PREVIEW_CAP = FRAGMENT_TEXT_CAP;

/** 服务代码根目录（本模块位于 <codeRoot>/src/runtime/）。 */
const CODE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface RuntimeConfig {
  dataDir: string;
  /** pi 凭据与模型配置目录（显式指定，不读 ~/.pi/agent）。 */
  agentDir: string;
  /** 控制面目录（socket 与拥有者令牌；默认数据目录的兄弟目录 control/）。 */
  controlDir?: string;
  socketPath?: string;
  thinkingLevel?: ModelSelection["thinkingLevel"];
  /** 默认取 models.json 的第一个模型；可显式指定 provider/id。 */
  modelProvider?: string;
  modelId?: string;
  /**
   * 工具执行后端：local（开发/验证，无隔离，禁止用于声明请求确认模式的
   * 边界）| container（Linux 容器边界）| systemd（执行账户入口）。
   * 省略时取 local：只适用于开发与模拟验证，生产部署必须显式配置。
   */
  execution?: ExecutionBackendConfig;
  /** 默认注册真实编码工具（路由器 + 工具工作进程）；模拟测试可覆盖。 */
  toolFactory?: (ctx: { registry: import("../agent/managed-processes.ts").ManagedProcessRegistry; router: import("../agent/tool-router.ts").ToolRouter }) => ToolDefinition[];
  /** 上下文预算覆盖（默认取模型 contextWindow/maxTokens + 默认预留；测试用小窗口时收紧预留）。 */
  budgetOverrides?: Partial<SelectorBudgetConfig>;
  /** Web Search（issue 20）：Tavily 目标/超时覆盖（仅测试注入；生产缺省官方端点与 15s 超时）。 */
  webSearch?: import("../agent/web-search.ts").WebSearchConfig;
  /** Jev 实验：仅测试注入目标与超时；生产固定官方端点。 */
  jev?: { baseUrl?: string; timeoutMs?: number };
  /** 上下文压缩（issue 30）：摘要超时覆盖（仅测试注入；生产 180 s）。 */
  compaction?: { summaryTimeoutMs?: number };
  /** MCP（issue 16）：超时覆盖（仅测试注入；生产缺省 MCP_LIMITS）。 */
  mcp?: McpTimeouts;
  /** 自动审查配置（issue 15）：仅测试用来压短时限/输出上限。 */
  autoReview?: { timeoutMs?: number; maxTokens?: number };
  /** QQ 入口：超时/巡检间隔覆盖（仅测试注入；生产取默认）。 */
  qq?: QqAdapterTimeouts;
  /**
   * 停用真实 QQ 通道（issue 21 §1，dev 开发实例经 RUUKOTO_DISABLE_QQ=1 注入）：
   * 不创建/启动适配器；qq 控制面操作仍作用于配置存储，qqStatus 标注停用来源。
   */
  qqDisabled?: boolean;
  /**
   * 停用真实 Telegram 通道（issue 04，dev 开发实例经 RUUKOTO_DISABLE_TELEGRAM=1 注入）：
   * 不创建适配器；telegram 控制面操作仍作用于配置存储。
   */
  telegramDisabled?: boolean;
  /**
   * 产品身份（agent-direction issue 01，ADR 0017）：缺省 ruukoto（个人 Agent）。
   * ruukoto-dev（Coding Agent）启动时强制停用 QQ/Telegram 适配器、不创建调度器，
   * 并把产品归属登记到数据目录 meta（跨产品复用同一数据目录直接拒绝）。
   */
  productType?: ProductType;
  /** Telegram 入口（issue 04）：长轮询秒数/断线退避覆盖（仅测试注入；生产取默认）。 */
  telegram?: { pollTimeoutSec?: number; backoffMs?: number };
  /** 编排器（issue 01）：超时巡检间隔覆盖（仅测试注入；生产取默认）。 */
  orchestrator?: { deadlineCheckMs?: number };
  /** 应用数据（issue 02）：查询子进程挂点（仅测试注入；生产缺省）。 */
  appData?: { queryStallMs?: number };
  /**
   * 调度器与通知：测试可替换默认 Telegram 渠道，QQ 按操作目标走自身适配器；
   * 未加载发送器时保留 pending。时钟/间隔/发送时限仅测试覆盖。
   */
  scheduler?: { channel?: NotifyChannel; now?: () => number; tickMs?: number; sendTimeoutMs?: number };
  /** 显式可信启动配置，缺省不监听；GitHub 操作仍经通用 MCP。 */
  githubWebhook?: GitHubEventsConfig;
}

export class RuntimeApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 先核对结构，再进行幂等核实；模型能力与认证只检查尚未接收的请求。 */
export function parseModelSelection(value: unknown): ModelSelection {
  const v = value as Partial<ModelSelection> | null;
  if (!v || typeof v.provider !== "string" || !v.provider.trim() || typeof v.modelId !== "string" || !v.modelId.trim()
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v.thinkingLevel as string)) {
    throw new RuntimeApiError("invalid_params", "model_selection 必须包含 provider、modelId 和合法 thinkingLevel");
  }
  return { provider: v.provider, modelId: v.modelId, thinkingLevel: v.thinkingLevel! };
}

class DirOccupiedError extends Error {}
class TaskGoneError extends Error {}

export class Runtime {
  readonly config: RuntimeConfig;
  private readonly db: Db;
  readonly store: Store;
  readonly artifacts: ArtifactStore;
  readonly credentials: CredentialStore;
  /** 统一数据访问范围（issue 05 §1）：身份由宿主注入，跨项目仅经拥有者授权。 */
  readonly access: AccessScope;
  /** pi JSONL 历史的可重建位置索引（issue 05 §2）。 */
  readonly historyIndex: HistoryIndex;
  /** 长期记忆存储（issue 05 §5）。 */
  readonly memories: MemoryStore;
  /** MCP 服务配置（issue 16）：拥有者按项目管理的 MCP 服务。 */
  readonly mcp: McpStore;
  /** QQ 连接配置与群聊收发记录（私聊使用编排器与公共 outbox）。 */
  readonly qqStore: QqStore;
  /** QQ 群聊与 owner 私聊适配器（null = 尚未启动或开发实例停用）。 */
  private qqAdapter: QqAdapter | null = null;
  /**
   * main 应用数据空间（issue 02）：独立 main.db + 只读查询子进程运行器。
   * unavailableReason 非空时能力停止（丢失/身份不符/损坏/格式过新），
   * 不自动重建、不覆盖既有实例绑定。
   */
  private appDataStore: AppDataStore | null = null;
  private readonly appDataRunner = new AppDataQueryRunner();
  private appDataUnavailableReason: string | null = null;
  /** 后台编排器（issue 01）：角色引导、入站事件派发、子任务结果回传与超时。 */
  orchestrator: Orchestrator | null = null;
  /** Telegram owner 入口配置（issue 04）。 */
  readonly telegramStore: TelegramStore;
  /** Telegram 适配器（start 时创建；null = 未创建或 dev 停用）。 */
  private telegram: TelegramAdapter | null = null;
  private githubWebhook: GitHubWebhook | null = null;
  private readonly githubEvents: GitHubEvents;
  /** 调度计划/运行/发送账本（issue 03，核心库三表）。 */
  readonly sched: SchedulerStore;
  /** 工具操作账本（架构工单 05）：结果、效果未知与停止/重启补记。 */
  private readonly ledger: ToolOpLedger;
  /** 调度器（issue 03）：扫描循环 + 发送循环；仅个人 Agent 产品在 start 时创建。 */
  scheduler: Scheduler | null = null;
  /** 产品身份（issue 01）：缺省 ruukoto。 */
  readonly productType: ProductType;
  private sources!: SourceResolver;
  /** 额外事件监听（QQ 适配器等宿主内订阅者；控制面广播仍走 onEventBroadcast）。 */
  private readonly eventListeners = new Set<(events: PersistentEvent[]) => void>();
  private readonly lock: AcquiredLock;
  /** 模型配置锁（issue 21 §3）：同一 agentDir 的在线/离线写入互斥。 */
  private readonly configLock: AcquiredLock;
  modelRuntime!: ModelRuntime;
  private model: any;
  modelCatalog!: ModelCatalog;
  defaultSelection!: ModelSelection;
  /** 自动审查调用（issue 15）：start 建好模型目录后创建；auto-review 任务的审批闸门使用。 */
  private reviewer!: ApprovalReviewer;
  /**
   * 模型配置应用门闩（issue 21 §4）：非 null 表示正在应用，元素为受影响
   * provider；门闩期间这些 provider 的新任务拒绝进入执行或队列。
   */
  private modelConfigGate: Set<string> | null = null;
  /** 当前（或最近一次）配置应用结束时兑现；内部提交遇门闩等它后重试。 */
  private modelConfigSettled: Promise<void> = Promise.resolve();
  private drivers = new Map<string, Driver>();
  private loopActive = new Set<string>();
  private loopPromises = new Map<string, Promise<void>>();
  private wakePending = new Set<string>();
  stopping = false;
  private stopPromise: Promise<void> | null = null;
  /** 控制面注入：事件广播与停止回调。 */
  onEventBroadcast: ((events: PersistentEvent[]) => void) | null = null;
  onCloseServer: (() => Promise<void>) | null = null;

  private constructor(config: RuntimeConfig, db: Db, store: Store, lock: AcquiredLock, configLock: AcquiredLock) {
    this.config = config;
    this.productType = config.productType ?? "ruukoto";
    this.db = db;
    this.store = store;
    this.lock = lock;
    this.configLock = configLock;
    this.artifacts = new ArtifactStore(config.dataDir, store);
    this.credentials = new CredentialStore(config.agentDir);
    this.access = new AccessScope(db);
    this.historyIndex = new HistoryIndex(db);
    this.memories = new MemoryStore(db);
    this.mcp = new McpStore(db);
    this.qqStore = new QqStore(db);
    this.sched = new SchedulerStore(store);
    this.ledger = new ToolOpLedger(store, {
      app_data: appDataOpCheck((opId) => this.appDataWriteVerdict(opId)),
      scheduler: schedulerOpCheck(this.sched),
      delegation: delegationOpCheck(store),
      chat_result: chatResultOpCheck(store),
    });
    this.telegramStore = new TelegramStore(store);
    this.githubEvents = new GitHubEvents({
      store, artifacts: this.artifacts, sched: this.sched, config: config.githubWebhook,
      target: (channel) => this.notifyChannel(channel)?.target() ?? null,
      readReply: (id, offset, length) => this.readTaskReply(id, offset, length),
      dispatch: () => !this.stopping && this.orchestrator ? this.orchestrator.dispatchRegisteredEvents() : Promise.resolve(),
      capReply: (target, text) => {
        if (target.channel !== QQ_PRIVATE_SOURCE) return capReply(text);
        const chars = [...text], cap = this.qqStore.getConfig()?.maxReplyChars ?? 1500;
        return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : text;
      },
    });
    store.onCommitted = (events) => {
      this.onEventBroadcast?.(events);
      for (const listener of this.eventListeners) {
        try {
          listener(events);
        } catch {
          // 宿主内监听者异常不影响提交路径
        }
      }
    };
  }

  /** 订阅持久事件（宿主内组件，如 QQ 适配器；控制面广播用 onEventBroadcast）。 */
  addEventListener(listener: (events: PersistentEvent[]) => void): void {
    this.eventListeners.add(listener);
  }

  removeEventListener(listener: (events: PersistentEvent[]) => void): void {
    this.eventListeners.delete(listener);
  }

  /** 控制面目录（socket 与拥有者令牌所在）。 */
  controlDir(): string {
    return this.config.controlDir ?? path.join(path.dirname(path.resolve(this.config.dataDir)), "control");
  }

  /** 始终排除的保护根目录：后台数据、服务凭据、控制面与服务代码（realpath 规范化）。 */
  protectedRoots(): string[] {
    const canonical = (p: string): string => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    return [
      canonical(this.config.dataDir),
      canonical(this.config.agentDir),
      canonical(this.controlDir()),
      canonical(CODE_ROOT),
    ];
  }

  launcherFor(mode: AccessMode) {
    return createLauncherFor(this.config.execution ?? { backend: "local" }, mode);
  }

  static async start(config: RuntimeConfig): Promise<Runtime> {
    const productType: ProductType = config.productType ?? "ruukoto";
    // Coding Agent 产品（issue 01）：消息平台连接与个人调度不属于产品边界；
    // 与显式 qqDisabled/telegramDisabled 同源生效（状态视图按产品标注原因）
    const fullConfig: RuntimeConfig = { ...config, execution: config.execution ?? { backend: "local" },
      qqDisabled: productType === "ruukoto-dev" ? true : config.qqDisabled,
      telegramDisabled: productType === "ruukoto-dev" ? true : config.telegramDisabled,
      githubWebhook: config.githubWebhook ? parseGitHubEventsConfig(config.githubWebhook) : undefined };
    fs.mkdirSync(fullConfig.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(fullConfig.agentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionsDirFor(fullConfig.dataDir), { recursive: true, mode: 0o700 });

    const lock = acquireInstanceLock(fullConfig.dataDir);
    // 配置锁（issue 21 §3）：同一 agentDir 只允许一个在线后台或离线配置写入方，
    // 覆盖不同 dataDir 指向同一 agentDir 的情况
    let configLock: AcquiredLock;
    try {
      configLock = acquireConfigLock(fullConfig.agentDir);
    } catch (err) {
      lock.release();
      throw err;
    }
    let runtime: Runtime;
    try {
      const db = new Db(fullConfig.dataDir);
      const store = new Store(db);
      runtime = new Runtime(fullConfig, db, store, lock, configLock);
    } catch (err) {
      configLock.release();
      lock.release();
      throw err;
    }

    // 产品归属登记（issue 01，兼容扩展）：旧库无该 meta 键，首次启动按当前产品补记；
    // 已归属另一产品的数据目录拒绝以本产品启动——配置、数据与控制面不跨产品串用
    const recordedProduct = runtime.store.getMetaValue(PRODUCT_META_KEY);
    if (recordedProduct !== null && recordedProduct !== productType) {
      runtime.db.close();
      configLock.release();
      lock.release();
      throw new RuntimeApiError(
        "product_mismatch",
        `该数据目录已归属产品 ${recordedProduct}，不能以 ${productType} 启动；检查 --data-dir、RUUKOTO_*_DIR 或 RUUKOTO_PRODUCT`,
      );
    }
    if (recordedProduct === null) runtime.store.setMetaValue(PRODUCT_META_KEY, productType);

    try {
      if (fullConfig.githubWebhook) webhookSecret(runtime.credentials, fullConfig.githubWebhook, true);
    } catch (err) {
      runtime.db.close(); configLock.release(); lock.release(); throw err;
    }

    runtime.modelRuntime = await ModelRuntime.create({
      authPath: path.join(fullConfig.agentDir, "auth.json"),
      modelsPath: path.join(fullConfig.agentDir, "models.json"),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    const configured = resolveConfiguredModel(runtime.modelRuntime, fullConfig);
    if (!configured) {
      runtime.db.close();
      configLock.release();
      lock.release();
      throw new RuntimeApiError(
        "no_model",
        "未找到可用模型：models.json 中没有 provider，或指定的 provider/model 不存在",
      );
    }
    runtime.model = configured.model;
    runtime.defaultSelection = { provider: configured.model.provider, modelId: configured.model.id, thinkingLevel: configured.thinkingLevel };
    try {
      runtime.modelCatalog = await createModelCatalog(runtime.modelRuntime, config.agentDir, configured.model);
      await runtime.modelCatalog.resolve(runtime.defaultSelection);
      runtime.reviewer = createApprovalReviewer({
        modelRuntime: runtime.modelRuntime,
        modelCatalog: runtime.modelCatalog,
        timeoutMs: fullConfig.autoReview?.timeoutMs,
        maxTokens: fullConfig.autoReview?.maxTokens,
      });
      runtime.store.withTx(() => runtime.store.initializeSessionModelSelections(runtime.defaultSelection));
    } catch (err) {
      runtime.db.close();
      configLock.release();
      lock.release();
      throw err;
    }

    // main 应用数据空间（issue 02）：先于恢复打开/登记 main.db 并核对实例绑定
    // （恢复要按应用库回执核实未落结果的应用数据操作）；不可用则能力停止
    runtime.initAppData();
    runtime.initSources();
    // 调度器（issue 03）：恢复准备须在通用 recover() 改写 running 任务之前——
    // 先按关联记录真实状态补关闭/合并漏过周期，再把遗留 sending 定为未知。
    // 个人调度只属于个人 Agent 产品（issue 01）：ruukoto-dev 不创建调度器
    if (runtime.productType === "ruukoto") {
      runtime.initScheduler();
      runtime.scheduler!.prepareRecovery();
    }
    runtime.recover();
    // GitHub 专用模块退役迁移（issue 17）：仅升级后首次启动执行；无旧表直接跳过
    retireGitHubModule({ db: runtime.db, store: runtime.store, artifacts: runtime.artifacts, dataDir: fullConfig.dataDir });
    // QQ 群聊入口（issue 07）：恢复收件登记、自动恢复群会话队列，按配置连接
    // NapCat（未配置/未启用时保持禁用，不猜测端点与群号）；
    // qqDisabled（dev 开发实例）跳过适配器创建，不真实连接
    if (!fullConfig.qqDisabled) {
      runtime.qqAdapter = new QqAdapter({
        store: runtime.store,
        qqStore: runtime.qqStore,
        sched: runtime.sched,
        credentials: runtime.credentials,
        dataDir: fullConfig.dataDir,
        timeouts: fullConfig.qq,
        bridge: {
          registerPrivate: async (input) => {
            if (runtime.stopping || !runtime.orchestrator) throw new Error("编排器尚未就绪或后台正在停止");
            return runtime.orchestrator.registerInboundEvent({ source: QQ_PRIVATE_SOURCE, targetRole: "main", ...input });
          },
          dispatchInbound: () => runtime.orchestrator?.dispatchRegisteredEvents() ?? Promise.resolve(),
          registerGroup: (key) => {
            if (runtime.stopping || !runtime.orchestrator) throw new Error("编排器尚未就绪或后台正在停止");
            return runtime.orchestrator.registerQqGroup(key);
          },
          cancelTask: (taskId) => runtime.cancelTask(taskId),
          findProjectByName: (name) => runtime.store.findProjectByName(name),
          createProject: (name) => runtime.createProject(name),
          createSession: (input) => runtime.createSession(input),
          readTaskReplyText: (taskId) => runtime.readTaskReplyText(taskId),
          resumeQueue: (sessionId) => runtime.resumeQueue(sessionId),
          kickSession: (sessionId) => runtime.kick(sessionId),
        },
      });
      runtime.addEventListener((events) => runtime.qqAdapter?.onRuntimeEvents(events));
    }
    // Telegram owner 入口（issue 04）：先创建（编排器启动巡检补登 owner 回复要读
    // 固定目标），编排器启动后才开始轮询；dev 开发实例不创建
    if (!fullConfig.telegramDisabled) {
      runtime.telegram = new TelegramAdapter({
        store: runtime.store,
        tg: runtime.telegramStore,
        sched: runtime.sched,
        credentials: runtime.credentials,
        register: async (input) => {
          if (!runtime.orchestrator) throw new Error("编排器未启动");
          return runtime.orchestrator.registerInboundEvent({ source: TELEGRAM_SOURCE, targetRole: "main", ...input });
        },
        log: (message) => process.stderr.write(`[ruukoto:telegram] ${message}\n`),
        ...fullConfig.telegram,
      });
    }
    // 编排器（issue 01）：引导 main/coding/chat 角色、恢复已登记未建任务的
    // 入站事件、补记重启窗口内结束的子任务结果；监听任务终态事件做结果回传
    runtime.orchestrator = new Orchestrator({
      store: runtime.store,
      qqStore: runtime.qqStore,
      dataDir: fullConfig.dataDir,
      deadlineCheckMs: fullConfig.orchestrator?.deadlineCheckMs,
      bridge: {
        submit: (input) => runtime.submitInternal(input),
        cancelTask: (taskId, reason) => runtime.cancelTask(taskId, reason ? { reason } : undefined),
        findProjectByName: (name) => runtime.store.findProjectByName(name),
        createProject: (name) => runtime.createProject(name),
        createSession: (input) => runtime.createSession(input),
        readTaskReply: (taskId, offset, length) => runtime.readTaskReply(taskId, offset, length),
        resumeQueue: (sessionId) => runtime.resumeQueue(sessionId),
        kickSession: (sessionId) => runtime.kick(sessionId),
        defaultModelSelection: () => runtime.defaultSelection,
      },
      onInboundTerminal: (event, task, outcome) => event.source === GITHUB_SOURCE
        ? runtime.githubEvents.terminal(event, task, outcome)
        : runtime.enqueueOwnerReply(event, task, outcome),
      inboundGate: (event) => runtime.inboundGate(event),
      reviewRequest: (event) => runtime.githubEvents.request(event),
      resultData: (task, outcome) => runtime.githubEvents.resultData(task, outcome),
      resultNotice: (task) => runtime.githubEvents.notice(task),
    });
    runtime.addEventListener((events) => runtime.orchestrator?.onRuntimeEvents(events));
    await runtime.orchestrator.start();
    await runtime.qqAdapter?.start();
    runtime.telegram?.start();
    // 恢复与角色引导完成后才开放调度事件派发与发送（ruukoto-dev 无调度器）
    runtime.scheduler?.start();
    if (fullConfig.githubWebhook) {
      try {
        runtime.githubWebhook = await GitHubWebhook.start({
          ...fullConfig.githubWebhook,
          secret: () => webhookSecret(runtime.credentials, fullConfig.githubWebhook!),
          onPullRequest: (event) => {
            if (runtime.stopping) throw new Error("后台正在停止");
            return runtime.githubEvents.register(event);
          },
        });
      } catch (err) {
        await runtime.stop("github_webhook_start_failed");
        throw err;
      }
    }
    runtime.store.withTx(() => {
      runtime.store.appendEvent({ type: "backend.started", dataDir: fullConfig.dataDir, executionBackend: fullConfig.execution!.backend, product: productType });
    });
    return runtime;
  }

  socketPath(): string {
    return this.config.socketPath ?? path.join(this.controlDir(), "control.sock");
  }

  githubWebhookAddress() { return this.githubWebhook?.address ?? null; }

  // ---------- 调度器与通知（issue 03） ----------

  /** 来源核实（issue 03/05）：通知与委派的来源校验共用；与调度器生命周期无关。 */
  private initSources(): void {
    this.sources = createSourceResolver({
      store: this.store,
      access: this.access,
      artifacts: this.artifacts,
      appData: () => this.appDataStore,
    });
  }

  private initScheduler(): void {
    const now = this.config.scheduler?.now ?? (() => Date.now());
    const channel = (source: string) => this.notifyChannel(source);
    this.scheduler = new Scheduler({
      store: this.store,
      sched: this.sched,
      now,
      channel,
      // 编排器在 start 末尾创建；调度扫描只在其后开放，恢复准备不派发
      dispatchRegistered: () => this.orchestrator?.dispatchRegisteredEvents() ?? Promise.resolve(),
      serial: (fn) => (this.orchestrator ? this.orchestrator.serial(fn) : fn()),
      cancelTask: (taskId) => this.cancelTask(taskId),
      verifySources: (op) => {
        const problem = this.githubEvents.verifyNotification(op);
        if (problem) return problem;
        const main = this.store.getAgentRole("main");
        if (op.sourceKind === "schedule_run") {
          const run = this.sched.getRun(op.sourceKey);
          if (run?.newsResult && (!main || this.store.getProject(main.projectId)?.webSearch !== "enabled")) return "新闻搜索已禁用或 main 不可用";
        }
        return main ? this.sources.verify(main.projectId, op.sourceRefs) : "main 角色未引导";
      },
      searchNews: (params, signal) => {
        const main = this.store.getAgentRole("main");
        if (!main || this.store.getProject(main.projectId)?.webSearch !== "enabled") throw new WebSearchError("disabled", "main Web Search 不可用");
        return searchTavily({ credentials: this.credentials, projectId: main.projectId, ...this.config.webSearch }, params, signal);
      },
      log: (message) => process.stderr.write(`[ruukoto:scheduler] ${message}\n`),
      tickMs: this.config.scheduler?.tickMs,
      sendTimeoutMs: this.config.scheduler?.sendTimeoutMs,
    });
  }

  /** 按已固定的渠道选择发送器；缺省通知仍沿用 Telegram，不能把旧操作改发到另一平台。 */
  private notifyChannel(source?: string): NotifyChannel | null {
    if (source === QQ_PRIVATE_SOURCE) return this.qqAdapter;
    if (this.config.scheduler?.channel) return this.config.scheduler.channel;
    return source === undefined || source === TELEGRAM_SOURCE ? this.telegram : null;
  }

  private qqPrivateGate(event: InboundEvent): "run" | "wait" | { drop: string } {
    if (event.source !== QQ_PRIVATE_SOURCE) return "run";
    return this.qqAdapter?.gatePrivate(event) ?? "wait";
  }

  private inboundGate(event: InboundEvent): "run" | "wait" | { drop: string } {
    if (event.source === QQ_GROUP_SOURCE) return this.qqAdapter?.gateGroup(event) ?? "wait";
    return event.source === GITHUB_SOURCE ? this.githubEvents.gate(event) : this.qqPrivateGate(event);
  }

  /**
   * owner 回复（issue 04/06）：私聊入站任务到达终态时，在编排器的结果事务内
   * 登记一条发送操作——发送键为入站事件 id，目标由宿主固定，正文取本任务的
   * 最终回答（失败/超时/未知只发宿主固定提示）。定时唤醒与子任务唤醒产生的
   * 任务没有私聊来源事件，不会自动外发。
   */
  private enqueueOwnerReply(event: InboundEvent, task: Task, outcome: ChildOutcome): void {
    if (event.source !== TELEGRAM_SOURCE && event.source !== QQ_PRIVATE_SOURCE) return;
    const skip = (reason: string) => this.store.appendEvent({ type: event.source === QQ_PRIVATE_SOURCE ? "qq_private.reply_skipped" : "telegram.reply_skipped", eventId: event.id, taskId: task.id, reason }, { taskId: task.id });
    const current = this.notifyChannel(event.source)?.target() ?? null;
    const target = event.source === QQ_PRIVATE_SOURCE ? event.replyTarget : current;
    const externalId = event.source === QQ_PRIVATE_SOURCE ? qqPrivateExternalId : telegramExternalId;
    // 目标只能是登记该消息的同一 bot + chat（配置换了 bot/chat 不改发到新目标）
    if (!target || !current || !isDeepStrictEqual(target, current) || !event.externalId.startsWith(externalId(target.account, target.chatId, ""))) {
      return skip(target ? "target_changed" : "target_unavailable");
    }
    const text =
      outcome === "completed"
        ? this.readTaskReplyText(task.id)?.trim() || "（无文本输出）"
        : `[ruukoto] 这条消息的处理${outcome === "timeout" ? "超时" : outcome === "unknown" ? "被后台重启中断，结果未知" : "失败或已取消"}，详情见 TUI。`;
    try {
      const chars = [...text];
      const cap = this.qqStore.getConfig()?.maxReplyChars ?? 1500;
      const reply = event.source === QQ_PRIVATE_SOURCE
        ? (chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : text)
        : capReply(text);
      this.sched.insertOp({ sourceKind: "owner_reply", sourceKey: event.id, taskId: task.id, hostOpId: null, target, text: reply, sourceRefs: [] });
    } catch (err) {
      skip(`enqueue_failed：${(err as Error).message}`.slice(0, 200));
    }
  }

  /** 拥有者控制面：计划分页列表 / 详情（含最近运行） / 取消。 */
  scheduleList(input: { status?: string; cursor?: string; limit?: number }) {
    if (input.status !== undefined && !["active", "completed", "canceled"].includes(input.status)) {
      throw new RuntimeApiError("invalid_params", "status 只能是 active / completed / canceled");
    }
    const { items, nextCursor } = this.sched.listSchedules({ status: input.status as ScheduleStatus | undefined, cursor: input.cursor, limit: input.limit });
    // 列表不带完整正文（详情单条读取），保持分页有界
    return { schedules: items.map(({ payload, ...rest }) => ({ ...rest, payloadChars: [...payload.text].length })), nextCursor };
  }

  scheduleGet(scheduleId: string) {
    const schedule = this.sched.getSchedule(scheduleId);
    if (!schedule) throw new RuntimeApiError("not_found", `计划不存在：${scheduleId}`);
    return { schedule, runs: this.sched.listRuns(scheduleId, 20) };
  }

  async scheduleCancel(input: { scheduleId: string; expectedVersion: number; reason: string }) {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    // ruukoto-dev 无调度器：取消计划的合并语义不可用，明确拒绝而不是静默改写
    if (!this.scheduler) throw new RuntimeApiError("unavailable", "该实例未启动个人调度（Coding Agent 产品边界）");
    if (!input.reason.trim()) throw new RuntimeApiError("invalid_params", "reason 不能为空");
    try {
      return await this.scheduler.cancelSchedule({ ...input, source: "owner", cancelOpId: null });
    } catch (err) {
      if (err instanceof SchedulerConflictError) throw new RuntimeApiError("request_conflict", err.message);
      throw err;
    }
  }

  notificationList(input: { status?: string; cursor?: string; limit?: number }) {
    if (input.status !== undefined && !["pending", "sending", "sent", "failed", "effect_unknown", "canceled"].includes(input.status)) {
      throw new RuntimeApiError("invalid_params", "status 非法");
    }
    const { items, nextCursor } = this.sched.listOps({ status: input.status as NotificationStatus | undefined, cursor: input.cursor, limit: input.limit });
    return { operations: items.map(({ text, ...rest }) => ({ ...rest, textChars: [...text].length })), nextCursor };
  }

  notificationGet(opId: string) {
    const op = this.sched.getOp(opId);
    if (!op) throw new RuntimeApiError("not_found", `发送操作不存在：${opId}`);
    return { operation: op };
  }

  notificationCancel(input: { opId: string; reason: string }) {
    if (!input.reason.trim()) throw new RuntimeApiError("invalid_params", "reason 不能为空");
    const op = this.store.withTx(() => this.sched.cancelOp(input.opId, input.reason, null));
    if (!op) throw new RuntimeApiError("not_found", `发送操作不存在：${input.opId}`);
    return { operation: op };
  }

  // ---------- 应用数据空间（issue 02） ----------

  /**
   * 打开 main.db 并核对核心库登记的实例绑定：
   * - 未登记（全新部署）→ 建立并把稳定实例 ID 登记到核心库 meta（同事务）；
   * - 已登记但文件丢失/身份不符/损坏/格式过新 → 能力停止，不自动创建空库，
   *   不据此把旧操作判为未提交；保留未知效果并留下 app_data.unavailable。
   */
  private initAppData(): void {
    const dataDir = path.resolve(this.config.dataDir);
    const appDir = path.join(dataDir, "agent-data");
    const file = path.join(appDir, "main.db");
    const registered = this.store.getMetaValue("app_data.main_instance_id");
    if (!registered) {
      // 首次初始化（或上次初始化在"建库后、登记前"崩溃）：打开/建立库并登记
      // 其实例 ID。跨库失败可恢复——下次启动重试；不覆盖既有实例绑定。
      let store: AppDataStore | null = null;
      try {
        store = new AppDataStore(file);
        const instanceId = store.getInstanceId();
        this.store.withTx(() => this.store.setMetaValue("app_data.main_instance_id", instanceId));
        this.appDataStore = store;
        this.appDataUnavailableReason = null;
      } catch (err) {
        try {
          store?.close();
        } catch {
          // 关闭失败不阻断能力停止
        }
        this.appDataUnavailableReason = `应用数据库初始化/登记失败：${(err as Error).message}`;
        this.markAppDataUnavailable(this.appDataUnavailableReason);
      }
      return;
    }
    if (!fs.existsSync(file)) {
      this.appDataUnavailableReason = "应用数据库已登记但文件丢失：保留未知效果，能力停止（不自动创建空库）";
      this.markAppDataUnavailable(this.appDataUnavailableReason);
      return;
    }
    try {
      const store = new AppDataStore(file);
      const instanceId = store.getInstanceId();
      if (instanceId !== registered) {
        try {
          store.close();
        } catch {
          // 关闭失败不阻断能力停止
        }
        this.appDataUnavailableReason = "应用数据库实例标识与登记不符：保留未知效果，能力停止（不覆盖既有实例绑定）";
        this.markAppDataUnavailable(this.appDataUnavailableReason);
        return;
      }
      this.appDataStore = store;
      this.appDataUnavailableReason = null;
    } catch (err) {
      this.appDataUnavailableReason = `应用数据库不可用（${err instanceof AppDataError ? err.code : "open_failed"}）：${(err as Error).message}`;
      this.markAppDataUnavailable(this.appDataUnavailableReason);
    }
  }

  private markAppDataUnavailable(reason: string): void {
    this.appDataStore = null;
    try {
      this.store.withTx(() => {
        this.store.appendEvent({ type: "app_data.unavailable", reason });
      });
    } catch {
      // 启动早期事件落盘失败不阻断后台启动；能力保持停止
    }
  }

  /** main 应用数据能力的当前状态（Driver 装配与恢复判定共用）。 */
  appDataStatus(): { available: boolean; reason: string | null } {
    return { available: this.appDataStore !== null, reason: this.appDataUnavailableReason };
  }

  /** 按宿主操作 ID 核实应用库提交状态（工具操作账本的应用数据族核实；单例连接）。 */
  private appDataWriteVerdict(hostOpId: string): "committed" | "not_committed" | "unverifiable" {
    if (!this.appDataStore) return "unverifiable";
    try {
      return this.appDataStore.getReceipt(hostOpId) ? "committed" : "not_committed";
    } catch {
      return "unverifiable";
    }
  }

  // ---------- 恢复 ----------

  private recover(): void {
    // 恢复是一次逻辑事务：任务中断、确认失效、占用事实、队列暂停与恢复
    // 事件要么全部提交，要么整体回滚，不留半恢复状态
    this.store.withTx(() => {
      const store = this.store;
      const interruptedTaskIds: string[] = [];
      const pausedSessionIds: string[] = [];

      // 1. 结果缺失的工具操作按工具操作账本的分类器补记（架构工单 05）：覆盖全部
      //    任务（含终态：核心结果写入失败窗口、驱动器缺失的中断路径）。无写入效果
      //    与审批未消费记已知结论；工具族先按宿主操作 ID 核实（ADR 0009 §7）；其余
      //    结果缺失且可能已产生外部效果 → effect_unknown，不重放。
      //    未完成执行 → interrupted。
      this.ledger.settleAll();
      for (const task of store.listTasksByStatus(["running", "awaiting_confirmation"])) {
        const changed = store.transitionTask(task.id, ["running", "awaiting_confirmation"], "interrupted", {
          interruptReason: "backend_restart",
          endedAt: new Date().toISOString(),
        });
        if (changed) {
          store.stalePendingConfirmations(task.id);
          store.appendEvent(
            {
              type: "task.interrupted",
              taskId: task.id,
              sessionId: task.sessionId,
              reason: "backend_restart",
              cancelRequested: task.cancelRequested,
              // 补记之后读取的任务标记（含本次新标与此前运行时已标），与停止路径同一口径
              effectUnknown: task.effectUnknown,
            },
            { taskId: task.id, sessionId: task.sessionId },
          );
          interruptedTaskIds.push(task.id);
        }
      }

      // 2. 遗留占用：旧后台已死但其子进程状态无法确认 → 保留占用，暂停会话，
      //    由拥有者核实后 resume_queue 释放（systemd KillMode=control-group 下
      //    子进程随服务终止，正常部署不会出现）。
      for (const occ of store.listAllOccupancy()) {
        store.appendEvent(
          { type: "occupancy.stale", sessionId: occ.sessionId, taskId: occ.taskId, cwdReal: occ.cwdReal },
          { sessionId: occ.sessionId, taskId: occ.taskId },
        );
        const session = store.getSession(occ.sessionId);
        if (session && session.queueState === "active") {
          store.setSessionQueueState(occ.sessionId, "paused", "occupancy_unverified");
          store.appendEvent(
            { type: "session.queue_paused", sessionId: occ.sessionId, reason: "occupancy_unverified" },
            { sessionId: occ.sessionId },
          );
          pausedSessionIds.push(occ.sessionId);
        }
      }

      // 3. 有排队任务的会话暂停自动调度，等待拥有者显式恢复
      for (const session of store.listSessions()) {
        const queued = store.listQueuedTasksFifo(session.id);
        if (queued.length > 0 && session.queueState === "active") {
          store.setSessionQueueState(session.id, "paused", "backend_restart");
          store.appendEvent(
            { type: "session.queue_paused", sessionId: session.id, reason: "backend_restart" },
            { sessionId: session.id },
          );
          pausedSessionIds.push(session.id);
        }
      }

      // 4. 修复会话与 JSONL 的对应关系：登记的文件缺失而同 pi session id 的
      //    文件存在（崩溃发生在路径回填前后窗口）时，采用最新一份，保证重启
      //    后继续写入同一份权威历史，而不是另起新文件。
      const sessionsDir = sessionsDirFor(this.config.dataDir);
      for (const session of store.listSessions()) {
        const recorded = session.sessionFile;
        const recordedOk = recorded !== null && fs.existsSync(recorded);
        if (recordedOk) continue;
        const candidates = fs
          .readdirSync(sessionsDir)
          .filter((f) => f.endsWith(`_${session.piSessionId}.jsonl`))
          .sort();
        const latest = candidates.at(-1);
        if (latest) {
          const found = path.join(sessionsDir, latest);
          store.setSessionFile(session.id, found);
          if (recorded !== null) {
            store.appendEvent(
              {
                type: "session.history_unreadable",
                sessionId: session.id,
                sessionFile: recorded,
                error: `登记的会话文件缺失，已改用同 session id 的 ${latest}`,
              },
              { sessionId: session.id },
            );
          }
        } else if (recorded !== null) {
          store.appendEvent(
            {
              type: "session.history_unreadable",
              sessionId: session.id,
              sessionFile: recorded,
              error: "登记的会话文件缺失且未找到同 session id 的历史文件",
            },
            { sessionId: session.id },
          );
        }
      }

      store.appendEvent(
        { type: "backend.recovered", interruptedTaskIds, pausedSessionIds },
      );
    });
  }

  // ---------- 项目与会话 ----------

  createProject(name: string, createRequestId?: string): Project {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    if (!name.trim()) throw new RuntimeApiError("invalid_params", "项目名不能为空");
    try {
      // 重名与幂等键去重都在存储层同一事务内判定（issue 21）
      return this.store.withTx(() => this.store.createProject(name, createRequestId));
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
  }

  async createSession(input: {
    /** 目标项目；自动建项目时留空并传 projectName。 */
    projectId?: string;
    /** 自动创建项目（issue 21 工作区入口）：先校验目录再同事务建项目与会话，失败不留空项目。 */
    projectName?: string;
    cwd: string;
    confirmTools?: string[];
    /** 入口类别（默认 dev；qq_group 仅由 QQ 适配器经窄接口创建）。 */
    kind?: SessionKind;
    /** 创建幂等键（issue 21）：同键同参返回已存在会话，同键异参报 request_conflict。 */
    createRequestId?: string;
  }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    if (!input.projectId && !input.projectName?.trim()) {
      throw new RuntimeApiError("invalid_params", "project_id 或 project_name 必填其一");
    }
    if (input.projectId) {
      const project = this.store.getProject(input.projectId);
      if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    }
    const identity = await resolveDirIdentity(input.cwd).catch((err: DirIdentityError) =>
      Promise.reject(new RuntimeApiError("invalid_params", err.message)),
    );
    // 工作区不得是保护根（后台数据、凭据、控制面、服务代码）本身、其子级或其祖先
    try {
      assertGrantNotProtected(identity.cwdReal, this.protectedRoots());
    } catch (err) {
      throw new RuntimeApiError("invalid_params", `工作区不可用：${(err as Error).message}`);
    }
    try {
      return this.store.withTx(() => {
        // 目录校验先于任何写入；项目与会话同一事务，会话失败则项目一并回滚
        const projectId = input.projectId ?? this.store.createProject(input.projectName!.trim(), input.createRequestId).id;
        return this.store.createSession({
          projectId,
          kind: input.kind ?? "dev",
          cwd: identity.cwd,
          cwdReal: identity.cwdReal,
          cwdDev: identity.dev,
          cwdIno: identity.ino,
          piSessionId: randomUUID(),
          confirmTools: input.confirmTools ?? [],
          createRequestId: input.createRequestId,
          modelSelection: this.defaultSelection,
        });
      });
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
  }

  async listModels(input: { provider?: string; offset?: number; limit?: number } = {}) {
    return this.modelCatalog.list(input);
  }

  getSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", "会话不存在");
    return session;
  }

  listSessionSummaries(projectId: string) {
    if (!this.store.getProject(projectId)) throw new RuntimeApiError("not_found", "项目不存在");
    return this.store.listSessionSummaries(projectId);
  }

  async setSessionModel(input: { sessionId: string; modelSelection: ModelSelection; expectedVersion: number }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    this.getSession(input.sessionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new RuntimeApiError("invalid_params", "expected_version 必须为非负整数");
    const selection = parseModelSelection(input.modelSelection);
    // 配置应用期间不得为受影响 provider 钉入新引用（与 §4 删除核实同一同步段语义）
    const check = await this.resolveSelection(selection);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    return this.store.withTx(() => {
      check();
      return this.store.setSessionModel(input.sessionId, selection, input.expectedVersion);
    });
  }

  // ---------- 模型配置管理（issue 21 §3/§4） ----------

  /** 应用门闩检查：受影响 provider 的新任务在配置应用期间拒绝进入。 */
  private assertModelConfigIdle(provider: string): void {
    if (this.modelConfigGate?.has(provider)) {
      throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
    }
  }

  /**
   * 按当前目录核实模型选择。返回的 check 须在写入的同一同步段调用：resolve
   * 的 await 期间门闩生效，或一次应用已整体完成（目录被重建，如 provider 已
   * 删除且引用核实已通过）时拒绝，不让新引用钻过 §4 的删除/应用边界。
   */
  private async resolveSelection(selection: ModelSelection): Promise<() => void> {
    this.assertModelConfigIdle(selection.provider);
    const catalog = this.modelCatalog;
    await catalog.resolve(selection);
    return () => {
      this.assertModelConfigIdle(selection.provider);
      if (this.modelCatalog !== catalog) throw new RuntimeApiError("model_config_busy", "模型配置刚刚更新，请重试");
    };
  }

  /** 修订核对（乐观并发）：全部写操作按调用方读取时的修订应用。 */
  private assertConfigRevision(expected: unknown): void {
    if (typeof expected !== "string" || expected.length === 0) {
      throw new RuntimeApiError("invalid_params", "expected_revision 必须是非空字符串");
    }
    if (expected !== configRevision(this.config.agentDir)) {
      throw new RuntimeApiError("config_conflict", "模型配置已被其他修改更新，请重新加载后重试");
    }
  }

  /** 秘密脱敏：配置文件当前含有的任何秘密（API key、headers 值）不得出现在错误文本里。 */
  private scrubSecrets(text: string): string {
    let out = text;
    for (const secret of configSecrets(this.config.agentDir)) out = out.split(secret).join("***");
    return out;
  }

  /**
   * 模型配置应用（issue 21 §4）：单-flight 门闩 → 受影响活动任务核查 →
   * 快照旧字节 → 写文件 → 重建模型栈。门闩设置与任务核查之间无 await
   * （单线程原子性），核查期间新的受影响任务无法进入执行或队列；
   * 任何失败恢复旧字节并重建旧模型栈——不先改文件、不部分应用、
   * 不自动取消任务。
   */
  private async applyModelConfigChange(affected: string[], fn: () => Promise<void>): Promise<void> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    if (this.modelConfigGate) throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
    this.modelConfigGate = new Set(affected);
    const blocked = this.store.countActiveTasksByProviders(affected);
    if (blocked > 0) {
      this.modelConfigGate = null;
      throw new RuntimeApiError(
        "model_config_blocked",
        `有 ${blocked} 个任务正在使用受影响的提供方（运行中/等待确认/排队），请先完成或取消这些任务`,
      );
    }
    let settle!: () => void;
    this.modelConfigSettled = new Promise<void>((resolve) => (settle = resolve));
    const snapshot = snapshotConfigFiles(this.config.agentDir);
    try {
      await fn();
      await this.rebuildModelStack();
    } catch (err) {
      // 先按失败时的文件（含新写入的秘密）脱敏，再回滚
      if (err instanceof Error) err.message = this.scrubSecrets(err.message);
      // 回滚：恢复旧字节并重建旧模型栈，重启后也不会静默选用部分新配置
      restoreConfigFiles(this.config.agentDir, snapshot);
      await this.rebuildModelStack().catch(() => {});
      throw err;
    } finally {
      this.modelConfigGate = null;
      settle();
    }
  }

  /**
   * 重建模型栈并传播到所有存活 Driver：新 ModelRuntime → 目录 → 审查器。
   * SDK 组合失败的 provider 会被静默丢弃，这里按 models.json 声明逐模型
   * 核实可解析，失败即抛错（由调用方回滚）。默认模型按当前配置重新解析，
   * 只影响新建会话；既有会话钉住的模型选择不被改写。存活 SDK 会话闭包
   * 持有旧 ModelRuntime，由 Driver 标记后在下一任务开始前丢弃重建。
   */
  private async rebuildModelStack(): Promise<void> {
    const agentDir = this.config.agentDir;
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    const catalogFile = loadModelCatalogFile(agentDir);
    for (const [providerId, def] of Object.entries(catalogFile.providers)) {
      for (const definition of ((def?.models as Array<{ id?: unknown }> | undefined) ?? [])) {
        if (typeof definition?.id === "string" && !modelRuntime.getModel(providerId, definition.id)) {
          throw new RuntimeApiError(
            "model_config_invalid",
            `provider ${providerId} 的模型 ${definition.id} 未通过 SDK 校验（检查 api/baseUrl 等协议字段）`,
          );
        }
      }
    }
    const configured = resolveConfiguredModel(modelRuntime, this.config);
    if (!configured) {
      throw new RuntimeApiError("no_model", "应用该配置后将没有可用模型，已回滚");
    }
    const modelCatalog = await createModelCatalog(modelRuntime, agentDir, configured.model);
    await modelCatalog.resolve({ provider: configured.model.provider, modelId: configured.model.id, thinkingLevel: configured.thinkingLevel });
    const reviewer = createApprovalReviewer({
      modelRuntime,
      modelCatalog,
      timeoutMs: this.config.autoReview?.timeoutMs,
      maxTokens: this.config.autoReview?.maxTokens,
    });
    this.modelRuntime = modelRuntime;
    this.modelCatalog = modelCatalog;
    this.reviewer = reviewer;
    this.model = configured.model;
    this.defaultSelection = { provider: configured.model.provider, modelId: configured.model.id, thinkingLevel: configured.thinkingLevel };
    for (const driver of this.drivers.values()) {
      driver.updateModelDeps({ modelRuntime, modelCatalog, model: configured.model, reviewer });
    }
  }

  /** 模型配置视图（脱敏）：目录中 apiKey 以 true 代替，凭据只报是否配置与类型。 */
  getModelConfig(): {
    revision: string;
    providers: Record<string, any>;
    credentials: Record<string, { configured: boolean; type?: string }>;
    defaultModel: ModelSelection | null;
    summaryModel: SummaryModel | null;
    runtimeDefault: ModelSelection;
    busyProviders: string[];
  } {
    const agentDir = this.config.agentDir;
    const credentials: Record<string, { configured: boolean; type?: string }> = {};
    for (const [provider, entry] of Object.entries(loadAuthFile(agentDir))) {
      credentials[provider] = { configured: true, type: typeof entry?.type === "string" ? entry.type : undefined };
    }
    let defaultModel: ModelSelection | null = null;
    try {
      defaultModel = loadDefaultModel(agentDir);
    } catch {
      // 损坏的默认配置文件不阻塞配置视图（修订指纹仍覆盖它，保存可修复）
    }
    return {
      revision: configRevision(agentDir),
      providers: sanitizeCatalog(loadModelCatalogFile(agentDir).providers),
      credentials,
      defaultModel,
      summaryModel: this.readSummaryModel(),
      runtimeDefault: this.defaultSelection,
      busyProviders: this.modelConfigGate ? [...this.modelConfigGate] : [],
    };
  }

  /** 摘要模型配置（损坏按未设置展示；修订指纹仍覆盖它，保存可修复）。 */
  private readSummaryModel(): SummaryModel | null {
    try {
      return loadSummaryModel(this.config.agentDir);
    } catch {
      return null;
    }
  }

  /** 删除 provider/模型前核实引用（§4）：被持久默认、摘要模型、会话或逻辑角色引用时拒绝，先提供替代项。 */
  private assertSelectionNotReferenced(provider: string, modelId?: string): void {
    let defaultModel: ModelSelection | null = null;
    try {
      defaultModel = loadDefaultModel(this.config.agentDir);
    } catch {
      // 损坏的默认配置文件不可能构成有效引用，按未配置处理
    }
    const summaryModel = this.readSummaryModel();
    const refs = this.store.countProviderReferences(provider, modelId);
    const usedByDefault = defaultModel?.provider === provider && (modelId === undefined || defaultModel.modelId === modelId);
    const usedBySummary = summaryModel?.provider === provider && (modelId === undefined || summaryModel.modelId === modelId);
    if (usedByDefault || usedBySummary || refs.sessions > 0 || refs.roles > 0) {
      const target = modelId === undefined ? `提供方 ${provider}` : `模型 ${provider}/${modelId}`;
      const parts: string[] = [];
      if (usedByDefault) parts.push("后台默认模型");
      if (usedBySummary) parts.push("摘要模型");
      if (refs.sessions > 0) parts.push(`${refs.sessions} 个会话`);
      if (refs.roles > 0) parts.push(`${refs.roles} 个逻辑角色`);
      throw new RuntimeApiError("provider_in_use", `${target} 仍被引用（${parts.join("、")}），请先切换这些引用到其他可用项`);
    }
  }

  /** 保存模型目录：修订核对 → 结构校验 → 删除项引用核实 → 受影响 provider（修改/删除）受门闩应用。 */
  async saveModelCatalog(input: { providers: unknown; expectedRevision: unknown }): Promise<{ revision: string }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    this.assertConfigRevision(input.expectedRevision);
    const before = loadModelCatalogFile(this.config.agentDir).providers;
    // 脱敏视图原样回写：占位符还原为原值，未改动的秘密不必重新输入
    const providers = restoreCatalogSecrets(input.providers, before);
    const errors = validateModelCatalog({ providers });
    if (errors.length > 0) {
      throw new RuntimeApiError("invalid_params", `模型目录结构无效：${errors.join("；")}`);
    }
    const next = { providers: providers as Record<string, any> };
    // 受影响 = 被修改或删除的 provider；新增的 provider 不影响任何运行中任务
    const affected = Object.keys(before).filter(
      (id) => !(id in next.providers) || !isDeepStrictEqual(before[id], next.providers[id]),
    );
    // 经目录保存删除 provider/模型与 remove_model_provider 同一约束（§4），不留悬空引用
    for (const id of Object.keys(before)) {
      if (!(id in next.providers)) {
        this.assertSelectionNotReferenced(id);
        continue;
      }
      const oldModels = new Set((((before[id]?.models as Array<{ id?: unknown }> | undefined) ?? [])).map((m) => m?.id).filter((v): v is string => typeof v === "string"));
      const newModels = new Set((((next.providers[id]?.models as Array<{ id?: unknown }> | undefined) ?? [])).map((m) => m?.id).filter((v): v is string => typeof v === "string"));
      for (const modelId of oldModels) {
        if (!newModels.has(modelId)) this.assertSelectionNotReferenced(id, modelId);
      }
    }
    await this.applyModelConfigChange(affected, async () => {
      saveModelCatalogFile(this.config.agentDir, next);
    });
    this.store.withTx(() => this.store.appendEvent({ type: "model.config_changed", kind: "catalog" }));
    return { revision: configRevision(this.config.agentDir) };
  }

  async setModelApiKey(input: { provider: unknown; apiKey: unknown; expectedRevision: unknown }): Promise<{ revision: string; configured: boolean }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const provider = typeof input.provider === "string" ? input.provider.trim() : "";
    if (!provider) throw new RuntimeApiError("invalid_params", "provider 必须是非空字符串");
    const invalid = validateApiKey(input.apiKey);
    if (invalid) throw new RuntimeApiError("invalid_params", invalid);
    this.assertConfigRevision(input.expectedRevision);
    await this.applyModelConfigChange([provider], async () => {
      setProviderApiKey(this.config.agentDir, provider, input.apiKey as string);
    });
    this.store.withTx(() => this.store.appendEvent({ type: "model.config_changed", kind: "api_key", provider }));
    return { revision: configRevision(this.config.agentDir), configured: true };
  }

  async removeModelApiKey(input: { provider: unknown; expectedRevision: unknown }): Promise<{ revision: string; configured: boolean }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const provider = typeof input.provider === "string" ? input.provider.trim() : "";
    if (!provider) throw new RuntimeApiError("invalid_params", "provider 必须是非空字符串");
    this.assertConfigRevision(input.expectedRevision);
    await this.applyModelConfigChange([provider], async () => {
      removeProviderCredential(this.config.agentDir, provider);
    });
    this.store.withTx(() => this.store.appendEvent({ type: "model.config_changed", kind: "api_key", provider }));
    return { revision: configRevision(this.config.agentDir), configured: false };
  }

  /**
   * 删除 provider：被持久默认模型、任何会话或逻辑角色引用时拒绝
   * （provider_in_use）；否则从 models.json 与 auth.json 一并移除。
   */
  async removeModelProvider(input: { provider: unknown; expectedRevision: unknown }): Promise<{ revision: string }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const provider = typeof input.provider === "string" ? input.provider.trim() : "";
    if (!provider) throw new RuntimeApiError("invalid_params", "provider 必须是非空字符串");
    this.assertConfigRevision(input.expectedRevision);
    this.assertSelectionNotReferenced(provider);
    await this.applyModelConfigChange([provider], async () => {
      const catalog = loadModelCatalogFile(this.config.agentDir);
      if (provider in catalog.providers) {
        delete catalog.providers[provider];
        saveModelCatalogFile(this.config.agentDir, catalog);
      }
      removeProviderCredential(this.config.agentDir, provider);
    });
    this.store.withTx(() => this.store.appendEvent({ type: "model.config_changed", kind: "catalog", provider }));
    return { revision: configRevision(this.config.agentDir) };
  }

  /**
   * 设置后台默认模型（持久化到 default-model.json）：只影响之后新建的
   * 会话；既有会话钉住的选择不改写，任务不需要应用门闩。显式启动参数
   * （--model）优先于持久默认。
   */
  async setDefaultModel(input: { provider: unknown; modelId: unknown; thinkingLevel: unknown; expectedRevision: unknown }): Promise<{ revision: string; defaultModel: ModelSelection }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const selection = parseModelSelection({ provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel });
    // 必须能在当前目录中解析（成员 + 思考档位），否则新会话将拿到不可用默认
    const option = await this.catalogOption(selection.provider, selection.modelId);
    if (!option.thinkingLevels.includes(selection.thinkingLevel)) {
      throw new RuntimeApiError("invalid_params", `该模型不支持思考档位 ${selection.thinkingLevel}`);
    }
    // 门闩检查、修订核对与文件写入在同一同步段：并发保存只会有一方通过修订核对
    if (this.modelConfigGate) throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
    this.assertConfigRevision(input.expectedRevision);
    saveDefaultModel(this.config.agentDir, selection);
    // 与启动/重建同一解析口径：显式 --model/--thinking 运行期间持久默认只落盘，不改运行时默认
    const configured = resolveConfiguredModel(this.modelRuntime, this.config);
    if (configured) {
      this.model = configured.model;
      this.defaultSelection = { provider: configured.model.provider, modelId: configured.model.id, thinkingLevel: configured.thinkingLevel };
    }
    this.store.withTx(() => this.store.appendEvent({ type: "model.config_changed", kind: "default_model", provider: selection.provider }));
    return { revision: configRevision(this.config.agentDir), defaultModel: selection };
  }

  /** 模型必须在当前目录中（setDefaultModel 与 setSummaryModel 共用的核对）。 */
  private async catalogOption(provider: string, modelId: string): Promise<ModelOption> {
    let offset = 0;
    for (;;) {
      const page = await this.modelCatalog.list({ provider, offset, limit: 100 });
      const option = page.models.find((m) => m.provider === provider && m.modelId === modelId);
      if (option) return option;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    throw new RuntimeApiError("invalid_params", `模型不在后台已配置的目录中：${provider}/${modelId}`);
  }

  /**
   * 设置或清除上下文压缩的摘要模型（issue 30 §8，持久化到 summary-model.json）。
   * 每次摘要读取当前配置，不按任务钉版，不需要应用门闩；provider 与 modelId 都为 null 即清除。
   */
  async setSummaryModel(input: { provider: unknown; modelId: unknown; expectedRevision: unknown }): Promise<{ revision: string; summaryModel: SummaryModel | null }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    let model: SummaryModel | null = null;
    if (input.provider !== null || input.modelId !== null) {
      if (typeof input.provider !== "string" || !input.provider.trim() || typeof input.modelId !== "string" || !input.modelId.trim()) {
        throw new RuntimeApiError("invalid_params", "provider 与 model_id 必须同为非空字符串，或同为 null（清除）");
      }
      await this.catalogOption(input.provider, input.modelId);
      model = { provider: input.provider, modelId: input.modelId };
    }
    if (this.modelConfigGate) throw new RuntimeApiError("model_config_busy", "模型配置正在应用，请稍后重试");
    this.assertConfigRevision(input.expectedRevision);
    saveSummaryModel(this.config.agentDir, model);
    this.store.withTx(() => this.store.appendEvent({ type: "model.config_changed", kind: "summary_model", provider: model?.provider }));
    return { revision: configRevision(this.config.agentDir), summaryModel: model };
  }

  /**
   * 显式连通性探测（30s 超时）：经当前目录解析模型后发一个 1-token 请求。
   * 这是唯一的联网核实入口；本地校验不暗示模型服务可用。
   */
  async testModelConnection(input: { provider: unknown; modelId: unknown }): Promise<{ ok: boolean; detail: string }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const provider = typeof input.provider === "string" ? input.provider.trim() : "";
    const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
    if (!provider || !modelId) throw new RuntimeApiError("invalid_params", "provider 与 model_id 必须是非空字符串");
    let model: any;
    try {
      model = await this.modelCatalog.resolve({ provider, modelId, thinkingLevel: "off" });
    } catch (err) {
      return { ok: false, detail: this.scrubSecrets((err as Error).message) };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let failure: string;
    try {
      const reply = await this.modelRuntime.completeSimple(
        model,
        { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
        { maxTokens: 1, signal: controller.signal },
      );
      // completeSimple 不以 reject 报错：鉴权/HTTP/中止都以 stopReason 返回
      if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return { ok: true, detail: `连接成功：${provider}/${modelId}` };
      failure = reply.errorMessage ?? "连接失败";
    } catch (err) {
      failure = (err as Error).message;
    } finally {
      clearTimeout(timer);
    }
    return { ok: false, detail: this.scrubSecrets(controller.signal.aborted ? "连接超时（30 秒）" : failure) };
  }

  // ---------- 提交与排队 ----------

  /**
   * 校验拥有者为任务显式授予的工作区外路径：必须存在，且不得是保护根
   * （后台数据、凭据、控制面、服务代码）本身、其子级或其祖先。
   */
  private validateGrantedPaths(paths: GrantedPath[]): GrantedPath[] {
    const resolved: GrantedPath[] = [];
    for (const p of paths) {
      if (!p.path.trim()) throw new RuntimeApiError("invalid_params", "授予路径不能为空");
      if (p.access !== "read" && p.access !== "read_write") {
        throw new RuntimeApiError("invalid_params", `授予路径访问级别无效：${p.access}`);
      }
      let real: string;
      try {
        real = fs.realpathSync(p.path);
      } catch {
        throw new RuntimeApiError("invalid_params", `授予路径不存在：${p.path}`);
      }
      try {
        assertGrantNotProtected(real, this.protectedRoots());
      } catch (err) {
        throw new RuntimeApiError("invalid_params", (err as Error).message);
      }
      resolved.push({ path: real, access: p.access, purpose: p.purpose || "未说明" });
    }
    return resolved;
  }

  /**
   * worktree 的共享 Git 元数据在工作区之外：授予路径覆盖它时在用途中展示
   * 共享影响（不自动挂载主仓库或父目录——只有拥有者显式给出的路径进入边界）。
   */
  private annotateSharedGitMetadata(cwdReal: string, granted: GrantedPath[]): GrantedPath[] {
    const commonGitDir = resolveWorktreeCommonGitDir(cwdReal);
    if (!commonGitDir) return granted;
    return granted.map((p) =>
      grantCoversPath(p.path, commonGitDir) && !p.purpose.includes("共享 Git 元数据")
        ? { ...p, purpose: `${p.purpose}（共享 Git 元数据：${commonGitDir}）` }
        : p,
    );
  }

  async submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode?: AccessMode;
    grantedPaths?: GrantedPath[];
    resumesTaskId?: string;
    modelSelection: ModelSelection;
    /**
     * 编排字段（issue 01）：仅后台编排器经窄接口传递（子任务/事件任务/唤醒）。
     * 控制面 ops 不接受这些字段，模型与客户端无法设置。
     */
    agentId?: AgentRoleId | null;
    parentTaskId?: string | null;
    sourceEventId?: string | null;
    deadline?: string | null;
  }): Promise<Task> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    if (!input.input.trim()) throw new RuntimeApiError("invalid_params", "输入不能为空");
    // 计划模式（issue 26）只限普通开发会话：角色会话各有固定职责与工具
    if (isPlanInput(input.input) && (session.kind !== "dev" || this.store.getAgentRoleBySession(session.id))) {
      throw new RuntimeApiError("invalid_params", "计划模式（/plan）只能在普通开发会话中使用");
    }
    if (input.agentId != null && !AGENT_ROLE_IDS.includes(input.agentId)) {
      throw new RuntimeApiError("invalid_params", `逻辑角色无效：${input.agentId}`);
    }
    // 截止时间入库前统一为 UTC ISO 表示：不同偏移/写法表示同一时刻时幂等
    // 摘要一致，超时巡检的字符串比较即时间比较
    let deadline: string | null = null;
    if (input.deadline != null) {
      deadline = normalizeIsoInstant(input.deadline);
      if (deadline === null) throw new RuntimeApiError("invalid_params", `截止时间无效：${input.deadline}`);
    }
    // 未显式指定时固定为提交瞬间的会话默认模式（issue 12）；幂等摘要据此计算，
    // 默认值之后的变更不会漂移已接收任务。
    const accessMode = input.accessMode ?? session.defaultAccessMode;
    if (!isAccessMode(accessMode)) {
      throw new RuntimeApiError("invalid_params", `访问模式无效：${accessMode}`);
    }
    const selection = parseModelSelection(input.modelSelection);
    // 摘要键序固定（v11 前的旧算法为前五个键）：旧格式摘要据同一对象核对
    const digestBase = {
      input: input.input, accessMode,
      grantedPaths: (input.grantedPaths ?? []).map(p => ({ path: p.path, access: p.access, purpose: p.purpose || "未说明" })),
      resumesTaskId: input.resumesTaskId ?? null, modelSelection: selection,
    };
    const submissionDigest = createHash("sha256").update(JSON.stringify({
      ...digestBase,
      agentId: input.agentId ?? null, parentTaskId: input.parentTaskId ?? null,
      sourceEventId: input.sourceEventId ?? null, deadline,
    })).digest("hex");
    // 升级兼容（schema v11 引入编排字段前的已接收请求）：编排字段全空的提交
    // 附带旧格式摘要，同参重试仍可核实；编排字段非空时不提供旧格式，同键异参
    // 校验不放宽
    const legacyDigest =
      (input.agentId ?? null) === null && (input.parentTaskId ?? null) === null &&
      (input.sourceEventId ?? null) === null && deadline === null
        ? createHash("sha256").update(JSON.stringify(digestBase)).digest("hex")
        : undefined;
    const existing = this.store.findMatchingSubmission({ sessionId: input.sessionId, requestId: input.requestId, submissionDigest, legacyDigest });
    if (existing) return existing;
    // 模型配置应用门闩（issue 21 §4）：幂等重试放行（不新建任务），
    // 受影响 provider 的新提交在应用期间拒绝进入队列；continueTask 经
    // this.submit 走同一检查
    const check = await this.resolveSelection(selection);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    // 所选模式的执行入口必须可用（缺少后端/身份配置时明确失败，不回退）
    try {
      this.launcherFor(accessMode);
    } catch (err) {
      const code = err instanceof ExecutionError ? err.code : "execution_unavailable";
      throw new RuntimeApiError(code, `${accessMode} 模式的执行入口不可用：${(err as Error).message}`);
    }
    const grantedPaths = this.annotateSharedGitMetadata(
      session.cwdReal,
      this.validateGrantedPaths(input.grantedPaths ?? []),
    );

    let task: Task;
    let duplicate: boolean;
    try {
      ({ task, duplicate } = this.store.withTx(() => {
        // 门闩重检必须在入队事务内（issue 21 §4）：应用方的门闩设置与活动
        // 任务核查是同一同步段，这里在插入前重检才能保证"检查到应用完成
        // 之间"没有受影响任务钻过边界；重复提交先仲裁返回，不受门闩影响
        const raced = this.store.findMatchingSubmission({ sessionId: input.sessionId, requestId: input.requestId, submissionDigest, legacyDigest });
        if (raced) return { task: raced, duplicate: true };
        check();
        return this.store.insertQueuedTask({
          sessionId: input.sessionId,
          requestId: input.requestId,
          input: input.input,
          accessMode,
          grantedPaths,
          resumesTaskId: input.resumesTaskId,
          modelSelection: selection,
          submissionDigest,
          legacyDigest,
          agentId: input.agentId ?? null,
          parentTaskId: input.parentTaskId ?? null,
          sourceEventId: input.sourceEventId ?? null,
          deadline,
        });
      }));
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
    if (!duplicate) this.kick(input.sessionId);
    return task;
  }

  /**
   * 后台内部提交（编排器唤醒/委派、入站事件、QQ）：遇配置应用门闩等本次应用
   * 结束后按同一请求键重试——这些调用方没有人会手动重试，失败会滞留到重启。
   */
  private async submitInternal(input: Parameters<Runtime["submit"]>[0]): Promise<Task> {
    for (;;) {
      try {
        return await this.submit(input);
      } catch (err) {
        if (!(err instanceof RuntimeApiError) || err.code !== "model_config_busy") throw err;
        await this.modelConfigSettled;
      }
    }
  }

  /**
   * 中断任务的人工继续：新任务带 resumes_task_id；不自动重放任何执行。
   * 新任务沿用会话默认模式（提交时可显式覆盖）；旧批准不继承。
   */
  async continueTask(input: { taskId: string; sessionId?: string; requestId: string; input: string; accessMode?: AccessMode; grantedPaths?: GrantedPath[]; modelSelection: ModelSelection }): Promise<Task> {
    const old = this.store.getTask(input.taskId);
    if (!old) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    if (input.sessionId !== undefined && input.sessionId !== old.sessionId) throw new RuntimeApiError("invalid_params", "源任务不属于指定会话");
    if (old.status !== "interrupted") {
      throw new RuntimeApiError("invalid_state", `只能继续已中断的任务，当前状态 ${old.status}`);
    }
    return this.submit({
      sessionId: old.sessionId,
      requestId: input.requestId,
      input: input.input,
      accessMode: input.accessMode,
      grantedPaths: input.grantedPaths,
      resumesTaskId: old.id,
      modelSelection: input.modelSelection,
    });
  }

  /**
   * 拥有者设置会话默认访问模式（issue 12）：只影响之后新建且未显式指定
   * 模式的任务；不改写既有任务、待生效模式或待处理审批。
   */
  async setSessionDefaultMode(input: { sessionId: string; mode: AccessMode; expectedVersion: number }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    this.getSession(input.sessionId);
    if (!isAccessMode(input.mode)) {
      throw new RuntimeApiError("invalid_params", `会话默认模式无效：${input.mode}（${SESSION_DEFAULT_MODES.join(" | ")}）`);
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new RuntimeApiError("invalid_params", "expected_version 必须为非负整数");
    try {
      return this.store.withTx(() => this.store.setSessionDefaultMode(input.sessionId, input.mode, input.expectedVersion));
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  /**
   * 拥有者显式切换任务访问模式（完全访问只能由此入口或提交参数选择）。
   * - queued/awaiting_confirmation（无执行中工具）：立即应用——停止并核实
   *   旧执行单元退出后落库；awaiting 的等待审批一并失效；
   * - running（工具执行中）：登记待生效模式，在下一个工具边界应用；
   *   执行中的调用继续使用开始时的范围；需要立即停止请用中断。
   */
  async switchTaskMode(input: { taskId: string; mode: AccessMode; grantedPaths?: GrantedPath[] }): Promise<Task> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝模式切换");
    const task = this.store.getTask(input.taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    if (!isAccessMode(input.mode)) {
      throw new RuntimeApiError("invalid_params", `访问模式无效：${input.mode}`);
    }
    if (task.accessMode === input.mode && !input.grantedPaths) {
      throw new RuntimeApiError("invalid_state", `任务已是 ${input.mode} 模式`);
    }
    // 目标模式的执行入口必须可用（明确失败，不回退）
    try {
      this.launcherFor(input.mode);
    } catch (err) {
      const code = err instanceof ExecutionError ? err.code : "execution_unavailable";
      throw new RuntimeApiError(code, `目标模式的执行入口不可用：${(err as Error).message}`);
    }
    if (input.grantedPaths) {
      this.validateGrantedPaths(input.grantedPaths);
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new RuntimeApiError("invalid_state", `任务已结束（${task.status}），不能切换模式`);
    }
    if (task.status === "queued" || task.status === "awaiting_confirmation") {
      // 无执行中工具的边界：立即应用
      const driver = this.drivers.get(task.sessionId);
      const reaped = driver ? await driver.router.stopWorker() : true;
      if (!reaped) {
        // 无法核实旧执行单元退出：任务中断、占用保留（不可安全继续）
        this.store.withTx(() => {
          if (this.store.transitionTask(task.id, ["queued", "running", "awaiting_confirmation"], "interrupted", {
            interruptReason: "mode_switch_unverified",
            endedAt: new Date().toISOString(),
          })) {
            this.store.stalePendingConfirmations(task.id);
            this.store.appendEvent(
              { type: "task.mode_switch_failed", taskId: task.id, sessionId: task.sessionId, to: input.mode, reason: "无法核实旧执行单元已退出" },
              { taskId: task.id, sessionId: task.sessionId },
            );
          }
        });
        throw new RuntimeApiError("mode_switch_unverified", "无法核实旧执行单元已退出，任务已中断（占用保留待核实）");
      }
      this.store.withTx(() => {
        let version = task.permissionVersion;
        if (input.grantedPaths) {
          const session = this.store.getSession(task.sessionId)!;
          const annotated = this.annotateSharedGitMetadata(session.cwdReal, this.validateGrantedPaths(input.grantedPaths));
          version = this.store.updateGrantedPaths(task.id, annotated);
        }
        version = this.store.applyModeSwitch(task.id, input.mode);
        this.store.appendEvent(
          { type: "task.mode_switched", taskId: task.id, sessionId: task.sessionId, from: task.accessMode, to: input.mode, permissionVersion: version },
          { taskId: task.id, sessionId: task.sessionId },
        );
      });
      if (driver && task.status === "awaiting_confirmation") {
        driver.supersedeWaiters();
      }
      return this.store.getTask(task.id)!;
    }
    // running：登记待生效，工具边界处应用
    this.store.withTx(() => {
      if (this.store.requestModeSwitch(task.id, input.mode)) {
        this.store.appendEvent(
          { type: "task.mode_switch_requested", taskId: task.id, sessionId: task.sessionId, from: task.accessMode, to: input.mode },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
    });
    return this.store.getTask(task.id)!;
  }

  // ---------- 审批 / 产物 / 凭据 ----------

  /**
   * 拥有者查询任务产物正文（按 id、偏移、长度）。宿主依据任务归属查找，
   * 不接受任意宿主路径，不跨任务返回正文。
   */
  queryArtifact(input: { taskId: string; artifactId: string; offset?: number; length?: number }): { artifact: Artifact; encoding: "base64"; data: string } {
    const task = this.store.getTask(input.taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    const artifact = this.store.getArtifact(input.artifactId);
    if (!artifact || artifact.taskId !== input.taskId) {
      throw new RuntimeApiError("not_found", `产物不存在或不属于该任务：${input.artifactId}`);
    }
    const offset = Math.max(0, input.offset ?? 0);
    // 上限按线上帧约束：base64 膨胀 4/3 + JSON 开销必须留在 MAX_FRAME_BYTES 内
    const length = Math.min(Math.max(1, input.length ?? 256 * 1024), 720 * 1024);
    const buf = this.artifacts.read(artifact.id, offset, length);
    return { artifact, encoding: "base64", data: buf.toString("base64") };
  }

  listCredentialBindings() {
    return this.credentials.list();
  }

  addCredentialBinding(input: { name: string; host: string; header: string; purpose: string; secret: string }) {
    if (!input.name.trim() || !input.host.trim() || !input.header.trim() || !input.secret) {
      throw new RuntimeApiError("invalid_params", "凭据绑定的名称、主机、头与秘密值都不能为空");
    }
    // 同名更新保留既有使用范围（mcp 配置或历史 github bind 收紧的 scope 不因轮换令牌而丢失）
    const existing = this.credentials.get(input.name);
    let scope = existing?.scope;
    if (input.purpose === JEV_CREDENTIAL_PURPOSE) {
      const host = jevCredentialHost(this.config.jev?.baseUrl);
      if (input.host.toLowerCase() !== host || input.header.toLowerCase() !== "authorization") {
        throw new RuntimeApiError("invalid_params", `Jev 凭据须使用 host=${host} 与 authorization 头`);
      }
      if (scope?.repoId !== undefined || scope?.operations?.some((operation) => operation !== JEV_CREDENTIAL_PURPOSE) ||
          (scope?.operations !== undefined && !scope.operations.includes(JEV_CREDENTIAL_PURPOSE))) {
        throw new RuntimeApiError("invalid_params", "凭据已有其他使用范围，请为 Jev 另建凭据");
      }
      // 保存时即收紧操作范围，配置项目之前也不能被通用 http_request 借用。
      scope = { ...scope, operations: [JEV_CREDENTIAL_PURPOSE] };
    }
    this.credentials.upsert({ ...input, host: input.host.toLowerCase(), scope });
    return { name: input.name, host: input.host.toLowerCase(), header: input.header, purpose: input.purpose };
  }

  removeCredentialBinding(name: string): boolean {
    return this.credentials.remove(name);
  }

  // ---------- MCP 服务配置（issue 16 §2/§6） ----------

  /**
   * 配置/更新项目的 MCP 服务（拥有者操作）。端点生产固定 https（http 仅限
   * 回环模拟服务）；凭据按名称引用 CredentialStore 绑定（host 须与端点一致、
   * 用途须为 mcp），配置后 scope 收紧到本项目 + mcp 操作；变更采用期望版本
   * 校验，任何变化递增 configVersion（任务内调用前重读核对）。
   */
  mcpConfigure(input: {
    projectId: string;
    name: string;
    endpoint: string;
    /** 凭据绑定名；undefined = 更新时保留现有引用，null = 清除。 */
    credential?: string | null;
    /** 允许列表条目：工具名字符串（= 只读）或 { name, effect: read|write|unknown }。 */
    toolAllowlist: unknown[];
    enabled?: boolean;
    expectedVersion?: number;
  }): McpServiceConfig {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(input.name)) {
      throw new RuntimeApiError("invalid_params", `服务名必须是小写 slug（^[a-z0-9][a-z0-9_-]{0,29}$）：${input.name}`);
    }
    let endpoint: URL;
    try {
      endpoint = parseMcpEndpoint(input.endpoint);
    } catch (err) {
      throw new RuntimeApiError("invalid_params", (err as Error).message);
    }
    if (!Array.isArray(input.toolAllowlist)) {
      throw new RuntimeApiError("invalid_params", "tool_allowlist 必须是数组（工具名字符串或 { name, effect } 对象）");
    }
    const normalized = normalizeToolAllowlist(input.toolAllowlist);
    if ("error" in normalized) throw new RuntimeApiError("invalid_params", normalized.error);
    const toolAllowlist = normalized.entries;
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
      throw new RuntimeApiError("invalid_params", "expected_version 必须是非负整数");
    }
    if (input.credential) {
      const cred = this.credentials.get(input.credential);
      if (!cred) throw new RuntimeApiError("invalid_params", `凭据绑定不存在：${input.credential}`);
      if (cred.host !== endpoint.host) {
        throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 的 host（${cred.host}）与端点 host（${endpoint.host}）不一致`);
      }
      if (cred.purpose !== MCP_CREDENTIAL_PURPOSE) {
        throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 用途是 ${cred.purpose}，MCP 服务需要 purpose=${MCP_CREDENTIAL_PURPOSE} 的凭据`);
      }
      if (cred.header.toLowerCase() !== "authorization") {
        throw new RuntimeApiError("invalid_params", `MCP 凭据须使用 authorization 头（Bearer）：${input.credential}`);
      }
      // scope 兼容性先校验（写操作前）：已有 scope 冲突时拒绝，避免静默改变
      // 既有授权的边界，也避免配置已落库但凭据收紧失败的半截状态
      if (cred.scope) {
        const sameProject = cred.scope.projectId === undefined || cred.scope.projectId === input.projectId;
        const coversOp = cred.scope.operations === undefined || cred.scope.operations.includes(MCP_CREDENTIAL_PURPOSE);
        if (!sameProject || !coversOp) {
          throw new RuntimeApiError(
            "invalid_params",
            `凭据 ${input.credential} 已有使用范围（项目 ${cred.scope.projectId ?? "不限"}/操作 ${cred.scope.operations?.join(",") ?? "不限"}），与 mcp 冲突；请先调整凭据范围或另建凭据`,
          );
        }
      }
    }
    let service: McpServiceConfig;
    try {
      // 配置变更与事件同事务：状态变化不留无事件的洞（审计与 TUI 依赖事件流）
      service = this.store.withTx(() => {
        const s = this.mcp.upsertService({
          projectId: input.projectId,
          name: input.name,
          endpoint: endpoint.toString(),
          credential: input.credential,
          toolAllowlist,
          enabled: input.enabled,
          expectedVersion: input.expectedVersion,
        });
        this.store.appendEvent(
          { type: "mcp.service_changed", serviceId: s.id, projectId: s.projectId, name: s.name, endpoint: s.endpoint, configVersion: s.configVersion, action: "upsert" },
          {},
        );
        return s;
      });
    } catch (err) {
      if (err instanceof McpVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    // 凭据 scope 收紧到本项目 + mcp 操作（兼容性已在写操作前校验）：
    // 通用 http_request 与越权项目不得借用同名凭据
    if (service.credential) {
      const cred = this.credentials.get(service.credential)!;
      const ops = cred.scope?.operations;
      this.credentials.upsert({
        ...cred,
        scope: { ...cred.scope, projectId: service.projectId, operations: ops ? [...ops] : [MCP_CREDENTIAL_PURPOSE] },
      });
    }
    return service;
  }

  mcpListServices(projectId?: string): McpServiceConfig[] {
    return this.mcp.listServices(projectId);
  }

  mcpSetEnabled(serviceId: string, enabled: boolean, expectedVersion?: number): McpServiceConfig {
    let service: McpServiceConfig | null;
    try {
      service = this.mcp.setEnabled(serviceId, enabled, expectedVersion);
    } catch (err) {
      if (err instanceof McpVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    if (!service) throw new RuntimeApiError("not_found", `MCP 服务不存在：${serviceId}`);
    this.store.withTx(() => {
      this.store.appendEvent(
        { type: "mcp.service_changed", serviceId: service.id, projectId: service.projectId, name: service.name, endpoint: service.endpoint, configVersion: service.configVersion, action: enabled ? "enabled" : "disabled" },
        {},
      );
    });
    return service;
  }

  mcpRemoveService(serviceId: string): boolean {
    const service = this.mcp.getService(serviceId);
    if (!service) return false;
    return this.store.withTx(() => {
      const removed = this.mcp.removeService(serviceId);
      if (removed) {
        this.store.appendEvent(
          { type: "mcp.service_changed", serviceId, projectId: service.projectId, name: service.name, endpoint: service.endpoint, configVersion: service.configVersion + 1, action: "removed" },
          {},
        );
      }
      return removed;
    });
  }

  /**
   * 连接检查（拥有者诊断入口）：连接服务、发现工具并按当前允许列表标注
   * allowed/blocked；返回脱敏视图（端点与服务信息可见，秘密值不出现）。
   * 失败返回 ok:false 与错误说明，不抛错（区别于配置不存在）。
   */
  async mcpCheckService(serviceId: string): Promise<{
    service: McpServiceConfig;
    ok: boolean;
    serverInfo: { name?: string; version?: string } | null;
    protocolVersion: string | null;
    tools: Array<{ name: string; allowed: boolean; effect?: McpToolEffect; reason?: string }>;
    error?: string;
    errorCode?: string;
  }> {
    const service = this.mcp.getService(serviceId);
    if (!service) throw new RuntimeApiError("not_found", `MCP 服务不存在：${serviceId}`);
    let conn: McpConnection | null = null;
    try {
      conn = await connectMcpService(service, {
        credentials: this.credentials,
        projectId: service.projectId,
        connectTimeoutMs: this.config.mcp?.connectTimeoutMs,
        listTimeoutMs: this.config.mcp?.listTimeoutMs,
        callTimeoutMs: this.config.mcp?.callTimeoutMs,
      });
      const tools = await conn.listTools();
      return {
        service,
        ok: true,
        serverInfo: conn.serverInfo,
        protocolVersion: conn.protocolVersion,
        // 逐工具标注：allowed = 在允许列表且通过客户端校验；effect = 本地副作用
        // 类别（issue 18；决定是否逐次审批）；reason 说明不可注册原因
        tools: tools.map((t) => {
          const effect = allowlistEffectFor(service.toolAllowlist, t.name);
          if (effect === null) return { name: t.name, allowed: false, reason: "不在允许列表" };
          const validated = validateRemoteTool(t);
          return "disabledReason" in validated
            ? { name: t.name, allowed: false, reason: validated.disabledReason }
            : { name: t.name, allowed: true, effect, reason: undefined };
        }),
      };
    } catch (err) {
      return {
        service,
        ok: false,
        serverInfo: null,
        protocolVersion: null,
        tools: [],
        error: (err as Error).message,
        errorCode: (err as { code?: string }).code,
      };
    } finally {
      await conn?.close();
    }
  }

  // ---------- 调度 ----------

  private kick(sessionId: string): void {
    if (this.stopping) return;
    if (this.loopActive.has(sessionId)) {
      this.wakePending.add(sessionId);
      return;
    }
    this.loopActive.add(sessionId);
    const loop = this.runQueueLoop(sessionId).finally(() => {
      this.loopActive.delete(sessionId);
      this.loopPromises.delete(sessionId);
      if (this.wakePending.delete(sessionId)) this.kick(sessionId);
    });
    this.loopPromises.set(sessionId, loop);
    void loop;
  }

  /** 占用释放或队列恢复时唤醒所有会话（等待同目录的排队任务重新尝试）。 */
  private kickAll(): void {
    for (const session of this.store.listSessions()) {
      if (this.store.listQueuedTasksFifo(session.id).length > 0) this.kick(session.id);
    }
  }

  private async runQueueLoop(sessionId: string): Promise<void> {
    for (;;) {
      if (this.stopping) return;
      const session = this.store.getSession(sessionId);
      if (!session || session.queueState !== "active") return;
      const task = this.store.listQueuedTasksFifo(sessionId)[0];
      if (!task) return;

      // 私聊与 Telegram 共用 main 队列，仍按这条消息的固定配置重核，不能凭会话身份放行。
      const sourceEvent = task.sourceEventId ? this.store.getInboundEvent(task.sourceEventId) : null;
      if (sourceEvent) {
        // 群任务须先原子关联收件、入站与任务，避免提交后的立即 kick 抢先执行。
        if (sourceEvent.source === QQ_GROUP_SOURCE && sourceEvent.taskId !== task.id) return;
        const decision = this.inboundGate(sourceEvent);
        if (decision === "wait") return;
        if (decision !== "run") {
          await this.cancelTask(task.id, { reason: decision.drop });
          continue;
        }
      }

      // QQ 群聊会话（issue 07 §4）：入队后、模型调用前核对启停/群范围/账号
      // 在线/排队过期。wait = 暂不启动（上线或巡检时重新 kick）；drop = 过期
      // 或越权，取消跳过（不回复），继续取下一个。
      if (session.kind === "qq_group") {
        if (!this.qqAdapter) return;
        const decision = this.qqAdapter.gate(session, task);
        if (decision === "wait") return;
        if (decision !== "run") {
          this.store.withTx(() => {
            const ok = this.store.transitionTask(task.id, ["queued"], "canceled", {
              errorMessage: decision.drop,
              endedAt: new Date().toISOString(),
            });
            if (ok) {
              this.store.appendEvent(
                { type: "task.canceled", taskId: task.id, sessionId },
                { taskId: task.id, sessionId },
              );
            }
          });
          continue;
        }
      }

      // 任务开始前核对目录身份：排队期间被替换或失效的目录拒绝执行
      try {
        await verifyDirIdentity({
          cwd: session.cwd,
          cwdReal: session.cwdReal,
          dev: session.cwdDev,
          ino: session.cwdIno,
        });
      } catch (err) {
        this.store.withTx(() => {
          const ok = this.store.transitionTask(task.id, ["queued"], "failed", {
            errorMessage: (err as Error).message,
            endedAt: new Date().toISOString(),
          });
          if (ok) {
            this.store.appendEvent(
              { type: "task.failed", taskId: task.id, sessionId, errorMessage: (err as Error).message },
              { taskId: task.id, sessionId },
            );
          }
        });
        continue; // 该会话其余任务共用同一目录，同样会被拒绝
      }

      try {
        this.store.withTx(() => {
          if (this.stopping) throw new TaskGoneError(); // 停止开始后不再让排队任务转入运行
          if (!this.store.tryAcquireOccupancy({
            cwdReal: session.cwdReal,
            cwdDev: session.cwdDev,
            cwdIno: session.cwdIno,
            sessionId,
            taskId: task.id,
          })) {
            throw new DirOccupiedError();
          }
          if (!this.store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() })) {
            throw new TaskGoneError();
          }
          this.store.appendEvent(
            { type: "task.started", taskId: task.id, sessionId },
            { taskId: task.id, sessionId },
          );
        });
      } catch (err) {
        if (err instanceof DirOccupiedError) return; // 等待占用释放后的唤醒
        if (err instanceof TaskGoneError) continue; // 已被取消或后台停止，取下一个
        throw err;
      }

      const fresh = this.store.getTask(task.id)!;
      try {
        const driver = await this.getDriver(session);
        await driver.run(fresh);
      } catch (err) {
        // driver.run 内部已兜底；此处防御性记录，避免调度循环中断
        this.store.withTx(() => {
          this.store.transitionTask(task.id, ["running", "awaiting_confirmation"], "failed", {
            errorMessage: `驱动器异常：${(err as Error).message}`,
            endedAt: new Date().toISOString(),
          });
          this.store.appendEvent(
            { type: "task.failed", taskId: task.id, sessionId, errorMessage: (err as Error).message },
            { taskId: task.id, sessionId },
          );
          this.store.releaseOccupancy(session.cwdReal, task.id);
        });
      } finally {
        this.kickAll();
      }
    }
  }

  private async getDriver(session: Session): Promise<Driver> {
    let driver = this.drivers.get(session.id);
    if (!driver) {
      driver = new Driver(session, {
        store: this.store,
        ledger: this.ledger,
        qqStore: this.qqStore,
        sessionsDir: sessionsDirFor(this.config.dataDir),
        agentDir: this.config.agentDir,
        modelRuntime: this.modelRuntime,
        modelCatalog: this.modelCatalog,
        model: this.model,
        thinkingLevel: this.config.thinkingLevel ?? "off",
        toolFactory:
          this.config.toolFactory ??
          ((ctx) => createCodingTools(ctx.router)),
        artifacts: this.artifacts,
        credentials: this.credentials,
        launcherFor: (mode) => this.launcherFor(mode),
        protectedRoots: this.protectedRoots(),
        onOccupancyReleased: () => this.kickAll(),
        access: this.access,
        historyIndex: this.historyIndex,
        memories: this.memories,
        budgetOverrides: this.config.budgetOverrides,
        webSearch: this.config.webSearch,
        jev: this.config.jev,
        compaction: this.config.compaction,
        mcp: { store: this.mcp, ...this.config.mcp },
        allowTaskTool: (task, name, effect) => this.githubEvents.allowTool(task, name, effect),
        reviewer: this.reviewer,
        // QQ 群聊会话（issue 07）：每次模型调用前移出已撤回交互（只改视图）
        qqRecalledFilter: (sessionId, messages) =>
          filterRecalledQqMessages(messages, this.qqStore.recalledTagsForSession(sessionId)),
        // main 应用数据空间（issue 02）：仅 main 角色会话装配；不可用时缺省
        // （能力停止，事件已记录），不装配工具
        appData: this.appDataStore
          ? {
              store: this.appDataStore,
              runner: this.appDataRunner,
              queryStallMs: this.config.appData?.queryStallMs,
            }
          : undefined,
        // 调度与通知（issue 03）：仅 main 角色会话装配；目标只来自可信宿主渠道；
        // ruukoto-dev 无调度器，不装配（issue 01）
        scheduler: this.scheduler
          ? {
              sched: this.sched,
              scheduler: this.scheduler,
              sources: this.sources,
              target: () => {
                const taskId = this.drivers.get(session.id)?.currentTaskId;
                const task = taskId ? this.store.getTask(taskId) : null;
                const event = task?.sourceEventId ? this.store.getInboundEvent(task.sourceEventId) : null;
                if (event?.source === QQ_PRIVATE_SOURCE) {
                  const current = this.notifyChannel(QQ_PRIVATE_SOURCE)?.target() ?? null;
                  return isDeepStrictEqual(current, event.replyTarget) ? current : null;
                }
                return this.notifyChannel()?.target() ?? null;
              },
              now: this.config.scheduler?.now ?? (() => Date.now()),
            }
          : undefined,
        // 委派 coding（issue 05）：仅 main 角色会话装配；宿主固定参数在编排器
        delegation: {
          sources: this.sources,
          delegate: (input) => {
            if (!this.orchestrator) throw new Error("编排器未启动");
            return this.orchestrator.delegateCoding(input);
          },
          readReply: (taskId, offset, length) => this.readTaskReply(taskId, offset, length),
          resultNotice: (task) => this.githubEvents.notice(task),
        },
      });
      this.drivers.set(session.id, driver);
    } else {
      // 会话记录可能更新（如 sessionFile 落盘后回填）
      driver.syncSessionRecord(session);
    }
    return driver;
  }

  // ---------- 中断 / 取消 / 确认 / 恢复队列 ----------

  async interruptTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${taskId}`);
    if (task.status !== "running" && task.status !== "awaiting_confirmation") {
      throw new RuntimeApiError("invalid_state", `只能中断运行中或等待确认的任务，当前 ${task.status}`);
    }
    const driver = await this.getDriver(this.store.getSession(task.sessionId)!);
    await driver.requestStop(task, { terminal: "interrupted", reason: "owner_interrupt", cancelIntent: false });
    return this.store.getTask(taskId)!;
  }

  async cancelTask(taskId: string, opts?: { reason?: string }): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${taskId}`);
    if (task.status === "queued") {
      this.store.withTx(() => {
        const ok = this.store.transitionTask(task.id, ["queued"], "canceled", {
          endedAt: new Date().toISOString(),
          // 编排器超时取消等场景持久化原因（undefined 时保持原状不写入）
          errorMessage: opts?.reason,
        });
        if (ok) {
          this.store.appendEvent(
            { type: "task.canceled", taskId: task.id, sessionId: task.sessionId },
            { taskId: task.id, sessionId: task.sessionId },
          );
        }
      });
      return this.store.getTask(taskId)!;
    }
    if (task.status === "running" || task.status === "awaiting_confirmation") {
      const driver = await this.getDriver(this.store.getSession(task.sessionId)!);
      await driver.requestStop(task, { terminal: "canceled", reason: opts?.reason ?? "owner_cancel", cancelIntent: true });
      return this.store.getTask(taskId)!;
    }
    throw new RuntimeApiError("invalid_state", `任务已结束（${task.status}），不能取消`);
  }

  respondConfirmation(
    confirmationId: string,
    decision: "approved" | "rejected",
    expectedPermissionVersion?: number,
  ): ConfirmationRequest {
    const confirmation = this.store.getConfirmation(confirmationId);
    if (!confirmation) throw new RuntimeApiError("not_found", `确认请求不存在：${confirmationId}`);
    // 批准绑定原请求的权限版本：版本变化时拒绝旧选择，要求重新查看
    if (expectedPermissionVersion !== undefined && confirmation.permissionVersion !== expectedPermissionVersion) {
      throw new RuntimeApiError(
        "permission_version_mismatch",
        `审批的权限版本已变化（当前 ${confirmation.permissionVersion}，请求 ${expectedPermissionVersion}）：请刷新详情后重新决定`,
      );
    }
    const task = this.store.getTask(confirmation.taskId)!;
    if (task.status !== "awaiting_confirmation") {
      throw new RuntimeApiError("stale_confirmation", `确认请求已失效（任务状态 ${task.status}）`);
    }
    const driver = this.drivers.get(confirmation.sessionId);
    if (!driver) throw new RuntimeApiError("stale_confirmation", "确认请求已失效（无活动执行）");
    const applied = driver.resolveConfirmation(confirmationId, decision);
    if (!applied) throw new RuntimeApiError("stale_confirmation", "确认请求已被处理或失效");
    return this.store.getConfirmation(confirmationId)!;
  }

  /** 拥有者确认旧执行已停止：释放该会话遗留占用并恢复队列。 */
  async resumeQueue(sessionId: string, selection?: ModelSelection): Promise<Session> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${sessionId}`);
    if (this.store.countLegacyQueuedTasks(sessionId) > 0 && !selection) {
      throw new RuntimeApiError("model_selection_required", "旧排队任务未记录模型配置；请显式确认 model_selection 后恢复队列");
    }
    // 模型配置应用门闩（issue 21 §4）：显式确认的 provider 受影响时拒绝
    const check = selection ? await this.resolveSelection(parseModelSelection(selection)) : null;
    this.store.withTx(() => {
      check?.();
      if (this.store.countLegacyQueuedTasks(sessionId) > 0) {
        if (!selection) throw new RuntimeApiError("model_selection_required", "请显式确认旧任务的模型配置");
        this.store.fillLegacyQueuedModelSelections(sessionId, selection);
      }
      // 仅释放遗留（所属任务已结束）的占用；活动任务持有的占用不得被此操作破坏
      for (const occ of this.store.listAllOccupancy()) {
        if (occ.sessionId !== sessionId) continue;
        const occTask = this.store.getTask(occ.taskId);
        if (occTask && !isTerminalTaskStatus(occTask.status)) {
          throw new RuntimeApiError(
            "occupancy_active",
            `任务 ${occ.taskId} 仍在 ${occTask.status}，占用不能释放`,
          );
        }
        this.store.releaseOccupancy(occ.cwdReal, occ.taskId);
      }
      this.store.setSessionQueueState(sessionId, "active", null);
      this.store.appendEvent({ type: "session.queue_resumed", sessionId }, { sessionId });
    });
    this.kick(sessionId);
    return this.store.getSession(sessionId)!;
  }

  // ---------- 快照 ----------

  /** 数据实例稳定标识（待确认请求绑定；新数据库分配新标识）。 */
  instanceId(): string {
    return this.db.getInstanceId();
  }

  /**
   * 生效的模型来源与思考强度（供 TUI 展示；只读信息，不可经此改变配置）。
   * provider/id 来自实际解析到的模型对象，不是配置文件的原始文本。
   */
  modelInfo(): { provider: string; id: string; name: string; thinkingLevel: string } {
    return {
      provider: String(this.model?.provider ?? ""),
      id: String(this.model?.id ?? ""),
      name: String(this.model?.name ?? ""),
      thinkingLevel: this.defaultSelection.thinkingLevel,
    };
  }

  /** 执行后端说明（local 无隔离必须显式标记，不得暗示隔离已生效）。 */
  executionInfo(): { backend: string; note: string } {
    const backend = this.config.execution?.backend ?? "local";
    const note =
      backend === "local"
        ? "local 执行后端：无隔离，仅用于开发/验证；不得据此声明请求确认模式的执行边界"
        : backend === "container"
          ? "container 执行后端：请求确认任务在 Linux 容器边界内执行"
          : "systemd 执行账户入口：完全访问任务以固定执行 UID 运行";
    return { backend, note };
  }

  /**
   * 任务输出预览：活动任务优先取 Driver 当前状态（最新、未必已发事件），
   * 否则回退到持久化的最新片段；片段所属消息已有最终条目 → 无预览。
   * 中断/失败任务的残留片段标为 captured_partial（中断前已捕获部分）。
   */
  outputPreviewFor(task: Task): OutputPreview | null {
    if (task.status === "running" || task.status === "awaiting_confirmation") {
      const live = this.drivers.get(task.sessionId)?.currentOutputPreview(task.id);
      if (live) {
        const capped = tailTextByBytes(live.text, FRAGMENT_PREVIEW_CAP);
        const latest = this.store.getLatestOutputFragment(task.id);
        return {
          messageId: live.messageId,
          text: capped.text,
          totalBytes: capped.totalBytes,
          truncated: capped.truncated,
          seq: latest?.messageId === live.messageId ? latest.seq : this.store.getMaxSeq(),
          state: "generating",
        };
      }
      const persisted = this.store.getLatestOutputFragment(task.id);
      if (persisted && !this.store.hasOutputEntryForMessage(task.id, persisted.messageId)) {
        return { ...persisted, state: "generating" };
      }
      return null;
    }
    if (task.status === "interrupted" || task.status === "failed" || task.status === "canceled") {
      const persisted = this.store.getLatestOutputFragment(task.id);
      if (persisted && !this.store.hasOutputEntryForMessage(task.id, persisted.messageId)) {
        return { ...persisted, state: "captured_partial" };
      }
    }
    return null;
  }

  snapshot(): {
    projects: Project[];
    sessions: Session[];
    tasks: Task[];
    confirmations: ConfirmationRequestView[];
    artifacts: Artifact[];
    previews: Record<string, OutputPreview>;
    instanceId: string;
    execution: { backend: string; note: string };
    defaultModel: { provider: string; id: string; name: string; thinkingLevel: string };
    roleSessionIds: string[];
    seq: number;
  } {
    // 有界快照：全部活动任务 + 每个会话最近结束的若干任务；更早的经 list_tasks 分页
    const sessions = this.store.listSessions();
    const tasks: Task[] = [];
    for (const session of sessions) {
      const all = this.store.listTasksBySession(session.id);
      const active = all.filter((t) => ACTIVE_TASK_STATUSES.includes(t.status));
      const ended = all
        .filter((t) => !ACTIVE_TASK_STATUSES.includes(t.status))
        .sort((a, b) => (a.endedAt ?? a.createdAt).localeCompare(b.endedAt ?? b.createdAt) || b.id.localeCompare(a.id))
        .slice(-SNAPSHOT_ENDED_TASKS_PER_SESSION);
      tasks.push(...active, ...ended);
    }
    const previews: Record<string, OutputPreview> = {};
    for (const task of tasks) {
      const preview = this.outputPreviewFor(task);
      if (preview) previews[task.id] = preview;
    }
    return {
      projects: this.store.listProjects(),
      sessions,
      tasks,
      confirmations: this.store.listConfirmationsByStatus("pending").map(confirmationToView),
      artifacts: this.listRecentArtifacts(),
      previews,
      instanceId: this.db.getInstanceId(),
      execution: this.executionInfo(),
      defaultModel: this.modelInfo(),
      roleSessionIds: this.store.listAgentRoles().map((r) => r.sessionId),
      seq: this.store.getMaxSeq(),
    };
  }

  /** 活动任务与最近结束任务的产物元数据（正文在产物文件，按 id 查询）。 */
  private listRecentArtifacts(): Artifact[] {
    const active = this.store.listTasksByStatus(["queued", "running", "awaiting_confirmation"]);
    const ids = new Set<string>();
    const out: Artifact[] = [];
    for (const task of active) {
      for (const artifact of this.store.listArtifactsByTask(task.id)) {
        if (!ids.has(artifact.id)) {
          ids.add(artifact.id);
          out.push(artifact);
        }
      }
    }
    return out;
  }

  /**
   * 单任务详情：任务、工具操作、确认请求（参数有界预览，超限经
   * getConfirmationParams / getToolOpParams 分段读取）、产物、输出预览。
   */
  getTaskDetail(taskId: string): {
    seq: number;
    task: Task;
    toolOps: ToolOpView[];
    confirmations: ConfirmationRequestView[];
    artifacts: Artifact[];
    outputPreview: OutputPreview | null;
  } | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    return {
      seq: this.store.getMaxSeq(),
      task,
      toolOps: this.store.listToolOpsByTask(task.id).map(toolOpToView),
      confirmations: this.store.listConfirmationsByTask(task.id).map(confirmationToView),
      artifacts: this.store.listArtifactsByTask(task.id),
      outputPreview: this.outputPreviewFor(task),
    };
  }

  /** 按 会话 + request_id 精确查询（重连幂等核实；含已离开快照的完成任务）。 */
  findTaskByRequest(input: { sessionId: string; requestId: string }): { task: Task | null } {
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    return { task: this.store.findTaskByRequest(input.sessionId, input.requestId) };
  }

  /** 会话内任务分页（新 → 旧；已结束任务的历史查询入口）。 */
  listTasks(input: { sessionId: string; before?: string; limit?: number }): { tasks: Task[]; hasMore: boolean } {
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    try {
      return this.store.listTasksBySessionPaged(input.sessionId, { before: input.before, limit: input.limit });
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  // ---------- 历史读取（与 05 历史工具共用的读取边界） ----------

  /** 历史读取的公共边界：会话归属校验 + 错误码传递（损坏 vs 未落盘）。 */
  private withSessionHistory<T>(sessionId: string, fn: (sessionFile: string | null) => T): T {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${sessionId}`);
    try {
      return fn(session.sessionFile);
    } catch (err) {
      if (err instanceof HistoryReadError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  /**
   * 分页读取会话消息历史。文件路径由后台按会话归属查找，客户端不能传
   * 任意宿主路径；损坏与尚未落盘明确区分（HistoryReadError /
   * fileAvailable=false）。
   */
  readHistory(input: {
    sessionId: string;
    before?: string;
    limit?: number;
    entryTextCap?: number;
    pageTextBudget?: number;
  }): HistoryPage {
    return this.withSessionHistory(input.sessionId, (file) => readHistoryPage(file, input));
  }

  /** 指定历史条目的正文分段（字节偏移，UTF-8 边界对齐）。 */
  readHistoryEntry(input: { sessionId: string; entryId: string; offset?: number; length?: number }): HistoryEntryView {
    return this.withSessionHistory(input.sessionId, (file) =>
      readHistoryEntryText(file, input.entryId, input.offset, input.length),
    );
  }

  readToolResult(input: { sessionId: string; entryId: string; length?: number }) {
    return this.withSessionHistory(input.sessionId, (file) => readToolResult(file, input.entryId, input.length));
  }

  /**
   * 指定任务的最终 assistant 文本（issue 04）：按任务关联的历史条目倒序读取，
   * 不取会话最新一条（重启补登时会话可能已跑过别的任务）。无文本返回 null。
   */
  readTaskReplyText(taskId: string): string | null {
    return this.readTaskReply(taskId)?.text ?? null;
  }

  /** 按任务读取最终回答的 UTF-8 字节分页，不受首段 256 KiB 上限限制。 */
  readTaskReply(taskId: string, offset = 0, length = 256 * 1024): HistoryEntryView | null {
    const task = this.store.getTask(taskId);
    if (!task || task.status !== "completed") return null;
    // 最终回答总在任务条目末尾；只看最后 20 条，避免长任务逐条重解析历史文件
    for (const entryId of task.historyEntryIds.slice(-20).reverse()) {
      try {
        const entry = this.readHistoryEntry({ sessionId: task.sessionId, entryId, offset, length });
        if (entry.role === "assistant" && entry.totalBytes > 0) return entry;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 序列化参数 JSON 的有界分段（UTF-8 边界对齐）。 */
  private pagedParams(params: Record<string, unknown>, offset?: number, length?: number): BoundedText {
    const json = JSON.stringify(params);
    const cap = Math.min(Math.max(1, length ?? SEGMENT_DEFAULT_BYTES), SEGMENT_MAX_BYTES);
    return sliceTextByBytes(json, Math.max(0, offset ?? 0), cap);
  }

  /** 审批完整参数的分段读取（序列化 JSON 的字节切片，UTF-8 边界对齐）。 */
  getConfirmationParams(input: { confirmationId: string; offset?: number; length?: number }): {
    confirmation: Omit<ConfirmationRequest, "params">;
    params: BoundedText;
  } {
    const confirmation = this.store.getConfirmation(input.confirmationId);
    if (!confirmation) throw new RuntimeApiError("not_found", `确认请求不存在：${input.confirmationId}`);
    const { params: _params, ...rest } = confirmation;
    return { confirmation: rest, params: this.pagedParams(confirmation.params, input.offset, input.length) };
  }

  /** 工具操作完整参数的分段读取（同上）。 */
  getToolOpParams(input: { toolOpId: string; offset?: number; length?: number }): {
    toolOp: Omit<ToolOp, "params">;
    params: BoundedText;
  } {
    const op = this.store.getToolOp(input.toolOpId);
    if (!op) throw new RuntimeApiError("not_found", `工具操作不存在：${input.toolOpId}`);
    const { params: _params, ...rest } = op;
    return { toolOp: rest, params: this.pagedParams(op.params, input.offset, input.length) };
  }

  /** 事件只是实时投影与恢复来源；最终消息仍经 JSONL 历史读取。 */
  readTaskEvents(input: { taskId: string; afterSeq?: number; limit?: number }): { events: PersistentEvent[]; nextAfter: number | null } {
    if (!this.store.getTask(input.taskId)) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    const after = input.afterSeq === undefined ? 0 : input.afterSeq;
    const limit = input.limit === undefined ? 100 : input.limit;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new RuntimeApiError("invalid_params", "after_seq 必须是非负整数，limit 必须是正整数");
    }
    const cap = Math.min(limit, 500);
    const rows = this.store.getTaskEventsAfter(input.taskId, after, cap + 1);
    const events: PersistentEvent[] = [];
    let bytes = 64;
    for (const row of rows.slice(0, cap)) {
      const event = capEventForWire(row);
      const size = frameBytes(event);
      if (bytes + size > SEGMENT_MAX_BYTES) {
        if (!events.length) throw new RuntimeApiError("event_too_large", `事件 ${row.seq} 超过单页上限`);
        break;
      }
      events.push(event);
      bytes += size;
    }
    return { events, nextAfter: events.length < rows.length ? events.at(-1)!.seq : null };
  }

  getEventLog(afterSeq: number, limit?: number): PersistentEvent[] {
    return this.store.getEventsAfter(afterSeq, limit);
  }

  // ---------- 跨项目资料授权（issue 05 §1；拥有者入口） ----------

  createDataGrant(input: { fromProjectId: string; toProjectId: string; category: DataCategory; purpose?: string }): DataGrant {
    try {
      const grant = this.access.createGrant(input);
      this.store.withTx(() => {
        this.store.appendEvent({
          type: "data_grant.created",
          grantId: grant.id,
          fromProjectId: grant.fromProjectId,
          toProjectId: grant.toProjectId,
          category: grant.category,
        });
      });
      return grant;
    } catch (err) {
      if (err instanceof AccessDeniedError) throw new RuntimeApiError("invalid_params", err.message);
      throw err;
    }
  }

  revokeDataGrant(grantId: string): DataGrant {
    const grant = this.access.revokeGrant(grantId);
    if (!grant) throw new RuntimeApiError("not_found", `授权不存在或已撤销：${grantId}`);
    this.store.withTx(() => {
      this.store.appendEvent({
        type: "data_grant.revoked",
        grantId: grant.id,
        fromProjectId: grant.fromProjectId,
        toProjectId: grant.toProjectId,
        category: grant.category,
      });
    });
    return grant;
  }

  listDataGrants(opts: { includeRevoked?: boolean } = {}): DataGrant[] {
    return this.access.listGrants(opts);
  }

  // ---------- 历史检索（issue 05 §2；拥有者入口，全范围） ----------

  /**
   * 同步会话历史索引并做字面关键词搜索（拥有者范围 = 全部项目）。
   * 索引是派生数据：文件替换/截断时重建索引，绝不改写源 JSONL。
   */
  searchHistory(input: {
    query: string;
    projectId?: string;
    sessionId?: string;
    taskId?: string;
    role?: string;
    since?: string;
    until?: string;
    limit?: number;
    scanLimit?: number;
    cursor?: { sessionId: string; byteOffset: number } | null;
    contextChars?: number;
  }): {
    hits: import("../core/history-index.ts").HistorySearchHit[];
    complete: boolean;
    cursor: { sessionId: string; byteOffset: number } | null;
    scanned: number;
    unindexedSessionIds: string[];
  } {
    if (!input.query || input.query.length === 0) {
      throw new RuntimeApiError("invalid_params", "搜索关键词不能为空");
    }
    let sessions = this.store.listSessions();
    if (input.taskId) {
      const task = this.store.getTask(input.taskId);
      if (!task) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
      sessions = sessions.filter((s) => s.id === task.sessionId);
    }
    if (input.sessionId) {
      sessions = sessions.filter((s) => s.id === input.sessionId);
      if (sessions.length === 0) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    }
    if (input.projectId) {
      if (!this.store.getProject(input.projectId)) {
        throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
      }
      sessions = sessions.filter((s) => s.projectId === input.projectId);
    }
    const indexed: Array<{ sessionId: string; filePath: string }> = [];
    const unindexedSessionIds: string[] = [];
    for (const session of sessions) {
      if (!session.sessionFile || !fs.existsSync(session.sessionFile)) {
        unindexedSessionIds.push(session.id);
        continue;
      }
      try {
        this.historyIndex.sync(session.id, session.sessionFile);
      } catch (err) {
        if (err instanceof HistoryReadError) throw new RuntimeApiError(err.code, err.message);
        throw err;
      }
      indexed.push({ sessionId: session.id, filePath: session.sessionFile });
    }
    const result = searchHistory(this.db, indexed, {
      query: input.query,
      taskId: input.taskId,
      role: input.role,
      since: input.since,
      until: input.until,
      limit: input.limit,
      scanLimit: input.scanLimit,
      cursor: input.cursor ?? undefined,
      contextChars: input.contextChars,
    });
    return { ...result, unindexedSessionIds };
  }

  /**
   * 设置项目指令文件（issue 05 §3；拥有者入口）。工作区相对路径列表；
   * 任务开始时经受限读取钉版。传空数组 = 清除项目指令。
   */
  setProjectInstructions(input: { projectId: string; files: string[] }): Project {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    for (const file of input.files) {
      if (typeof file !== "string" || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
        throw new RuntimeApiError("invalid_params", `指令文件须为工作区相对路径且不含 ..：${String(file)}`);
      }
    }
    this.store.setProjectInstructionFiles(project.id, input.files);
    return this.store.getProject(project.id)!;
  }

  /**
   * 按项目启用/禁用 Web Search（issue 20；拥有者入口）。默认启用；
   * 禁用立即阻止后续调用（工具按调用新鲜检查），启用从下一任务生效
   * （任务开始固定工具清单）。
   */
  setProjectWebSearch(input: { projectId: string; enabled: boolean }): Project {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    this.store.setProjectWebSearch(project.id, input.enabled ? "enabled" : "disabled");
    return this.store.getProject(project.id)!;
  }

  getProjectJev(projectId: string): JevConfig {
    if (!this.store.getProject(projectId)) throw new RuntimeApiError("not_found", `项目不存在：${projectId}`);
    return getProjectJevConfig(this.store, projectId);
  }

  /** 拥有者配置实验；任务开始钉版，后续调用与应用结果前均重核版本和凭据。 */
  setProjectJev(input: { projectId: string; enabled: boolean; credential: string | null; expectedVersion: number }): JevConfig {
    const previous = this.getProjectJev(input.projectId);
    if (typeof input.enabled !== "boolean" ||
        !(input.credential === null || (typeof input.credential === "string" && input.credential.trim().length > 0)) ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RuntimeApiError("invalid_params", "Jev 配置须含 enabled、credential 与非负整数 expected_version");
    }
    if (input.expectedVersion !== previous.configVersion) {
      throw new RuntimeApiError("version_conflict", `Jev 配置版本冲突：期望 v${input.expectedVersion}，当前 v${previous.configVersion}`);
    }
    if (previous.configVersion === Number.MAX_SAFE_INTEGER) throw new RuntimeApiError("invalid_params", "Jev 配置版本已达上限");
    if (input.enabled && (this.store.getAgentRole("chat")?.projectId === input.projectId ||
        this.store.listSessions().some((session) => session.projectId === input.projectId && session.kind === "qq_group"))) {
      throw new RuntimeApiError("invalid_params", "QQ 群聊与 chat 项目不开放 Jev 实验");
    }
    if (input.enabled && !input.credential) throw new RuntimeApiError("invalid_params", "启用 Jev 前须选择服务凭据");
    if (input.credential && (input.enabled || input.credential !== previous.credential)) {
      const host = jevCredentialHost(this.config.jev?.baseUrl);
      const binding = this.credentials.get(input.credential);
      if (!binding?.secret || binding.host !== host || binding.header.toLowerCase() !== "authorization" || binding.purpose !== JEV_CREDENTIAL_PURPOSE) {
        throw new RuntimeApiError("invalid_params", `Jev 凭据须存在且使用 host=${host}、authorization 头与 purpose=${JEV_CREDENTIAL_PURPOSE}`);
      }
      if (binding.scope?.repoId !== undefined ||
          (binding.scope?.projectId !== undefined && binding.scope.projectId !== input.projectId) ||
          binding.scope?.operations?.some((operation) => operation !== JEV_CREDENTIAL_PURPOSE) ||
          (binding.scope?.operations !== undefined && !binding.scope.operations.includes(JEV_CREDENTIAL_PURPOSE))) {
        throw new RuntimeApiError("invalid_params", "凭据已有其他项目或操作范围，请为本项目另建 Jev 凭据");
      }
      // 文件写入先于启用；失败时配置仍保持原值。两种存储不宣称跨文件原子。
      this.credentials.upsert({ ...binding, scope: { projectId: input.projectId, operations: [JEV_CREDENTIAL_PURPOSE] } });
    }
    const config: JevConfig = { enabled: input.enabled, credential: input.credential, configVersion: previous.configVersion + 1 };
    this.store.withTx(() => {
      this.store.setMetaValue(jevConfigKey(input.projectId), JSON.stringify(config));
      this.store.appendEvent({ type: "project.jev_changed", projectId: input.projectId, configVersion: config.configVersion, enabled: config.enabled });
    });
    return config;
  }

  // ---------- 长期记忆（issue 05 §5；拥有者管理入口） ----------

  /** 拥有者查看记忆（项目内 + 个人共享；含已撤销）。 */
  listMemories(input: { projectId?: string; personal?: boolean } = {}): Memory[] {
    if (input.personal) return this.memories.listPersonal();
    if (input.projectId) {
      if (!this.store.getProject(input.projectId)) {
        throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
      }
      return this.memories.listByProject(input.projectId);
    }
    // 未指定范围：全部项目 + 个人共享（管理视图）
    const out: Memory[] = [];
    for (const project of this.store.listProjects()) out.push(...this.memories.listByProject(project.id));
    out.push(...this.memories.listPersonal());
    return out;
  }

  getMemoryDetail(memoryId: string): { memory: MemoryWithContent; versions: MemoryVersion[] } {
    const memory = this.memories.getCurrent(memoryId);
    if (!memory) throw new RuntimeApiError("not_found", `记忆不存在：${memoryId}`);
    return { memory, versions: this.memories.listVersions(memoryId) };
  }

  /**
   * 拥有者保存记忆（新建或修订）。projectId=null 表示个人共享（仅拥有者
   * 可设置）；owner_note 来源只接受拥有者入口（代理工具已另行拒绝）。
   */
  ownerSaveMemory(input: {
    memoryId?: string;
    expectedVersion?: number;
    projectId: string | null;
    category: Memory["category"];
    content: string;
    sourceRefs: MemorySourceRef[];
    reason?: string;
  }): MemoryWithContent {
    if (input.projectId !== null && !this.store.getProject(input.projectId)) {
      throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    }
    try {
      const saved = this.store.withTx(() => {
        const memory = input.memoryId
          ? this.memories.revise({
              memoryId: input.memoryId,
              expectedVersion: input.expectedVersion ?? -1,
              content: input.content,
              sourceRefs: input.sourceRefs,
              author: "owner",
              reason: input.reason,
            })
          : this.memories.create({
              projectId: input.projectId,
              category: input.category,
              content: input.content,
              sourceRefs: input.sourceRefs,
              author: "owner",
              reason: input.reason,
            });
        this.store.appendEvent({
          type: "memory.saved",
          memoryId: memory.id,
          projectId: memory.projectId,
          version: memory.currentVersion,
          author: "owner",
          taskId: null,
        });
        return memory;
      });
      return saved;
    } catch (err) {
      if (err instanceof MemoryConflictError || err instanceof MemoryNotFoundError || err instanceof MemoryValidationError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
  }

  ownerRevokeMemory(input: { memoryId: string; expectedVersion: number; reason?: string }): Memory {
    try {
      const memory = this.store.withTx(() => {
        const m = this.memories.revoke({
          memoryId: input.memoryId,
          expectedVersion: input.expectedVersion,
          author: "owner",
          reason: input.reason,
        });
        this.store.appendEvent({
          type: "memory.revoked",
          memoryId: m.id,
          projectId: m.projectId,
          version: m.currentVersion,
          author: "owner",
          taskId: null,
        });
        return m;
      });
      return memory;
    } catch (err) {
      if (err instanceof MemoryConflictError || err instanceof MemoryNotFoundError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
  }

  ownerRestoreMemory(input: { memoryId: string; fromVersion: number; reason?: string }): MemoryWithContent {
    try {
      const memory = this.store.withTx(() => {
        const m = this.memories.restore({
          memoryId: input.memoryId,
          fromVersion: input.fromVersion,
          author: "owner",
          reason: input.reason,
        });
        this.store.appendEvent({
          type: "memory.restored",
          memoryId: m.id,
          projectId: m.projectId,
          fromVersion: input.fromVersion,
          newVersion: m.currentVersion,
          author: "owner",
          taskId: null,
        });
        return m;
      });
      return memory;
    } catch (err) {
      if (err instanceof MemoryConflictError || err instanceof MemoryNotFoundError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
  }

  // ---------- 上下文选择记录（issue 05 §6；拥有者审计入口） ----------

  listSelectionRecords(input: { taskId?: string; sessionId?: string; limit?: number } = {}): SelectionRecord[] {
    if (input.taskId) {
      if (!this.store.getTask(input.taskId)) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
      return this.store.listSelectionRecordsByTask(input.taskId, input.limit);
    }
    if (input.sessionId) {
      if (!this.store.getSession(input.sessionId)) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
      return this.store.listSelectionRecordsBySession(input.sessionId, input.limit);
    }
    throw new RuntimeApiError("invalid_params", "必须指定 taskId 或 sessionId");
  }

  getSessionUsage(sessionId: string): { input: number; output: number } {
    if (!this.store.getSession(sessionId)) throw new RuntimeApiError("not_found", `会话不存在：${sessionId}`);
    return this.store.getSessionUsage(sessionId);
  }

  getSelectionRecord(recordId: string): SelectionRecord {
    const record = this.store.getSelectionRecord(recordId);
    if (!record) throw new RuntimeApiError("not_found", `选择记录不存在：${recordId}`);
    return record;
  }

  /** 技能库（issue 22）：当前库内容与诊断，只读；任务使用的是各自开始时的钉版。 */
  listSkills(): { dir: string; skills: Array<{ name: string; explicitOnly: boolean; description: string }>; diagnostics: string[] } {
    const lib = loadSkillLibrary(this.config.agentDir);
    return {
      dir: skillsDirFor(this.config.agentDir),
      skills: lib.skills.map((s) => ({
        name: s.name,
        explicitOnly: s.disableModelInvocation,
        description: s.description.length > 120 ? `${s.description.slice(0, 120)}…` : s.description,
      })),
      diagnostics: lib.diagnostics,
    };
  }

  /**
   * 单次调用的上下文窗口预算分解（issue 14）。校验记录属于指定会话；
   * 占比由 selectionBreakdown 统一计算。只读：不触发模型请求，不重读历史。
   */
  getContextBreakdown(input: { sessionId: string; recordId: string }): {
    record: SelectionRecord;
    breakdown: ContextBreakdown;
    checkpoint: Omit<ContextCheckpoint, "summary" | "clearedRefs" | "fingerprint" | "usage"> | null;
  } {
    const record = this.store.getSelectionRecord(input.recordId);
    if (!record || record.sessionId !== input.sessionId) {
      throw new RuntimeApiError("not_found", `选择记录不存在或不属于该会话：${input.recordId}`);
    }
    // 压缩点信息（issue 30 §9）：不回传摘要正文与条目引用
    const found = record.checkpointId ? this.store.getCheckpoint(record.checkpointId) : null;
    let checkpoint: Omit<ContextCheckpoint, "summary" | "clearedRefs" | "fingerprint" | "usage"> | null = null;
    if (found) {
      const { summary: _summary, clearedRefs: _clearedRefs, fingerprint: _fingerprint, usage: _usage, ...rest } = found;
      checkpoint = rest;
    }
    try {
      return { record, breakdown: selectionBreakdown(record), checkpoint };
    } catch (err) {
      if (err instanceof SelectionRecordCorrupt) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  // ---------- 模型请求 prompt 快照（issue 13；拥有者审计入口） ----------

  /** 当前会话的模型请求列表（新 → 旧；分页游标 = 上一页最后一条的 createdAt/id）。 */
  listPromptRequests(input: { sessionId: string; limit?: number; cursor?: { createdAt: string; id: string } }): {
    records: SelectionRecord[];
    hasMore: boolean;
  } {
    if (!this.store.getSession(input.sessionId)) {
      throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    }
    const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
    return this.store.listSelectionRecordsPage(input.sessionId, limit, input.cursor);
  }

  /**
   * 读取某次请求的 prompt 快照片段（按字节分页；base64）。
   * 校验记录存在且属于指定会话；快照缺失（旧记录）如实报错，不重新拼接。
   */
  readPromptSnapshot(input: { recordId: string; sessionId: string; offset?: number; length?: number }): {
    record: SelectionRecord;
    artifact: Artifact;
    encoding: "base64";
    data: string;
  } {
    const record = this.store.getSelectionRecord(input.recordId);
    if (!record || record.sessionId !== input.sessionId) {
      throw new RuntimeApiError("not_found", `请求记录不存在或不属于该会话：${input.recordId}`);
    }
    if (!record.promptArtifactId) {
      throw new RuntimeApiError("snapshot_missing", "该次 prompt 正文未记录（记录创建于快照捕获上线之前）");
    }
    const artifact = this.store.getArtifact(record.promptArtifactId);
    if (!artifact) {
      throw new RuntimeApiError("snapshot_missing", "该次 prompt 快照产物元数据缺失");
    }
    const offset = Math.max(0, input.offset ?? 0);
    // 上限按线上帧约束：base64 膨胀 4/3 + JSON 开销必须留在 MAX_FRAME_BYTES 内
    const length = Math.min(Math.max(1, input.length ?? 256 * 1024), 720 * 1024);
    const buf = this.artifacts.read(artifact.id, offset, length);
    return { record, artifact, encoding: "base64", data: buf.toString("base64") };
  }

  // ---------- QQ 群聊入口（issue 07；拥有者管理入口） ----------

  /**
   * 配置/更新 NapCat OneBot 连接（拥有者操作）。端点 ws/wss：ws 仅限回环或
   * 受控私网地址，跨主机须 wss 受保护传输；非回环端点必须配置 token 凭据
   * （CredentialStore 绑定，purpose=qq_onebot，host 与端点一致；配置后 scope
   * 收紧到 qq_onebot 操作）。任何变化递增 configVersion 并即时重建连接。
   */
  async qqConfigure(input: {
    endpoint: string;
    credential?: string | null;
    selfId: string;
    ownerUserId?: string | null;
    maxReplyChars?: number;
    expectedVersion?: number;
  }): Promise<QqConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new RuntimeApiError("invalid_params", `端点不是合法 URL：${input.endpoint}`);
    }
    if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
      throw new RuntimeApiError("invalid_params", `端点必须是 ws:// 或 wss://：${input.endpoint}`);
    }
    const host = endpoint.hostname.toLowerCase();
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    const isPrivate =
      /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
    if (endpoint.protocol === "ws:" && !isLoopback && !isPrivate) {
      throw new RuntimeApiError("invalid_params", "ws:// 明文连接仅限回环或受控私网地址；跨主机请使用 wss:// 受保护传输");
    }
    if (!/^[1-9]\d{3,19}$/.test(input.selfId) || !Number.isSafeInteger(Number(input.selfId))) {
      throw new RuntimeApiError("invalid_params", `self_id 必须是 QQ 号数字串：${input.selfId}`);
    }
    const previous = this.qqStore.getConfig();
    const credentialName = input.credential !== undefined ? input.credential : previous?.credentialName ?? null;
    const ownerUserId = input.ownerUserId !== undefined ? input.ownerUserId : previous?.ownerUserId ?? null;
    if (ownerUserId !== null && (typeof ownerUserId !== "string" || !/^[1-9]\d{3,19}$/.test(ownerUserId) || !Number.isSafeInteger(Number(ownerUserId)) || ownerUserId === input.selfId)) {
      throw new RuntimeApiError("invalid_params", "owner_user_id 必须是与登录账号不同的 QQ 号数字串");
    }
    if (ownerUserId !== null && !credentialName) {
      throw new RuntimeApiError("invalid_params", "QQ 私聊入口必须配置 token 凭据");
    }
    if (input.maxReplyChars !== undefined && (!Number.isInteger(input.maxReplyChars) || input.maxReplyChars < 100 || input.maxReplyChars > 20000)) {
      throw new RuntimeApiError("invalid_params", "max_reply_chars 必须是 100–20000 的整数");
    }
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
      throw new RuntimeApiError("invalid_params", "expected_version 必须是非负整数");
    }
    if (credentialName) {
      const cred = this.credentials.get(credentialName);
      if (!cred) throw new RuntimeApiError("invalid_params", `凭据绑定不存在：${credentialName}`);
      if (cred.host !== endpoint.host) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 的 host（${cred.host}）与端点 host（${endpoint.host}）不一致`);
      }
      if (cred.purpose !== QQ_CREDENTIAL_PURPOSE) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 用途是 ${cred.purpose}，QQ 入口需要 purpose=${QQ_CREDENTIAL_PURPOSE} 的凭据`);
      }
      if (cred.header.toLowerCase() !== "authorization") {
        throw new RuntimeApiError("invalid_params", `QQ 凭据须使用 authorization 头（Bearer）：${credentialName}`);
      }
      if (cred.scope && cred.scope.operations !== undefined && !cred.scope.operations.includes(QQ_CREDENTIAL_PURPOSE)) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 已有使用范围（操作 ${cred.scope.operations.join(",")}），与 qq_onebot 冲突；请另建凭据`);
      }
      if (cred.scope?.projectId !== undefined) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 已绑定项目范围（QQ 入口凭据不按项目限定）；请另建凭据`);
      }
    }
    if (!isLoopback && !credentialName) {
      throw new RuntimeApiError("invalid_params", "非回环端点必须配置 token 凭据（credential）");
    }
    let config: QqConfig;
    try {
      config = this.store.withTx(() => {
        const c = this.qqStore.upsertConfig({
          endpoint: endpoint.toString(),
          credentialName,
          selfId: input.selfId,
          ownerUserId,
          maxReplyChars: input.maxReplyChars,
          expectedVersion: input.expectedVersion,
        });
        this.store.appendEvent({ type: "qq.config_changed", configVersion: c.configVersion, action: "upsert" }, {});
        return c;
      });
    } catch (err) {
      if (err instanceof QqVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    // 凭据 scope 收紧到 qq_onebot 操作：通用 http_request 与其他入口不得借用
    if (config.credentialName) {
      const cred = this.credentials.get(config.credentialName)!;
      const ops = cred.scope?.operations;
      this.credentials.upsert({
        ...cred,
        scope: { ...cred.scope, operations: ops ? [...new Set([...ops, QQ_CREDENTIAL_PURPOSE])] : [QQ_CREDENTIAL_PURPOSE] },
      });
    }
    await this.qqAdapter?.onConfigChanged();
    await this.reconcileQqPrivate();
    return config;
  }

  /** 配置变化立即撤销私聊旧授权；不能把同一 main 会话中 Telegram 的任务一并取消。 */
  private async reconcileQqPrivate(): Promise<void> {
    for (const event of this.store.listInboundByStatus(["registered", "queued"])) {
      if (event.source !== QQ_PRIVATE_SOURCE) continue;
      const gate = this.qqPrivateGate(event);
      if (gate === "run" || gate === "wait") continue;
      if (event.status === "registered") {
        this.store.withTx(() => this.store.failRegisteredInbound(event.id));
      } else if (event.taskId) {
        const task = this.store.getTask(event.taskId);
        if (task && (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) {
          await this.cancelTask(task.id, { reason: gate.drop });
        }
      }
    }
    const main = this.store.getAgentRole("main");
    if (main) this.kick(main.sessionId);
    this.scheduler?.kickSender();
  }

  /** QQ 入口状态（配置视图 + 运行期连接状态；不含 token 与消息正文）。 */
  qqStatus() {
    return (
      this.qqAdapter?.status() ?? {
        configured: this.qqStore.getConfig() !== null,
        enabled: false,
        online: false,
        // qqDisabled 与未启动区分标注（产品边界 / dev 开发实例两种来源），避免误以为连接异常
        ...(this.config.qqDisabled ? { disabledByConfig: true } : {}),
        stateDetail: this.config.qqDisabled
          ? this.productType === "ruukoto-dev"
            ? "Coding Agent（ruukoto-dev）不连接消息平台"
            : "已由启动配置停用（dev 开发实例不连接真实 QQ 通道）"
          : "适配器未启动",
      }
    );
  }

  /** 一键停用/启用：停用即断开连接、阻止新接收与后续发送，运行中任务按取消机制收尾。 */
  async qqSetEnabled(enabled: boolean, expectedVersion?: number): Promise<QqConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    let config: QqConfig | null;
    try {
      config = this.store.withTx(() => {
        const prev = this.qqStore.getConfig();
        const c = this.qqStore.setEnabled(enabled, expectedVersion);
        // 同值调用不递增版本（无变化），也不产生无变化的配置事件
        if (c && c.configVersion !== prev?.configVersion) {
          this.store.appendEvent({ type: "qq.config_changed", configVersion: c.configVersion, action: enabled ? "enabled" : "disabled" }, {});
        }
        return c;
      });
    } catch (err) {
      if (err instanceof QqVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    if (!config) throw new RuntimeApiError("not_found", "QQ 入口未配置（先 qq_configure）");
    await this.qqAdapter?.onConfigChanged();
    await this.reconcileQqPrivate();
    return config;
  }

  /** 群允许列表增删（配置版本递增；移除即取消该群排队/运行任务与未发送回复）。 */
  async qqGroupUpdate(input: { groupId: string; allow: boolean; expectedVersion?: number }): Promise<QqConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    if (!/^\d{4,20}$/.test(input.groupId)) {
      throw new RuntimeApiError("invalid_params", `群号必须是数字串：${input.groupId}`);
    }
    let config: QqConfig | null;
    try {
      config = this.store.withTx(() => {
        const current = this.qqStore.getConfig();
        if (!current) return null;
        const groups = input.allow
          ? [...new Set([...current.groups, input.groupId])]
          : current.groups.filter((g) => g !== input.groupId);
        const c = this.qqStore.setGroups(groups, input.expectedVersion);
        if (c) {
          this.store.appendEvent(
            { type: "qq.config_changed", configVersion: c.configVersion, action: input.allow ? "group_added" : "group_removed", groupId: input.groupId },
            {},
          );
        }
        return c;
      });
    } catch (err) {
      if (err instanceof QqVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    if (!config) throw new RuntimeApiError("not_found", "QQ 入口未配置（先 qq_configure）");
    if (!input.allow) await this.qqAdapter?.onGroupRemoved(input.groupId);
    else await this.qqAdapter?.onConfigChanged();
    await this.reconcileQqPrivate();
    return config;
  }

  /** 收件登记查看（新 → 旧；含状态与撤回标记，供队列与错误排查）。 */
  qqListInbox(input: { groupId?: string; limit?: number } = {}): QqInboxRow[] {
    return this.qqStore.listInbox(input);
  }

  /** 发送记录查看（新 → 旧；含 sent/failed/unknown/canceled 与平台消息 id）。 */
  qqListOutbox(input: { groupId?: string; limit?: number } = {}): QqOutboxRow[] {
    return this.qqStore.listOutbox(input);
  }

  // ---------- Telegram owner 入口（issue 04；拥有者管理入口） ----------

  /**
   * 配置/更新 Telegram bot 与固定 owner（拥有者操作）。bot token 经凭据绑定
   * 引用（purpose=telegram_bot，host 与 API 地址一致；配置后 scope 收紧到
   * telegram_bot 操作）；API 地址默认官方端点，可指向受控反代（http 仅限回环）。
   * 任何变化递增 configVersion 并即时重连；旧目标上未发送的操作不改发。
   */
  async telegramConfigure(input: {
    apiBase?: string;
    credential: string;
    ownerUserId: string;
    ownerChatId?: string;
    expectedVersion?: number;
  }): Promise<TelegramConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    let api: URL;
    try {
      api = new URL(input.apiBase ?? TELEGRAM_DEFAULT_API);
    } catch {
      throw new RuntimeApiError("invalid_params", `api_base 不是合法 URL：${input.apiBase}`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname.toLowerCase());
    if (api.protocol !== "https:" && !(api.protocol === "http:" && loopback)) {
      throw new RuntimeApiError("invalid_params", "api_base 必须是 https://（http:// 仅限回环地址）");
    }
    const ownerChatId = input.ownerChatId ?? input.ownerUserId;
    if (!/^\d{1,20}$/.test(input.ownerUserId) || !/^\d{1,20}$/.test(ownerChatId)) {
      throw new RuntimeApiError("invalid_params", "user_id / chat_id 必须是数字串（私聊的 chat_id 即 owner 的 user_id）");
    }
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
      throw new RuntimeApiError("invalid_params", "expected_version 必须是非负整数");
    }
    const cred = this.credentials.get(input.credential);
    if (!cred) throw new RuntimeApiError("invalid_params", `凭据绑定不存在：${input.credential}`);
    if (cred.purpose !== TELEGRAM_CREDENTIAL_PURPOSE) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 用途是 ${cred.purpose}，Telegram 入口需要 purpose=${TELEGRAM_CREDENTIAL_PURPOSE} 的凭据`);
    }
    if (cred.host !== api.host.toLowerCase()) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 的 host（${cred.host}）与 API 地址 host（${api.host}）不一致`);
    }
    if (!/^\d+:[\w-]+$/.test(cred.secret)) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 的值不是 bot token 格式（<数字>:<密钥>）`);
    }
    if (cred.scope?.projectId !== undefined || (cred.scope?.operations !== undefined && !cred.scope.operations.includes(TELEGRAM_CREDENTIAL_PURPOSE))) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 已有其他使用范围，与 telegram_bot 冲突；请另建凭据`);
    }
    let config: TelegramConfig;
    try {
      config = this.store.withTx(() => {
        const c = this.telegramStore.upsertConfig({
          apiBase: api.toString().replace(/\/+$/, ""),
          credentialName: input.credential,
          ownerUserId: input.ownerUserId,
          ownerChatId,
          expectedVersion: input.expectedVersion,
        });
        this.store.appendEvent({ type: "telegram.config_changed", configVersion: c.configVersion, action: "upsert" });
        return c;
      });
    } catch (err) {
      if (err instanceof TelegramVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    // scope 收紧：通用 http_request 与其他入口不得借用 bot token
    this.credentials.upsert({ ...cred, scope: { operations: [TELEGRAM_CREDENTIAL_PURPOSE] } });
    await this.telegram?.onConfigChanged();
    return config;
  }

  /** Telegram 入口状态（配置视图 + 轮询状态；不含 token 与消息正文）。 */
  telegramStatus(): Record<string, unknown> {
    if (this.telegram) return this.telegram.status();
    return {
      configured: this.telegramStore.getConfig() !== null,
      enabled: false,
      online: false,
      ...(this.config.telegramDisabled
        ? {
            disabledByConfig: true,
            stateDetail:
              this.productType === "ruukoto-dev"
                ? "Coding Agent（ruukoto-dev）不连接消息平台"
                : "已由启动配置停用（dev 开发实例不连接真实 Telegram）",
          }
        : {}),
    };
  }

  /** 一键启停：停用即停止轮询；未发送的 owner 回复与通知因目标停用而取消（不改发）。 */
  async telegramSetEnabled(enabled: boolean, expectedVersion?: number): Promise<TelegramConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    let config: TelegramConfig | null;
    try {
      config = this.store.withTx(() => {
        const prev = this.telegramStore.getConfig();
        const c = this.telegramStore.setEnabled(enabled, expectedVersion);
        if (c && c.configVersion !== prev?.configVersion) {
          this.store.appendEvent({ type: "telegram.config_changed", configVersion: c.configVersion, action: enabled ? "enabled" : "disabled" });
        }
        return c;
      });
    } catch (err) {
      if (err instanceof TelegramVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    if (!config) throw new RuntimeApiError("not_found", "Telegram 入口未配置（先 telegram_configure）");
    await this.telegram?.onConfigChanged();
    return config;
  }

  // ---------- 停止 ----------

  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.doStop(reason);
    return this.stopPromise;
  }

  private async doStop(reason: string): Promise<void> {
    this.store.withTx(() => {
      this.store.appendEvent({ type: "backend.stopping", reason });
    });

    await this.githubWebhook?.stop();
    this.githubWebhook = null;

    // 调度器先行停止（issue 03）：停止扫描与领取，中止并等待在途发送收尾；
    // 之后编排器等待派发链，关闭数据库前不再有发送回调写库
    await this.scheduler?.stop().catch(() => {});
    // Telegram 轮询停止（issue 04）：之后不再登记入站事件、不再写轮询偏移
    await this.telegram?.stop().catch(() => {});
    // 编排器先行停止：停超时巡检，停止路径不再产生新的取消/唤醒
    if (this.orchestrator) {
      await this.orchestrator.stop().catch(() => {});
      this.orchestrator = null;
    }

    // QQ 适配器先行停止：断开 NapCat 连接、停止接收新事件（在途任务由下方
    // 统一中断路径收尾；未发送回复保留 pending 事实，不在停止路径补发）
    if (this.qqAdapter) {
      await this.qqAdapter.stop().catch(() => {});
      this.qqAdapter = null;
    }

    // 中断活动任务（queued 保留）；requestStop 内部完成终态、占用与事件
    const active = this.store.listTasksByStatus(ACTIVE_TASK_STATUSES.filter((s) => s !== "queued"));
    const driverOf = (task: Task) => this.drivers.get(task.sessionId);
    for (const task of active) {
      const driver = driverOf(task);
      if (driver) {
        await driver.requestStop(task, {
          terminal: "interrupted",
          reason: "backend_stop",
          cancelIntent: false,
        }).catch(() => {});
      } else {
        // 已占用运行中但驱动器缺失（异常路径）：条件更新中断并保留占用事实
        this.store.withTx(() => {
          if (this.store.transitionTask(task.id, ["running", "awaiting_confirmation"], "interrupted", {
            interruptReason: "backend_stop",
            endedAt: new Date().toISOString(),
          })) {
            this.store.stalePendingConfirmations(task.id);
            this.store.appendEvent(
              { type: "task.interrupted", taskId: task.id, sessionId: task.sessionId, reason: "backend_stop", cancelRequested: false, effectUnknown: false },
              { taskId: task.id, sessionId: task.sessionId },
            );
          }
        });
      }
    }

    for (const driver of this.drivers.values()) {
      await driver.dispose();
    }
    this.drivers.clear();

    // 等待调度循环收尾（停止意图已在上面使 runQueueLoop 退出），
    // 之后才能关闭数据库，避免循环尾部访问已关闭的连接
    while (this.loopPromises.size > 0) {
      await Promise.allSettled(Array.from(this.loopPromises.values()));
    }

    if (this.onCloseServer) {
      await this.onCloseServer().catch(() => {});
    }
    // 应用数据空间（issue 02）：回收在途只读查询子进程，checkpoint 后关闭
    await this.appDataRunner.dispose().catch(() => {});
    if (this.appDataStore) {
      try {
        this.appDataStore.close();
      } catch {
        // 关闭失败不阻断退出
      }
      this.appDataStore = null;
    }
    this.store.withTx(() => {
      this.store.appendEvent({ type: "backend.stopped", reason });
    });
    this.db.close();
    this.lock.release();
    this.configLock.release();
    try {
      fs.rmSync(this.socketPath(), { force: true });
    } catch {
      // socket 清理失败不阻断退出
    }
  }
}
