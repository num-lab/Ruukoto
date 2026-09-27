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
import type { AccessMode, AgentRole, PersistentEventBody, Session, Task, ToolCategory } from "../core/types.ts";
import { randomId, TASK_END_MARKER, TASK_START_MARKER } from "../core/types.ts";
import { isToolOpExecutionUncertain, type Store } from "../core/store.ts";
import { editStatsFromResult, parseSessionFile, snapUtf8End, tailTextByBytes, type ParsedSessionEntry } from "../core/history.ts";
import { FRAGMENT_TEXT_CAP } from "../core/views.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { CredentialStore } from "./execution/credentials.ts";
import type { ExecutionError } from "./execution/launchers.ts";
import type { WorkerLauncher } from "./execution/launchers.ts";
import { createManagedProcessRegistry, type ManagedProcessRegistry } from "./managed-processes.ts";
import { createSdkSession, SYSTEM_PROMPTS } from "./session-factory.ts";
import { ToolRouter, ROUTED_TOOL_NAMES } from "./tool-router.ts";
import { ApprovalGate } from "./approval-gate.ts";
import type { AccessScope } from "../core/access.ts";
import type { HistoryIndex } from "../core/history-index.ts";
import type { MemoryStore } from "../core/memory.ts";
import type { SelectorBudgetConfig } from "./context-selector.ts";
import { beginContextAssembly, ContextSendBlocked, type ContextAssembly } from "./context-assembly.ts";
import type { JevRequestConfig } from "./jev.ts";
import { createHostDataTools, HOST_DATA_TOOL_NAMES, type HostToolContext } from "./host-tools.ts";
import { createAppDataTools, APP_DATA_TOOL_NAMES, APP_DATA_WRITE_TOOL_NAMES, settleAppDataOp, type AppToolContext } from "./app-data/tools.ts";
import type { AppDataStore } from "./app-data/store.ts";
import type { AppDataQueryRunner } from "./app-data/query.ts";
import { createSchedulerTools, settleSchedulerOp, SCHEDULER_TOOL_NAMES, type SchedulerToolsDeps } from "./scheduler-tools.ts";
import { createDelegationTools, settleDelegationOp, DELEGATION_TOOL_NAMES, type DelegationToolsDeps } from "./delegation-tools.ts";
import { createChatResultTools, settleChatResultOp, CHAT_RESULT_TOOL_NAMES } from "./chat-result-tools.ts";
import type { QqStore } from "../qq/store.ts";
import { createWebSearchTools, WEB_SEARCH_TOOL_NAMES, type WebSearchConfig } from "./web-search.ts";
import { createSkillTools, expandSkillCommand, loadSkillLibrary, SKILL_TOOL_NAMES, type SkillLibrary } from "./skills.ts";
import { createTodoTools, TODO_TOOL_NAMES } from "./todo.ts";
import { isPlanInput, runsInPlanMode } from "./plan-mode.ts";
import { allowsCategory, sessionToolClass, taskToolSet, type SessionToolClass, type TaskToolSet } from "./tool-availability.ts";
import { planMcpTaskTools, EMPTY_MCP_PLAN, type McpTaskPlan } from "./mcp/tools.ts";
import type { McpTimeouts } from "./mcp/client.ts";
import type { McpStore, McpToolEffect } from "./mcp/store.ts";
import type { Accessor } from "../core/access.ts";

const FRAGMENT_INTERVAL_MS = 250;

