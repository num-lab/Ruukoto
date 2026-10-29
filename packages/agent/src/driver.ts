import { getCurrentSystemPrompt, getCurrentTools, createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
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
import { endTaskExecution, type TaskEndingContext } from "./task-ending.ts";
import { isDeepStrictEqual } from "node:util";
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
import type { AgentWaitSnapshot } from "@ruukoto/core/agent-wait.ts";
import { editStatsFromResult, parseSessionFile, snapUtf8End, type ParsedSessionEntry } from "@ruukoto/core/history.ts";
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
import { beginContextAssembly, ContextSendBlocked, type AgentReportContext, type ContextAssembly } from "./context-assembly.ts";
import type { JevRequestConfig } from "./jev.ts";
import type { HostToolContext } from "./host-tools.ts";
import { ownerQuestionCreatedByTask, ownerQuestionTaskEligible, type OwnerQuestion, type OwnerQuestionItem } from "@ruukoto/core/owner-questions.ts";
import type { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { expandSkillCommand, loadSkillLibrary, type SkillLibrary } from "./skills.ts";
import { validateSubAgentRole, validateSubAgentRoleLibrary, type SubAgentRoleLibrary } from "./subagent-roles.ts";
import { requireSubAgentDefinition, SubAgentDefinitionError, type SubAgentDefinitionSnapshot } from "@ruukoto/core/subagent-definition.ts";
import { SubAgentRoleError } from "./subagent-roles.ts";
import { buildHostToolSet, type HostCall, type HostToolFamily, type HostToolRuntime } from "./host-tool-families.ts";
import type { BackgroundProcessCalls } from "./background-process-tools.ts";
import { allowsCategory, executionProfile, subAgentAllows, taskToolSet, workflowAllows, type AgentResourcePhase, type ExecutionProfile, type TaskToolSet, type WorkflowExecutionProfile, sourceAllows } from "./tool-availability.ts";
import type { AgentWaitCall } from "./agent-wait-tools.ts";
import { WorkflowError, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import { requireSubAgentExecution, snapshotSubAgentExecution, SubAgentExecutionError, type SubAgentExecutionSnapshot } from "@ruukoto/core/subagent-execution.ts";
import { subAgentAccessPolicy, subAgentSourceProfile } from "./subagent-capabilities.ts";
import type { CodeCuaManager } from "./mcp/code.ts";
import type { McpToolInfo } from "./mcp/tools.ts";
import { mcpCredentialDigest } from "./mcp/client.ts";
import { McpSession } from "./mcp/session.ts";
import type { McpTimeouts } from "./mcp/client.ts";
import type { McpStore, McpToolEffect } from "./mcp/store.ts";
import type { Accessor } from "@ruukoto/core/access.ts";
import { taskAttachmentReferences } from "./owner-attachments.ts";
import type { AttachmentReference } from "@ruukoto/core/attachments.ts";
import { hasImageInput, IMAGE_INPUT_UNSUPPORTED, taskImageReferences, type ImageReference } from "./inbound-images.ts";

const FRAGMENT_INTERVAL_MS = 250;

/** 引导 user 消息携带的源 Task ID（随消息序列化进会话 JSONL，来源与正文一起成为历史）。 */
function guidanceSourceId(message: unknown): string | null {
  return message !== null && typeof message === "object" && typeof (message as { ruukotoSourceTaskId?: unknown }).ruukotoSourceTaskId === "string"
    ? (message as { ruukotoSourceTaskId: string }).ruukotoSourceTaskId
    : null;
}

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
  ownerQuestions?: { create(ctx: HostToolContext, questions: OwnerQuestionItem[]): OwnerQuestion };
  backgroundProcesses?: BackgroundProcessCalls & { active(sessionId: string): boolean };
  /** Jev 的本地模拟服务与超时覆盖，仅宿主测试注入。 */
  jev?: JevRequestConfig;
  /** 上下文压缩的摘要超时覆盖（issue 30），仅测试注入；生产 180 s。 */
  compaction?: { summaryTimeoutMs?: number };
  /** MCP（issue 16）：服务配置存储与超时覆盖；未配置时 MCP 工具不注册。 */
  mcp?: { store: McpStore; cua?: CodeCuaManager } & McpTimeouts;
  /** 宿主按任务收紧工具白名单；MCP 类别取自本地钉版配置，不接受模型声明。 */
  allowTaskTool?: (task: Task, name: string, mcpEffect?: McpToolEffect) => boolean;
  browser?: { allowed(task: Task): boolean; close(sessionId: string): Promise<boolean> };
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
   * SubAgent 结果候选与工作内消息；结果在有效模型响应后确认消费，其他身份恒为空。
   */
  parentInjection?: ParentDelivery["takeInjection"];
  parentInjectionRecheck?: (sessionId: string, resultTaskIds: string[], messageIds: string[]) => string | null;
  parentInjectionAccepted?: (taskId: string, resultTaskIds: string[], entryId: string, messageIds: string[]) => void;
  beforeModelRequest?: (task: Task) => void;
  afterModelRequest?: (task: Task) => void;
  reportContext?: (task: Task) => AgentReportContext | null;
  subAgentRoles?: () => SubAgentRoleLibrary;
  agentWait?: {
    initialPhase(task: Task): AgentResourcePhase;
    snapshot(task: Task): AgentWaitSnapshot | null;
    acquireResources(task: Task): Promise<boolean>;
    wait: AgentWaitCall;
  };
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
  private sdkDisposal: Promise<void> | null = null;
  private registry: ManagedProcessRegistry;
  private managedTaskId: string | null = null;
  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
  private processStops = new Map<ManagedEntry, Promise<boolean>>();
  private stoppingProcesses = 0;
  private ending = false;
  readonly router: ToolRouter;
  private currentTask: Task | null = null;
  private currentModelSupportsImages = false;
  private taskEnding: TaskEndingContext | null = null;
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
  private thinkingOffset = 0;
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
  /** 当前任务从官方注册表固定的 MCP 工具名。 */
  private mcpToolNames = new Set<string>();
  /** 首轮选定的授权元数据；任务恢复资源时保持，调用门继续求交。 */
  private currentMcpTools = new Map<string, McpToolInfo>();
  private mcpSession: McpSession | null = null;
  private mcpPreflights = 0;
  private mcpTaskToolsSelected = false;
  private mcpConfigurations = new Map<string, string>();
  /** SDK 装配的执行画像与角色正文签名。 */
  private toolSignature: string | null = null;
  /** 模型配置已应用、存活 SDK 会话待丢弃重建（issue 21 §4；见 updateModelDeps）。 */
  private sdkConfigStale = false;
  /** 执行画像（架构工单 08）：任务开始算一次、钉到下一任务开始；首个任务前为 null。 */
  private pinnedProfile: ExecutionProfile | null = null;
  /** 本任务允许的工具（任务开始时算一次；激活、发送前与调用门共用；null = 尚未算出，一律拒绝）。 */
  private taskTools: TaskToolSet | null = null;
  private eligibleTools: TaskToolSet | null = null;
  /** 本任务的模型上下文组装（任务开始时建、结束即丢；context 钩子与发送前复核共用）。 */
  private assembly: ContextAssembly | null = null;
  /** 原始 streamFunction（包装前保存；发送前检查在委托前执行）。 */
  private originalStreamFn: any = null;
  /** 任务开始时钉版的技能库（issue 22；null = 资料受限会话不读取）。 */
  private pinnedSkills: SkillLibrary | null = null;
  private workflowManagedUnits: ((entries: ManagedEntry[]) => void) | null = null;
  /** 用户消息落盘前附稳定图片引用；不把图片正文交给 SDK 历史写入。 */
  private pendingUserImages: ImageReference[] = [];
  private pendingUserAttachments: AttachmentReference[] = [];
  private resourcePhase: AgentResourcePhase = "execution";
  private backgroundObservation = false;
  private activeToolCalls = new Set<string>();
  private injection: ReturnType<ParentDelivery["takeInjection"]> | null = null;
  private injectionAccepted = false;
  private modelResponseAccepted = false;
  private reportContext: AgentReportContext | null = null;
  private pinnedDefinition: SubAgentDefinitionSnapshot | null = null;
  private pinnedRoles: SubAgentRoleLibrary | null = null;
  private pinnedExecution: SubAgentExecutionSnapshot | null = null;
  /**
   * 引导批次（coding-message-control）：joining = 已预留进当前边界的源 Task ID，
   * 源取消需等待本批落盘结果；steered = 本次 run 已向 SDK 移交过输入；
   * contaminated = 有已移交输入未能核实在权威历史，run 末必须丢弃 SDK／manager。
   */
  private guidanceJoining = new Set<string>();
  private guidanceJoined: Promise<void> = Promise.resolve();
  private guidanceJoinedResolve: (() => void) | null = null;
  private guidanceSteered = false;
  private guidanceContaminated = false;

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
      resourceAvailable: () => this.resourcePhase === "execution",
      onManagedIdentity: () => this.reportManagedUnits(),
      launcherFor: deps.launcherFor,
      verificationLauncher: deps.verificationLauncher,
      protectedRoots: deps.protectedRoots,
      skillRoots: () => this.pinnedSkills?.skills.map(skill => ({ name: skill.name, dir: skill.dir })) ?? [],
      artifactAccess: (task, artifact) => {
        if (this.profile.workflow) return !artifact.name.startsWith("prompt-snapshot:") &&
          this.verifyWorkflowTask(task) === null && Boolean(deps.workflow?.artifactAccess(task, artifact));
        if (this.profile.source) {
          const artifactSession = deps.store.getSession(artifact.sessionId);
          return !artifact.name.startsWith("prompt-snapshot:") && this.verifyWorkflowTask(task) === null && Boolean(artifactSession &&
            deps.access.canAccess(this.accessor(), artifactSession.projectId, "artifact"));
        }
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
      mcp: deps.mcp ? { store: deps.mcp.store, cua: deps.mcp.cua, supportsImages: async task => (await this.deps.modelCatalog.resolve(task.modelSelection!)).input?.includes("image") ?? false, tool: name => this.currentMcpTools.get(name), verifyCall: (task, name) => { this.refreshTaskTools(this.deps.store.getTask(task.id) ?? task); return this.taskTools?.allowed.has(name) ? null : this.toolRejection(name); }, call: async (params, hooks) => { if (!this.mcpSession) throw new Error("MCP SDK 未装配"); return this.mcpSession.call(params, hooks); }, evidence: () => this.mcpSession?.evidence() } : undefined,
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
  private allows(category: ToolCategory, profile = this.profile): boolean {
    if (category === "browser" && (profile.workflow || profile.toolSignature === "scheduled")) return false;
    return profile.source ? profile.source.categories.includes(category)
      : profile.workflow ? profile.workflow.categories.includes(category) : allowsCategory(profile.toolClass, category);
  }

  /** 已登记句柄变成真实执行身份时仍沿原任务记录，不重新登记单元。 */
  reportManagedUnits(): void {
    const entries = this.registry.list();
    if (this.managedTaskId) this.deps.onManagedUnits?.(this.managedTaskId, entries);
    this.workflowManagedUnits?.(entries);
  }

  setWorkflowManagedUnits(callback: (entries: ManagedEntry[]) => void): void { this.workflowManagedUnits = callback; }

  verifyWorkflowTask(task: Task): string | null {
    try { this.verifyRoleDefinition(task); }
    catch (error) {
      if (!(error instanceof SubAgentRoleError) && !(error instanceof SubAgentDefinitionError) && !(error instanceof SubAgentExecutionError)) throw error;
      return `${error.code}:${error.message}`;
    }
    const problem = this.deps.verifyTask?.(task);
    if (problem) return problem;
    if (this.injection) {
      const injectionProblem = this.deps.parentInjectionRecheck?.(this.session.id, this.injection.results.map(result => result.id), this.injection.messages.map(message => message.id));
      if (injectionProblem) return injectionProblem;
    }
    if (!this.profile.workflow) return null;
    return this.deps.workflow ? this.deps.workflow.verify(task) : "工作流步骤的宿主权限核实不可用";
  }

  private verifyRoleDefinition(task: Task): void {
    if (!task.subAgentId) return;
    const agent = this.deps.store.getSubAgent(task.subAgentId);
    if (!agent || agent.sessionId !== this.session.id) throw new SubAgentRoleError("definition_missing", "子代理角色身份缺失；核实记录后再继续。");
    const definition = validateSubAgentRole(requireSubAgentDefinition(agent));
    if (!this.pinnedDefinition || definition.digest !== this.pinnedDefinition.digest || (definition.kind === "host_review") !== Boolean(task.sourceEventId)) throw new SubAgentRoleError("definition_corrupt", "子代理角色内容或用途与执行绑定不一致；核实记录后再继续。");
    if (definition.kind === "host_review") return;
    const execution = requireSubAgentExecution(task.readScope?.execution);
    const current = this.deps.store.getTask(task.id);
    const saved = requireSubAgentExecution(current?.readScope?.execution);
    if (this.pinnedExecution && this.pinnedExecution.digest !== execution.digest || saved.digest !== execution.digest ||
        execution.roleDigest !== definition.digest || execution.accessMode !== task.accessMode || current?.accessMode !== execution.accessMode ||
        execution.source.projectId !== this.session.projectId || definition.tools?.some(name => !execution.tools.includes(name))) throw new SubAgentExecutionError("execution_binding_invalid");
    const policy = subAgentAccessPolicy(execution.source.accessMode, definition);
    if ((execution.accessMode === "full_access" && policy.accessMode !== "full_access") ||
        (execution.accessMode === "auto-review" && policy.accessMode === "confirm") ||
        (policy.protectSource && !execution.protectSource) || (execution.protectSource && execution.accessMode === "full_access")) throw new SubAgentExecutionError("execution_binding_invalid");
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
    if (this.profile.source || this.profile.workflow) {
      if (this.currentTask?.id !== ctx.taskId || (this.profile.source ?? this.profile.workflow)!.toolClass !== "main") return "步骤未绑定个人助手来源";
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
    const source = this.profile.source ?? this.profile.workflow;
    return { kind: "agent", projectId: source?.sourceProjectId ?? this.session.projectId,
      ...(source ? { grantIds: source.grantIds } : {}) };
  }

  private dataSessionReadable(ctx: HostToolContext, sessionId: string, category: "history" | "artifact"): boolean {
    const session = this.deps.store.getSession(sessionId);
    if (!session || !this.deps.access.canAccess(this.accessor(), session.projectId, category)) return false;
    const task = this.deps.store.getTask(ctx.taskId);
    if (this.profile.source && (!task || this.verifyWorkflowTask(task))) return false;
    return !this.profile.workflow || Boolean(task && this.verifyWorkflowTask(task) === null && this.deps.workflow?.historyAccess(task, sessionId));
  }

  private dataSourceReadable(ctx: HostToolContext, ref: MemorySourceRef): boolean {
    if (!this.deps.access.sourceRefAccessible(this.accessor(), ref)) return false;
    if (ref.kind === "history_entry") return this.dataSessionReadable(ctx, ref.sessionId, "history");
    if (ref.kind === "owner_note") return true;
    const artifact = this.deps.store.getArtifact(ref.artifactId);
    const task = this.deps.store.getTask(ctx.taskId);
    if (!artifact || ((this.profile.source || this.profile.workflow) && artifact.name.startsWith("prompt-snapshot:"))) return false;
    if (this.profile.source && (!task || this.verifyWorkflowTask(task))) return false;
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

  get currentTaskEnding(): TaskEndingContext | null {
    return this.taskEnding;
  }

  /** 会话记录更新后同步（如 sessionFile 落盘回填）。 */
  syncSessionRecord(latest: Session): void {
    if (this.session.cwdReal !== latest.cwdReal || this.session.cwdDev !== latest.cwdDev || this.session.cwdIno !== latest.cwdIno) this.sdkConfigStale = true;
    this.session.cwd = latest.cwd;
    this.session.cwdReal = latest.cwdReal;
    this.session.cwdDev = latest.cwdDev;
    this.session.cwdIno = latest.cwdIno;
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

  private hostToolRuntime(toolClass: HostToolRuntime["toolClass"] = this.profile.toolClass): HostToolRuntime {
    return {
      registry: this.registry,
      toolClass,
      call: { taskContext: () => null, bindCall: this.bindHostCall },
      identity: {
        verifyMain: (ctx) => this.verifyMainBinding(ctx),
        verifyHost: (ctx) => this.verifyDelegationHost(ctx),
      },
      data: {
        recordMemory: (ctx, memoryId) => {
          if (this.profile.workflow && this.currentTask?.id === ctx.taskId) this.deps.workflow?.recordMemory?.(this.currentTask, memoryId);
          if (this.profile.source && !this.profile.workflow && this.currentTask?.id === ctx.taskId) this.deps.store.withTx(() => {
            const task = this.deps.store.getTask(ctx.taskId);
            if (!task?.readScope) throw new SubAgentExecutionError("execution_missing");
            const ids = task.readScope.readMemories ?? [];
            if (ids.includes(memoryId)) return;
            this.deps.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?").run(JSON.stringify({ ...task.readScope, readMemories: [...ids, memoryId] }), task.id);
            this.deps.store.appendEvent({ type: "task.memory_accessed", taskId: task.id, sessionId: task.sessionId, memoryId }, { taskId: task.id, sessionId: task.sessionId });
          });
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
      agentWait: this.deps.agentWait ? async (ctx, sdkCallId, targets, timeoutMs, signal) => {
        const result = await this.deps.agentWait!.wait(ctx, sdkCallId, targets, timeoutMs, signal);
        if (!this.stopRequested && !signal?.aborted && result.reason !== "interrupted") await this.restoreWorkspace(ctx.taskId);
        return result;
      } : undefined,
      ownerQuestions: this.deps.ownerQuestions ? {
        create: (ctx, questions) => {
          const question = this.deps.ownerQuestions!.create(ctx, questions);
          const task = this.deps.store.getTask(ctx.taskId);
          if (task && this.currentTask?.id === task.id) this.refreshTaskTools(task);
          return question;
        },
      } : undefined,
      backgroundProcesses: this.deps.backgroundProcesses ? {
        start: (ctx, command, signal) => this.deps.backgroundProcesses!.start(ctx, command, signal),
        status: async (ctx, input) => {
          const result = this.deps.backgroundProcesses!.status(ctx, input);
          if (!this.deps.backgroundProcesses!.active(ctx.sessionId)) await this.restoreWorkspace(ctx.taskId);
          return result;
        },
        output: (ctx, input) => this.deps.backgroundProcesses!.output(ctx, input),
        stop: (ctx, processId) => this.deps.backgroundProcesses!.stop(ctx, processId),
        wait: async (ctx, processId, timeoutMs, signal) => {
          const result = await this.deps.backgroundProcesses!.wait(ctx, processId, timeoutMs, signal);
          if (!this.stopRequested && !signal?.aborted && result.reason !== "interrupted" && !this.deps.backgroundProcesses!.active(ctx.sessionId)) await this.restoreWorkspace(ctx.taskId);
          return result;
        },
      } : undefined,
    };
  }

  private sourceTools(profile: WorkflowExecutionProfile, mcp: ToolDefinition[]): { tools: ToolDefinition[]; names: ReadonlySet<string> } {
    const host = buildHostToolSet(this.deps.hostToolFamilies.filter(family => family.category !== "owner_question" && (profile.categories.includes(family.category) ||
      (family.category === "subagent" && profile.collaboration))), this.hostToolRuntime("subagent"));
    const coding = profile.categories.includes("coding") ? this.deps.toolFactory({ registry: this.registry, router: this.router })
      .filter(tool => profile.toolClass !== "main" || subAgentAllows({ write: true, review: false }, tool.name)) : [];
    return { names: host.names, tools: [...coding, ...host.tools, ...mcp].filter(tool => sourceAllows(profile, tool.name)) };
  }

  /** 只发现能力，不执行工具或改动父 Driver；入队方保存结果后仍须在执行前复核。 */
  async preflightSubAgent(source: WorkflowSource, definition: SubAgentDefinitionSnapshot, options: { tools?: string[]; verify?: boolean; workflow?: boolean } = {}): Promise<SubAgentExecutionSnapshot> {
    validateSubAgentRole(definition);
    const policy = subAgentAccessPolicy(source.accessMode, definition, options.verify);
    const profile = subAgentSourceProfile(source, options);
    const launcher = policy.protectSource ? this.deps.verificationLauncher?.() : this.deps.launcherFor(policy.accessMode);
    if (!launcher || (policy.protectSource && launcher.kind !== "native")) throw new SubAgentExecutionError("source_protection_unavailable", "来源保护的原生执行环境不可用；停止派发并报告拥有者。");
    const sourceTask = this.deps.store.getTask(source.taskId);
    if (!sourceTask?.modelSelection) throw new SubAgentExecutionError("source_invalid", "来源任务缺少模型选择；不能核实实际工具注册表。");
    if (sourceTask.sessionId !== this.session.id) throw new SubAgentExecutionError("source_invalid", "来源任务不属于当前会话；不能核实工具注册表。");
    if (profile.categories.includes("mcp") && this.deps.mcp) {
      const identity = this.deps.store.getSessionIdentity(sourceTask.sessionId);
      if (!identity) throw new SubAgentExecutionError("source_invalid", "来源会话身份缺失；不能核实工具注册表。");
      const sourceProfile = executionProfile({ identity, planMode: sourceTask.planMode,
        writeTarget: Boolean(sourceTask.workId && this.deps.store.getWorkDelegation(sourceTask.workId)?.writeTarget),
        review: identity.kind === "subagent" && (this.deps.taskMcp?.(sourceTask) ?? false), workflow: this.deps.workflow?.resolve(sourceTask) });
      this.mcpPreflights++;
      try {
        if (!this.sdk) await this.ensureSdk(await this.deps.modelCatalog.resolve(sourceTask.modelSelection), sourceTask.modelSelection.thinkingLevel, sourceProfile);
        await this.mcpSession?.ready();
      } finally { this.mcpPreflights--; }
    }
    if (this.currentTask?.id === source.taskId) this.refreshTaskTools(sourceTask);
    const catalog = new Map((profile.categories.includes("mcp") ? this.mcpSession?.tools() ?? [] : []).filter(meta => {
      if (meta.service.cua) return false;
      if (this.currentTask?.id !== source.taskId) return true;
      const captured = this.currentMcpTools.get(meta.exposedName);
      return this.taskTools?.allowed.has(meta.exposedName) && captured?.service.configVersion === meta.service.configVersion && captured.toolSignature === meta.toolSignature && captured.credentialDigest === (meta.service.credential ? mcpCredentialDigest(this.deps.credentials.get(meta.service.credential)) : null);
    }).map(meta => [meta.exposedName, { ...meta, credentialDigest: meta.service.credential ? mcpCredentialDigest(this.deps.credentials.get(meta.service.credential)) : null }]));
    const definitions = [...catalog.keys()].map(name => this.sdk!.getToolDefinition(name)!).filter(Boolean);

      const candidates = this.sourceTools({ ...profile, tools: undefined }, definitions).tools;
      const available = taskToolSet({ registered: candidates.map(tool => tool.name), plan: false,
        webSearchEnabled: this.deps.store.getWebSearch().state !== "disabled",
        mcpEffect: name => catalog.get(name)?.effect,
        narrow: (name, effect) => sourceAllows({ ...profile, tools: undefined }, name) && Boolean(sourceTask && (!this.deps.allowTaskTool || this.deps.allowTaskTool(sourceTask, name, effect))) });
      const required = [...new Set([...(definition.tools ?? []), ...(options.tools ?? [])])];
      const missing = required.filter(name => !available.allowed.has(name) || (definition.tools?.includes(name) && options.tools && !options.tools.includes(name)) ||
        (options.tools?.includes(name) && definition.tools && !definition.tools.includes(name)));
      if (missing.length) throw new SubAgentExecutionError("tools_unavailable", `角色所需工具不可用：${missing.map(name => `${name}（${definition.tools?.includes(name) && options.tools && !options.tools.includes(name) ? "步骤工具清单未包含" : options.tools?.includes(name) && definition.tools && !definition.tools.includes(name) ? "角色工具清单未包含" : available.reasonFor(name)}）`).join("、")}；调整角色或来源配置后重新派发。`);
      const selected = options.tools ?? definition.tools ?? [...available.allowed];
      const tools = selected.filter(name => !definition.tools || definition.tools.includes(name));
      return snapshotSubAgentExecution({ source, roleDigest: definition.digest, ...policy, tools, mcpSignature: this.mcpSignature([...catalog.values()]) });
  }

  private mcpSignature(tools: McpToolInfo[]): string {
    return tools.map(meta => `${meta.service.id}:${meta.service.configVersion}:${meta.exposedName}:${meta.toolSignature}:${meta.credentialDigest ?? ""}`).sort().join("|");
  }

  private async ensureSdk(model: any, thinkingLevel: ThinkingLevel, profile = this.profile): Promise<AgentSession> {
    if (this.sdkDisposal) await this.sdkDisposal;
    if (this.sdk) return this.sdk;
    const hostToolSet = profile.source ? this.sourceTools(profile.source, []) : buildHostToolSet(
      this.deps.hostToolFamilies.filter((family) =>
        (this.allows(family.category, profile) || (family.category === "subagent" && profile.toolClass === "subagent")) &&
        (family.category !== "owner_question" || Boolean(this.currentTask && this.deps.ownerQuestions && ownerQuestionTaskEligible(this.deps.store, this.currentTask))) &&
        (family.category !== "background_process" || Boolean(this.currentTask && this.deps.backgroundProcesses && ownerQuestionTaskEligible(this.deps.store, this.currentTask)))),
      this.hostToolRuntime(profile.toolClass),
    );
    const subAgentTools = profile.subAgentTools;
    const allTools = profile.source ? hostToolSet.tools : [
      ...(this.allows("coding", profile) ? this.deps.toolFactory({ registry: this.registry, router: this.router })
        .filter(tool => !profile.workflow || profile.toolClass !== "main" || subAgentAllows({ write: true, review: false }, tool.name)) : []),
      ...(profile.workflow && !this.allows("coding", profile)
        ? this.deps.toolFactory({ registry: this.registry, router: this.router }).filter(tool => subAgentAllows({ write: false, review: false }, tool.name)) : []),
      ...(subAgentTools
        ? this.deps.toolFactory({ registry: this.registry, router: this.router })
            .filter((t) => subAgentAllows(subAgentTools, t.name))
        : []),
      ...hostToolSet.tools,
    ];
    this.hostToolNames = hostToolSet.names;
    this.allToolNames = allTools.map((t) => t.name);
    if (new Set(this.allToolNames).size !== allTools.length) throw new Error("工具装配存在重复名字");
    this.mcpSession = this.deps.mcp && profile.planMcp ? new McpSession({
      ...this.deps.mcp, store: this.deps.mcp.store, credentials: this.deps.credentials, cua: this.deps.mcp.cua,
      task: () => this.currentTask,
      discover: () => this.resourcePhase === "execution" || this.mcpPreflights > 0,
      cuaAllowed: () => this.resourcePhase === "execution" && this.currentModelSupportsImages && !!this.currentTask && ownerQuestionTaskEligible(this.deps.store, this.currentTask),
      direct: () => !!this.pinnedExecution && !this.pinnedExecution.tools.includes("tool_search") || !!this.pinnedDefinition?.tools && !this.pinnedDefinition.tools.includes("tool_search") || !!this.currentTask && !!this.deps.allowTaskTool && !this.deps.allowTaskTool(this.currentTask, "tool_search"),
      allow: meta => {
        const current = this.deps.mcp!.store.getService(meta.service.id);
        const task = this.currentTask;
        return !!task && !this.stopRequested && !this.deps.store.getTask(task.id)?.effectUnknown &&
          current?.enabled === true && current.configVersion === meta.service.configVersion &&
          this.currentMcpTools.get(meta.exposedName)?.service.configVersion === meta.service.configVersion && this.currentMcpTools.get(meta.exposedName)?.toolSignature === meta.toolSignature && this.currentMcpTools.get(meta.exposedName)?.credentialDigest === (meta.service.credential ? mcpCredentialDigest(this.deps.credentials.get(meta.service.credential)) : null) && (this.taskTools?.allowed.has(meta.exposedName) ?? true);
      },
      dispatch: (id, params, signal) => this.router.executeRouted(id, params, signal),
      changed: () => { if (this.sdk) this.allToolNames = [...new Set([...allTools.map(tool => tool.name), ...this.sdk.getAllTools().map(tool => tool.name)])]; },
    }) : null;
    this.sdk = await createSdkSession({
      session: this.session,
      sessionsDir: this.deps.sessionsDir,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.modelRuntime,
      model,
      thinkingLevel,
      tools: allTools,
      systemPrompt: (profile.workflow
        ? SYSTEM_PROMPTS.workflow
        : profile.toolSignature === "scheduled"
        ? `${SYSTEM_PROMPTS.main}\n- 当前是宿主为本次定时计划创建的独立执行上下文，不读取主聊天或前次运行历史。任务按计划保存的模式执行，子任务与汇总属于本次运行。完成全部工作后给出最终结果或失败原因；宿主向创建时固定的目标发送一次最终回报，无目标则保存结果。`
        : SYSTEM_PROMPTS[profile.toolClass]) + (this.pinnedDefinition ? `\n[${this.pinnedDefinition.kind === "role" ? `子代理角色 ${this.pinnedDefinition.name}` : "宿主固定评审"}]\n${this.pinnedDefinition.body}\n[/子代理定义]` : ""),
      mcp: this.mcpSession ?? undefined,
      hooks: {
        onToolCall: (event) => this.handleToolCall(event),
        onSessionEvent: (event) => this.handleSessionEvent(event),
        bindHostApi: (api) => {
          this.markerApi = api.appendEntry;
        },
        onContext: (messages) => this.handleContext(messages),
      },
    });
    if (this.mcpSession) {
      this.hostToolNames = new Set([...this.hostToolNames, "tool_search"]);
      this.allToolNames = [...new Set([...this.allToolNames, ...this.sdk.getAllTools().map(tool => tool.name)])];
    }
    this.wrapStreamFunction(this.sdk);
    const sdk = this.sdk;
    const finishTurn = sdk.agent.finishTurn;
    sdk.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      const task = this.currentTask;
      if (!task) return decision || undefined;
      if (this.deps.store.listToolOpsByTask(task.id).some(op => op.mcp && op.effectUnknown)) return { action: "end" };
      // 引导边界预留（coding-message-control）：尊重 SDK 与停止的原有决定；只有可
      // 继续且存在持久接纳的引导时才续轮。预留（joining）与源取消在核心库事务上
      // 互斥——先取消者不在 pending，先预留者令取消等待本批落盘结果。
      if (this.stopRequested || signal?.aborted || turn.message.stopReason === "error" || turn.message.stopReason === "aborted" || decision?.action === "end") {
        return decision || undefined;
      }
      const pending = this.deps.store.withTx(() => {
        const list = this.deps.store.listTaskGuidance(task.id).filter(guidance => guidance.state === "pending");
        for (const guidance of list) this.guidanceJoining.add(guidance.sourceTaskId);
        return list;
      });
      if (pending.length === 0) return decision || undefined;
      this.guidanceJoined = new Promise<void>(done => { this.guidanceJoinedResolve = done; });
      return { action: "continue" };
    };
    const prepareNextTurn = sdk.agent.prepareNextTurnWithContext;
    if (prepareNextTurn) {
      sdk.agent.prepareNextTurnWithContext = async (turn, signal) => {
        const next = await prepareNextTurn(turn, signal);
        const task = this.currentTask;
        if (!task || this.stopRequested || signal?.aborted) return next || undefined;
        // 选批截点（下一请求的输入截点）：同步事务内重读持久路由并移交 SDK——
        // 取消先提交者已不在 pending；已预留者取消在等落盘结果，仍在 pending 同批接入。
        // 准备期间收到、尚未取消的引导按持久接纳次序一起排入。
        this.deps.store.withTx(() => {
          for (const guidance of this.deps.store.listTaskGuidance(task.id)) {
            if (guidance.state !== "pending") continue;
            const source = this.deps.store.getTask(guidance.sourceTaskId);
            if (!source || source.status !== "queued") continue;
            const media = taskImageReferences(source, this.deps.store);
            // 目标模型不支持图片：本条不移交，留在路由；目标结束按回退回队首。
            if (media.length > 0 && !this.currentModelSupportsImages) continue;
            this.guidanceJoining.add(guidance.sourceTaskId);
            this.guidanceSteered = true;
            sdk.agent.steer({
              role: "user",
              content: [{ type: "text", text: source.input }],
              timestamp: Date.now(),
              ruukotoSourceTaskId: source.id,
              ruukotoTaskId: task.id,
              ruukotoAttachmentRefs: taskAttachmentReferences(source, this.deps.store),
              ruukotoMediaRefs: media,
            } as any);
          }
        });
        return next || undefined;
      };
    }
    const prepareRequest = sdk.agent.prepareRequest;
    sdk.agent.prepareRequest = async (request, signal) => {
      const next = await prepareRequest?.(request, signal);
      this.settleGuidanceBatch();
      return next || undefined;
    };
    sdk.setSteeringMode("all");
    // 目标停止后的接入阻断：监听先于 JSONL append 同步触发；已停止时让追加失败，
    // 把本轮收束成停止而不是把未核实的输入写进权威历史。
    sdk.subscribe((event) => {
      if ((event.type === "message_start" || event.type === "message_end") && this.stopRequested && guidanceSourceId((event as { message?: unknown }).message)) {
        this.guidanceContaminated = true;
        throw Object.assign(new Error("引导接入在目标停止后被阻断，本次运行按停止收束"), { code: "guidance_stopped_before_append" });
      }
    });
    return this.sdk;
  }

  /** 批次落定（prepareRequest）：核实实际 JSONL——已落 entry 记 joined 并解除本批取消等待。 */
  private settleGuidanceBatch(): void {
    if (this.guidanceJoining.size === 0) return;
    const file = this.sdk?.sessionFile;
    const entries = file && fs.existsSync(file) ? parseSessionFile(file) : [];
    this.deps.store.withTx(() => {
      for (const sourceTaskId of [...this.guidanceJoining]) {
        const entry = entries.find(e => e.type === "message" && guidanceSourceId(e.message) === sourceTaskId);
        if (entry) this.deps.store.recordTaskGuidanceEntry(sourceTaskId, this.deps.store.getTaskGuidance(sourceTaskId)!.targetTaskId, entry.id);
        else this.guidanceContaminated = true; // 已移交 SDK 却未落权威历史：manager 可能有残留，run 末丢弃
        this.guidanceJoining.delete(sourceTaskId);
      }
    });
    this.releaseGuidanceWaiters();
  }

  private releaseGuidanceWaiters(): void {
    const resolve = this.guidanceJoinedResolve;
    this.guidanceJoinedResolve = null;
    resolve?.();
  }

  /**
   * 目标结束事务内裁决引导路由：已落权威历史的源归本任务（joined），
   * 未落的 pending 源回普通队首；同时解除所有源取消的等待。
   */
  private settleGuidanceAtTaskEnd(taskId: string): void {
    const pending = this.deps.store.listTaskGuidance(taskId).filter(guidance => guidance.state === "pending");
    if (pending.length > 0) {
      const file = this.sdk?.sessionFile;
      const entries = file && fs.existsSync(file) ? parseSessionFile(file) : [];
      for (const guidance of pending) {
        const entry = entries.find(e => e.type === "message" && guidanceSourceId(e.message) === guidance.sourceTaskId);
        if (entry) this.deps.store.recordTaskGuidanceEntry(guidance.sourceTaskId, guidance.targetTaskId, entry.id);
      }
    }
    this.deps.store.fallbackTaskGuidance(taskId);
    this.guidanceJoining.clear();
    this.releaseGuidanceWaiters();
  }

  /** 取消待接入引导源：已预留进当前批次的等待本批落定（可能已接入），未预留的立即可取消。 */
  async waitGuidanceSource(sourceTaskId: string): Promise<void> {
    if (this.guidanceJoining.has(sourceTaskId)) await this.guidanceJoined;
  }

  /** 显式引导接入：未消费审批已在受理事务内 stale；这里解除工具等待，让运行到达下一边界。 */
  releaseGuidanceWaits(): void {
    this.approvals.supersedeAll();
  }

  /** 工具执行入口按 sdkCallId 绑定宿主上下文（execute 包装时调用）。 */
  private readonly bindHostCall = (sdkCallId: string): HostCall => {
    const ctx = this.hostToolCalls.get(sdkCallId) ?? null;
    if (ctx) {
      const op = this.deps.store.getToolOp(ctx.hostOpId);
      if (!op || !this.taskTools?.allowed.has(op.toolName) || this.stopRequested) throw new ExecutionError("resource_unavailable", "执行资源未取得或任务已停止，请等待后继续");
    }
    if (ctx && (this.profile.source || this.profile.workflow)) {
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
  private async handleContext(messages: any[]): Promise<{ messages: any[] } | undefined> {
    const sdk = this.sdk;
    if (!this.assembly || !sdk) return undefined;
    await this.mcpSession?.sync();
    if (this.currentTask) this.refreshTaskTools(this.deps.store.getTask(this.currentTask.id)!);
    const tools = [...getCurrentTools(messages).filter(tool => !tool.name.startsWith("mcp__")), ...sdk.getActiveToolNames().filter(name => name.startsWith("mcp__")).map(name => sdk.getToolDefinition(name)!).filter(Boolean).map(toToolDeclaration)];
    const system = createInitialSystemMessage(getCurrentSystemPrompt(messages), tools);
    const transcript = system ? [system, ...messages.filter(message => message.role !== "system")] : messages;
    const result = await this.assembly.assemble(transcript.filter(message => message.role !== "system"), {
      systemPrompt: getCurrentSystemPrompt(transcript),
      tools: getCurrentTools(transcript),
      model: sdk.model,
      sessionFile: sdk.sessionFile,
    });
    if (!result) return undefined;
    return { messages: system ? [system, ...result.messages] : result.messages };
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
        this.deps.beforeModelRequest?.(task);
      } catch (err) {
        if (err instanceof ContextSendBlocked) this.lastBlockedReason = err.message;
        throw err;
      }
      this.beginModelRequest(task);
      this.flushEntryRefs(task);
      const stream = await original.call(agent, model, context, options);
      assembly.afterSend(stream);
      return stream;
    };
  }

  /** 发送前本模块的检查（模型选择与工具白名单）：失败即抛（宿主原因已保存；Driver 据此中断任务）。 */
  private checkBeforeSend(task: Task, model: any, context: any, options: any): void {
    this.verifyRoleDefinition(task);
    const fresh = this.deps.store.getTask(task.id) ?? task;
    this.refreshTaskTools(fresh);
    const workflowProblem = this.verifyWorkflowTask(task);
    if (workflowProblem) throw new ContextSendBlocked(`workflow_source_invalid:${workflowProblem}`);
    this.verifyReportContext(task);
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
    {
      const forbidden = getCurrentTools(context.messages)
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

  async run(task: Task, ending?: TaskEndingContext): Promise<void> {
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
    this.pinnedDefinition = identity.kind === "subagent" ? validateSubAgentRole(requireSubAgentDefinition(identity.agent)) : null;
    this.pinnedExecution = this.pinnedDefinition?.kind === "role" ? requireSubAgentExecution(task.readScope?.execution) : null;
    this.verifyRoleDefinition(task);
    const workflow = this.deps.workflow?.resolve(task);
    if (identity.kind === "subagent" && identity.workflow && !workflow) throw new WorkflowError("source_invalid");
    this.pinnedProfile = executionProfile({
      identity,
      writeTarget: Boolean(task.workId && this.deps.store.getWorkDelegation(task.workId)?.writeTarget),
      review: identity.kind === "subagent" && (this.deps.taskMcp?.(task) ?? false),
      planMode: task.planMode,
      workflow,
      source: this.pinnedExecution ? subAgentSourceProfile(this.pinnedExecution.source, { tools: this.pinnedExecution.tools, workflow: Boolean(workflow), verify: workflow?.hostVerify }) : null,
    });
    if (this.deps.ownerQuestions && identity.kind === "dev") this.pinnedProfile.toolSignature += `|owner-question:${ownerQuestionTaskEligible(this.deps.store, task)}`;
    this.mcpTaskToolsSelected = false;
    this.mcpConfigurations = new Map(this.deps.mcp?.store.listServices().filter(service => service.enabled).map(service => [service.id, `${service.configVersion}:${service.credential ? mcpCredentialDigest(this.deps.credentials.get(service.credential)) ?? "missing" : "anonymous"}`]));
    const resourcePhase = this.deps.agentWait?.initialPhase(task) ?? "execution";
    const referenceSnapshot = resourcePhase === "conversation" ? this.deps.agentWait?.snapshot(task) ?? null : null;
    if (this.pinnedExecution && resourcePhase === "conversation" && !referenceSnapshot) throw new SubAgentExecutionError("reference_snapshot_missing", "内部对话所需的参考快照缺失；停止本次执行并报告拥有者。");
    this.currentTask = task;
    this.taskEnding = ending ?? { taskId: task.id, stopSnapshot: null };
    this.stopRequested = false;
    this.stopPromise = null;
    this.guidanceJoining.clear();
    this.guidanceJoined = Promise.resolve();
    this.guidanceJoinedResolve = null;
    this.guidanceSteered = false;
    this.guidanceContaminated = false;
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
    this.pendingUserAttachments = [];
    this.taskTools = null;
    this.eligibleTools = null;
    this.resourcePhase = resourcePhase;
    this.backgroundObservation = this.deps.backgroundProcesses?.active(task.sessionId) ?? false;
    this.recordResourcePhase(task);
    this.activeToolCalls.clear();
    this.modelResponseAccepted = false;
    // Note: 见 .agents/notes/implemented/simplification/2026-10-28-home-skills-discovery.md
    this.pinnedSkills = this.resourcePhase === "conversation" ? referenceSnapshot?.taskId === task.id ? referenceSnapshot.skills : referenceSnapshot?.skills ? loadSkillLibrary() : null
      : this.profile.restricted && !this.profile.source && !this.profile.workflow ? null : this.allows("skills") ? loadSkillLibrary() : null;
    this.pinnedRoles = this.resourcePhase === "conversation" ? referenceSnapshot?.roles ?? null
      : this.allows("subagent") && this.profile.toolClass !== "subagent" ? this.deps.subAgentRoles?.() ?? null : null;
    if (this.pinnedRoles) validateSubAgentRoleLibrary(this.pinnedRoles);
    // SubAgent 结果注入（agent-direction issue 11）与工作内消息注入（issue 13）：
    // 摘要与消息正文由宿主写定，不伪装拥有者新请求，也不授予委派权限。
    const injection = this.deps.parentInjection?.(this.session.id);
    this.injection = injection ?? null;
    this.injectionAccepted = false;
    this.reportContext = structuredClone(this.deps.reportContext?.(task) ?? null);
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
      roles: this.pinnedRoles,
      resourcePhase: this.resourcePhase,
      backgroundObservation: this.backgroundObservation,
      referenceSnapshot,
      referenceSource: this.pinnedExecution?.source,
      subagentResults,
      subagentMessages,
      reportContext: this.reportContext,
    }, this.deps);
    this.runPromise = this.runInner(task);
    try {
      await this.runPromise;
    } finally {
      await this.stopPromise;
      this.assembly?.abort();
      this.assembly = null;
      // 引导收尾：解除仍在等待的源取消；已移交却未核实落盘或停止时移交过输入的
      // SDK/manager 可能残留未落盘 entry，必须丢弃，由下次运行从权威 JSONL 重开。
      this.guidanceJoining.clear();
      this.releaseGuidanceWaiters();
      if (this.guidanceSteered && (this.stopRequested || this.guidanceContaminated)) await this.dropSdkForToolChange();
      this.guidanceSteered = false;
      this.guidanceContaminated = false;
      this.flushOutput();
      this.endThinking();
      this.currentMcpTools.clear();
      this.mcpSession?.qualify();
      this.mcpToolNames = new Set();
      this.runPromise = null;
      this.currentTask = null;
      this.taskEnding = null;
      this.activeToolCalls.clear();
    }
  }

  private async selectMcpTools(): Promise<void> {
    if (this.resourcePhase !== "execution") return;
    await this.mcpSession?.ready();
    if (this.currentTask) for (const service of this.mcpSession?.unavailable() ?? []) this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "mcp.service_unavailable", serviceId: service.id, taskId: this.currentTask!.id, sessionId: this.currentTask!.sessionId, name: service.name, endpoint: service.endpoint, reason: `服务尚未就绪或未提供允许的工具（${this.mcpSession!.failure(service)}）；本任务不使用该服务。` }, { taskId: this.currentTask!.id, sessionId: this.currentTask!.sessionId }));
    this.currentMcpTools = new Map(this.mcpSession?.tools().filter(meta => this.mcpConfigurations.get(meta.service.id) === `${meta.service.configVersion}:${meta.service.credential ? mcpCredentialDigest(this.deps.credentials.get(meta.service.credential)) ?? "missing" : "anonymous"}`).map(meta => [meta.exposedName, { ...meta, credentialDigest: meta.service.credential ? mcpCredentialDigest(this.deps.credentials.get(meta.service.credential)) : null }]));
    this.mcpToolNames = new Set(this.currentMcpTools.keys());
    this.mcpTaskToolsSelected = true;
    if (this.pinnedExecution && this.mcpSignature([...this.currentMcpTools.values()]) !== this.pinnedExecution.mcpSignature) throw new SubAgentExecutionError("mcp_configuration_changed", "来源 MCP 工具已改变；停止执行并重新核实来源。");
    if (this.sdk) this.allToolNames = [...new Set([...this.allToolNames, ...this.sdk.getAllTools().map(tool => tool.name)])];
  }

  /** 取消与队列回收共用一次关闭；停止失败时保留原 SDK 待核实。
   * Note: 见 .agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md
   */
  private dropSdkForToolChange(): Promise<void> {
    if (this.sdkDisposal) return this.sdkDisposal;
    const sdk = this.sdk;
    if (!sdk) return Promise.resolve();
    this.sdkDisposal = (async () => {
      await this.deps.mcp?.cua?.shutdown(this.session.id);
      await sdk.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      sdk.dispose();
      this.sdk = null;
      this.mcpSession = null;
      this.originalStreamFn = null;
      this.markerApi = null;
    })().finally(() => { this.sdkDisposal = null; });
    return this.sdkDisposal;
  }

  private clearMcpTaskTools(): void {
    this.currentMcpTools.clear();
    this.mcpSession?.qualify();
  }

  private recordResourcePhase(task: Task): void {
    this.deps.store.withTx(() => this.deps.store.appendEvent({ type: "task.resources_changed", taskId: task.id, sessionId: task.sessionId, phase: this.resourcePhase }, { taskId: task.id, sessionId: task.sessionId }));
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
      this.currentModelSupportsImages = !!model.input?.includes("image");
      this.pendingUserImages = taskImageReferences(task, this.deps.store);
      this.pendingUserAttachments = taskAttachmentReferences(task, this.deps.store);
      if (this.pendingUserImages.length > 0 && !model?.input?.includes("image")) {
        throw new Error(`${IMAGE_INPUT_UNSUPPORTED}:所选模型不支持图片输入`);
      }
      // 模型配置应用后（issue 21 §4）：旧 SDK 会话闭包持有旧 ModelRuntime，
      // 任务边界处丢弃，由 ensureSdk 以新模型栈重建（历史在会话文件中）
      if (this.sdkConfigStale) {
        await this.dropSdkForToolChange();
        this.sdkConfigStale = false;
      }
      const toolSignature = `${this.profile.toolSignature}|${this.pinnedDefinition?.digest ?? ""}`;
      if (this.sdk && this.resourcePhase !== "conversation" && toolSignature !== this.toolSignature) await this.dropSdkForToolChange();
      sdk = await this.ensureSdk(model, task.modelSelection.thinkingLevel);
      await this.selectMcpTools();
      if (this.resourcePhase !== "conversation" || this.toolSignature === null) this.toolSignature = toolSignature;
      if (sdk.model?.provider !== model.provider || sdk.model?.id !== model.id) await sdk.setModel(model);
      sdk.setThinkingLevel(task.modelSelection.thinkingLevel);
      if (sdk.model?.provider !== model.provider || sdk.model?.id !== model.id || sdk.thinkingLevel !== task.modelSelection.thinkingLevel) {
        throw new Error("model_selection_mismatch:SDK 未应用任务模型配置");
      }
    } catch (err) {
      this.clearMcpTaskTools();
      await this.finalize(task, "failed", { errorMessage: `SDK 会话创建失败：${(err as Error).message}` });
      return;
    }

    // 任务开始固定本任务允许的工具（架构工单 03）：完整注册表减去任务收窄（计划模式、
    // 宿主按任务收窄）与项目关闭的 Web Search（issue 20：模型不可见、系统提示同步重建；
    // 任务内的禁用由工具按调用新鲜检查立即阻止）。每次从完整注册表重算，宿主对当前
    // 任务的限制不带入下一任务。
    this.refreshTaskTools(task);

    // 会话文件路径尽早落库：崩溃后重启才能打开同一份 JSONL 而不是另起新文件
    const currentFile = sdk.sessionFile;
    if (currentFile && currentFile !== this.session.sessionFile) {
      this.deps.store.withTx(() => {
        this.deps.store.setSessionFile(this.session.id, currentFile);
        this.session.sessionFile = currentFile;
      });
    }

    if (this.stopRequested) {
      await this.killManagedProcesses();
      await this.finalize(task, "interrupted", { interruptReason: "aborted" });
      return;
    }

    let promptText: string;
    try {
      promptText = this.profile.restricted ? task.input : expandSkillCommand(this.pinnedSkills, task.input, this.profile.toolClass === "main" ? undefined : "bash");
    } catch (err) {
      await this.finalize(task, "failed", { errorMessage: (err as Error).message });
      return;
    }

    this.appendMarker(TASK_START_MARKER, { taskId: task.id, requestId: task.requestId });
    if (this.pinnedRoles) this.appendMarker("ruukoto_subagent_roles", { taskId: task.id, ...this.pinnedRoles });
    if (this.pinnedExecution) this.appendMarker("ruukoto_subagent_execution", { taskId: task.id, ...this.pinnedExecution });
    if (this.injection && (this.injection.results.length || this.injection.messages.length)) {
      this.appendMarker("ruukoto_parent_injection", { taskId: task.id, results: this.injection.results,
        messages: this.injection.messages });
    }
    if (this.reportContext) this.appendMarker("ruukoto_agent_report_context", { taskId: task.id, ...this.reportContext });
    try {
      await sdk.prompt(promptText);

    } catch (err) {
      await this.killManagedProcesses();
      if (!this.stopRequested) await this.finalize(task, "failed", { errorMessage: (err as Error).message });
      return;
    }

    await this.killManagedProcesses();
    if (this.stopRequested) return;

    const lastAssistant = findLastAssistant(sdk.messages as any[]);
    const stopReason: string = lastAssistant?.stopReason ?? "error";

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

    if (this.deps.store.listToolOpsByTask(task.id).some(op => op.mcp && op.effectUnknown)) {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted" });
      await this.finalize(task, "interrupted", { interruptReason: "mcp_effect_unknown" });
      return;
    }

    if (stopReason === "error") {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "failed" });
      await this.finalize(task, "failed", { errorMessage: lastAssistant?.errorMessage ?? "模型返回错误" });
      return;
    }

    this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "completed" });
    const verification = this.verifyAndLinkHistory(task);
    if (verification.ok) await this.finalize(task, "completed", {});
    else await this.finalize(task, "interrupted", { interruptReason: verification.reason! });
  }

  private refreshTaskTools(task: Task): void {
    const allowTaskTool = this.deps.allowTaskTool;
    const subAgentTools = this.profile.subAgentTools;
    const eligible = taskToolSet({
      registered: this.allToolNames,
      ownerQuestionsEnabled: Boolean(this.deps.ownerQuestions && ownerQuestionTaskEligible(this.deps.store, task)),
      ownerQuestionPending: ownerQuestionCreatedByTask(this.deps.store, task.id),
      backgroundProcessesEnabled: Boolean(this.deps.backgroundProcesses && ownerQuestionTaskEligible(this.deps.store, task)),
      backgroundStartEnabled: task.accessMode === "full_access" && !task.planMode && this.resourcePhase === "execution",
      backgroundObservation: this.backgroundObservation,
      resourcePhase: this.resourcePhase,
      plan: this.profile.plan,
      browserEnabled: this.deps.browser?.allowed(task) ?? false,
      webSearchEnabled: this.deps.store.getWebSearch().state !== "disabled",
      mcpEffect: (name) => this.currentMcpTools.get(name)?.effect,
      // SubAgent 任务收窄（issue 16）：画像工具集决定清单（装配、发送前与调用门
      // 同一结论）；收窄不进 workerKey。宿主评审任务（issue 19）另加 effect=read
      // 的 MCP（只读资料入口，写与副作用不明的 MCP 留在拒绝集）
      narrow:
        this.profile.source
          ? (name, effect) => sourceAllows(this.profile.source!, name) && (!allowTaskTool || allowTaskTool(task, name, effect))
          : this.profile.workflow
          ? (name, effect) => workflowAllows(this.profile.workflow!, name) && (!allowTaskTool || allowTaskTool(task, name, effect))
          : subAgentTools
          ? (name, effect) => subAgentAllows(subAgentTools, name, effect)
          : allowTaskTool
            ? (name, effect) => allowTaskTool(task, name, effect)
            : undefined,
    });
    if (this.pinnedExecution && this.resourcePhase === "execution") {
      const missing = this.pinnedExecution.tools.filter(name => !eligible.allowed.has(name));
      if (missing.length) throw new SubAgentExecutionError("tools_unavailable", `已固定工具不可用：${missing.join("、")}；停止本次执行并报告拥有者。`);
    }
    this.eligibleTools = eligible;
    const allowed = new Set([...eligible.allowed].filter(name => !name.startsWith("mcp__") || this.currentMcpTools.has(name) && !task.effectUnknown));
    this.taskTools = { allowed, reasonFor: name => eligible.reasonFor(name) };
    this.mcpSession?.qualify();
    const active = new Set(this.sdk?.getActiveToolNames());
    this.sdk?.setActiveToolsByName([...allowed].filter(name => !name.startsWith("mcp__") || this.currentMcpTools.get(name)?.exposure === "direct" || active.has(name)));

  }

  referenceSnapshot(): AgentWaitSnapshot {
    const task = this.currentTask && this.deps.store.getTask(this.currentTask.id);
    if (!task || !this.assembly) throw new ExecutionError("task_mismatch", "没有可记录的活动任务参考快照");
    const selection = this.deps.store.listSelectionRecordsByTask(task.id).at(-1);
    return { taskId: task.id, permissionVersion: task.permissionVersion, selectionRecordId: selection?.id ?? null,
      promptArtifactId: selection?.promptArtifactId ?? null, instructions: this.assembly.referenceInstructions(), skills: structuredClone(this.pinnedSkills), roles: structuredClone(this.pinnedRoles) };
  }

  /** Runtime 先登记等待；核实成功后才可在事务内释放全部目录占用。 */
  // Note: 见 .agents/notes/implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md
  async yieldWorkspace(taskId: string, transfer?: (snapshot: AgentWaitSnapshot) => void): Promise<boolean> {
    const task = this.currentTask;
    if (!task || task.id !== taskId || this.stopRequested) throw new ExecutionError("task_mismatch", "等待任务已停止或不属于当前 Driver");
    if (this.activeToolCalls.size > 1) throw new ExecutionError("tool_boundary_busy", "其他工具仍在执行，请等当前工具完成后再等待后台工作");
    const ending = this.taskEnding!, previous = ending.stopSnapshot;
    const candidate = ending.stopSnapshot ??= this.deps.ledger.beginStop(task.id);
    if (!await this.stopManagedProcesses(task.id)) {
      this.stopRequested = true;
      await this.finalize(task, "interrupted", { interruptReason: "tool_process_unreaped", keepOccupancy: true, abort: true });
      return false;
    }
    if (!this.stopRequested && ending.stopSnapshot === candidate) ending.stopSnapshot = previous;
    transfer?.(this.referenceSnapshot());
    this.resourcePhase = "conversation";
    if (transfer) this.backgroundObservation = true;
    if (!transfer) this.recordResourcePhase(this.currentTask!);
    this.assembly?.setResourcePhase(this.resourcePhase, undefined, this.deps.backgroundProcesses?.active(task.sessionId));
    this.refreshTaskTools(this.deps.store.getTask(task.id)!);
    return true;
  }

  /** 业务工具恢复只经过宿主资源取得与来源复核；竞争失败时继续内部对话。 */
  async restoreWorkspace(taskId: string): Promise<boolean> {
    const task = this.currentTask;
    if (!task || task.id !== taskId || this.stopRequested) return false;
    if (this.resourcePhase === "execution") return true;
    if (!this.deps.agentWait || !await this.deps.agentWait.acquireResources(task)) return false;
    if (this.stopRequested || this.deps.store.getTask(task.id)?.cancelRequested) return false;
    this.resourcePhase = "execution";
    this.backgroundObservation = false;
    this.recordResourcePhase(this.currentTask!);
    if (this.mcpTaskToolsSelected) await this.mcpSession?.ready(); else await this.selectMcpTools();
    if (this.stopRequested) return false;
    this.assembly?.setResourcePhase(this.resourcePhase, this.pinnedSkills);
    this.refreshTaskTools(this.deps.store.getTask(task.id)!);
    return true;
  }

  private acceptParentInjection(task: Task): void {
    if (this.injectionAccepted || !this.injection || (!this.injection.results.length && !this.injection.messages.length)) return;
    const file = this.sdk?.sessionFile;
    const marker = file ? parseSessionFile(file).findLast(entry => entry.type === "custom" && entry.customType === "ruukoto_parent_injection" && (entry.data as { taskId?: string } | undefined)?.taskId === task.id) : null;
    if (!marker) throw new ContextSendBlocked("parent_injection_unrecorded:父级资料未登记到会话记录");
    this.deps.parentInjectionAccepted?.(task.id, this.injection.results.map(result => result.id), marker.id, this.injection.messages.map(message => message.id));
    this.injectionAccepted = true;
  }

  private verifyReportContext(task: Task): void {
    if (!this.reportContext) return;
    const file = this.sdk?.sessionFile;
    let entries: ParsedSessionEntry[];
    try { entries = file ? parseSessionFile(file) : []; }
    catch { throw new ContextSendBlocked("agent_report_context_unrecorded:报告参考输入未落盘或历史不可解析"); }
    const marker = entries.findLast(entry => entry.type === "custom" && entry.customType === "ruukoto_agent_report_context" &&
      (entry.data as { taskId?: string } | undefined)?.taskId === task.id);
    if (!marker || !isDeepStrictEqual(marker.data, { taskId: task.id, ...this.reportContext })) {
      throw new ContextSendBlocked("agent_report_context_unrecorded:报告参考输入未落盘或与本轮固定内容不同");
    }
  }

  private acceptModelResponse(task: Task): void {
    if (!this.modelResponseAccepted) return;
    // SDK 的 message_end 通知先于 appendMessage；下一事件才可核实首次会话的标记已落盘。
    this.flushEntryRefs(task);
    this.acceptParentInjection(task);
    this.deps.afterModelRequest?.(task);
    this.modelResponseAccepted = false;
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
    const result = await endTaskExecution({ store: this.deps.store, ledger: this.deps.ledger, onReleased: this.deps.onOccupancyReleased }, task, this.taskEnding!, {
      terminal: opts.terminal, reason: opts.reason, abort: true,
      unreapedReason: opts.modeSwitchFailure ? "mode_switch_unverified" : "tool_process_unreaped",
      modeSwitchFailure: opts.modeSwitchFailure,
      // 中止完成后在同一事务裁决引导路由：SDK 已收束，JSONL 是此时刻的权威历史。
      inTx: () => this.settleGuidanceAtTaskEnd(task.id),
      halt: async () => {
        this.assembly?.abort();
        this.approvals.cancelAll();
        // SDK 中止等待工具返回，须并行回收进程组以解除工具等待。
        const abortPromise = this.sdk?.isStreaming ? this.sdk.abort().catch(() => {
          // SDK 中止失败仍由执行单元回收与任务终态保护占用。
        }) : null;
        const [managedReaped, browserReaped] = await Promise.all([this.killManagedProcesses(), this.deps.browser?.close(task.sessionId) ?? true]);
        if (abortPromise) await abortPromise;
        this.clearMcpTaskTools();
        this.flushOutput();
        this.endThinking();
        return managedReaped && browserReaped;
      },
    });
    return result.reaped;
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
      keepOccupancy?: boolean;
      abort?: true;
      occupancyIssueReason?: string | null;
      modeSwitchFailure?: { to: AccessMode; reason: string };
    },
  ): Promise<void> {
    await endTaskExecution({ store: this.deps.store, ledger: this.deps.ledger, onReleased: this.deps.onOccupancyReleased }, task, this.taskEnding!, {
      terminal: to, reason: extra.interruptReason ?? extra.errorMessage, abort: extra.abort,
      unreapedReason: extra.occupancyIssueReason ?? "tool_process_unreaped", modeSwitchFailure: extra.modeSwitchFailure,
      inTx: () => this.settleGuidanceAtTaskEnd(task.id),
      halt: async () => {
        const reaped = await this.killManagedProcesses();
        this.flushOutput();
        this.endThinking();
        return !extra.keepOccupancy && reaped;
      },
    });
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
    // 交接失败沿停止前事实收尾；成功且没有并发中止时撤去候选，避免自然结束补账本。
    // Note: 见 .agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md
    const ending = this.taskEnding!, previous = ending.stopSnapshot;
    const candidate = ending.stopSnapshot ??= this.deps.ledger.beginStop(task.id);
    let reaped = false;
    try {
      const [managedReaped, browserReaped] = await Promise.all([this.stopManagedProcesses(task.id), this.deps.browser?.close(task.sessionId) ?? true]);
      reaped = managedReaped && browserReaped;
      if (!reaped) {
        throw new ExecutionError("mode_switch_unverified", "无法核实旧执行单元已退出，模式切换失败");
      }
      const switched = await this.router.prepareToolBoundary(task);
      this.refreshTaskTools(switched);
      if (!this.stopRequested && ending.stopSnapshot === candidate) ending.stopSnapshot = previous;
      return switched;
    } catch (err) {
      // 切换失败（无法核实旧执行单元退出）：任务无法安全继续
      this.stopRequested = true;
      const reason = err instanceof ExecutionError ? err.code : "mode_switch_failed";
      await this.finalize(task, "interrupted", {
        interruptReason: reason,
        abort: true,
        keepOccupancy: !reaped,
        occupancyIssueReason: "mode_switch_unverified",
        modeSwitchFailure: { to: task.pendingAccessMode, reason },
      });
      throw err;
    }
  }

  private async handleToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const current = this.currentTask;
    if (!current) return undefined;
    this.refreshTaskTools(this.deps.store.getTask(current.id) ?? current);
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

    if (event.toolName === "browser" && !this.deps.browser?.allowed(task)) {
      return { block: true, reason: "浏览器仅开放完全访问的拥有者会话" };
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
    const task = this.currentTask && this.deps.store.getTask(this.currentTask.id);
    if (task) this.refreshTaskTools(task);
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
    this.modelResponseAccepted = false;
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
    this.thinkingOffset = 0;
    this.emitThinking();
  }

  private emitThinking(): void {
    if (!this.thinking) return;
    const thinking = this.thinking;
    const last = thinking.text.charCodeAt(thinking.text.length - 1);
    const text = !thinking.endedAt && last >= 0xd800 && last <= 0xdbff ? thinking.text.slice(0, -1) : thinking.text;
    const bytes = Buffer.from(text, "utf8");
    let offset = this.thinkingOffset;
    // Note: 见 .agents/notes/implemented/feature/2026-10-18-complete-reasoning-and-preview.md
    this.deps.store.withTx(() => {
      do {
        const end = snapUtf8End(bytes, Math.min(offset + FRAGMENT_TEXT_CAP, bytes.length));
        const body = { ...thinking, offset, text: bytes.subarray(offset, end).toString("utf8"), endedAt: end === bytes.length ? thinking.endedAt : null };
        this.deps.store.appendEvent(body, { taskId: body.taskId, sessionId: body.sessionId });
        offset = end;
      } while (offset < bytes.length);
    });
    this.thinkingOffset = offset;
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
          if (update.type === "thinking_delta") this.thinking!.text += update.delta;
          if (firstExplicitThinking || update.type === "thinking_start" || Date.now() - this.lastThinkingAt >= FRAGMENT_INTERVAL_MS) this.emitThinking();
        } else if (update.type === "thinking_end") {
          // 部分 provider 把 end 延迟到整条消息结束，不重新打开已被正文结束的阶段。
          if (this.thinking && this.thinkingIndex === update.contentIndex) {
            if (update.content.startsWith(this.thinking.text)) this.thinking.text = update.content;
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
        if (event.message.role === "toolResult") {
          // SDK 在监听返回后同步落盘；逐条发引用，不等待同批其他工具结束。
          setImmediate(() => this.flushEntryRefs(task));
          return;
        }
        // 任务归属标记（coding-message-control）：本任务全部 user 输入（原始要求与
        // 已接入引导）共享目标 Task ID；上下文选择的"必留输入"按它界定任务跨度。
        if (event.message.role === "user" && (event.message as any).ruukotoTaskId === undefined) {
          (event.message as any).ruukotoTaskId = task.id;
        }
        if (event.message.role === "user" && this.pendingUserAttachments.length > 0) {
          (event.message as any).ruukotoAttachmentRefs = this.pendingUserAttachments;
          this.pendingUserAttachments = [];
        }
        if (event.message.role === "user" && this.pendingUserImages.length > 0) {
          // pi 的监听通知先于 appendMessage；同一对象也留在 agent.state 中。
          (event.message as any).ruukotoMediaRefs = this.pendingUserImages;
          this.pendingUserImages = [];
        }
        if (event.message.role !== "assistant") return;
        this.modelResponseAccepted = event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
        const text = extractText(event.message.content);
        const seen = this.currentPreview?.text ?? "";
        if (text.startsWith(seen)) this.appendOutput(text.slice(seen.length));
        this.flushOutput();
        this.endThinking();
        return;
      }
      case "tool_execution_start": {
        this.acceptModelResponse(task);
        this.activeToolCalls.add(event.toolCallId);
        return;
      }
      case "tool_execution_end": {
        this.activeToolCalls.delete(event.toolCallId);
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
        this.acceptModelResponse(task);
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
  // Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-trace-migration.md
  private flushEntryRefs(task: Task): void {
    if (this.managedTaskId !== task.id) return;
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
    this.clearMcpTaskTools();
    await this.dropSdkForToolChange();
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
