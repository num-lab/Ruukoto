import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
/**
 * 会话驱动器：把 SDK 会话接到任务状态机上。
 *
 * 职责：
 * - 懒创建 SDK 会话（封闭配置见 session-factory）；
 * - 运行任务：标记条目关联（task_start/task_end marker）→ prompt → 依据
 *   最终 assistant 消息与落盘核对确定终态（条件更新保证取消/完成竞争下
 *   只有一个终态）；
 * - tool_call 门：记录执行意图；需要确认的工具阻塞等待决定（auto-review
 *   模式的审批请求先经一次有时限的自动审查，失败/越界一律转拥有者）；
 * - 片段与条目引用：流式片段按 partial 事件发出；条目引用只在读文件确认
 *   落盘后发出（不预支未落盘内容，不建第二套权威历史）；
 * - 停止路径：先提交停止意图，解除确认等待，abort()，回收受管进程组，
 *   之后才提交终态并释放占用；
 * - 模型上下文：每个任务一个组装实例（context-assembly，含上下文压缩）；
 *   context 钩子交出消息，发送前先过本模块的检查、再由组装实例复核并落
 *   选择记录，被拦下时任务中断并暂停该会话队列；
 * - 上下文超限：检测后任务中断（context_overflow）并暂停该会话队列，
 *   不自动摘要、不重试。
 */