export interface DriverDeps {
  store: Store;
  qqStore: QqStore;
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
  /** Web Search（issue 20）：Tavily 目标/超时覆盖（仅测试注入；生产缺省官方端点）。 */
  webSearch?: WebSearchConfig;
  /** Jev 的本地模拟服务与超时覆盖，仅宿主测试注入。 */
  jev?: JevRequestConfig;
  /** 上下文压缩的摘要超时覆盖（issue 30），仅测试注入；生产 180 s。 */
  compaction?: { summaryTimeoutMs?: number };
  /** MCP（issue 16）：服务配置存储与超时覆盖；未配置时 MCP 工具不注册。 */
  mcp?: { store: McpStore } & McpTimeouts;
  /** 宿主按任务收紧工具白名单；MCP 类别取自本地钉版配置，不接受模型声明。 */
  allowTaskTool?: (task: Task, name: string, mcpEffect?: McpToolEffect) => boolean;
  /** 自动审查（issue 15）：auto-review 任务的审批请求先经其裁决；缺省时退化为纯人工。 */
  reviewer?: ApprovalReviewer;
  /**
   * QQ 群聊会话的撤回消息过滤（issue 07）：每次模型调用前移出已撤回交互
   * （只改模型视图，不改写历史）。仅 kind=qq_group 会话调用。
   */
  qqRecalledFilter?: (sessionId: string, messages: any[]) => any[];
  /**
   * main 应用数据空间（issue 02）：仅 main 角色会话装配六个受控工具；
   * 停止/恢复路径按应用库回执核实未落结果的应用数据操作。
   */
  appData?: {
    store: AppDataStore;
    runner: AppDataQueryRunner;
    /** 按宿主操作 ID 核实应用库提交状态（恢复与停止路径共用）。 */
    writeVerdict(hostOpId: string): "committed" | "not_committed" | "unverifiable";
    /** 查询子进程挂点（仅测试注入；模型不可达）。 */
    queryStallMs?: number;
  };
  /**
   * 调度计划与通知（issue 03）：仅 main 角色会话装配六个 scheduler 工具；
   * 停止路径按宿主操作 ID 核实未落结果的调度写操作（同库，恒可核实）。
   */
  scheduler?: Pick<SchedulerToolsDeps, "sched" | "scheduler" | "sources" | "target" | "now">;
  /**
   * 委派 coding（issue 05）：仅 main 角色会话装配；停止路径按子任务是否存在
   * 核实未落结果的委派操作（同库，恒可核实）。
   */
  delegation?: Pick<DelegationToolsDeps, "sources" | "delegate" | "readReply" | "resultNotice">;
}

export class Driver {
  readonly session: Session;
  private readonly deps: DriverDeps;
  private sdk: AgentSession | null = null;
  private registry: ManagedProcessRegistry;
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
  /** SDK 扩展桥注入的 appendEntry（宿主标记条目，custom，不进模型上下文）。 */
  private markerApi: ((customType: string, data: unknown) => void) | null = null;
  /** 当前正在执行的宿主数据工具上下文（taskContext 注入用）。 */
  private hostToolCtx: HostToolContext | null = null;
  /** 本任务内 sdkCallId → 宿主数据工具上下文（并发调用各自独立）。 */
  private hostToolCalls = new Map<string, HostToolContext>();
  /** SDK 会话登记的全部工具名（任务开始钉版工具清单的基准）。 */
  private allToolNames: string[] = [];
  /** 当前任务钉版的 MCP 工具名集合（handleToolCall 分派依据；任务间比对签名）。 */
  private mcpToolNames = new Set<string>();
  /** 当前任务钉版的 MCP 计划（工具元数据 + 按服务持有的连接；结束/取消/关闭时回收）。 */
  private currentMcpPlan: McpTaskPlan | null = null;
  /** 上次 SDK 会话创建时的 MCP 工具清单签名（不一致则重建会话换工具定义）。 */
  private mcpSignature: string | null = null;
  /** 模型配置已应用、存活 SDK 会话待丢弃重建（issue 21 §4；见 updateModelDeps）。 */
  private sdkConfigStale = false;
  /** 待装配进新 SDK 会话的 MCP 工具定义（runInner 计划后由 ensureSdk 消费）。 */
  private pendingMcpToolDefs: ToolDefinition[] = [];
  /** 角色配置缓存（undefined = 未查询；null = 非角色会话）。 */
  private roleConfig: AgentRole | null | undefined = undefined;
  /** 会话工具类别缓存（Driver 生命周期内不变）。 */
  private toolClassCache: SessionToolClass | undefined = undefined;
  /** 本任务允许的工具（任务开始时算一次；激活、发送前与调用门共用；null = 尚未算出，一律拒绝）。 */
  private taskTools: TaskToolSet | null = null;
  /** 本任务的模型上下文组装（任务开始时建、结束即丢；context 钩子与发送前复核共用）。 */
  private assembly: ContextAssembly | null = null;
  /** 原始 streamFunction（包装前保存；发送前检查在委托前执行）。 */
  private originalStreamFn: any = null;
  /** 任务开始时钉版：以计划模式运行（issue 26，决定计划说明与工具白名单）。 */
  private pinnedPlan = false;
  /** 任务开始时钉版的技能库（issue 22；null = 资料受限会话不读取）。 */
  private pinnedSkills: SkillLibrary | null = null;

