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

import { OwnerAttachments } from "./owner-attachments.ts";
import type { AttachmentMetadata, AttachmentUpload } from "@ruukoto/core/attachments.ts";
import { RuntimeModels } from "./models.ts";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AppDataQueryRunner } from "@ruukoto/agent/app-data/query.ts";
import { AppDataError,AppDataStore } from "@ruukoto/agent/app-data/store.ts";
import { createAppDataFamily } from "@ruukoto/agent/app-data/tools.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { SelectorBudgetConfig } from "@ruukoto/agent/context-selector.ts";
import { DEFAULT_BUDGET_CONFIG, selectionBreakdown,SelectionRecordCorrupt,type ContextBreakdown } from "@ruukoto/agent/context-selector.ts";
import { generateManualCompaction, inspectManualCompaction, ManualCompactionError } from "@ruukoto/agent/manual-compaction.ts";
import { createDelegationFamily,delegationOpCheck } from "@ruukoto/agent/delegation-tools.ts";
import { Driver } from "@ruukoto/agent/driver.ts";
import { endTaskExecution, type TaskEndingContext } from "@ruukoto/agent/task-ending.ts";
import { BrowserManager, BROWSER_META_KEY, type BrowserManagerOptions } from "@ruukoto/agent/browser-manager.ts";
import { browserTaskAllowed, createBrowserFamily } from "@ruukoto/agent/browser-tools.ts";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import {
  createLauncherFor,
  ExecutionError,
  type ExecutionBackendConfig,
} from "@ruukoto/agent/execution/launchers.ts";
import type { HostToolFamily } from "@ruukoto/agent/host-tool-families.ts";
import { createHostDataFamily } from "@ruukoto/agent/host-tools.ts";
import { getProjectJevConfig,JEV_CREDENTIAL_PURPOSE,jevConfigKey,jevCredentialHost,type JevConfig } from "@ruukoto/agent/jev-config.ts";
import { connectMcpService,MCP_CREDENTIAL_PURPOSE,McpError,parseMcpEndpoint,type McpConnection,type McpTimeouts } from "@ruukoto/agent/mcp/client.ts";
import { allowlistEffectFor,McpStore,McpVersionConflictError,normalizeToolAllowlist,type McpServiceConfig,type McpToolEffect } from "@ruukoto/agent/mcp/store.ts";
import { CodeCuaManager } from "@ruukoto/agent/mcp/code.ts";
import { cuaToolEffect, parseCuaConfig, restrictCuaTool, type CuaConfig } from "@ruukoto/agent/mcp/cua.ts";
import { describeCuaTools, discoverCuaTargets } from "@ruukoto/agent/mcp/cua-discovery.ts";
import { readMacosCuaPermissions } from "@ruukoto/agent/execution/native-macos-identity.ts";
import { validateRemoteTool } from "@ruukoto/agent/mcp/tools.ts";
import { configSecrets, loadSummaryModel, type SummaryModel } from "@ruukoto/agent/model-config.ts";
import { ModelSelectionError, type ModelCatalog } from "@ruukoto/agent/model-selection.ts";
import { sessionsDirFor } from "@ruukoto/agent/session-factory.ts";
import { createSkillFamily,skillsDirFor,type SkillId } from "@ruukoto/agent/skills.ts";
import { loadHostSkillLibrary, ManagedSkillsStore } from "@ruukoto/agent/managed-skills.ts";
import { subagentOpCheck, subAgentTaskRequestId } from "@ruukoto/agent/subagent-ledger.ts";
import { createSubAgentFamily } from "@ruukoto/agent/subagent-tools.ts";
import { subAgentAccessPolicy } from "@ruukoto/agent/subagent-capabilities.ts";
import { HOST_REVIEW_DEFINITION, SubAgentRoleError, validateSubAgentRole } from "@ruukoto/agent/subagent-roles.ts";
import { requireSubAgentDefinition, SubAgentDefinitionError } from "@ruukoto/core/subagent-definition.ts";
import { createWorkflowFamily } from "@ruukoto/agent/workflow-tools.ts";
import { createTodoFamily, parseTodos } from "@ruukoto/agent/todo.ts";
import { createOwnerQuestionFamily } from "@ruukoto/agent/owner-question-tools.ts";
import { createBackgroundProcessFamily, backgroundProcessForModel } from "@ruukoto/agent/background-process-tools.ts";
import { RuntimeBackgroundProcesses } from "./background-processes.ts";
import { BackgroundProcessError, latestBackgroundReferenceSnapshot, listActiveBackgroundProcesses, pageBackgroundProcesses, type BackgroundProcess, type BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { sessionToolCategories } from "@ruukoto/agent/tool-availability.ts";
import { HostExecutionManager } from "./host-execution.ts";
import { createCodingTools } from "@ruukoto/agent/tool-router.ts";
import { createWebSearchFamily,searchTavily,WebSearchError } from "@ruukoto/agent/web-search.ts";
import { createChatResultFamily } from "@ruukoto/channels/chat-result-tools.ts";
import { resolveAcceptedChatResult } from "@ruukoto/channels/chat-results.ts";
import { retireGitHubModule } from "@ruukoto/channels/github-retirement.ts";
import { GitHubEvents,parseGitHubEventsConfig,webhookSecret,type GitHubEventsConfig } from "@ruukoto/channels/github/events.ts";
import { GITHUB_SOURCE,GitHubWebhook } from "@ruukoto/channels/github/webhook.ts";
import { ImApprovals } from "@ruukoto/channels/im-approvals.ts";
import { ImEntries } from "@ruukoto/channels/im-entries.ts";
import { InboundMediaStore,type InboundMediaMessage } from "@ruukoto/channels/inbound-media.ts";
import { QQ_PRIVATE_SOURCE,QqAdapter,type QqAdapterTimeouts } from "@ruukoto/channels/qq/adapter.ts";
import { QQ_GROUP_SOURCE,QqStore,type QqConfig,type QqInboxRow,type QqOutboxRow } from "@ruukoto/channels/qq/store.ts";
import { SCHEDULER_LEDGER,schedulerOpCheck } from "@ruukoto/channels/scheduler/ledger.ts";
import { Scheduler,type NotifyChannel } from "@ruukoto/channels/scheduler/runtime.ts";
import { SchedulerConflictError,SchedulerStore,type NotificationStatus,type ScheduleRun,type ScheduleStatus } from "@ruukoto/channels/scheduler/store.ts";
import { SERVICE_LEDGER } from "@ruukoto/channels/service-ledger.ts";
import { createSourceResolver,type SourceResolver } from "@ruukoto/channels/source-resolver.ts";
import { TELEGRAM_SOURCE,TelegramAdapter,TelegramStore,type TelegramConfig } from "@ruukoto/channels/telegram/adapter.ts";
import { AccessDeniedError,AccessScope } from "@ruukoto/core/access.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { Db } from "@ruukoto/core/db.ts";
import { getBranchRequest, sourceArtifact } from "@ruukoto/core/branch.ts";
import { finishCompactionRequest, getCompactionRequest, getLatestSessionCompaction, recoverCompactionRequests, reserveCompactionRequest, updateCompactionSource } from "@ruukoto/core/compaction.ts";
import { DirIdentityError,legacyProjectClaimableFromDir,resolveDirIdentity,sameDirIdentity,verifyDirIdentity,type DirIdentity } from "@ruukoto/core/dir-identity.ts";
import { HistoryIndex,searchHistory } from "@ruukoto/core/history-index.ts";
import { searchWorkspaceHistory, type WorkspaceHistorySearchResult, type WorkspaceHistoryCursor } from "@ruukoto/core/history-search.ts";
import { readIndexedHistoryPage, readIndexedHistoryEntryText } from "@ruukoto/core/history-window.ts";
import { setImmediate as yieldHistory } from "node:timers/promises";
import {
  HistoryReadError,
  historyTodoParams,
  parseSessionFile,
  readHistoryEntryText,
  readHistoryPage,
  readToolResult,
  readHistoryPrefix,
  snapshotSessionHistory,
  sliceTextByBytes,
  tailTextByBytes,
  type HistoryEntryView,
  type HistoryPage,
  type HistorySnapshot,
} from "@ruukoto/core/history.ts";
import { acquireConfigLock,acquireInstanceLock,type AcquiredLock } from "@ruukoto/core/instance-lock.ts";
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryStore,
  MemoryValidationError,
  type MemoryWithContent,
} from "@ruukoto/core/memory.ts";
import { parseModelSelection } from "@ruukoto/core/model-selection.ts";
import { cancelOwnerQuestion, consumeOwnerQuestion, createOwnerQuestion, getOwnerQuestion, getOwnerQuestionReceipt, invalidateOwnerQuestionsForTask, listOwnerQuestions, ownerQuestionTaskEligible, ownerQuestionToView, parseOwnerAnswers, type OwnerAnswer, type OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import { sameTarget } from "@ruukoto/core/notify-target.ts";
import { PRODUCT_META_KEY,type ProductType } from "@ruukoto/core/product.ts";
import { CODING_ROLE_RETIRED,CORE_GROUP_CHAT_RETIRED } from "@ruukoto/core/session-identity.ts";
import { Store,StoreConflictError } from "@ruukoto/core/store.ts";
import { bindWorkflowExecution, chargeWorkflow, controlWorkflow, findWorkflowRun, getWorkflowDeliveryRun, getWorkflowExecution, getWorkflowQuestion, getWorkflowReceipt, getWorkflowRunNumber, getWorkflowStep, listWorkflowExecutions, listWorkflowRuns, listWorkflowSteps, recoverWorkflowRuns, requireWorkflowRun, setWorkflowState, startWorkflowExecution, updateWorkflowExecution, updateWorkflowRun, workflowDeliveryKey, workflowDigest, workflowJson, workflowQuestionKey, workflowSlotsUsed, workflowTerminal, WorkflowError, type WorkflowControl, type WorkflowRun, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import { requireSubAgentExecution, requireSubAgentExecutionScope, SubAgentExecutionError } from "@ruukoto/core/subagent-execution.ts";
import { workCopyHostFor } from "@ruukoto/core/work-copy-host.ts";
import { WorkspaceSnapshotError } from "@ruukoto/core/workspace-snapshot.ts";
import { listWorkspaceFiles, readWorkspaceFile } from "./workspace-files.ts";
import { readWorkspaceGit } from "./workspace-git.ts";
import { WorkflowCoordinator, type WorkflowAgentExecutor } from "./workflows.ts";
import { WorkflowSteps } from "./workflow-steps.ts";
import { WorkflowLibrary } from "./workflow-library.ts";
import { workflowLaunchDigest, workflowDefinitionDigest, requireWorkflowInterface, type WorkflowLaunch } from "@ruukoto/core/workflow.ts";
import { validateWorkflowScript } from "@ruukoto/agent/script-worker/validate.ts";
import { branchSession, recoverBranchSessions, type BranchSessionDeps } from "./branch-session.ts";
import type { DataCategory,DataGrant,Memory,MemorySourceRef,MemoryVersion,SelectionRecord } from "@ruukoto/core/types.ts";
import {
  ACTIVE_TASK_STATUSES,
  AGENT_ROLE_IDS,
  isAccessMode,
  isSessionDefaultMode,
  isTerminalTaskStatus,
  normalizeIsoInstant,
  randomId,
  SESSION_DEFAULT_MODES,
  type AccessMode,
  type AgentRoleId,
  type Artifact,
  type ConfirmationRequest,
  type ContextCheckpoint,
  type GrantedPath,
  type InboundEvent,
  type ModelSelection,
  type NotifyTarget,
  type ToolCategory,
  type PersistentEvent,
  type Project,
  type Session,
  type SessionCompactionRequest,
  type SessionDefaultMode,
  type StandingPermission,
  type SubAgent,
  type SubAgentMessage,
  type Task,
  type ToolOp,
  type WorkDelegation
} from "@ruukoto/core/types.ts";
import {
  capEventForWire,
  confirmationToView,
  FRAGMENT_TEXT_CAP,
  frameBytes,
  SEGMENT_DEFAULT_BYTES,
  SEGMENT_MAX_BYTES,
  toolOpToView,
  type BoundedText,
  type ConfirmationRequestView,
  type OutputPreview,
  type TaskView,
  type ToolOpView,
} from "@ruukoto/core/views.ts";
import { GIT_SAFE_DIRECTORY_ENV,grantCoversPath,resolveWorktreeCommonGitDir,taskWorkspaceFor } from "@ruukoto/core/worktree.ts";
import { ParentDelivery, workflowWakeInput, workflowReport } from "@ruukoto/runtime/parent-delivery.ts";
import { RuntimeAgentWait, agentWaitGroupTargets, agentWaitTargetsReady } from "./agent-wait.ts";
import { AgentWaitError, agentWaitView, agentReportKey, bindAgentReportFallback, consumeAgentReport, getAgentReport, registerAgentReport, isAgentReportFallback, isAgentReportParked,
  completeAgentReports, finishAgentReportFallback, invalidateAgentReports, parkAgentReportFallback, transferAgentReportFallbacks, latestAgentReferenceSnapshot, listAgentReports, listAgentWaits, recoverAgentWaits, releaseAgentReports, sameAgentReportSource, startAgentReportFallback,
  type AgentReport, type AgentReportCompletion, type AgentReportTarget, type AgentWaitTarget } from "@ruukoto/core/agent-wait.ts";
import { createAgentWaitFamily } from "@ruukoto/agent/agent-wait-tools.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "@ruukoto/core/types.ts";
import { ImWorkflows } from "@ruukoto/channels/im-workflows.ts";
import { SubAgentDelegationError,SubAgentManager,type WorkCancellation } from "@ruukoto/runtime/subagents.ts";
import { loadSubAgentRoleLibrary } from "./subagent-role-library.ts";
import { applyWorkspaceMigration,previewWorkspaceMigration,type MigrationApplyInput,type MigrationApplyResult,type MigrationPreview,type MigrationPreviewInput } from "@ruukoto/runtime/workspace-migration.ts";
import { createHash,randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Orchestrator, type ChildOutcome } from "./orchestrator.ts";
import { assertWorktreeGrantAllowed,WorkCopyError,WorkCopyManager,type WorkCopyExecutor } from "./work-copy.ts";

/** 快照中每个会话保留的近期已结束任务数（更早的经 list_tasks 分页查询）。 */
const SNAPSHOT_ENDED_TASKS_PER_SESSION = 20;
/** 快照/get_task 中输出预览的字节上限。 */
const FRAGMENT_PREVIEW_CAP = FRAGMENT_TEXT_CAP;

/** 服务代码根目录（本模块位于 <codeRoot>/packages/runtime/src/）。 */
const CODE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** qq_inbox_list 的归档视图行（issue 20）：收件登记 + main 接收账本 + 复核结论。 */
export interface QqInboxArchiveRow extends QqInboxRow {
  acceptance: { acceptedAt: string; acceptedByTaskId: string; reason: string; summary: string } | null;
  sourceProblem: string | null;
}

/** app 注入产品身份与能力；共享运行时按能力装配。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md
 */
export interface RuntimeProduct {
  type: ProductType;
  branchSessions?: boolean;
  manualCompaction?: boolean;
  im: boolean;
  scheduler: boolean;
  serviceEnabled(config: RuntimeConfig): boolean;
  toolFamilies(context: ProductToolContext): readonly HostToolFamily[];
}

export interface ProductToolContext {
  config: RuntimeConfig;
  store: Store;
  artifacts: ArtifactStore;
  sched: SchedulerStore;
  scheduler: Scheduler | null;
  sources: SourceResolver;
  notificationTarget(ctx: import("@ruukoto/agent/host-tool-families.ts").HostToolContext): NotifyTarget | null;
}

export interface RuntimeConfig {
  /** 宿主测试可注入步骤执行器；null 只启用存储与宿主操作测试，默认使用真实 Driver。 */
  workflowAgent?: WorkflowAgentExecutor | null;
  workflowIntegrate?: import("./workflows.ts").WorkflowDeps["integrate"];
  product: RuntimeProduct;
  browser?: Pick<BrowserManagerOptions, "binaryPath" | "chromePath" | "headed" | "noSandbox">;
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
   * 工具执行后端：native（操作系统原生沙箱）| local（仅供库层开发/验证，无隔离）；
   * 完全访问直接使用启动账户。
   * 省略时取 local：只适用于开发与模拟验证，生产部署必须显式配置。
   */
  execution?: ExecutionBackendConfig;
  /** 工作副本执行入口的测试替身；生产由 Runtime 自己装配。 */
  workCopyExecutor?: WorkCopyExecutor;
  /** 默认注册真实编码工具（路由器 + 工具工作进程）；模拟测试可覆盖。 */
  toolFactory?: (ctx: { registry: import("@ruukoto/agent/managed-processes.ts").ManagedProcessRegistry; router: import("@ruukoto/agent/tool-router.ts").ToolRouter }) => ToolDefinition[];
  /** 上下文预算覆盖（默认取模型 contextWindow/maxTokens + 默认预留；测试用小窗口时收紧预留）。 */
  budgetOverrides?: Partial<SelectorBudgetConfig>;
  /** Web Search（issue 20）：Tavily 目标/超时覆盖（仅测试注入；生产缺省官方端点与 15s 超时）。 */
  webSearch?: import("@ruukoto/agent/web-search.ts").WebSearchConfig;
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
   * 入口照常创建但不连接、入站作废（架构工单 10）；qq 控制面操作仍作用于配置存储，qqStatus 标注停用来源。
   */
  qqDisabled?: boolean;
  /**
   * 停用真实 Telegram 通道（issue 04，dev 开发实例经 RUUKOTO_DISABLE_TELEGRAM=1 注入）：
   * 入口照常创建但不轮询、入站作废（架构工单 10）；telegram 控制面操作仍作用于配置存储。
   */
  telegramDisabled?: boolean;
  /** Telegram 入口（issue 04）：长轮询秒数/断线退避覆盖（仅测试注入；生产取默认）。 */
  telegram?: { pollTimeoutSec?: number; backoffMs?: number };
  /** 编排器（issue 01）：超时巡检间隔覆盖（仅测试注入；生产取默认）。 */
  orchestrator?: { deadlineCheckMs?: number };
  /** 应用数据（issue 02）：查询子进程挂点（仅测试注入；生产缺省）。 */
  appData?: { queryStallMs?: number };
  /**
   * 服务器服务管理（agent-direction issue 09）：显式部署配置（受保护
   * helper 与策略路径，生产经环境变量注入，见 deploy/systemd/README.md）。装配
   * 另要求产品 ruukoto + Linux；缺任一条件即无此能力（工具不装配，不是静默放行）。
   * allowNonLinuxPlatform 与 timeouts 仅测试注入（受控 helper 替身的离线协议测试）。
   * Note: 见 .agents/notes/implemented/architecture/2026-10-03-service-management-helper.md
   */
  service?: {
    helperPath: string;
    policyPath: string;
    useSudo?: boolean;
    sudoPath?: string;
    allowNonLinuxPlatform?: boolean;
    timeouts?: { inspectMs?: number; restartMs?: number; stopMs?: number };
  };
  /**
   * 调度器与通知：测试可替换默认 Telegram 渠道，QQ 按操作目标走自身适配器；
   * 未加载发送器时保留 pending。时钟/间隔/发送时限仅测试覆盖。
   */
  scheduler?: { channel?: NotifyChannel; now?: () => number; tickMs?: number; sendTimeoutMs?: number };
  /** 显式可信启动配置，缺省不监听；GitHub 操作仍经通用 MCP。 */
  githubWebhook?: GitHubEventsConfig;
}

export { RuntimeApiError };

class DirOccupiedError extends Error {}
class TaskGoneError extends Error {}

export class Runtime {
  readonly config: RuntimeConfig;
  private readonly db: Db;
  readonly store: Store;
  readonly attachments: OwnerAttachments;
  readonly artifacts: ArtifactStore;
  private browserManager!: BrowserManager;
  private cuaManager!: CodeCuaManager;
  private backgroundProcesses!: RuntimeBackgroundProcesses;
  readonly inboundMedia: InboundMediaStore;
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
  /** QQ owner 私聊入口（启动配置停用时也存在，见 RuntimeConfig.qqDisabled）。 */
  private readonly qqAdapter: QqAdapter;
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
  /**
   * 通用 SubAgent 委派（agent-direction issue 11）：工作委托、动态身份与
   * 执行任务的集中登记；普通开发会话与 main 的委派工具经它提交。
   */
  subagents: SubAgentManager | null = null;
  workflows: WorkflowCoordinator | null = null;
  readonly workflowLibrary: WorkflowLibrary;
  private readonly imWorkflows: ImWorkflows;
  private workflowSteps!: WorkflowSteps;
  hostExecutions!: HostExecutionManager;
  /** Telegram owner 入口配置（issue 04）。 */
  readonly telegramStore: TelegramStore;
  /** Telegram owner 入口（启动配置停用时也存在，见 RuntimeConfig.telegramDisabled）。 */
  private readonly telegram: TelegramAdapter;
  /** 拥有者 IM 入口表（架构工单 10）：门、reconcile、owner 回复与工作汇报、凭据代次、通知目标。 */
  private readonly imEntries: ImEntries;
  private githubWebhook: GitHubWebhook | null = null;
  private readonly githubEvents: GitHubEvents;
  /** 父级送达（架构工单 09）：结果与工作内消息怎样、何时进入主 Agent 的模型调用。 */
  private readonly parentDelivery: ParentDelivery;
  private readonly agentWait: RuntimeAgentWait;
  private readonly reportGroups = new Set<string>();
  /** 调度计划/运行/发送账本（issue 03，核心库三表）。 */
  readonly sched: SchedulerStore;
  /** IM 审批命令处理（agent-direction issue 08）；绑定拥有者的私聊控制消息入口。 */
  private readonly imApprovals: ImApprovals;
  /** 工具操作账本（架构工单 05）：结果、效果未知与停止/重启补记。 */
  private ledger!: ToolOpLedger;
  private hostToolFamilies!: readonly HostToolFamily[];
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
  readonly models: RuntimeModels;
  get defaultSelection(): ModelSelection { return this.models.current.defaultSelection; }
  private drivers = new Map<string, Driver>();
  private loopActive = new Set<string>();
  private loopPromises = new Map<string, Promise<void>>();
  private hostOperationPromises = new Set<Promise<unknown>>();
  private compactions = new Map<string, { request: SessionCompactionRequest; controller: AbortController; promise: Promise<void> }>();
  private wakePending = new Set<string>();
  stopping = false;
  private readonly modeSwitchStopping = new Set<string>();
  private stopPromise: Promise<void> | null = null;
  /** 控制面注入：事件广播与停止回调。 */
  onEventBroadcast: ((events: PersistentEvent[]) => void) | null = null;
  onCloseServer: (() => Promise<void>) | null = null;

  private constructor(config: RuntimeConfig, db: Db, store: Store, lock: AcquiredLock, configLock: AcquiredLock) {
    this.config = config;
    this.productType = config.product.type;
    this.db = db;
    this.store = store;
    this.workflowLibrary = new WorkflowLibrary(store, config.agentDir);
    this.lock = lock;
    this.configLock = configLock;
    this.models = new RuntimeModels({
      store, config,
      countActiveCompactions: providers => [...this.compactions.values()].filter(({ request }) => providers.includes(request.summaryModel.provider)).length,
      publishStack: stack => { for (const driver of this.drivers.values()) driver.updateModelDeps(stack); },
      flushPendingMessages: () => this.subagents?.flushPendingMessages() ?? Promise.resolve(),
    });
    this.artifacts = new ArtifactStore(config.dataDir, store);
    this.attachments = new OwnerAttachments(config.dataDir, store, this.artifacts);
    this.inboundMedia = new InboundMediaStore(config.dataDir, store, this.artifacts);
    this.credentials = new CredentialStore(config.agentDir);
    this.access = new AccessScope(db);
    this.historyIndex = new HistoryIndex(db);
    this.memories = new MemoryStore(db);
    this.mcp = new McpStore(db);
    this.qqStore = new QqStore(db);
    this.sched = new SchedulerStore(store);
    this.telegramStore = new TelegramStore(store);
    // 拥有者 IM 入口（issue 04/06，架构工单 10）：始终创建；启动配置停用（dev 开发实例、
    // ruukoto-code 产品边界）只是入口标志。编排器启动后才连接/轮询（见 start）
    const startupDisabled = config.product.im ? "dev" : "product";
    this.qqAdapter = new QqAdapter({
      store,
      media: this.inboundMedia,
      qqStore: this.qqStore,
      sched: this.sched,
      credentials: this.credentials,
      timeouts: config.qq,
      startupDisabled: config.qqDisabled ? startupDisabled : undefined,
      bridge: {
        registerPrivate: (input) => {
          if (this.stopping || !this.orchestrator) throw new Error("编排器尚未就绪或后台正在停止");
          return this.registerImInbound(QQ_PRIVATE_SOURCE, input);
        },
        dispatchInbound: () => this.orchestrator?.dispatchRegisteredEvents() ?? Promise.resolve(),
        kickSession: (sessionId) => this.kick(sessionId),
      },
    });
    this.telegram = new TelegramAdapter({
      store,
      media: this.inboundMedia,
      tg: this.telegramStore,
      sched: this.sched,
      credentials: this.credentials,
      register: (input) => {
        if (!this.orchestrator) throw new Error("编排器未启动");
        return this.registerImInbound(TELEGRAM_SOURCE, input);
      },
      onOnline: () => {
        void this.orchestrator?.dispatchRegisteredEvents().catch(() => {});
        const main = this.store.getAgentRole("main");
        if (main) this.kick(main.sessionId);
      },
      log: (message) => process.stderr.write(`[ruukoto:telegram] ${message}\n`),
      ...config.telegram,
      startupDisabled: config.telegramDisabled ? startupDisabled : undefined,
    });
    this.imEntries = new ImEntries({
      store,
      sched: this.sched,
      entries: [this.qqAdapter, this.telegram],
      defaultChannel: config.scheduler?.channel,
      readReply: (taskId) => this.readTaskReplyText(taskId),
      cancelTask: (taskId, reason) => this.cancelTask(taskId, { reason }),
      invalidateApprovals: (source) => this.imApprovals.invalidate(source),
      kick: (sessionId) => this.kick(sessionId),
      kickSender: () => this.scheduler?.kickSender(),
    });
    // IM 审批命令（agent-direction issue 08）：绑定拥有者的 QQ/Telegram 私聊
    // 控制消息直接进入审批处理路径，不经编排器派发、不建任务
    this.imApprovals = new ImApprovals({
      store,
      sched: this.sched,
      entry: (source) => this.imEntries.entry(source),
      applyDecision: (confirmation, decision, txExtra) => {
        const driver = this.drivers.get(confirmation.sessionId);
        if (!driver) return false;
        return driver.resolveConfirmation(confirmation.id, decision, { txExtra });
      },
      supersedeApprovals: (sessionId, ids) => this.drivers.get(sessionId)?.supersedeApprovals(ids),
      serviceAvailable: () => config.product.serviceEnabled(config),
      // 长期授权（issue 10）：创建前同步核对部署策略当前修订；无服务管理能力返回 null
      servicePolicyRevision: () => {
        if (!config.product.serviceEnabled(config) || !config.service) return null;
        try {
          return createHash("sha256").update(fs.readFileSync(config.service.policyPath)).digest("hex");
        } catch {
          return null;
        }
      },
      kickSender: () => this.scheduler?.kickSender(),
    });
    this.githubEvents = new GitHubEvents({
      store, artifacts: this.artifacts, sched: this.sched, config: config.githubWebhook,
      target: (channel) => this.imEntries.target(channel),
      readReply: (id, offset, length) => this.readTaskReply(id, offset, length),
      dispatch: () => !this.stopping && this.orchestrator ? this.orchestrator.dispatchRegisteredEvents() : Promise.resolve(),
      capReply: (target, text) => (this.imEntries.entry(target.channel) ?? this.telegram).capReply(text),
    });
    this.parentDelivery = new ParentDelivery({
      store,
      submit: (input) => this.submitInternal(input),
      defaultModelSelection: () => this.defaultSelection,
      readReply: (taskId) => this.readTaskReplyText(taskId),
      isReviewEvent: (event) => this.githubEvents.request(event) !== null,
      resultNotice: (task) => this.githubEvents.notice(task),
      sendWorkReport: (report) => this.imEntries.sendWorkReport(report),
      verifyWorkflowReport: run => this.verifyWorkflowReport(run),
      sendWorkflowReport: report => this.imEntries.sendWorkReport(report),
      reserveAgentReport: report => this.agentWait.reserve(report),
      verifyWork: work => this.subagents!.verifyWorkspace(work),
      verifyTask: task => this.verifySubAgentSource(task),
      verifyAgentReport: report => this.verifyAgentWaitTarget(report.source, report.target) && (Boolean(report.claimTaskId) || !this.agentReportWorkCanceled(report)),
      routeAgentReport: report => this.routeAgentReportGroup(report),
      recordClaimedReport: (task, outcome, reports) => this.recordClaimedAgentReport(task, outcome, reports),
      reportInput: (task, reports) => this.agentReportInput(task, reports),
    });
    this.agentWait = new RuntimeAgentWait({ store,
      source: (target, parent) => this.agentWaitSource(target, parent),
      verify: (source, target) => this.verifyAgentWaitTarget(source, target),
      snapshot: task => {
        const driver = this.drivers.get(task.sessionId);
        if (!driver || driver.currentTaskId !== task.id) throw new AgentWaitError("task_inactive");
        return driver.referenceSnapshot();
      },
      yieldWorkspace: task => this.drivers.get(task.sessionId)?.yieldWorkspace(task.id) ?? Promise.resolve(false),
      subscribe: listener => this.addEventListener(listener), unsubscribe: listener => this.removeEventListener(listener), kick: () => this.kickAll() });
    this.imWorkflows = new ImWorkflows({ store, sched: this.sched, entry: source => this.imEntries.entry(source),
      answer: input => this.answerWorkflowQuestion(input),
      start: (input, origin) => this.startWorkflowOwner({ ...input, sessionId: this.store.getAgentRole("main")!.sessionId }, origin),
      control: input => this.controlWorkflow(input), detail: (...args) => this.getWorkflowDetail(...args),
      logs: (...args) => this.getWorkflowLogs(...args), step: (...args) => this.getWorkflowStep(...args),
      definitions: (...args) => this.workflowLibrary.list(...args), definition: input => this.getWorkflowDefinition(input),
      kickSender: () => this.scheduler?.kickSender() });
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
    const config = this.config.execution ?? { backend: "local" as const };
    return createLauncherFor(config.backend === "native" ? {
      ...config,
      native: { ...config.native, protectedRoots: [...this.protectedRoots(), ...(config.native?.protectedRoots ?? [])] },
    } : config, mode);
  }

  /**
   * 按发起任务模式创建与汇总 worktree，执行宿主固定 Git 命令。
   * 副本与必要共享 Git 目录按操作授予；停止未核实时保留结果与目录占用。
   * Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
   * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
   * Note: 见 .agents/notes/implemented/architecture/2026-10-12-personal-native-sandbox.md
   */
  async executeWorkCopy(input: Parameters<WorkCopyExecutor>[0]): ReturnType<WorkCopyExecutor> {
    if (!input.execution || input.execution.kind === "task") {
      const operation = this.executeOrdinaryWorkCopy(input);
      this.hostOperationPromises.add(operation);
      void operation.finally(() => this.hostOperationPromises.delete(operation)).catch(() => undefined);
      return operation;
    }
    const { ToolWorkerHost } = await import("@ruukoto/agent/tool-worker/host.ts");
    const taskId = input.execution.taskId;
    const workflowHost = input.execution.kind === "workflow-host";
    const parent = this.store.getTask(taskId);
    if (!parent) throw new WorkCopyError("task_ending", "任务执行已结束：工作副本保留，不再执行 Git");
    const assertParent = (): void => {
      if (this.stopping) throw new WorkCopyError("task_ending", "后台正在停止，保留工作副本，不再执行 Git");
      this.hostExecutions.assertActive(taskId);
      if (workflowHost) {
        const execution = getWorkflowExecution(this.store, taskId);
        if (!execution || !this.verifyWorkflowSource(requireWorkflowRun(this.store, execution.runId).source)) throw new WorkCopyError("source_invalid", "工作流来源授权已失效，保留副本与已有结果");
      } else {
        const source = workCopyHostFor(this.store.getTask(taskId)!)!;
        if (source.workId !== input.workId || source.operation !== input.operation || source.parentTaskId !== input.parentTaskId ||
            (input.source && !isDeepStrictEqual(input.source, source.source)) ||
            this.modeSwitchStopping.has(source.parentTaskId) || this.verifyAgentReportSources(source.parentTaskId)) throw new WorkCopyError("source_invalid", "工作副本操作的来源或登记参数已失效，保留已有结果");
      }
    };
    assertParent();
    const launcher = this.launcherFor(parent.accessMode);
    const workspaceStat = fs.statSync(input.workspace);
    const spec = {
      taskId: `${taskId}-${randomId("wt")}`,
      mode: parent.accessMode,
      workspace: input.workspace,
      workspaceIdentity: { dev: workspaceStat.dev, ino: workspaceStat.ino },
      grantedPaths: [
        { path: input.copyDir, access: input.copyAccess ?? "read_write" as const, purpose: "worktree 副本创建或汇总" },
        ...(input.extraGrants ?? []),
      ],
      env: GIT_SAFE_DIRECTORY_ENV,
    };
    const copyReal = fs.realpathSync(input.copyDir);
    const copyStat = fs.statSync(copyReal);
    const acquired = this.store.withTx(() => this.store.tryAcquireOccupancy({
      cwdReal: copyReal, cwdDev: copyStat.dev, cwdIno: copyStat.ino, sessionId: parent.sessionId, taskId: parent.id,
    }) || this.store.listAllOccupancy().some(held => held.taskId === parent.id && grantCoversPath(held.cwdReal, copyReal)));
    if (!acquired) throw new WorkCopyError("busy", "工作副本仍被执行占用或待核实：保留现场，等待执行结束或拥有者核实后恢复队列");
    const host = ToolWorkerHost.create(launcher, spec);
    const entry = {
      kind: "starting" as import("@ruukoto/agent/managed-processes.ts").ManagedUnitKind,
      id: randomId("wt"),
      label: `worktree_${input.operation}:${input.workId}`,
      stop: () => host.stop(),
    };
    const startOpId = randomId("op");
    let opId: string | null = null;
    try {
      this.hostExecutions.register(parent.id, entry);
      this.store.withTx(() => {
        this.store.recordToolIntent({
          id: startOpId, taskId: parent.id, sessionId: parent.sessionId,
          toolName: "worktree_start",
          params: { workId: input.workId, operation: input.operation, workspace: input.workspace, copyDir: copyReal, branch: input.branch, source: input.source ?? null },
        });
      });
    } catch (err) {
      this.store.withTx(() => this.store.releaseOccupancyForDir(parent.id, copyReal));
      throw err;
    }
    let result: Awaited<ReturnType<WorkCopyExecutor>> | null = null;
    let reaped = false;
    try {
      await host.start();
      this.store.withTx(() => this.ledger.recordResult(parent, startOpId, "工作副本执行单元已启动，Git 命令尚未调用", false));
      const identity = host.identity();
      if (identity) Object.assign(entry, identity);
      this.hostExecutions.updateIdentity(parent.id, entry);
      assertParent();
      const gitOpId = opId = randomId("op");
      this.store.withTx(() => this.store.recordToolIntent({
        id: gitOpId, taskId: parent.id, sessionId: parent.sessionId,
        toolName: `worktree_${input.operation}`,
        params: { workId: input.workId, workspace: input.workspace, copyDir: input.copyDir, branch: input.branch, command: input.command, source: input.source ?? null },
      }));
      const reply = await host.call({
        opId: gitOpId,
        sdkCallId: randomId("call"),
        name: "bash",
        params: { command: input.command, timeout: 120 },
        timeoutMs: 150_000,
      });
      const content = reply.content.map((block) => {
        if (typeof block !== "object" || block === null || !("text" in block)) return "";
        return typeof block.text === "string" ? block.text : "";
      }).join("\n").trim();
      result = { isError: reply.isError, ...(reply.errorMessage ? { errorMessage: reply.errorMessage } : {}), content };
      this.store.withTx(() => {
        this.ledger.recordResult(parent, gitOpId, content || reply.errorMessage || "Git 命令已返回空结果", reply.isError);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.withTx(() => {
        if (opId && !result) this.ledger.markEffectUnknown(parent, opId);
        else if (!result) this.ledger.recordResult(parent, startOpId, `已知未执行：Git 命令尚未调用，${message}`, true);
      });
      result ??= { isError: true, errorMessage: message, content: "" };
    } finally {
      reaped = await host.stop();
      const identity = host.identity();
      if (identity && (entry.kind !== identity.kind || entry.id !== identity.id)) {
        Object.assign(entry, identity);
        this.hostExecutions.updateIdentity(parent.id, entry);
      }
    }
    if (!reaped) {
      await this.hostExecutions.stop(parent.id, "interrupted", "tool_process_unreaped");
      throw new WorkCopyError("worker_stop_unverified", "工作副本执行单元退出未核实：父目录占用、工作副本及已收到的 Git 结果均保留，请拥有者核实后恢复队列");
    }
    assertParent();
    return result!;
  }

  private async executeOrdinaryWorkCopy(input: Parameters<WorkCopyExecutor>[0]): ReturnType<WorkCopyExecutor> {
    const parent = this.store.getTask(input.execution?.taskId ?? input.parentTaskId);
    const driver = parent ? this.drivers.get(parent.sessionId) : null;
    const session = parent ? this.store.getSession(parent.sessionId) : null;
    if (!parent || !driver || !session || this.stopping || this.modeSwitchStopping.has(parent.id) ||
        !["running", "awaiting_confirmation"].includes(parent.status) || parent.cancelRequested || this.verifyAgentReportSources(parent.id)) {
      throw new WorkCopyError("task_ending", "来源任务已停止，保留工作副本，不再执行 Git");
    }
    const sourcePath = input.source?.path ?? input.workspace;
    const sourceStat = fs.statSync(sourcePath);
    const source = input.source ?? { path: fs.realpathSync(sourcePath), dev: sourceStat.dev, ino: sourceStat.ino };
    if (fs.realpathSync(source.path) !== source.path || sourceStat.dev !== source.dev || sourceStat.ino !== source.ino ||
        !this.store.listAllOccupancy().some(held => held.taskId === parent.id && grantCoversPath(held.cwdReal, source.path))) {
      throw new WorkCopyError("task_ending", "来源目录未由父任务按真实身份占用，保留现场，不再执行 Git");
    }
    const copyReal = fs.realpathSync(input.copyDir), copyStat = fs.statSync(copyReal);
    const task = this.store.withTx(() => {
      const task = this.store.insertQueuedTask({ sessionId: parent.sessionId, requestId: `work-copy-host:${input.workId}:${input.operation}:${randomId("op")}`,
        input: JSON.stringify({ workId: input.workId, operation: input.operation }), submissionDigest: workflowDigest({ ...input, execution: undefined }),
        modelSelection: null, parentTaskId: parent.id, sourcePermissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: parent.grantedPaths,
        readScope: { paths: [], sourceRefs: [], workCopyHost: { version: 1, parentTaskId: parent.id, workId: input.workId, operation: input.operation, source, units: [], stopVerified: null } } }).task;
      if (!this.store.tryAcquireOccupancy({ cwdReal: copyReal, cwdDev: copyStat.dev, cwdIno: copyStat.ino, sessionId: parent.sessionId, taskId: task.id })) {
        throw new WorkCopyError("busy", "工作副本仍被占用或待核实，保留现场，请等待执行结束或核实后恢复队列");
      }
      this.store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() });
      this.store.appendEvent({ type: "task.started", taskId: task.id, sessionId: task.sessionId }, { taskId: task.id, sessionId: task.sessionId });
      return this.store.getTask(task.id)!;
    });
    try {
      this.hostExecutions.attach(task.id);
      driver.registerManagedProcess(parent.id, { kind: "starting", id: task.id, label: `work-copy-host:${input.operation}:${input.workId}`,
        stop: () => this.hostExecutions.stop(task.id, "interrupted", "source_task_ending") });
      const result = await this.executeWorkCopy({ ...input, parentTaskId: parent.id, execution: { kind: "work-copy-host", taskId: task.id } });
      this.store.withTx(() => this.store.setTaskResult(task.id, JSON.stringify(result), JSON.stringify({ parentTaskId: parent.id, workId: input.workId, operation: input.operation })));
      if (!await this.hostExecutions.stop(task.id, result.isError ? "failed" : "completed", result.errorMessage ?? "")) {
        throw new WorkCopyError("worker_stop_unverified", "宿主执行停止未核实，保留来源与副本占用，请拥有者核实后恢复队列");
      }
      return result;
    } catch (error) {
      const reaped = this.hostExecutions.has(task.id) ? await this.hostExecutions.stop(task.id, "failed", error instanceof WorkCopyError ? error.code : "work_copy_host_failed") : this.store.withTx(() => {
        this.store.setTaskResult(task.id, JSON.stringify({ isError: true, content: "", errorMessage: "宿主登记未完成，执行单元未启动" }), JSON.stringify({ parentTaskId: parent.id }));
        this.store.endTask(task.id, ["running"], "failed", { errorMessage: "work_copy_host_not_attached" });
        const snapshot = workCopyHostFor(this.store.getTask(task.id)!)!;
        this.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?").run(JSON.stringify({ ...task.readScope, workCopyHost: { ...snapshot, stopVerified: true } }), task.id);
        return true;
      });
      if (!reaped && !driver.stoppingManagedProcesses && !this.modeSwitchStopping.has(parent.id)) {
        const ending = driver.currentTaskEnding!;
        // Note: 见 .agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md
        void driver.requestStop(parent, { terminal: "interrupted", reason: "tool_process_unreaped", cancelIntent: false }).catch(async (failure: unknown) => {
          process.stderr.write(`[ruukoto:runtime] 工作副本来源停止收尾失败：${failure instanceof Error ? failure.message : String(failure)}\n`);
          try {
            await endTaskExecution({ store: this.store, ledger: this.ledger, onReleased: () => this.kickAll() }, parent, ending, {
              terminal: "interrupted", reason: "tool_process_unreaped", unreapedReason: "tool_process_unreaped",
            });
          } catch {
            process.stderr.write(`[ruukoto:runtime] 工作副本来源任务 ${parent.id} 的兜底收尾未落盘，保留任务与占用，请拥有者核实后重启恢复\n`);
          }
        });
      }
      throw error;
    }
  }

  static async start(config: RuntimeConfig): Promise<Runtime> {
    const productType = config.product.type;
    // Coding Agent 产品（issue 01）：消息平台连接与个人调度不属于产品边界；
    // 与显式 qqDisabled/telegramDisabled 同源生效（状态视图按产品标注原因）
    const fullConfig: RuntimeConfig = { ...config, execution: config.execution ?? { backend: "local" },
      qqDisabled: config.product.im ? config.qqDisabled : true,
      telegramDisabled: config.product.im ? config.telegramDisabled : true,
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

    try {
      await runtime.models.initialize();
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
    // 个人调度只属于个人 Agent 产品（issue 01）：ruukoto-code 不创建调度器
    if (fullConfig.product.scheduler) {
      runtime.initScheduler();
      runtime.scheduler!.prepareRecovery();
    }
    // 通用 SubAgent 委派（agent-direction issue 11）：子工作目录在 agent-work/
    // 下（保护根之外）；登记事务前的准备与提交后的 kick 由管理器执行
    const worktreeRoot = path.join(path.dirname(path.resolve(fullConfig.dataDir)), "agent-work", "worktrees");
    const workCopies = new WorkCopyManager({
      worktreeRoot,
      protectedRoots: () => runtime.protectedRoots(),
      execute: fullConfig.workCopyExecutor ?? ((input) => runtime.executeWorkCopy(input)),
    });
    runtime.subagents = new SubAgentManager({
      store: runtime.store,
      roles: () => loadSubAgentRoleLibrary(fullConfig.agentDir),
      source: taskId => runtime.workflowSource(taskId, false, true),
      verifySource: source => runtime.verifyWorkflowSource(source),
      preflight: async (source, definition) => (await runtime.getDriver(runtime.store.getSession(source.sessionId)!)).preflightSubAgent(source, definition),
      workRoot: path.join(path.dirname(path.resolve(fullConfig.dataDir)), "agent-work", "sub-agents"),
      workCopies,
      sources: runtime.sources,
      resolveSelection: (selection) => runtime.models.resolveSelection(selection),
      launcherFor: (mode) => runtime.launcherFor(mode),
      defaultModelSelection: () => runtime.defaultSelection,
      kickSession: (sessionId) => runtime.kick(sessionId),
      resumeQueue: (sessionId) => runtime.resumeQueue(sessionId),
      parentDelivery: runtime.parentDelivery,
      cancelTask: (taskId, reason) => runtime.cancelTask(taskId, reason ? { reason } : undefined),
      protectedRoots: () => runtime.protectedRoots(),
      dataDir: fullConfig.dataDir,
    });
    runtime.initHostToolFamilies();
    runtime.workflowSteps = new WorkflowSteps({ store: runtime.store, artifacts: runtime.artifacts, access: runtime.access,
      copies: new WorkCopyManager({ worktreeRoot: path.join(path.dirname(path.resolve(fullConfig.dataDir)), "agent-work", "worktrees"),
        protectedRoots: () => runtime.protectedRoots(), execute: input => runtime.executeWorkCopy(input) }),
      hostOperation: (input, execute) => runtime.workflowHostOperation(input, execute),
      getDriver: session => runtime.getDriver(session), readReply: (taskId, offset, length) => runtime.readTaskReply(taskId, offset, length),
      verifySource: source => runtime.verifyWorkflowSource(source),
      verifySources: (projectId, refs, taskId) => runtime.sources.verify(projectId, refs as import("@ruukoto/channels/scheduler/store.ts").SourceRef[], taskId),
      ...(fullConfig.workflowAgent ? {} : { verifyExecution: (task: Task) => runtime.workflowSteps.assertExecution(task) }),
    });
    runtime.cuaManager.recover();
    await runtime.browserManager.recover();
    await runtime.backgroundProcesses.recover();
    runtime.recover();
    if (fullConfig.workflowAgent !== null) {
      runtime.workflows = new WorkflowCoordinator({ store: runtime.store,
        roles: () => loadSubAgentRoleLibrary(fullConfig.agentDir),
        ledger: runtime.ledger,
        workRoot: path.join(path.dirname(path.resolve(fullConfig.dataDir)), "agent-work", "workflow-agents"),
        source: taskId => runtime.workflowSource(taskId), selection: taskId => runtime.store.getTask(taskId)!.modelSelection!,
        verifySource: source => runtime.verifyWorkflowSource(source), agent: fullConfig.workflowAgent ?? (context => runtime.workflowSteps.agent(context)),
        ...(fullConfig.workflowAgent ? {} : { preflight: async (source, definition, options) => (await runtime.getDriver(runtime.store.getSession(source.sessionId)!)).preflightSubAgent(source, definition, options) }),
        integrate: fullConfig.workflowIntegrate ?? (context => runtime.workflowSteps.integrate(context)),
        verifyResultSources: (run, step) => runtime.workflowSteps.verifyResultSources(run, step),
        ...(fullConfig.workflowAgent ? {} : { verifyExecution: (task: Task) => runtime.workflowSteps.assertExecution(task) }),
        onReleased: () => runtime.kickAll(),
        stopHost: (taskId, reason) => {
          const execution = getWorkflowExecution(runtime.store, taskId);
          return runtime.hostExecutions.stop(taskId, execution && requireWorkflowRun(runtime.store, execution.runId).status === "canceled" ? "canceled" : "interrupted", reason);
        },
      });
      runtime.addEventListener(events => {
        runtime.workflows?.onEvents(events);
        if (events.some(event => event.body.type.startsWith("workflow."))) queueMicrotask(() => {
          if (runtime.stopping) return;
          try { runtime.imWorkflows.sweep(); }
          catch (error) { process.stderr.write(`[ruukoto:workflow] 问题通知登记失败；等待状态保留：${error instanceof WorkflowError ? error.code : "store_failed"}\n`); }
          if (runtime.orchestrator) void runtime.parentDelivery.sweepWorkflows().catch(() => {
            process.stderr.write("[ruukoto:workflow] 最终送达登记失败；原键与运行事实保留供恢复\n");
          });
        });
      });
      runtime.workflows.recover();
    } else {
      runtime.store.withTx(() => {
        recoverWorkflowRuns(runtime.store);
        for (const run of listWorkflowRuns(runtime.store)) {
          if (!workflowTerminal(run.status) && run.status !== "paused" && (run.status === "queued" || run.scriptUnits.length > 0 || listWorkflowExecutions(runtime.store, run.id).some(execution => execution.kind === "agent"))) {
            setWorkflowState(runtime.store, run.id, "paused", "agent_unavailable");
          }
        }
      });
    }
    await recoverBranchSessions(runtime.branchDeps());
    // GitHub 专用模块退役迁移（issue 17）：仅升级后首次启动执行；无旧表直接跳过
    retireGitHubModule({ db: runtime.db, store: runtime.store, artifacts: runtime.artifacts, dataDir: fullConfig.dataDir });
    // 固定角色退役收尾（agent-direction issue 20/23）：只把未终态的行改成终态
    // （排队任务取消、收件跳过、在途发送定 unknown），重复启动幂等不重放
    runtime.retireLegacyRoles();
    // 编排器（issue 01）：引导 main/coding 角色、恢复已登记未建任务的
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
      dispatchScheduled: (event, selection) => runtime.dispatchScheduled(event, selection),
      onInboundTerminal: (event, task, outcome) => {
        if (event.source === "scheduler") return;
        // 未完成归属的图片拒绝只使用媒体账本回执，取消排队任务不再另发 owner 回复。
        if (runtime.inboundMedia.hasMedia(event) && event.taskId !== task.id) return;
        if (event.source === GITHUB_SOURCE) runtime.githubEvents.terminal(event, task, outcome);
        else if (!listAgentReports(runtime.store, { taskId: task.id }).some(report => report.claimTaskId === task.id && report.status === "pending") || !runtime.parentDelivery.reportReady(task)) runtime.imEntries.enqueueOwnerReply(event, task, outcome);
      },
      parentDelivery: runtime.parentDelivery,
      inboundGate: (event) => runtime.inboundGate(event),
      reviewRequest: (event) => runtime.githubEvents.request(event),
      // 宿主固定评审（agent-direction issue 19）：编排器直接调用管理器，不经模型工具。
      // issue 13：SubAgent 执行任务终态与启动恢复时冲刷待投递的工作内消息
      subagents: {
        delegate: (input) => runtime.subagents!.delegate(input),
        resultRecorded: (task) => runtime.subagents!.resultRecorded(task),
        verifyWorkspace: work => runtime.subagents!.verifyWorkspace(work),
        start: () => runtime.subagents!.start(),
        flushPending: (parentSessionId) => runtime.subagents!.flushPendingMessages(parentSessionId),
      },
      resultData: (task, outcome) => runtime.githubEvents.resultData(task, outcome),
      recoverMedia: () => runtime.recoverInboundMedia(),
      prepareMedia: (event, selection) => runtime.prepareInboundMedia(event, selection),
      promoteMedia: (event, task) => {
        if (runtime.inboundMedia.hasMedia(event)) runtime.inboundMedia.promote(event.id, task.id, task.sessionId);
      },
      cleanupMedia: () => runtime.inboundMedia.cleanup(),
    });
    runtime.addEventListener((events) => runtime.orchestrator?.onRuntimeEvents(events));
    await runtime.orchestrator.start();
    // 拥有者 IM 入口（issue 04/06）：编排器启动后才连接 NapCat / 开始轮询（编排器启动
    // 巡检补登 owner 回复要读固定目标）；未配置/未启用时保持断开，不猜测端点
    await runtime.qqAdapter.start();
    runtime.telegram.start();
    // 恢复与角色引导完成后才开放调度事件派发与发送（ruukoto-code 无调度器）
    runtime.scheduler?.start();
    runtime.imWorkflows.sweep();
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

  private workflowSource(taskId: string, ownerControl = false, delegation = false): WorkflowSource {
    const task = this.store.getTask(taskId);
    const session = task ? this.store.getSession(task.sessionId) : null;
    const identity = session ? this.store.getSessionIdentity(session.id) : null;
    const event = task?.sourceEventId ? this.store.getInboundEvent(task.sourceEventId) : null;
    if (this.stopping || !task || !session || !identity || !["dev", "main", "scheduled"].includes(identity.kind) || task.planMode ||
        task.subAgentId || getWorkflowExecution(this.store, task.id) || getWorkflowDeliveryRun(this.store, task.id) || task.cancelRequested || !(delegation ? ["queued", "running", "awaiting_confirmation"] : ["running", "awaiting_confirmation"]).includes(task.status) || !task.modelSelection ||
        (identity.kind === "dev" && (task.parentTaskId || task.sourceEventId)) ||
        (identity.kind === "main" && (event ? ![QQ_PRIVATE_SOURCE, TELEGRAM_SOURCE].includes(event.source) || this.inboundGate(event) !== "run" :
          !ownerControl && !delegation && (task.agentId !== null || task.parentTaskId !== null || task.sourcePermissionVersion !== null)))) throw new WorkflowError("source_forbidden");
    const scheduled = this.store.getScheduledRunForTask(task.id);
    if (scheduled && (scheduled.closedAt || scheduled.scheduleStatus === "canceled")) throw new WorkflowError("source_invalid");
    for (const ref of task.readScope?.sourceRefs ?? []) {
      if (typeof ref !== "object" || ref === null || !("kind" in ref) || !("ref" in ref) || typeof ref.ref !== "string") throw new WorkflowError("source_invalid");
      const id = ref.kind === "task_result" ? ref.ref.slice("task:".length) : ref.kind === "artifact" ? this.store.getArtifact(ref.ref.slice("artifact:".length).split("@")[0])?.taskId : null;
      if (id && getWorkflowExecution(this.store, id)) throw new WorkflowError("cross_run_source");
    }
    return { product: this.productType, projectId: session.projectId, sessionId: session.id, taskId: task.id, permissionVersion: task.permissionVersion,
      accessMode: task.accessMode, grantedPaths: task.grantedPaths, capabilities: sessionToolCategories(identity.kind === "scheduled" ? "main" : identity.kind === "main" ? "main" : "dev"),
      references: task.readScope?.sourceRefs ?? [], replyTarget: scheduled ? this.sched.getSchedule(this.sched.getRun(scheduled.id)!.scheduleId)?.target ?? null : event?.replyTarget ?? null, scheduledRunId: scheduled?.id ?? null,
      authority: { toolClass: identity.kind === "dev" ? "dev" : "main", categories: this.delegationCategories(identity.kind === "dev" ? "dev" : "main"),
        grantIds: this.access.listGrants().filter(grant => grant.toProjectId === session.projectId).map(grant => grant.id),
        configuration: this.workflowConfiguration(session.projectId), workspace: { path: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno } } };
  }

  private delegationCategories(toolClass: "dev" | "main"): ToolCategory[] {
    return [...new Set([...sessionToolCategories(toolClass).filter(category =>
      ["coding", "mcp", "subagent"].includes(category) || this.hostToolFamilies.some(family => family.category === category)), "coding" as const, "mcp" as const])];
  }

  private workflowConfiguration(projectId: string): string {
    const services = this.mcp.listServices(projectId);
    const credentials = this.credentials.list().filter(binding => !this.credentials.get(binding.name)?.scope?.projectId ||
      this.credentials.get(binding.name)?.scope?.projectId === projectId).map(binding => this.credentials.get(binding.name));
    let servicePolicy: string | null = null;
    if (this.config.service) {
      try { servicePolicy = createHash("sha256").update(fs.readFileSync(this.config.service.policyPath)).digest("hex"); }
      catch (cause) { throw new WorkflowError("source_configuration_unavailable", { cause }); }
    }
    return workflowDigest({ services, credentials, webSearch: this.store.getProject(projectId)?.webSearch, searchConfig: this.config.webSearch ?? null,
      execution: this.config.execution, service: this.config.service ?? null, servicePolicy, appInstance: this.appDataStore?.getInstanceId() ?? null });
  }

  private verifyWorkflowSource(source: WorkflowSource, finalReport = false): boolean {
    const task = this.store.getTask(source.taskId);
    const session = this.store.getSession(source.sessionId);
    const identity = this.store.getSessionIdentity(source.sessionId);
    if (this.stopping || source.product !== this.productType || !task || task.sessionId !== source.sessionId || task.permissionVersion !== source.permissionVersion || task.accessMode !== source.accessMode || !isDeepStrictEqual(task.grantedPaths, source.grantedPaths) || !session || session.projectId !== source.projectId ||
        !identity || !["dev", "main", "scheduled"].includes(identity.kind)) return false;
    const event = task.sourceEventId ? this.store.getInboundEvent(task.sourceEventId) : null;
    const scheduled = this.store.getScheduledRunForTask(task.id);
    if (source.replyTarget) {
      if (scheduled) {
        const scheduleRun = this.sched.getRun(scheduled.id);
        const target = scheduleRun ? this.sched.getSchedule(scheduleRun.scheduleId)?.target : null;
        if (!isDeepStrictEqual(target, source.replyTarget) || !isDeepStrictEqual(this.imEntries.target(source.replyTarget.channel), source.replyTarget)) return false;
      } else if (!event || !isDeepStrictEqual(event.replyTarget, source.replyTarget) || typeof this.inboundGate(event) === "object") return false;
    }
    if (source.scheduledRunId && (!scheduled || scheduled.id !== source.scheduledRunId || (!finalReport && scheduled.closedAt) || scheduled.scheduleStatus === "canceled")) return false;
    if (source.authority) {
      const toolClass = identity.kind === "dev" ? "dev" : "main";
      if (source.authority.toolClass !== toolClass || !isDeepStrictEqual(source.authority.categories, this.delegationCategories(toolClass))) return false;
      let configuration: string;
      try { configuration = this.workflowConfiguration(source.projectId); }
      catch { return false; }
      if (source.authority.configuration !== configuration || source.authority.grantIds.some(id => !this.access.getGrant(id) || this.access.getGrant(id)!.revokedAt)) return false;
    }
    if (source.authority) {
      try {
        const workspace = source.authority.workspace, stat = fs.statSync(workspace.path);
        if (fs.realpathSync(workspace.path) !== workspace.path || stat.dev !== workspace.dev || stat.ino !== workspace.ino) return false;
      } catch { return false; }
    }
    return !this.sources.verify(source.projectId, source.references as import("@ruukoto/channels/scheduler/store.ts").SourceRef[]);
  }

  private verifyWorkflowReport(run: WorkflowRun, finalReport = false): boolean {
    const verifySource = (source: WorkflowSource) => this.verifyWorkflowSource(source, finalReport);
    return verifySource(run.source) && listWorkflowSteps(this.store, run.id).every(step => this.workflowSteps.verifyResultSources(run, step, verifySource));
  }

  /** 结果只依赖截至目标执行的历史；身份后来复用不扩大旧报告的冻结依赖。
   * Note: 见 .agents/notes/implemented/architecture/2026-10-15-subagent-source-capabilities.md
   */
  private verifySubAgentSource(task: Task, finalReport = false): string | null {
    try { return this.subAgentSourceProblem(task, finalReport); }
    catch (error) {
      if (!(error instanceof SubAgentExecutionError) && !(error instanceof SubAgentDefinitionError) && !(error instanceof SubAgentRoleError) && !(error instanceof WorkCopyError) &&
          (!(error instanceof WorkspaceSnapshotError) || !["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(error.code))) throw error;
      return error.code;
    }
  }

  private subAgentSourceProblem(task: Task, finalReport: boolean): string | null {
    if (!task.subAgentId) return null;
    const agent = this.store.getSubAgent(task.subAgentId), session = this.store.getSession(task.sessionId);
    if (!agent || !session || agent.sessionId !== task.sessionId || this.store.getSessionIdentity(task.sessionId)?.kind !== "subagent") return "subagent_source_invalid";
    const definition = validateSubAgentRole(requireSubAgentDefinition(agent));
    const history = (this.store.db.prepare("SELECT id FROM tasks WHERE session_id = ? AND rowid <= (SELECT rowid FROM tasks WHERE id = ?) ORDER BY rowid").all(task.sessionId, task.id) as { id: string }[]).map(row => row.id);
    const dependencies = getAgentReport(this.store, agentReportKey({ kind: "task", taskId: task.id }))?.dependencyTaskIds ?? history;
    if (!history.includes(task.id) || !isDeepStrictEqual(dependencies, history)) return "execution_corrupt";
    for (const id of dependencies) {
      const previous = this.store.getTask(id), work = previous?.workId ? this.store.getWorkDelegation(previous.workId) : null;
      if (!previous || previous.subAgentId !== agent.id || previous.sessionId !== session.id || !work || work.parentSessionId !== agent.parentSessionId) return "subagent_source_invalid";
      this.subagents!.verifyWorkspace(work);
      if (definition.kind === "host_review") {
        const event = previous.sourceEventId ? this.store.getInboundEvent(previous.sourceEventId) : null;
        const origin = this.store.getTask(work.originTaskId);
        if (definition.digest !== HOST_REVIEW_DEFINITION.digest || !event || event.source !== GITHUB_SOURCE || !this.githubEvents.request(event) ||
            this.inboundGate(event) !== "run" || origin?.sourceEventId !== event.id || origin.sessionId !== work.parentSessionId ||
            previous.parentTaskId !== origin.id || previous.accessMode !== "confirm" || origin.accessMode !== "confirm" ||
            previous.sourcePermissionVersion !== origin.permissionVersion) return "subagent_source_invalid";
        continue;
      }
      const scope = requireSubAgentExecutionScope(previous.readScope), saved = scope.execution;
      if (previous.sourceEventId || saved.roleDigest !== definition.digest || saved.accessMode !== previous.accessMode ||
          saved.source.sessionId !== work.parentSessionId || saved.source.projectId !== session.projectId ||
          definition.tools?.some(name => !saved.tools.includes(name)) || !this.verifyWorkflowSource(saved.source, finalReport)) return "subagent_source_invalid";
      const policy = subAgentAccessPolicy(saved.source.accessMode, definition);
      if ((saved.accessMode === "full_access" && policy.accessMode !== "full_access") || (saved.accessMode === "auto-review" && policy.accessMode === "confirm") ||
          (policy.protectSource && !saved.protectSource) || (saved.protectSource && saved.accessMode === "full_access")) return "execution_binding_invalid";
      if (!previous.requestId.startsWith("smsg:") && previous.parentTaskId !== saved.source.taskId) return "execution_binding_invalid";
      if (previous.requestId.startsWith("smsg:")) {
        const message = this.store.getSubAgentMessage(previous.requestId.slice("smsg:".length));
        if (!message || message.workId !== work.id || message.toSubAgentId !== agent.id || previous.parentTaskId !== message.fromTaskId) return "execution_binding_invalid";
      }
      const memories = this.store.db.prepare("SELECT json_extract(body, '$.memoryId') AS id FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'task.memory_accessed'").all(previous.id) as { id: string }[];
      if (memories.some(memory => !scope.readMemories.includes(memory.id))) return "execution_corrupt";
      if (this.sources.verify(saved.source.projectId, scope.sourceRefs as import("@ruukoto/channels/scheduler/store.ts").SourceRef[], previous.id)) return "subagent_materials_revoked";
      if (scope.readMemories.some(memoryId => this.memories.getMemory(memoryId)?.status !== "active")) return "subagent_memory_revoked";
      for (const op of this.store.listToolOpsByTask(previous.id)) {
        if (Array.isArray(op.params.source_refs) && this.sources.verify(saved.source.projectId, op.params.source_refs as import("@ruukoto/channels/scheduler/store.ts").SourceRef[], previous.id)) return "subagent_materials_revoked";
        if (op.toolName === "memory_read" && typeof op.params.memory_id === "string" && this.memories.getMemory(op.params.memory_id)?.status !== "active") return "subagent_memory_revoked";
      }
    }
    return null;
  }

  private subAgentOriginalSource(work: WorkDelegation): WorkflowSource {
    const row = this.store.db.prepare("SELECT id FROM tasks WHERE work_id = ? ORDER BY rowid LIMIT 1").get(work.id) as { id: string } | undefined;
    const first = row ? this.store.getTask(row.id) : null;
    const source = requireSubAgentExecutionScope(first?.readScope).execution.source;
    if (!first || first.subAgentId !== work.subAgentId || first.parentTaskId !== work.originTaskId || source.taskId !== work.originTaskId || source.sessionId !== work.parentSessionId) throw new SubAgentExecutionError("execution_binding_invalid");
    return source;
  }

  private agentWaitSource(target: AgentWaitTarget, parent: Task): WorkflowSource {
    const identity = this.store.getSessionIdentity(parent.sessionId);
    if (!identity || !["dev", "main", "scheduled"].includes(identity.kind) || parent.subAgentId ||
        getWorkflowExecution(this.store, parent.id) || getWorkflowDeliveryRun(this.store, parent.id) || isAgentReportFallback(this.store, parent.id)) throw new AgentWaitError("source_forbidden");
    let source: WorkflowSource;
    if (target.kind === "workflow") {
      source = requireWorkflowRun(this.store, target.runId).source;
    } else {
      const child = this.store.getTask(target.taskId), work = child?.workId ? this.store.getWorkDelegation(child.workId) : null;
      const origin = work ? this.store.getTask(work.originTaskId) : null;
      const session = origin ? this.store.getSession(origin.sessionId) : null;
      if (!child?.subAgentId || !work || !origin || !session || work.parentSessionId !== parent.sessionId) throw new AgentWaitError("target_invalid");
      const prior = listAgentWaits(this.store, { sessionId: parent.sessionId }).find(wait => wait.targets.some(item => item.kind === "task" && item.taskId === child.id));
      let original: WorkflowSource;
      try { original = this.subAgentOriginalSource(work); }
      catch (error) {
        if (!(error instanceof SubAgentExecutionError)) throw error;
        throw new AgentWaitError("source_invalid");
      }
      if (prior && !isDeepStrictEqual(prior.source, original)) throw new AgentWaitError("source_invalid");
      source = prior?.source ?? original;
    }
    if (source.sessionId !== parent.sessionId || !this.verifyAgentWaitTarget(source, target)) throw new AgentWaitError("source_invalid");
    const scheduled = this.store.getScheduledRunForTask(parent.id);
    const event = parent.sourceEventId ? this.store.getInboundEvent(parent.sourceEventId) : null;
    if (source.scheduledRunId !== (scheduled?.id ?? null) || (!source.scheduledRunId && !isDeepStrictEqual(source.replyTarget, event?.replyTarget ?? null))) throw new AgentWaitError("reply_target_mismatch");
    return source;
  }

  private verifyAgentWaitTarget(source: WorkflowSource, target: AgentWaitTarget | AgentReportTarget, finalReport = false): boolean {
    if (!this.verifyWorkflowSource(source, finalReport)) return false;
    if (target.kind === "workflow") {
      const run = requireWorkflowRun(this.store, target.runId);
      return run.source.taskId === source.taskId && (!("terminalVersion" in target) || target.terminalVersion === run.terminalVersion) && this.verifyWorkflowReport(run, finalReport);
    }
    const child = this.store.getTask(target.taskId);
    let work: WorkDelegation | null;
    try { work = child?.workId ? this.store.getWorkDelegation(child.workId) : null; }
    catch (error) {
      if (!(error instanceof WorkspaceSnapshotError) || !["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(error.code)) throw error;
      return false;
    }
    if (!child || !work || work.originTaskId !== source.taskId || work.parentSessionId !== source.sessionId) return false;
    try {
      return isDeepStrictEqual(source, this.subAgentOriginalSource(work)) && this.verifySubAgentSource(child, finalReport) === null;
    } catch (error) {
      if (!(error instanceof SubAgentExecutionError)) throw error;
      return false;
    }
  }

  private verifyAgentReportSources(taskId: string, finalReport = false): string | null {
    const current = this.store.getTask(taskId);
    if (current && ["main", "scheduled"].includes(this.store.getSessionIdentity(current.sessionId)?.kind ?? "")) {
      let child: Task | null = null;
      if (current.requestId.startsWith("wake:")) {
        child = this.store.getTask(current.requestId.slice("wake:".length));
        if (!child || current.parentTaskId !== child.id || (child.subAgentId
          ? !child.workId || this.store.getWorkDelegation(child.workId)?.parentSessionId !== current.sessionId
          : !child.parentTaskId || this.store.getTask(child.parentTaskId)?.sessionId !== current.sessionId)) return "subagent_source_invalid";
      } else if (current.requestId.startsWith("smsg:")) {
        const message = this.store.getSubAgentMessage(current.requestId.slice("smsg:".length));
        child = message ? this.store.getTask(message.fromTaskId) : null;
        if (!message || message.parentSessionId !== current.sessionId || message.toSubAgentId || !child || current.parentTaskId !== child.id ||
            child.workId !== message.workId || child.subAgentId !== message.fromSubAgentId) return "subagent_source_invalid";
      }
      if (child) {
        const problem = this.verifySubAgentSource(child, finalReport);
        if (problem) return problem;
      }
    }

    for (const wait of listAgentWaits(this.store, { taskId })) {
      const task = this.store.getTask(taskId);
      if (!task || task.permissionVersion !== wait.snapshot.permissionVersion || wait.targets.some(target => !this.verifyAgentWaitTarget(wait.source, target, finalReport))) return "agent_wait_source_invalid";
    }
    let reports: AgentReport[];
    try { reports = this.agentReportReferences(taskId); }
    catch (error) {
      if (error instanceof HistoryReadError || error instanceof AgentWaitError) return "agent_report_input_invalid";
      throw error;
    }
    for (const report of reports) {
      if (!this.verifyAgentWaitTarget(report.source, report.target, finalReport)) return "agent_report_source_invalid";
      if (report.fallbackTaskId === taskId && this.agentReportWorkCanceled(report)) return "agent_report_work_canceled";
    }
    return null;
  }

  private agentReportWorkCanceled(report: AgentReport): boolean {
    if (report.target.kind !== "task") return false;
    const child = this.store.getTask(report.target.taskId);
    return Boolean(child?.workId && this.store.getWorkDelegation(child.workId)?.canceledAt);
  }

  private conversationAdmitted(task: Task): boolean {
    if (task.subAgentId || getWorkflowExecution(this.store, task.id)) return false;
    return Boolean(getWorkflowDeliveryRun(this.store, task.id) || isAgentReportFallback(this.store, task.id) || latestBackgroundReferenceSnapshot(this.store, task.sessionId) || latestAgentReferenceSnapshot(this.store, task.sessionId));
  }

  private async acquireAgentResources(task: Task): Promise<boolean> {
    const current = this.store.getTask(task.id), session = this.store.getSession(task.sessionId);
    if (!current || !session || current.cancelRequested || !["running", "awaiting_confirmation"].includes(current.status) || this.verifyAgentReportSources(task.id)) throw new AgentWaitError("source_invalid");
    const workspace = taskWorkspaceFor({ session, work: current.workId ? this.store.getWorkDelegation(current.workId) : null });
    const blocking = this.store.findBlockingOccupancy(workspace.path, workspace.dev, workspace.ino);
    if (blocking?.taskId === null) throw new BackgroundProcessError("background_directory_occupied", "会话后台持有目录；先 process_stop，再用 process_status 核实 stopped，停止未核实时报告拥有者。");
    const verified = await verifyDirIdentity({ cwd: workspace.path, cwdReal: workspace.path, dev: workspace.dev, ino: workspace.ino });
    const acquired = this.store.withTx(() => {
      const fresh = this.store.getTask(task.id);
      if (!fresh || fresh.cancelRequested || fresh.permissionVersion !== current.permissionVersion || !["running", "awaiting_confirmation"].includes(fresh.status) || this.verifyAgentReportSources(task.id)) throw new AgentWaitError("source_invalid");
      const held = this.store.getOccupancyByDir(workspace.path);
      return held?.taskId === task.id || this.store.tryAcquireOccupancy({ cwdReal: workspace.path, cwdDev: verified.dev, cwdIno: verified.ino, sessionId: task.sessionId, taskId: task.id });
    });
    if (!acquired) return false;
    await verifyDirIdentity({ cwd: workspace.path, cwdReal: workspace.path, dev: workspace.dev, ino: workspace.ino });
    if (this.store.getTask(task.id)?.permissionVersion !== current.permissionVersion || this.verifyAgentReportSources(task.id)) throw new AgentWaitError("source_invalid");
    return true;
  }

  private agentTaskEntries(task: Task): ReturnType<typeof parseSessionFile> {
    const file = this.store.getSession(task.sessionId)?.sessionFile;
    if (!file) return [];
    const entries = parseSessionFile(file);
    const start = entries.findIndex(entry => entry.type === "custom" && entry.customType === TASK_START_MARKER && (entry.data as { taskId?: string } | undefined)?.taskId === task.id);
    const nextBoundary = entries.findIndex((entry, index) => index > start && entry.type === "custom" && (entry.customType === TASK_START_MARKER || entry.customType === TASK_END_MARKER));
    return start < 0 ? [] : entries.slice(start + 1, nextBoundary < 0 ? undefined : nextBoundary);
  }

  /** 报告权释放后仍从保护历史重建实际输入闭包，旧消费归属不会把资料从新主轮解绑。 */
  private agentReportReferences(taskId: string): AgentReport[] {
    const reports = new Map(listAgentReports(this.store, { taskId }).map(report => [report.key, report]));
    const claimed = this.store.db.prepare("SELECT DISTINCT json_extract(body, '$.key') AS report_key FROM events WHERE task_id = ? AND json_extract(body, '$.type') = 'agent_report.changed'")
      .all(taskId) as { report_key: string }[];
    for (const item of claimed) {
      const report = getAgentReport(this.store, item.report_key);
      if (!report) throw new AgentWaitError("report_input_reference_missing");
      reports.set(report.key, report);
    }
    const task = this.store.getTask(taskId), waits = listAgentWaits(this.store, { taskId });
    if (!task || !waits.length) return [...reports.values()];
    const inputKeys = new Set<string>(), consumedInputs = new Map<string, Set<string>>();
    for (const entry of this.agentTaskEntries(task)) {
      const message = entry.message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
      if (entry.type !== "message" || message?.role !== "toolResult" || message.toolName !== "agent_wait" || !waits.some(wait => wait.sdkCallId === message.toolCallId) || message.isError) continue;
      let result: import("@ruukoto/agent/agent-wait-tools.ts").AgentWaitResult;
      try { result = JSON.parse(message.content!.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")) as import("@ruukoto/agent/agent-wait-tools.ts").AgentWaitResult; }
      catch { throw new AgentWaitError("report_input_invalid"); }
      if (!result || typeof result !== "object" || !Array.isArray(result.targets)) throw new AgentWaitError("report_input_invalid");
      if (result.reportTargets !== undefined && (result.reason !== "result" || !Array.isArray(result.reportTargets) || result.reportTargets.length > 20)) throw new AgentWaitError("report_input_invalid");
      if (result.reason !== "result") continue;
      const accepted = new Set<string>();
      for (const target of [...result.targets, ...(result.reportTargets ?? [])]) {
        if (!result.reportTargets?.includes(target) && (target?.reportOwnerTaskId !== taskId || typeof target.resultSummary !== "string")) continue;
        if (!target || (target.kind !== "task" && target.kind !== "workflow") || target.reportOwnerTaskId !== taskId || typeof target.resultSummary !== "string" ||
          (target.kind === "task" ? typeof target.taskId !== "string" : typeof target.runId !== "string" || typeof target.terminalVersion !== "number")) throw new AgentWaitError("report_input_invalid");
        const identity = target.kind === "task" ? target : { ...target, terminalVersion: target.terminalVersion! };
        const report = getAgentReport(this.store, agentReportKey(identity));
        if (!report || report.parentSessionId !== task.sessionId || !waits.some(wait => wait.sdkCallId === message.toolCallId &&
          sameAgentReportSource(wait.source, report.source))) throw new AgentWaitError("report_input_reference_missing");
        reports.set(report.key, report);
        accepted.add(report.key);
        if (result.reportTargets?.includes(target)) inputKeys.add(report.key);
      }
      consumedInputs.set(entry.id, accepted);
    }
    if ([...reports.values()].some(report => report.fallbackTaskId !== taskId && report.consumption?.taskId === taskId &&
        !consumedInputs.get(report.consumption.entryId)?.has(report.key))) throw new AgentWaitError("report_input_missing");
    if (isTerminalTaskStatus(task.status) && [...reports.values()].some(report => report.fallbackTaskId !== taskId && report.consumption &&
        report.consumption.taskId !== taskId && !inputKeys.has(report.key))) throw new AgentWaitError("report_input_missing");
    return [...reports.values()];
  }

  private agentReportInput(task: Task, reports: AgentReport[]): AgentReportCompletion["reportInput"] | null {
    if (!reports.some(report => report.consumption && report.consumption.taskId !== task.id)) return null;
    const calls = listAgentWaits(this.store, { taskId: task.id }).filter(wait => wait.reason === "result").map(wait => wait.sdkCallId);
    for (const entry of this.agentTaskEntries(task)) {
      const message = entry.message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
      if (entry.type !== "message" || message?.role !== "toolResult" || message.toolName !== "agent_wait" || !calls.includes(message.toolCallId ?? "") || message.isError) continue;
      const result = JSON.parse(message.content!.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")) as import("@ruukoto/agent/agent-wait-tools.ts").AgentWaitResult;
      const group = result.reportTargets;
      if (result.reason === "result" && group && group.length <= 20 && group.length === reports.length && reports.every(report => group.some(target =>
        target.reportOwnerTaskId === task.id && target.resultSummary !== null && target.resultSummary !== undefined && target.kind === report.target.kind &&
        (target.kind === "task" && report.target.kind === "task" ? target.taskId === report.target.taskId : target.kind === "workflow" && report.target.kind === "workflow" && target.runId === report.target.runId && target.terminalVersion === report.target.terminalVersion)))) return { entryId: entry.id, keys: reports.map(report => report.key) };
    }
    return null;
  }

  private acceptAgentWaitResults(task: Task): void {
    if (this.verifyAgentReportSources(task.id)) throw new AgentWaitError("source_invalid");
    const reports = listAgentReports(this.store, { taskId: task.id });
    if (!reports.some(report => report.status === "pending" && !report.consumption)) return;
    const taskEntries = this.agentTaskEntries(task);
    const fallbackReports = reports.filter(report => report.fallbackTaskId === task.id && report.status === "pending" && !report.consumption);
    if (fallbackReports.length) {
      const input = taskEntries.find(entry => entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user");
      const group = taskEntries.find(entry => entry.type === "custom" && entry.customType === "ruukoto_agent_report_context" && (entry.data as { taskId?: string } | undefined)?.taskId === task.id);
      const proof = group ?? input;
      if (!proof) throw new AgentWaitError("report_input_missing");
      for (const report of fallbackReports) consumeAgentReport(this.store, report.key, { taskId: task.id, entryId: proof.id });
    }
    for (const wait of listAgentWaits(this.store, { taskId: task.id })) {
      if (wait.reason !== "result") continue;
      const results = taskEntries.filter(item => {
        const message = item.message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean } | undefined;
        return item.type === "message" && message?.role === "toolResult" && message.toolName === "agent_wait" && message.toolCallId === wait.sdkCallId && !message.isError;
      });
      for (const entry of results) {
        const message = entry.message as { content: { type: string; text?: string }[] };
        const result = JSON.parse(message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")) as import("@ruukoto/agent/agent-wait-tools.ts").AgentWaitResult;
        if (result.reason !== "result") continue;
        const delivered = [...result.targets, ...(result.reportTargets ?? [])].filter(target => target.resultSummary !== null && target.resultSummary !== undefined && target.reportOwnerTaskId === task.id);
        for (const report of listAgentReports(this.store, { taskId: task.id }).filter(report => report.claimTaskId === task.id && !report.consumption)) {
          const target = report.target;
          if (delivered.some(item => item.kind === target.kind && (item.kind === "task" && target.kind === "task" ? item.taskId === target.taskId : item.kind === "workflow" && target.kind === "workflow" && item.runId === target.runId && item.terminalVersion === target.terminalVersion))) consumeAgentReport(this.store, report.key, { taskId: task.id, entryId: entry.id });
        }
      }
    }
  }

  private recordClaimedAgentReport(task: Task, outcome: ChildOutcome, reports: AgentReport[]): AgentReportCompletion {
    const reply = this.readTaskReply(task.id, 0, 64 * 1024);
    const problem = this.verifyAgentReportSources(task.id);
    if (outcome !== "completed" || problem || !reply) return { status: "undelivered", reason: problem ?? "parent_report_missing" };
    const reportInput = reports.some(report => report.claimTaskId === task.id) ? this.agentReportInput(task, reports) : null;
    if (reports.some(report => report.claimTaskId === task.id && report.consumption && report.consumption.taskId !== task.id) && !reportInput) return { status: "undelivered", reason: "report_input_missing" };
    const source = reports[0].source;
    if (!source.replyTarget || source.scheduledRunId) return { status: "reported", entryId: reply.entryId, ...(reportInput ? { reportInput } : {}) };
    const origin = this.store.getTask(source.taskId), event = task.sourceEventId ? this.store.getInboundEvent(task.sourceEventId) : null;
    const originalEvent = origin?.sourceEventId ? this.store.getInboundEvent(origin.sourceEventId) : null;
    if (!originalEvent || (event ? !event.replyTarget || !sameTarget(event.replyTarget, source.replyTarget) : reports.some(report => report.fallbackTaskId !== task.id))) return { status: "undelivered", reason: "reply_target_mismatch" };
    const workflow = getWorkflowDeliveryRun(this.store, task.id);
    const child = task.requestId.startsWith("wake:") ? this.store.getTask(task.requestId.slice("wake:".length)) : null;
    const key = event?.id ?? `${originalEvent.id}#${workflow ? workflowDeliveryKey(workflow) : child?.workId ? `work:${child.workId}:${child.id}` : `agent-final:${task.requestId}`}`;
    const facts = reports.map(report => {
      if (report.target.kind === "workflow") {
        const run = requireWorkflowRun(this.store, report.target.runId), steps = listWorkflowSteps(this.store, run.id), executions = listWorkflowExecutions(this.store, run.id);
        const stop = run.scriptStopVerified === false || executions.some(execution => execution.stopVerified === false) ? "停止未核实"
          : (run.scriptUnits.length === 0 || run.scriptStopVerified === true) && executions.every(execution => execution.status === "queued" || execution.stopVerified === true) ? "停止已核实" : "停止核实待完成";
        return `工作流 ${run.id}：${run.status}${run.reason ? `（${run.reason}）` : ""}；步骤 ${steps.filter(step => step.status === "completed").length}/${steps.length} 完成；${stop}${executions.some(execution => this.store.getTask(execution.taskId)?.effectUnknown) ? "；操作效果未知" : ""}`;
      }
      const child = this.store.getTask(report.target.taskId)!;
      return `子任务 ${child.id}：${child.status}${this.store.listAllOccupancy().some(held => held.taskId === child.id) ? "；停止未核实" : "；停止已核实"}${child.effectUnknown ? "；操作效果未知" : ""}`;
    }).join("\n");
    const sent = this.imEntries.sendWorkReport({ event: originalEvent, wakeTaskId: task.id, key, text: `${facts}\n${reply.text}` });
    const op = this.sched.findOpBySource("owner_reply", key);
    return sent && op ? { status: "reported", entryId: reply.entryId, outboxOpId: op.id, ...(reportInput ? { reportInput } : {}) }
      : { status: "undelivered", reason: "report_enqueue_failed", ...(reportInput ? { reportInput } : {}) };
  }

  private async routeAgentReportGroup(report: AgentReport): Promise<boolean> {
    const waits = listAgentWaits(this.store, { sessionId: report.parentSessionId });
    const first = waits.find(wait => wait.targets.some(target => target.kind === report.target.kind &&
      (target.kind === "task" && report.target.kind === "task" ? target.taskId === report.target.taskId : target.kind === "workflow" && report.target.kind === "workflow" && target.runId === report.target.runId)));
    if (!first) return false;
    const parent = this.store.getTask(first.taskId);
    if (parent && ["running", "awaiting_confirmation"].includes(parent.status)) return true;
    const key = `agent-final:${first.taskId}`;
    if (this.reportGroups.has(key)) return true;
    const targets = agentWaitGroupTargets(this.store, first.taskId);
    if (!agentWaitTargetsReady(this.store, targets)) {
      const queued = listAgentReports(this.store).filter(item => item.status === "pending" && targets.some(target => target.kind === item.target.kind &&
        (target.kind === "task" && item.target.kind === "task" ? target.taskId === item.target.taskId : target.kind === "workflow" && item.target.kind === "workflow" && target.runId === item.target.runId)) &&
        item.fallbackTaskId && !item.claimTaskId && ["queued", "parked"].includes(item.fallbackState ?? ""));
      this.store.withTx(() => { for (const id of new Set(queued.map(item => item.fallbackTaskId!))) parkAgentReportFallback(this.store, id, "group_waiting"); });
      return true;
    }
    this.reportGroups.add(key);
    try {
      const reports = this.store.withTx(() => {
        if (targets.some(target => !this.verifyAgentWaitTarget(first.source, target))) {
          const existing = listAgentReports(this.store, { parentSessionId: first.sessionId }).filter(item => targets.some(target => target.kind === item.target.kind &&
            (target.kind === "task" && item.target.kind === "task" ? target.taskId === item.target.taskId : target.kind === "workflow" && item.target.kind === "workflow" && target.runId === item.target.runId)));
          invalidateAgentReports(this.store, existing.map(item => item.key), "source_invalid");
          return [];
        }
        return targets.map(target => {
          const identity = target.kind === "task" ? target : { ...target, terminalVersion: requireWorkflowRun(this.store, target.runId).terminalVersion! };
          return registerAgentReport(this.store, { target: identity, source: first.source, parentSessionId: first.sessionId });
        });
      }).filter(item => item.status === "pending");
      if (!reports.length) return true;
      const invalid = reports.some(item => !this.verifyAgentWaitTarget(item.source, item.target));
      const canceled = !invalid && reports.some(item => this.agentReportWorkCanceled(item));
      if (invalid || canceled) {
        this.store.withTx(() => invalidateAgentReports(this.store, reports.map(item => item.key), canceled ? "work_canceled" : "source_invalid"));
        return true;
      }
      if (reports.some(item => item.claimTaskId)) return true;
      if (reports.some(item => item.fallbackState === "running" || item.fallbackState === "completed")) return false;
      const canonical = reports.map(item => item.fallbackTaskId).find(id => id !== null);
      if (canonical) {
        this.store.withTx(() => transferAgentReportFallbacks(this.store, reports.map(item => item.key), canonical));
        this.kick(report.parentSessionId);
        return true;
      }
      const source = first.source, origin = this.store.getTask(source.taskId)!;
      const identity = this.store.getSessionIdentity(source.sessionId)!;
      const input = "[后台工作最终回报]\n" + reports.map(item => item.target.kind === "workflow"
        ? workflowReport(this.store, requireWorkflowRun(this.store, item.target.runId)).text
        : `子任务 ${item.target.taskId}：${this.store.getTask(item.target.taskId)!.status}\n${this.store.getTask(item.target.taskId)!.resultSummary}`).join("\n\n") +
        "\n按上述已记录事实和会话结果给出一次最终总结，明确失败、取消、未知效果与停止未核实；本轮只汇总，不执行新的工作。";
      await this.submitInternal({ sessionId: source.sessionId, requestId: key, input, modelSelection: origin.modelSelection ?? this.defaultSelection,
        accessMode: source.accessMode, grantedPaths: source.grantedPaths, agentId: identity.kind === "main" ? identity.role.id : null,
        parentTaskId: source.taskId, sourcePermissionVersion: source.permissionVersion, reportKeys: reports.map(item => item.key) });
      return true;
    } finally { this.reportGroups.delete(key); }
  }

  /** 拥有者查询持久事实；大问题/回答以 UTF-8 字节分页，授权快照不从 wire 回填。 */
  getWorkflowDetail(runId: string, stepOffset = 0) {
    const run = chargeWorkflow(requireWorkflowRun(this.store, runId), Date.now());
    const steps = listWorkflowSteps(this.store, runId), executions = listWorkflowExecutions(this.store, runId);
    const stopped = run.status === "paused" || workflowTerminal(run.status);
    const stopUnverified = run.scriptStopVerified === false || (stopped && run.scriptUnits.length > 0 && run.scriptStopVerified !== true) ||
      executions.some(execution => execution.stopVerified === false || (stopped && (execution.status === "running" || (execution.status === "finished" && execution.stopVerified !== true))));
    return { run: { id: run.id, sessionId: run.source.sessionId, definitionId: run.definitionId, scriptDigest: run.scriptDigest, inputDigest: run.inputDigest,
      number: getWorkflowRunNumber(this.store, run.id),
      displayName: run.displayName ?? `未命名工作流 ${run.createdAt}`, description: run.description ?? null, createdAt: run.createdAt,
      stopUnverified, effectUnknown: run.reason === "effect_unknown" || executions.some(execution => this.store.getTask(execution.taskId)?.effectUnknown),
      status: run.status, version: run.version, reason: run.reason, attempts: run.attempts, maxAttempts: run.maxAttempts,
      usedMs: run.usedMs, durationMs: run.durationMs, clockVerified: run.clockVerified, scriptStopVerified: run.scriptStopVerified, terminalVersion: run.terminalVersion,
      delivery: run.delivery ? { version: run.delivery.version, taskId: run.delivery.taskId, status: run.delivery.status, reason: run.delivery.reason } : undefined },
    steps: steps.slice(stepOffset, stepOffset + 100).map(step => ({ key: step.key, kind: step.kind, status: step.status, resultRecorded: step.resultRecorded, attempts: step.attempts,
      question: getWorkflowQuestion(this.store, runId, step.key)?.status ?? null, outputArtifact: step.outputArtifact })),
    stepOffset, totalSteps: steps.length, nextStepOffset: stepOffset + 100 < steps.length ? stepOffset + 100 : null,
    executions: executions.slice(-100) };
  }

  listWorkflows(sessionId?: string, offset = 0, limit = 50, scope: "current" | "history" = "history") {
    const history = listWorkflowRuns(this.store, sessionId).reverse();
    const runs = scope === "current" ? [...history.filter(run => !workflowTerminal(run.status)), ...history.filter(run => workflowTerminal(run.status)).slice(0, 10)] : history;
    return { runs: runs.slice(offset, offset + limit).map(run => this.getWorkflowDetail(run.id).run), total: runs.length,
      offset, nextOffset: offset + limit < runs.length ? offset + limit : null };
  }
  findWorkflow(sessionId: string, requestKey: string) {
    const run = findWorkflowRun(this.store, sessionId, requestKey);
    return run ? this.getWorkflowDetail(run.id) : null;
  }
  async saveWorkflowDefinition(input: { name: string; script: string; expectedDigest: string | null; requestKey: string }) {
    const { script: _script, requestDigest: _requestDigest, ...result } = await this.workflowLibrary.save(input, () => { if (this.stopping) throw new WorkflowError("runtime_unavailable"); });
    return result;
  }
  findWorkflowSave(requestKey: string) {
    const saved = this.workflowLibrary.saved(requestKey);
    if (!saved) return null;
    const { script: _script, requestDigest: _requestDigest, ...result } = saved;
    return result;
  }
  getWorkflowDefinition(input: { name?: string; definitionId?: string; offset?: number; length?: number; versionOffset?: number }) {
    if ((input.name === undefined) === (input.definitionId === undefined)) throw new WorkflowError("invalid_params");
    const definition = input.definitionId ? Promise.resolve(this.workflowLibrary.version(input.definitionId)) : this.workflowLibrary.load(input.name!);
    return definition.then(({ script, ...version }) => {
      const versionOffset = input.versionOffset ?? 0, versions = input.name ? this.workflowLibrary.versions(input.name, versionOffset, 101) : [];
      return { ...version, name: input.name ?? null,
        ...sliceTextByBytes(script, input.offset ?? 0, Math.min(input.length ?? 16 * 1024, 64 * 1024)),
        versions: versions.slice(0, 100), versionOffset, nextVersionOffset: versions.length > 100 ? versionOffset + 100 : null };
    });
  }
  getWorkflowStep(runId: string, stepKey: string, offset = 0, length = 16 * 1024) {
    const run = requireWorkflowRun(this.store, runId);
    const step = getWorkflowStep(this.store, runId, stepKey);
    if (!step) throw new WorkflowError("step_missing");
    return { runId, stepKey, status: step.status, ...sliceTextByBytes(JSON.stringify({ params: step.params, result: step.result, rawOutput: step.rawOutput,
      outputArtifact: step.outputArtifact, frozen: step.frozen, verification: step.verification, input: run.input }), offset, Math.min(length, 64 * 1024)) };
  }
  getWorkflowLogs(runId: string, offset = 0, length = 16 * 1024) {
    const run = requireWorkflowRun(this.store, runId);
    const text = [`工作流 ${run.id}：${run.status}；${run.reason ?? "无等待原因"}`,
      ...listWorkflowSteps(this.store, runId).map(step => {
        const params = step.params;
        const progress = typeof params === "object" && params !== null && "text" in params && typeof params.text === "string" ? params.text : JSON.stringify(params);
        return `${step.key} [${step.kind}] ${step.status}${step.kind === "progress" ? `\n${progress}` : ""}`;
      }), ...(run.delivery ? ["最终事实\n" + run.delivery.facts, "最终回报\n" + run.delivery.text] : [])].join("\n");
    return { runId, ...sliceTextByBytes(text, offset, Math.min(length, 64 * 1024)) };
  }
  private async workflowScript(input: WorkflowLaunch): Promise<string> {
    const definition = input.name ? await this.workflowLibrary.load(input.name) : null;
    if (definition) requireWorkflowInterface(definition);
    const script = definition?.script ?? input.script!;
    if (!input.name) await validateWorkflowScript(script);
    return script;
  }
  private workflowReplay(sessionId: string, key: string, digest: string): WorkflowRun | null {
    if (!key || key.length > 128) throw new WorkflowError("invalid_params");
    const old = findWorkflowRun(this.store, sessionId, key);
    if (old && old.paramsDigest !== digest) throw new WorkflowError("request_conflict");
    return old;
  }

  async startWorkflowTask(input: WorkflowLaunch & { taskId: string; requestKey: string }) {
    const task = this.store.getTask(input.taskId);
    if (!task) throw new WorkflowError("source_missing");
    const digest = workflowLaunchDigest(input), old = this.workflowReplay(task.sessionId, input.requestKey, digest);
    if (old) return this.getWorkflowDetail(old.id);
    if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
    this.workflowSource(task.id);
    const script = await this.workflowScript(input);
    return this.getWorkflowDetail(this.workflows.start({ ...input, displayName: input.name ?? input.title, sourceTaskId: task.id, script, requestDigest: digest }).id);
  }

  /** 可信拥有者入口：短期发起任务和运行同事务登记，不调用模型或借用活动聊天。 */
  async startWorkflowOwner(input: WorkflowLaunch & { sessionId: string; requestKey: string }, origin?: {
    sourceEvent(): string;
    txExtra(run: WorkflowRun): void;
  }) {
    const digest = workflowLaunchDigest(input), old = this.workflowReplay(input.sessionId, input.requestKey, digest);
    if (old) {
      if (origin) this.store.withTx(() => { origin.sourceEvent(); origin.txExtra(old); });
      return this.getWorkflowDetail(old.id);
    }
    if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
    const session = this.store.getSession(input.sessionId), identity = this.store.getSessionIdentity(input.sessionId);
    if (!session || !identity || !["dev", "main"].includes(identity.kind) || session.defaultAccessMode === "plan") throw new WorkflowError("source_forbidden");
    const selection = identity.kind === "main" ? identity.role.modelSelection ?? session.modelSelection ?? this.defaultSelection : session.modelSelection ?? this.defaultSelection;
    const script = await this.workflowScript(input);
    let check: Awaited<ReturnType<RuntimeModels["resolveSelection"]>>;
    try { check = await this.models.resolveSelection(selection); }
    catch (cause) { if (!(cause instanceof ModelSelectionError)) throw cause; throw new WorkflowError(cause.code, { cause }); }
    const mode = session.defaultAccessMode;
    try { this.launcherFor(mode); }
    catch (cause) { if (!(cause instanceof ExecutionError)) throw cause; throw new WorkflowError(cause.code, { cause }); }
    const run = this.store.withTx(() => {
      const raced = this.workflowReplay(session.id, input.requestKey, digest);
      if (raced) { if (origin) { origin.sourceEvent(); origin.txExtra(raced); } return raced; }
      if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
      this.assertNoSessionCompaction(session.id);
      try { check(); }
      catch (cause) { if (!(cause instanceof ModelSelectionError)) throw cause; throw new WorkflowError(cause.code, { cause }); }
      const current = this.store.getSession(session.id)!;
      if (current.modelSelectionVersion !== session.modelSelectionVersion || current.defaultAccessModeVersion !== session.defaultAccessModeVersion ||
          (identity.kind === "main" && !isDeepStrictEqual(this.store.getAgentRole("main")?.modelSelection ?? current.modelSelection ?? this.defaultSelection, selection))) throw new WorkflowError("source_changed");
      let stat: fs.Stats;
      try { stat = fs.statSync(current.cwdReal); }
      catch (cause) { throw new WorkflowError("source_invalid", { cause }); }
      if (stat.dev !== current.cwdDev || stat.ino !== current.cwdIno || fs.realpathSync(current.cwdReal) !== current.cwdReal) throw new WorkflowError("source_invalid");
      const sourceEventId = origin?.sourceEvent() ?? null;
      const queued = this.store.insertQueuedTask({ sessionId: session.id, requestId: `workflow-start:${input.requestKey}`, input: workflowJson({ ...input, script: undefined, scriptDigest: workflowDefinitionDigest(script) }),
        modelSelection: selection, accessMode: mode, submissionDigest: digest, agentId: identity.kind === "main" ? "main" : null, sourceEventId });
      if (queued.duplicate) throw new WorkflowError("request_conflict");
      this.store.transitionTask(queued.task.id, ["queued"], "running", { startedAt: new Date().toISOString() });
      const accepted = this.workflows.register({ ...input, displayName: input.name ?? input.title, sourceTaskId: queued.task.id, script, requestDigest: digest }, taskId => this.workflowSource(taskId, true));
      this.store.setTaskResult(queued.task.id, `已启动工作流 ${accepted.id}`, JSON.stringify({ workflowRunId: accepted.id, hostStart: true }));
      this.store.endTask(queued.task.id, ["running"], "completed");
      origin?.txExtra(accepted);
      return accepted;
    });
    this.workflows.kick();
    return this.getWorkflowDetail(run.id);
  }
  async controlWorkflow(input: { runId: string; requestKey: string; version: number; control: WorkflowControl; txExtra?: () => void }) {
    if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
    await this.workflows.control(input.runId, input.requestKey, input.version, input.control, null, input.txExtra);
    return this.getWorkflowDetail(input.runId);
  }
  findWorkflowReceipt(runId: string, requestId: string, operation: "workflow_answer" | "workflow_control") {
    requireWorkflowRun(this.store, runId);
    const receipt = getWorkflowReceipt(this.store, runId, operation === "workflow_control" ? `owner:${requestId}` : requestId);
    if (receipt && receipt.operation !== operation) throw new WorkflowError("request_conflict");
    return receipt;
  }
  getWorkflowQuestion(runId: string, stepKey: string, offset = 0, length = 16 * 1024) {
    const question = getWorkflowQuestion(this.store, runId, stepKey);
    if (!question) throw new WorkflowError("question_missing");
    const prompt = question.prompt as { options?: string[]; schema?: unknown };
    return { runId, stepKey, status: question.status, version: question.version, runVersion: question.runVersion,
      ...(prompt.options ? { choices: prompt.options } : {}), ...(prompt.schema !== undefined ? { schema: prompt.schema } : {}),
      ...sliceTextByBytes(JSON.stringify({ prompt: question.prompt, answer: question.answer }), offset, Math.min(Math.max(length, 1), 64 * 1024)) };
  }
  answerWorkflowQuestion(input: { runId: string; stepKey: string; version: number; runVersion: number; requestKey: string; answer: unknown; txExtra?: () => void }) {
    if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
    const question = getWorkflowQuestion(this.store, input.runId, input.stepKey);
    if (!question) throw new WorkflowError("question_missing");
    return this.workflows.answer(input.runId, input.stepKey, input.version, input.answer, question.source, input);
  }

  /** 可信宿主的短期操作；先查重，按运行授权持有真实任务、账本与目录占用。 */
  workflowHostOperation<T>(input: import("./workflow-steps.ts").WorkflowHostOperationInput,
    execute: (execution: import("./work-copy.ts").WorkCopyExecution, task: Task) => Promise<T>): Promise<T> {
    const operation = this.runWorkflowHostOperation(input, execute);
    this.hostOperationPromises.add(operation);
    void operation.finally(() => this.hostOperationPromises.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async runWorkflowHostOperation<T>(input: import("./workflow-steps.ts").WorkflowHostOperationInput,
    execute: (execution: import("./work-copy.ts").WorkCopyExecution, task: Task) => Promise<T>): Promise<T> {
    const run = requireWorkflowRun(this.store, input.runId);
    const requestId = `workflow-host:${run.id}:${input.key}`;
    const digest = workflowDigest({ stepKey: input.stepKey, params: input.params, directories: input.directories ?? [] });
    const old = this.store.findTaskByRequest(run.source.sessionId, requestId);
    if (old) {
      if (old.submissionDigest !== digest) throw new WorkflowError("request_conflict");
      const execution = getWorkflowExecution(this.store, old.id);
      if (old.status === "completed" && old.resultSummary !== null && execution?.stopVerified === true) return JSON.parse(old.resultSummary) as T;
      if (old.status !== "queued" || !execution || execution.status !== "queued" || old.effectUnknown || this.store.listToolOpsByTask(old.id).length > 0) {
        throw new WorkflowError(old.effectUnknown ? "effect_unknown" : "verification_required");
      }
    }
    if (!this.verifyWorkflowSource(run.source)) throw new WorkflowError("source_invalid");
    const task = old ?? this.store.withTx(() => {
      const task = this.store.insertQueuedTask({ sessionId: run.source.sessionId, requestId, input: workflowJson(input.params), submissionDigest: digest,
        modelSelection: null, parentTaskId: run.source.taskId, accessMode: run.source.accessMode, grantedPaths: run.source.grantedPaths,
        sourcePermissionVersion: run.source.permissionVersion }).task;
      bindWorkflowExecution(this.store, { id: randomId("wfexec"), runId: run.id, stepKey: input.stepKey, kind: "host", taskId: task.id,
        number: listWorkflowExecutions(this.store, run.id).filter(execution => execution.kind === "host" && execution.stepKey === input.stepKey).length + 1,
        status: "queued", units: [], stopVerified: null });
      return task;
    });
    const session = this.store.getSession(run.source.sessionId)!;
    for (;;) {
      const current = requireWorkflowRun(this.store, run.id);
      if (this.stopping || current.status !== "running" || this.store.getTask(task.id)!.status !== "queued" || !this.verifyWorkflowSource(run.source)) {
        if (current.status === "canceled" || (!this.stopping && !this.verifyWorkflowSource(run.source))) this.store.withTx(() => {
          this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: "workflow_host_not_started" });
          updateWorkflowExecution(this.store, task.id, { status: "finished", stopVerified: true });
        });
        throw new WorkflowError("run_inactive");
      }
      const started = this.store.withTx(() => {
        if (!this.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, sessionId: session.id, taskId: task.id })) return false;
        for (const directory of input.directories ?? []) {
          if (this.store.listAllOccupancy().some(held => held.taskId === task.id && grantCoversPath(held.cwdReal, directory.path))) continue;
          if (!this.store.tryAcquireOccupancy({ cwdReal: directory.path, cwdDev: directory.dev, cwdIno: directory.ino, sessionId: session.id, taskId: task.id })) { this.store.releaseOccupancy(task.id); return false; }
        }
        if (!startWorkflowExecution(this.store, task.id)) { this.store.releaseOccupancy(task.id); return false; }
        this.store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() });
        this.store.appendEvent({ type: "task.started", taskId: task.id, sessionId: task.sessionId }, { taskId: task.id, sessionId: task.sessionId });
        return true;
      });
      if (started) { this.hostExecutions.attach(task.id); break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    try {
      const value = await execute({ kind: "workflow-host", taskId: task.id }, this.store.getTask(task.id)!);
      const serialized = workflowJson(value);
      if (this.store.getTask(task.id)!.status !== "running") throw new WorkflowError("task_ending");
      this.store.withTx(() => this.store.setTaskResult(task.id, serialized, JSON.stringify({ workflowRunId: run.id, stepKey: input.stepKey })));
      if (!await this.hostExecutions.stop(task.id, "completed", "")) throw new WorkflowError("stop_unverified");
      return value;
    } catch (error) {
      await this.hostExecutions.stop(task.id, "failed", error instanceof WorkflowError || error instanceof WorkCopyError ? error.code : "workflow_host_failed");
      throw error;
    } finally {
      this.store.withTx(() => {
        const current = requireWorkflowRun(this.store, run.id);
        updateWorkflowRun(this.store, chargeWorkflow(current, Date.now()));
      });
    }
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

  /** 每次调度使用独立会话；任务、来源事件与运行绑定同事务提交。 */
  private async dispatchScheduled(event: InboundEvent, selection: ModelSelection): Promise<Task> {
    const run = this.sched.getRun(event.externalId);
    const schedule = run ? this.sched.getSchedule(run.scheduleId) : null;
    if (!run || !schedule || run.inboundEventId !== event.id) throw new RuntimeApiError("not_found", "调度运行来源不可核实");
    if (run.rootTaskId) return this.store.getTask(run.rootTaskId)!;
    try {
      if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
      const check = await this.models.resolveSelection(selection);
      this.launcherFor(schedule.accessMode);
      const sourceProblem = this.sources.verify(schedule.projectId, schedule.sourceRefs);
      if (sourceProblem) throw new RuntimeApiError("task_sources_revoked", "调度资料授权已失效，未开始执行");
      const workDir = path.join(path.dirname(path.resolve(this.config.dataDir)), "agent-work", "scheduled", run.id);
      fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
      const real = fs.realpathSync(workDir);
      const stat = fs.statSync(real);
      return this.store.withTx(() => {
        const currentRun = this.sched.getRun(run.id);
        const currentSchedule = this.sched.getSchedule(schedule.id);
        if (currentRun?.rootTaskId) return this.store.getTask(currentRun.rootTaskId)!;
        if (this.stopping || !currentRun || currentRun.closedAt || !currentSchedule || currentSchedule.status === "canceled" ||
            this.store.getInboundEvent(event.id)?.status !== "registered") {
          throw new RuntimeApiError("task_ending", "调度计划已取消或运行已结束，未开始执行");
        }
        check();
        if (this.sources.verify(schedule.projectId, schedule.sourceRefs)) throw new RuntimeApiError("task_sources_revoked", "调度资料授权已失效，未开始执行");
        const session = this.store.createSession({ projectId: schedule.projectId, kind: "dev", cwd: real, cwdReal: real,
          cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: randomId("pi"), confirmTools: [], modelSelection: selection });
        const { task } = this.store.insertQueuedTask({ sessionId: session.id, requestId: `evt:${event.id}`, input: event.body,
          accessMode: schedule.accessMode, modelSelection: selection,
          submissionDigest: createHash("sha256").update(JSON.stringify({ runId: run.id, eventId: event.id, mode: schedule.accessMode })).digest("hex"),
          sourceEventId: event.id, readScope: { paths: [], sourceRefs: schedule.sourceRefs } });
        if (!this.sched.bindRunExecution(run.id, session.id, task.id)) throw new RuntimeApiError("task_ending", "调度运行绑定已失效");
        this.store.markInboundQueued(event.id, task.id);
        return task;
      });
    } catch (err) {
      // 配置应用门闩与后台停止留待恢复；确定无法启动的本次运行登记失败，不补跑。
      if (err instanceof RuntimeApiError && (err.code === "model_config_busy" || err.code === "stopping")) throw err;
      this.store.withTx(() => {
        if (this.store.failRegisteredInbound(event.id)) this.store.appendEvent({ type: "inbound.skipped", eventId: event.id,
          source: event.source, reason: "schedule_start_failed:本次定时执行无法启动，请检查模型、执行入口或资料授权" });
      });
      throw err;
    }
  }

  /** 首次任务、全部派生执行和结果汇总到终态后才关闭运行。 */
  private scheduledRunOutcome(run: ScheduleRun): { status: "completed" | "failed" | "canceled" | "interrupted"; text: string } | null {
    const schedule = this.sched.getSchedule(run.scheduleId);
    const workflows = listWorkflowRuns(this.store).filter(workflow => workflow.source.scheduledRunId === run.id);
    if (workflows.some(workflow => !workflowTerminal(workflow.status))) return null;
    if (workflows.some(workflow => listWorkflowExecutions(this.store, workflow.id).some(execution => {
      const task = this.store.getTask(execution.taskId);
      return !task || !isTerminalTaskStatus(task.status) || execution.stopVerified === false ||
        (execution.status !== "queued" && execution.stopVerified !== true);
    }) || (workflow.scriptUnits.length > 0 && workflow.scriptStopVerified !== true))) return null;
    if (schedule?.status !== "canceled" && workflows.some(workflow => !workflow.delivery || !["reported", "undelivered"].includes(workflow.delivery.status))) return null;
    if (!run.rootTaskId) {
      if (schedule?.status === "canceled") return { status: "canceled", text: "计划已取消，本次运行未开始" };
      const event = run.inboundEventId ? this.store.getInboundEvent(run.inboundEventId) : null;
      return event?.status === "failed" ? { status: "failed", text: "本次定时执行无法启动，请检查模型、执行入口或资料授权" } : null;
    }
    const tasks = this.store.listScheduledRunTasks(run.id).filter(task => !isAgentReportParked(this.store, task.id));
    const taskIds = new Set(tasks.map((task) => task.id));
    if (this.store.listAllOccupancy().some((held) => held.taskId !== null && taskIds.has(held.taskId))) return null;
    if (tasks.some((task) => !isTerminalTaskStatus(task.status) || (!getWorkflowExecution(this.store, task.id) && !workCopyHostFor(task) && task.resultSummary === null) ||
        workCopyHostFor(task)?.stopVerified === false)) return null;
    if (schedule?.status === "canceled") return { status: "canceled", text: "计划已取消，运行记录、成果及未核实占用保留" };
    if (this.store.listPendingSubAgentMessages(run.sessionId!).length > 0) return null;
    const invalidWorkspaces: { taskId: string; code: string }[] = [];
    for (const task of tasks) {
      if (getWorkflowExecution(this.store, task.id)) continue;
      if (!task.subAgentId || !task.workId) continue;
      let work: WorkDelegation | null;
      try { work = this.store.getWorkDelegation(task.workId); }
      catch (error) {
        if (!(error instanceof WorkspaceSnapshotError) || !["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(error.code)) throw error;
        invalidWorkspaces.push({ taskId: task.id, code: error.code });
        continue;
      }
      if (work?.canceledAt) continue;
      if (work) {
        try { this.subagents!.verifyWorkspace(work); }
        catch (error) {
          if (!(error instanceof WorkCopyError) || !["snapshot_missing", "snapshot_corrupt", "snapshot_changed", "snapshot_invalid", "worktree_gone"].includes(error.code)) throw error;
          invalidWorkspaces.push({ taskId: task.id, code: error.code });
          continue;
        }
      }
      const sourceProblem = this.verifySubAgentSource(task, true);
      if (sourceProblem) { invalidWorkspaces.push({ taskId: task.id, code: sourceProblem }); continue; }
      const report = getAgentReport(this.store, agentReportKey({ kind: "task", taskId: task.id }));
      if (!this.store.findTaskByRequest(run.sessionId!, `wake:${task.id}`) && report?.status !== "reported") return null;
    }
    const final = tasks.filter((task) => task.sessionId === run.sessionId && !getWorkflowExecution(this.store, task.id) && !workCopyHostFor(task)).sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? "") || a.id.localeCompare(b.id)).at(-1)!;
    const ordinary = tasks.filter(task => !getWorkflowExecution(this.store, task.id));
    const problem = ordinary.find((task) => task.status === "interrupted") ?? ordinary.find((task) => task.status !== "completed");
    const status = problem?.status === "interrupted" ? "interrupted" : problem || invalidWorkspaces.length || workflows.some(workflow => workflow.status !== "succeeded" || workflow.delivery?.status === "undelivered") ? "failed" : "completed";
    const reply = this.readTaskReplyText(final.id)?.trim();
    return { status, text: [...workflows.map(workflow => `工作流 ${workflow.id}：${workflow.status}${workflow.delivery?.reason ? `；未送达 ${workflow.delivery.reason}` : ""}`),
      ...workflows.map(workflow => workflow.delivery?.facts ?? `工作流 ${workflow.id}：${workflow.status}`),
      ...invalidWorkspaces.map(item => `${item.taskId}：来源或工作区基线不可核实（${item.code}）；原记录与副本保留`),
      problem ? `${problem.id}：${problem.resultSummary ?? problem.errorMessage ?? "执行未成功"}` : null, reply].filter(Boolean).join("\n") || "（无文本结果）" };
  }

  /** 取消事实已提交；停止整项运行，已有成果与停止未核实状态沿原收尾路径保留。 */
  private async cancelScheduledRun(run: ScheduleRun, initiatingTaskId: string | null): Promise<void> {
    if (!run.rootTaskId) return;
    for (const snapshot of listWorkflowRuns(this.store).filter(item => item.source.scheduledRunId === run.id)) {
      const workflow = requireWorkflowRun(this.store, snapshot.id);
      if (workflowTerminal(workflow.status)) continue;
      if (this.workflows) await this.workflows.control(workflow.id, `schedule-cancel:${run.id}`, workflow.version, { action: "cancel" }, initiatingTaskId);
      else this.store.withTx(() => controlWorkflow(this.store, workflow.id, `schedule-cancel:${run.id}`, workflow.version, { action: "cancel" }));
    }
    const tasks = this.store.listScheduledRunTasks(run.id);
    this.store.withTx(() => {
      for (const task of tasks) {
        if (task.status === "queued") this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: "schedule_canceled" });
        else if (!isTerminalTaskStatus(task.status)) this.store.setCancelRequested(task.id, true);
      }
    });
    const works = [...new Set(tasks.flatMap((task) => task.workId && !getWorkflowExecution(this.store, task.id) ? [task.workId] : []))];
    for (const workId of works) {
      try { await this.subagents!.cancelWork({ workId, by: "owner", reason: "调度计划已取消", parentSessionId: run.sessionId! }); }
      catch (error) {
        if (!(error instanceof WorkspaceSnapshotError) || !["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(error.code)) throw error;
        process.stderr.write(`[ruukoto:scheduler] 工作 ${workId} 的取消记录不可核实（${error.code}）；保留原记录与副本，继续停止本次运行已登记的任务\n`);
      }
    }
    for (const task of this.store.listScheduledRunTasks(run.id)) {
      if (getWorkflowExecution(this.store, task.id)) continue;
      if (isTerminalTaskStatus(task.status)) continue;
      if (task.id === initiatingTaskId) {
        // 本工具返回前 SDK abort 会等当前调用；取消意图已落库，仅发起者异步收尾。
        void this.cancelTask(task.id, { reason: "schedule_canceled" }).catch((err: unknown) => {
          process.stderr.write(`[ruukoto:scheduler] 发起任务 ${task.id} 取消收尾失败，运行保持未完成，请核实任务与占用：${err instanceof Error ? err.message : String(err)}\n`);
        });
      } else await this.cancelTask(task.id, { reason: "schedule_canceled" });
    }
    await this.subagents!.flushPendingMessages(run.sessionId!);
  }

  private initScheduler(): void {
    const now = this.config.scheduler?.now ?? (() => Date.now());
    this.scheduler = new Scheduler({
      store: this.store,
      sched: this.sched,
      now,
      channel: (source) => this.imEntries.channel(source),
      // 编排器在 start 末尾创建；调度扫描只在其后开放，恢复准备不派发
      dispatchRegistered: () => this.orchestrator?.dispatchRegisteredEvents() ?? Promise.resolve(),
      serial: (fn) => (this.orchestrator ? this.orchestrator.serial(fn) : fn()),
      runOutcome: (run) => this.scheduledRunOutcome(run),
      cancelRun: (run, initiatingTaskId) => this.cancelScheduledRun(run, initiatingTaskId),
      verifySources: (op) => {
        const authorizationProblem = this.sched.verifyToolAuthorization(op);
        if (authorizationProblem) return authorizationProblem;
        if (op.sourceKind === "schedule_run" && listWorkflowRuns(this.store).some(run => run.source.scheduledRunId === op.sourceKey && !this.verifyWorkflowReport(run, true))) {
          return "定时工作流回报资料或原入口已失效";
        }
        if (op.sourceKind === "schedule_run" && listAgentReports(this.store).some(report => report.source.scheduledRunId === op.sourceKey &&
            (!this.verifyAgentWaitTarget(report.source, report.target, true) || !report.source.replyTarget || !sameTarget(report.source.replyTarget, op.target) ||
              (Boolean(report.fallbackTaskId) && report.proof?.taskId === report.fallbackTaskId && this.agentReportWorkCanceled(report))))) {
          return "定时等待结果回报的资料或原入口已失效";
        }
        if (op.sourceKind === "workflow_question") {
          const parts = op.sourceKey.split("#");
          const question = parts.length === 3 ? getWorkflowQuestion(this.store, parts[0], parts[1]) : null;
          const run = question ? requireWorkflowRun(this.store, question.runId) : null;
          const step = question ? getWorkflowStep(this.store, question.runId, question.stepKey) : null;
          return question && run && question.status === "pending" && workflowQuestionKey(question) === op.sourceKey &&
            ["running", "waiting"].includes(run.status) && question.source.replyTarget && sameTarget(question.source.replyTarget, op.target) &&
            step && this.workflowSteps.verifyResultSources(run, step)
            ? null : "工作流问题已回答、取消或来源失效";
        }
        if (op.sourceKind === "owner_reply" && op.taskId) {
          if (this.verifyAgentReportSources(op.taskId, true)) return "等待结果回报的资料或原入口已失效";
          const reports = this.agentReportReferences(op.taskId);
          if (reports.some(report => report.source.scheduledRunId ||
              !report.source.replyTarget || !sameTarget(report.source.replyTarget, op.target))) return "等待结果回报的资料或原入口已失效";
          const workflow = getWorkflowDeliveryRun(this.store, op.taskId);
          if (workflow && (!this.verifyWorkflowReport(workflow) || workflow.source.scheduledRunId ||
              !workflow.source.replyTarget || !sameTarget(workflow.source.replyTarget, op.target))) return "工作流最终回报来源已失效";
        }
        // IM 审批控制消息回执（issue 08）：宿主已在处理时核实身份；发送前核对
        // 原控制事件与钉版目标，不经仅适用于 GitHub 的入站核实
        if (op.sourceKind === "inbound_event") {
          if (op.sourceKey.startsWith("media:")) {
            const message = this.inboundMedia.getMessageById(op.sourceKey.slice("media:".length));
            const entry = message ? this.imEntries.entry(message.source) : null;
            const current = entry?.target();
            return message && ["rejected", "expired"].includes(message.status) && entry && message.actor === entry.expectedActor() &&
              message.replyTarget && current && sameTarget(message.replyTarget, op.target) && sameTarget(current, op.target)
              ? null : "图片拒绝回执来源已失效";
          }
          const event = this.store.getInboundEvent(op.sourceKey);
          if (event?.eventKind === "im_approval" || event?.eventKind === "im_workflow") {
            return event.actor && event.replyTarget && sameTarget(event.replyTarget, op.target)
              ? null
              : "IM 审批回执来源不可核实";
          }
        }
        // IM 审批初始通知：发送前检查请求仍有效（已决定/已失效的未发出通知不发出）；
        // 不影响 task:<taskId> 的一次通知槽
        if (op.sourceKind === "confirmation" && op.sourceKey.startsWith("im-approval:")) {
          const confirmation = this.store.getConfirmation(op.sourceKey.slice("im-approval:".length));
          if (!confirmation || confirmation.status !== "pending") return "审批已决定或失效，通知不再发出";
        }
        const problem = this.githubEvents.verifyNotification(op);
        if (problem) return problem;
        const main = this.store.getAgentRole("main");
        const run = op.sourceKind === "schedule_run" ? this.sched.getRun(op.sourceKey) : null;
        const projectId = run ? this.sched.getSchedule(run.scheduleId)?.projectId
          : op.taskId ? this.store.getSession(this.store.getTask(op.taskId)?.sessionId ?? "")?.projectId : main?.projectId;
        return projectId ? this.sources.verify(projectId, op.sourceRefs) : "通知来源项目不可核实";
      },
      log: (message) => process.stderr.write(`[ruukoto:scheduler] ${message}\n`),
      tickMs: this.config.scheduler?.tickMs,
      sendTimeoutMs: this.config.scheduler?.sendTimeoutMs,
    });
  }

  private inboundGate(event: InboundEvent): "run" | "wait" | { drop: string } {
    // 核心群聊已退役（agent-direction issue 20）：旧群入站事件一律作废
    if (event.source === QQ_GROUP_SOURCE) return { drop: CORE_GROUP_CHAT_RETIRED };
    if (event.source === "scheduler") {
      const run = this.sched.getRun(event.externalId);
      const schedule = run ? this.sched.getSchedule(run.scheduleId) : null;
      return !run || run.closedAt || !schedule || schedule.status === "canceled" ? { drop: "schedule_canceled" } : "run";
    }
    return event.source === GITHUB_SOURCE ? this.githubEvents.gate(event) : this.imEntries.gate(event);
  }

  // ---------- IM 审批（agent-direction issue 08） ----------

  /**
   * IM 入站登记：审批命令整条匹配时直接进入宿主审批路径（不派发、不建任务、
   * 不排在等待审批的普通任务后面）；普通正文保持现有入站路径。
   */
  private async registerImInbound(
    source: string,
    input: { externalId: string; actor: string | null; body: string; replyTarget: NotifyTarget | null; commandText?: string; media?: boolean },
  ): Promise<unknown> {
    const { commandText, media, ...registration } = input;
    if (media) {
      const message = this.inboundMedia.getMessage(source, input.externalId);
      if (!message) throw new Error("图片暂存记录缺失");
      if (message.status === "rejected" || message.status === "expired") {
        this.store.withTx(() => this.enqueueMediaReceipt(message));
        this.scheduler?.kickSender();
        return message;
      }
      if (message.status !== "ready" && message.status !== "bound") return message;
      // 重投沿用首次下载时的拥有者与配置代次，不能用新入口重新包装旧图片。
      registration.actor = message.actor;
      registration.body = message.body;
      registration.replyTarget = message.replyTarget;
    }
    if (!media && commandText !== undefined) {
      const workflowOutcome = await this.imWorkflows.handleCommand({ source, externalId: input.externalId, actor: input.actor,
        replyTarget: input.replyTarget, commandText });
      if (workflowOutcome) return workflowOutcome;
      const outcome = await this.imApprovals.handleCommand({
        source,
        externalId: input.externalId,
        actor: input.actor,
        replyTarget: input.replyTarget,
        commandText,
      });
      if (outcome) return outcome;
    }
    const result = await this.orchestrator!.registerInboundEvent({ source, targetRole: "main", ...registration });
    if (media) this.inboundMedia.attachEvent(source, input.externalId, result.event.id);
    return result;
  }

  private enqueueMediaReceipt(message: InboundMediaMessage): void {
    if (!message.replyTarget) return;
    this.sched.insertOp({
      sourceKind: "inbound_event", sourceKey: `media:${message.id}`, taskId: null, hostOpId: null,
      target: message.replyTarget, sourceRefs: [],
      text: message.reason === "image_input_unsupported"
        ? "[ruukoto] 当前模型不支持图片输入，这条图片消息未执行。请在配置中选择支持图片的模型后重新发送。"
        : message.reason === "download_failed" || message.reason === "download_interrupted"
          ? "[ruukoto] 图片下载未能完成，这条消息未执行。请稍后重新发送图片。"
          : "[ruukoto] 图片接收失败，这条消息未执行。请发送 JPEG、PNG 或 WebP，每条最多 4 张，每张不超过 8 MiB。",
    });
  }

  private async recoverInboundMedia(): Promise<void> {
    this.inboundMedia.recover();
    for (const message of this.inboundMedia.listRejectedMessages()) this.store.withTx(() => this.enqueueMediaReceipt(message));
    for (const message of this.inboundMedia.listReadyMessages()) {
      await this.registerImInbound(message.source, { externalId: message.externalId, actor: message.actor,
        body: message.body, replyTarget: message.replyTarget, media: true });
    }
  }

  private async prepareInboundMedia(event: InboundEvent, selection: ModelSelection): Promise<boolean> {
    if (!this.inboundMedia.hasMedia(event)) return true;
    const message = this.inboundMedia.getMessage(event.source, event.externalId)!;
    if (["rejected", "expired"].includes(message.status)) {
      this.store.withTx(() => {
        this.store.failRegisteredInbound(event.id);
        this.enqueueMediaReceipt(message);
      });
      const role = this.store.getAgentRole(event.targetRole);
      const pending = role ? this.store.findTaskByRequest(role.sessionId, `evt:${event.id}`) : null;
      if (pending?.status === "queued") await this.cancelTask(pending.id, { reason: "inbound_media_rejected" });
      return false;
    }
    // 已创建任务的重启窗口沿用原模型与请求键；能力在 Driver 发出请求前再次核实。
    const role = this.store.getAgentRole(event.targetRole);
    if (role && this.store.findTaskByRequest(role.sessionId, `evt:${event.id}`)) return true;
    const model = await this.models.current.modelCatalog.resolve(selection);
    if (model.input.includes("image")) return true;
    this.inboundMedia.rejectMessage(event.source, event.externalId, "image_input_unsupported");
    this.store.withTx(() => {
      this.store.failRegisteredInbound(event.id);
      this.enqueueMediaReceipt(this.inboundMedia.getMessage(event.source, event.externalId)!);
      this.store.appendEvent({ type: "inbound.skipped", eventId: event.id, source: event.source, reason: "image_input_unsupported" });
    });
    this.scheduler?.kickSender();
    return false;
  }

  /** 拥有者控制面：计划分页列表 / 详情（含最近运行） / 取消。 */
  scheduleList(input: { status?: string; cursor?: string; limit?: number }) {
    if (input.status !== undefined && !["active", "completed", "canceled"].includes(input.status)) {
      throw new RuntimeApiError("invalid_params", "status 只能是 active / completed / canceled");
    }
    const { items, nextCursor } = this.sched.listSchedules({ status: input.status as ScheduleStatus | undefined, cursor: input.cursor, limit: input.limit });
    // 列表不带完整正文（详情单条读取），保持分页有界
    return { schedules: items.map(({ instruction, ...rest }) => ({ ...rest, instructionChars: [...instruction].length })), nextCursor };
  }

  scheduleGet(scheduleId: string) {
    const schedule = this.sched.getSchedule(scheduleId);
    if (!schedule) throw new RuntimeApiError("not_found", `计划不存在：${scheduleId}`);
    const heldTaskIds = new Set(this.store.listAllOccupancy().map((held) => held.taskId));
    return { schedule, runs: this.sched.listRuns(scheduleId, 20).map((run) => ({
      ...run,
      stopUnverifiedTaskIds: this.store.listScheduledRunTasks(run.id)
        .filter((task) => isTerminalTaskStatus(task.status) && heldTaskIds.has(task.id)).map((task) => task.id),
    })) };
  }

  // ---------- 长期操作授权（拥有者控制面；agent-direction issue 10） ----------

  /**
   * 长期授权分页列表（入口停用后仍可管理的遗留目录；只查询，目录权限不能用于
   * 放行旧授权）。光标为上一页最后一条授权 id。
   */
  serviceGrantList(input: { cursor?: string; limit?: number }): { items: StandingPermission[]; nextCursor: string | null } {
    try {
      const { items, hasMore } = this.store.listStandingPermissionsPaged({ before: input.cursor, limit: input.limit ?? 50 });
      return { items, nextCursor: hasMore && items.length > 0 ? items[items.length - 1]!.id : null };
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError("invalid_params", err.message);
      throw err;
    }
  }

  /** 长期授权详情：完整范围、版本、存续状态、来源与独立使用记录（有界）。 */
  serviceGrantGet(permissionId: string): { permission: StandingPermission; usages: ConfirmationRequest[] } {
    const permission = this.store.getStandingPermission(permissionId);
    if (!permission) throw new RuntimeApiError("not_found", `长期授权不存在：${permissionId}`);
    return { permission, usages: this.store.listConfirmationsByStanding(permissionId, 50) };
  }

  /** 带版本撤销长期授权；已撤销的幂等返回（重复撤销不再次变更）。 */
  serviceGrantRevoke(permissionId: string, expectedVersion: number): StandingPermission {
    try {
      const { permission } = this.store.withTx(() => this.store.revokeStandingPermission(permissionId, expectedVersion));
      return permission;
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code === "not_found" ? "not_found" : err.code, err.message);
      throw err;
    }
  }

  async scheduleCancel(input: { scheduleId: string; expectedVersion: number; reason: string }) {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    // ruukoto-code 无调度器：取消计划的合并语义不可用，明确拒绝而不是静默改写
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
      recoverCompactionRequests(store);
      recoverAgentWaits(store);
      const interruptedTaskIds: string[] = [];
      const pausedSessionIds: string[] = [];

      // 1. 结果缺失的工具操作按工具操作账本的分类器补记（架构工单 05）：覆盖全部
      //    任务（含终态：核心结果写入失败窗口、驱动器缺失的中断路径）。无写入效果
      //    与审批未消费记已知结论；工具族先按宿主操作 ID 核实；其余
      //    结果缺失且可能已产生外部效果 → effect_unknown，不重放。
      //    未完成执行 → interrupted。
      // Note: 见 .agents/notes/implemented/architecture/2026-09-23-main-app-data-space.md
      this.ledger.settleAll();
      for (const task of store.listTasksByStatus(["running", "awaiting_confirmation"])) {
        const claims = listAgentReports(store, { taskId: task.id }).filter(report => report.status === "pending" && (report.claimTaskId === task.id || report.fallbackTaskId === task.id));
        if (claims.length) {
          const file = store.getSession(task.sessionId)?.sessionFile;
          const entries = file && fs.existsSync(file) ? parseSessionFile(file) : [];
          const start = entries.findIndex(entry => entry.type === "custom" && entry.customType === TASK_START_MARKER && (entry.data as { taskId?: string } | undefined)?.taskId === task.id);
          const end = entries.findIndex((entry, index) => index > start && entry.type === "custom" && entry.customType === TASK_END_MARKER && (entry.data as { taskId?: string; status?: string } | undefined)?.taskId === task.id && (entry.data as { status?: string }).status === "completed");
          const messages = start < 0 ? [] : entries.slice(start + 1, end < 0 ? undefined : end).filter(entry => entry.type === "message");
          const final = messages.at(-1)?.message as { role?: string; stopReason?: string; content?: { type: string; text?: string }[] } | undefined;
          if (final?.role === "assistant" && final.stopReason !== "error" && final.stopReason !== "aborted" && final.content?.some(part => part.type === "text" && part.text)) {
            store.addHistoryEntryIds(task.id, messages.map(entry => entry.id));
            if (this.verifyAgentReportSources(task.id)) invalidateAgentReports(store, claims.map(report => report.key), "source_invalid");
            else this.acceptAgentWaitResults(task);
            if (end >= 0) {
              store.endTask(task.id, ["running", "awaiting_confirmation"], "completed", { keepOccupancy: true });
              continue;
            }
            const proof = { status: "undelivered" as const, reason: "parent_report_unverified", entryId: messages.at(-1)!.id };
            if (claims.some(report => report.fallbackTaskId === task.id)) finishAgentReportFallback(store, task.id, proof);
            else if (this.parentDelivery.reportReady(task)) completeAgentReports(store, task.id, { ...proof, reportInput: this.agentReportInput(task, claims) ?? undefined });
            else releaseAgentReports(store, task.id, "wait_group_pending");
          }
        }
        const changed = store.endTask(task.id, ["running", "awaiting_confirmation"], "interrupted", {
          interruptReason: "backend_restart",
          endedAt: new Date().toISOString(),
          keepOccupancy: true,
        });
        if (changed) interruptedTaskIds.push(task.id);
        if (changed) releaseAgentReports(store, task.id, "backend_restart");
      }

      interruptedTaskIds.push(...this.subagents!.recoverQueuedTasks());

      // 2. 遗留占用：旧执行单元状态无法确认时保留占用并暂停会话，
      //    由拥有者核实后 resume_queue 释放；user scope 独立于后台服务，
      //    backend 的 KillMode 不能证明该 scope 与后代已退出。
      // Note: 见 .agents/notes/implemented/architecture/2026-10-12-personal-native-sandbox.md
      for (const occ of store.listAllOccupancy()) {
        if (occ.taskId === null) continue;
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

  /**
   * 固定角色退役的启动收尾（agent-direction issue 20 群聊、issue 23 coding）：只把
   * 未终态的旧行改成终态，每次启动执行、按状态幂等（已终态的行不再改动，重复
   * 升级/重启不重放）。
   * - 群会话与 coding 角色会话的排队任务 → canceled（原因按角色）；运行中的已由
   *   recover() 定 interrupted（结果未知，不重放）；旧 coding 子任务的结果与 main
   *   唤醒由编排器启动巡检补记一次；
   * - 在途（pending）群回复 → unknown（effect_unknown，不重发），对应收件记
   *   reply_unknown；完成但未发回复的收件不再补发，与其余未终态收件一并
   *   记 skipped；
   * - 已登记的 qq_group 入站事件的作废与 inbound.skipped 由编排器启动恢复
   *   经入站门固定 drop 统一处理，不在此重复。
   */
  private retireLegacyRoles(): void {
    this.store.withTx(() => {
      for (const ob of this.qqStore.listPendingOutbox()) {
        if (this.qqStore.settleOutbox(ob.opId, "unknown", { error: `${CORE_GROUP_CHAT_RETIRED}（发送结果未确认，effect_unknown，不重发）` })) {
          this.store.db.prepare("UPDATE qq_inbox SET status = 'reply_unknown' WHERE task_id = ? AND status = 'queued'").run(ob.taskId);
        }
      }
      const now = new Date().toISOString();
      const retired = [
        ...this.qqStore.listGroupSessions().map((gs) => ({ sessionId: gs.sessionId, reason: CORE_GROUP_CHAT_RETIRED })),
        ...this.store.listAgentRoles().filter((r) => r.id === "coding").map((r) => ({ sessionId: r.sessionId, reason: CODING_ROLE_RETIRED })),
      ];
      for (const { sessionId, reason } of retired) {
        for (const task of this.store.listQueuedTasksFifo(sessionId)) {
          this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: reason, endedAt: now });
        }
      }
      // 先于 outbox 定 reply_unknown 的行已离开 queued 状态，不会被覆盖
      for (const row of this.qqStore.listPendingInbox()) {
        this.qqStore.setInboxStatus(row.dedupKey, "skipped");
      }
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
    mode?: SessionDefaultMode;
    modelSelection?: ModelSelection;
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
      // 角色与群聊会话所在的项目不能作为普通会话归属（issue 20；与
      // openWorkspace「角色或群聊项目不能作为工作区认领」同一判定）——否则可在
      // 群项目里建普通 dev 会话，绕过群会话只读归档边界读取群原始历史
      const roles = this.store.listAgentRoles();
      if (roles.some((r) => r.projectId === project.id) || this.store.listSessions().some((s) => s.projectId === project.id && s.kind !== "dev")) {
        throw new RuntimeApiError("invalid_params", "角色或群聊项目不能创建普通会话");
      }
    }
    const identity = await this.resolveUsableDir(input.cwd);
    const settings = await this.sessionCreationSettings(input);
    try {
      return this.store.withTx(() => {
        if (!input.createRequestId || !this.store.findSessionByCreateRequestId(input.createRequestId)) settings.check?.();
        // 目录校验先于任何写入；项目与会话同一事务，会话失败则项目一并回滚
        const projectId = input.projectId ?? this.store.createProject(input.projectName!.trim(), input.createRequestId).id;
        return this.store.createSession({
          projectId,
          kind: "dev",
          cwd: identity.cwd,
          cwdReal: identity.cwdReal,
          cwdDev: identity.dev,
          cwdIno: identity.ino,
          piSessionId: randomUUID(),
          confirmTools: input.confirmTools ?? [],
          createRequestId: input.createRequestId,
          modelSelection: settings.modelSelection,
          defaultAccessMode: settings.mode,
        });
      });
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
  }

  private async sessionCreationSettings(input: { createRequestId?: string; mode?: SessionDefaultMode; modelSelection?: ModelSelection }) {
    // 已提交成果先于当前模型目录核实；重发不能覆盖之后修改的会话设置。
    if (input.createRequestId && this.store.findSessionByCreateRequestId(input.createRequestId)) return { modelSelection: this.defaultSelection, mode: "confirm" as const, check: null };
    if (input.mode !== undefined && !isSessionDefaultMode(input.mode)) throw new RuntimeApiError("invalid_params", "会话默认模式无效");
    const modelSelection = input.modelSelection === undefined ? this.defaultSelection : parseModelSelection(input.modelSelection);
    const check = input.modelSelection === undefined ? null : await this.models.resolveSelection(modelSelection);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    return { modelSelection, mode: input.mode ?? "confirm", check };
  }

  private branchDeps(): BranchSessionDeps {
    return { store: this.store, access: this.access, sessionsDir: sessionsDirFor(this.config.dataDir), enabled: this.config.product.branchSessions === true,
      validate: async (session) => {
        if (this.store.getSessionIdentity(session.id)?.kind !== "dev") throw new RuntimeApiError("invalid_params", "只有普通开发会话可以建立分支");
        const workspace = this.store.getProject(session.workspaceProjectId ?? session.projectId);
        if (!workspace?.rootDir) throw new RuntimeApiError("invalid_params", "旧会话尚未映射到工作区，请先完成工作区映射");
        try {
          await verifyDirIdentity({ cwd: session.cwd, cwdReal: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno });
          await verifyDirIdentity(workspace.rootDir);
        } catch (error) {
          if (error instanceof DirIdentityError) throw new RuntimeApiError("cwd_changed", "来源会话或工作区目录已失效或被替换，请核实目录后再分支");
          throw error;
        }
        const current = await this.resolveUsableDir(session.cwd);
        if (!sameDirIdentity({ cwd: session.cwd, cwdReal: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno }, current)) {
          throw new RuntimeApiError("cwd_changed", "来源目录入口已指向其他目录，请核实后再分支");
        }
        const relative = path.relative(workspace.rootDir.cwdReal, session.cwdReal);
        if ((relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) && !sameDirIdentity(workspace.rootDir, current)) throw new RuntimeApiError("invalid_params", "会话目录已不在所属工作区范围");
      } };
  }

  async branchSession(input: { sessionId: string; name?: string; requestId: string }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝会话分支");
    return branchSession(this.branchDeps(), input);
  }

  findBranchSession(requestId: string) {
    const request = getBranchRequest(this.store, requestId);
    return { status: request?.status ?? "not_found", session: request?.status === "published" ? this.store.getSession(request.session.id) : null, error: request?.error ?? null };
  }

  private assertNoSessionCompaction(sessionId: string): void {
    if (this.compactions.has(sessionId) || getLatestSessionCompaction(this.store, sessionId)?.status === "running") {
      throw new RuntimeApiError("session_compaction_busy", "此会话正在压缩上下文，请等待完成或用 /interrupt 停止；输入已保留");
    }
  }

  /** 先持久接收并占住会话，再异步摘要；相同请求键只核实原操作。
   * Note: 见 .agents/notes/implemented/feature/2026-10-11-manual-context-compaction.md
   */
  async compactSession(input: { sessionId: string; requestId: string; prompt?: string }): Promise<SessionCompactionRequest> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || (input.prompt !== undefined && typeof input.prompt !== "string")) {
      throw new RuntimeApiError("invalid_params", "压缩请求键或指引无效");
    }
    const prompt = input.prompt?.trim() || null;
    const paramsDigest = createHash("sha256").update(JSON.stringify([input.sessionId, prompt])).digest("hex");
    const existing = getCompactionRequest(this.store, input.requestId);
    if (existing) {
      if (existing.paramsDigest !== paramsDigest) throw new RuntimeApiError("request_conflict", "压缩请求键已用于不同参数");
      return existing;
    }
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝上下文压缩");
    if (!this.config.product.manualCompaction) throw new RuntimeApiError("unavailable", "当前产品不提供手动上下文压缩");
    const session = this.getSession(input.sessionId);
    if (this.store.getSessionIdentity(session.id)?.kind !== "dev") throw new RuntimeApiError("invalid_state", "只有普通开发会话可以手动压缩上下文");
    this.assertNoSessionCompaction(session.id);
    if (this.loopActive.has(session.id) || this.store.listTasksBySession(session.id).some(task => ACTIVE_TASK_STATUSES.includes(task.status))) {
      throw new RuntimeApiError("session_busy", "此会话有排队、启动中或活动任务，请等待完成或先停止任务");
    }
    const modelSelection = { ...(session.modelSelection ?? this.defaultSelection) };
    let summaryModel: SummaryModel;
    try { summaryModel = loadSummaryModel(this.config.agentDir) ?? { provider: modelSelection.provider, modelId: modelSelection.modelId }; }
    catch { throw new RuntimeApiError("summary_model_invalid", "摘要模型配置损坏，请修复摘要模型配置后重试"); }
    this.models.assertAvailable(summaryModel.provider);
    const request: SessionCompactionRequest = { requestId: input.requestId, sessionId: session.id, prompt, paramsDigest, modelSelection, summaryModel,
      source: null, expectedCheckpointId: null, status: "running", checkpointId: null, summarizedCount: 0, estimateBefore: null, estimateAfter: null,
      errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), endedAt: null };
    const operation = { request, controller: new AbortController(), promise: Promise.resolve() };
    this.compactions.set(session.id, operation);
    try { this.store.withTx(() => reserveCompactionRequest(this.store, request)); }
    catch (error) {
      const committed = getCompactionRequest(this.store, request.requestId);
      if (!committed || committed.paramsDigest !== paramsDigest) {
        this.compactions.delete(session.id);
        if (error instanceof StoreConflictError) throw new RuntimeApiError(error.code, error.message);
        throw error;
      }
      // 提交后广播失败不能留下没有执行者的在途请求。
    }
    const accepted = getCompactionRequest(this.store, request.requestId)!;
    if (accepted.status !== "running") {
      this.compactions.delete(session.id);
      return accepted;
    }
    const catalog = this.models.current.modelCatalog;
    const modelRuntime = this.models.current.modelRuntime;
    operation.promise = Promise.resolve().then(() => this.runSessionCompaction(session, operation, catalog, modelRuntime)).finally(() => {
      this.compactions.delete(session.id);
    });
    return request;
  }

  getSessionCompaction(input: { sessionId: string; requestId?: string }): SessionCompactionRequest | null {
    this.getSession(input.sessionId);
    const request = input.requestId ? getCompactionRequest(this.store, input.requestId) : getLatestSessionCompaction(this.store, input.sessionId);
    if (request && request.sessionId !== input.sessionId) throw new RuntimeApiError("request_conflict", "压缩请求不属于此会话");
    return request;
  }

  interruptSessionCompaction(input: { sessionId: string; requestId: string }): SessionCompactionRequest {
    const request = this.getSessionCompaction(input);
    if (!request) throw new RuntimeApiError("not_found", "压缩请求不存在，请核实原请求");
    let result: SessionCompactionRequest;
    try {
      result = this.store.withTx(() => finishCompactionRequest(this.store, request.requestId, { status: "cancelled", errorCode: "summary_canceled", errorMessage: "压缩已取消，未替换压缩点" }));
    } catch (error) {
      const committed = getCompactionRequest(this.store, request.requestId);
      if (!committed || committed.status === "running") throw error;
      result = committed;
    }
    const operation = this.compactions.get(input.sessionId);
    if (operation?.request.requestId === request.requestId && result.status === "cancelled") operation.controller.abort();
    return result;
  }

  private async runSessionCompaction(session: Session, operation: { request: SessionCompactionRequest; controller: AbortController }, catalog: ModelCatalog, modelRuntime: ModelRuntime): Promise<void> {
    const { request, controller } = operation;
    let checkpoint: ContextCheckpoint | null = null;
    try {
      if (controller.signal.aborted) return;
      checkpoint = this.store.getActiveCheckpoint(session.id);
      if (!session.sessionFile) {
        if (checkpoint) throw new ManualCompactionError("checkpoint_invalid", "压缩点对应的历史缺失，请恢复历史后重试");
        if (session.branchSource || this.store.listTasksBySession(session.id).some(task => task.status === "completed")) throw new RuntimeApiError("history_corrupt", "会话历史缺失，请恢复历史后重试");
        this.store.withTx(() => finishCompactionRequest(this.store, request.requestId, { status: "noop", estimateBefore: 0, estimateAfter: 0 }));
        return;
      }
      let snapshot: HistorySnapshot;
      try { snapshot = snapshotSessionHistory(session.sessionFile, id => {
        const task = this.store.getTask(id);
        return task && (task.sessionId === session.id || session.branchSource?.taskIds.includes(id)) ? task.status : null;
      }, { allowEmpty: true }); }
      catch (error) {
        if (error instanceof HistoryReadError) throw error;
        throw new RuntimeApiError("history_corrupt", "会话历史不可读，请恢复历史后重试");
      }
      if (snapshot.entries[0]!.id !== session.piSessionId || snapshot.excluded.length || snapshot.byteLimit !== fs.statSync(session.sessionFile).size) {
        throw new RuntimeApiError("history_corrupt", "历史身份或尾部无法核实，请恢复完整历史后重试");
      }
      const { entries, ...source } = snapshot;
      this.store.withTx(() => updateCompactionSource(this.store, request.requestId, source, checkpoint?.id ?? null));
      const budget = { ...DEFAULT_BUDGET_CONFIG, ...this.config.budgetOverrides };
      const inspected = inspectManualCompaction({ entries, sessionId: session.id, checkpoint, prompt: request.prompt ?? undefined, budget });
      const result = inspected.plan ? await generateManualCompaction({ entries, sessionId: session.id, checkpoint, checkpointId: randomId("ckpt"),
        modelRuntime, model: await catalog.resolve({ ...request.summaryModel, thinkingLevel: "off" }), signal: controller.signal,
        prompt: request.prompt ?? undefined, budget, timeoutMs: this.config.compaction?.summaryTimeoutMs }) : { kind: "noop" as const, estimateBefore: inspected.estimateBefore };
      if (controller.signal.aborted) return;
      this.store.withTx(() => {
        const current = this.getSession(session.id);
        if (current.sessionFile !== source.file || current.piSessionId !== session.piSessionId || this.store.getSessionIdentity(session.id)?.kind !== "dev" || fs.statSync(source.file).size !== source.byteLimit) {
          throw new RuntimeApiError("source_changed", "来源历史或会话身份已改变，请核实后重试");
        }
        readHistoryPrefix(source.file, source);
        if (result.kind === "noop") {
          finishCompactionRequest(this.store, request.requestId, { status: "noop", estimateBefore: result.estimateBefore, estimateAfter: result.estimateBefore });
        } else {
          const cp: Omit<ContextCheckpoint, "status"> = { ...result.checkpoint, sessionId: session.id, taskId: null, callIndex: null, manualRequestId: request.requestId, createdAt: new Date().toISOString() };
          finishCompactionRequest(this.store, request.requestId, { status: "succeeded", summarizedCount: cp.summarizedCount, estimateBefore: cp.estimateBefore, estimateAfter: cp.estimateAfter }, cp);
        }
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof ManualCompactionError || error instanceof ModelSelectionError || error instanceof RuntimeApiError || error instanceof HistoryReadError || error instanceof StoreConflictError ? error.code : "compaction_failed";
      const reason = code === "checkpoint_invalid" ? "原压缩点已失效，不能继续使用；请核实历史后重试" :
        code === "summary_timeout" ? "摘要超时，请稍后重试" :
        code === "summary_empty" ? "摘要模型返回空内容，请检查模型后重试" :
        code === "summary_output_limit" ? "摘要输出达到上限，请调整摘要模型后重试" :
        code === "summary_input_budget_exceeded" ? "摘要输入超过模型预算，请选择更大窗口的摘要模型或缩短指引后重试" :
        code.startsWith("model_") || code === "thinking_not_supported" ? "所选模型不可用，请检查模型与凭据配置后重试" :
        code === "history_corrupt" || code === "source_changed" ? "来源历史无法核实，请恢复完整历史后重试" : "上下文压缩失败，请核实原请求和模型配置后重试";
      try {
        this.store.withTx(() => {
          if (code === "checkpoint_invalid") {
            const old = checkpoint?.id;
            if (old) this.store.invalidateCheckpoint(old);
          }
          finishCompactionRequest(this.store, request.requestId, { status: "failed", errorCode: code, errorMessage: reason });
        });
      } catch (failure) {
        process.stderr.write(`[ruukoto:compaction] 请求 ${request.requestId} 无法保存失败终态：${this.scrubSecrets((failure as Error).message)}\n`);
      }
    }
  }

  getSessionTodos(sessionId: string) {
    return this.withSessionHistory(sessionId, file => {
      const params = file ? historyTodoParams(parseSessionFile(file)) : null;
      return { todos: params === null ? null : parseTodos(params) };
    });
  }

  /**
   * 打开工作区（agent-direction issue 05）：按真实目录身份（realpath/dev+ino）
   * 复用或创建工作区并新建会话。工作区实例上是带根目录归属的项目；旧项目可经
   * projectId 认领根目录（保留旧关系），已归属他目录的项目拒绝改归属。同一
   * createRequestId 重发返回原会话；目录校验与认领/建项目/建会话在同一事务，
   * 失败不留空项目。
   */
  async openWorkspace(input: {
    cwd: string;
    mode?: SessionDefaultMode;
    modelSelection?: ModelSelection;
    /** 指定既有项目（旧项目认领或显式选择）；缺省按目录身份自动复用/创建。 */
    projectId?: string;
    /** 启动请求标识（幂等键）：重发返回原会话。 */
    createRequestId?: string;
  }): Promise<{ session: Session; projectName: string; createdProject: boolean }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    if (input.createRequestId && getBranchRequest(this.store, input.createRequestId)) throw new RuntimeApiError("request_conflict", "请求键已用于会话分支");
    const identity = await this.resolveUsableDir(input.cwd);
    const settings = await this.sessionCreationSettings(input);
    try {
      return this.store.withTx(() => {
        // 应答丢失后的同一标识重发：直接返回首次成果，项目/会话都不重建；
        // 同键异目录按 request_conflict 处理（与 create_session 同一纪律，
        // 目录身份同样是 realpath 或 dev+ino 别名判定）
        if (input.createRequestId) {
          const replay = this.store.findSessionByCreateRequestId(input.createRequestId);
          if (replay) {
            const replayIdentity: DirIdentity = { cwd: replay.cwd, cwdReal: replay.cwdReal, dev: replay.cwdDev, ino: replay.cwdIno };
            if (!sameDirIdentity(replayIdentity, identity)) {
              throw new StoreConflictError(`request_id 已存在且目录不同：session=${replay.id}`, "request_conflict");
            }
            return { session: replay, projectName: this.store.getProject(replay.projectId)!.name, createdProject: false };
          }
        }
        settings.check?.();
        let project: Project | null = null;
        let createdProject = false;
        if (input.projectId) {
          const target = this.store.getProject(input.projectId);
          if (!target) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
          project = target;
          // 逻辑角色与群聊会话所在的项目不是可认领的旧项目（可信入口不会发，后台兜底）
          const rolesOfRuntime = this.store.listAgentRoles();
          if (rolesOfRuntime.some((r) => r.projectId === target.id) || this.store.listSessions().some((s) => s.projectId === target.id && s.kind !== "dev")) {
            throw new RuntimeApiError("invalid_params", "角色或群聊项目不能作为工作区认领");
          }
          // 多目录旧项目不能在迁移流程之外认领到其中一个目录（issue 07 步骤 2 收紧；
          // 与 control/workspace.ts 的候选筛选同一判定（legacyProjectClaimableFromDir）；
          // 目录仍否有效由迁移预览核实，不在此做文件系统检查
          if (!legacyProjectClaimableFromDir(this.store.listSessions().filter((s) => s.projectId === target.id), rolesOfRuntime.map((r) => r.sessionId))) {
            throw new RuntimeApiError("invalid_params", "旧项目会话分布在多个目录，不能在迁移流程之外认领到其中一个目录；请用 project migration-preview 组织迁移");
          }
          if (!project.rootDir) {
            this.store.attachProjectRoot(project.id, identity);
          } else if (!sameDirIdentity(project.rootDir, identity)) {
            throw new RuntimeApiError("invalid_params", `项目已归属其他工作区目录：${project.rootDir.cwdReal}`);
          }
        } else {
          project = this.store.findProjectByRoot(identity);
          if (!project) {
            // 自动项目名取根目录名，重名仅展示层去重（同名不同目录绝不合并）
            const base = path.basename(identity.cwdReal) || "workspace";
            for (let n = 1; ; n++) {
              const name = n === 1 ? base : `${base} (${n})`;
              if (!this.store.findProjectByName(name)) {
                project = this.store.createProject(name, input.createRequestId, identity);
                createdProject = true;
                break;
              }
            }
          }
        }
        const session = this.store.createSession({
          projectId: project.id,
          kind: "dev",
          cwd: identity.cwd,
          cwdReal: identity.cwdReal,
          cwdDev: identity.dev,
          cwdIno: identity.ino,
          piSessionId: randomUUID(),
          confirmTools: [],
          createRequestId: input.createRequestId,
          modelSelection: settings.modelSelection,
          defaultAccessMode: settings.mode,
        });
        return { session, projectName: project.name, createdProject };
      });
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
  }

  /** 解析目录身份并校验不是保护根本身、其子级或其祖先。 */
  private async resolveUsableDir(cwd: string): Promise<DirIdentity> {
    const identity = await resolveDirIdentity(cwd).catch((err: DirIdentityError) =>
      Promise.reject(new RuntimeApiError("invalid_params", err.message)),
    );
    try {
      assertGrantNotProtected(identity.cwdReal, this.protectedRoots());
    } catch (err) {
      throw new RuntimeApiError("invalid_params", `工作区不可用：${(err as Error).message}`);
    }
    return identity;
  }

  listWorkspaceFiles(input: { workspaceId: string; path?: string }) {
    const root = this.store.getProject(input.workspaceId)?.rootDir;
    if (!root) throw new RuntimeApiError("workspace_not_found", "工作区不存在或尚未登记目录，请重新选择工作区。");
    return listWorkspaceFiles(input.workspaceId, root, input.path ?? "", this.protectedRoots());
  }

  readWorkspaceFile(input: { workspaceId: string; path: string; offset?: number; length?: number; version?: string }) {
    const root = this.store.getProject(input.workspaceId)?.rootDir;
    if (!root) throw new RuntimeApiError("workspace_not_found", "工作区不存在或尚未登记目录，请重新选择工作区。");
    return readWorkspaceFile(input.workspaceId, root, input.path, this.protectedRoots(), input);
  }

  readWorkspaceGit(input: { workspaceId: string; cursor?: string }) {
    const root = this.store.getProject(input.workspaceId)?.rootDir;
    if (!root) throw new RuntimeApiError("workspace_not_found", "工作区不存在或尚未登记目录，请重新选择工作区。");
    return readWorkspaceGit(input.workspaceId, root, this.protectedRoots(), input.cursor);
  }

  /**
   * 旧数据 → 工作区的组织迁移（agent-direction issue 07 步骤 2/3）：
   * 全部推断集中在 workspace-migration.ts，这里只做接线。预览零写入；
   * 应用先查成功回执再核修订，单事务提交，失败整体回滚。
   */
  previewWorkspaceMigration(input: MigrationPreviewInput): MigrationPreview {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    return previewWorkspaceMigration(
      { store: this.store, instanceId: this.db.getInstanceId(), protectedRoots: this.protectedRoots() },
      input,
    );
  }

  applyWorkspaceMigration(input: MigrationApplyInput): MigrationApplyResult {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    return applyWorkspaceMigration(
      { store: this.store, instanceId: this.db.getInstanceId(), protectedRoots: this.protectedRoots() },
      input,
    );
  }

  getSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", "会话不存在");
    return session;
  }

  // Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md
  private workspaceChats(): Session[] {
    if (this.productType !== "ruukoto-code") throw new RuntimeApiError("unavailable", "工作区搜索只向 Code 开放");
    return this.store.listSessions().filter(session => this.store.getSessionIdentity(session.id)?.kind === "dev");
  }

  /** 旧查询按原项目或组织归属；workspace_chats 由后台身份筛选并覆盖全部工作区。 */
  listSessionSummaries(input: { projectId?: string; workspaceId?: string; scope?: "workspace_chats" }): Array<{ sessionId: string; name: string | null; lastActiveAt: string; workspaceId?: string; archivedAt?: string | null }> {
    if (input.projectId && input.workspaceId) throw new RuntimeApiError("invalid_params", "project_id 与 workspace_id 互斥，只能传其一");
    if (input.scope === "workspace_chats") {
      const sessions = new Map(this.workspaceChats().map(session => [session.id, session]));
      if (input.projectId || input.workspaceId) throw new RuntimeApiError("invalid_params", "workspace_chats 查询使用全部工作区，不接受项目限制");
      return this.store.listAllSessionSummaries().flatMap(summary => {
        const session = sessions.get(summary.sessionId);
        return session ? [{ ...summary, workspaceId: session.workspaceProjectId ?? session.projectId, archivedAt: session.archivedAt }] : [];
      });
    }
    const id = input.workspaceId ?? input.projectId;
    if (!id) throw new RuntimeApiError("invalid_params", "project_id 或 workspace_id 必填其一");
    if (!this.store.getProject(id)) throw new RuntimeApiError("not_found", "项目不存在");
    return input.workspaceId ? this.store.listSessionSummariesForWorkspace(id) : this.store.listSessionSummaries(id);
  }

  async setSessionModel(input: { sessionId: string; modelSelection: ModelSelection; expectedVersion: number }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    this.getSession(input.sessionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new RuntimeApiError("invalid_params", "expected_version 必须为非负整数");
    const selection = parseModelSelection(input.modelSelection);
    // 配置应用期间不得为受影响 provider 钉入新引用（与 §4 删除核实同一同步段语义）
    const check = await this.models.resolveSelection(selection);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    return this.store.withTx(() => {
      check();
      return this.store.setSessionModel(input.sessionId, selection, input.expectedVersion);
    });
  }

  /** 秘密脱敏：配置文件当前含有的 API key、OAuth token、headers 值不得出现在错误文本里。 */
  private scrubSecrets(text: string): string {
    let out = text;
    for (const secret of configSecrets(this.config.agentDir)) out = out.split(secret).join("***");
    return out;
  }


  // ---------- 提交与排队 ----------

  /**
   * 校验拥有者为任务显式授予的工作区外路径：必须存在，且不得是保护根
   * （后台数据、凭据、控制面、服务代码）本身、其子级或其祖先；不得覆盖
   * 宿主管理的工作副本根（agent-work/worktrees，issue 16：子任务副本只能
   * 经委派范围访问，授予路径是旁路，绕过单一写入者）。
   */
  private validateGrantedPaths(paths: GrantedPath[]): GrantedPath[] {
    const resolved: GrantedPath[] = [];
    let worktreesRoot = path.join(path.dirname(path.resolve(this.config.dataDir)), "agent-work", "worktrees");
    try {
      worktreesRoot = fs.realpathSync(worktreesRoot);
    } catch {
      // 根尚未创建：与路径参数的 realpath 比较前以 resolve 的父链归一
      worktreesRoot = path.resolve(worktreesRoot);
    }
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
      // 工作副本模块统一负责旁路写入保护；Runtime 仍负责将错误翻译为控制面错误。
      try {
        assertWorktreeGrantAllowed(real, p.access, worktreesRoot);
      } catch (err) {
        throw new RuntimeApiError("invalid_params", (err as Error).message);
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

  putAttachment(input: AttachmentUpload) {
    if (!input || typeof input.session_id !== "string" || !input.session_id) throw new RuntimeApiError("invalid_params", "请选择会话后附加文件。");
    const session = this.store.getSession(input.session_id);
    if (!session || !["dev", "main"].includes(this.store.getSessionIdentity(session.id)?.kind ?? "")) throw new RuntimeApiError("attachment_scope", "请选择用户会话后附加文件。");
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，请稍后重新选择文件。");
    try { return this.attachments.put(input); }
    catch (error) { if (error instanceof RuntimeApiError) throw error; throw new RuntimeApiError("attachment_unavailable", "附件保存失败，未提交任务；请检查后台存储后重新选择文件。"); }
  }

  async submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    attachments?: AttachmentMetadata[];
    accessMode?: SessionDefaultMode;
    grantedPaths?: GrantedPath[];
    resumesTaskId?: string;
    modelSelection: ModelSelection;
    /**
     * 编排字段（issue 01）：仅后台编排器经窄接口传递（子任务/事件任务/唤醒）。
     * 控制面 ops 不接受这些字段，模型与客户端无法设置。
     */
    agentId?: AgentRoleId | null;
    parentTaskId?: string | null;
    sourcePermissionVersion?: number | null;
    sourceEventId?: string | null;
    deadline?: string | null;
    /** 仅宿主最终送达使用；与汇总任务在同一事务建立可信绑定。 */
    workflowRunId?: string;
    reportKey?: string;
    reportKeys?: string[];
    /** 仅可信问题入口提交；客户端与模型不能指定回答来源。 */
    ownerAnswer?: { questionId: string; version: number; answers: OwnerAnswer[] };
  }, internal = false): Promise<TaskView> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    if (typeof input.input !== "string" || (!input.input.trim() && !input.attachments?.length)) throw new RuntimeApiError("invalid_params", "请输入消息或选择附件。");
    if (input.workflowRunId && !internal) throw new RuntimeApiError("invalid_params", "工作流汇总只能由宿主登记");
    if (input.reportKey && !internal) throw new RuntimeApiError("invalid_params", "结果补报只能由宿主登记");
    if (input.reportKeys && !internal) throw new RuntimeApiError("invalid_params", "结果补报只能由宿主登记");
    if (input.ownerAnswer && (!internal || this.store.getSessionIdentity(session.id)?.kind !== "dev")) throw new RuntimeApiError("invalid_params", "请从问题卡片提交回答。");
    const identity = this.store.getSessionIdentity(session.id)!;
    // SubAgent 子会话（agent-direction issue 11）：不是普通用户对话入口；任务
    // 只能经集中委派登记（直接写库，不经本入口），控制面不能把它当作用户会话提交
    if (identity.kind === "subagent" || (identity.kind === "scheduled" && !internal)) {
      throw new RuntimeApiError(
        "invalid_state",
        identity.kind === "subagent" ? "该会话是 SubAgent 的独立工作会话，不能提交用户对话或另行继续"
          : "该独立调度会话由宿主管理，不能提交用户对话或另行继续",
      );
    }
    // 固定角色已退役（agent-direction issue 20/23）：qq_group 会话与 chat/coding
    // 角色会话是只读归档，拒绝作为对话入口重新提交；continueTask 经本入口提交，一并覆盖
    if (identity.kind === "retired") {
      throw new RuntimeApiError("invalid_state", identity.reason === CORE_GROUP_CHAT_RETIRED
        ? "核心群聊已退役：该会话是只读归档，不能提交任务（历史可经 qq inbox / read_history 查阅）"
        : "固定 coding 角色已退役：该会话是只读归档，不能提交任务（委派改用 subagent_delegate，旧结果经 coding_result / read_history 查阅）");
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
    // 默认模式只决定新任务；重试摘要绑定原请求，后续修改默认值不会改变已接收任务。
    const mode = input.accessMode ?? session.defaultAccessMode;
    if (!isSessionDefaultMode(mode)) {
      throw new RuntimeApiError("invalid_params", `模式无效：${mode}`);
    }
    const planMode = mode === "plan";
    if (planMode && identity.kind !== "dev") {
      throw new RuntimeApiError("invalid_params", "Plan 只能在普通开发会话中使用");
    }
    const accessMode = mode === "plan" ? "auto-review" : mode;
    const selection = parseModelSelection(input.modelSelection);
    // 未指定模式记录 null；有效模式另存于任务，重试不重新采用会话默认值。
    const digestBase = {
      input: input.input, accessMode: input.accessMode ?? null,
      grantedPaths: (input.grantedPaths ?? []).map(p => ({ path: p.path, access: p.access, purpose: p.purpose || "未说明" })),
      resumesTaskId: input.resumesTaskId ?? null, modelSelection: selection,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
    const submission = {
      ...digestBase,
      agentId: input.agentId ?? null, parentTaskId: input.parentTaskId ?? null, sourcePermissionVersion: input.sourcePermissionVersion ?? null,
      sourceEventId: input.sourceEventId ?? null, deadline,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.reportKey ? { reportKey: input.reportKey } : {}),
      ...(input.reportKeys ? { reportKeys: input.reportKeys } : {}),
      ...(input.ownerAnswer ? { ownerAnswer: input.ownerAnswer } : {}),
    };
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const submissionDigest = `request-v2:${digest(submission)}`;
    const existing = this.store.findMatchingSubmission({ sessionId: input.sessionId, requestId: input.requestId, submissionDigest });
    if (existing) return this.taskView(existing);
    const attachments = this.attachments.prepare(session.id, input.attachments ?? []);
    this.assertNoSessionCompaction(input.sessionId);
    // 模型配置应用门闩（issue 21 §4）：幂等重试放行（不新建任务），
    // 受影响 provider 的新提交在应用期间拒绝进入队列；continueTask 经
    // this.submit 走同一检查
    const sourceEvent = input.sourceEventId ? this.store.getInboundEvent(input.sourceEventId) : null;
    const check = await this.models.resolveSelection(selection, (sourceEvent !== null && this.inboundMedia.hasMedia(sourceEvent)) || attachments.some(item => item.metadata.mimeType !== null));
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
        const raced = this.store.findMatchingSubmission({ sessionId: input.sessionId, requestId: input.requestId, submissionDigest });
        if (raced) return { task: raced, duplicate: true };
        this.assertNoSessionCompaction(input.sessionId);
        check();
        const reportKeys = input.reportKeys ?? (input.reportKey ? [input.reportKey] : []);
        for (const key of reportKeys) {
          const report = getAgentReport(this.store, key);
          if (!report || report.parentSessionId !== session.id || report.status !== "pending" || report.claimTaskId ||
              !this.verifyAgentWaitTarget(report.source, report.target)) throw new AgentWaitError("report_owned");
        }
        let workflow: WorkflowRun | null = null;
        if (input.workflowRunId) {
          workflow = requireWorkflowRun(this.store, input.workflowRunId);
          if (!workflowTerminal(workflow.status) || !workflow.delivery || workflow.delivery.status !== "pending" ||
              workflow.delivery.taskId || workflow.delivery.version !== workflow.terminalVersion || !this.verifyWorkflowReport(workflow) ||
              workflow.source.sessionId !== session.id || workflow.source.projectId !== session.projectId ||
              input.requestId !== workflowDeliveryKey(workflow) || input.input !== workflowWakeInput(workflow) ||
              input.parentTaskId !== workflow.source.taskId || input.sourcePermissionVersion !== workflow.source.permissionVersion ||
              accessMode !== workflow.source.accessMode || input.sourceEventId != null ||
              !isDeepStrictEqual(input.grantedPaths ?? [], workflow.source.grantedPaths) ||
              input.agentId !== (identity.kind === "main" ? identity.role.id : null)) throw new WorkflowError("delivery_invalid");
        }
        if (identity.kind === "scheduled") {
          const source = input.parentTaskId ? this.store.getTask(input.parentTaskId) : null;
          const run = source ? this.store.getScheduledRunForTask(source.id) : null;
          if (!source || run?.id !== identity.runId || run.closedAt || run.scheduleStatus === "canceled" ||
              source.permissionVersion !== input.sourcePermissionVersion || source.accessMode !== accessMode) {
            throw new RuntimeApiError("task_ending", "调度派生任务的来源授权已失效，拒绝登记");
          }
        }
        const ordinaryInbound = input.sourceEventId && input.requestId === `evt:${input.sourceEventId}` && (!sourceEvent || !this.inboundMedia.hasMedia(sourceEvent)) ? this.store.getInboundEvent(input.sourceEventId) : null;
        if (ordinaryInbound && (ordinaryInbound.status !== "registered" || this.inboundGate(ordinaryInbound) !== "run")) {
          throw new RuntimeApiError("task_ending", "入站来源已失效或暂不可用，拒绝登记新任务");
        }
        const queued = this.store.insertQueuedTask({
          sessionId: input.sessionId,
          requestId: input.requestId,
          input: input.input,
          accessMode,
          planMode,
          grantedPaths,
          resumesTaskId: input.resumesTaskId,
          modelSelection: selection,
          submissionDigest,
          agentId: input.agentId ?? null,
          parentTaskId: input.parentTaskId ?? null,
          sourcePermissionVersion: input.sourcePermissionVersion ?? null,
          sourceEventId: input.sourceEventId ?? null,
          deadline,
        });
        if (!queued.duplicate) this.attachments.bind(queued.task.id, session.id, attachments);
        if (input.ownerAnswer) consumeOwnerQuestion(this.store, { questionId: input.ownerAnswer.questionId, sessionId: session.id,
          version: input.ownerAnswer.version, requestKey: input.requestId, requestDigest: submissionDigest,
          answers: input.ownerAnswer.answers, source: { kind: "coding-owner", sessionId: session.id }, taskId: queued.task.id });
        if (ordinaryInbound) this.store.markInboundQueued(ordinaryInbound.id, queued.task.id);
        if (workflow) updateWorkflowRun(this.store, { ...workflow, delivery: { ...workflow.delivery!, taskId: queued.task.id, status: "queued" } });
        for (const key of reportKeys) bindAgentReportFallback(this.store, key, queued.task.id);
        return queued;
      }));
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
    if (!duplicate) {
      const trustedOwnerInput = !internal || Boolean(input.ownerAnswer) || Boolean(task.sourceEventId && task.requestId === `evt:${task.sourceEventId}` &&
        sourceEvent && [QQ_PRIVATE_SOURCE, TELEGRAM_SOURCE].includes(sourceEvent.source) && this.inboundGate(sourceEvent) === "run");
      const driver = this.drivers.get(input.sessionId), activeTaskId = driver?.currentTaskId;
      if (trustedOwnerInput && driver && activeTaskId && this.agentWait.interrupt(activeTaskId, "owner_input")) {
        const active = this.store.getTask(activeTaskId)!;
        await driver.requestStop(active, { terminal: "interrupted", reason: "owner_input", cancelIntent: false });
      }
      this.kick(input.sessionId);
    }
    return this.taskView(task);
  }

  private verifyBackgroundCaller(taskId: string, sessionId: string): void {
    const task = this.store.getTask(taskId);
    if (!task || task.sessionId !== sessionId || task.status !== "running" || task.cancelRequested || !ownerQuestionTaskEligible(this.store, task)) throw new BackgroundProcessError("background_source_invalid", "当前输入没有本会话后台资格；结束本轮并报告拥有者。");
  }

  private backgroundSourceProblem(record: BackgroundProcess): string | null {
    const task = this.store.getTask(record.taskId), session = this.store.getSession(record.sessionId);
    if (!task || !session || !ownerQuestionTaskEligible(this.store, task) || task.sessionId !== record.sessionId || session.projectId !== record.source.projectId || task.accessMode !== "full_access" || task.planMode || task.permissionVersion !== record.source.permissionVersion || !isDeepStrictEqual(task.grantedPaths, record.source.grantedPaths)) return "background_source_revoked";
    try {
      const directory = fs.statSync(record.workspace.path);
      if (!directory.isDirectory() || fs.realpathSync(record.workspace.path) !== record.workspace.path || directory.dev !== record.workspace.dev || directory.ino !== record.workspace.ino) return "background_directory_changed";
    } catch { return "background_directory_changed"; }
    return null;
  }

  listBackgroundProcesses(sessionId: string, offset = 0): { processes: BackgroundProcessView[]; totalCount: number; nextOffset: number | null } {
    if (!this.store.getSession(sessionId)) throw new RuntimeApiError("session_not_found", "会话不存在；请选择会话后查看后台。");
    return pageBackgroundProcesses(this.store, { sessionId, offset });
  }

  backgroundProcessOutput(input: { sessionId: string; processId: string; stream: "stdout" | "stderr"; offset?: number }) {
    return this.backgroundProcesses.read(input);
  }

  async stopBackgroundProcess(input: { sessionId: string; processId: string }): Promise<BackgroundProcessView> {
    this.backgroundProcesses.get(input.sessionId, input.processId);
    return this.backgroundProcesses.requestStop(input.processId);
  }

  async endSessionBackground(input: { sessionId: string; requestKey: string }): Promise<{ processes: BackgroundProcessView[]; stopVerified: boolean }> {
    if (!this.store.getSession(input.sessionId)) throw new RuntimeApiError("session_not_found", "会话不存在；请选择会话后结束后台。");
    return this.backgroundProcesses.closeSession(input.sessionId, input.requestKey);
  }

  listOwnerQuestions(sessionId: string, offset = 0, limit = 20): { questions: OwnerQuestionView[]; nextOffset: number | null } {
    if (!this.store.getSession(sessionId)) throw new RuntimeApiError("not_found", "会话不存在，请重新选择会话。");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RuntimeApiError("invalid_params", "问题页码须非负，每页1–20项。");
    const rows = listOwnerQuestions(this.store, sessionId, limit + 1, offset), questions: OwnerQuestionView[] = [];
    let bytes = 128;
    for (const row of rows.slice(0, limit)) {
      const question = ownerQuestionToView(row), size = frameBytes(question);
      if (bytes + size > 256 * 1024) break;
      questions.push(question); bytes += size;
    }
    return { questions, nextOffset: questions.length < rows.length ? offset + questions.length : null };
  }

  // Note: 见 .agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md
  async answerOwnerQuestion(input: { sessionId: string; questionId: string; version: number; requestId: string; answers: unknown;
    modelSelection: ModelSelection; accessMode?: SessionDefaultMode; grantedPaths?: GrantedPath[] }): Promise<TaskView> {
    const question = getOwnerQuestion(this.store, input.questionId);
    if (!question || question.sessionId !== input.sessionId) throw new RuntimeApiError("question_missing", "问题已不可用，请刷新问题卡片。");
    const answers = parseOwnerAnswers(input.answers, question.questions);
    const text = "[拥有者问题回答]\n" + question.questions.map((item, index) => `${index + 1}. ${item.question}${item.multiple ? "（多选）" : ""}${item.options ? `\n选项：${JSON.stringify(item.options)}` : ""}\n回答：${answers[index].text}`).join("\n\n");
    return this.submit({ sessionId: input.sessionId, requestId: input.requestId, input: text, modelSelection: input.modelSelection,
      accessMode: input.accessMode, grantedPaths: input.grantedPaths,
      ownerAnswer: { questionId: input.questionId, version: input.version, answers } }, true);
  }

  cancelOwnerQuestion(input: { sessionId: string; questionId: string; version: number; requestId: string }): OwnerQuestionView {
    const requestDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return ownerQuestionToView(this.store.withTx(() => cancelOwnerQuestion(this.store, { questionId: input.questionId,
      sessionId: input.sessionId, version: input.version, requestKey: input.requestId, requestDigest })));
  }

  findOwnerQuestionReceipt(sessionId: string, requestId: string, operation: "owner_question_answer" | "owner_question_cancel") {
    const receipt = getOwnerQuestionReceipt(this.store, sessionId, requestId, operation);
    return { receipt };
  }

  /**
   * 后台内部提交（编排器唤醒/委派、入站事件、QQ）：遇配置应用门闩等本次应用
   * 结束后按同一请求键重试——这些调用方没有人会手动重试，失败会滞留到重启。
   */
  private async submitInternal(input: Parameters<Runtime["submit"]>[0]): Promise<Task> {
    for (;;) {
      try {
        return await this.submit(input, true);
      } catch (err) {
        if (!(err instanceof RuntimeApiError) || err.code !== "model_config_busy") throw err;
        await this.models.whenConfigIdle();
      }
    }
  }

  /**
   * 中断任务的人工继续：新任务带 resumes_task_id；不自动重放任何执行。
   * 新任务沿用会话默认模式（提交时可显式覆盖）；旧批准不继承。
   */
  async continueTask(input: { taskId: string; sessionId?: string; requestId: string; input: string; attachments?: AttachmentMetadata[]; accessMode?: SessionDefaultMode; grantedPaths?: GrantedPath[]; modelSelection: ModelSelection }): Promise<TaskView> {
    const old = this.store.getTask(input.taskId);
    if (!old) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    if (this.store.listToolOpsByTask(old.id).some(op => op.mcp && op.effectUnknown)) throw new RuntimeApiError("cua_task_not_replayable", "电脑操作结果未知的旧任务不能继续；请完成电脑恢复后发起新工作。");
    if (getWorkflowExecution(this.store, old.id)) throw new RuntimeApiError("invalid_state", "工作流执行由运行恢复，不接受普通任务继续");
    if (workCopyHostFor(old)) throw new RuntimeApiError("invalid_state", "宿主工作副本操作不能作为模型任务继续；请核实保留现场后重新发起工作");
    if (input.sessionId !== undefined && input.sessionId !== old.sessionId) throw new RuntimeApiError("invalid_params", "源任务不属于指定会话");
    if (old.status !== "interrupted") {
      throw new RuntimeApiError("invalid_state", `只能继续已中断的任务，当前状态 ${old.status}`);
    }
    return this.submit({
      sessionId: old.sessionId,
      requestId: input.requestId,
      input: input.input,
      attachments: input.attachments,
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
  /**
   * 拥有者存档/取消存档：只把会话从工作区会话列表隐藏，不改资料身份、历史、
   * 任务或排队状态。宿主独立执行会话（角色、SubAgent、定时）不允许存档，避免
   * 隐藏后无人可见的长期执行会话。存档不要求空闲；运行中任务继续执行。
   */
  async setSessionArchived(input: { sessionId: string; archived: boolean }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    this.getSession(input.sessionId);
    if (typeof input.archived !== "boolean") throw new RuntimeApiError("invalid_params", "archived 必须是布尔值");
    const kind = this.store.getSessionIdentity(input.sessionId)?.kind;
    if (kind !== "dev" && kind !== "main") throw new RuntimeApiError("invalid_state", "宿主独立执行会话不能存档");
    try {
      return this.store.withTx(() => this.store.setSessionArchived(input.sessionId, input.archived));
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  async setSessionDefaultMode(input: { sessionId: string; mode: SessionDefaultMode; expectedVersion: number }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    this.getSession(input.sessionId);
    if (["subagent", "scheduled"].includes(this.store.getSessionIdentity(input.sessionId)?.kind ?? "")) {
      throw new RuntimeApiError("invalid_state", "宿主独立执行会话不允许修改默认模式");
    }
    if (!isSessionDefaultMode(input.mode)) {
      throw new RuntimeApiError("invalid_params", `会话默认模式无效：${input.mode}（${SESSION_DEFAULT_MODES.join(" | ")}）`);
    }
    if (input.mode === "plan" && this.store.getSessionIdentity(input.sessionId)?.kind !== "dev") {
      throw new RuntimeApiError("invalid_params", "Plan 只能在普通开发会话中使用");
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
  async switchTaskMode(input: { taskId: string; mode: AccessMode; grantedPaths?: GrantedPath[] }): Promise<TaskView> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝模式切换");
    const task = this.store.getTask(input.taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    if (getWorkflowExecution(this.store, task.id) || task.subAgentId || ["subagent", "scheduled"].includes(this.store.getSessionIdentity(task.sessionId)?.kind ?? "")) {
      throw new RuntimeApiError("invalid_state", "独立执行任务的权限模式由宿主保存的来源授权决定，不允许切换");
    }
    if (!isAccessMode(input.mode)) {
      throw new RuntimeApiError("invalid_params", `访问模式无效：${input.mode}`);
    }
    if (task.planMode) {
      throw new RuntimeApiError("invalid_state", "Plan 任务不能切换权限模式；请先中断，再按当前会话模式继续");
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
      this.modeSwitchStopping.add(task.id);
      try {
        const [managedReaped, browserReaped] = await Promise.all([driver ? driver.stopManagedProcesses(task.id) : true,
          driver?.currentTaskId && driver.currentTaskId !== task.id ? true : this.browserManager.close(task.sessionId)]);
        const reaped = managedReaped && browserReaped;
        if (!reaped) {
          await driver?.requestStop(task, {
            terminal: "interrupted", reason: "mode_switch_unverified", cancelIntent: false,
            modeSwitchFailure: { to: input.mode, reason: "无法核实旧执行单元已退出" },
          });
          throw new RuntimeApiError("mode_switch_unverified", "无法核实旧执行单元已退出，任务已中断（占用保留待核实）");
        }
        this.store.withTx(() => {
          const current = this.store.getTask(task.id);
          if (!current || isTerminalTaskStatus(current.status) || current.cancelRequested || current.permissionVersion !== task.permissionVersion) {
            throw new RuntimeApiError("invalid_state", "任务已结束、正在停止或权限已变化：拒绝提交迟到的模式切换");
          }
          let version = current.permissionVersion;
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
        return this.taskView(this.store.getTask(task.id)!);
      } finally {
        this.modeSwitchStopping.delete(task.id);
      }
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
    return this.taskView(this.store.getTask(task.id)!);
  }

  // ---------- 审批 / 产物 / 凭据 ----------

  /**
   * 拥有者查询任务产物正文（按 id、偏移、长度）。宿主依据任务归属查找，
   * 不接受任意宿主路径，不跨任务返回正文。
   */
  queryArtifact(input: { taskId: string; artifactId: string; sessionId?: string; offset?: number; length?: number }): { artifact: Artifact; encoding: "base64"; data: string } {
    const task = this.store.getTask(input.taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    let artifact = this.store.getArtifact(input.artifactId);
    if (!artifact || artifact.taskId !== input.taskId) {
      throw new RuntimeApiError("not_found", `产物不存在或不属于该任务：${input.artifactId}`);
    }
    if (input.sessionId && input.sessionId !== artifact.sessionId) {
      artifact = sourceArtifact(this.store, this.access, input.sessionId, artifact.id);
      if (!artifact) throw new RuntimeApiError("access_denied", "产物不在分支已核实的来源集合");
    }
    const offset = Math.max(0, input.offset ?? 0);
    // 上限按线上帧约束：base64 膨胀 4/3 + JSON 开销必须留在 MAX_FRAME_BYTES 内
    const length = Math.min(Math.max(1, input.length ?? 256 * 1024), 720 * 1024);
    const buf = this.artifacts.read(artifact.id, offset, Math.max(0, Math.min(length, artifact.byteCount - offset)));
    return { artifact, encoding: "base64", data: buf.toString("base64") };
  }

  listCredentialBindings(input: { projectId?: string; endpoint?: string } = {}) {
    if (input.projectId && !this.store.getProject(input.projectId)) throw new RuntimeApiError("not_found", "配置来源不存在，请重新选择。");
    let host: string | undefined;
    if (input.endpoint !== undefined) {
      try { host = parseMcpEndpoint(input.endpoint).host; }
      catch { throw new RuntimeApiError("invalid_params", "MCP 端点无效，请检查地址。"); }
    }
    const services = this.mcp.listServices();
    return this.credentials.list().flatMap(view => {
      const scope = this.credentials.get(view.name)?.scope;
      if (input.projectId && (view.purpose !== MCP_CREDENTIAL_PURPOSE || view.header.toLowerCase() !== "authorization" ||
          !this.credentials.getForUse(view.name, { projectId: input.projectId, operation: MCP_CREDENTIAL_PURPOSE }))) return [];
      if (host !== undefined && view.host !== host) return [];
      const references = services.filter(service => service.credential === view.name).map(service => ({
        serviceId: service.id, projectId: service.projectId, projectName: this.store.getProject(service.projectId)?.name ?? service.projectId, serviceName: service.name,
      }));
      return [{ ...view, scope, references }];
    });
  }

  mcpSources(input: { workspaceId: string; offset?: number; limit?: number; selectedProjectId?: string }) {
    if (!this.store.getProject(input.workspaceId)?.rootDir) throw new RuntimeApiError("workspace_not_found", "工作区不存在，请重新选择。");
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeApiError("invalid_params", "配置来源分页须为非负 offset 与 1–100 的 limit。");
    const sources = this.store.listWorkspaceConfigSources(input.workspaceId, offset, limit + 1, input.selectedProjectId);
    return { sources: sources.slice(0, limit).map(source => ({ ...source, serviceCount: this.mcp.countServices(source.projectId) })), offset, hasMore: sources.length > limit };
  }

  // Note: 见 .agents/notes/implemented/feature/2026-10-21-code-mcp-settings.md
  mcpSaveCredential(input: { projectId: string; name: string; endpoint: string; secret: string }) {
    if (!this.store.getProject(input.projectId)) throw new RuntimeApiError("not_found", "配置来源不存在，请重新选择。");
    if (!input.name.trim() || input.name.length > 128 || /[\r\n]/.test(input.name) || !input.secret || input.secret !== input.secret.trim() || /[\r\n]/.test(input.secret)) throw new RuntimeApiError("invalid_params", "凭据名称与令牌不能为空、不能含换行，令牌首尾不能有空白。");
    let endpoint: URL;
    try { endpoint = parseMcpEndpoint(input.endpoint); }
    catch { throw new RuntimeApiError("invalid_params", "MCP 端点无效，请检查地址。"); }
    if (this.credentials.get(input.name)) throw new RuntimeApiError("credential_exists", "凭据名称已存在，请为本次保存使用新的名称。");
    this.credentials.upsert({ name: input.name, host: endpoint.host, header: "authorization", purpose: MCP_CREDENTIAL_PURPOSE, secret: input.secret, scope: { projectId: input.projectId, operations: [MCP_CREDENTIAL_PURPOSE] } });
    return this.listCredentialBindings({ projectId: input.projectId, endpoint: input.endpoint }).find(binding => binding.name === input.name)!;
  }

  mcpRemoveCredential(projectId: string, name: string): { removed: boolean } {
    if (!this.store.getProject(projectId)) throw new RuntimeApiError("not_found", "配置来源不存在，请重新选择。");
    const binding = this.credentials.get(name);
    if (!binding) return { removed: false };
    if (binding.purpose !== MCP_CREDENTIAL_PURPOSE || binding.header.toLowerCase() !== "authorization" || binding.scope?.projectId !== projectId || binding.scope.operations?.length !== 1 || binding.scope.operations[0] !== MCP_CREDENTIAL_PURPOSE || binding.scope.repoId !== undefined) throw new RuntimeApiError("credential_scope_mismatch", "此凭据不专属于当前 MCP 配置来源，请保留原凭据并另建绑定。");
    if (this.mcp.listServices().some(service => service.credential === name)) throw new RuntimeApiError("credential_in_use", "仍有服务引用此凭据，请先解除所有服务引用后再移除。");
    return { removed: this.credentials.remove(name) };
  }

  async addCredentialBinding(input: { name: string; host: string; header: string; purpose: string; secret: string }) {
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
    // 内容有变化时先使引用它的 IM 配置代次失效（agent-direction issue 08），再写凭据；
    // 凭据写失败不恢复旧版本，明确报错
    if (!existing || existing.secret !== input.secret || existing.host !== input.host.toLowerCase() ||
        existing.header !== input.header || existing.purpose !== input.purpose) {
      this.imEntries.bumpForCredential(input.name);
      this.credentials.upsert({ ...input, host: input.host.toLowerCase(), scope });
      await this.imEntries.reconcileAfterCredential(input.name);
    } else {
      this.credentials.upsert({ ...input, host: input.host.toLowerCase(), scope });
    }
    return { name: input.name, host: input.host.toLowerCase(), header: input.header, purpose: input.purpose };
  }

  async removeCredentialBinding(name: string): Promise<boolean> {
    if (!this.credentials.get(name)) return false;
    // 先使引用它的 IM 配置代次失效，再删除凭据；删除失败不恢复旧版本
    this.imEntries.bumpForCredential(name);
    const removed = this.credentials.remove(name);
    await this.imEntries.reconcileAfterCredential(name);
    return removed;
  }

  // ---------- MCP 服务配置（issue 16 §2/§6） ----------

  /**
   * 配置/更新项目的 MCP 服务（拥有者操作）。端点生产固定 https（http 仅限
   * 回环模拟服务）；凭据按名称引用 CredentialStore 绑定（host 须与端点一致、
   * 用途须为 mcp），配置后 scope 收紧到本项目 + mcp 操作；变更采用期望版本
   * 校验，任何变化递增 configVersion（任务内调用前重读核对）。
   */
  mcpConfigure(input: {
    serviceId?: string;
    projectId: string;
    name: string;
    endpoint?: string;
    cua?: CuaConfig;
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
    let endpoint: URL | undefined;
    const existing = this.mcp.getServiceByName(input.projectId, input.name);
    let cua: CuaConfig | undefined;
    if (input.cua) {
      cua = parseCuaConfig(input.cua);
      if (this.productType !== "ruukoto-code" || cua.kind !== "cua-mac" || input.endpoint !== undefined || input.credential) throw new RuntimeApiError("invalid_params", "Code 电脑配置须选择本机 Driver，不接受 HTTPS 端点或凭据。");
    } else {
      try { endpoint = parseMcpEndpoint(input.endpoint!); }
      catch (err) { throw new RuntimeApiError("invalid_params", (err as Error).message); }
    }
    if (cua || existing?.cua) this.cuaManager.assertConfigurationChange();
    if (!Array.isArray(input.toolAllowlist)) {
      throw new RuntimeApiError("invalid_params", "tool_allowlist 必须是数组（工具名字符串或 { name, effect } 对象）");
    }
    const normalized = normalizeToolAllowlist(input.toolAllowlist);
    if ("error" in normalized) throw new RuntimeApiError("invalid_params", normalized.error);
    const toolAllowlist = normalized.entries;
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
      throw new RuntimeApiError("invalid_params", "expected_version 必须是非负整数");
    }
    const credential = cua ? null : input.credential !== undefined ? input.credential : existing?.credential;
    if (credential) {
      const cred = this.credentials.get(credential);
      if (!cred) throw new RuntimeApiError("invalid_params", `凭据绑定不存在：${credential}`);
      if (cred.host !== endpoint!.host) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credential} 的 host（${cred.host}）与端点 host（${endpoint!.host}）不一致`);
      }
      if (cred.purpose !== MCP_CREDENTIAL_PURPOSE) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credential} 用途是 ${cred.purpose}，MCP 服务需要 purpose=${MCP_CREDENTIAL_PURPOSE} 的凭据`);
      }
      if (cred.header.toLowerCase() !== "authorization") {
        throw new RuntimeApiError("invalid_params", `MCP 凭据须使用 authorization 头（Bearer）：${credential}`);
      }
      // scope 兼容性先校验（写操作前）：已有 scope 冲突时拒绝，避免静默改变
      // 既有授权的边界，也避免配置已落库但凭据收紧失败的半截状态
      if (cred.scope) {
        const sameProject = (cred.scope.projectId === undefined || cred.scope.projectId === input.projectId) && cred.scope.repoId === undefined;
        const coversOp = cred.scope.operations === undefined || cred.scope.operations.includes(MCP_CREDENTIAL_PURPOSE);
        if (!sameProject || !coversOp) {
          throw new RuntimeApiError(
            "invalid_params",
            `凭据 ${credential} 已有使用范围（项目 ${cred.scope.projectId ?? "不限"}/操作 ${cred.scope.operations?.join(",") ?? "不限"}），与 mcp 冲突；请先调整凭据范围或另建凭据`,
          );
        }
      }
    }
    let service: McpServiceConfig;
    try {
      // 配置变更与事件同事务：状态变化不留无事件的洞（审计与 TUI 依赖事件流）
      service = this.store.withTx(() => {
        if (input.serviceId !== undefined && this.mcp.getServiceByName(input.projectId, input.name)?.id !== input.serviceId) throw new RuntimeApiError("version_conflict", "原 MCP 服务已删除或替换，请重新读取后选择当前服务；不会把原编辑自动转成新增。");
        const s = this.mcp.upsertService({
          projectId: input.projectId,
          name: input.name,
          endpoint: endpoint?.toString(),
          cua,
          credential: cua ? null : input.credential,
          toolAllowlist,
          enabled: input.enabled,
          expectedVersion: input.expectedVersion,
        });
        this.store.appendEvent(
          { type: "mcp.service_changed", serviceId: s.id, projectId: s.projectId, name: s.name, endpoint: s.endpoint, ...(s.cua ? { cua: { kind: s.cua.kind } } : {}), configVersion: s.configVersion, action: "upsert" },
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

  mcpCuaStatus() { return this.cuaManager.status(); }
  mcpCuaTargets() { return discoverCuaTargets("cua-mac"); }
  mcpCuaStop(serviceId?: string) { return this.cuaManager.stop(serviceId); }
  mcpCuaBeginRecovery() { return this.cuaManager.beginRecovery(); }
  mcpCuaObserve() { return this.cuaManager.observe(); }
  mcpCuaAccept(observationId: string) { return this.cuaManager.accept(observationId); }

  mcpListServices(projectId?: string): McpServiceConfig[] {
    return this.mcp.listServices(projectId);
  }

  mcpSetEnabled(serviceId: string, enabled: boolean, expectedVersion?: number): McpServiceConfig {
    return this.store.withTx(() => {
      let service: McpServiceConfig | null;
      try { service = this.mcp.setEnabled(serviceId, enabled, expectedVersion); }
      catch (err) {
        if (err instanceof McpVersionConflictError) throw new RuntimeApiError(err.code, err.message);
        throw err;
      }
      if (!service) throw new RuntimeApiError("not_found", `MCP 服务不存在：${serviceId}`);
      this.store.appendEvent(
        { type: "mcp.service_changed", serviceId: service.id, projectId: service.projectId, name: service.name, endpoint: service.endpoint, ...(service.cua ? { cua: { kind: service.cua.kind } } : {}), configVersion: service.configVersion, action: enabled ? "enabled" : "disabled" },
        {},
      );
      return service;
    });
  }

  mcpRemoveService(serviceId: string, expectedVersion?: number): boolean {
    const service = this.mcp.getService(serviceId);
    if (!service) return false;
    if (service.cua) this.cuaManager.assertConfigurationChange();
    return this.store.withTx(() => {
      let removed: boolean;
      try {
        removed = this.mcp.removeService(serviceId, expectedVersion);
      } catch (err) {
        if (err instanceof McpVersionConflictError) throw new RuntimeApiError(err.code, err.message);
        throw err;
      }
      if (removed) {
        this.store.appendEvent(
          { type: "mcp.service_changed", serviceId, projectId: service.projectId, name: service.name, endpoint: service.endpoint, ...(service.cua ? { cua: { kind: service.cua.kind } } : {}), configVersion: service.configVersion + 1, action: "removed" },
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
    permissions?: { accessibility: boolean; screenRecording: boolean };
  }> {
    const service = this.mcp.getService(serviceId);
    if (!service) throw new RuntimeApiError("not_found", `MCP 服务不存在：${serviceId}`);
    let conn: McpConnection | null = null;
    try {
      if (service.cua) {
        const cua = service.cua;
        const tools = (await describeCuaTools(cua)).flatMap(raw => {
          const tool = restrictCuaTool(cua, raw);
          if (!tool) return [];
          const validated = validateRemoteTool(tool), effect = allowlistEffectFor(service.toolAllowlist, tool.name);
          return [{ name: tool.name, allowed: effect !== null && !("disabledReason" in validated), effect: cuaToolEffect(cua, tool.name)!, reason: "disabledReason" in validated ? validated.disabledReason : effect === null ? "不在允许列表" : undefined }];
        });
        const permissions = await readMacosCuaPermissions(), ok = permissions.accessibility && permissions.screenRecording;
        return { service, ok, serverInfo: { name: "cua-driver", version: cua.version }, protocolVersion: null, tools, permissions,
          ...(!ok ? { errorCode: "cua_permissions_missing", error: "当前后台启动宿主缺少辅助功能或屏幕录制权限；请在系统设置授权该宿主并重新检查。" } : {}) };
      }
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
        error: service.cua ? "本机电脑程序或宿主权限检查失败；请核对官方固定版本、安装与执行权限，并重建原生 helper 后重新检查；未启动电脑连接。" : err instanceof McpError && err.code === "auth_failed" ? "MCP 认证失败，请检查当前来源的凭据、端点与权限后重新检查。" : "MCP 连接或工具发现失败，请检查端点与网络后重新检查；未执行业务工具。",
        errorCode: err instanceof McpError || err instanceof ExecutionError ? err.code : "check_failed",
      };
    } finally {
      await conn?.close();
    }
  }

  // ---------- 调度 ----------

  private kick(sessionId: string): void {
    if (this.stopping || this.compactions.has(sessionId)) return;
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
      if (this.stopping || this.compactions.has(sessionId)) return;
      const session = this.store.getSession(sessionId);
      if (!session || session.queueState !== "active") return;
      const task = this.store.listQueuedTasksFifo(sessionId).find(candidate => !isAgentReportParked(this.store, candidate.id));
      if (!task) return;
      const fallback = listAgentReports(this.store, { taskId: task.id }).find(report => report.fallbackTaskId === task.id && report.status === "pending");
      if (fallback) {
        await this.routeAgentReportGroup(fallback);
        if (isAgentReportParked(this.store, task.id)) continue;
      }

      // 私聊与 Telegram 共用 main 队列，仍按这条消息的固定配置重核，不能凭会话身份放行。
      const sourceEvent = task.sourceEventId ? this.store.getInboundEvent(task.sourceEventId) : null;
      if (sourceEvent) {
        const media = this.inboundMedia.getMessage(sourceEvent.source, sourceEvent.externalId);
        if (media && ["rejected", "expired"].includes(media.status) && sourceEvent.taskId !== task.id) {
          await this.cancelTask(task.id, { reason: "inbound_media_rejected" });
          continue;
        }
        const decision = this.inboundGate(sourceEvent);
        if (decision === "wait") return;
        if (decision !== "run") {
          await this.cancelTask(task.id, { reason: decision.drop });
          continue;
        }
        // 先核实来源代次；仍有效的群/图片任务才等待收件、入站与媒体归属事务。
        if ((sourceEvent.source === QQ_GROUP_SOURCE || this.inboundMedia.hasMedia(sourceEvent)) && sourceEvent.taskId !== task.id) return;
      }

      // 父级送达的放行判定（工单 09 入口 4）：已取消工作的结果唤醒与消息唤醒在此
      // 截住。取消所在轮次的模型调用如已开始则不级联。
      const wakeProblem = this.parentDelivery.wakeUnavailable(task);
      if (wakeProblem) {
        await this.cancelTask(task.id, { reason: wakeProblem });
        continue;
      }

      // 兜底（启动收尾见 retireLegacyRoles）：钻过退役边界的排队归档会话任务固定取消跳过
      const identity = this.store.getSessionIdentity(sessionId)!;
      if (identity.kind === "retired") {
        this.store.withTx(() => {
          this.store.endTask(task.id, ["queued"], "canceled", {
            errorMessage: identity.reason,
            endedAt: new Date().toISOString(),
          });
        });
        continue;
      }

      // 任务开始前核对目录身份（issue 16：占用键是任务写入目标；排队期间被
      // 替换或失效的写入目录拒绝执行，不自动重建）
      let workspaceLaunch: ReturnType<typeof taskWorkspaceFor>;
      let dialogue: boolean;
      try {
        const workLaunch = task.workId ? this.store.getWorkDelegation(task.workId) : null;
        workspaceLaunch = taskWorkspaceFor({ session, work: workLaunch });
        dialogue = this.conversationAdmitted(task) && Boolean(this.store.findBlockingOccupancy(workspaceLaunch.path, workspaceLaunch.dev, workspaceLaunch.ino));
        if (!dialogue) workspaceLaunch.dev = (await verifyDirIdentity({
          cwd: workspaceLaunch.path,
          cwdReal: workspaceLaunch.path,
          dev: workspaceLaunch.dev,
          ino: workspaceLaunch.ino,
        })).dev;
      } catch (err) {
        if (!(err instanceof DirIdentityError) && (!(err instanceof WorkspaceSnapshotError) || !["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(err.code))) throw err;
        this.store.withTx(() => {
          this.store.endTask(task.id, ["queued"], "failed", {
            errorMessage: err instanceof WorkspaceSnapshotError ? `${err.code}：${err.message}` : err.message,
            endedAt: new Date().toISOString(),
          });
        });
        continue; // 该会话其余任务共用同一目录，同样会被拒绝
      }

      try {
        this.store.withTx(() => {
          if (this.stopping) throw new TaskGoneError(); // 停止开始后不再让排队任务转入运行
          this.assertNoSessionCompaction(sessionId);
          if (task.subAgentId && !task.sourceEventId) {
            const work = task.workId ? this.store.getWorkDelegation(task.workId) : null;
            if (work && workflowSlotsUsed(this.store, work.parentSessionId) >= 3) throw new DirOccupiedError();
          }
          const scheduled = this.store.getScheduledRunForTask(task.id);
          if (scheduled && (scheduled.closedAt || scheduled.scheduleStatus === "canceled")) {
            this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: "schedule_canceled" });
            return;
          }
          if (!dialogue && !this.store.tryAcquireOccupancy({
            cwdReal: workspaceLaunch.path,
            cwdDev: workspaceLaunch.dev,
            cwdIno: workspaceLaunch.ino,
            sessionId,
            taskId: task.id,
          })) {
            throw new DirOccupiedError();
          }
          if (!this.store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() })) {
            throw new TaskGoneError();
          }
          if (isAgentReportFallback(this.store, task.id)) startAgentReportFallback(this.store, task.id);
          this.store.appendEvent(
            { type: "task.started", taskId: task.id, sessionId },
            { taskId: task.id, sessionId },
          );
        });
      } catch (err) {
        if (err instanceof DirOccupiedError) return; // 等待占用释放后的唤醒
        if (err instanceof TaskGoneError) continue; // 已被取消或后台停止，取下一个
        if (err instanceof WorkspaceSnapshotError && ["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(err.code)) {
          this.store.withTx(() => this.store.endTask(task.id, ["queued"], "failed", { errorMessage: `${err.code}：${err.message}` }));
          continue;
        }
        throw err;
      }

      const fresh = this.store.getTask(task.id)!;
      if (fresh.status !== "running") continue;
      const ending: TaskEndingContext = { taskId: task.id, stopSnapshot: null };
      let driver: Driver | undefined;
      try {
        driver = await this.getDriver(session);
        await driver.run(fresh, ending);
      } catch (err) {
        // worker 停止不能证明浏览器等全部资源退出；取得 Driver 后的异常保守保留占用。
        // Note: 见 .agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md
        await endTaskExecution({ store: this.store, ledger: this.ledger, onReleased: () => this.kickAll() }, task, ending, {
          terminal: "failed", reason: `驱动器异常：${(err as Error).message}`, unreapedReason: "tool_process_unreaped",
          halt: async () => { if (!driver) return true; await driver.stopManagedProcesses(task.id); return false; },
        });
      } finally {
        // SubAgent 子会话（agent-direction issue 11）：driver.run 收尾后释放运行
        // 对象（SDK 缓存与 MCP 连接）；身份、会话、JSONL 与产物保留——释放
        // SDK 不等于删除 SubAgent。终态事件监听已在提交边界同步完成。
        if (identity.kind === "subagent") {
          const current = this.drivers.get(sessionId);
          this.drivers.delete(sessionId);
          if (current) await current.dispose();
        }
        this.kickAll();
      }
    }
  }

  /** 同一份清单用于会话装配与后台恢复；能力停用仍保留历史操作的核实规则。 */
  private browserAllowed(task: Task): boolean {
    if (!browserTaskAllowed(this.store, task) || getWorkflowDeliveryRun(this.store, task.id)) return false;
    const background = listActiveBackgroundProcesses(this.store, task.sessionId).find(record => record.handedOff);
    if (background) {
      const problem = this.backgroundSourceProblem(background);
      if (problem) { this.backgroundProcesses.requestStop(background.id, problem); return false; }
      if (!ownerQuestionTaskEligible(this.store, task) || task.accessMode !== background.source.accessMode) return false;
    }
    if (!task.sourceEventId) return true;
    const event = this.store.getInboundEvent(task.sourceEventId);
    return Boolean(event && this.imEntries.entry(event.source) && this.imEntries.gate(event) === "run");
  }

  private initHostToolFamilies(): void {
    this.cuaManager = new CodeCuaManager(this.store, this.mcp, this.artifacts, this.config.dataDir, this.config.mcp);
    this.browserManager = new BrowserManager({ dataDir: this.config.dataDir, store: this.store, ...this.config.browser,
      persist: (stateJson, binding) => this.store.withTx(() => {
        this.store.setMetaValue(BROWSER_META_KEY, stateJson);
        this.store.appendEvent({ type: "browser.binding_changed", sessionId: binding.sessionId, generation: binding.generation,
          kind: binding.kind, state: binding.state, failureCode: binding.failureCode }, { sessionId: binding.sessionId });
      }),
    });
    this.hostToolFamilies = [
      createBackgroundProcessFamily(this.store),
      createAgentWaitFamily(),
      createBrowserFamily({ store: this.store, artifacts: this.artifacts, manager: this.browserManager,
        screenshotDir: path.join(this.config.dataDir, "browser", "screenshots"), allowed: task => this.browserAllowed(task) }),
      createTodoFamily(),
      createHostDataFamily({
        store: this.store,
        access: this.access,
        historyIndex: this.historyIndex,
        memories: this.memories,
        sessionFileFor: (sessionId) => this.store.getSession(sessionId)?.sessionFile ?? null,
        projectOfSession: (sessionId) => this.store.getSession(sessionId)?.projectId ?? null,
        syncSession: (sessionId) => {
          const file = this.store.getSession(sessionId)?.sessionFile;
          if (!file) return { unindexed: true };
          this.historyIndex.sync(sessionId, file);
          return { unindexed: !this.historyIndex.isIndexed(sessionId) };
        },
      }),
      createWebSearchFamily({
        store: this.store,
        artifacts: this.artifacts,
        credentials: this.credentials,
        ...this.config.webSearch,
      }),
      createAppDataFamily({
        store: this.appDataStore,
        runner: this.appDataRunner,
        coreStore: this.store,
        queryStallMs: () => this.config.appData?.queryStallMs,
        writeVerdict: (opId) => this.appDataWriteVerdict(opId),
      }),
      createDelegationFamily({
        coreStore: this.store,
        artifacts: this.artifacts,
        readReply: (taskId, offset, length) => this.readTaskReply(taskId, offset, length),
        resultNotice: (task) => this.githubEvents.notice(task),
      }),
      createSubAgentFamily({
        coreStore: this.store,
        sources: this.sources,
        delegate: (input) => this.subagents!.delegate(input),
        close: (input) => this.subagents!.close(input),
        cancelWork: (input) => this.subagents!.cancelWork(input),
        message: (input) => this.subagents!.message(input),
        integrate: (input) => this.subagents!.integrate(input),
        readReply: (taskId, offset, length) => this.readTaskReply(taskId, offset, length),
        resultNotice: (task) => this.githubEvents.notice(task),
        artifacts: this.artifacts,
      }),
      createWorkflowFamily({ store: this.store, workflowLibrary: this.workflowLibrary,
        startWorkflowTask: input => this.startWorkflowTask(input), getWorkflowDefinition: input => this.getWorkflowDefinition(input),
        getWorkflowDetail: (...args) => this.getWorkflowDetail(...args), getWorkflowStep: (...args) => this.getWorkflowStep(...args),
        getWorkflowLogs: (...args) => this.getWorkflowLogs(...args), getWorkflowQuestion: (...args) => this.getWorkflowQuestion(...args),
        listWorkflows: (...args) => this.listWorkflows(...args), controlWorkflow: input => this.controlWorkflow(input) }),
      createChatResultFamily({ coreStore: this.store, qqStore: this.qqStore }),
      createOwnerQuestionFamily(this.store),
      ...this.config.product.toolFamilies({
        config: this.config,
        store: this.store,
        artifacts: this.artifacts,
        sched: this.sched,
        scheduler: this.scheduler,
        sources: this.sources,
        notificationTarget: (ctx) => {
          const task = this.store.getTask(ctx.taskId);
          if (task?.readScope?.execution) return this.verifySubAgentSource(task) ? null : task.readScope.execution.source.replyTarget;
          const execution = getWorkflowExecution(this.store, ctx.taskId);
          if (execution) {
            const run = requireWorkflowRun(this.store, execution.runId);
            return this.verifyWorkflowSource(run.source) ? run.source.replyTarget : null;
          }
          const scheduled = this.store.getScheduledRunForTask(ctx.taskId);
          if (scheduled) {
            const run = this.sched.getRun(scheduled.id);
            return run ? this.sched.getSchedule(run.scheduleId)?.target ?? null : null;
          }
          return this.imEntries.notificationTarget(task?.sourceEventId ? this.store.getInboundEvent(task.sourceEventId) : null);
        },
      }),
      createSkillFamily(),
    ];
    this.ledger = new ToolOpLedger(this.store, {
      // 已删除的 coding_delegate 仍按 analyze / draft 分别核实，不能依赖当前装配。
      delegation: delegationOpCheck(this.store),
      subagent: subagentOpCheck(this.store),
    }, [
      // 停用个人能力仍核实旧账本，分包不把已知结果改为效果未知。
      { ...SCHEDULER_LEDGER, familyCheck: schedulerOpCheck(this.sched) },
      SERVICE_LEDGER,
      ...this.hostToolFamilies.flatMap((family) => family.ledger ? [family.ledger] : []),
    ]);
    this.hostExecutions = new HostExecutionManager({ store: this.store, ledger: this.ledger, onReleased: () => this.kickAll() });
    this.backgroundProcesses = new RuntimeBackgroundProcesses({ store: this.store, dataDir: this.config.dataDir,
      handoff: async (taskId, transfer) => {
        const task = this.store.getTask(taskId), session = task && this.store.getSession(task.sessionId);
        if (!session) throw new BackgroundProcessError("background_source_invalid", "后台来源会话缺失；结束本轮并向拥有者说明。");
        return (await this.getDriver(session)).yieldWorkspace(taskId, transfer);
      },
      restore: async taskId => {
        const task = this.store.getTask(taskId), driver = task && this.drivers.get(task.sessionId);
        return driver?.restoreWorkspace(taskId) ?? false;
      },
      sourceProblem: record => this.backgroundSourceProblem(record), released: () => this.kickAll() });
  }

  private async getDriver(session: Session): Promise<Driver> {
    let driver = this.drivers.get(session.id);
    if (!driver) {
      driver = new Driver(session, {
        store: this.store,
        ledger: this.ledger,
        sessionsDir: sessionsDirFor(this.config.dataDir),
        agentDir: this.config.agentDir,
        subAgentRoles: () => loadSubAgentRoleLibrary(this.config.agentDir),
        modelRuntime: this.models.current.modelRuntime,
        modelCatalog: this.models.current.modelCatalog,
        model: this.models.current.model,
        thinkingLevel: this.config.thinkingLevel ?? "off",
        toolFactory:
          this.config.toolFactory ??
          ((ctx) => createCodingTools(ctx.router)),
        artifacts: this.artifacts,
        credentials: this.credentials,
        launcherFor: (mode) => this.launcherFor(mode),
        verificationLauncher: () => createLauncherFor({ backend: "native", native: {
          ...(this.config.execution?.backend === "native" ? this.config.execution.native : {}), protectedRoots: [...this.protectedRoots(),
            ...(this.config.execution?.backend === "native" ? this.config.execution.native?.protectedRoots ?? [] : [])] } }, "confirm"),
        protectedRoots: this.protectedRoots(),
        onOccupancyReleased: () => this.kickAll(),
        access: this.access,
        historyIndex: this.historyIndex,
        memories: this.memories,
        budgetOverrides: this.config.budgetOverrides,
        hostToolFamilies: this.hostToolFamilies,
        ownerQuestions: { create: (ctx, questions) => this.store.withTx(() => createOwnerQuestion(this.store, { ...ctx, questions })) },
        backgroundProcesses: {
          active: sessionId => listActiveBackgroundProcesses(this.store, sessionId).some(record => record.handedOff),
          start: (ctx, command, signal) => {
            this.verifyBackgroundCaller(ctx.taskId, ctx.sessionId);
            return this.backgroundProcesses.start(ctx, command, signal);
          },
          status: (ctx, input) => {
            this.verifyBackgroundCaller(ctx.taskId, ctx.sessionId);
            if (input.processId !== undefined) {
              if (input.offset !== undefined) throw new BackgroundProcessError("invalid_params", "指定 process_id 时不要带 offset；列表分页才使用 offset。");
              return backgroundProcessForModel(this.backgroundProcesses.get(ctx.sessionId, input.processId));
            }
            const result = this.listBackgroundProcesses(ctx.sessionId, input.offset);
            return { ...result, processes: result.processes.map(backgroundProcessForModel) };
          },
          output: (ctx, input) => { this.verifyBackgroundCaller(ctx.taskId, ctx.sessionId); return this.backgroundProcessOutput({ sessionId: ctx.sessionId, ...input }); },
          stop: (ctx, processId) => { this.verifyBackgroundCaller(ctx.taskId, ctx.sessionId); this.backgroundProcesses.get(ctx.sessionId, processId); return this.backgroundProcesses.requestStop(processId); },
        },
        jev: this.config.jev,
        compaction: this.config.compaction,
        mcp: { store: this.mcp, cua: this.cuaManager, ...this.config.mcp },
        allowTaskTool: (task, name) => !getWorkflowDeliveryRun(this.store, task.id) && !isAgentReportFallback(this.store, task.id) && this.githubEvents.allowTool(task, name),
        browser: { allowed: task => this.browserAllowed(task), close: sessionId => this.browserManager.close(sessionId) },
        verifyTask: task => {
          const sourceProblem = this.verifySubAgentSource(task);
          if (sourceProblem) return sourceProblem;
          const run = getWorkflowDeliveryRun(this.store, task.id);
          return run && !this.verifyWorkflowReport(run) ? "workflow_report_source_invalid" : this.verifyAgentReportSources(task.id);
        },
        agentWait: {
          initialPhase: task => this.store.listAllOccupancy().some(held => held.taskId === task.id) ? "execution" : "conversation",
          snapshot: task => latestBackgroundReferenceSnapshot(this.store, task.sessionId) ?? latestAgentReferenceSnapshot(this.store, task.sessionId),
          acquireResources: task => this.acquireAgentResources(task),
          wait: (ctx, sdkCallId, targets, timeoutMs, signal) => this.agentWait.wait(ctx, sdkCallId, targets, timeoutMs, signal),
        },
        beforeModelRequest: task => {
          const background = listActiveBackgroundProcesses(this.store, task.sessionId).find(record => record.handedOff);
          if (background && this.backgroundSourceProblem(background)) throw new BackgroundProcessError("background_source_invalid", "后台参考来源已失效；停止依赖该资料的模型请求并核实原后台。");
          if (this.verifyAgentReportSources(task.id)) throw new AgentWaitError("source_invalid");
          const claims = listAgentReports(this.store, { taskId: task.id }).filter(report => report.status === "pending" && report.claimTaskId === task.id);
          if (claims.some(report => report.consumption && report.consumption.taskId !== task.id) && !this.agentReportInput(task, claims)) throw new AgentWaitError("report_input_missing");
        },
        afterModelRequest: task => this.store.withTx(() => this.acceptAgentWaitResults(task)),
        reportContext: task => {
          const reports = listAgentReports(this.store, { taskId: task.id }).filter(report => report.fallbackTaskId === task.id);
          if (reports.length < 2) return null;
          return { reportKeys: reports.map(report => report.key), text: "[后台工作分组回报]\n" + reports.map(report => report.target.kind === "workflow"
            ? workflowReport(this.store, requireWorkflowRun(this.store, report.target.runId)).text
            : `子任务 ${report.target.taskId}：${this.store.getTask(report.target.taskId)!.status}\n${this.store.getTask(report.target.taskId)!.resultSummary}`).join("\n\n") + "\n请一次汇总本组全部事实，明确失败、取消和停止未核实；不再逐项另发总结。" };
        },
        // 宿主评审任务（agent-direction issue 19）按任务另开只读 MCP：GitHub MCP
        // 配在 main 项目（评审 SubAgent 的会话在 main 项目下；凭据范围按项目核对）
        taskMcp: (task) => this.githubEvents.isReviewTask(task),
        reviewer: this.models.current.reviewer,
        // IM 审批（agent-direction issue 08）：创建通知与消费前固定身份复核；
        // 长期授权候选（issue 10）：共享 main 不继承其他入口；无 IM 来源的任务恒无候选
        approvalIm: {
          notifyCreated: (confirmation, task) => this.imApprovals.notifyCreated(confirmation, task),
          consumeRecheck: (confirmation, task) => this.verifySubAgentSource(task) ?? this.workflowSteps.verify(task) ?? this.imApprovals.consumeRecheck(confirmation, task),
          standingCandidate: (task, scope) => this.imApprovals.standingCandidate(task, scope),
        },
        parentInjection: (sessionId) => this.parentDelivery.takeInjection(sessionId),
        parentInjectionRecheck: (sessionId, resultIds, messageIds) => this.parentDelivery.verifyInjection(sessionId, resultIds, messageIds),
        parentInjectionAccepted: (taskId, resultTaskIds, entryId, messageIds) => this.parentDelivery.acceptInjection(taskId, resultTaskIds, entryId, messageIds),
        verifyTaskSources: (projectId, refs) => this.sources.verify(projectId, refs as any[]),
        workflow: this.workflowSteps,
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
    if (getWorkflowExecution(this.store, task.id)?.kind === "agent") throw new RuntimeApiError("invalid_state", "工作流步骤由所属运行控制，请暂停或取消运行");
    if (task.status !== "running" && task.status !== "awaiting_confirmation") {
      throw new RuntimeApiError("invalid_state", `只能中断运行中或等待确认的任务，当前 ${task.status}`);
    }
    if (this.hostExecutions.has(task.id)) {
      await this.hostExecutions.stop(task.id, "interrupted", "owner_interrupt");
      return this.store.getTask(taskId)!;
    }
    const driver = await this.getDriver(this.store.getSession(task.sessionId)!);
    await driver.requestStop(task, { terminal: "interrupted", reason: "owner_interrupt", cancelIntent: false });
    return this.store.getTask(taskId)!;
  }

  async cancelTask(taskId: string, opts?: { reason?: string }): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${taskId}`);
    if (getWorkflowExecution(this.store, task.id)?.kind === "agent") throw new RuntimeApiError("invalid_state", "工作流步骤由所属运行控制，请取消运行");
    if (task.status === "queued") {
      this.store.withTx(() => {
        this.store.endTask(task.id, ["queued"], "canceled", {
          endedAt: new Date().toISOString(),
          // 编排器超时取消等场景持久化原因（undefined 时保持原状不写入）
          errorMessage: opts?.reason,
        });
        invalidateOwnerQuestionsForTask(this.store, task.id);
      });
      return this.store.getTask(taskId)!;
    }
    if (task.status === "running" || task.status === "awaiting_confirmation") {
      // 先持久化取消意图（issue 14 窗口修复）：任务已转 running 而 Driver 尚未
      // 登记 currentTask 时 requestStop 挡不住；runInner 开头按此标记直接定态
      // canceled，不调用模型。已在执行的任务 requestStop 会再写同一标记（同值）。
      this.store.withTx(() => {
        this.store.setCancelRequested(task.id, true);
        invalidateOwnerQuestionsForTask(this.store, task.id);
      });
      if (this.hostExecutions.has(task.id)) {
        await this.hostExecutions.stop(task.id, "canceled", opts?.reason ?? "owner_cancel");
        return this.store.getTask(taskId)!;
      }
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
    const check = selection ? await this.models.resolveSelection(parseModelSelection(selection)) : null;
    let parentSessionId: string | null = null;
    let releasedOccupancy = false;
    this.store.withTx(() => {
      check?.();
      if (this.store.countLegacyQueuedTasks(sessionId) > 0) {
        if (!selection) throw new RuntimeApiError("model_selection_required", "请显式确认旧任务的模型配置");
        this.store.fillLegacyQueuedModelSelections(sessionId, selection);
      }
      // 仅释放遗留（所属任务已结束）的占用；活动任务持有的占用不得被此操作破坏
      for (const occ of this.store.listAllOccupancy()) {
        if (occ.sessionId !== sessionId) continue;
        if (occ.taskId === null) continue;
        const occTask = this.store.getTask(occ.taskId);
        if (occTask && !isTerminalTaskStatus(occTask.status)) {
          throw new RuntimeApiError(
            "occupancy_active",
            `任务 ${occ.taskId} 仍在 ${occTask.status}，占用不能释放`,
          );
        }
        releasedOccupancy = this.store.releaseOccupancy(occ.taskId) || releasedOccupancy;
        const copy = occTask ? workCopyHostFor(occTask) : null;
        if (copy) this.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?")
          .run(JSON.stringify({ ...occTask!.readScope, workCopyHost: { ...copy, stopVerified: true } }), occ.taskId);
      }
      try { parentSessionId = this.subagents?.executionVerified(sessionId) ?? null; }
      catch (err) {
        if (err instanceof SubAgentDelegationError) throw new RuntimeApiError(err.code, err.message);
        throw err;
      }
      this.store.setSessionQueueState(sessionId, "active", null);
      this.store.appendEvent({ type: "session.queue_resumed", sessionId }, { sessionId });
    });
    if (releasedOccupancy) {
      const driver = this.drivers.get(sessionId);
      this.drivers.delete(sessionId);
      await driver?.dispose();
    }
    if (parentSessionId) await this.subagents!.flushPendingMessages(parentSessionId);
    if (releasedOccupancy) this.kickAll();
    else this.kick(sessionId);
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
      provider: String(this.models.current.model?.provider ?? ""),
      id: String(this.models.current.model?.id ?? ""),
      name: String(this.models.current.model?.name ?? ""),
      thinkingLevel: this.defaultSelection.thinkingLevel,
    };
  }

  /** 执行后端说明（local 无隔离必须显式标记，不得暗示隔离已生效）。 */
  executionInfo(): { backend: string; note: string } {
    const backend = this.config.execution?.backend ?? "local";
    const note =
      backend === "local"
        ? "local 执行后端：开发受限任务无隔离；完全访问使用启动账户权限且免操作审批"
        : "native 执行后端：受限任务在操作系统原生沙箱内执行；完全访问使用启动账户直接执行";
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
    tasks: TaskView[];
    confirmations: ConfirmationRequestView[];
    artifacts: Artifact[];
    previews: Record<string, OutputPreview>;
    instanceId: string;
    execution: { backend: string; note: string };
    defaultModel: { provider: string; id: string; name: string; thinkingLevel: string };
    mainSessionId: string | null;
    roleSessionIds: string[];
    subAgentSessionIds: string[];
    workDelegations: WorkDelegation[];
    subAgents: SubAgent[];
    ownerQuestions: OwnerQuestionView[];
    backgroundProcesses: BackgroundProcessView[];
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
    const snapshot = {
      projects: this.store.listProjects(),
      sessions,
      tasks: tasks.map(task => this.taskView(task)),
      confirmations: this.store.listConfirmationsByStatus("pending").map(confirmationToView),
      artifacts: this.listRecentArtifacts(),
      previews,
      instanceId: this.db.getInstanceId(),
      execution: this.executionInfo(),
      defaultModel: this.modelInfo(),
      mainSessionId: this.store.getAgentRole("main")?.sessionId ?? null,
      roleSessionIds: this.store.listAgentRoles().map((r) => r.sessionId),
      subAgentSessionIds: this.store.listSubAgents().map((a) => a.sessionId),
      workDelegations: this.store.listWorkDelegations(),
      subAgents: this.store.listSubAgents(),
      ownerQuestions: sessions.flatMap(session => this.listOwnerQuestions(session.id).questions),
      backgroundProcesses: sessions.flatMap(session => this.listBackgroundProcesses(session.id).processes),
      seq: this.store.getMaxSeq(),
    };
    let questionBytes = 0;
    snapshot.ownerQuestions = snapshot.ownerQuestions.filter(question => {
      questionBytes += frameBytes(question);
      return questionBytes <= 128 * 1024;
    });
    while (snapshot.ownerQuestions.length && frameBytes(snapshot) > SEGMENT_MAX_BYTES) snapshot.ownerQuestions.pop();
    let backgroundBytes = 0;
    snapshot.backgroundProcesses = snapshot.backgroundProcesses.filter(record => { backgroundBytes += frameBytes(record); return backgroundBytes <= 128 * 1024; });
    while (snapshot.backgroundProcesses.length && frameBytes(snapshot) > SEGMENT_MAX_BYTES) snapshot.backgroundProcesses.pop();
    return snapshot;
  }

  // ---------- 工作委托与 SubAgent（agent-direction issue 11；只读视图） ----------

  /** 工作委托列表（可选按父用户会话过滤）；每项附 SubAgent 与执行任务状态。 */
  workList(parentSessionId?: string): { works: Array<{ work: WorkDelegation; agent: SubAgent | null; tasks: Pick<Task, "id" | "status" | "createdAt" | "endedAt" | "resultSummary">[] }> } {
    const works = parentSessionId ? this.store.listWorkDelegationsBySession(parentSessionId) : this.store.listWorkDelegations();
    return {
      works: works.map((work) => ({
        work,
        agent: this.store.getSubAgent(work.subAgentId),
        tasks: this.store.listTasksByWork(work.id).map((t) => ({
          id: t.id,
          status: t.status,
          createdAt: t.createdAt,
          endedAt: t.endedAt,
          resultSummary: t.resultSummary,
        })),
      })),
    };
  }

  /** 单项工作详情：委托、SubAgent（含归属与状态）、全部执行任务与工作内消息。 */
  workGet(workId: string): { work: WorkDelegation; agent: SubAgent | null; tasks: Task[]; messages: SubAgentMessage[] } {
    const work = this.store.getWorkDelegation(workId);
    if (!work) throw new RuntimeApiError("not_found", `工作委托不存在：${workId}`);
    return {
      work,
      agent: this.store.getSubAgent(work.subAgentId),
      tasks: this.store.listTasksByWork(work.id),
      // 工作内协作消息（issue 13）：来源与投递结果随详情可查（含协作方的任务归属）
      messages: this.store.listSubAgentMessagesByWork(work.id),
    };
  }

  /**
   * 拥有者显式关闭 SubAgent（agent-direction issue 12；控制面 op subagent_close）。
   * 有活动任务拒绝并提示先取消；已关闭幂等。历史、产物与工作目录保留可查。
   */
  closeSubAgent(subAgentId: string): { agent: SubAgent; alreadyClosed: boolean } {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    if (!this.subagents) throw new RuntimeApiError("unavailable", "SubAgent 管理器未启动");
    try {
      return this.subagents.close({ subAgentId, by: "owner" });
    } catch (err) {
      if (err instanceof SubAgentDelegationError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  /**
   * 拥有者取消整项工作（agent-direction issue 14；控制面 op work_cancel）：
   * 登记事务内把本工作的排队任务直接取消、活动任务写取消意图，提交后按
   * 现有停止路径逐个处理；已取消幂等返回原记录与当前任务状态；其他工作
   * 不受影响。取消不关闭 SubAgent、不删除历史与产物。
   */
  async cancelWork(workId: string, opts?: { reason?: string }): Promise<WorkCancellation> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    if (!this.subagents) throw new RuntimeApiError("unavailable", "SubAgent 管理器未启动");
    try {
      return await this.subagents.cancelWork({ workId, by: "owner", reason: opts?.reason ?? null });
    } catch (err) {
      if (err instanceof SubAgentDelegationError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
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
    task: TaskView;
    toolOps: ToolOpView[];
    confirmations: ConfirmationRequestView[];
    artifacts: Artifact[];
    outputPreview: OutputPreview | null;
  } | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const displayInput = this.subAgentDisplayInput(task);
    return {
      seq: this.store.getMaxSeq(),
      task: { ...this.taskView(task), ...(displayInput !== undefined ? { displayInput } : {}) },
      toolOps: this.store.listToolOpsByTask(task.id).map(toolOpToView),
      confirmations: this.store.listConfirmationsByTask(task.id).map(confirmationToView),
      artifacts: this.store.listArtifactsByTask(task.id),
      outputPreview: this.outputPreviewFor(task),
    };
  }

  // Note: 见 .agents/notes/implemented/architecture/2026-10-15-desktop-shadcn-demo.md
  private subAgentDisplayInput(task: Task): string | undefined {
    if (!task.parentTaskId || !task.workId || !task.subAgentId) return undefined;
    const parent = this.store.getTask(task.parentTaskId);
    const work = this.store.getWorkDelegation(task.workId);
    const agent = this.store.getSubAgent(task.subAgentId);
    if (!parent || !work || !agent || agent.sessionId !== task.sessionId || agent.parentSessionId !== parent.sessionId || work.parentSessionId !== parent.sessionId) return undefined;
    const requests = new Set<string>();
    for (const op of this.store.listToolOpsByTask(parent.id)) {
      if (op.toolName !== "subagent_delegate" || op.recordedResultAt === null || op.isError !== false || op.effectUnknown) continue;
      const { key, request, work_id: workId, sub_agent_id: subAgentId } = op.params;
      if (typeof key !== "string" || typeof request !== "string" || task.requestId !== subAgentTaskRequestId(work.id, key)) continue;
      if (workId !== undefined ? workId !== work.id : work.requestKey !== key || work.originTaskId !== parent.id) continue;
      if (subAgentId !== undefined ? subAgentId !== agent.id : work.subAgentId !== agent.id) continue;
      requests.add(request);
    }
    return requests.size === 1 ? requests.values().next().value : undefined;
  }

  /** 按 会话 + request_id 精确查询（重连幂等核实；含已离开快照的完成任务）。 */
  findTaskByRequest(input: { sessionId: string; requestId: string }): { task: TaskView | null } {
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    const task = this.store.findTaskByRequest(input.sessionId, input.requestId);
    return { task: task ? this.taskView(task) : null };
  }

  /** 会话内任务分页（新 → 旧；已结束任务的历史查询入口）。 */
  listTasks(input: { sessionId: string; before?: string; limit?: number }): { tasks: TaskView[]; hasMore: boolean } {
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    let page: { tasks: Task[]; hasMore: boolean };
    try {
      page = this.store.listTasksBySessionPaged(input.sessionId, { before: input.before, limit: input.limit });
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    return { ...page, tasks: page.tasks.map(task => this.taskView(task)) };
  }

  // ---------- 历史读取（与 05 历史工具共用的读取边界） ----------

  // Note: 见 .agents/notes/implemented/feature/2026-10-14-internal-report-visibility.md
  private taskView(task: Task): TaskView {
    const wait = listAgentWaits(this.store, { taskId: task.id }).at(-1);
    return { ...task, inputPurpose: getWorkflowDeliveryRun(this.store, task.id) || isAgentReportFallback(this.store, task.id) ? "internal_report" : "user",
      ...(isAgentReportFallback(this.store, task.id) ? { reportParked: isAgentReportParked(this.store, task.id) } : {}),
      ...(wait ? { wait: agentWaitView(this.store, wait) } : {}),
      ...(["running", "awaiting_confirmation"].includes(task.status) ? { resourcePhase: this.store.listAllOccupancy().some(held => held.taskId === task.id) ? "execution" as const : "conversation" as const } : {}) };
  }

  private historyViews(session: Session, entries: HistoryEntryView[]): HistoryEntryView[] {
    const unmarked = new Set(entries.filter(entry => entry.role === "user" && !entry.taskId).map(entry => entry.entryId));
    const missingMarkers = new Set<string>();
    if (unmarked.size) {
      const tasks = [...this.store.listTasksBySession(session.id),
        ...(session.branchSource?.taskIds ?? []).map(id => this.store.getTask(id)).filter(task => task !== null)];
      for (const task of tasks) {
        const refs = task.historyEntryIds.filter(id => unmarked.has(id));
        if (refs.length && this.taskView(task).inputPurpose === "internal_report") for (const id of refs) missingMarkers.add(id);
      }
    }
    return entries.map(entry => {
      if (!entry.taskId) return missingMarkers.has(entry.entryId) ? { ...entry, taskAssociationError: "task_marker_missing" } : entry;
      const task = this.store.getTask(entry.taskId);
      if (!task) return { ...entry, taskAssociationError: "task_missing" };
      if (task.sessionId !== session.id && !session.branchSource?.taskIds.includes(task.id)) {
        return { ...entry, taskAssociationError: "task_outside_session" };
      }
      return { ...entry, inputPurpose: this.taskView(task).inputPurpose };
    });
  }

  /** 历史读取的公共边界：会话归属校验 + 错误码传递（损坏 vs 未落盘）。 */
  private withSessionHistory<T>(sessionId: string, fn: (sessionFile: string | null, session: Session) => T): T {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${sessionId}`);
    try {
      return fn(session.sessionFile, session);
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
    return this.withSessionHistory(input.sessionId, (file, session) => {
      const page = readHistoryPage(file, input);
      return { ...page, entries: this.historyViews(session, page.entries) };
    });
  }

  /** 定位读取先分批准备索引，再返回带来源身份的连续历史窗口。 */
  private async prepareHistoryIndex(sessionId: string, file: string): Promise<void> {
    let offset: number | undefined;
    for (;;) {
      const batch = this.historyIndex.syncBatch(sessionId, file, offset);
      if (batch.complete) return;
      offset = batch.readOffset;
      await yieldHistory();
    }
  }

  async readHistoryWindow(input: { sessionId: string; before?: string; after?: string; around?: string; source?: string; limit?: number; entryTextCap?: number; pageTextBudget?: number }): Promise<HistoryPage> {
    const session = this.getSession(input.sessionId);
    try {
      if (session.sessionFile) await this.prepareHistoryIndex(session.id, session.sessionFile);
      const page = readIndexedHistoryPage(this.db, session.id, session.sessionFile, input);
      return { ...page, entries: this.historyViews(session, page.entries) };
    } catch (error) {
      if (error instanceof HistoryReadError) throw new RuntimeApiError(error.code, error.message);
      throw error;
    }
  }

  /** 指定历史条目的正文分段；连续窗口沿用来源身份，避免补入另一份文件。 */
  readHistoryEntry(input: { sessionId: string; entryId: string; offset?: number; length?: number; source?: string }): HistoryEntryView {
    return this.withSessionHistory(input.sessionId, (file, session) =>
      this.historyViews(session, [input.source ? readIndexedHistoryEntryText(this.db, session.id, file, input.entryId, input.offset, input.length, input.source) : readHistoryEntryText(file, input.entryId, input.offset, input.length)])[0],
    );
  }

  readToolResult(input: { sessionId: string; entryId: string; length?: number; field?: import("@ruukoto/core/history.ts").ToolResultField; offset?: number }) {
    return this.withSessionHistory(input.sessionId, (file) => readToolResult(file, input.entryId, input.length, input.field === undefined ? undefined : { field: input.field, offset: input.offset }));
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
    toolOp: Omit<ToolOpView, "params" | "paramsBytes" | "paramsTruncated">;
    params: BoundedText;
  } {
    const op = this.store.getToolOp(input.toolOpId);
    if (!op) throw new RuntimeApiError("not_found", `工具操作不存在：${input.toolOpId}`);
    const { params: _params, ...rest } = toolOpToView(op);
    return { toolOp: rest, params: this.pagedParams(op.params, input.offset, input.length) };
  }

  getToolOpMcp(input: { toolOpId: string; offset?: number; length?: number }): BoundedText {
    const op = this.store.getToolOp(input.toolOpId);
    if (!op?.mcp) throw new RuntimeApiError("not_found", "该工具操作没有电脑原始证据。");
    return this.pagedParams({ ...op.mcp }, input.offset, input.length);
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
  async searchHistory(input: {
    query: string;
    scope?: "workspace_chats";
    projectId?: string;
    sessionId?: string;
    taskId?: string;
    role?: string;
    since?: string;
    until?: string;
    limit?: number;
    scanLimit?: number;
    cursor?: { sessionId: string; byteOffset: number } | WorkspaceHistoryCursor | null;
    contextChars?: number;
  }): Promise<{
    hits: import("@ruukoto/core/history-index.ts").HistorySearchHit[];
    complete: boolean;
    cursor: { sessionId: string; byteOffset: number } | WorkspaceHistoryCursor | null;
    scanned: number;
    unindexedSessionIds: string[];
    sourceIssues?: WorkspaceHistorySearchResult["sourceIssues"];
    progress?: WorkspaceHistorySearchResult["progress"];
  }> {
    if (!input.query || input.query.length === 0) {
      throw new RuntimeApiError("invalid_params", "搜索关键词不能为空");
    }
    if (input.scope === "workspace_chats") {
      if (input.projectId || input.sessionId || input.taskId || input.role) throw new RuntimeApiError("invalid_params", "工作区正文搜索不接受会话、任务或角色限制");
      const candidates = this.workspaceChats().map(session => {
        let facts: { expected: boolean; entries: Set<string>; tasks: Set<string> } | undefined;
        const historyFacts = () => {
          if (facts) return facts;
          const tasks = [...this.store.listTasksBySession(session.id), ...(session.branchSource?.taskIds ?? []).map(id => this.store.getTask(id)).filter(task => task !== null)];
          const internal = tasks.filter(task => this.taskView(task).inputPurpose === "internal_report");
          facts = { expected: this.historyIndex.isIndexed(session.id) || tasks.some(task => task.historyEntryIds.length > 0), entries: new Set(internal.flatMap(task => task.historyEntryIds)), tasks: new Set(internal.map(task => task.id)) };
          return facts;
        };
        return { sessionId: session.id, filePath: session.sessionFile,
          get historyExpected() { return historyFacts().expected; },
          get excludedEntryIds() { return historyFacts().entries; },
          get excludedTaskIds() { return historyFacts().tasks; } };
      });
      try {
        return await searchWorkspaceHistory(this.db, candidates, input);
      } catch (error) {
        if (error instanceof HistoryReadError) throw new RuntimeApiError(error.code, error.message);
        throw error;
      }
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
   * expected_version（issue 06）：携带时做乐观并发校验（v1 起的正整数），
   * 省略 = 旧入口兼容写入；两条路径都更新同一行、递增同一设置版本并产生
   * 同一 project.settings_changed 事件。
   */
  setProjectInstructions(input: { projectId: string; files: string[]; expectedVersion?: number }): Project {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
      throw new RuntimeApiError("invalid_params", "expected_version 须为正整数（设置版本从 1 起）");
    }
    for (const file of input.files) {
      if (typeof file !== "string" || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
        throw new RuntimeApiError("invalid_params", `指令文件须为工作区相对路径且不含 ..：${String(file)}`);
      }
    }
    try {
      return this.store.withTx(() =>
        this.store.updateProjectSettings({ projectId: project.id, instructionFiles: input.files, expectedVersion: input.expectedVersion }),
      );
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  /**
   * 按项目启用/禁用 Web Search（issue 20；拥有者入口）。默认启用；
   * 禁用立即阻止后续调用（工具按调用新鲜检查），启用从下一任务生效
   * （任务开始固定工具清单）。expected_version 语义同 setProjectInstructions。
   */
  setProjectWebSearch(input: { projectId: string; enabled: boolean; expectedVersion?: number }): Project {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
      throw new RuntimeApiError("invalid_params", "expected_version 须为正整数（设置版本从 1 起）");
    }
    try {
      return this.store.withTx(() =>
        this.store.updateProjectSettings({ projectId: project.id, webSearch: input.enabled ? "enabled" : "disabled", expectedVersion: input.expectedVersion }),
      );
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
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
    const lib = loadHostSkillLibrary(this.config.agentDir);
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

  listManagedSkills(input: { offset?: number; limit?: number } = {}) {
    return new ManagedSkillsStore(this.config.agentDir).list(input);
  }

  getSkill(id: SkillId) {
    return new ManagedSkillsStore(this.config.agentDir).get(id);
  }

  previewSkillImport(sourceDir: string) {
    return new ManagedSkillsStore(this.config.agentDir).preview(sourceDir);
  }

  importSkill(input: { id: SkillId; sourceDir: string; contentRevision: string; expectedRevision: string }) {
    return new ManagedSkillsStore(this.config.agentDir).import(input);
  }

  setSkillEnabled(input: { id: SkillId; enabled: boolean; expectedRevision: string }) {
    return new ManagedSkillsStore(this.config.agentDir).setEnabled(input);
  }

  removeSkill(input: { id: SkillId; expectedRevision: string }) {
    return new ManagedSkillsStore(this.config.agentDir).remove(input);
  }

  listSubAgentRoles() {
    const library = loadSubAgentRoleLibrary(this.config.agentDir);
    return { dir: path.join(this.config.agentDir, "agents"), roles: library.roles.map(({ name, description, tools, permissions, digest }) => ({ name, description, tools, permissions, digest })), diagnostics: library.diagnostics };
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

  /** 配置/更新 NapCat OneBot 连接（拥有者操作；校验见 QqAdapter.configure）。 */
  async qqConfigure(input: Parameters<QqAdapter["configure"]>[0]): Promise<QqConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const config = this.qqAdapter.configure(input);
    await this.imEntries.applyConfig(QQ_PRIVATE_SOURCE);
    return config;
  }

  /** QQ 入口状态（配置视图 + 运行期连接状态；不含 token 与消息正文）。 */
  qqStatus() {
    return this.qqAdapter.status();
  }

  /** 一键停用/启用：停用即断开连接、阻止新接收与后续发送，运行中任务按取消机制收尾。 */
  async qqSetEnabled(enabled: boolean, expectedVersion?: number): Promise<QqConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const config = this.qqAdapter.setEnabled(enabled, expectedVersion);
    await this.imEntries.applyConfig(QQ_PRIVATE_SOURCE);
    return config;
  }

  /**
   * 旧群收件登记查看（新 → 旧；含状态与撤回标记）。核心群聊已退役（issue 20），
   * 本视图即归档核查入口：每条记录附 main 的接收账本行（接收时间、接收任务、
   * 理由、摘要快照）与当前复核结论（null = 可用；否则为不可用原因——归档行
   * 缺失/不一致、main 不可用或来源已撤回）。未经 main 接收的记录两字段为空。
   */
  qqListInbox(input: { groupId?: string; limit?: number } = {}): QqInboxArchiveRow[] {
    const mainProjectId = this.store.getAgentRole("main")?.projectId ?? null;
    return this.qqStore.listInbox(input).map((row) => {
      let accepted = mainProjectId && row.taskId ? this.store.getAcceptedChatResult(mainProjectId, row.taskId) : null;
      let sourceProblem: string | null = null;
      if (!mainProjectId && row.taskId) {
        // main 角色不可用（异常库）：不能把被阻断的来源显示成"未接收/可用"
        accepted = this.store.getAcceptedChatResultForTask(row.taskId);
        if (accepted) sourceProblem = "main 角色不可用，无法复核接收来源";
      } else if (accepted && mainProjectId && row.taskId) {
        try {
          resolveAcceptedChatResult(this.store, this.qqStore, mainProjectId, row.taskId);
        } catch (err) {
          sourceProblem = (err as Error).message;
        }
      }
      return {
        ...row,
        acceptance: accepted
          ? { acceptedAt: accepted.acceptedAt, acceptedByTaskId: accepted.acceptedByTaskId, reason: accepted.reason, summary: accepted.summary }
          : null,
        sourceProblem,
      };
    });
  }

  /** 发送记录查看（新 → 旧；含 sent/failed/unknown/canceled 与平台消息 id）。 */
  qqListOutbox(input: { groupId?: string; limit?: number } = {}): QqOutboxRow[] {
    return this.qqStore.listOutbox(input);
  }

  // ---------- Telegram owner 入口（issue 04；拥有者管理入口） ----------

  /** 配置/更新 Telegram bot 与固定 owner（拥有者操作；校验见 TelegramAdapter.configure）。 */
  async telegramConfigure(input: Parameters<TelegramAdapter["configure"]>[0]): Promise<TelegramConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const config = this.telegram.configure(input);
    await this.imEntries.applyConfig(TELEGRAM_SOURCE);
    return config;
  }

  /** Telegram 入口状态（配置视图 + 轮询状态；不含 token 与消息正文）。 */
  telegramStatus(): Record<string, unknown> {
    return this.telegram.status();
  }

  /** 一键启停：停用即停止轮询；未发送的 owner 回复与通知因目标停用而取消（不改发）。 */
  async telegramSetEnabled(enabled: boolean, expectedVersion?: number): Promise<TelegramConfig> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    const config = this.telegram.setEnabled(enabled, expectedVersion);
    await this.imEntries.applyConfig(TELEGRAM_SOURCE);
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
    const modelsClosed = this.models.close();
    this.store.withTx(() => {
      this.store.appendEvent({ type: "backend.stopping", reason });
      for (const { request, controller } of this.compactions.values()) {
        finishCompactionRequest(this.store, request.requestId, { status: "interrupted", errorCode: "backend_interrupted", errorMessage: "后台停止中断了压缩，未替换压缩点；可重新执行 /compact" });
        controller.abort();
      }
    });
    await Promise.allSettled([...this.compactions.values()].map(operation => operation.promise));

    await this.githubWebhook?.stop();
    this.githubWebhook = null;

    // 调度器先行停止（issue 03）：停止扫描与领取，中止并等待在途发送收尾；
    // 之后编排器等待派发链，关闭数据库前不再有发送回调写库
    await this.scheduler?.stop().catch(() => {});
    // Telegram 轮询停止（issue 04）：之后不再登记入站事件、不再写轮询偏移
    await this.telegram.stop().catch(() => {});
    // 编排器先行停止：停超时巡检，停止路径不再产生新的取消/唤醒
    if (this.orchestrator) {
      await this.orchestrator.stop().catch(() => {});
      this.orchestrator = null;
    }

    // QQ 适配器先行停止：断开 NapCat 连接、停止接收新事件（在途任务由下方
    // 统一中断路径收尾；未发送回复保留 pending 事实，不在停止路径补发）
    await this.qqAdapter.stop().catch(() => {});
    await this.workflows?.stop("backend_stop");
    await this.hostExecutions.shutdown("backend_stop");
    await this.backgroundProcesses.shutdown();
    await Promise.allSettled([...this.hostOperationPromises]);

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
        await endTaskExecution({ store: this.store, ledger: this.ledger, onReleased: () => this.kickAll() }, task, { taskId: task.id, stopSnapshot: null }, {
          terminal: "interrupted", reason: "backend_stop", unreapedReason: "backend_stop",
        });
      }
    }

    await modelsClosed;
    for (const driver of this.drivers.values()) {
      await driver.dispose();
    }
    this.drivers.clear();
    await this.cuaManager.shutdown();
    await this.browserManager.shutdown();

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
