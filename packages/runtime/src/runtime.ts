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
import { CodeScheduler } from "./code-scheduler.ts";
import { bindCodeScheduleTask, CodeScheduleError, getCodeScheduleRunForSession, getCodeScheduleRunForTask, getCodeScheduledTaskSource, getOpenCodeScheduleRunForSession, listCodeScheduleRunTasks, listCodeSchedules, listCodeScheduleRuns, listOpenCodeScheduleRuns, pauseCodeSchedule, type CodeScheduleConfig, type CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { SelectorBudgetConfig } from "@ruukoto/agent/context-selector.ts";
import { DEFAULT_BUDGET_CONFIG, selectionBreakdown,SelectionRecordCorrupt,type ContextBreakdown } from "@ruukoto/agent/context-selector.ts";
import { generateManualCompaction, inspectManualCompaction, ManualCompactionError } from "@ruukoto/agent/manual-compaction.ts";
import { Driver } from "@ruukoto/agent/driver.ts";
import { endTaskExecution, type TaskEndingContext } from "@ruukoto/agent/task-ending.ts";
import { BrowserManager, BROWSER_META_KEY, type BrowserManagerOptions } from "@ruukoto/agent/browser-manager.ts";
import { DesktopBrowserManager } from "@ruukoto/agent/desktop-browser.ts";
import { createDesktopBrowserFamily } from "@ruukoto/agent/desktop-browser-tools.ts";
import { browserTaskAllowed, createBrowserFamily } from "@ruukoto/agent/browser-tools.ts";
import { assertGrantNotProtected, assertGrantsNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import {
  createLauncherFor,
  ExecutionError,
  type ExecutionBackendConfig,
} from "@ruukoto/agent/execution/launchers.ts";
import type { HostToolFamily } from "@ruukoto/agent/host-tool-families.ts";
import { createHostDataFamily } from "@ruukoto/agent/host-tools.ts";
import { getProjectJevConfig,JEV_CREDENTIAL_PURPOSE,jevConfigKey,jevCredentialHost,type JevConfig } from "@ruukoto/agent/jev-config.ts";
import { connectMcpService,isMcpCredential,MCP_CREDENTIAL_PURPOSE,McpError,parseMcpEndpoint,type McpConnection,type McpTimeouts } from "@ruukoto/agent/mcp/client.ts";
import { allowlistEffectFor,McpStore,McpVersionConflictError,normalizeToolAllowlist,type McpServiceConfig,type McpToolEffect } from "@ruukoto/agent/mcp/store.ts";
import { CodeCuaManager } from "@ruukoto/agent/mcp/code.ts";
import { cuaToolEffect, parseCuaConfig, restrictCuaTool, type CuaConfig } from "@ruukoto/agent/mcp/cua.ts";
import { describeCuaTools, discoverCuaTargets } from "@ruukoto/agent/mcp/cua-discovery.ts";
import { readMacosCuaPermissions } from "@ruukoto/agent/execution/native-macos-identity.ts";
import { validateRemoteTool } from "@ruukoto/agent/mcp/tools.ts";
import { configSecrets, loadSummaryModel, type SummaryModel } from "@ruukoto/agent/model-config.ts";
import { ModelSelectionError, type ModelCatalog } from "@ruukoto/agent/model-selection.ts";
import { sessionsDirFor } from "@ruukoto/agent/session-factory.ts";
import { createSkillFamily, getSkillDetail, listSkillLibrary, loadSkillLibrary, skillsDirFor, type SkillId } from "@ruukoto/agent/skills.ts";
import { subAgentTaskRequestId } from "@ruukoto/agent/subagent-ledger.ts";
import { createSubAgentFamily } from "@ruukoto/agent/subagent-tools.ts";
import { subAgentAccessPolicy } from "@ruukoto/agent/subagent-capabilities.ts";
import { SubAgentRoleError, validateSubAgentRole } from "@ruukoto/agent/subagent-roles.ts";
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
import { MessageRecallRuntime, RECALL_PAUSE_REASON } from "./message-recall.ts";
import { closeEditWindows, getEditWindowRecall, getOpenMessageRecall, publicMessageRecall } from "@ruukoto/core/message-recall.ts";
import { createCodingTools } from "@ruukoto/agent/tool-router.ts";
import { createWebSearchFamily,TAVILY_CREDENTIAL_PURPOSE,WEB_SEARCH_CREDENTIAL_NAME } from "@ruukoto/agent/web-search.ts";
import { resolveTavilyTarget } from "@ruukoto/agent/web-search-transport.ts";
import { createSourceResolver,type SourceResolver,type SourceRef } from "@ruukoto/channels/source-resolver.ts";
import { AccessDeniedError,AccessScope } from "@ruukoto/core/access.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { Db } from "@ruukoto/core/db.ts";
import { getBranchRequest, sourceArtifact } from "@ruukoto/core/branch.ts";
import { getSideChatByRequest, listSideChats } from "@ruukoto/core/side-chat.ts";
import { getManagedWorkspaceRequest, listManagedWorkspaceRequestIds, saveManagedWorkspaceRequest, type ManagedWorkspaceRequest } from "@ruukoto/core/managed-workspaces.ts";
import { prepareManagedWorkspace, verifyManagedWorkspace } from "./managed-workspace.ts";
import { finishCompactionRequest, getCompactionRequest, getLatestSessionCompaction, recoverCompactionRequests, reserveCompactionRequest, updateCompactionSource } from "@ruukoto/core/compaction.ts";
import { DirIdentityError,resolveDirIdentity,sameDirIdentity,verifyDirIdentity,type DirIdentity } from "@ruukoto/core/dir-identity.ts";
import { effectiveProjection } from "@ruukoto/core/history-effective.ts";
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
import { cancelOwnerQuestion, consumeOwnerQuestion, createOwnerQuestion, getOwnerQuestion, getOwnerQuestionReceipt, invalidateOwnerQuestionsForTask, listOwnerQuestions, ownerQuestionTaskEligible, ownerQuestionToView, parseOwnerAnswers, OwnerQuestionError, type OwnerQuestion, type OwnerQuestionReceipt, type OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import { PRODUCT } from "@ruukoto/core/product.ts";
import { verifyProfile, ensureProfileEndpoint, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { Store,StoreConflictError } from "@ruukoto/core/store.ts";
import { bindWorkflowExecution, chargeWorkflow, controlWorkflow, findWorkflowRun, getWorkflowDeliveryRun, getWorkflowExecution, getWorkflowQuestion, getWorkflowReceipt, getWorkflowRunNumber, getWorkflowStep, listWorkflowExecutions, listWorkflowRuns, listWorkflowSteps, recoverWorkflowRuns, requireWorkflowRun, setWorkflowState, startWorkflowExecution, updateWorkflowExecution, updateWorkflowRun, workflowDeliveryKey, workflowDigest, workflowJson, workflowSlotsUsed, workflowTerminal, WorkflowError, type WorkflowControl, type WorkflowRun, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import { requireSubAgentExecutionScope, SubAgentExecutionError } from "@ruukoto/core/subagent-execution.ts";
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
import { openSideChat, recoverSideChats, type SideChatDeps } from "./side-chat.ts";
import type { DataCategory,DataGrant,Memory,MemorySourceRef,MemoryVersion,SelectionRecord } from "@ruukoto/core/types.ts";
import {
  ACTIVE_TASK_STATUSES,
  isAccessMode,
  isSessionDefaultMode,
  isTerminalTaskStatus,
  normalizeIsoInstant,
  randomId,
  SESSION_DEFAULT_MODES,
  type AccessMode,
  type Artifact,
  type ConfirmationRequest,
  type ContextCheckpoint,
  type GrantedPath,
  type ModelSelection,
  type ToolCategory,
  type PersistentEvent,
  type Project,
  type Session,
  type SessionCompactionRequest,
  type MessageRecall,
  type PublicMessageRecall,
  type SessionDefaultMode,
  type SubAgent,
  type SubAgentMessage,
  type Task,
  type TaskGuidance,
  type TaskQueue,
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
import { AgentWaitError, agentWaitView, agentReportKey, bindAgentReportFallback, claimAgentReports, consumeAgentReport, getAgentReport, registerAgentReport, isAgentReportFallback, isAgentReportParked,
  completeAgentReports, finishAgentReportFallback, invalidateAgentReports, parkAgentReportFallback, transferAgentReportFallbacks, latestAgentReferenceSnapshot, listAgentReports, listAgentWaits, recoverAgentWaits, releaseAgentReports, sameAgentReportSource, startAgentReportFallback,
  type AgentReport, type AgentReportCompletion, type AgentReportTarget, type AgentWaitTarget } from "@ruukoto/core/agent-wait.ts";
import { createAgentWaitFamily } from "@ruukoto/agent/agent-wait-tools.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "@ruukoto/core/types.ts";
import { SubAgentDelegationError,SubAgentManager,type WorkCancellation } from "@ruukoto/runtime/subagents.ts";
import { loadSubAgentRoleLibrary } from "./subagent-role-library.ts";
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




export interface RuntimeConfig {
  profile: ProfilePaths;
  /** 宿主测试可注入步骤执行器；null 只启用存储与宿主操作测试，默认使用真实 Driver。 */
  workflowAgent?: WorkflowAgentExecutor | null;
  workflowIntegrate?: import("./workflows.ts").WorkflowDeps["integrate"];
  browser?: Pick<BrowserManagerOptions, "binaryPath" | "chromePath" | "headed" | "noSandbox">;
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
  /** 编排器（issue 01）：超时巡检间隔覆盖（仅测试注入；生产取默认）。 */
  orchestrator?: { deadlineCheckMs?: number };
  /** Clock and polling overrides for scheduled Coding execution. */
  scheduler?: { now?: () => number; tickMs?: number };
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
  private desktopBrowserManager!: DesktopBrowserManager;
  private cuaManager!: CodeCuaManager;
  private backgroundProcesses!: RuntimeBackgroundProcesses;
  readonly credentials: CredentialStore;
  /** 统一数据访问范围（issue 05 §1）：身份由宿主注入，跨项目仅经拥有者授权。 */
  readonly access: AccessScope;
  /** pi JSONL 历史的可重建位置索引（issue 05 §2）。 */
  readonly historyIndex: HistoryIndex;
  /** 长期记忆存储（issue 05 §5）。 */
  readonly memories: MemoryStore;
  /** MCP 服务配置：由本实例管理。 */
  readonly mcp: McpStore;
  /** 后台编排器（issue 01）：角色引导、入站事件派发、子任务结果回传与超时。 */
  orchestrator: Orchestrator | null = null;
  /**
   * 通用 SubAgent 委派（agent-direction issue 11）：工作委托、动态身份与
   * 执行任务的集中登记；普通开发会话与 main 的委派工具经它提交。
   */
  subagents: SubAgentManager | null = null;
  workflows: WorkflowCoordinator | null = null;
  readonly workflowLibrary: WorkflowLibrary;
  private workflowSteps!: WorkflowSteps;
  hostExecutions!: HostExecutionManager;
  /** 父级送达（架构工单 09）：结果与工作内消息怎样、何时进入主 Agent 的模型调用。 */
  private readonly parentDelivery: ParentDelivery;
  private readonly agentWait: RuntimeAgentWait;
  /** Recall orchestration: acceptance, stopping, effective history and receipts. */
  readonly messageRecall: MessageRecallRuntime;
  private readonly reportGroups = new Set<string>();
  /** 工具操作账本（架构工单 05）：结果、效果未知与停止/重启补记。 */
  private ledger!: ToolOpLedger;
  private hostToolFamilies!: readonly HostToolFamily[];
  codeScheduler: CodeScheduler | null = null;
  private sources!: SourceResolver;
  /** 额外事件监听（QQ 适配器等宿主内订阅者；控制面广播仍走 onEventBroadcast）。 */
  private readonly eventListeners = new Set<(events: PersistentEvent[]) => void>();
  private readonly lock: AcquiredLock;
  /** 模型配置锁（issue 21 §3）：同一 agentDir 的在线/离线写入互斥。 */
  private readonly configLock: AcquiredLock;
  readonly models: RuntimeModels;
  get defaultSelection(): ModelSelection { return this.models.current.defaultSelection; }
  private drivers = new Map<string, Driver>();
  private readonly reportRequestInputs = new Map<string, { entryId: string; keys: string[] }[]>();
  private readonly preparedReportInputs = new Map<string, { reportKeys: string[]; entryIds: string[] }>();
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
  /**
   * MyGo 桌面浏览器通路（mygo-agent-browser）：由控制面在启动时挂接——
   * desktopBrowserCall 向已登记连接发起窄命令（含截图/快照分块装配）；
   * onDesktopBrowserEvent 由宿主消费页面事实（闸门/导航/渲染失效），
   * 断线即绑定失效，事件与页面只认发出时那个连接身份。
   */
  desktopBrowserCall: ((connectionId: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>) | null = null;
  onDesktopBrowserEvent: ((connectionId: string, event: { session: string; kind: string; generation: number; owned?: boolean; source?: string; url?: string; title?: string }) => void) | null = null;
  /** 已登记桌面浏览器连接断开（ControlServer 在 socket 关闭回收时通知）。 */
  onDesktopBrowserDisconnected: ((connectionId: string) => void) | null = null;

  private constructor(config: RuntimeConfig, db: Db, store: Store, lock: AcquiredLock, configLock: AcquiredLock) {
    this.config = config;
    this.db = db;
    this.store = store;
    this.workflowLibrary = new WorkflowLibrary(store, config.profile.agentDir);
    this.lock = lock;
    this.configLock = configLock;
    this.models = new RuntimeModels({
      store, config,
      countActiveCompactions: providers => [...this.compactions.values()].filter(({ request }) => providers.includes(request.summaryModel.provider)).length,
      publishStack: stack => { for (const driver of this.drivers.values()) driver.updateModelDeps(stack); },
      flushPendingMessages: () => this.subagents?.flushPendingMessages() ?? Promise.resolve(),
    });
    this.artifacts = new ArtifactStore(config.profile.dataDir, store);
    this.attachments = new OwnerAttachments(config.profile.dataDir, store, this.artifacts);
    this.credentials = new CredentialStore(config.profile.agentDir);
    this.access = new AccessScope(db);
    this.historyIndex = new HistoryIndex(db);
    this.memories = new MemoryStore(db);
    this.mcp = new McpStore(db);
    this.parentDelivery = new ParentDelivery({
      store,
      submit: (input) => this.submitInternal(input),
      defaultModelSelection: () => this.defaultSelection,
      readReply: (taskId) => this.readTaskReplyText(taskId),
      verifyWorkflowReport: run => this.verifyWorkflowReport(run),
      reserveAgentReport: report => this.agentWait.reserve(report),
      verifyWork: work => this.subagents!.verifyWorkspace(work),
      verifyTask: task => this.verifySubAgentSource(task),
      verifyAgentReport: report => this.verifyAgentWaitTarget(report.source, report.target) && !this.agentReportWorkCanceled(report),
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
    // Resolve recall dependencies lazily because host execution, workflow and SubAgent managers
    // are initialized later; closures avoid construction-order coupling.
    this.messageRecall = new MessageRecallRuntime({
      store,
      sessionsDir: sessionsDirFor(config.profile.dataDir),
      driverFor: sessionId => this.drivers.get(sessionId),
      ensureDriver: session => this.getDriver(session),
      disposeDriver: async sessionId => {
        const driver = this.drivers.get(sessionId);
        this.drivers.delete(sessionId);
        await driver?.dispose();
      },
      hostExecutions: () => this.hostExecutions ?? null,
      workflows: () => this.workflows,
      subagents: () => this.subagents,
      backgroundProcesses: { requestStop: (id, reason) => { this.backgroundProcesses?.requestStop(id, reason); } },
      agentWait: this.agentWait,
      attachments: this.attachments,
      artifacts: this.artifacts,
      kick: sessionId => this.kick(sessionId),
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
    return this.config.profile.controlDir;
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
      canonical(this.config.profile.dataDir),
      canonical(this.config.profile.agentDir),
      canonical(this.controlDir()),
      canonical(CODE_ROOT),
    ];
  }

  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-operation-specific-checks.md
  launcherFor(mode: AccessMode) {
    const config = this.config.execution ?? { backend: "local" as const };
    const launcher = createLauncherFor(config.backend === "native" ? {
      ...config,
      native: { ...config.native, protectedRoots: [...this.protectedRoots(), ...(config.native?.protectedRoots ?? [])] },
    } : config, mode);
    if (mode === "full_access" || launcher.kind === "native") return launcher;
    return { ...launcher, launch: async (spec: Parameters<typeof launcher.launch>[0]) => {
      try { assertGrantsNotProtected([spec.workspace, ...spec.grantedPaths.map(grant => grant.path), ...(spec.readRoots ?? []).map(root => root.path)], this.protectedRoots()); }
      catch (error) {
        throw new ExecutionError("execution_unavailable", "受限执行范围不可用：请停止本轮并向拥有者报告工作目录与授权范围。", undefined, "sandbox_rejected", { cause: error });
      }
      return launcher.launch(spec);
    } };
  }

  /**
   * 按发起任务模式创建与汇总 worktree，执行宿主固定 Git 命令。
   * 副本与必要共享 Git 目录按操作授予；停止未核实时保留结果与目录占用。
   * Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
   * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
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
      const codeSource = getCodeScheduledTaskSource(this.store, parent.id);
      if (codeSource) bindCodeScheduleTask(this.store, { runId: codeSource.runId, taskId: task.id, sourceTaskId: parent.id });
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
    verifyProfile(config.profile);
    await ensureProfileEndpoint(config.profile);
    const fullConfig: RuntimeConfig = { ...config, execution: config.execution ?? { backend: "local" } };
    fs.mkdirSync(sessionsDirFor(fullConfig.profile.dataDir), { recursive: true, mode: 0o700 });

    const lock = acquireInstanceLock(fullConfig.profile.dataDir);
    // 配置锁（issue 21 §3）：同一 agentDir 只允许一个在线后台或离线配置写入方，
    // 覆盖不同 dataDir 指向同一 agentDir 的情况
    let configLock: AcquiredLock;
    try {
      configLock = acquireConfigLock(fullConfig.profile.agentDir);
    } catch (err) {
      lock.release();
      throw err;
    }
    let runtime: Runtime;
    try {
      const db = new Db(fullConfig.profile.dataDir, undefined, { instanceId: fullConfig.profile.instanceId, layout: fullConfig.profile.layout, preparationId: fullConfig.profile.preparationId });
      const store = new Store(db);
      runtime = new Runtime(fullConfig, db, store, lock, configLock);
    } catch (err) {
      configLock.release();
      lock.release();
      throw err;
    }


    try {
      await runtime.models.initialize();
    } catch (err) {
      runtime.db.close();
      configLock.release();
      lock.release();
      throw err;
    }

    runtime.initSources();
    // 通用 SubAgent 委派（agent-direction issue 11）：子工作目录在 agent-work/
    // 下（保护根之外）；登记事务前的准备与提交后的 kick 由管理器执行
    const worktreeRoot = path.join(fullConfig.profile.workCopyDir, "worktrees");
    const workCopies = new WorkCopyManager({
      worktreeRoot,
      protectedRoots: () => runtime.protectedRoots(),
      execute: fullConfig.workCopyExecutor ?? ((input) => runtime.executeWorkCopy(input)),
    });
    runtime.subagents = new SubAgentManager({
      store: runtime.store,
      roles: () => loadSubAgentRoleLibrary(fullConfig.profile.agentDir),
      source: taskId => { const task = runtime.store.getTask(taskId); if (task && runtime.mcpSourceBlocked(task)) throw new SubAgentExecutionError("effect_unknown", "原来源存在未知 MCP 效果；请查询原工作，不能重新委派业务。"); return runtime.workflowSource(taskId, true); },
      verifySource: source => runtime.verifyWorkflowSource(source),
      preflight: async (source, definition) => (await runtime.getDriver(runtime.store.getSession(source.sessionId)!)).preflightSubAgent(source, definition),
      workRoot: path.join(fullConfig.profile.workCopyDir, "sub-agents"),
      workCopies,
      sources: runtime.sources,
      resolveSelection: (selection) => runtime.models.resolveSelection(selection),
      launcherFor: (mode) => runtime.launcherFor(mode),
      kickSession: (sessionId) => runtime.kick(sessionId),
      resumeQueue: (sessionId) => runtime.resumeQueue(sessionId),
      parentDelivery: runtime.parentDelivery,
      cancelTask: (taskId, reason) => runtime.cancelTask(taskId, reason ? { reason } : undefined),
      assertSourceOpen: (taskId) => runtime.messageRecall.assertSourceNotSealed(taskId),
      protectedRoots: () => runtime.protectedRoots(),
    });
    runtime.initDesktopBrowser();
    runtime.initHostToolFamilies();
    runtime.workflowSteps = new WorkflowSteps({ store: runtime.store, artifacts: runtime.artifacts, access: runtime.access,
      copies: new WorkCopyManager({ worktreeRoot: path.join(fullConfig.profile.workCopyDir, "worktrees"),
        protectedRoots: () => runtime.protectedRoots(), execute: input => runtime.executeWorkCopy(input) }),
      hostOperation: (input, execute) => runtime.workflowHostOperation(input, execute),
      getDriver: session => runtime.getDriver(session), readReply: (taskId, offset, length) => runtime.readTaskReply(taskId, offset, length),
      verifySource: source => runtime.verifyWorkflowSource(source),
      verifySources: (projectId, refs, taskId) => runtime.sources.verify(projectId, refs as SourceRef[], taskId),
      ...(fullConfig.workflowAgent ? {} : { verifyExecution: (task: Task) => runtime.workflowSteps.assertExecution(task) }),
    });
    runtime.cuaManager.recover();
    await runtime.browserManager.recover();
    await runtime.backgroundProcesses.recover();
    runtime.recover();
    if (fullConfig.workflowAgent !== null) {
      runtime.workflows = new WorkflowCoordinator({ store: runtime.store,
        roles: () => loadSubAgentRoleLibrary(fullConfig.profile.agentDir),
        ledger: runtime.ledger,
        workRoot: path.join(fullConfig.profile.workCopyDir, "workflow-agents"),
        source: taskId => { const task = runtime.store.getTask(taskId); if (task && runtime.mcpSourceBlocked(task)) throw new WorkflowError("effect_unknown"); return runtime.workflowSource(taskId); }, selection: taskId => runtime.store.getTask(taskId)!.modelSelection!,
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
    // Recover pending recalls from persisted phases and verify completion markers for completed receipts
    // after workflow and SubAgent managers are assembled.
    await runtime.messageRecall.recoverAll();
    runtime.recoverManagedSessions();
    await recoverBranchSessions(runtime.branchDeps());
    await recoverSideChats(runtime.sideDeps());
    runtime.orchestrator = new Orchestrator({
      store: runtime.store,
      deadlineCheckMs: fullConfig.orchestrator?.deadlineCheckMs,
      bridge: {
        submit: (input) => runtime.submitInternal(input),
        cancelTask: (taskId, reason) => runtime.cancelTask(taskId, reason ? { reason } : undefined),
        readTaskReply: (taskId, offset, length) => runtime.readTaskReply(taskId, offset, length),
        resumeQueue: (sessionId) => runtime.resumeQueue(sessionId),
        kickSession: (sessionId) => runtime.kick(sessionId),
        defaultModelSelection: () => runtime.defaultSelection,
      },
      parentDelivery: runtime.parentDelivery,
      // issue 13：SubAgent 执行任务终态与启动恢复时冲刷待投递的工作内消息
      subagents: {
        resultRecorded: (task) => runtime.subagents!.resultRecorded(task),
        verifyWorkspace: work => runtime.subagents!.verifyWorkspace(work),
        start: () => runtime.subagents!.start(),
        flushPending: (parentSessionId) => runtime.subagents!.flushPendingMessages(parentSessionId),
      },
    });
    runtime.addEventListener((events) => runtime.orchestrator?.onRuntimeEvents(events));
    await runtime.orchestrator.start();
    runtime.codeScheduler = new CodeScheduler({ store: runtime.store,
        prepare: async config => {
          const check = await runtime.models.resolveSelection(config.modelSelection);
          runtime.launcherFor(config.permission);
          return check;
        }, outcome: run => runtime.codeScheduledRunOutcome(run), cancel: run => runtime.cancelCodeScheduledRun(run),
        kick: sessionId => runtime.kick(sessionId), now: fullConfig.scheduler?.now, tickMs: fullConfig.scheduler?.tickMs });
    runtime.addEventListener(() => runtime.codeScheduler?.kick());
    runtime.codeScheduler.start();
    runtime.store.withTx(() => {
      runtime.store.appendEvent({ type: "backend.started", dataDir: fullConfig.profile.dataDir, executionBackend: fullConfig.execution!.backend, product: PRODUCT });
    });
    return runtime;
  }

  socketPath(): string {
    return this.config.profile.socketPath;
  }

  private workflowSource(taskId: string, delegation = false): WorkflowSource {
    const task = this.store.getTask(taskId);
    // Reject workflow/delegation registration from recall-sealed sources.
    this.messageRecall.assertSourceNotSealed(taskId);
    const codeSource = task ? getCodeScheduledTaskSource(this.store, task.id) : null;
    const session = task ? this.store.getSession(task.sessionId) : null;
    const identity = session ? this.store.getSessionIdentity(session.id) : null;
    if (this.stopping || !task || !session || identity?.kind !== "dev" || task.planMode ||
        task.subAgentId || getWorkflowExecution(this.store, task.id) || getWorkflowDeliveryRun(this.store, task.id) || task.cancelRequested || !(delegation ? ["queued", "running", "awaiting_confirmation"] : ["running", "awaiting_confirmation"]).includes(task.status) || !task.modelSelection ||
        (!codeSource && task.parentTaskId)) throw new WorkflowError("source_forbidden");
    for (const ref of task.readScope?.sourceRefs ?? []) {
      if (typeof ref !== "object" || ref === null || !("kind" in ref) || !("ref" in ref) || typeof ref.ref !== "string") throw new WorkflowError("source_invalid");
      const id = ref.kind === "task_result" ? ref.ref.slice("task:".length) : ref.kind === "artifact" ? this.store.getArtifact(ref.ref.slice("artifact:".length).split("@")[0])?.taskId : null;
      if (id && getWorkflowExecution(this.store, id)) throw new WorkflowError("cross_run_source");
    }
    return { product: PRODUCT, projectId: session.projectId, sessionId: session.id, taskId: task.id, permissionVersion: task.permissionVersion,
      accessMode: task.accessMode, grantedPaths: task.grantedPaths, capabilities: sessionToolCategories("dev"),
      references: task.readScope?.sourceRefs ?? [],
      ...(codeSource ? { codeScheduledRunId: codeSource.runId } : {}),
      authority: { toolClass: "dev", categories: this.delegationCategories(),
        grantIds: this.access.listGrants().filter(grant => grant.toProjectId === session.projectId).map(grant => grant.id),
        configuration: this.workflowConfiguration(session.projectId), workspace: { path: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno } } };
  }

  private delegationCategories(): ToolCategory[] {
    return [...new Set([...sessionToolCategories("dev").filter(category =>
      ["coding", "mcp", "subagent"].includes(category) || this.hostToolFamilies.some(family => family.category === category)), "coding" as const, "mcp" as const])];
  }

  private workflowConfiguration(projectId: string): string {
    const services = this.mcp.listServices();
    const credentials = this.credentials.list().filter(binding => binding.purpose === MCP_CREDENTIAL_PURPOSE ||
      !this.credentials.get(binding.name)?.scope?.projectId || this.credentials.get(binding.name)?.scope?.projectId === projectId).map(binding => this.credentials.get(binding.name));
    return workflowDigest({ services, credentials, webSearch: this.store.getWebSearch().state, searchConfig: this.config.webSearch ?? null,
      execution: this.config.execution });
  }

  /** 未知 MCP 效果冻结原输入的自动业务；新拥有者输入拥有独立来源。 */
  private mcpSourceBlocked(task: Task): boolean {
    const roots = new Set<string>();
    const pending = [task.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (roots.has(id)) continue;
      roots.add(id);
      const current = this.store.getTask(id);
      if (!current) continue;
      if (current.parentTaskId) pending.push(current.parentTaskId);
      if (current.resumesTaskId) pending.push(current.resumesTaskId);
      const work = current.workId ? this.store.getWorkDelegation(current.workId) : null;
      if (work) pending.push(work.originTaskId);
      const inherited = current.readScope?.execution?.source.taskId;
      if (inherited) pending.push(inherited);
      const execution = getWorkflowExecution(this.store, id);
      if (execution) pending.push(requireWorkflowRun(this.store, execution.runId).source.taskId);
    }
    const placeholders = [...roots].map(() => "?").join(",");
    return !!this.store.db.prepare(`WITH RECURSIVE lineage(id) AS (
      SELECT id FROM tasks WHERE id IN (${placeholders})
      UNION SELECT child.id FROM tasks child JOIN lineage parent ON child.parent_task_id = parent.id
        OR child.resumes_task_id = parent.id
        OR json_extract(child.read_scope, '$.execution.source.taskId') = parent.id
        OR child.work_id IN (SELECT id FROM work_delegations WHERE origin_task_id = parent.id)
      ) SELECT 1 FROM tool_ops op JOIN lineage ON lineage.id = op.task_id WHERE op.effect_unknown = 1 AND op.mcp IS NOT NULL LIMIT 1`).get(...roots);
  }

  private verifyWorkflowSource(source: WorkflowSource, finalReport = false): boolean {
    const task = this.store.getTask(source.taskId);
    const session = this.store.getSession(source.sessionId);
    const identity = this.store.getSessionIdentity(source.sessionId);
    if (task && !finalReport && this.mcpSourceBlocked(task)) return false;
    if (this.stopping || source.product !== PRODUCT || !task || task.sessionId !== source.sessionId || task.permissionVersion !== source.permissionVersion || task.accessMode !== source.accessMode || !isDeepStrictEqual(task.grantedPaths, source.grantedPaths) || !session || session.projectId !== source.projectId ||
        identity?.kind !== "dev") return false;
    try {
      const codeSource = getCodeScheduledTaskSource(this.store, task.id);
      if ((source.codeScheduledRunId ?? null) !== (codeSource?.runId ?? null)) return false;
    } catch (error) {
      if (!(error instanceof CodeScheduleError)) throw error;
      return false;
    }
    if (source.authority) {
      if (source.authority.toolClass !== "dev" || !isDeepStrictEqual(source.authority.categories, this.delegationCategories())) return false;
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
    return !this.sources.verify(source.projectId, source.references as SourceRef[]);
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
      const scope = requireSubAgentExecutionScope(previous.readScope), saved = scope.execution;
      if (saved.roleDigest !== definition.digest || saved.accessMode !== previous.accessMode ||
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
      if (this.sources.verify(saved.source.projectId, scope.sourceRefs as SourceRef[], previous.id)) return "subagent_materials_revoked";
      if (scope.readMemories.some(memoryId => this.memories.getMemory(memoryId)?.status !== "active")) return "subagent_memory_revoked";
      for (const op of this.store.listToolOpsByTask(previous.id)) {
        if (Array.isArray(op.params.source_refs) && this.sources.verify(saved.source.projectId, op.params.source_refs as SourceRef[], previous.id)) return "subagent_materials_revoked";
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
    const codeScheduled = getCodeScheduledTaskSource(this.store, parent.id);
    if ((source.codeScheduledRunId ?? null) !== (codeScheduled?.runId ?? null)) throw new AgentWaitError("source_invalid");
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
    if (current && getCodeScheduleRunForTask(this.store, current.id)) {
      let child: Task | null = null;
      if (current.requestId.startsWith("wake:")) {
        child = this.store.getTask(current.requestId.slice("wake:".length));
        if (!child || current.parentTaskId !== child.id || !child.subAgentId || !child.workId ||
            this.store.getWorkDelegation(child.workId)?.parentSessionId !== current.sessionId) return "subagent_source_invalid";
      } else if (current.requestId.startsWith("smsg:")) {
        const message = this.store.getSubAgentMessage(current.requestId.slice("smsg:".length));
        child = message ? this.store.getTask(message.fromTaskId) : null;
        if (!message || message.parentSessionId !== current.sessionId || message.toSubAgentId || message.deliveredTaskId !== current.id ||
            !child || current.parentTaskId !== child.id || child.workId !== message.workId || child.subAgentId !== message.fromSubAgentId) return "subagent_source_invalid";
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
      if (this.agentReportWorkCanceled(report)) return "agent_report_work_canceled";
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
    const raw = parseSessionFile(file), omitted = effectiveProjection(raw).omitted;
    const entries = raw.filter(entry => entry.type !== "context_edit" && !omitted.has(entry.id));
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
    if (!task) return [...reports.values()];
    const actualInputs = this.reportInputEntries(task);
    for (const input of actualInputs) for (const key of input.keys) {
      const report = getAgentReport(this.store, key);
      if (!report) throw new AgentWaitError("report_input_reference_missing");
      reports.set(key, report);
    }
    const inputKeys = new Set(actualInputs.flatMap(input => input.keys)), consumedInputs = new Map(actualInputs.map(input => [input.entryId, new Set(input.keys)]));
    for (const entry of this.agentTaskEntries(task)) {
      const message = entry.message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
      if (entry.type !== "message" || message?.role !== "toolResult" || message.toolName !== "wait" || !waits.some(wait => wait.sdkCallId === message.toolCallId) || message.isError) continue;
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
    const dynamic = this.reportInputEntries(task).find(input => reports.every(report => input.keys.includes(report.key)));
    if (dynamic) return { entryId: dynamic.entryId, keys: reports.map(report => report.key) };
    const calls = listAgentWaits(this.store, { taskId: task.id }).filter(wait => wait.reason === "result").map(wait => wait.sdkCallId);
    for (const entry of this.agentTaskEntries(task)) {
      const message = entry.message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
      if (entry.type !== "message" || message?.role !== "toolResult" || message.toolName !== "wait" || !calls.includes(message.toolCallId ?? "") || message.isError) continue;
      const result = JSON.parse(message.content!.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")) as import("@ruukoto/agent/agent-wait-tools.ts").AgentWaitResult;
      const group = result.reportTargets;
      if (result.reason === "result" && group && group.length <= 20 && group.length === reports.length && reports.every(report => group.some(target =>
        target.reportOwnerTaskId === task.id && target.resultSummary !== null && target.resultSummary !== undefined && target.kind === report.target.kind &&
        (target.kind === "task" && report.target.kind === "task" ? target.taskId === report.target.taskId : target.kind === "workflow" && report.target.kind === "workflow" && target.runId === report.target.runId && target.terminalVersion === report.target.terminalVersion)))) return { entryId: entry.id, keys: reports.map(report => report.key) };
    }
    return null;
  }

  private reportInputEntries(task: Task): { entryId: string; keys: string[] }[] {
    const inputs: { entryId: string; keys: string[] }[] = [];
    const fallback = listAgentReports(this.store, { taskId: task.id }).filter(report => report.fallbackTaskId === task.id);
    const entries = this.agentTaskEntries(task);
    for (const entry of entries) {
      const message = entry.message as { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; ruukotoReportKeys?: unknown; content?: { type: string; text?: string }[] } | undefined;
      let keys: string[] = [];
      if (entry.type === "message" && message?.role === "user" && Array.isArray(message.ruukotoReportKeys)) {
        if (message.ruukotoReportKeys.some(key => typeof key !== "string")) throw new AgentWaitError("report_input_invalid");
        keys = message.ruukotoReportKeys;
        const marker = entries.find(item => item.type === "custom" && item.customType === "ruukoto_agent_report_context" &&
          (item.data as { taskId?: string } | undefined)?.taskId === task.id && isDeepStrictEqual((item.data as { reportKeys?: string[] }).reportKeys, keys) &&
          (item.data as { text?: string }).text === message.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("\n"));
        if (!marker) throw new AgentWaitError("report_input_invalid");
      } else if (entry.type === "message" && message?.role === "toolResult" && message.toolName === "wait" && !message.isError &&
          listAgentWaits(this.store, { taskId: task.id }).some(wait => wait.sdkCallId === message.toolCallId)) {
        let result: import("@ruukoto/agent/agent-wait-tools.ts").AgentWaitResult;
        try { result = JSON.parse(message.content!.filter(part => part.type === "text").map(part => part.text ?? "").join("\n")) as import("@ruukoto/agent/agent-wait-tools.ts").AgentWaitResult; }
        catch { throw new AgentWaitError("report_input_invalid"); }
        if (!result || typeof result !== "object" || !Array.isArray(result.targets) || result.targets.some(target => !target || typeof target !== "object")) throw new AgentWaitError("report_input_invalid");
        if (result.reportTargets !== undefined && (result.reason !== "result" || !Array.isArray(result.reportTargets) || result.reportTargets.length > 20)) throw new AgentWaitError("report_input_invalid");
        if (result.reason === "result") for (const target of [...result.targets, ...(result.reportTargets ?? [])]) {
          if (!target || typeof target !== "object") throw new AgentWaitError("report_input_invalid");
          if (!result.reportTargets?.includes(target) && (target.reportOwnerTaskId !== task.id || typeof target.resultSummary !== "string")) continue;
          if (target.reportOwnerTaskId !== task.id || typeof target.resultSummary !== "string" ||
              (target.kind === "task" ? typeof target.taskId !== "string" : target.kind !== "workflow" || typeof target.runId !== "string" || !Number.isSafeInteger(target.terminalVersion))) throw new AgentWaitError("report_input_invalid");
          keys.push(agentReportKey(target.kind === "task" ? target : { ...target, terminalVersion: target.terminalVersion! }));
        }
      } else if (fallback.length && entry.type === "custom" && entry.customType === "ruukoto_agent_report_context") {
        const data = entry.data as { taskId?: string; text?: string; reportKeys?: string[] } | undefined;
        if (data?.taskId === task.id && typeof data.text === "string" && Array.isArray(data.reportKeys)) keys = data.reportKeys;
      } else if (fallback.length && entry.type === "message" && message?.role === "user" && !inputs.length) keys = fallback.map(report => report.key);
      if (!keys.length) continue;
      for (const key of keys) {
        const report = getAgentReport(this.store, key);
        if (!report || report.parentSessionId !== task.sessionId) throw new AgentWaitError("report_input_reference_missing");
      }
      inputs.push({ entryId: entry.id, keys: [...new Set(keys)] });
    }
    return inputs;
  }

  private bindAgentReportRequest(task: Task, messages: readonly unknown[]): { reportKeys: string[]; entryIds: string[]; selectionRecordId: string | null } {
    const entries = this.agentTaskEntries(task), prepared = this.preparedReportInputs.get(task.id);
    const inputs = this.reportInputEntries(task).filter(input => {
      const entry = entries.find(item => item.id === input.entryId)!;
      if (entry.type === "message") return messages.some(message => isDeepStrictEqual(JSON.parse(JSON.stringify(message)), entry.message));
      const data = entry.data as { text?: string } | undefined;
      return typeof data?.text === "string" && messages.some(message => {
        const value = message as { content?: unknown };
        return typeof value.content === "string" ? value.content.includes(data.text!) : Array.isArray(value.content) && value.content.some(part => part?.type === "text" && typeof part.text === "string" && part.text.includes(data.text!));
      });
    });
    if (prepared && prepared.reportKeys.some(key => !inputs.some(input => input.keys.includes(key)))) throw new AgentWaitError("report_input_missing");
    this.reportRequestInputs.set(task.id, inputs);
    return { reportKeys: [...new Set(inputs.flatMap(input => input.keys))], entryIds: inputs.map(input => input.entryId),
      selectionRecordId: this.store.listSelectionRecordsByTask(task.id).at(-1)?.id ?? null };
  }

  private acceptAgentWaitResults(task: Task): void {
    if (this.verifyAgentReportSources(task.id)) throw new AgentWaitError("source_invalid");
    const inputs = this.reportRequestInputs.get(task.id) ?? this.recoverReportRequestInputs(task);
    this.reportRequestInputs.delete(task.id);
    for (const input of inputs) for (const key of input.keys) {
      const report = getAgentReport(this.store, key);
      if (report?.status === "pending" && !report.consumption && (report.claimTaskId === task.id || report.fallbackTaskId === task.id)) consumeAgentReport(this.store, key, { taskId: task.id, entryId: input.entryId });
    }
  }

  private recoverReportRequestInputs(task: Task): { entryId: string; keys: string[] }[] {
    const entries = this.agentTaskEntries(task), candidates = this.reportInputEntries(task);
    const accepted: { entryId: string; keys: string[] }[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.type !== "custom" || entry.customType !== "ruukoto_agent_report_context") continue;
      const data = entry.data as { taskId?: string; requestBinding?: boolean; reportKeys?: string[]; entryIds?: string[]; selectionRecordId?: string } | undefined;
      if (!data?.requestBinding || data.taskId !== task.id || !Array.isArray(data.reportKeys) || !Array.isArray(data.entryIds)) continue;
      const next = entries.findIndex((item, position) => position > index && item.type === "custom" && item.customType === "ruukoto_agent_report_context" && (item.data as { requestBinding?: boolean } | undefined)?.requestBinding);
      const response = entries.slice(index + 1, next < 0 ? undefined : next).find(item => item.type === "message" &&
        (item.message as { role?: string; stopReason?: string } | undefined)?.role === "assistant" && !["error", "aborted"].includes((item.message as { stopReason: string }).stopReason));
      if (!response) continue;
      const record = this.store.listSelectionRecordsByTask(task.id).find(record => record.id === data.selectionRecordId);
      if (!record?.promptArtifactId) throw new AgentWaitError("report_input_missing");
      const artifact = this.store.getArtifact(record.promptArtifactId);
      if (!artifact) throw new AgentWaitError("report_input_missing");
      let snapshot: { context?: { messages?: unknown[] }; messages?: unknown[] };
      try { snapshot = JSON.parse(this.artifacts.read(artifact.id, 0, artifact.byteCount).toString("utf8")) as typeof snapshot; }
      catch { throw new AgentWaitError("report_input_invalid"); }
      if (!snapshot || typeof snapshot !== "object") throw new AgentWaitError("report_input_invalid");
      const messages = snapshot.messages ?? snapshot.context?.messages;
      if (!Array.isArray(messages)) throw new AgentWaitError("report_input_invalid");
      for (const input of candidates.filter(input => data.entryIds!.includes(input.entryId))) {
        const original = entries.find(item => item.id === input.entryId)!;
        const text = (original.data as { text?: string } | undefined)?.text;
        const included = original.type === "message" ? messages.some(message => isDeepStrictEqual(JSON.parse(JSON.stringify(message)), original.message)) : typeof text === "string" && JSON.stringify(messages).includes(JSON.stringify(text).slice(1, -1));
        if (!included || input.keys.some(key => !data.reportKeys!.includes(key))) throw new AgentWaitError("report_input_missing");
        accepted.push(input);
      }
    }
    return accepted;
  }

  private pendingBoundaryReports(task: Task): AgentReport[] {
    if (!ownerQuestionTaskEligible(this.store, task) || task.cancelRequested || this.store.getSession(task.sessionId)?.queueState !== "active" || task.interruptReason === "owner_interrupt") return [];
    const admitted = new Set(this.reportInputEntries(task).flatMap(input => input.keys));
    return listAgentReports(this.store, { parentSessionId: task.sessionId }).filter(report => {
      if (report.status !== "pending" || admitted.has(report.key) || report.claimTaskId && report.claimTaskId !== task.id ||
          report.fallbackState === "running" || report.fallbackState === "completed" || report.consumption?.taskId === task.id) return false;
      if (report.fallbackTaskId && this.store.getTask(report.fallbackTaskId)?.status !== "queued") return false;
      const wait = listAgentWaits(this.store, { sessionId: task.sessionId }).find(wait => wait.targets.some(target => agentReportKey(target.kind === "task" ? target : { ...target, terminalVersion: report.target.kind === "workflow" ? report.target.terminalVersion : 0 }) === report.key));
      return !wait || agentWaitTargetsReady(this.store, agentWaitGroupTargets(this.store, wait.taskId));
    });
  }

  private prepareBoundaryReports(task: Task): { reportKeys: string[]; text: string } | null {
    return this.store.withTx(() => {
      const reports = this.pendingBoundaryReports(this.store.getTask(task.id)!);
      if (!reports.length) return null;
      if (reports.some(report => !this.verifyAgentWaitTarget(report.source, report.target) || this.agentReportWorkCanceled(report))) {
        invalidateAgentReports(this.store, reports.map(report => report.key), "source_invalid");
        throw new AgentWaitError("source_invalid");
      }
      claimAgentReports(this.store, { taskId: task.id, keys: reports.map(report => report.key) });
      return { reportKeys: reports.map(report => report.key), text: "[后台报告 · 资料]\n" + reports.map(report => report.target.kind === "workflow"
        ? workflowReport(this.store, requireWorkflowRun(this.store, report.target.runId)).text
        : `子任务 ${report.target.taskId}：${this.store.getTask(report.target.taskId)!.status}\n${this.store.getTask(report.target.taskId)!.resultSummary}`).join("\n\n") };
    });
  }

  private recordClaimedAgentReport(task: Task, outcome: ChildOutcome, reports: AgentReport[]): AgentReportCompletion {
    const reply = this.readTaskReply(task.id, 0, 64 * 1024);
    const problem = this.verifyAgentReportSources(task.id);
    if (outcome !== "completed" || problem || !reply) return { status: "undelivered", reason: problem ?? "parent_report_missing" };
    const reportInput = reports.some(report => report.claimTaskId === task.id) ? this.agentReportInput(task, reports) : null;
    if (reports.some(report => report.claimTaskId === task.id && report.consumption && report.consumption.taskId !== task.id) && !reportInput) return { status: "undelivered", reason: "report_input_missing" };
    return { status: "reported", entryId: reply.entryId, ...(reportInput ? { reportInput } : {}) };
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
        accessMode: source.accessMode, grantedPaths: source.grantedPaths,
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
    if (this.mcpSourceBlocked(task)) throw new WorkflowError("effect_unknown");
    const digest = workflowLaunchDigest(input), old = this.workflowReplay(task.sessionId, input.requestKey, digest);
    if (old) return this.getWorkflowDetail(old.id);
    if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
    this.workflowSource(task.id);
    const script = await this.workflowScript(input);
    return this.getWorkflowDetail(this.workflows.start({ ...input, displayName: input.name ?? input.title, sourceTaskId: task.id, script, requestDigest: digest }).id);
  }

  /** 可信拥有者入口：短期发起任务和运行同事务登记，不调用模型或借用活动聊天。 */
  async startWorkflowOwner(input: WorkflowLaunch & { sessionId: string; requestKey: string }) {
    const digest = workflowLaunchDigest(input), old = this.workflowReplay(input.sessionId, input.requestKey, digest);
    if (old) {
      return this.getWorkflowDetail(old.id);
    }
    if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
    const session = this.store.getSession(input.sessionId), identity = this.store.getSessionIdentity(input.sessionId);
    if (!session || identity?.kind !== "dev" || session.defaultAccessMode === "plan") throw new WorkflowError("source_forbidden");
    const selection = session.modelSelection ?? this.defaultSelection;
    const script = await this.workflowScript(input);
    let check: Awaited<ReturnType<RuntimeModels["resolveSelection"]>>;
    try { check = await this.models.resolveSelection(selection); }
    catch (cause) { if (!(cause instanceof ModelSelectionError)) throw cause; throw new WorkflowError(cause.code, { cause }); }
    const mode = session.defaultAccessMode;
    try { this.launcherFor(mode); }
    catch (cause) { if (!(cause instanceof ExecutionError)) throw cause; throw new WorkflowError(cause.code, { cause }); }
    const run = this.store.withTx(() => {
      const raced = this.workflowReplay(session.id, input.requestKey, digest);
      if (raced) return raced;
      if (this.stopping || !this.workflows) throw new WorkflowError("runtime_unavailable");
      this.assertNoSessionCompaction(session.id);
      try { check(); }
      catch (cause) { if (!(cause instanceof ModelSelectionError)) throw cause; throw new WorkflowError(cause.code, { cause }); }
      const current = this.store.getSession(session.id)!;
      if (current.modelSelectionVersion !== session.modelSelectionVersion || current.defaultAccessModeVersion !== session.defaultAccessModeVersion) throw new WorkflowError("source_changed");
      let stat: fs.Stats;
      try { stat = fs.statSync(current.cwdReal); }
      catch (cause) { throw new WorkflowError("source_invalid", { cause }); }
      if (stat.dev !== current.cwdDev || stat.ino !== current.cwdIno || fs.realpathSync(current.cwdReal) !== current.cwdReal) throw new WorkflowError("source_invalid");
      const queued = this.store.insertQueuedTask({ sessionId: session.id, requestId: `workflow-start:${input.requestKey}`, input: workflowJson({ ...input, script: undefined, scriptDigest: workflowDefinitionDigest(script) }),
        modelSelection: selection, accessMode: mode, submissionDigest: digest });
      if (queued.duplicate) throw new WorkflowError("request_conflict");
      this.store.transitionTask(queued.task.id, ["queued"], "running", { startedAt: new Date().toISOString() });
      const accepted = this.workflows.register({ ...input, displayName: input.name ?? input.title, sourceTaskId: queued.task.id, script, requestDigest: digest }, taskId => this.workflowSource(taskId));
      this.store.setTaskResult(queued.task.id, `已启动工作流 ${accepted.id}`, JSON.stringify({ workflowRunId: accepted.id, hostStart: true }));
      this.store.endTask(queued.task.id, ["running"], "completed");
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
      if (run.source.codeScheduledRunId) bindCodeScheduleTask(this.store, { runId: run.source.codeScheduledRunId, taskId: task.id, sourceTaskId: run.source.taskId });
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


  private requireCodeScheduler(): CodeScheduler {
    if (!this.codeScheduler) throw new RuntimeApiError("unavailable", "当前产品不提供 Code 定时计划。");
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，请稍后核实原计划操作。");
    return this.codeScheduler;
  }
  listCodeSchedules(input: { offset?: number; limit?: number; scope?: "current" | "history" } = {}) { return this.requireCodeScheduler().list(input); }
  getCodeSchedule(input: { planId: string; runOffset?: number }) { return this.requireCodeScheduler().get(input); }
  saveCodeSchedule(input: { requestId: string; planId?: string; expectedVersion?: number; config: CodeScheduleConfig }) { return this.requireCodeScheduler().save(input); }
  controlCodeSchedule(input: { requestId: string; planId: string; expectedVersion: number; control: "pause" | "resume" | "cancel"; acknowledgeRunId?: string; expectedRunVersion?: number }) { return this.requireCodeScheduler().control(input); }
  findCodeScheduleReceipt(input: { requestId: string }) { return this.requireCodeScheduler().find(input); }

  private codeScheduledRunOutcome(run: CodeScheduleRun): import("./code-scheduler.ts").CodeScheduleOutcome {
    const tasks = listCodeScheduleRunTasks(this.store, run.id), ids = new Set(tasks.map(task => task.id));
    const active = tasks.filter(task => !isTerminalTaskStatus(task.status) && !isAgentReportParked(this.store, task.id));
    const background = listActiveBackgroundProcesses(this.store).filter(process => ids.has(process.taskId));
    const workflows = listWorkflowRuns(this.store).filter(workflow => workflow.source.codeScheduledRunId === run.id);
    const occupied = this.store.listAllOccupancy().some(held => held.taskId ? ids.has(held.taskId) : background.some(process => process.id === held.processId));
    const stopUnverified = (occupied && active.length === 0 && background.every(process => process.state !== "running")) || background.some(process => process.state === "stop_unverified") ||
      tasks.some(task => { const host = workCopyHostFor(task); return host && host.units.length > 0 && host.stopVerified !== true; }) ||
      workflows.some(workflow => workflowTerminal(workflow.status) && ((workflow.scriptUnits.length > 0 && workflow.scriptStopVerified !== true) || listWorkflowExecutions(this.store, workflow.id).some(execution => execution.status !== "queued" && execution.stopVerified !== true)));
    const unknown = tasks.some(task => task.effectUnknown || this.store.listToolOpsByTask(task.id).some(op => op.effectUnknown));
    if (stopUnverified) return { reason: "stop_unverified", recovery: "stop_unverified", canAcknowledge: false };
    if (unknown) return { reason: "effect_unknown", recovery: "effect_unknown", canAcknowledge: active.length === 0 && !occupied && background.length === 0 && workflows.every(workflow => workflowTerminal(workflow.status)) };
    if (active.length) return { reason: active.some(task => task.status === "awaiting_confirmation") ? "awaiting_confirmation" : active.some(task => task.status === "queued" && this.store.getSession(task.sessionId)?.queueState === "paused") ? "queue_paused" : active.some(task => task.status === "queued") ? "waiting_workspace" : "running" };
    if (background.length || occupied) return { reason: "background_running" };
    if (workflows.some(workflow => !workflowTerminal(workflow.status))) return { reason: "awaiting_workflow" };
    if (tasks.some(task => !getWorkflowExecution(this.store, task.id) && !workCopyHostFor(task) && task.resultSummary === null)) return { reason: "awaiting_result" };
    let deliveryFailure: string | null = null;
    if (!run.cancelRequested) {
      if (tasks.some(task => listOwnerQuestions(this.store, task.sessionId, 100).some(question => question.taskId === task.id && question.status === "pending"))) return { reason: "awaiting_answer" };
      for (const child of tasks.filter(task => task.subAgentId && !getWorkflowExecution(this.store, task.id))) {
        const problem = this.verifySubAgentSource(child, true);
        if (problem) { deliveryFailure ??= problem; continue; }
        if (child.workId && this.store.getWorkDelegation(child.workId)?.canceledAt) continue;
        if (!child.resultDeliveredAt && !this.store.findTaskByRequest(run.sessionId, `wake:${child.id}`) && !["reported", "undelivered"].includes(getAgentReport(this.store, agentReportKey({ kind: "task", taskId: child.id }))?.status ?? "")) return { reason: "awaiting_report" };
      }
      for (const report of listAgentReports(this.store).filter(report => report.source.codeScheduledRunId === run.id && report.status === "pending")) {
        if (!this.verifyAgentWaitTarget(report.source, report.target, true) || this.agentReportWorkCanceled(report)) deliveryFailure ??= "report_source_invalid";
        else return { reason: "awaiting_report" };
      }
      for (const message of this.store.listPendingSubAgentMessages(run.sessionId)) {
        const sender = this.store.getTask(message.fromTaskId), problem = sender ? this.verifySubAgentSource(sender, true) : "subagent_source_invalid";
        if (problem) deliveryFailure ??= problem;
        else return { reason: "awaiting_report" };
      }
      for (const workflow of workflows.filter(workflow => !workflow.delivery || !["reported", "undelivered"].includes(workflow.delivery.status))) {
        if (!this.verifyWorkflowReport(workflow, true)) deliveryFailure ??= "workflow_source_invalid";
        else return { reason: "awaiting_report" };
      }
    }
    if (run.cancelRequested) return { status: "canceled", reason: "schedule_canceled" };
    const failed = tasks.find(task => task.status !== "completed" && !isAgentReportParked(this.store, task.id));
    const workflowFailed = workflows.some(workflow => workflow.status !== "succeeded" || workflow.delivery?.status === "undelivered");
    return { status: failed?.status === "interrupted" ? "interrupted" : failed || workflowFailed || deliveryFailure ? "failed" : "completed", reason: failed?.errorMessage ?? deliveryFailure ?? (workflowFailed ? "workflow_failed" : null) };
  }

  private async cancelCodeScheduledRun(run: CodeScheduleRun): Promise<void> {
    for (const workflow of listWorkflowRuns(this.store).filter(item => item.source.codeScheduledRunId === run.id && !workflowTerminal(item.status))) {
      if (this.workflows) await this.workflows.control(workflow.id, `code-schedule-cancel:${run.id}`, workflow.version, { action: "cancel" });
      else this.store.withTx(() => controlWorkflow(this.store, workflow.id, `code-schedule-cancel:${run.id}`, workflow.version, { action: "cancel" }));
    }
    const tasks = listCodeScheduleRunTasks(this.store, run.id);
    this.store.withTx(() => {
      for (const task of tasks) {
        for (const question of listOwnerQuestions(this.store, task.sessionId, 100).filter(question => question.taskId === task.id && question.status === "pending")) cancelOwnerQuestion(this.store, { questionId: question.id, sessionId: question.sessionId, version: question.version, status: "stale" });
        if (task.status === "queued") this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: "schedule_canceled" });
        else if (!isTerminalTaskStatus(task.status)) this.store.setCancelRequested(task.id, true);
      }
      invalidateAgentReports(this.store, listAgentReports(this.store).filter(report => report.source.codeScheduledRunId === run.id && report.status === "pending").map(report => report.key), "schedule_canceled");
    });
    for (const process of listActiveBackgroundProcesses(this.store).filter(process => tasks.some(task => task.id === process.taskId))) this.backgroundProcesses.requestStop(process.id, "schedule_canceled");
    for (const task of tasks) if (!isTerminalTaskStatus(this.store.getTask(task.id)!.status) && !getWorkflowExecution(this.store, task.id)) await this.cancelTask(task.id, { reason: "schedule_canceled" });
    await this.subagents!.flushPendingMessages(run.sessionId);
  }

  // ---------- 调度器与通知（issue 03） ----------

  /** 来源核实（issue 03/05）：通知与委派的来源校验共用；与调度器生命周期无关。 */
  private initSources(): void {
    this.sources = createSourceResolver({
      store: this.store,
      access: this.access,
      artifacts: this.artifacts,
    });
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
            const sourceProblem = this.verifyAgentReportSources(task.id);
            if (sourceProblem) invalidateAgentReports(store, claims.map(report => report.key), "source_invalid");
            else {
              try { this.acceptAgentWaitResults(task); }
              catch (error) {
                if (!(error instanceof AgentWaitError) && !(error instanceof HistoryReadError)) throw error;
                invalidateAgentReports(store, claims.map(report => report.key), "agent_report_input_invalid");
              }
            }
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

      // 侧聊排队任务（含接纳后未启动的窗口）：重启一律中断，不暂停会话队列、
      // 不等待 /resume-queue，也不重放输入；新提交按正常校验重新接纳
      for (const task of store.listTasksByStatus(["queued"])) {
        if (store.sideParentId(task.sessionId) === null) continue;
        if (store.endTask(task.id, ["queued"], "interrupted", { interruptReason: "backend_restart", endedAt: new Date().toISOString() })) {
          interruptedTaskIds.push(task.id);
        }
      }

      // 2. 遗留占用：旧执行单元状态无法确认时保留占用并暂停会话，
      //    由拥有者核实后 resume_queue 释放；user scope 独立于后台服务，
      //    backend 的 KillMode 不能证明该 scope 与后代已退出。
      // Note: See .agents/notes/implemented/architecture/2026-10-17-native-linux-execution-identity.md
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
      const sessionsDir = sessionsDirFor(this.config.profile.dataDir);
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

      // 5. 引导路由核实（coding-message-control）：目标已被本次恢复中断，
      //    按权威 JSONL 裁决——已落盘的输入归原任务 joined，未落的回普通队首。
      for (const guidance of store.listPendingGuidance()) {
        const file = store.getSession(guidance.sessionId)?.sessionFile;
        const entry = file && fs.existsSync(file)
          ? parseSessionFile(file).find(e => e.type === "message" && (e.message as { ruukotoSourceTaskId?: string } | undefined)?.ruukotoSourceTaskId === guidance.sourceTaskId)
          : undefined;
        if (entry) store.recordTaskGuidanceEntry(guidance.sourceTaskId, guidance.targetTaskId, entry.id);
        else store.fallbackTaskGuidance(guidance.targetTaskId);
      }

      store.appendEvent(
        { type: "backend.recovered", interruptedTaskIds, pausedSessionIds },
      );
    });
  }


  // ---------- 项目与会话 ----------

  createProject(name: string, createRequestId?: string): Project {
    this.assertNotManagedCreation(createRequestId);
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
    this.assertNotManagedCreation(input.createRequestId);
    if (!input.projectId && !input.projectName?.trim()) {
      throw new RuntimeApiError("invalid_params", "project_id 或 project_name 必填其一");
    }
    if (input.projectId) {
      const project = this.store.getProject(input.projectId);
      if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    }
    const identity = await this.resolveWorkspaceDir(input.cwd);
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

  private assertNotManagedCreation(requestId?: string): void {
    if (requestId && getManagedWorkspaceRequest(this.store, requestId)) throw new RuntimeApiError("request_conflict", "请求键已用于自动工作区创建");
  }

  // Note: See .agents/notes/implemented/feature/2026-11-07-managed-coding-workspaces.md
  async createManagedSession(input: { createRequestId: string; mode?: SessionDefaultMode; modelSelection?: ModelSelection }): Promise<{ session: Session; project: Project }> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.createRequestId)) throw new RuntimeApiError("invalid_params", "工作区创建请求键无效。");
    if (input.mode !== undefined && !isSessionDefaultMode(input.mode)) throw new RuntimeApiError("invalid_params", "会话默认模式无效");
    const explicitModel = input.modelSelection === undefined ? null : parseModelSelection(input.modelSelection);
    const paramsDigest = createHash("sha256").update(JSON.stringify([input.mode ?? null, explicitModel])).digest("hex");
    let request = getManagedWorkspaceRequest(this.store, input.createRequestId);
    if (request && request.paramsDigest !== paramsDigest) throw new RuntimeApiError("request_conflict", "工作区创建请求键已用于不同参数。");
    if (!request) {
      const settings = await this.sessionCreationSettings(input);
      request = this.store.withTx(() => {
        const existing = getManagedWorkspaceRequest(this.store, input.createRequestId);
        if (existing) {
          if (existing.paramsDigest !== paramsDigest) throw new RuntimeApiError("request_conflict", "工作区创建请求键已用于不同参数。");
          return existing;
        }
        if (this.store.findProjectByCreateRequestId(input.createRequestId) || this.store.findSessionByCreateRequestId(input.createRequestId) ||
            getBranchRequest(this.store, input.createRequestId) || getSideChatByRequest(this.store, input.createRequestId)) {
          throw new RuntimeApiError("request_conflict", "请求键已用于其他项目或会话创建。");
        }
        settings.check?.();
        const projectId = randomId("proj");
        const root = path.join(this.config.profile.workspaceDir, projectId);
        const reserved: ManagedWorkspaceRequest = { requestId: input.createRequestId, paramsDigest, projectId, root, parent: null, stage: null,
          modelSelection: { ...settings.modelSelection }, mode: settings.mode, sessionId: null, error: null };
        saveManagedWorkspaceRequest(this.store, reserved);
        return reserved;
      });
    }
    return this.publishManagedSession(request);
  }

  findManagedSession(requestId: string): { status: "not_found" | "prepared" | "published"; session: Session | null; project: Project | null; error: string | null } {
    const request = getManagedWorkspaceRequest(this.store, requestId);
    if (!request) return { status: "not_found", session: null, project: null, error: null };
    this.validateManagedWorkspaceRequest(request);
    if (!request.sessionId) return { status: "prepared", session: null, project: null, error: request.error };
    const session = this.store.getSession(request.sessionId), project = this.store.getProject(request.projectId);
    if (!session || !project?.rootDir || !project.managed || session.projectId !== project.id || session.cwdReal !== request.root || session.cwdIno !== project.rootDir.ino || session.createRequestId !== request.requestId) throw new RuntimeApiError("managed_workspace_corrupt", "已创建的工作区或会话记录缺失，请恢复原数据。");
    verifyManagedWorkspace(request, project.rootDir);
    return { status: "published", session, project, error: null };
  }

  findCreatedSession(requestId: string): Session | null {
    return this.store.findSessionByCreateRequestId(requestId);
  }

  private publishManagedSession(request: ManagedWorkspaceRequest): { session: Session; project: Project } {
    this.validateManagedWorkspaceRequest(request);
    if (request.sessionId) {
      const result = this.findManagedSession(request.requestId);
      return { session: result.session!, project: result.project! };
    }
    try {
      const identity = prepareManagedWorkspace(this.store, request);
      return this.store.withTx(() => {
        let name = "No workspace";
        for (let n = 2; this.store.findProjectByName(name); n++) name = `No workspace (${n})`;
        const project = this.store.createProject(name, request.requestId, identity, { id: request.projectId });
        const session = this.store.createSession({ projectId: project.id, kind: "dev", cwd: identity.cwd, cwdReal: identity.cwdReal,
          cwdDev: identity.dev, cwdIno: identity.ino, piSessionId: randomUUID(), confirmTools: [], createRequestId: request.requestId,
          modelSelection: request.modelSelection, defaultAccessMode: request.mode, managedWorkspace: true });
        saveManagedWorkspaceRequest(this.store, { ...request, sessionId: session.id, error: null });
        return { session, project };
      });
    } catch (error) {
      const committed = getManagedWorkspaceRequest(this.store, request.requestId);
      if (committed?.sessionId) {
        const result = this.findManagedSession(request.requestId);
        return { session: result.session!, project: result.project! };
      }
      const code = error instanceof RuntimeApiError || error instanceof StoreConflictError ? error.code : "managed_prepare_failed";
      this.store.withTx(() => saveManagedWorkspaceRequest(this.store, { ...(committed ?? request), error: code }));
      if (error instanceof RuntimeApiError) throw error;
      if (error instanceof StoreConflictError) throw new RuntimeApiError(error.code, error.message);
      process.stderr.write(`[ruukoto:workspace] Creation ${request.requestId} remains prepared: ${error instanceof Error ? error.message : String(error)}\n`);
      throw new RuntimeApiError("managed_prepare_failed", "工作区尚未创建完成；请按原请求核实或重试。");
    }
  }

  private validateManagedWorkspaceRequest(request: ManagedWorkspaceRequest): void {
    const parent = this.config.profile.workspaceDir;
    if (request.root !== path.join(parent, request.projectId) || request.parent !== null && request.parent.cwdReal !== parent ||
        request.stage !== null && (path.dirname(request.stage.cwdReal) !== parent || !path.basename(request.stage.cwdReal).startsWith(`.${request.projectId}.prepare-`))) {
      throw new RuntimeApiError("managed_workspace_corrupt", "工作区创建记录与当前实例不符，请保留原数据并核实记录。");
    }
  }

  private recoverManagedSessions(): void {
    for (const requestId of listManagedWorkspaceRequestIds(this.store)) {
      try {
        const request = getManagedWorkspaceRequest(this.store, requestId)!;
        if (request.sessionId === null) this.publishManagedSession(request);
      } catch (error) { process.stderr.write(`[ruukoto:workspace] Creation ${requestId} requires recovery: ${error instanceof RuntimeApiError ? error.code : "store_failed"}\n`); }
    }
  }

  private branchDeps(): BranchSessionDeps {
    return { store: this.store, access: this.access, sessionsDir: sessionsDirFor(this.config.profile.dataDir),
      validate: async (session) => {
        if (this.store.getSessionIdentity(session.id)?.kind !== "dev") throw new RuntimeApiError("invalid_params", "只有普通开发会话可以建立分支");
        const workspace = this.store.getProject(session.projectId);
        if (!workspace?.rootDir) throw new RuntimeApiError("invalid_params", "旧会话尚未映射到工作区，请先完成工作区映射");
        try {
          await verifyDirIdentity({ cwd: session.cwd, cwdReal: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno });
          await verifyDirIdentity(workspace.rootDir);
        } catch (error) {
          if (error instanceof DirIdentityError) throw new RuntimeApiError("cwd_changed", "来源会话或工作区目录已失效或被替换，请核实目录后再分支");
          throw error;
        }
        const current = await this.resolveWorkspaceDir(session.cwd);
        if (!sameDirIdentity({ cwd: session.cwd, cwdReal: session.cwdReal, dev: session.cwdDev, ino: session.cwdIno }, current)) {
          throw new RuntimeApiError("cwd_changed", "来源目录入口已指向其他目录，请核实后再分支");
        }
        const relative = path.relative(workspace.rootDir.cwdReal, session.cwdReal);
        if ((relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) && !sameDirIdentity(workspace.rootDir, current)) throw new RuntimeApiError("invalid_params", "会话目录已不在所属工作区范围");
      } };
  }

  async branchSession(input: { sessionId: string; name?: string; taskId?: string; requestId: string }): Promise<Session> {
    this.assertNotManagedCreation(input.requestId);
    this.assertCodeScheduleSessionMutable(input.sessionId);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝会话分支");
    // Do not snapshot pending recalls: incomplete omissions must not leak into branch copies.
    this.messageRecall.assertNoOpenRecall(input.sessionId);
    return branchSession(this.branchDeps(), input);
  }

  findBranchSession(requestId: string) {
    const request = getBranchRequest(this.store, requestId);
    return { status: request?.status ?? "not_found", session: request?.status === "published" ? this.store.getSession(request.session.id) : null, error: request?.error ?? null };
  }

  private sideDeps(): SideChatDeps {
    return this.branchDeps();
  }

  /** 打开侧聊（创建或重开）：父会话唯一绑定，首次打开冻结安全快照。 */
  async openSideChat(input: { sessionId: string; requestId: string }): Promise<Session> {
    this.assertNotManagedCreation(input.requestId);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝打开侧聊");
    // Do not snapshot pending recalls: incomplete omissions must not leak into side-chat copies.
    this.messageRecall.assertNoOpenRecall(input.sessionId);
    return openSideChat(this.sideDeps(), input);
  }

  /** 侧聊请求键核实（应答丢失后按原键查询；published 返回会话，其余回执给出状态与原因）。 */
  findSideChat(requestId: string) {
    const binding = getSideChatByRequest(this.store, requestId);
    return { status: binding?.status ?? "not_found", session: binding?.status === "published" ? this.store.getSession(binding.sideSessionId) : null, parentSessionId: binding?.parentSessionId ?? null, error: binding?.error ?? null };
  }

  /** 侧聊持久绑定清单（快照恢复与列表排除共用同一事实）。 */
  sideChatBindings(): Array<{ parentSessionId: string; sideSessionId: string }> {
    // 只下发已发布绑定：prepared/failed 没有可用侧聊会话，客户端须回退 open_side_chat 完成或核实
    return listSideChats(this.store).filter(binding => binding.status === "published").map(binding => ({ parentSessionId: binding.parentSessionId, sideSessionId: binding.sideSessionId }));
  }

  /**
   * 侧聊新提交：只收纯文本，无附件/继续/引导/编排字段；模型固定父会话
   * 受理时选择；同一时刻最多接纳一个未终结任务（并发按入队事务仲裁）。
   */
  async submitSideChat(input: { sessionId: string; requestId: string; input: string }): Promise<TaskView> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    const identity = this.store.getSessionIdentity(session.id);
    if (identity?.kind !== "side") throw new RuntimeApiError("invalid_state", "该会话不是侧聊；请用 /side 打开侧聊后发送");
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    if (typeof input.input !== "string" || !input.input.trim()) throw new RuntimeApiError("invalid_params", "请输入消息。");
    const parent = this.store.getSession(identity.parentSessionId);
    if (!parent) throw new RuntimeApiError("history_corrupt", "侧聊的父会话绑定缺失，请核实后台状态");
    const selection = parseModelSelection(parent.modelSelection ?? this.defaultSelection);
    const submission = { input: input.input, modelSelection: selection, side: true };
    const submissionDigest = `request-v2:${createHash("sha256").update(JSON.stringify(submission)).digest("hex")}`;
    const existing = this.store.findMatchingSubmission({ sessionId: session.id, requestId: input.requestId, submissionDigest });
    if (existing) return this.taskView(existing);
    this.assertNoSessionCompaction(session.id);
    const check = await this.models.resolveSelection(selection);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    let task: Task;
    let duplicate: boolean;
    try {
      ({ task, duplicate } = this.store.withTx(() => {
        const raced = this.store.findMatchingSubmission({ sessionId: session.id, requestId: input.requestId, submissionDigest });
        if (raced) return { task: raced, duplicate: true };
        this.assertNoSessionCompaction(session.id);
        check();
        if (this.store.listTasksBySession(session.id).some(item => ACTIVE_TASK_STATUSES.includes(item.status))) {
          throw new StoreConflictError("侧聊正在生成中，请等待本轮结束后发送；输入已保留", "side_busy");
        }
        // 侧聊不得请求目录占用；发现占用即数据异常，按异常报错不自动释放
        if (this.store.listAllOccupancy().some(held => held.taskId !== null && this.store.getTask(held.taskId)?.sessionId === session.id)) {
          throw new StoreConflictError("侧聊存在不应有的执行占用，请核实后台状态", "side_occupancy_invalid");
        }
        return this.store.insertQueuedTask({
          sessionId: session.id,
          requestId: input.requestId,
          input: input.input,
          accessMode: "confirm",
          planMode: false,
          grantedPaths: [],
          modelSelection: selection,
          submissionDigest,
          parentTaskId: null,
          sourcePermissionVersion: null,
          deadline: null,
        });
      }));
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    if (!duplicate) this.kick(session.id);
    return this.taskView(task);
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
    // Compaction must wait for recall so its point can be verified against the effective prefix.
    this.messageRecall.assertNoOpenRecall(input.sessionId);
    const session = this.getSession(input.sessionId);
    this.assertCodeScheduleSessionMutable(session.id);
    if (this.store.getSessionIdentity(session.id)?.kind !== "dev") throw new RuntimeApiError("invalid_state", "只有普通开发会话可以手动压缩上下文");
    this.assertNoSessionCompaction(session.id);
    if (this.loopActive.has(session.id) || this.store.listTasksBySession(session.id).some(task => ACTIVE_TASK_STATUSES.includes(task.status))) {
      throw new RuntimeApiError("session_busy", "此会话有排队、启动中或活动任务，请等待完成或先停止任务");
    }
    const modelSelection = { ...(session.modelSelection ?? this.defaultSelection) };
    let summaryModel: SummaryModel;
    try { summaryModel = loadSummaryModel(this.config.profile.agentDir) ?? { provider: modelSelection.provider, modelId: modelSelection.modelId }; }
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
    this.assertNotManagedCreation(input.createRequestId);
    if (input.createRequestId && getBranchRequest(this.store, input.createRequestId)) throw new RuntimeApiError("request_conflict", "请求键已用于会话分支");
    const identity = await this.resolveWorkspaceDir(input.cwd);
    const settings = await this.sessionCreationSettings(input);
    try {
      return this.store.withTx(() => {
        this.assertNotManagedCreation(input.createRequestId);
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
          if (!project.rootDir || !sameDirIdentity(project.rootDir, identity)) {
            throw new RuntimeApiError("invalid_params", "项目未绑定该工作区目录。");
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

  private resolveWorkspaceDir(cwd: string): Promise<DirIdentity> {
    return resolveDirIdentity(cwd).catch((err: DirIdentityError) =>
      Promise.reject(new RuntimeApiError("invalid_params", err.message)),
    );
  }

  listWorkspaceFiles(input: { workspaceId: string; path?: string; cursor?: string }) {
    const root = this.store.getProject(input.workspaceId)?.rootDir;
    if (!root) throw new RuntimeApiError("workspace_not_found", "工作区不存在或尚未登记目录，请重新选择工作区。");
    return listWorkspaceFiles(input.workspaceId, root, input.path ?? "", input.cursor);
  }

  readWorkspaceFile(input: { workspaceId: string; path: string; offset?: number; length?: number; version?: string }) {
    const root = this.store.getProject(input.workspaceId)?.rootDir;
    if (!root) throw new RuntimeApiError("workspace_not_found", "工作区不存在或尚未登记目录，请重新选择工作区。");
    return readWorkspaceFile(input.workspaceId, root, input.path, input);
  }

  readWorkspaceGit(input: { workspaceId: string; cursor?: string }) {
    const root = this.store.getProject(input.workspaceId)?.rootDir;
    if (!root) throw new RuntimeApiError("workspace_not_found", "工作区不存在或尚未登记目录，请重新选择工作区。");
    return readWorkspaceGit(input.workspaceId, root, input.cursor);
  }



  getSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", "会话不存在");
    return this.codeSessionView(session);
  }

  private codeSessionView(session: Session): Session {
    const run = getCodeScheduleRunForSession(this.store, session.id);
    return run ? { ...session, codeScheduleRunId: run.id, codeScheduleActive: run.closedAt === null } : session;
  }

  private assertCodeScheduleSessionMutable(sessionId: string): void {
    if (getOpenCodeScheduleRunForSession(this.store, sessionId)) throw new RuntimeApiError("schedule_session_managed", "本轮由 Scheduled 管理；请在计划页修改未来配置，当前会话可处理审批、问题与停止。");
  }

  private assertCodeScheduleSelection(run: CodeScheduleRun, input: { modelSelection?: ModelSelection; accessMode?: SessionDefaultMode; grantedPaths?: GrantedPath[] }): void {
    if ((input.modelSelection && !isDeepStrictEqual(input.modelSelection, run.snapshot.modelSelection)) || (input.accessMode !== undefined && input.accessMode !== run.snapshot.permission) || input.grantedPaths?.length) throw new RuntimeApiError("schedule_configuration_fixed", "本轮使用计划接纳时的模型和权限；刷新运行会话后继续。");
  }

  // Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md
  private workspaceChats(): Session[] {
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
        return session && this.store.sideParentId(summary.sessionId) === null ? [{ ...summary, workspaceId: session.projectId, archivedAt: session.archivedAt }] : [];
      });
    }
    const id = input.workspaceId ?? input.projectId;
    if (!id) throw new RuntimeApiError("invalid_params", "project_id 或 workspace_id 必填其一");
    if (!this.store.getProject(id)) throw new RuntimeApiError("not_found", "项目不存在");
    const summaries = this.store.listSessionSummaries(id);
    // 侧聊不属于普通会话清单；拥有者经侧聊专用入口访问
    return summaries.filter(summary => this.store.sideParentId(summary.sessionId) === null);
  }

  async setSessionModel(input: { sessionId: string; modelSelection: ModelSelection; expectedVersion: number }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    this.getSession(input.sessionId);
    this.assertCodeScheduleSessionMutable(input.sessionId);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new RuntimeApiError("invalid_params", "expected_version 必须为非负整数");
    const selection = parseModelSelection(input.modelSelection);
    // 配置应用期间不得为受影响 provider 钉入新引用（与 §4 删除核实同一同步段语义）
    const check = await this.models.resolveSelection(selection);
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止");
    return this.store.withTx(() => {
      this.assertCodeScheduleSessionMutable(input.sessionId);
      check();
      return this.store.setSessionModel(input.sessionId, selection, input.expectedVersion);
    });
  }

  /** 秘密脱敏：配置文件当前含有的 API key、OAuth token、headers 值不得出现在错误文本里。 */
  private scrubSecrets(text: string): string {
    let out = text;
    for (const secret of configSecrets(this.config.profile.agentDir)) out = out.split(secret).join("***");
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
    let worktreesRoot = path.join(this.config.profile.workCopyDir, "worktrees");
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
    this.assertCodeScheduleSessionMutable(input.session_id);
    if (!session || this.store.getSessionIdentity(session.id)?.kind !== "dev") throw new RuntimeApiError("attachment_scope", "请选择用户会话后附加文件。");
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
    modelSelection: ModelSelection;
    /**
     * 编排字段（issue 01）：仅后台编排器经窄接口传递（子任务/事件任务/唤醒）。
     * 控制面 ops 不接受这些字段，模型与客户端无法设置。
     */
    parentTaskId?: string | null;
    sourcePermissionVersion?: number | null;
    deadline?: string | null;
    /** 仅宿主最终送达使用；与汇总任务在同一事务建立可信绑定。 */
    workflowRunId?: string;
    reportKey?: string;
    reportKeys?: string[];
    /**
     * 显式引导（coding-message-control）：把本输入接入会话当前任务的下一边界；
     * 错过目标按普通队列输入回到队首。仅普通开发会话的拥有者新输入可用。
     */
    guidance?: boolean;
    /**
     * MyGo 桌面浏览器来源（mygo-agent-browser）：仅控制面按已登记连接写定，
     * 模型与客户端参数不能自称；与任务同事务持久化，连接断开绑定即失效。
     */
    browser?: { connectionId: string };
  }, internal = false): Promise<TaskView> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    if (typeof input.input !== "string" || (!input.input.trim() && !input.attachments?.length)) throw new RuntimeApiError("invalid_params", "请输入消息或选择附件。");
    if (input.workflowRunId && !internal) throw new RuntimeApiError("invalid_params", "工作流汇总只能由宿主登记");
    if (input.reportKey && !internal) throw new RuntimeApiError("invalid_params", "结果补报只能由宿主登记");
    if (input.reportKeys && !internal) throw new RuntimeApiError("invalid_params", "结果补报只能由宿主登记");
    if (input.guidance && (internal || this.store.getSessionIdentity(session.id)?.kind !== "dev")) {
      throw new RuntimeApiError("invalid_params", "仅普通开发会话的拥有者新输入可转为引导");
    }
    const identity = this.store.getSessionIdentity(session.id)!;
    // SubAgent 子会话（agent-direction issue 11）：不是普通用户对话入口；任务
    // 只能经集中委派登记（直接写库，不经本入口），控制面不能把它当作用户会话提交
    if (identity.kind === "subagent") throw new RuntimeApiError("invalid_state", "该会话是 SubAgent 的独立工作会话，不能提交用户对话或另行继续");
    // 侧聊走专用提交：客户端给的模型/模式等参数对侧聊无意义，不接受普通提交形状
    if (identity.kind === "side") {
      throw new RuntimeApiError("invalid_state", "该会话是侧聊，请使用侧聊专用提交入口");
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
      resumesTaskId: null, modelSelection: selection,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
    const submission = {
      ...digestBase,
      parentTaskId: input.parentTaskId ?? null, sourcePermissionVersion: input.sourcePermissionVersion ?? null, deadline,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.reportKey ? { reportKey: input.reportKey } : {}),
      ...(input.reportKeys ? { reportKeys: input.reportKeys } : {}),
      ...(input.guidance ? { guidance: true } : {}),
    };
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const submissionDigest = `request-v2:${digest(submission)}`;
    const existing = this.store.findMatchingSubmission({ sessionId: input.sessionId, requestId: input.requestId, submissionDigest });
    if (existing) return this.taskView(existing);
    const codeRun = getOpenCodeScheduleRunForSession(this.store, session.id);
    const codeSource = input.parentTaskId ? getCodeScheduledTaskSource(this.store, input.parentTaskId) : null;
    if (codeRun) {
      if (!internal || !codeSource || codeSource.runId !== codeRun.id) throw new RuntimeApiError("schedule_session_managed", "本轮由 Scheduled 管理；请从问题卡片回答，或在 Scheduled 中处理本轮。");
      this.assertCodeScheduleSelection(codeRun, input);
      if (["effect_unknown", "stop_unverified"].includes(codeRun.reason ?? "") || listCodeScheduleRunTasks(this.store, codeRun.id).some(task => task.effectUnknown)) throw new RuntimeApiError("schedule_recovery_required", "本轮结果或停止尚未核实；请在 Scheduled 查看记录并完成恢复。");
    } else if (codeSource) throw new RuntimeApiError("schedule_source_invalid", "定时任务的运行会话不匹配，未提交任务。");
    const attachments = this.attachments.prepare(session.id, input.attachments ?? []);
    this.assertNoSessionCompaction(input.sessionId);
    // 模型配置应用门闩（issue 21 §4）：幂等重试放行（不新建任务），
    // 受影响 provider 的新提交在应用期间拒绝进入队列
    const check = await this.models.resolveSelection(selection, attachments.some(item => item.metadata.mimeType !== null));
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
        if (codeSource) getCodeScheduledTaskSource(this.store, codeSource.taskId);
        else this.assertCodeScheduleSessionMutable(session.id);
        this.assertNoSessionCompaction(input.sessionId);
        check();
        // Reject owner input while recall is pending. Successful acceptance closes the edit window
        // and restores the original queue state; sealed sources cannot register derived work.
        if (!internal) {
          this.messageRecall.assertNoOpenRecall(session.id);
          this.messageRecall.closeEditWindowForNewInput(session.id);
        }
        if (input.parentTaskId) this.messageRecall.assertSourceNotSealed(input.parentTaskId);
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
              accessMode !== workflow.source.accessMode || !isDeepStrictEqual(input.grantedPaths ?? [], workflow.source.grantedPaths)) throw new WorkflowError("delivery_invalid");
        }
        const queued = this.store.insertQueuedTask({
          sessionId: input.sessionId,
          requestId: input.requestId,
          input: input.input,
          accessMode,
          planMode,
          grantedPaths,
          inputPurpose: input.reportKey || input.reportKeys?.length || input.workflowRunId ? "internal_report" : undefined,
          modelSelection: selection,
          submissionDigest,
          parentTaskId: input.parentTaskId ?? null,
          sourcePermissionVersion: input.sourcePermissionVersion ?? null,
          deadline,
        });
        if (!queued.duplicate) this.attachments.bind(queued.task.id, session.id, attachments);
        if (codeSource) bindCodeScheduleTask(this.store, { runId: codeSource.runId, taskId: queued.task.id, sourceTaskId: codeSource.taskId });
        if (input.browser && !queued.duplicate) this.store.bindTaskBrowser(queued.task.id, input.browser.connectionId);
        if (workflow) updateWorkflowRun(this.store, { ...workflow, delivery: { ...workflow.delivery!, taskId: queued.task.id, status: "queued" } });
        for (const key of reportKeys) bindAgentReportFallback(this.store, key, queued.task.id);
        // 显式引导与源 Task 同事务创建路由：先持久化才谈接入与回退
        if (input.guidance && !queued.duplicate) this.acceptGuidanceForTask(queued.task.id);
        return queued;
      }));
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
    if (!duplicate) {
      const guidance = this.store.getTaskGuidance(task.id);
      if (guidance?.state === "pending") {
        // 显式引导仅解除等待：不中断任务与已开始的工具批次；目标在下一个安全边界接入
        this.agentWait.interrupt(guidance.targetTaskId, "owner_input");
        this.backgroundProcesses.interruptWait(guidance.targetTaskId);
        this.drivers.get(input.sessionId)?.releaseGuidanceWaits();
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

  // Note: See .agents/notes/implemented/feature/2026-10-30-coding-owner-question-wait.md
  async answerOwnerQuestion(input: { sessionId: string; questionId: string; version: number; requestId: string; answers: unknown }): Promise<OwnerQuestionReceipt> {
    const requestDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.store.withTx(() => {
      const original = getOwnerQuestionReceipt(this.store, input.sessionId, input.requestId);
      if (original) {
        if (original.operation !== "owner_question_answer" || original.questionId !== input.questionId || original.digest !== requestDigest) throw new OwnerQuestionError("request_conflict");
        return original;
      }
      this.messageRecall.assertNoOpenRecall(input.sessionId);
      const question = getOwnerQuestion(this.store, input.questionId);
      if (!question || question.sessionId !== input.sessionId) throw new OwnerQuestionError("question_not_found");
      return consumeOwnerQuestion(this.store, { questionId: input.questionId, sessionId: input.sessionId, version: input.version,
        requestKey: input.requestId, requestDigest, answers: parseOwnerAnswers(input.answers, question.questions) });
    });
  }

  private waitForOwnerQuestion(questionId: string, signal?: AbortSignal): Promise<OwnerQuestion> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, question?: OwnerQuestion) => {
        this.removeEventListener(check);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(question!);
      };
      const abort = () => finish(new OwnerQuestionError("question_source_invalid", "提问任务已停止；保留已接纳回答，请查看原问题状态。"));
      const check = () => {
        try {
          const question = getOwnerQuestion(this.store, questionId);
          if (!question) return finish(new OwnerQuestionError("question_not_found"));
          if (question.status !== "pending") finish(undefined, question);
        } catch (error) { finish(error instanceof Error ? error : new OwnerQuestionError("question_corrupt")); }
      };
      this.addEventListener(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
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
    this.assertCodeScheduleSessionMutable(input.sessionId);
    if (typeof input.archived !== "boolean") throw new RuntimeApiError("invalid_params", "archived 必须是布尔值");
    const kind = this.store.getSessionIdentity(input.sessionId)?.kind;
    if (kind !== "dev") throw new RuntimeApiError("invalid_state", "宿主独立执行会话不能存档");
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
    this.assertCodeScheduleSessionMutable(input.sessionId);
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
    this.assertCodeScheduleSessionMutable(task.sessionId);
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

  listCredentialBindings(input: { purpose?: string; endpoint?: string } = {}) {
    let host: string | undefined;
    if (input.endpoint !== undefined) {
      try { host = parseMcpEndpoint(input.endpoint).host; }
      catch { throw new RuntimeApiError("invalid_params", "MCP 端点无效，请检查地址。"); }
    }
    const services = this.mcp.listServices();
    return this.credentials.list().flatMap(view => {
      const binding = this.credentials.get(view.name)!;
      if (input.purpose && view.purpose !== input.purpose) return [];
      if (input.purpose === MCP_CREDENTIAL_PURPOSE && !isMcpCredential(binding)) return [];
      if (host !== undefined && view.host !== host) return [];
      const references = services.filter(service => service.credential === view.name).map(service => ({ serviceId: service.id, serviceName: service.name }));
      return [{ ...view, scope: binding.scope, references }];
    });
  }

  // Note: 见 .agents/notes/implemented/simplification/2026-10-24-code-instance-mcp.md
  mcpSaveCredential(input: { name: string; endpoint: string; secret: string }) {
    if (!input.name.trim() || input.name.length > 128 || /[\r\n]/.test(input.name) || !input.secret || input.secret !== input.secret.trim() || /[\r\n]/.test(input.secret)) throw new RuntimeApiError("invalid_params", "凭据名称与令牌不能为空、不能含换行，令牌首尾不能有空白。");
    let endpoint: URL;
    try { endpoint = parseMcpEndpoint(input.endpoint); }
    catch { throw new RuntimeApiError("invalid_params", "MCP 端点无效，请检查地址。"); }
    if (this.credentials.get(input.name)) throw new RuntimeApiError("credential_exists", "凭据名称已存在，请为本次保存使用新的名称。");
    const binding = { name: input.name, host: endpoint.host, header: "authorization", purpose: MCP_CREDENTIAL_PURPOSE, secret: input.secret, scope: { operations: [MCP_CREDENTIAL_PURPOSE] } };
    if (!isMcpCredential(binding, endpoint.host)) throw new RuntimeApiError("invalid_params", "MCP 凭据须限定 authorization 与 mcp 操作范围。");
    this.credentials.upsert(binding);
    return this.listCredentialBindings({ purpose: MCP_CREDENTIAL_PURPOSE, endpoint: input.endpoint }).find(binding => binding.name === input.name)!;
  }

  mcpRemoveCredential(name: string): { removed: boolean } {
    const binding = this.credentials.get(name);
    if (!binding) return { removed: false };
    if (!isMcpCredential(binding)) throw new RuntimeApiError("credential_scope_mismatch", "此凭据不专属于实例 MCP，请保留原凭据并另建绑定。");
    this.assertCredentialUnreferenced(name);
    return { removed: this.credentials.remove(name) };
  }

  /** 桌面 Web 搜索设置页专用：只写固定名 Tavily 绑定，不接受名称、主机或用途参数；秘密值不进任何输出。 */
  webSearchSaveCredential(input: { secret: string }) {
    if (!input.secret || input.secret !== input.secret.trim() || /[\r\n]/.test(input.secret)) throw new RuntimeApiError("invalid_params", "令牌不能为空、首尾不能有空白且不能含换行。");
    const existing = this.credentials.get(WEB_SEARCH_CREDENTIAL_NAME);
    if (existing && existing.purpose !== TAVILY_CREDENTIAL_PURPOSE) throw new RuntimeApiError("credential_scope_mismatch", "同名绑定不是 Web Search 凭据，请更换名称后另建。");
    const host = resolveTavilyTarget(this.config.webSearch?.baseUrl).host;
    this.credentials.upsert({ name: WEB_SEARCH_CREDENTIAL_NAME, host, header: "authorization", purpose: TAVILY_CREDENTIAL_PURPOSE, secret: input.secret });
    return this.listCredentialBindings({ purpose: TAVILY_CREDENTIAL_PURPOSE }).find(binding => binding.name === WEB_SEARCH_CREDENTIAL_NAME)!;
  }

  webSearchRemoveCredential(): { removed: boolean } {
    const binding = this.credentials.get(WEB_SEARCH_CREDENTIAL_NAME);
    if (!binding) return { removed: false };
    if (binding.purpose !== TAVILY_CREDENTIAL_PURPOSE) throw new RuntimeApiError("credential_scope_mismatch", "此凭据不专属于 Web Search，请保留原凭据并另建绑定。");
    this.assertCredentialUnreferenced(WEB_SEARCH_CREDENTIAL_NAME);
    return { removed: this.credentials.remove(WEB_SEARCH_CREDENTIAL_NAME) };
  }

  private assertCredentialUnreferenced(name: string): void {
    if (this.mcp.listServices().some(service => service.credential === name)) throw new RuntimeApiError("credential_in_use", "仍有服务引用此凭据，请先解除所有服务引用后再移除。");
  }

  async addCredentialBinding(input: { name: string; host: string; header: string; purpose: string; secret: string }) {
    if (!input.name.trim() || !input.host.trim() || !input.header.trim() || !input.secret) {
      throw new RuntimeApiError("invalid_params", "凭据绑定的名称、主机、头与秘密值都不能为空");
    }
    // 同名更新保留既有使用范围（mcp 配置或历史 github bind 收紧的 scope 不因轮换令牌而丢失）
    const existing = this.credentials.get(input.name);
    let scope = existing?.scope;
    if (input.purpose === MCP_CREDENTIAL_PURPOSE || existing?.purpose === MCP_CREDENTIAL_PURPOSE) {
      if (existing && !isMcpCredential(existing)) throw new RuntimeApiError("credential_scope_mismatch", "已有绑定不符合实例 MCP 范围，请保留原凭据并另建绑定。");
      scope = { operations: [MCP_CREDENTIAL_PURPOSE] };
      if (!isMcpCredential({ ...input, scope })) throw new RuntimeApiError("invalid_params", "MCP 凭据须使用 authorization 头及 mcp 用途，请另建正确的绑定。");
    }
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

  async removeCredentialBinding(name: string): Promise<boolean> {
    if (!this.credentials.get(name)) return false;
    this.assertCredentialUnreferenced(name);
    return this.credentials.remove(name);
  }

  // ---------- MCP 服务配置（issue 16 §2/§6） ----------

  /**
   * 配置/更新实例的 MCP 服务（拥有者操作）。端点生产固定 https（http 仅限
   * 回环模拟服务）；凭据按名称引用 CredentialStore 绑定（host 须与端点一致、
   * 用途须为 mcp，且仅限 mcp 操作、无项目或仓库限制）；变更采用期望版本
   * 校验，任何变化递增 configVersion（任务内调用前重读核对）。
   */
  mcpConfigure(input: {
    serviceId?: string;
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
    if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(input.name)) {
      throw new RuntimeApiError("invalid_params", `服务名必须是小写 slug（^[a-z0-9][a-z0-9_-]{0,29}$）：${input.name}`);
    }
    let endpoint: URL | undefined;
    const existing = this.mcp.getServiceByName(input.name);
    let cua: CuaConfig | undefined;
    if (input.cua) {
      cua = parseCuaConfig(input.cua);
      if (cua.kind !== "cua-mac" || input.endpoint !== undefined || input.credential) throw new RuntimeApiError("invalid_params", "Code 电脑配置须选择本机 Driver，不接受 HTTPS 端点或凭据。");
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
      if (!isMcpCredential(cred, endpoint!.host)) throw new RuntimeApiError("invalid_params", "MCP 凭据须匹配端点主机、mcp 用途、authorization 头与专用操作范围，且无项目或仓库限制；请另建绑定。");
    }
    let service: McpServiceConfig;
    try {
      // 配置变更与事件同事务：状态变化不留无事件的洞（审计与 TUI 依赖事件流）
      service = this.store.withTx(() => {
        if (input.serviceId !== undefined && this.mcp.getServiceByName(input.name)?.id !== input.serviceId) throw new RuntimeApiError("version_conflict", "原 MCP 服务已删除或替换，请重新读取后选择当前服务；不会把原编辑自动转成新增。");
        const s = this.mcp.upsertService({
          name: input.name,
          endpoint: endpoint?.toString(),
          cua,
          credential: cua ? null : input.credential,
          toolAllowlist,
          enabled: input.enabled,
          expectedVersion: input.expectedVersion,
        });
        this.store.appendEvent(
          { type: "mcp.service_changed", serviceId: s.id, name: s.name, endpoint: s.endpoint, ...(s.cua ? { cua: { kind: s.cua.kind } } : {}), configVersion: s.configVersion, action: "upsert" },
          {},
        );
        return s;
      });
    } catch (err) {
      if (err instanceof McpVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    return service;
  }

  mcpCuaStatus() { return this.cuaManager.status(); }
  mcpCuaTargets() { return discoverCuaTargets("cua-mac"); }
  mcpCuaStop(serviceId?: string) { return this.cuaManager.stop(serviceId); }
  mcpCuaObserve() { return this.cuaManager.observe(); }
  mcpCuaAccept(observationId: string) { return this.cuaManager.accept(observationId); }

  mcpListServices(): McpServiceConfig[] {
    return this.mcp.listServices();
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
        { type: "mcp.service_changed", serviceId: service.id, name: service.name, endpoint: service.endpoint, ...(service.cua ? { cua: { kind: service.cua.kind } } : {}), configVersion: service.configVersion, action: enabled ? "enabled" : "disabled" },
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
          { type: "mcp.service_changed", serviceId, name: service.name, endpoint: service.endpoint, ...(service.cua ? { cua: { kind: service.cua.kind } } : {}), configVersion: service.configVersion + 1, action: "removed" },
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
        error: service.cua ? "本机电脑程序或宿主权限检查失败；请核对官方固定版本、安装与执行权限，并重建原生 helper 后重新检查；未启动电脑连接。" : err instanceof McpError && err.code === "auth_failed" ? "MCP 认证失败，请检查当前实例的凭据、端点与权限后重新检查。" : "MCP 连接或工具发现失败，请检查端点与网络后重新检查；未执行业务工具。",
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

  private executableQueueHead(sessionId: string): Task | undefined {
    const candidates = this.store.listQueuedTasksFifo(sessionId).filter(task => !isAgentReportParked(this.store, task.id));
    return candidates.find(task => isAgentReportFallback(this.store, task.id) || getWorkflowDeliveryRun(this.store, task.id)) ?? candidates[0];
  }

  private isExecutableQueueHead(task: Task): boolean {
    return !this.stopping && !this.compactions.has(task.sessionId) && this.store.getSession(task.sessionId)?.queueState === "active" &&
      this.executableQueueHead(task.sessionId)?.id === task.id;
  }

  private async runQueueLoop(sessionId: string): Promise<void> {
    for (;;) {
      if (this.stopping || this.compactions.has(sessionId)) return;
      const session = this.store.getSession(sessionId);
      if (!session || session.queueState !== "active") return;
      const task = this.executableQueueHead(sessionId);
      if (!task) return;
      const codeRun = getCodeScheduleRunForTask(this.store, task.id);
      if (codeRun) {
        try { getCodeScheduledTaskSource(this.store, task.id); }
        catch (error) {
          if (!(error instanceof CodeScheduleError)) throw error;
          if (this.store.getTask(task.id)?.status === "queued") await this.cancelTask(task.id, { reason: error.code });
          continue;
        }
        if (["effect_unknown", "stop_unverified"].includes(codeRun.reason ?? "") || listCodeScheduleRunTasks(this.store, codeRun.id).some(item => item.effectUnknown)) {
          this.store.withTx(() => {
            this.store.setSessionQueueState(sessionId, "paused", "schedule_recovery_required");
            this.store.appendEvent({ type: "session.queue_paused", sessionId, reason: "schedule_recovery_required" }, { sessionId });
          });
          return;
        }
      }
      const fallback = listAgentReports(this.store, { taskId: task.id }).find(report => report.fallbackTaskId === task.id && report.status === "pending");
      if (fallback) {
        await this.routeAgentReportGroup(fallback);
        if (isAgentReportParked(this.store, task.id)) continue;
      }


      // 父级送达的放行判定（工单 09 入口 4）：已取消工作的结果唤醒与消息唤醒在此
      // 截住。取消所在轮次的模型调用如已开始则不级联。
      const wakeProblem = this.parentDelivery.wakeUnavailable(task);
      if (wakeProblem) {
        await this.cancelTask(task.id, { reason: wakeProblem });
        continue;
      }

      const identity = this.store.getSessionIdentity(sessionId)!;

      // 任务开始前核对目录身份（issue 16：占用键是任务写入目标；排队期间被
      // 替换或失效的写入目录拒绝执行，不自动重建）。
      // 侧聊不核实目录身份，也不取目录占用（无工具、不触碰工作区）；父会话
      // 任务、审批与目录占用互不影响。
      let workspaceLaunch: ReturnType<typeof taskWorkspaceFor> | null = null;
      let dialogue = identity.kind === "side";
      if (!dialogue) try {
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
          if (!this.isExecutableQueueHead(task)) return;
          if (codeRun) pauseCodeSchedule(this.store, { planId: codeRun.scheduleId, reason: "schedule_workspace_invalid" });
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
          if (!this.isExecutableQueueHead(task)) throw new TaskGoneError();
          this.assertNoSessionCompaction(sessionId);
          if (task.subAgentId) {
            const work = task.workId ? this.store.getWorkDelegation(task.workId) : null;
            if (work && workflowSlotsUsed(this.store, work.parentSessionId) >= 3) throw new DirOccupiedError();
          }
          if (codeRun) getCodeScheduledTaskSource(this.store, task.id);
          if (!dialogue && !this.store.tryAcquireOccupancy({
            cwdReal: workspaceLaunch!.path,
            cwdDev: workspaceLaunch!.dev,
            cwdIno: workspaceLaunch!.ino,
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
        if (err instanceof CodeScheduleError) {
          if (this.store.getTask(task.id)?.status === "queued") await this.cancelTask(task.id, { reason: err.code });
          continue;
        }
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
        this.reportRequestInputs.delete(task.id);
        this.preparedReportInputs.delete(task.id);
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
  private initDesktopBrowser(): void {
    this.desktopBrowserManager = new DesktopBrowserManager({ store: this.store, call: () => this.desktopBrowserCall });
    this.onDesktopBrowserEvent = (connectionId, event) => this.desktopBrowserManager.onEvent(connectionId, event);
    this.onDesktopBrowserDisconnected = connectionId => this.desktopBrowserManager.onDisconnect(connectionId);
  }

  private browserAllowed(task: Task): boolean {
    if (!browserTaskAllowed(this.store, task) || getWorkflowDeliveryRun(this.store, task.id)) return false;
    const background = listActiveBackgroundProcesses(this.store, task.sessionId).find(record => record.handedOff);
    if (background) {
      const problem = this.backgroundSourceProblem(background);
      if (problem) { this.backgroundProcesses.requestStop(background.id, problem); return false; }
      if (!ownerQuestionTaskEligible(this.store, task) || task.accessMode !== background.source.accessMode) return false;
    }
    return true;
  }

  private initHostToolFamilies(): void {
    this.cuaManager = new CodeCuaManager(this.store, this.mcp, this.artifacts, this.config.profile.dataDir, this.config.mcp);
    this.browserManager = new BrowserManager({ dataDir: this.config.profile.dataDir, store: this.store, ...this.config.browser,
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
        screenshotDir: path.join(this.config.profile.dataDir, "browser", "screenshots"), allowed: task => this.browserAllowed(task) }),
      createDesktopBrowserFamily({ store: this.store, artifacts: this.artifacts, manager: this.desktopBrowserManager }),
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
      createSubAgentFamily({
        coreStore: this.store,
        delegate: (input) => this.subagents!.delegate(input),
        close: (input) => this.subagents!.close(input),
        cancelWork: (input) => this.subagents!.cancelWork(input),
        message: (input) => this.subagents!.message(input),
        integrate: (input) => this.subagents!.integrate(input),
        readReply: (taskId, offset, length) => this.readTaskReply(taskId, offset, length),
        artifacts: this.artifacts,
      }),
      createWorkflowFamily({ store: this.store, workflowLibrary: this.workflowLibrary,
        startWorkflowTask: input => this.startWorkflowTask(input), getWorkflowDefinition: input => this.getWorkflowDefinition(input),
        getWorkflowDetail: (...args) => this.getWorkflowDetail(...args), getWorkflowStep: (...args) => this.getWorkflowStep(...args),
        getWorkflowLogs: (...args) => this.getWorkflowLogs(...args), getWorkflowQuestion: (...args) => this.getWorkflowQuestion(...args),
        listWorkflows: (...args) => this.listWorkflows(...args), controlWorkflow: input => this.controlWorkflow(input) }),
      createOwnerQuestionFamily(this.store),
      createSkillFamily(),
    ];
    this.ledger = new ToolOpLedger(this.store, this.hostToolFamilies.flatMap(family => family.ledger ? [family.ledger] : []));
    this.hostExecutions = new HostExecutionManager({ store: this.store, ledger: this.ledger, onReleased: () => this.kickAll() });
    this.backgroundProcesses = new RuntimeBackgroundProcesses({ store: this.store, dataDir: this.config.profile.dataDir,
      handoff: async (taskId, transfer) => {
        const task = this.store.getTask(taskId), session = task && this.store.getSession(task.sessionId);
        if (!session) throw new BackgroundProcessError("background_source_invalid", "后台来源会话缺失；结束本轮并向拥有者说明。");
        return (await this.getDriver(session)).yieldWorkspace(taskId, transfer);
      },
      restore: async taskId => {
        const task = this.store.getTask(taskId), driver = task && this.drivers.get(task.sessionId);
        return driver?.restoreWorkspace(taskId) ?? false;
      },
      sourceProblem: record => this.backgroundSourceProblem(record), released: () => this.kickAll(),
      subscribe: listener => this.addEventListener(listener), unsubscribe: listener => this.removeEventListener(listener) });
  }

  private async getDriver(session: Session): Promise<Driver> {
    let driver = this.drivers.get(session.id);
    if (!driver) {
      driver = new Driver(session, {
        store: this.store,
        ledger: this.ledger,
        sessionsDir: sessionsDirFor(this.config.profile.dataDir),
        agentDir: this.config.profile.agentDir,
        subAgentRoles: () => loadSubAgentRoleLibrary(this.config.profile.agentDir),
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
        ownerQuestions: { create: (ctx, questions) => this.store.withTx(() => createOwnerQuestion(this.store, { ...ctx, questions })),
          wait: (questionId, signal) => this.waitForOwnerQuestion(questionId, signal) },
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
          wait: (ctx, processId, timeoutMs, signal) => { this.verifyBackgroundCaller(ctx.taskId, ctx.sessionId); return this.backgroundProcesses.wait(ctx, processId, timeoutMs, signal); },
        },
        jev: this.config.jev,
        compaction: this.config.compaction,
        mcp: { store: this.mcp, cua: this.cuaManager, ...this.config.mcp },
        allowTaskTool: (task, name) => (!this.mcpSourceBlocked(task) || !name.startsWith("mcp__") && this.ledger.hasNoWriteEffect({ toolName: name, params: {} })) && !getWorkflowDeliveryRun(this.store, task.id) && !isAgentReportFallback(this.store, task.id),
        browser: { allowed: task => this.browserAllowed(task), close: sessionId => this.browserManager.close(sessionId) },
        desktopBrowser: this.desktopBrowserManager,
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
        beforeModelRequest: (task, messages) => {
          if (this.store.getTask(task.id)?.interruptReason === "owner_interrupt" || this.store.getSession(task.sessionId)?.queuePauseReason === "owner_pause") throw new RuntimeApiError("task_ending", "拥有者已暂停会话；本任务不再发送模型请求。");
          const background = listActiveBackgroundProcesses(this.store, task.sessionId).find(record => record.handedOff);
          if (background && this.backgroundSourceProblem(background)) throw new BackgroundProcessError("background_source_invalid", "后台参考来源已失效；停止依赖该资料的模型请求并核实原后台。");
          if (this.verifyAgentReportSources(task.id)) throw new AgentWaitError("source_invalid");
          const claims = listAgentReports(this.store, { taskId: task.id }).filter(report => report.status === "pending" && report.claimTaskId === task.id);
          if (claims.some(report => report.consumption && report.consumption.taskId !== task.id) && !this.agentReportInput(task, claims)) throw new AgentWaitError("report_input_missing");
          return this.bindAgentReportRequest(task, messages);
        },
        afterModelRequest: task => this.store.withTx(() => this.acceptAgentWaitResults(task)),
        reportBoundary: {
          pending: task => this.pendingBoundaryReports(this.store.getTask(task.id)!).length > 0,
          prepare: task => this.prepareBoundaryReports(task),
          bind: (task, batch) => { this.preparedReportInputs.set(task.id, batch); },
        },
        reportContext: task => {
          const reports = listAgentReports(this.store, { taskId: task.id }).filter(report => report.fallbackTaskId === task.id);
          if (reports.length < 2) return null;
          return { reportKeys: reports.map(report => report.key), text: "[后台工作分组回报]\n" + reports.map(report => report.target.kind === "workflow"
            ? workflowReport(this.store, requireWorkflowRun(this.store, report.target.runId)).text
            : `子任务 ${report.target.taskId}：${this.store.getTask(report.target.taskId)!.status}\n${this.store.getTask(report.target.taskId)!.resultSummary}`).join("\n\n") + "\n请一次汇总本组全部事实，明确失败、取消和停止未核实；不再逐项另发总结。" };
        },
        reviewer: this.models.current.reviewer,
        consumeRecheck: (_confirmation, task) => this.verifySubAgentSource(task) ?? this.workflowSteps.verify(task),
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
    this.store.withTx(() => {
      if (this.store.getSessionIdentity(task.sessionId)?.kind === "dev" && !task.subAgentId && !getWorkflowExecution(this.store, task.id)) {
        this.store.setSessionQueueState(task.sessionId, "paused", "owner_pause");
        this.store.appendEvent({ type: "session.queue_paused", sessionId: task.sessionId, reason: "owner_pause" }, { sessionId: task.sessionId });
      }
      this.store.transitionTask(task.id, [task.status], task.status, { interruptReason: "owner_interrupt" });
      invalidateOwnerQuestionsForTask(this.store, task.id);
    });
    if (this.hostExecutions.has(task.id)) {
      await this.hostExecutions.stop(task.id, "interrupted", "owner_interrupt");
      return this.store.getTask(taskId)!;
    }
    const driver = await this.getDriver(this.store.getSession(task.sessionId)!);
    await driver.requestStop(task, { terminal: "interrupted", reason: "owner_interrupt", cancelIntent: false });
    return this.store.getTask(taskId)!;
  }

  /**
   * 引导目标解析（事务内）：执行归属的活动任务优先；错过时锚定最近的非排队
   * 普通开发任务（含刚结束者，回退路由据此把源放回队首）；无候选返回 null，
   * 调用方按普通排队处理。排队中的任务与源自身都不是有效目标。
   */
  private guidanceTarget(sessionId: string, excludeTaskId: string): string | null {
    const active = this.drivers.get(sessionId)?.currentTaskId;
    const activeTask = active && active !== excludeTaskId ? this.store.getTask(active) : null;
    if (activeTask && (activeTask.status === "running" || activeTask.status === "awaiting_confirmation") && this.store.ordinaryCodeTask(activeTask)) return activeTask.id;
    const candidate = [...this.store.listTasksBySession(sessionId)].reverse()
      .find(task => task.id !== excludeTaskId && task.status !== "queued" && this.store.ordinaryCodeTask(task));
    return candidate ? candidate.id : null;
  }

  /** 事务内受理引导路由；目标可接入时同时失效其未消费审批（不批准、不取消旧操作）。 */
  private acceptGuidanceForTask(sourceTaskId: string, expectedQueueRevision?: number): TaskGuidance | null {
    const source = this.store.getTask(sourceTaskId);
    if (!source) throw new StoreConflictError("输入不存在，请刷新会话", "not_found");
    const targetId = this.guidanceTarget(source.sessionId, sourceTaskId);
    if (!targetId) return null;
    const guidance = this.store.acceptTaskGuidance(sourceTaskId, targetId, true, expectedQueueRevision);
    if (guidance.state === "pending") {
      this.store.stalePendingConfirmations(targetId);
      const question = listOwnerQuestions(this.store, source.sessionId).find(item => item.taskId === targetId && item.status === "pending");
      if (question) cancelOwnerQuestion(this.store, { questionId: question.id, sessionId: source.sessionId, version: question.version });
    }
    return guidance;
  }

  /**
   * 已排队的普通输入显式转换成当前任务的引导（coding-message-control）：
   * 正文、附件、请求身份与队列事实不变；错过目标回普通队首。
   */
  async steerTask(taskId: string, opts?: { expectedQueueRevision?: number }): Promise<Task> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，请稍后重试");
    const task = this.store.getTask(taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${taskId}`);
    const session = this.store.getSession(task.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${task.sessionId}`);
    if (this.store.getSessionIdentity(session.id)?.kind !== "dev") throw new RuntimeApiError("guidance_not_allowed", "仅普通开发会话支持引导");
    this.messageRecall.assertNoOpenRecall(session.id);
    let guidance: TaskGuidance | null;
    try {
      guidance = this.store.withTx(() => this.acceptGuidanceForTask(taskId, opts?.expectedQueueRevision));
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    // 错过目标：输入保持普通排队（位置不变）
    if (!guidance) return this.store.getTask(taskId)!;
    if (guidance.state === "pending") {
      this.agentWait.interrupt(guidance.targetTaskId, "owner_input");
      this.backgroundProcesses.interruptWait(guidance.targetTaskId);
      this.drivers.get(session.id)?.releaseGuidanceWaits();
    }
    this.kick(session.id);
    return this.store.getTask(taskId)!;
  }

  /**
   * 控制面队列快照：持久顺序、修订、本会话全部引导路由与可重排/可转引导集合
   * （queue.tasks 含不可重排的宿主/编排项；客户端只按 reorderableTaskIds 提交，
   * 「转为引导」动作只对 steerableTaskIds 开放）。
   */
  getTaskQueueDetail(sessionId: string): { queue: TaskQueue; reorderableTaskIds: string[]; steerableTaskIds: string[]; guidance: TaskGuidance[] } {
    const reorderable = this.store.listReorderableTasks(sessionId);
    return {
      queue: this.store.getTaskQueue(sessionId),
      reorderableTaskIds: reorderable.map(task => task.id),
      steerableTaskIds: reorderable.filter(task => !task.resumesTaskId && !this.store.hasOwnerQuestionContinuation(task.id)).map(task => task.id),
      guidance: this.store.listSessionGuidance(sessionId),
    };
  }

  /** 队列重排：仅交换普通拥有者输入的位置；冲突以实际持久状态拒绝并回执。 */
  reorderQueue(sessionId: string, taskIds: string[], expectedRevision: number): TaskQueue {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，请稍后重试");
    this.messageRecall.assertNoOpenRecall(sessionId);
    try {
      return this.store.withTx(() => this.store.reorderTaskQueue(sessionId, taskIds, expectedRevision));
    } catch (err) {
      if (err instanceof StoreConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
  }

  async cancelTask(taskId: string, opts?: { reason?: string }): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${taskId}`);
    // Leave terminal-state changes to recall orchestration while it verifies the stop closure.
    this.messageRecall.assertNoOpenRecall(task.sessionId);
    if (getWorkflowExecution(this.store, task.id)?.kind === "agent") throw new RuntimeApiError("invalid_state", "工作流步骤由所属运行控制，请取消运行");
    if (task.status === "queued") {
      // 待接入引导源：已预留进目标边界的源取消等待该批实际落盘结果，再核实现状
      const guidance = this.store.getTaskGuidance(task.id);
      if (guidance?.state === "pending") {
        const driver = this.drivers.get(task.sessionId);
        if (driver) await driver.waitGuidanceSource(task.id);
        const settled = this.store.getTaskGuidance(task.id);
        if (settled?.state === "joined") throw new RuntimeApiError("invalid_state", "输入已接入目标任务，不能取消");
      }
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
    // Do not consume approvals during recall; stopping invalidates them so late card responses create no effects.
    this.messageRecall.assertNoOpenRecall(confirmation.sessionId);
    if (task.status !== "awaiting_confirmation") {
      throw new RuntimeApiError("stale_confirmation", `确认请求已失效（任务状态 ${task.status}）`);
    }
    const driver = this.drivers.get(confirmation.sessionId);
    if (!driver) throw new RuntimeApiError("stale_confirmation", "确认请求已失效（无活动执行）");
    const applied = driver.resolveConfirmation(confirmationId, decision);
    if (!applied) throw new RuntimeApiError("stale_confirmation", "确认请求已被处理或失效");
    return this.store.getConfirmation(confirmationId)!;
  }

  /** Resume recorded tasks; releasing terminal execution occupancy requires explicit stop confirmation. */
  async resumeQueue(sessionId: string, stopConfirmed = false): Promise<Session> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${sessionId}`);
    const codeRun = getOpenCodeScheduleRunForSession(this.store, sessionId);
    if (codeRun) {
      getCodeScheduledTaskSource(this.store, codeRun.rootTaskId);
    }
    let parentSessionId: string | null = null;
    let releasedOccupancy = false;
    this.store.withTx(() => {
      if (codeRun) getCodeScheduledTaskSource(this.store, codeRun.rootTaskId);
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
        if (!stopConfirmed) throw new RuntimeApiError("stop_unverified", "旧执行尚未核实停止；请核实后显式确认停止，再恢复队列。");
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
      const recovery = codeRun && ["effect_unknown", "stop_unverified"].includes(codeRun.reason ?? "");
      if (recovery) for (const task of listCodeScheduleRunTasks(this.store, codeRun.id).filter(task => task.status === "queued")) this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: "schedule_recovery_required" });
      // Do not resume while recall is processing or awaiting verification. Resuming an edit window
      // closes it and restores the saved queue state rather than unconditionally activating the queue.
      if (session.queuePauseReason === RECALL_PAUSE_REASON) {
        throw new RuntimeApiError("recall_pending", "撤回请求尚未收束，请等待或先完成停止核实");
      }
      const edit = getEditWindowRecall(this.store, sessionId);
      if (edit && !recovery && session.queuePauseReason === "message_recall_edit") {
        closeEditWindows(this.store, sessionId, new Date().toISOString());
        const saved = edit.savedQueueState === "paused" ? "paused" : "active";
        this.store.setSessionQueueState(sessionId, saved, saved === "paused" ? edit.savedQueueReason : null);
        this.store.appendEvent(saved === "paused" ? { type: "session.queue_paused", sessionId, reason: edit.savedQueueReason ?? "message_recall_edit" } : { type: "session.queue_resumed", sessionId }, { sessionId });
      } else {
        this.store.setSessionQueueState(sessionId, recovery ? "paused" : "active", recovery ? "schedule_recovery_required" : null);
        this.store.appendEvent(recovery ? { type: "session.queue_paused", sessionId, reason: "schedule_recovery_required" } : { type: "session.queue_resumed", sessionId }, { sessionId });
      }
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
    /** 实例级 Web Search 开关（全实例共用）。 */
    webSearch: { state: "enabled" | "disabled"; version: number };
    subAgentSessionIds: string[];
    workDelegations: WorkDelegation[];
    subAgents: SubAgent[];
    ownerQuestions: OwnerQuestionView[];
    backgroundProcesses: BackgroundProcessView[];
    codeScheduleRuns: CodeScheduleRun[];
    taskGuidance: TaskGuidance[];
    /** Pending recalls and open edit windows for reconnect recovery, excluding other terminal receipts. */
    messageRecalls: PublicMessageRecall[];
    /** 侧聊持久绑定（重连后客户端恢复侧聊身份；普通会话列表按此排除）。 */
    sideChats: Array<{ parentSessionId: string; sideSessionId: string }>;
    seq: number;
  } {
    // 有界快照：全部活动任务 + 每个会话最近结束的若干任务；更早的经 list_tasks 分页。
    // 侧聊会话不进入普通会话列表（专用入口经 sideChats 绑定恢复）；任务仍全量
    // 扫描，侧聊悬浮层要靠任务状态恢复生成中与中断目标。
    const allSessions = this.store.listSessions();
    const sessions = allSessions.filter(session => this.store.sideParentId(session.id) === null).map(session => this.codeSessionView(session));
    const tasks: Task[] = [];
    for (const session of allSessions) {
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
      webSearch: this.store.getWebSearch(),
      subAgentSessionIds: this.store.listSubAgents().map((a) => a.sessionId),
      workDelegations: this.store.listWorkDelegations(),
      subAgents: this.store.listSubAgents(),
      ownerQuestions: sessions.flatMap(session => this.listOwnerQuestions(session.id).questions),
      backgroundProcesses: sessions.flatMap(session => this.listBackgroundProcesses(session.id).processes),
      codeScheduleRuns: this.codeScheduleRunSnapshot(),
      taskGuidance: sessions.flatMap(session => this.store.listSessionGuidance(session.id)),
      // Reconnect restores pending recall and edit-window state without replaying history.
      messageRecalls: sessions.flatMap(session => {
        const open = getOpenMessageRecall(this.store, session.id);
        const edit = getEditWindowRecall(this.store, session.id);
        return [open, edit].filter((recall): recall is MessageRecall => recall !== null).map(publicMessageRecall);
      }),
      sideChats: this.sideChatBindings(),
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
    while (snapshot.codeScheduleRuns.length && frameBytes(snapshot) > SEGMENT_MAX_BYTES) snapshot.codeScheduleRuns.pop();
    return snapshot;
  }

  private codeScheduleRunSnapshot(): CodeScheduleRun[] {
    const runs = new Map(listOpenCodeScheduleRuns(this.store).map(run => [run.id, run]));
    for (const plan of listCodeSchedules(this.store, { limit: 100 }).plans) {
      const latest = listCodeScheduleRuns(this.store, { planId: plan.id, limit: 1 }).runs[0];
      if (latest) runs.set(latest.id, latest);
    }
    const result: CodeScheduleRun[] = [];
    let bytes = 0;
    for (const run of runs.values()) {
      const size = frameBytes(run);
      if (bytes + size > 128 * 1024) break;
      result.push(run); bytes += size;
    }
    return result;
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
    const codeRun = getCodeScheduleRunForTask(this.store, task.id);
    return { ...task, inputPurpose: getWorkflowDeliveryRun(this.store, task.id) || isAgentReportFallback(this.store, task.id) ? "internal_report" : "user",
      ...(codeRun ? { codeScheduleRunId: codeRun.id } : {}),
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
      const hostToolOpId = entry.toolCallId ? this.store.listToolOpsByTask(task.id).find(op => op.sdkCallId === entry.toolCallId)?.id : undefined;
      const reportInput = entry.reportKeys?.length ? entry.reportKeys.every(key => {
        const report = getAgentReport(this.store, key);
        return report && report.parentSessionId === task.sessionId && this.reportInputEntries(task).some(input => input.entryId === entry.entryId && input.keys.includes(key));
      }) : false;
      return { ...entry, inputPurpose: reportInput ? "internal_report" : this.taskView(task).inputPurpose, ...(hostToolOpId ? { hostToolOpId } : {}) };
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
    // 侧聊不属于普通会话搜索范围；拥有者按会话/任务显式定位时仍可读取
    if (input.sessionId === undefined && input.taskId === undefined) {
      sessions = sessions.filter(session => this.store.sideParentId(session.id) === null);
    }
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
   * 启用/停用实例级 Web Search 开关（issue 20；拥有者入口，全实例共用）。默认
   * 启用；停用立即阻止后续调用（工具按调用新鲜检查），启用从下一任务生效
   * （任务开始固定工具清单）。expected_version 语义同 setProjectInstructions。
   */
  setWebSearch(input: { enabled: boolean; expectedVersion?: number }): { state: "enabled" | "disabled"; version: number } {
    if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
      throw new RuntimeApiError("invalid_params", "expected_version 须为正整数（设置版本从 1 起）");
    }
    try {
      return this.store.withTx(() =>
        this.store.setWebSearch({ state: input.enabled ? "enabled" : "disabled", expectedVersion: input.expectedVersion }),
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
    const lib = loadSkillLibrary();
    return {
      dir: skillsDirFor(),
      skills: lib.skills.map((s) => ({
        name: s.name,
        explicitOnly: s.disableModelInvocation,
        description: s.description.length > 120 ? `${s.description.slice(0, 120)}…` : s.description,
      })),
      diagnostics: lib.diagnostics,
    };
  }

  listSkillsPage(input: { offset?: number; limit?: number } = {}) {
    return listSkillLibrary(input);
  }

  getSkill(id: SkillId) {
    return getSkillDetail(id);
  }

  listSubAgentRoles() {
    const library = loadSubAgentRoleLibrary(this.config.profile.agentDir);
    return { dir: path.join(this.config.profile.agentDir, "agents"), roles: library.roles.map(({ name, description, tools, permissions, digest }) => ({ name, description, tools, permissions, digest })), diagnostics: library.diagnostics };
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

    await this.codeScheduler?.stop();
    // 编排器先行停止：停超时巡检，停止路径不再产生新的取消/唤醒
    if (this.orchestrator) {
      await this.orchestrator.stop().catch(() => {});
      this.orchestrator = null;
    }

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
    this.store.withTx(() => {
      this.store.appendEvent({ type: "backend.stopped", reason });
    });
    this.db.close();
    this.lock.release();
    this.configLock.release();
  }
}