  constructor(session: Session, deps: DriverDeps) {
    this.session = session;
    this.deps = deps;
    this.registry = createManagedProcessRegistry();
    this.approvals = new ApprovalGate({ store: deps.store, reviewer: () => this.deps.reviewer });
    this.router = new ToolRouter({
      store: deps.store,
      artifacts: deps.artifacts,
      credentials: deps.credentials,
      registry: this.registry,
      launcherFor: deps.launcherFor,
      protectedRoots: deps.protectedRoots,
      artifactAccess: (task, artifact) => {
        if (artifact.taskId === task.id) return true;
        const artifactSession = deps.store.getSession(artifact.sessionId);
        if (!artifactSession) return false;
        return deps.access.canAccess(this.accessor(), artifactSession.projectId, "artifact");
      },
      bridge: {
        awaitApproval: (input) => this.approvals.await(input),
        supersedeAllWaiters: () => this.approvals.supersedeAll(),
      },
      // MCP 动态工具经路由器统一处理（issue 18）：计划按任务钉版，执行时读取
      mcp: deps.mcp ? { store: deps.mcp.store, plan: () => this.currentMcpPlan } : undefined,
    });
  }

  get busy(): boolean {
    return this.currentTask !== null;
  }

  /** QQ 群聊入口会话（issue 07）：空工具集合 + 宿主约束资料范围。 */
  private get isQqGroup(): boolean {
    return this.session.kind === "qq_group";
  }

  /**
   * 角色会话（issue 01）：宿主引导的角色绑定（agent_roles 表，按会话反查）；
   * 非角色会话为 null。绑定只由宿主设置，任务/工具参数与模型结果不能修改。
   */
  private role(): AgentRole | null {
    if (this.roleConfig === undefined) {
      this.roleConfig = this.deps.store.getAgentRoleBySession(this.session.id);
    }
    return this.roleConfig;
  }

  /** 会话工具类别（工具可用性）：QQ 群归 chat，角色会话按宿主绑定，其余为普通开发会话。 */
  private get toolClass(): SessionToolClass {
    this.toolClassCache ??= sessionToolClass(this.session.kind, this.role()?.id ?? null);
    return this.toolClassCache;
  }

  /** 会话类别的清单含该工具类别（装配各注册来源的唯一条件）。 */
  private allows(category: ToolCategory): boolean {
    return allowsCategory(this.toolClass, category);
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
    const role = this.deps.store.getAgentRoleBySession(ctx.sessionId);
    if (!role || role.id !== "main") return "会话未绑定 main 角色";
    if (role.projectId !== this.session.projectId) return "main 角色项目绑定不匹配";
    if (this.currentTask?.id !== ctx.taskId) return "任务与当前执行不匹配";
    const task = this.deps.store.getTask(ctx.taskId);
    if (!task || task.sessionId !== ctx.sessionId) return "宿主任务归属校验失败";
    return null;
  }

  /** 宿主注入的资料访问身份（qq_group 与 chat 角色不适用跨项目授权与 owner_note 默认放行）。 */
  private accessor(): Accessor {
    if (this.isQqGroup) return { kind: "qq_group", projectId: this.session.projectId };
    if (this.role()?.id === "chat") return { kind: "role_restricted", projectId: this.session.projectId };
    return { kind: "agent", projectId: this.session.projectId };
  }