import * as fs from "node:fs";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ModelCatalog } from "./model-selection.ts";
import type { ApprovalReviewer } from "./review.ts";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type {
  AccessMode,
  ApprovalScope,
  ConfirmationRequest,
  PersistentEventBody,
  Session,
  Task,
  ToolCategory,
  Artifact,
  MemorySourceRef,
} from "@ruukoto/core/types.ts";
import { randomId, TASK_END_MARKER, TASK_START_MARKER } from "@ruukoto/core/types.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { editStatsFromResult, parseSessionFile, snapUtf8End, tailTextByBytes, type ParsedSessionEntry } from "@ruukoto/core/history.ts";
import { FRAGMENT_TEXT_CAP } from "@ruukoto/core/views.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { CredentialStore } from "./execution/credentials.ts";
import { ExecutionError } from "./execution/launchers.ts";
import type { WorkerLauncher } from "./execution/launchers.ts";
import { createManagedProcessRegistry, type ManagedEntry, type ManagedProcessRegistry } from "./managed-processes.ts";
import { createSdkSession, SYSTEM_PROMPTS } from "./session-factory.ts";
import { ToolRouter, ROUTED_TOOL_NAMES } from "./tool-router.ts";
import { ApprovalGate } from "./approval-gate.ts";
import type { ToolOpLedger } from "./tool-op-ledger.ts";
import type { AccessScope } from "@ruukoto/core/access.ts";
import type { HistoryIndex } from "@ruukoto/core/history-index.ts";
import type { MemoryStore } from "@ruukoto/core/memory.ts";
import type { SelectorBudgetConfig } from "./context-selector.ts";
import { beginContextAssembly, ContextSendBlocked, type ContextAssembly } from "./context-assembly.ts";
import type { JevRequestConfig } from "./jev.ts";
import type { HostToolContext } from "./host-tools.ts";
import type { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { expandSkillCommand, loadSkillLibrary, type SkillLibrary } from "./skills.ts";
import { buildHostToolSet, type HostCall, type HostToolFamily, type HostToolRuntime } from "./host-tool-families.ts";
import { allowsCategory, executionProfile, subAgentAllows, taskToolSet, workflowAllows, type ExecutionProfile, type TaskToolSet, type WorkflowExecutionProfile } from "./tool-availability.ts";
import { WorkflowError } from "@ruukoto/core/workflow.ts";
import { planMcpTaskTools, EMPTY_MCP_PLAN, type McpTaskPlan } from "./mcp/tools.ts";
import type { McpTimeouts } from "./mcp/client.ts";
import type { McpStore, McpToolEffect } from "./mcp/store.ts";
import type { Accessor } from "@ruukoto/core/access.ts";
import { hasImageInput, IMAGE_INPUT_UNSUPPORTED, taskImageReferences, type ImageReference } from "./inbound-images.ts";

const FRAGMENT_INTERVAL_MS = 250;

export interface DriverDeps {
  store: Store;
  /** 工具操作账本（架构工单 05）：结果、效果未知与停止补记只经它写。 */
  ledger: ToolOpLedger;
  sessionsDir: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: any;
  thinkingLevel: ThinkingLevel;
  modelCatalog: ModelCatalog;
  /** 工具装配：注册路由工具（真实编码工具）或 mock 工具（模拟测试）。 */
  toolFactory: (ctx: { registry: ManagedProcessRegistry; router: ToolRouter }) => ToolDefinition[];
  /** 工具正文产物存储（后台数据目录内受保护）。 */
  artifacts: ArtifactStore;
  /** 拥有者预配置的凭据绑定（服务凭据）。 */
  credentials: CredentialStore;
  /** 按访问模式返回工作进程启动器；未配置时抛 ExecutionError（不回退）。 */
  launcherFor: (mode: AccessMode) => WorkerLauncher;
  verificationLauncher?: () => WorkerLauncher;
  /** 始终排除的保护根目录（后台数据、服务凭据、控制面）。 */
  protectedRoots: string[];
  /** 占用释放后的唤醒回调（Runtime 注入，用于调度等待同目录的会话）。 */
  onOccupancyReleased: () => void;
  /** 资料访问范围判定（issue 05 §1）。 */
  access: AccessScope;
  /** 历史条目索引（issue 05 §2）。 */
  historyIndex: HistoryIndex;
  /** 长期记忆存储（issue 05 §5）。 */
  memories: MemoryStore;
  /** 上下文预算覆盖（默认取模型 contextWindow/maxTokens + 默认预留）。 */
  budgetOverrides?: Partial<SelectorBudgetConfig>;
  /** 静态宿主工具族；Runtime 负责捕获族专属依赖，Driver 负责当前调用接缝。 */
  hostToolFamilies: readonly HostToolFamily[];
  /** Jev 的本地模拟服务与超时覆盖，仅宿主测试注入。 */
  jev?: JevRequestConfig;
  /** 上下文压缩的摘要超时覆盖（issue 30），仅测试注入；生产 180 s。 */
  compaction?: { summaryTimeoutMs?: number };
  /** MCP（issue 16）：服务配置存储与超时覆盖；未配置时 MCP 工具不注册。 */
  mcp?: { store: McpStore } & McpTimeouts;
  /** 宿主按任务收紧工具白名单；MCP 类别取自本地钉版配置，不接受模型声明。 */
  allowTaskTool?: (task: Task, name: string, mcpEffect?: McpToolEffect) => boolean;
  /**
   * 宿主按任务另开只读 MCP（agent-direction issue 19 的 GitHub 评审 SubAgent）：
   * subagent 类会话只有该依赖为真时才规划 MCP，收窄为「静态只读白名单 ∪
   * effect=read 的 MCP」（装配、发送前与调用门同一结论）。
   */
  taskMcp?: (task: Task) => boolean;
  /** 自动审查（issue 15）：auto-review 任务的审批请求先经其裁决；缺省时退化为纯人工。 */
  reviewer?: ApprovalReviewer;
  /**
   * IM 审批宿主接线（agent-direction issue 08）：审批创建通知与消费前固定身份
   * 复核由宿主注入；均在审批创建/消费事务内执行，不得再开核心库事务。
   */
  approvalIm?: {
    notifyCreated?: (confirmation: ConfirmationRequest, task: Task) => void;
    consumeRecheck?: (confirmation: ConfirmationRequest, task: Task) => string | null;
    /**
     * 长期授权候选（agent-direction issue 10）：宿主按当前 main、任务来源入口身份
     * 与两项修订逐项核实；返回 null 走人工路径。
     */
    standingCandidate?: (
      task: Task,
      scope: Extract<ApprovalScope, { kind: "service_operation" }>,
    ) => { id: string; version: number } | null;
  };
  /**
   * 父级送达的注入入口（架构工单 09 入口 3）：任务开始时取普通开发会话待注入的
   * SubAgent 结果与工作内消息，同事务标记已投递；其他身份恒为空。
   */
  parentInjection?: ParentDelivery["takeInjection"];
  /**
   * main 委派资料的发送前复核（仅 subagent 类会话；撤销阻止后续注入，
   * 已保存快照正文不重新解析）。
   */
  verifyTaskSources?: (projectId: string, refs: unknown[]) => string | null;
  /** 宿主派生任务在每次模型请求与实际调用前重核来源。 */
  verifyTask?: (task: Task) => string | null;

  workflow?: {
    resolve(task: Task): WorkflowExecutionProfile | null;
    verify(task: Task): string | null;
    artifactAccess(task: Task, artifact: Artifact): boolean;
    historyAccess(task: Task, sessionId: string): boolean;
    recordMemory?(task: Task, memoryId: string): void;
  };
  onManagedUnits?(taskId: string, entries: ManagedEntry[]): void;

}

export class Driver {
  readonly session: Session;
  private readonly deps: DriverDeps;
  private sdk: AgentSession | null = null;
  private registry: ManagedProcessRegistry;
  private managedTaskId: string | null = null;
  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
  private processStops = new Map<ManagedEntry, Promise<boolean>>();
  private stoppingProcesses = 0;
  private ending = false;
  readonly router: ToolRouter;
  private currentTask: Task | null = null;
  private stopRequested = false;
  /** 审批闸门（架构工单 04）：审批请求全程；Driver 只接线应答、模式切换与停止。 */
  private readonly approvals: ApprovalGate;
  /** 本次任务中 sdkCallId → 宿主操作 id（结果记录与事件引用的关联键）。 */
  private callMap = new Map<string, string>();
  private flushedEntryIds = new Set<string>();
  private lastFragmentAt = 0;
  private textBlock: { contentIndex: number; text: string; offset: number; startedAt: string } | null = null;
  private nextTextIndex = 0;
  private sourceTextBlocks = new Map<number, string>();
  private thinking: Extract<PersistentEventBody, { type: "task.thinking" }> | null = null;
  private thinkingIndex: number | null = null;
  private lastThinkingAt = 0;
  /**
   * 流式 assistant 消息标识：SDK 的 message_update 每次携带新的对象副本，
   * 不能按引用识别；在每次模型请求前按序分配，flushEntryRefs 按条目
   * 落盘顺序消费，以同一身份关联思考、正文段与最终历史。
   */
  private currentMsgId: string | null = null;
  private pendingEntryMsgIds: string[] = [];
  /** 当前任务的最新输出预览（全量在内存；事件发送有界增量）。 */
  private currentPreview: { messageId: string; text: string } | null = null;
  private runPromise: Promise<void> | null = null;
  private stopPromise: Promise<boolean> | null = null;
  /** SDK 扩展桥注入的 appendEntry（宿主标记条目，custom，不进模型上下文）。 */
  private markerApi: ((customType: string, data: unknown) => void) | null = null;
  /** 本任务内 sdkCallId → 宿主数据工具上下文（并发调用各自独立）。 */
  private hostToolCalls = new Map<string, HostToolContext>();
  /** 宿主工具（非路由器）登记的产物引用：hostOpId → 产物 id（接到 task.tool_result 事件）。 */
  private hostToolArtifacts = new Map<string, string[]>();
  /** SDK 会话登记的全部工具名（任务开始钉版工具清单的基准）。 */
  private allToolNames: string[] = [];
  /** 当前任务已装配的静态宿主工具名（由族清单派生）。 */
  private hostToolNames: ReadonlySet<string> = new Set<string>();
  /** 当前任务钉版的 MCP 工具名集合（handleToolCall 分派依据；任务间比对签名）。 */
  private mcpToolNames = new Set<string>();
  /** 当前任务钉版的 MCP 计划（工具元数据 + 按服务持有的连接；结束/取消/关闭时回收）。 */
  private currentMcpPlan: McpTaskPlan | null = null;
  /** 上次 SDK 会话创建时的工具签名（画像工具集 + MCP 清单；不一致则重建会话换工具定义）。 */
  private toolSignature: string | null = null;
  /** 模型配置已应用、存活 SDK 会话待丢弃重建（issue 21 §4；见 updateModelDeps）。 */
  private sdkConfigStale = false;
  /** 待装配进新 SDK 会话的 MCP 工具定义（runInner 计划后由 ensureSdk 消费）。 */
  private pendingMcpToolDefs: ToolDefinition[] = [];
  /** 执行画像（架构工单 08）：任务开始算一次、钉到下一任务开始；首个任务前为 null。 */
  private pinnedProfile: ExecutionProfile | null = null;
  /** 本任务允许的工具（任务开始时算一次；激活、发送前与调用门共用；null = 尚未算出，一律拒绝）。 */
  private taskTools: TaskToolSet | null = null;
  /** 本任务的模型上下文组装（任务开始时建、结束即丢；context 钩子与发送前复核共用）。 */
  private assembly: ContextAssembly | null = null;
  /** 原始 streamFunction（包装前保存；发送前检查在委托前执行）。 */
  private originalStreamFn: any = null;
  /** 任务开始时钉版的技能库（issue 22；null = 资料受限会话不读取）。 */
  private pinnedSkills: SkillLibrary | null = null;
  private workflowManagedUnits: ((entries: ManagedEntry[]) => void) | null = null;
  /** 用户消息落盘前附稳定图片引用；不把图片正文交给 SDK 历史写入。 */
  private pendingUserImages: ImageReference[] = [];

  constructor(session: Session, deps: DriverDeps) {
    this.session = session;
    this.deps = deps;
    const registry = createManagedProcessRegistry();
    this.registry = { ...registry, register: entry => { registry.register(entry); this.reportManagedUnits(); } };
    this.approvals = new ApprovalGate({
      store: deps.store,
      ledger: deps.ledger,
      reviewer: () => this.deps.reviewer,
      notifyConfirmation: deps.approvalIm?.notifyCreated,
      consumeRecheck: deps.approvalIm?.consumeRecheck,
      standingCandidate: deps.approvalIm?.standingCandidate,
    });
    this.router = new ToolRouter({
      store: deps.store,
      ledger: deps.ledger,
      artifacts: deps.artifacts,
      credentials: deps.credentials,
      registry: this.registry,
      verifyTask: task => this.verifyWorkflowTask(task),
      onManagedIdentity: () => this.reportManagedUnits(),
      launcherFor: deps.launcherFor,
      verificationLauncher: deps.verificationLauncher,
      protectedRoots: deps.protectedRoots,
      artifactAccess: (task, artifact) => {
        if (this.profile.workflow) return !artifact.name.startsWith("prompt-snapshot:") &&
          this.verifyWorkflowTask(task) === null && Boolean(deps.workflow?.artifactAccess(task, artifact));
        // SubAgent 只读本次自产；模型上下文快照不是交付产物，拒绝
        if (this.profile.restricted) {
          return artifact.taskId === task.id && !artifact.name.startsWith("prompt-snapshot:");
        }
        if (artifact.taskId === task.id) return true;
        const artifactSession = deps.store.getSession(artifact.sessionId);
        if (!artifactSession) return false;
        return deps.access.canAccess(this.accessor(), artifactSession.projectId, "artifact");
      },
      approvals: this.approvals,
      // MCP 动态工具经路由器统一处理（issue 18）：计划按任务钉版，执行时读取
      mcp: deps.mcp ? { store: deps.mcp.store, plan: () => this.currentMcpPlan } : undefined,
    });
  }

  get busy(): boolean {
    return this.currentTask !== null;
  }

  /** 本任务的执行画像（调用方都在任务内；首个任务前读取即抛）。 */
  private get profile(): ExecutionProfile {
    if (!this.pinnedProfile) throw new Error("执行画像未确定（尚未运行任务）");
    return this.pinnedProfile;
  }

  /** 会话类别的清单含该工具类别（装配各注册来源的唯一条件）。 */
  private allows(category: ToolCategory): boolean {
    return this.profile.workflow ? this.profile.workflow.categories.includes(category) : allowsCategory(this.profile.toolClass, category);
  }

  /** 已登记句柄变成真实执行身份时仍沿原任务记录，不重新登记单元。 */
  reportManagedUnits(): void {
    const entries = this.registry.list();
    if (this.managedTaskId) this.deps.onManagedUnits?.(this.managedTaskId, entries);
    this.workflowManagedUnits?.(entries);
  }

  setWorkflowManagedUnits(callback: (entries: ManagedEntry[]) => void): void { this.workflowManagedUnits = callback; }

  verifyWorkflowTask(task: Task): string | null {
    const problem = this.deps.verifyTask?.(task);
    if (problem) return problem;
    if (!this.profile.workflow) return null;
    return this.deps.workflow ? this.deps.workflow.verify(task) : "工作流步骤的宿主权限核实不可用";
  }

  /** 不在本任务允许集合内的工具的拒绝原因。 */
  private toolRejection(name: string): string {
    return this.taskTools ? this.taskTools.reasonFor(name) : "本任务工具集合未确定";
  }

  /**
   * 应用数据工具的身份重核（issue 02）：每次调用重新核实宿主任务、会话、
   * 项目与 main 角色绑定，以及任务归属；模型参数不能提供这些身份。
   * 绑定在会话级：main 的持久会话中的任务（编排器创建或拥有者直接提交）
   * 都是 main 的任务；角色配置只由宿主写入 agent_roles 表。
   */
  private verifyMainBinding(ctx: { taskId: string; sessionId: string; projectId: string }): string | null {
    if (ctx.sessionId !== this.session.id) return "会话与当前执行不匹配";
    if (ctx.projectId !== this.session.projectId) return "项目与当前会话不匹配";
    if (this.profile.workflow) {
      if (this.currentTask?.id !== ctx.taskId || this.profile.workflow.toolClass !== "main") return "步骤未绑定个人助手来源";
      const task = this.deps.store.getTask(ctx.taskId);
      if (!task || task.sessionId !== ctx.sessionId) return "宿主任务归属校验失败";
      return this.verifyWorkflowTask(task);
    }
    const identity = this.deps.store.getSessionIdentity(ctx.sessionId);
    if (identity?.kind !== "main" && identity?.kind !== "scheduled") return "会话未绑定个人助手执行身份";
    if ((identity.kind === "main" ? identity.role.projectId : identity.projectId) !== this.session.projectId) return "个人助手资料项目绑定不匹配";
    if (this.currentTask?.id !== ctx.taskId) return "任务与当前执行不匹配";
    const task = this.deps.store.getTask(ctx.taskId);
    if (!task || task.sessionId !== ctx.sessionId) return "宿主任务归属校验失败";
    if (identity.kind === "scheduled") {
      const run = this.deps.store.getScheduledRunForTask(task.id);
      if (!run || run.closedAt || run.scheduleStatus === "canceled" || task.cancelRequested) return "本次定时运行已取消或关闭";
    }
    return null;
  }

  /** 宿主注入的资料访问身份。 */
  private accessor(): Accessor {
    return { kind: "agent", projectId: this.profile.workflow?.sourceProjectId ?? this.session.projectId,
      ...(this.profile.workflow ? { grantIds: this.profile.workflow.grantIds } : {}) };
  }

  private dataSessionReadable(ctx: HostToolContext, sessionId: string, category: "history" | "artifact"): boolean {
    const session = this.deps.store.getSession(sessionId);
    if (!session || !this.deps.access.canAccess(this.accessor(), session.projectId, category)) return false;
    const task = this.deps.store.getTask(ctx.taskId);
    return !this.profile.workflow || Boolean(task && this.verifyWorkflowTask(task) === null && this.deps.workflow?.historyAccess(task, sessionId));
  }

  private dataSourceReadable(ctx: HostToolContext, ref: MemorySourceRef): boolean {
    if (!this.deps.access.sourceRefAccessible(this.accessor(), ref)) return false;
    if (ref.kind === "history_entry") return this.dataSessionReadable(ctx, ref.sessionId, "history");
    if (ref.kind === "owner_note") return true;
    const artifact = this.deps.store.getArtifact(ref.artifactId);
    const task = this.deps.store.getTask(ctx.taskId);
    if (!artifact || (this.profile.workflow && artifact.name.startsWith("prompt-snapshot:"))) return false;
    return !this.profile.workflow || Boolean(task && this.verifyWorkflowTask(task) === null && this.deps.workflow?.artifactAccess(task, artifact));
  }

  /**
   * SubAgent 委派工具的宿主重核（agent-direction issue 11）：每次调用核实会话、
   * 项目与任务归属，以及会话是具备委派资格的身份（普通开发会话或 main；
   * 绑定 SubAgent/coding/chat 的会话、群会话一律拒绝）。
   */
  private verifyDelegationHost(ctx: { taskId: string; sessionId: string; projectId: string }): string | null {
    if (ctx.sessionId !== this.session.id) return "会话与当前执行不匹配";
    if (ctx.projectId !== this.session.projectId) return "项目与当前会话不匹配";
    if (this.currentTask?.id !== ctx.taskId) return "任务与当前执行不匹配";
    const identity = this.deps.store.getSessionIdentity(ctx.sessionId);
    if (identity?.kind === "subagent") return "SubAgent 不能委派下级";
    if (identity?.kind !== "dev" && identity?.kind !== "main" && identity?.kind !== "scheduled") return "该会话没有宿主委派资格";
    const task = this.deps.store.getTask(ctx.taskId);
    if (!task || task.sessionId !== ctx.sessionId) return "宿主任务归属校验失败";
    return null;
  }

  get currentTaskId(): string | null {
    return this.currentTask?.id ?? null;
  }

  /** 会话记录更新后同步（如 sessionFile 落盘回填）。 */
  syncSessionRecord(latest: Session): void {
    this.session.sessionFile = latest.sessionFile;
    this.session.queueState = latest.queueState;
    this.session.confirmTools = latest.confirmTools;
  }

  /**
   * 模型配置应用后更新模型栈引用（issue 21 §4）：下一个任务开始时
   * runInner 经 deps.modelCatalog.resolve 重新解析。存活 SDK 会话的
   * streamFn/setModel 闭包仍持有创建时的旧 ModelRuntime（对新增/变更
   * provider 会误判 Unknown provider/缺 key），标记后由 runInner 在下一
   * 任务开始前丢弃重建；历史在会话文件中，不受影响。进行中的任务不受
   * 影响（受影响 provider 不可能有活动任务——应用门闩保证）。
   */
  updateModelDeps(deps: { modelRuntime: ModelRuntime; modelCatalog: ModelCatalog; model: any; reviewer?: ApprovalReviewer }): void {
    this.deps.modelRuntime = deps.modelRuntime;
    this.deps.modelCatalog = deps.modelCatalog;
    this.deps.model = deps.model;
    this.deps.reviewer = deps.reviewer;
    if (this.sdk) this.sdkConfigStale = true;
  }

  private hostToolRuntime(): HostToolRuntime {
    return {
      registry: this.registry,
      toolClass: this.profile.toolClass,
      call: { taskContext: () => null, bindCall: this.bindHostCall },
      identity: {
        verifyMain: (ctx) => this.verifyMainBinding(ctx),
        verifyHost: (ctx) => this.verifyDelegationHost(ctx),
      },
      data: {
        recordMemory: (ctx, memoryId) => {
          if (this.profile.workflow && this.currentTask?.id === ctx.taskId) this.deps.workflow?.recordMemory?.(this.currentTask, memoryId);
        },
        accessor: () => this.accessor(),
        sessionReadable: (ctx, sessionId, category) => this.dataSessionReadable(ctx, sessionId, category),
        sourceReadable: (ctx, ref) => this.dataSourceReadable(ctx, ref),
      },
      approval: {
        request: (input) => this.approvals.request(input),
        requestStanding: (input) => this.approvals.requestStanding(input),
      },
      effects: {
        recordArtifact: (hostOpId, artifactId) => this.recordHostToolArtifact(hostOpId, artifactId),
        markEffectUnknown: (hostOpId) => {
          const task = this.currentTask;
          if (task) this.deps.store.withTx(() => this.deps.ledger.markEffectUnknown(task, hostOpId));
        },
      },
      skills: () => this.pinnedSkills,
    };
  }

  private async ensureSdk(model: any, thinkingLevel: ThinkingLevel): Promise<AgentSession> {
    if (this.sdk) return this.sdk;
    const hostToolSet = buildHostToolSet(
      this.deps.hostToolFamilies.filter((family) =>
        this.allows(family.category) || (family.category === "subagent" && this.profile.toolClass === "subagent")),
      this.hostToolRuntime(),
    );
    const subAgentTools = this.profile.subAgentTools;
    const allTools = [
      ...(this.allows("coding") ? this.deps.toolFactory({ registry: this.registry, router: this.router })
        .filter(tool => !this.profile.workflow || this.profile.toolClass !== "main" || subAgentAllows({ write: true, review: false }, tool.name)) : []),
      ...(this.profile.workflow && !this.allows("coding")
        ? this.deps.toolFactory({ registry: this.registry, router: this.router }).filter(tool => tool.name === "read" || tool.name === "read_artifact") : []),
      ...(subAgentTools
        ? this.deps.toolFactory({ registry: this.registry, router: this.router })
            .filter((t) => subAgentAllows(subAgentTools, t.name))
        : []),
      ...hostToolSet.tools,
      ...this.pendingMcpToolDefs,
    ];
    this.pendingMcpToolDefs = [];
    this.hostToolNames = hostToolSet.names;
    this.allToolNames = allTools.map((t) => t.name);
    if (new Set(this.allToolNames).size !== allTools.length) throw new Error("工具装配存在重复名字");
    this.sdk = await createSdkSession({
      session: this.session,
      sessionsDir: this.deps.sessionsDir,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.modelRuntime,
      model,
      thinkingLevel,
      tools: allTools,
      systemPrompt: this.profile.workflow
        ? SYSTEM_PROMPTS.workflow
        : this.profile.toolSignature === "scheduled"
        ? `${SYSTEM_PROMPTS.main}\n- 当前是宿主为本次定时计划创建的独立执行上下文，不读取主聊天或前次运行历史。任务按计划保存的模式执行，子任务与汇总属于本次运行。完成全部工作后给出最终结果或失败原因；宿主向创建时固定的目标发送一次最终回报，无目标则保存结果。无需为这份默认回报调用 notification_enqueue；任务明确要求另行发送时才用该工具。`
        : SYSTEM_PROMPTS[this.profile.toolClass],
      hooks: {
        onToolCall: (event) => this.handleToolCall(event),
        onSessionEvent: (event) => this.handleSessionEvent(event),
        bindHostApi: (api) => {
          this.markerApi = api.appendEntry;
        },
        onContext: (messages) => this.handleContext(messages),
      },
    });
    this.wrapStreamFunction(this.sdk);
    return this.sdk;
  }

  /** 工具执行入口按 sdkCallId 绑定宿主上下文（execute 包装时调用）。 */
  private readonly bindHostCall = (sdkCallId: string): HostCall => {
    const ctx = this.hostToolCalls.get(sdkCallId) ?? null;
    if (ctx && this.profile.workflow) {
      const task = this.deps.store.getTask(ctx.taskId);
      if (!task || task.sessionId !== ctx.sessionId || this.verifyWorkflowTask(task) !== null) {
        this.hostToolCalls.delete(sdkCallId);
        throw new WorkflowError("source_invalid");
      }
    }
    let released = false;
    return {
      context: ctx,
      release: () => {
        if (released) return;
        released = true;
        this.hostToolCalls.delete(sdkCallId);
      },
    } satisfies HostCall;
  };

  /** 宿主工具（不经路由器）登记产物引用（issue 09：接到 task.tool_result 事件）。 */
  private recordHostToolArtifact(hostOpId: string, artifactId: string): void {
    const list = this.hostToolArtifacts.get(hostOpId) ?? [];
    list.push(artifactId);
    this.hostToolArtifacts.set(hostOpId, list);
  }

  // ---------- 模型上下文（组装见 context-assembly）与发送前检查 ----------

  /** context 钩子：交给本任务的组装实例；任务之外的调用不修改视图。 */
  private handleContext(messages: any[]): Promise<{ messages: any[] } | undefined> | undefined {
    const sdk = this.sdk;
    if (!this.assembly || !sdk) return undefined;
    return this.assembly.assemble(messages, {
      systemPrompt: sdk.systemPrompt ?? "",
      tools: (sdk.agent.state.tools ?? []) as any[],
      model: sdk.model,
      sessionFile: sdk.sessionFile,
    });
  }

  /**
   * 包装公开的 sdk.agent.streamFunction：委托原发送函数前先做本模块的检查，
   * 再由组装实例收紧 maxTokens、复核上下文并落选择记录。扩展异常被 pi 吞掉，
   * 只有这里能可靠阻止发送；不重写模型循环，保留取消信号与事件语义。
   */
  private wrapStreamFunction(sdk: AgentSession): void {
    const agent = sdk.agent as any;
    if (this.originalStreamFn) return; // 已包装
    this.originalStreamFn = agent.streamFunction;
    const original = this.originalStreamFn;
    agent.streamFunction = async (model: any, context: any, options: any) => {
      const task = this.currentTask;
      const assembly = this.assembly;
      // SDK 在异步 context 钩子之后仍可能走到发送函数，取消必须在此兜底。
      if (!task || !assembly || this.stopRequested || options?.signal?.aborted) {
        throw new ContextSendBlocked("task_canceled:任务已停止，拒绝发送模型请求");
      }
      try {
        this.checkBeforeSend(task, model, context, options);
        ({ model, options } = assembly.prepareSend(model, context, options));
      } catch (err) {
        if (err instanceof ContextSendBlocked) this.lastBlockedReason = err.message;
        throw err;
      }
      this.beginModelRequest(task);
      const stream = await original.call(agent, model, context, options);
      assembly.afterSend(stream);
      return stream;
    };
  }

  /** 发送前本模块的检查（模型选择与工具白名单）：失败即抛（宿主原因已保存；Driver 据此中断任务）。 */
  private checkBeforeSend(task: Task, model: any, context: any, options: any): void {
    const workflowProblem = this.verifyWorkflowTask(task);
    if (workflowProblem) throw new ContextSendBlocked(`workflow_source_invalid:${workflowProblem}`);
    if (hasImageInput(context?.messages ?? []) && !model?.input?.includes("image")) {
      throw new ContextSendBlocked(`${IMAGE_INPUT_UNSUPPORTED}:所选模型不支持图片输入`);
    }
    const expected = task.modelSelection;
    if (!expected || model?.provider !== expected.provider || model?.id !== expected.modelId ||
        this.sdk?.thinkingLevel !== expected.thinkingLevel || (options?.reasoning ?? "off") !== expected.thinkingLevel) {
      throw new ContextSendBlocked("model_selection_mismatch:实际模型或思考强度与任务记录不一致");
    }
    // SubAgent 的资料授权复核（agent-direction issue 11；issue 12 并集）：每次向
    // 模型发送上下文前重新 verify 本会话全部任务的来源引用并集——复用保留的
    // 上下文含旧工作资料，旧资料撤销后同样阻止发送（快照正文不重新解析）。
    // issue 16：有写入目标的工作不发资料快照（readScope.paths 恒空），无
    // sourceRefs 可核，复核在此为空集通过。
    if ((this.profile.restricted || this.profile.toolSignature === "scheduled") && this.deps.verifyTaskSources) {
      const refs = this.deps.store
        .listTasksBySession(this.session.id)
        .flatMap((t) => t.readScope?.sourceRefs ?? []);
      if (refs.length > 0) {
        const problem = this.deps.verifyTaskSources(this.session.projectId, refs);
        if (problem) throw new ContextSendBlocked(`task_sources_revoked:${problem}`);
      }
    }
    // 工具可用性（架构工单 03）：发送载荷中的每个工具都必须在本任务允许的集合内
    // （按实际载荷检查，覆盖全部注册来源）
    if (Array.isArray(context?.tools)) {
      const forbidden = context.tools
        .map((t: any) => t?.name ?? t?.function?.name)
        .filter((name: unknown) => typeof name !== "string" || !this.taskTools?.allowed.has(name))
        .map((name: unknown) => `${String(name)}（${typeof name === "string" ? this.toolRejection(name) : "工具名无效"}）`);
      if (forbidden.length > 0) {
        throw new ContextSendBlocked(`task_tools_forbidden:任务工具白名单不含 ${forbidden.join(",")}（发送载荷已阻断）`);
      }
    }
  }

  /** 最终检查抛出的阻断原因（发送侧记录，任务结束路径据此识别）。 */
  private lastBlockedReason: string | null = null;

  /**
   * 识别任务结束是否由最终检查阻断引起：优先取发送侧记录的原因；
   * 兜底匹配最后 assistant 的错误消息（SDK 可能把发送前异常转成
   * stopReason=error）。返回 null = 非阻断结束。
   */
  private consumeBlockedReason(lastAssistant: any): string | null {
    const recorded = this.lastBlockedReason;
    this.lastBlockedReason = null;
    if (recorded) return recorded;
    const message: string = lastAssistant?.errorMessage ?? "";
    if (lastAssistant?.stopReason === "error") {
      for (const prefix of ["context_budget_exceeded", "context_selection_failed", "context_selection_missing", "context_pairing_invalid"]) {
        if (message.includes(prefix)) {
          const idx = message.indexOf(prefix);
          return message.slice(idx).split("\n", 1)[0] ?? prefix;
        }
      }
    }
    return null;
  }

  private appendMarker(customType: string, data: unknown): void {
    // SDK 会话创建前标记 API 不可用；此时代码路径不应产生标记
    this.markerApi?.(customType, data);
  }

  // ---------- 运行 ----------

  async run(task: Task): Promise<void> {
    if (this.runPromise) {
      throw new Error(`会话 ${this.session.id} 已有任务在运行`);
    }
    if (this.registry.list().length && this.deps.store.listAllOccupancy().some((occupancy) => occupancy.taskId === this.managedTaskId)) {
      throw new ExecutionError("tool_process_unreaped", "旧任务的执行单元尚未核实退出，拒绝运行新任务");
    }
    // 执行画像（架构工单 08）：任务开始算一次、钉到任务结束。已退役归档会话不运行
    // 任务（提交入口与队列兜底先行拒绝），走到这里即抛。
    const identity = this.deps.store.getSessionIdentity(this.session.id);
    if (!identity) throw new Error(`会话不存在：${this.session.id}`);
    const workflow = this.deps.workflow?.resolve(task);
    if (identity.kind === "subagent" && identity.workflow && !workflow) throw new WorkflowError("source_invalid");
    this.pinnedProfile = executionProfile({
      identity,
      writeTarget: Boolean(task.workId && this.deps.store.getWorkDelegation(task.workId)?.writeTarget),
      review: identity.kind === "subagent" && (this.deps.taskMcp?.(task) ?? false),
      planMode: task.planMode,
      workflow,
    });
    this.currentTask = task;
    this.stopRequested = false;
    this.stopPromise = null;
    this.flushedEntryIds = new Set();
    this.callMap = new Map();
    this.currentMsgId = null;
    this.pendingEntryMsgIds = [];
    this.currentPreview = null;
    this.textBlock = null;
    this.nextTextIndex = 0;
    this.sourceTextBlocks.clear();
    this.lastFragmentAt = 0;
    this.thinking = null;
    this.thinkingIndex = null;
    this.registry.clear();
    this.managedTaskId = task.id;
    this.processStops = new Map();
    this.ending = false;
    this.hostToolCalls = new Map();
    this.hostToolArtifacts = new Map();
    this.lastBlockedReason = null;
    this.pendingUserImages = [];
    this.taskTools = null;
    this.pinnedSkills = this.profile.restricted && !this.profile.workflow ? null : this.allows("skills") ? loadSkillLibrary(this.deps.agentDir) : null;
    // SubAgent 结果注入（agent-direction issue 11）与工作内消息注入（issue 13）：
    // 摘要与消息正文由宿主写定，不伪装拥有者新请求，也不授予委派权限。
    const injection = this.deps.parentInjection?.(this.session.id);
    const subagentResults = injection?.results.length
      ? injection.results.map((t) => ({ workId: t.workId!, subAgentId: t.subAgentId!, taskId: t.id, status: t.status, summary: t.resultSummary ?? "" }))
      : undefined;
    const subagentMessages = injection?.messages.length ? injection.messages : undefined;
    this.assembly = beginContextAssembly({
      task,
      session: this.session,
      accessor: this.accessor(),
      restricted: this.profile.restricted,
      plan: this.profile.plan,
      skills: this.pinnedSkills,
      subagentResults,
      subagentMessages,
    }, this.deps);
    this.runPromise = this.runInner(task);
    try {
      await this.runPromise;
    } finally {
      await this.stopPromise;
      this.assembly?.abort();
      this.assembly = null;
      this.flushOutput();
      this.endThinking();
      // 任务终态后回收本任务持有的 MCP 连接（所有退出路径统一兜底）
      await this.closeMcpConns();
      this.mcpToolNames = new Set();
      this.runPromise = null;
      this.currentTask = null;
    }
  }

  /** 任务开始的 MCP 工具计划：重读项目配置并发现工具；无 MCP 配置时零开销。 */
  private async planMcp(task: Task): Promise<McpTaskPlan> {
    if (this.verifyWorkflowTask(task)) throw new WorkflowError("source_invalid");
    if (!this.deps.mcp) return EMPTY_MCP_PLAN;
    // 画像决定是否规划：类别含 mcp，或 SubAgent 宿主评审任务另开只读 MCP（issue 19）
    if (!this.profile.planMcp) return EMPTY_MCP_PLAN;
    return planMcpTaskTools({
      mcpStore: this.deps.mcp.store,
      credentials: this.deps.credentials,
      projectId: this.session.projectId,
      dispatch: (sdkCallId, params, signal) => this.router.executeRouted(sdkCallId, params, signal),
      connectTimeoutMs: this.deps.mcp.connectTimeoutMs,
      listTimeoutMs: this.deps.mcp.listTimeoutMs,
      callTimeoutMs: this.deps.mcp.callTimeoutMs,
    });
  }

  /**
   * 工具清单签名变化时丢弃 SDK 会话（issue 16 §4 既定回退路径）：SDK 的
   * 工具白名单在创建时固定（session-factory 封闭运行时），无法安全替换定义；
   * ensureSdk 随后从同一历史文件重开会话并重新绑定宿主钩子，历史不丢。
   */
  private dropSdkForToolChange(): void {
    if (!this.sdk) return;
    this.sdk.dispose();
    this.sdk = null;
    this.originalStreamFn = null;
    this.markerApi = null;
  }

  /** 回收当前任务持有的 MCP 连接（幂等；迟到结果由 SDK 丢弃）。 */
  private async closeMcpConns(): Promise<void> {
    const plan = this.currentMcpPlan;
    this.currentMcpPlan = null;
    if (!plan) return;
    await Promise.all([...plan.connections.values()].map((c) => c.close()));
  }

  private async runInner(task: Task): Promise<void> {
    // 取消窗口（agent-direction issue 14）：任务已转 running、currentTask 尚未
    // 登记时到达的取消先持久化了 cancel_requested；这里直接按取消意图定态
    // canceled，不调用模型、不建 SDK 会话。
    // ponytail: 落在本窗口的取消不保留原始原因（超时取消会记为 canceled 而非
    // timeout）；原因在 requestStop 路径才有载体，窗口内没有。窗口写原因需给
    // 任务再加一列，暂不值得。
    if (this.deps.store.getTask(task.id)?.cancelRequested) {
      await this.finalize(task, "canceled", { interruptReason: "cancel_requested" });
      return;
    }
    let sdk: AgentSession;
    try {
      if (!task.modelSelection) throw new Error("model_selection_missing:任务未记录模型配置");
      const model = await this.deps.modelCatalog.resolve(task.modelSelection);
      this.pendingUserImages = taskImageReferences(task, this.deps.store);
      if (this.pendingUserImages.length > 0 && !model?.input?.includes("image")) {
        throw new Error(`${IMAGE_INPUT_UNSUPPORTED}:所选模型不支持图片输入`);
      }
      // 模型配置应用后（issue 21 §4）：旧 SDK 会话闭包持有旧 ModelRuntime，
      // 任务边界处丢弃，由 ensureSdk 以新模型栈重建（历史在会话文件中）
      if (this.sdkConfigStale) {
        this.sdkConfigStale = false;
        this.dropSdkForToolChange();
      }
      // MCP（issue 16）：任务开始重读配置并发现工具，钉版本任务工具清单；
      // 单个服务初始化失败降级为不可用事件，不阻断任务
      const mcpPlan = await this.planMcp(task);
      // SDK 会话签名 = 画像工具集 + MCP 清单（架构工单 08）：复用的 SubAgent 从只读
      // 转到写入工作时重建，正确性不依赖 Runtime 每任务释放 Driver
      const toolSignature = `${this.profile.toolSignature}|${mcpPlan.signature}`;
      if (this.sdk && toolSignature !== this.toolSignature) this.dropSdkForToolChange();
      this.pendingMcpToolDefs = mcpPlan.toolDefs;
      // 计划先登记：ensureSdk 失败时 catch 路径的 closeMcpConns 才能回收连接
      this.currentMcpPlan = mcpPlan;
      sdk = await this.ensureSdk(model, task.modelSelection.thinkingLevel);
      this.pendingMcpToolDefs = [];
      this.toolSignature = toolSignature;
      this.mcpToolNames = new Set(mcpPlan.toolDefs.map((t) => t.name));
      for (const u of mcpPlan.unavailable) {
        this.deps.store.withTx(() => {
          this.deps.store.appendEvent(
            {
              type: "mcp.service_unavailable",
              serviceId: u.service.id,
              projectId: u.service.projectId,
              taskId: task.id,
              sessionId: task.sessionId,
              name: u.service.name,
              endpoint: u.service.endpoint,
              reason: u.reason,
            },
            { taskId: task.id, sessionId: task.sessionId },
          );
        });
      }
      if (sdk.model?.provider !== model.provider || sdk.model?.id !== model.id) await sdk.setModel(model);
      sdk.setThinkingLevel(task.modelSelection.thinkingLevel);
      if (sdk.model?.provider !== model.provider || sdk.model?.id !== model.id || sdk.thinkingLevel !== task.modelSelection.thinkingLevel) {
        throw new Error("model_selection_mismatch:SDK 未应用任务模型配置");
      }
    } catch (err) {
      await this.closeMcpConns();
      await this.finalize(task, "failed", { errorMessage: `SDK 会话创建失败：${(err as Error).message}` });
      return;
    }

    // 任务开始固定本任务允许的工具（架构工单 03）：完整注册表减去任务收窄（计划模式、
    // 宿主按任务收窄）与项目关闭的 Web Search（issue 20：模型不可见、系统提示同步重建；
    // 任务内的禁用由工具按调用新鲜检查立即阻止）。每次从完整注册表重算，宿主对当前
    // 任务的限制不带入下一任务。
    const allowTaskTool = this.deps.allowTaskTool;
    const subAgentTools = this.profile.subAgentTools;
    this.taskTools = taskToolSet({
      registered: this.allToolNames,
      plan: this.profile.plan,
      webSearchEnabled: this.deps.store.getProject(this.session.projectId)?.webSearch !== "disabled",
      mcpEffect: (name) => this.currentMcpPlan?.tools.get(name)?.effect,
      // SubAgent 任务收窄（issue 16）：画像工具集决定清单（装配、发送前与调用门
      // 同一结论）；收窄不进 workerKey。宿主评审任务（issue 19）另加 effect=read
      // 的 MCP（只读资料入口，写与副作用不明的 MCP 留在拒绝集）
      narrow:
        this.profile.workflow
          ? (name, effect) => workflowAllows(this.profile.workflow!, name) && (!allowTaskTool || allowTaskTool(task, name, effect))
          : subAgentTools
          ? (name, effect) => subAgentAllows(subAgentTools, name, effect)
          : allowTaskTool
            ? (name, effect) => allowTaskTool(task, name, effect)
            : undefined,
    });
    sdk.setActiveToolsByName([...this.taskTools.allowed]);

    // 会话文件路径尽早落库：崩溃后重启才能打开同一份 JSONL 而不是另起新文件
    const currentFile = sdk.sessionFile;
    if (currentFile && currentFile !== this.session.sessionFile) {
      this.deps.store.withTx(() => {
        this.deps.store.setSessionFile(this.session.id, currentFile);
        this.session.sessionFile = currentFile;
      });
    }

    if (this.stopRequested) {
      // 停止意图先于 prompt 到达：直接进入中断终态（条件更新仲裁竞争）
      await this.killManagedProcesses();
      await this.finalize(task, "interrupted", { interruptReason: "aborted" });
      return;
    }

    // 拥有者显式调用技能（/skill:<名称> [参数]）：按钉版技能库展开后作为用户消息
    // 进入历史；不交给 pi 的 /skill: 展开。资料受限会话不识别。
    let promptText: string;
    try {
      promptText = this.profile.restricted ? task.input : expandSkillCommand(this.pinnedSkills, task.input);
    } catch (err) {
      await this.finalize(task, "failed", { errorMessage: (err as Error).message });
      return;
    }

    this.appendMarker(TASK_START_MARKER, { taskId: task.id, requestId: task.requestId });
    try {
      await sdk.prompt(promptText);
    } catch (err) {
      await this.killManagedProcesses();
      if (!this.stopRequested) {
        await this.finalize(task, "failed", { errorMessage: (err as Error).message });
      }
      return;
    }

    await this.killManagedProcesses();
    if (this.stopRequested) {
      // requestStop 拥有终态；这里只做清理
      return;
    }

    const lastAssistant = findLastAssistant(sdk.messages as any[]);
    const stopReason: string = lastAssistant?.stopReason ?? "error";

    // 请求前最终检查阻断（预算/配对/选择缺失）：中断并暂停队列，不摘要、
    // 不缩短输入后重试。依据宿主保存的原因识别，不靠 prompt() reject 文案。
    const blockedReason = this.consumeBlockedReason(lastAssistant);
    if (blockedReason !== null) {
      if (blockedReason.startsWith(`${IMAGE_INPUT_UNSUPPORTED}:`)) {
        this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "failed", reason: blockedReason });
        await this.finalize(task, "failed", { errorMessage: blockedReason });
        return;
      }
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: blockedReason });
      this.pauseQueue(blockedReason);
      await this.finalize(task, "interrupted", { interruptReason: blockedReason });
      return;
    }

    if (stopReason === "aborted") {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: "aborted" });
      await this.finalize(task, "interrupted", { interruptReason: "aborted" });
      return;
    }

    const contextWindow: number = sdk.model?.contextWindow ?? 0;
    if (lastAssistant && isContextOverflow(lastAssistant, contextWindow)) {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: "context_overflow" });
      this.pauseQueue("context_overflow");
      await this.finalize(task, "interrupted", { interruptReason: "context_overflow" });
      return;
    }

    if (stopReason === "error") {
      const message = lastAssistant?.errorMessage ?? "模型返回错误";
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "failed" });
      await this.finalize(task, "failed", { errorMessage: message });
      return;
    }

    // 自然完成：先写入任务结束标记（它本身就是"历史已写完"的证据），
    // 再核对最终历史确实落盘，最后宣布 completed
    this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "completed" });
    const verification = this.verifyAndLinkHistory(task);
    if (verification.ok) {
      await this.finalize(task, "completed", {});
    } else {
      await this.finalize(task, "interrupted", { interruptReason: verification.reason! });
    }
  }

  // ---------- 停止路径（interrupt / cancel / 后台停止共用） ----------

  /**
   * 显式停止当前执行。顺序：提交停止意图 → 解除确认等待 → abort() →
   * 回收受管进程组 → 条件更新终态并释放占用。与自然完成竞争时条件更新
   * 保证只有一个终态生效。
   */
  async requestStop(
    task: Task,
    opts: { terminal: "canceled" | "interrupted"; reason: string; cancelIntent: boolean; modeSwitchFailure?: { to: AccessMode; reason: string } },
  ): Promise<boolean> {
    if (this.currentTask?.id !== task.id) return false;
    this.stopPromise ??= this.requestStopInner(task, opts);
    return this.stopPromise;
  }

  private async requestStopInner(
    task: Task,
    opts: { terminal: "canceled" | "interrupted"; reason: string; cancelIntent: boolean; modeSwitchFailure?: { to: AccessMode; reason: string } },
  ): Promise<boolean> {
    this.stopRequested = true;
    this.assembly?.abort();

    // 1. 提交停止意图（独立事务持久化）
    this.deps.store.withTx(() => {
      this.deps.store.setCancelRequested(task.id, opts.cancelIntent);
    });

    // 在中止与回收之前快照已开始执行的操作（工具操作账本）：效果以停止瞬间为准，
    // 中止期间才落下的结果不改变结论
    const uncertainAtStop = this.deps.ledger.beginStop(task.id);

    // 2. 解除确认等待（门以 block 结束，不执行该操作）；进行中的自动审查一并中止
    this.approvals.cancelAll();

    // 3. 中止模型调用与确认等待；受管工具进程组的终止与 abort 并行进行：
    //    abort() 会等待在执行的工具返回，若工具在等待子进程退出，必须同时
    //    回收进程组（TERM → 超时 KILL）才能解除等待，否则互相死锁。
    const abortPromise = this.sdk?.isStreaming ? this.sdk.abort().catch(() => {
      // SDK 中止失败仍由执行单元回收与任务终态保护占用。
    }) : null;
    const reaped = await this.killManagedProcesses();
    if (abortPromise) await abortPromise;
    // MCP 连接随任务停止回收：在途调用已被 abort 中断，迟到结果由 SDK 丢弃
    await this.closeMcpConns();

    // 3b. 中止完成后按账本的分类器补记结果缺失的操作：无写入效果、审批未消费、
    //     工具族核实（应用库回执、调度账本、子任务、接收账本）；其余与快照一起
    //     在终态事务里标 effect_unknown
    const effectUnknownOpIds = this.deps.store.withTx(() => this.deps.ledger.settleTask(task, uncertainAtStop));

    // 4. 终态与占用释放（仅当尚未被自然完成抢先）
    await this.finalize(task, opts.terminal, {
      interruptReason: opts.reason,
      effectUnknownOpIds,
      keepOccupancy: !reaped,
      occupancyIssueReason: reaped ? null : opts.modeSwitchFailure ? "mode_switch_unverified" : "tool_process_unreaped",
      modeSwitchFailure: opts.modeSwitchFailure,
    });
    return reaped;
  }

  private async killManagedProcesses(): Promise<boolean> {
    this.ending = true;
    return this.stopManagedProcesses(this.managedTaskId!);
  }

  /** 临时执行单元归入当前任务；收尾开始后拒绝登记，调用方不得再启动单元。 */
  registerManagedProcess(taskId: string, entry: ManagedEntry): void {
    if (this.currentTask?.id !== taskId) throw new ExecutionError("task_mismatch", "执行单元不属于当前任务");
    if (this.ending || this.stopRequested || this.stoppingProcesses) throw new ExecutionError("task_ending", "任务正在停止执行单元，拒绝启动新的执行单元");
    this.registry.register(entry);
  }

  /** 已有聚合会消费临时单元的停止结果，临时调用无需另发停止请求。 */
  get stoppingManagedProcesses(): boolean {
    return this.stoppingProcesses > 0;
  }

  /** 回收任务的全部受管单元；重复与并发停止复用每个单元的核实结论。 */
  async stopManagedProcesses(taskId: string): Promise<boolean> {
    if (this.managedTaskId !== taskId) return true;
    this.stoppingProcesses++;
    try {
      // 执行意图落库（hook 处）与工作进程登记（工具 execute 处）之间隔着
      // promise 边界；让出一个宏任务，使已记录意图的派发先完成登记，再读登记表
      await new Promise((r) => setImmediate(r));
      const processes = this.registry.list();
      if (processes.length === 0) return true;
      let allReaped = true;
      for (const proc of processes) {
        let stop = this.processStops.get(proc);
        if (!stop) {
          stop = Promise.resolve().then(() => proc.stop()).catch((err: unknown) => {
            const code = err instanceof ExecutionError ? err.code : "stop_failed";
            process.stderr.write(`[ruukoto:driver] 执行单元 ${proc.id} 停止未核实（${code}），保留目录占用待拥有者核实\n`);
            return false;
          });
          this.processStops.set(proc, stop);
        }
        const ok = await stop;
        if (!ok) allReaped = false;
      }
      return allReaped;
    } finally {
      this.stoppingProcesses--;
    }
  }

  // ---------- 终态与占用 ----------

  private async finalize(
    task: Task,
    to: "completed" | "failed" | "canceled" | "interrupted",
    extra: {
      interruptReason?: string;
      errorMessage?: string;
      /** 已开始但结果未知的操作（在停止前快照）；拒绝/未执行的审批不在其中。 */
      effectUnknownOpIds?: string[];
      keepOccupancy?: boolean;
      occupancyIssueReason?: string | null;
      modeSwitchFailure?: { to: AccessMode; reason: string };
    },
  ): Promise<void> {
    const reaped = await this.killManagedProcesses();
    const keepOccupancy = extra.keepOccupancy || !reaped;
    this.flushOutput();
    this.endThinking();
    const changed = this.deps.store.withTx(() => {
      const store = this.deps.store;
      return store.endTask(task.id, ["running", "awaiting_confirmation"], to, {
        interruptReason: extra.interruptReason ?? null,
        errorMessage: extra.errorMessage ?? null,
        endedAt: new Date().toISOString(),
        keepOccupancy,
        occupancyIssueReason: extra.occupancyIssueReason ?? (reaped ? null : "tool_process_unreaped"),
        modeSwitchFailure: extra.modeSwitchFailure,
        onChanged: () => {
          for (const opId of extra.effectUnknownOpIds ?? []) this.deps.ledger.markEffectUnknown(task, opId);
        },
      });
    });
    // 占用释放后唤醒其他会话的排队任务
    if (changed && !keepOccupancy) this.deps.onOccupancyReleased();
  }

  private pauseQueue(reason: string): void {
    this.deps.store.withTx(() => {
      this.deps.store.setSessionQueueState(this.session.id, "paused", reason);
      this.deps.store.appendEvent(
        { type: "session.queue_paused", sessionId: this.session.id, reason },
        { sessionId: this.session.id },
      );
    });
  }

  // ---------- tool_call 门 ----------

  /**
   * 模式切换等已请求待生效的变化在此边界应用：没有执行中的工具时，先
   * 应用切换（解除旧等待、回收旧执行单元），再让新调用按当前模式执行。
   */
  private async boundaryTask(task: Task): Promise<Task> {
    if (!task.pendingAccessMode || task.pendingAccessMode === task.accessMode) return task;
    try {
      if (!await this.stopManagedProcesses(task.id)) {
        throw new ExecutionError("mode_switch_unverified", "无法核实旧执行单元已退出，模式切换失败");
      }
      return await this.router.prepareToolBoundary(task);
    } catch (err) {
      // 切换失败（无法核实旧执行单元退出）：任务无法安全继续
      this.stopRequested = true;
      const reason = err instanceof ExecutionError ? err.code : "mode_switch_failed";
      await this.finalize(task, "interrupted", {
        interruptReason: reason,
        effectUnknownOpIds: [],
        occupancyIssueReason: "mode_switch_unverified",
        modeSwitchFailure: { to: task.pendingAccessMode, reason },
      });
      throw err;
    }
  }

  private async handleToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const current = this.currentTask;
    if (!current) return undefined;
    const workflowProblem = this.verifyWorkflowTask(current);
    if (workflowProblem) return { block: true, reason: `工作流步骤授权失效：${workflowProblem}` };
    // 工具可用性（架构工单 03）：不在本任务允许集合内的调用一律阻止（激活侧已过滤，
    // 此处兜底注册泄漏/未知路径；不记录执行意图）
    if (!this.taskTools?.allowed.has(event.toolName)) {
      return { block: true, reason: `任务工具白名单不含 ${event.toolName}（${this.toolRejection(event.toolName)}）` };
    }
    const store = this.deps.store;

    // 每次调用读取当前任务（模式/权限版本/授予路径），不使用缓存
    let task = store.getTask(current.id) ?? current;
    const params = { ...(event.input as Record<string, unknown>) };

    try {
      task = await this.boundaryTask(task);
    } catch {
      return { block: true, reason: "模式切换失败，任务已停止" };
    }
    if (this.stopRequested) {
      return { block: true, reason: "任务已停止，确认等待解除" };
    }

    // 宿主操作 id 与模型调用 id 分开：不同任务复用调用 id 不串用批准
    const hostOpId = randomId("op");
    this.callMap.set(event.toolCallId, hostOpId);
    store.withTx(() => {
      store.recordToolIntent({
        id: hostOpId,
        taskId: task.id,
        sessionId: task.sessionId,
        toolName: event.toolName,
        sdkCallId: event.toolCallId,
        params,
      });
    });

    if (ROUTED_TOOL_NAMES.has(event.toolName)) {
      // 真实编码工具/结构化审批/产物查询：模式绑定的路由器执行。
      // 工具定义的 execute 经 registerRoutedCall 拿到宿主操作 id 与任务。
      this.router.registerRoutedCall(event.toolCallId, hostOpId, task, event.toolName);
      return undefined;
    }

    // 资料与记忆宿主工具（issue 05）、Web Search 宿主工具（issue 20）与
    // main 应用数据工具（issue 02）：身份由宿主注入，不经路由器/工作进程
    if (this.hostToolNames.has(event.toolName)) {
      this.hostToolCalls.set(event.toolCallId, {
        taskId: task.id,
        sessionId: task.sessionId,
        projectId: this.session.projectId,
        hostOpId,
      });
      return undefined;
    }

    // MCP 动态工具（issue 16/18）：按任务钉版的工具名集合判定，经路由器统一
    // 处理（配置核对、模式判定、审批与单次消费、发送）；必须在 mock
    // confirmTools 路径之前，未登记的工具不得落入放行
    if (this.mcpToolNames.has(event.toolName)) {
      this.router.registerRoutedCall(event.toolCallId, hostOpId, task, event.toolName);
      return undefined;
    }

    // mock 测试路径：confirmTools 门（仅模拟测试使用，不决定生产权限）
    if (!this.session.confirmTools.includes(event.toolName)) {
      return undefined;
    }

    // 经审批闸门：批准后先消费（= 执行开始）再放行 SDK 执行
    const approval = await this.approvals.request({
      task,
      hostOpId,
      toolName: event.toolName,
      params,
      scope: { kind: "tool", workspaceOnly: true },
    });
    return approval.approved ? undefined : { block: true, reason: approval.text };
  }

  /** 运行时入口：等待中的审批因模式切换立即失效（Runtime 调用）。 */
  supersedeWaiters(): void {
    this.approvals.supersedeAll();
  }

  /** 当前任务运行的完成信号（无任务运行时 resolve）。用于审批闸门外的等待方
   * 在任务自然结束时回落（避免控制面请求永久悬挂）。 */
  taskCompletion(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  /** 控制面/IM 应答确认：条件更新 pending → approved/rejected；失效应答返回 false。 */
  resolveConfirmation(confirmationId: string, decision: "approved" | "rejected", opts?: { txExtra?: () => void | { standingPermission?: { id: string; version: number } } }): boolean {
    return this.approvals.resolve(confirmationId, decision, opts);
  }

  /** 定向解除指定审批的等待（IM 绑定失效后 release waiter，issue 08）。 */
  supersedeApprovals(ids: ReadonlySet<string>): void {
    this.approvals.supersedeConfirmations(ids);
  }

  // ---------- 会话事件观察 ----------

  /** 任务当前的输出预览（全量在内存；供重连重建，事件发送有界增量）。 */
  currentOutputPreview(taskId: string): { messageId: string; text: string } | null {
    if (this.currentTask?.id !== taskId || !this.currentPreview) return null;
    return this.currentPreview;
  }

  /** 在最终请求校验之后、调用 provider 之前开始计时，排除排队与上下文组装。 */
  private beginModelRequest(task: Task): void {
    this.flushOutput();
    this.endThinking();
    this.currentMsgId = randomId("msg");
    this.pendingEntryMsgIds.push(this.currentMsgId);
    this.currentPreview = null;
    this.textBlock = null;
    this.nextTextIndex = 0;
    this.sourceTextBlocks.clear();
    this.lastFragmentAt = 0;
    this.startThinking(task);
  }

  private startThinking(task: Task): void {
    this.thinking = {
      type: "task.thinking", taskId: task.id, sessionId: task.sessionId,
      thinkingId: randomId("think"), messageId: this.currentMsgId!,
      startedAt: new Date().toISOString(), endedAt: null, text: "",
    };
    this.thinkingIndex = null;
    this.emitThinking();
  }

  private emitThinking(): void {
    if (!this.thinking) return;
    const body = { ...this.thinking };
    this.deps.store.withTx(() => this.deps.store.appendEvent(body, { taskId: body.taskId, sessionId: body.sessionId }));
    this.lastThinkingAt = Date.now();
  }

  private endThinking(): void {
    if (!this.thinking) return;
    this.thinking.endedAt = new Date().toISOString();
    this.emitThinking();
    this.thinking = null;
    this.thinkingIndex = null;
  }

  private appendOutput(text: string): void {
    if (!text || !this.currentMsgId) return;
    this.endThinking();
    this.textBlock ??= { contentIndex: this.nextTextIndex++, text: "", offset: 0, startedAt: new Date().toISOString() };
    this.textBlock.text += text;
    this.currentPreview = { messageId: this.currentMsgId, text: (this.currentPreview?.text ?? "") + text };
    if (Date.now() - this.lastFragmentAt >= FRAGMENT_INTERVAL_MS) this.flushOutput();
  }

  /** 每段正文独立按 UTF-8 字节偏移发送；段边界与 message_end 冲刷节流尾块。 */
  private flushOutput(): void {
    const task = this.currentTask;
    const block = this.textBlock;
    if (!task || !block || !this.currentMsgId) return;
    // provider 分块恰好切开 UTF-16 代理对时，等待下一块补齐。
    const last = block.text.charCodeAt(block.text.length - 1);
    const text = last >= 0xd800 && last <= 0xdbff ? block.text.slice(0, -1) : block.text;
    const bytes = Buffer.from(text, "utf8");
    const totalBytes = bytes.length;
    if (block.offset >= totalBytes) return;
    let offset = block.offset;
    this.deps.store.withTx(() => {
      while (offset < totalBytes) {
        const end = snapUtf8End(bytes, Math.min(offset + FRAGMENT_TEXT_CAP, totalBytes));
        this.deps.store.appendEvent({
          type: "task.output_fragment", taskId: task.id, sessionId: task.sessionId,
          messageId: this.currentMsgId!, contentIndex: block.contentIndex,
          text: bytes.subarray(offset, end).toString("utf8"), offset, totalBytes: end,
          truncated: false, partial: true, startedAt: block.startedAt,
        }, { taskId: task.id, sessionId: task.sessionId });
        offset = end;
      }
    });
    block.offset = offset;
    this.lastFragmentAt = Date.now();
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const task = this.currentTask;
    if (!task) return;

    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant" && !this.currentMsgId) this.beginModelRequest(task);
        return;
      }
      case "message_update": {
        if (event.message.role !== "assistant") return;
        if (!this.currentMsgId) this.beginModelRequest(task);
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_start" || update.type === "thinking_delta") {
          this.flushOutput();
          this.textBlock = null;
          if (this.thinking && this.thinkingIndex !== null && this.thinkingIndex !== update.contentIndex) this.endThinking();
          if (!this.thinking) this.startThinking(task);
          const firstExplicitThinking = this.thinkingIndex === null;
          // 占位阶段保留身份；公开思考的计时从首个明确事件开始，不含请求等待。
          if (firstExplicitThinking) this.thinking!.startedAt = new Date().toISOString();
          this.thinkingIndex = update.contentIndex;
          // SDK 的 partial 对象可能已被后续队列事件更新，只消费原生 delta。
          if (update.type === "thinking_delta") this.thinking!.text = tailTextByBytes(this.thinking!.text + update.delta, FRAGMENT_TEXT_CAP).text;
          if (firstExplicitThinking || update.type === "thinking_start" || Date.now() - this.lastThinkingAt >= FRAGMENT_INTERVAL_MS) this.emitThinking();
        } else if (update.type === "thinking_end") {
          // 部分 provider 把 end 延迟到整条消息结束，不重新打开已被正文结束的阶段。
          if (this.thinking && this.thinkingIndex === update.contentIndex) {
            if (!this.thinking.text) this.thinking.text = tailTextByBytes(update.content, FRAGMENT_TEXT_CAP).text;
            this.endThinking();
          }
        } else if (update.type === "text_delta") {
          this.sourceTextBlocks.set(update.contentIndex, (this.sourceTextBlocks.get(update.contentIndex) ?? "") + update.delta);
          this.appendOutput(update.delta);
        } else if (update.type === "text_end") {
          const seen = this.sourceTextBlocks.get(update.contentIndex) ?? "";
          if (update.content.startsWith(seen)) this.appendOutput(update.content.slice(seen.length));
          this.sourceTextBlocks.set(update.contentIndex, update.content);
        } else if (update.type.startsWith("toolcall_")) {
          this.flushOutput();
          this.textBlock = null;
          this.endThinking();
        }
        return;
      }
      case "message_end": {
        if (event.message.role === "user" && this.pendingUserImages.length > 0) {
          // pi 的监听通知先于 appendMessage；同一对象也留在 agent.state 中。
          (event.message as any).ruukotoMediaRefs = this.pendingUserImages;
          this.pendingUserImages = [];
        }
        if (event.message.role !== "assistant") return;
        const text = extractText(event.message.content);
        const seen = this.currentPreview?.text ?? "";
        if (text.startsWith(seen)) this.appendOutput(text.slice(seen.length));
        this.flushOutput();
        this.endThinking();
        return;
      }
      case "tool_execution_end": {
        const summary = summarizeToolResult(event.result);
        const editStats = editStatsFromResult(event.toolName, event.isError, event.result?.details);
        // SDK 调用 id → 宿主操作 id（不同任务复用调用 id 时不串用记录）
        const hostOpId = this.callMap.get(event.toolCallId) ?? event.toolCallId;
        const artifactIds = this.deps.store.getToolOp(hostOpId)
          ? [...this.router.artifactIdsFor(hostOpId), ...(this.hostToolArtifacts.get(hostOpId) ?? [])]
          : [];
        try {
          this.deps.store.withTx(() => this.deps.ledger.recordResult(task, hostOpId, summary, event.isError, { artifactIds, editStats }));
        } catch (err) {
          // 核心结果写入失败（issue 02）：工具族能核实的写操作立即按操作 ID 核实并
          // 保留真实状态——已提交不能报成"未执行"，也不自动再次写入；其余与无法
          // 核实的保持结果缺失，由重启恢复处理。
          try {
            this.deps.store.withTx(() => this.deps.ledger.settleAfterWriteFailure(task, hostOpId));
          } catch {
            // 补记也失败：保持结果缺失，交重启恢复
          }
          process.stderr.write(`[ruukoto] 工具结果落盘失败（${hostOpId}）：${(err as Error).message}\n`);
        }
        return;
      }
      case "turn_end": {
        // 本轮消息已持久化（message_end 持久化先于 turn_end）；下一拍读文件补条目引用
        setImmediate(() => this.flushEntryRefs(task));
        return;
      }
      default:
        return;
    }
  }

  /** 条目 → 流式消息标识：assistant 条目按落盘顺序消费分配的标识队列。 */
  private takeMessageId(entry: ParsedSessionEntry): string | null {
    if ((entry.message as any)?.role !== "assistant") return null;
    return this.pendingEntryMsgIds.shift() ?? null;
  }

  /** 读 JSONL，把本次任务尚未引用过的消息条目补发为 output_entry（先核实落盘）。 */
  private flushEntryRefs(task: Task): void {
    try {
      const file = this.sdk?.sessionFile;
      if (!file || !fs.existsSync(file)) return;
      const entries = parseSessionFile(file); // 解析失败抛错，不静默
      const startIdx = entries.findIndex(
        (e) => e.type === "custom" && (e as any).customType === TASK_START_MARKER && (e as any).data?.taskId === task.id,
      );
      if (startIdx === -1) return; // 首次落盘尚未包含标记
      for (let i = startIdx + 1; i < entries.length; i++) {
        const entry = entries[i] as any;
        if (entry.type === "custom" && entry.customType === TASK_END_MARKER && entry.data?.taskId === task.id) break;
        if (entry.type !== "message") continue;
        if (this.flushedEntryIds.has(entry.id)) continue;
        this.flushedEntryIds.add(entry.id);
        const messageId = this.takeMessageId(entry);
        this.deps.store.withTx(() => {
          this.deps.store.addHistoryEntryIds(task.id, [entry.id]);
          this.deps.store.appendEvent(
            {
              type: "task.output_entry",
              taskId: task.id,
              sessionId: task.sessionId,
              entryId: entry.id,
              sessionFile: file,
              role: String(entry.message?.role ?? "unknown"),
              messageId,
            },
            { taskId: task.id, sessionId: task.sessionId },
          );
        });
      }
    } catch (err) {
      this.deps.store.withTx(() => {
        this.deps.store.appendEvent(
          {
            type: "session.history_unreadable",
            sessionId: this.session.id,
            sessionFile: this.sdk?.sessionFile ?? "unknown",
            error: (err as Error).message,
          },
          { sessionId: this.session.id },
        );
      });
    }
  }

  /** 任务完成前核对：JSONL 完整可解析、任务标记齐全，返回条目关联。 */
  private verifyAndLinkHistory(task: Task): { ok: boolean; reason?: string } {
    try {
      const file = this.sdk?.sessionFile;
      if (!file) return { ok: false, reason: "history_unverified:会话文件不存在" };
      this.deps.store.withTx(() => {
        const recorded = this.deps.store.getSession(this.session.id);
        if (recorded && recorded.sessionFile !== file) {
          this.deps.store.setSessionFile(this.session.id, file);
        }
      });
      const entries = parseSessionFile(file);
      const startIdx = entries.findIndex(
        (e) => e.type === "custom" && (e as any).customType === TASK_START_MARKER && (e as any).data?.taskId === task.id,
      );
      const endIdx = entries.findIndex(
        (e) => e.type === "custom" && (e as any).customType === TASK_END_MARKER && (e as any).data?.taskId === task.id,
      );
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        return { ok: false, reason: "history_unverified:任务标记缺失（历史可能不完整）" };
      }
      const entryIds: string[] = [];
      for (let i = startIdx + 1; i < endIdx; i++) {
        const entry = entries[i] as any;
        if (entry.type === "message") entryIds.push(entry.id);
      }
      this.deps.store.withTx(() => {
        this.deps.store.addHistoryEntryIds(task.id, entryIds);
      });
      return { ok: true };
    } catch (err) {
      // 损坏的 JSONL：不覆盖、不忽略，要求人工处理
      this.deps.store.withTx(() => {
        this.deps.store.appendEvent(
          {
            type: "session.history_unreadable",
            sessionId: this.session.id,
            sessionFile: this.sdk?.sessionFile ?? "unknown",
            error: (err as Error).message,
          },
          { sessionId: this.session.id },
        );
      });
      return { ok: false, reason: "history_corrupted:JSONL 解析失败，保留原文件待人工处理" };
    }
  }

  async dispose(): Promise<void> {
    if (this.runPromise) await this.runPromise.catch(() => {});
    await this.closeMcpConns();
    this.sdk?.dispose();
    this.sdk = null;
  }
}

// ---------- 辅助 ----------

function findLastAssistant(messages: any[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

function summarizeToolResult(result: any): string {
  if (result === undefined || result === null) return "(no result)";
  if (typeof result === "string") return result.slice(0, 300);
  const text = extractText(result?.content);
  if (text.length > 0) return text.slice(0, 300);
  try {
    return JSON.stringify(result).slice(0, 300);
  } catch {
    return String(result).slice(0, 300);
  }
}