  /**
   * 资料范围受宿主约束的会话（issue 07 qq_group；issue 01 chat 角色）：
   * 上下文注入排除个人共享记忆与项目指令，记忆/资料工具按受限身份判定。
   * 工具白名单管工具可见性，本约束管资料范围，两者独立生效。
   */
  private get dataScopeRestricted(): boolean {
    return this.toolClass === "chat";
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

  private async ensureSdk(model: any, thinkingLevel: ThinkingLevel): Promise<AgentSession> {
    if (this.sdk) return this.sdk;
    // 工具可用性（架构工单 03）：各注册来源只在会话类别的清单含其类别时装配；
    // chat 与 QQ 群的清单为空，即空工具集合
    const hostDataTools = !this.allows("host_data")
      ? []
      : createHostDataTools({
          store: this.deps.store,
          access: this.deps.access,
          historyIndex: this.deps.historyIndex,
          memories: this.deps.memories,
          taskContext: () => this.hostToolCtx,
          bindCall: this.bindHostCall,
          sessionFileFor: (sessionId) => this.deps.store.getSession(sessionId)?.sessionFile ?? null,
          projectOfSession: (sessionId) => this.deps.store.getSession(sessionId)?.projectId ?? null,
          syncSession: (sessionId) => {
            const file = this.deps.store.getSession(sessionId)?.sessionFile;
            if (!file) return { unindexed: true };
            this.deps.historyIndex.sync(sessionId, file);
            return { unindexed: !this.deps.historyIndex.isIndexed(sessionId) };
          },
        });
    // Web Search 宿主工具（issue 20）：同一身份注入；项目禁用与否在任务开始
    // 钉版工具清单时判定（runInner），调用时另有新鲜检查
    const webSearchTools = !this.allows("web_search")
      ? []
      : createWebSearchTools({
          store: this.deps.store,
          artifacts: this.deps.artifacts,
          credentials: this.deps.credentials,
          taskContext: () => this.hostToolCtx,
          bindCall: this.bindHostCall,
          baseUrl: this.deps.webSearch?.baseUrl,
          timeoutMs: this.deps.webSearch?.timeoutMs,
        });
    // main 应用数据工具（issue 02）：只有 main 的清单含 app_data；执行入口每次调用仍重新核实 main 绑定
    const appDataTools =
      this.allows("app_data") && this.deps.appData
        ? createAppDataTools({
            store: this.deps.appData.store,
            runner: this.deps.appData.runner,
            coreStore: this.deps.store,
            taskContext: () => this.hostToolCtx,
            bindCall: this.bindHostCall,
            verifyMain: (ctx) => this.verifyMainBinding(ctx),
            awaitApproval: (input) => this.approvals.await(input),
            queryStallMs: () => this.deps.appData?.queryStallMs,
          })
        : [];
    // 调度与通知工具（issue 03）：只有 main 的清单含 scheduler
    const schedulerTools =
      this.allows("scheduler") && this.deps.scheduler
        ? createSchedulerTools({
            ...this.deps.scheduler,
            coreStore: this.deps.store,
            taskContext: () => this.hostToolCtx,
            bindCall: this.bindHostCall,
            verifyMain: (ctx) => this.verifyMainBinding(ctx),
            awaitApproval: (input) => this.approvals.await(input),
          })
        : [];
    // 委派 coding 工具（issue 05）：只有 main 的清单含 delegation
    const delegationTools =
      this.allows("delegation") && this.deps.delegation
        ? createDelegationTools({
            ...this.deps.delegation,
            coreStore: this.deps.store,
            artifacts: this.deps.artifacts,
            taskContext: () => this.hostToolCtx,
            bindCall: this.bindHostCall,
            verifyMain: (ctx) => this.verifyMainBinding(ctx),
          })
        : [];
    const chatResultTools = this.allows("chat_results")
      ? createChatResultTools({
          coreStore: this.deps.store, qqStore: this.deps.qqStore,
          taskContext: () => this.hostToolCtx, bindCall: this.bindHostCall,
          verifyMain: (ctx) => this.verifyMainBinding(ctx),
        })
      : [];
    // 技能工具（issue 22）：读取任务钉版的技能库
    const skillTools = !this.allows("skills")
      ? []
      : createSkillTools({ library: () => this.pinnedSkills, bindCall: this.bindHostCall });
    const allTools = [
      ...(this.allows("coding") ? this.deps.toolFactory({ registry: this.registry, router: this.router }) : []),
      // 工作清单（issue 25）：与编码工具同一类别——开发会话与 coding，main/chat 不装配
      ...(this.allows("coding") ? createTodoTools({ bindCall: this.bindHostCall }) : []),
      ...hostDataTools,
      ...webSearchTools,
      ...appDataTools,
      ...schedulerTools,
      ...delegationTools,
      ...chatResultTools,
      ...skillTools,
      // MCP 动态工具（issue 16）：runInner 按任务计划装配；SDK 白名单创建时
      // 固定，工具集合变化由 runInner 先重建会话再走到这里
      ...this.pendingMcpToolDefs,
    ];
    this.pendingMcpToolDefs = [];
    this.allToolNames = allTools.map((t) => t.name);
    this.sdk = await createSdkSession({
      session: this.session,
      sessionsDir: this.deps.sessionsDir,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.modelRuntime,
      model,
      thinkingLevel,
      tools: allTools,
      // 按会话类别固定（issue 24）：QQ 群与 chat 角色用 chat 提示；coding 含 GitHub 评审子任务
      systemPrompt: SYSTEM_PROMPTS[this.toolClass],
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
  private readonly bindHostCall = (sdkCallId: string): (() => void) => {
    const ctx = this.hostToolCalls.get(sdkCallId) ?? null;
    this.hostToolCtx = ctx;
    return () => {
      this.hostToolCtx = null;
      this.hostToolCalls.delete(sdkCallId);
    };
  };

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
    const expected = task.modelSelection;
    if (!expected || model?.provider !== expected.provider || model?.id !== expected.modelId ||
        this.sdk?.thinkingLevel !== expected.thinkingLevel || (options?.reasoning ?? "off") !== expected.thinkingLevel) {
      throw new ContextSendBlocked("model_selection_mismatch:实际模型或思考强度与任务记录不一致");
    }
    // 工具可用性（架构工单 03）：发送载荷中的每个工具都必须在本任务允许的集合内
    // （按实际载荷检查，覆盖全部注册来源；QQ 群与 chat 的集合为空）
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
    this.currentTask = task;
    this.stopRequested = false;
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
    this.hostToolCtx = null;
    this.hostToolCalls = new Map();
    this.lastBlockedReason = null;
    this.taskTools = null;
    // 计划模式（issue 26）：输入带 `/plan` 标记，或逐级继续的原任务带标记；只限普通开发会话（同提交入口）
    try {
      this.pinnedPlan = this.toolClass === "dev" && runsInPlanMode(task, (id) => this.deps.store.getTask(id));
    } catch {
      this.pinnedPlan = this.toolClass === "dev" && isPlanInput(task.input); // 原任务读取失败时只按本任务输入判定
    }
    this.pinnedSkills = this.dataScopeRestricted ? null : loadSkillLibrary(this.deps.agentDir);
    this.assembly = beginContextAssembly({
      task,
      session: this.session,
      accessor: this.accessor(),
      restricted: this.dataScopeRestricted,
      recalledFilter: this.isQqGroup && this.deps.qqRecalledFilter
        ? (messages) => this.deps.qqRecalledFilter!(this.session.id, messages)
        : undefined,
      plan: this.pinnedPlan,
      skills: this.pinnedSkills,
    }, this.deps);
    this.runPromise = this.runInner(task);
    try {
      await this.runPromise;
    } finally {
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
  private async planMcp(): Promise<McpTaskPlan> {
    if (!this.deps.mcp) return EMPTY_MCP_PLAN;
    // 会话类别的清单不含 mcp 时不注册 MCP 工具（QQ 群与 chat 的清单为空）
    if (!this.allows("mcp")) return EMPTY_MCP_PLAN;
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
    let sdk: AgentSession;
    try {
      if (!task.modelSelection) throw new Error("model_selection_missing:任务未记录模型配置");
      const model = await this.deps.modelCatalog.resolve(task.modelSelection);
      // 模型配置应用后（issue 21 §4）：旧 SDK 会话闭包持有旧 ModelRuntime，
      // 任务边界处丢弃，由 ensureSdk 以新模型栈重建（历史在会话文件中）
      if (this.sdkConfigStale) {
        this.sdkConfigStale = false;
        this.dropSdkForToolChange();
      }
      // MCP（issue 16）：任务开始重读配置并发现工具，钉版本任务工具清单；
      // 单个服务初始化失败降级为不可用事件，不阻断任务
      const mcpPlan = await this.planMcp();
      if (this.sdk && mcpPlan.signature !== this.mcpSignature) this.dropSdkForToolChange();
      this.pendingMcpToolDefs = mcpPlan.toolDefs;
      // 计划先登记：ensureSdk 失败时 catch 路径的 closeMcpConns 才能回收连接
      this.currentMcpPlan = mcpPlan;
      sdk = await this.ensureSdk(model, task.modelSelection.thinkingLevel);
      this.pendingMcpToolDefs = [];
      this.mcpSignature = mcpPlan.signature;
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
      this.finalize(task, "failed", { errorMessage: `SDK 会话创建失败：${(err as Error).message}` });
      return;
    }

    // 任务开始固定本任务允许的工具（架构工单 03）：完整注册表减去任务收窄（计划模式、
    // 宿主按任务收窄）与项目关闭的 Web Search（issue 20：模型不可见、系统提示同步重建；
    // 任务内的禁用由工具按调用新鲜检查立即阻止）。每次从完整注册表重算，宿主对当前
    // 任务的限制不带入下一任务。
    const allowTaskTool = this.deps.allowTaskTool;
    this.taskTools = taskToolSet({
      registered: this.allToolNames,
      plan: this.pinnedPlan,
      webSearchEnabled: this.deps.store.getProject(this.session.projectId)?.webSearch !== "disabled",
      mcpEffect: (name) => this.currentMcpPlan?.tools.get(name)?.effect,
      narrow: allowTaskTool ? (name, effect) => allowTaskTool(task, name, effect) : undefined,
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
      this.finalize(task, "interrupted", { interruptReason: "aborted" });
      return;
    }

    // 拥有者显式调用技能（/skill:<名称> [参数]）：按钉版技能库展开后作为用户消息
    // 进入历史；不交给 pi 的 /skill: 展开。资料受限会话不识别。
    let promptText: string;
    try {
      promptText = this.dataScopeRestricted ? task.input : expandSkillCommand(this.pinnedSkills, task.input);
    } catch (err) {
      this.finalize(task, "failed", { errorMessage: (err as Error).message });
      return;
    }

    this.appendMarker(TASK_START_MARKER, { taskId: task.id, requestId: task.requestId });
    try {
      await sdk.prompt(promptText);
    } catch (err) {
      if (!this.stopRequested) {
        this.finalize(task, "failed", { errorMessage: (err as Error).message });
      }
      await this.killManagedProcesses();
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
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: blockedReason });
      this.pauseQueue(blockedReason);
      this.finalize(task, "interrupted", { interruptReason: blockedReason });
      return;
    }

    if (stopReason === "aborted") {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: "aborted" });
      this.finalize(task, "interrupted", { interruptReason: "aborted" });
      return;
    }

    const contextWindow: number = sdk.model?.contextWindow ?? 0;
    if (lastAssistant && isContextOverflow(lastAssistant, contextWindow)) {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: "context_overflow" });
      this.pauseQueue("context_overflow");
      this.finalize(task, "interrupted", { interruptReason: "context_overflow" });
      return;
    }

    if (stopReason === "error") {
      const message = lastAssistant?.errorMessage ?? "模型返回错误";
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "failed" });
      this.finalize(task, "failed", { errorMessage: message });
      return;
    }

    // 自然完成：先写入任务结束标记（它本身就是"历史已写完"的证据），
    // 再核对最终历史确实落盘，最后宣布 completed
    this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "completed" });
    const verification = this.verifyAndLinkHistory(task);
    if (verification.ok) {
      this.finalize(task, "completed", {});
    } else {
      this.finalize(task, "interrupted", { interruptReason: verification.reason! });
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
    opts: { terminal: "canceled" | "interrupted"; reason: string; cancelIntent: boolean },
  ): Promise<boolean> {
    if (this.currentTask?.id !== task.id) return false;
    this.stopRequested = true;
    this.assembly?.abort();

    // 1. 提交停止意图（独立事务持久化）
    this.deps.store.withTx(() => {
      this.deps.store.setCancelRequested(task.id, opts.cancelIntent);
    });

    // 在中止与回收之前快照"结果未知"的操作：审批未消费 = 已知未执行（排除）；
    // 应用数据操作在中止完成后统一核实（3b：写操作按回执，只读查询无写入效果），
    // 不在预快照中标记。其余已开始执行的命令是否已产生外部效果不确定，必须沿用
    // effect_unknown
    const confirmations = this.deps.store.listConfirmationsByTask(task.id);
    const uncertainAtStop = this.deps.store
      .listUnresolvedToolOps(task.id)
      .filter(
        (op) =>
          isToolOpExecutionUncertain(op, confirmations) &&
          !(APP_DATA_TOOL_NAMES as readonly string[]).includes(op.toolName) &&
          !(SCHEDULER_TOOL_NAMES as readonly string[]).includes(op.toolName) &&
          !(DELEGATION_TOOL_NAMES as readonly string[]).includes(op.toolName) &&
          !(CHAT_RESULT_TOOL_NAMES as readonly string[]).includes(op.toolName),
      )
      .map((op) => op.id);

    // 2. 解除确认等待（门以 block 结束，不执行该操作）；进行中的自动审查一并中止
    this.approvals.cancelAll();

    // 3. 中止模型调用与确认等待；受管工具进程组的终止与 abort 并行进行：
    //    abort() 会等待在执行的工具返回，若工具在等待子进程退出，必须同时
    //    回收进程组（TERM → 超时 KILL）才能解除等待，否则互相死锁。
    const abortPromise = this.sdk?.isStreaming ? this.sdk.abort().catch(() => {}) : null;
    const reaped = await this.killManagedProcesses();
    if (abortPromise) await abortPromise;
    // MCP 连接随任务停止回收：在途调用已被 abort 中断，迟到结果由 SDK 丢弃
    await this.closeMcpConns();

    // 3b. 应用数据操作（issue 02）：中止完成后统一核实——写操作按应用库回执
    //     （有回执 = 已提交；可核实无回执 = 已知未提交；无法核实才保留
    //     effect_unknown）；只读查询不产生写入效果，结果缺失按已知未执行补记。
    const appDataUncertain: string[] = [];
    for (const op of this.deps.store.listUnresolvedToolOps(task.id)) {
      if (!(APP_DATA_TOOL_NAMES as readonly string[]).includes(op.toolName)) continue;
      if (!APP_DATA_WRITE_TOOL_NAMES.has(op.toolName)) {
        this.deps.store.withTx(() => {
          const recorded = this.deps.store.recordToolResult(op.id, "已知未执行：只读查询在停止前未产生写入效果", true);
          if (recorded) {
            this.deps.store.appendEvent(
              { type: "task.tool_result", taskId: task.id, toolOpId: op.id, summary: "已知未执行：只读查询在停止前未产生写入效果", isError: true, artifactIds: [] },
              { taskId: task.id, sessionId: task.sessionId },
            );
          }
        });
        continue;
      }
      if (!this.deps.appData) {
        appDataUncertain.push(op.id);
        continue;
      }
      const verdict = this.deps.appData.writeVerdict(op.id);
      if (verdict === "unverifiable") {
        appDataUncertain.push(op.id);
        continue;
      }
      this.deps.store.withTx(() => settleAppDataOp(this.deps.store, verdict, task, op, "后台停止前"));
    }

    // 3c. 调度与通知工具（issue 03）：按宿主操作 ID 核实是否已登记（核心库，
    //     恒可核实）；只读查询结果缺失按已知未执行补记。
    for (const op of this.deps.store.listUnresolvedToolOps(task.id)) {
      if (!(SCHEDULER_TOOL_NAMES as readonly string[]).includes(op.toolName)) continue;
      this.deps.store.withTx(() => settleSchedulerOp(this.deps.store, this.deps.scheduler?.sched ?? null, task, op, "后台停止前"));
    }
    // 3d. 委派工具（issue 05）：按子任务是否存在核实（同库，恒可核实）
    for (const op of this.deps.store.listUnresolvedToolOps(task.id)) {
      if (!(DELEGATION_TOOL_NAMES as readonly string[]).includes(op.toolName)) continue;
      this.deps.store.withTx(() => settleDelegationOp(this.deps.store, task, op, "后台停止前"));
    }
    for (const op of this.deps.store.listUnresolvedToolOps(task.id)) {
      if (!(CHAT_RESULT_TOOL_NAMES as readonly string[]).includes(op.toolName)) continue;
      this.deps.store.withTx(() => settleChatResultOp(this.deps.store, task, op, "后台停止前"));
    }

    // 4. 终态与占用释放（仅当尚未被自然完成抢先）
    this.finalize(task, opts.terminal, {
      interruptReason: opts.reason,
      effectUnknownOpIds: [...uncertainAtStop, ...appDataUncertain],
      keepOccupancy: !reaped,
      occupancyIssueReason: reaped ? null : "tool_process_unreaped",
    });
    return reaped;
  }

  private async killManagedProcesses(): Promise<boolean> {
    const processes = this.registry.list();
    if (processes.length === 0) return true;
    let allReaped = true;
    for (const proc of processes) {
      const ok = await proc.stop();
      if (!ok) allReaped = false;
    }
    this.registry.clear();
    return allReaped;
  }

  // ---------- 终态与占用 ----------

  private finalize(
    task: Task,
    to: "completed" | "failed" | "canceled" | "interrupted",
    extra: {
      interruptReason?: string;
      errorMessage?: string;
      /** 已开始但结果未知的操作（在停止前快照）；拒绝/未执行的审批不在其中。 */
      effectUnknownOpIds?: string[];
      keepOccupancy?: boolean;
      occupancyIssueReason?: string | null;
    },
  ): void {
    this.flushOutput();
    this.endThinking();
    this.deps.store.withTx(() => {
      const store = this.deps.store;
      const ok = store.transitionTask(task.id, ["running", "awaiting_confirmation"], to, {
        interruptReason: extra.interruptReason ?? null,
        errorMessage: extra.errorMessage ?? null,
        endedAt: new Date().toISOString(),
      });
      if (!ok) return; // 已被竞争路径定态
      store.clearPendingModeSwitch(task.id);

      const unknownOps = extra.effectUnknownOpIds ?? [];
      if (unknownOps.length > 0) {
        for (const opId of unknownOps) {
          const op = store.getToolOp(opId);
          if (!op || op.effectUnknown) continue;
          store.markToolOpEffectUnknown(opId);
          store.appendEvent(
            { type: "task.tool_effect_unknown", taskId: task.id, toolOpId: opId, toolName: op.toolName },
            { taskId: task.id, sessionId: task.sessionId },
          );
        }
        store.setEffectUnknown(task.id);
      }

      // 中断/取消时清理未决确认（标记 stale，防止失效批准再执行）
      if (to === "interrupted" || to === "canceled") {
        store.stalePendingConfirmations(task.id);
      }

      const refs = { taskId: task.id, sessionId: task.sessionId };
      switch (to) {
        case "completed":
          store.appendEvent({ type: "task.completed", taskId: task.id, sessionId: task.sessionId }, refs);
          break;
        case "failed":
          store.appendEvent(
            { type: "task.failed", taskId: task.id, sessionId: task.sessionId, errorMessage: extra.errorMessage ?? "" },
            refs,
          );
          break;
        case "canceled":
          store.appendEvent({ type: "task.canceled", taskId: task.id, sessionId: task.sessionId }, refs);
          break;
        case "interrupted":
          store.appendEvent(
            {
              type: "task.interrupted",
              taskId: task.id,
              sessionId: task.sessionId,
              reason: extra.interruptReason ?? "unknown",
              cancelRequested: store.getTask(task.id)?.cancelRequested ?? false,
              effectUnknown: store.getTask(task.id)?.effectUnknown ?? false,
            },
            refs,
          );
          break;
      }

      if (extra.keepOccupancy) {
        // 无法确认旧执行已退出：保留占用并报错，不允许同目录新任务启动
        store.appendEvent(
          {
            type: "task.tool_process_unreaped",
            taskId: task.id,
            sessionId: task.sessionId,
            reason: extra.occupancyIssueReason ?? "unknown",
          },
          refs,
        );
      } else {
        store.releaseOccupancy(this.session.cwdReal, task.id);
      }
    });
    // 占用释放后唤醒其他会话的排队任务
    this.deps.onOccupancyReleased();
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
      return await this.router.prepareToolBoundary(task);
    } catch (err) {
      // 切换失败（无法核实旧执行单元退出）：任务无法安全继续
      await this.killManagedProcesses();
      const reaped = await this.router.stopWorker();
      this.finalize(task, "interrupted", {
        interruptReason: `mode_switch_failed:${(err as Error).message}`,
        effectUnknownOpIds: [],
        keepOccupancy: !reaped,
        occupancyIssueReason: reaped ? null : "mode_switch_unverified",
      });
      throw err;
    }
  }

  private async handleToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const current = this.currentTask;
    if (!current) return undefined;
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
    if (
      (HOST_DATA_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (APP_DATA_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (SCHEDULER_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (DELEGATION_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (CHAT_RESULT_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (SKILL_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (TODO_TOOL_NAMES as readonly string[]).includes(event.toolName)
    ) {
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

    return this.approvals.confirmTool({ task, hostOpId, toolName: event.toolName, params });
  }

  /** 运行时入口：等待中的审批因模式切换立即失效（Runtime 调用）。 */
  supersedeWaiters(): void {
    this.approvals.supersedeAll();
  }

  /** 当前任务运行的完成信号（无任务运行时 resolve）。用于审批桥外的等待方
   * 在任务自然结束时回落（避免控制面请求永久悬挂）。 */
  taskCompletion(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  /** 控制面应答确认：条件更新 pending → approved/rejected；失效应答返回 false。 */
  resolveConfirmation(confirmationId: string, decision: "approved" | "rejected"): boolean {
    return this.approvals.resolve(confirmationId, decision);
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
        const artifactIds = this.deps.store.getToolOp(hostOpId) ? this.router.artifactIdsFor(hostOpId) : [];
        try {
          this.deps.store.withTx(() => {
            const recorded = this.deps.store.recordToolResult(hostOpId, summary, event.isError);
            if (recorded) {
              this.deps.store.appendEvent(
                { type: "task.tool_result", taskId: task.id, toolOpId: hostOpId, summary, isError: event.isError, artifactIds, ...(editStats ? { editStats } : {}) },
                { taskId: task.id, sessionId: task.sessionId },
              );
            }
          });
        } catch (err) {
          // 核心结果写入失败（issue 02）：应用数据写操作立即按操作 ID 核实应用库
          // 回执并保留真实状态——已提交不能报成"未执行"，也不自动再次写入；
          // 无法核实则保持结果缺失，由重启恢复按 effect_unknown 处理。
          const toolName = this.deps.store.getToolOp(hostOpId)?.toolName ?? "";
          if (this.deps.appData && APP_DATA_WRITE_TOOL_NAMES.has(toolName)) {
            const verdict = this.deps.appData.writeVerdict(hostOpId);
            if (verdict !== "unverifiable") {
              try {
                this.deps.store.withTx(() => settleAppDataOp(this.deps.store, verdict, task, { id: hostOpId }, "结果写入失败前"));
              } catch {
                // 补记也失败：保持结果缺失，交重启恢复
              }
            }
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
