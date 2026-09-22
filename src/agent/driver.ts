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
 * - 上下文超限：检测后任务中断（context_overflow）并暂停该会话队列，
 *   不自动摘要、不重试。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { modelResponseBudget, type ModelCatalog } from "./model-selection.ts";
import {
  classifyForReview,
  ReviewAbortedError,
  REVIEW_POLICY_VERSION,
  type ApprovalReviewer,
} from "./review.ts";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { AccessMode, ConfirmationRequest, Session, Task } from "../core/types.ts";
import { randomId, TASK_END_MARKER, TASK_START_MARKER } from "../core/types.ts";
import { isToolOpExecutionUncertain, type Store } from "../core/store.ts";
import { parseSessionFile, tailTextByBytes, type ParsedSessionEntry } from "../core/history.ts";
import { FRAGMENT_TEXT_CAP } from "../core/views.ts";
import { grantCoversPath } from "../core/worktree.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { CredentialStore } from "./execution/credentials.ts";
import type { ExecutionError } from "./execution/launchers.ts";
import type { WorkerLauncher } from "./execution/launchers.ts";
import { createManagedProcessRegistry, type ManagedProcessRegistry } from "./managed-processes.ts";
import { createSdkSession } from "./session-factory.ts";
import { ToolRouter, ROUTED_TOOL_NAMES, type ApprovalOutcome } from "./tool-router.ts";
import type { ApprovalScope } from "../core/types.ts";
import type { AccessScope } from "../core/access.ts";
import type { HistoryIndex } from "../core/history-index.ts";
import type { MemoryStore, MemoryWithContent } from "../core/memory.ts";
import {
  DEFAULT_BUDGET_CONFIG,
  SELECTOR_STRATEGY,
  budgetConfigVersion,
  estimateMessageTokens,
  selectContext,
  validateBudgetConfig,
  type SelectorBudgetConfig,
  type SelectorOutput,
} from "./context-selector.ts";
import { createHostDataTools, HOST_DATA_TOOL_NAMES, type HostToolContext } from "./host-tools.ts";
import { createGitHubTools, GITHUB_TOOL_NAMES, type GitHubToolsDeps } from "./github/tools.ts";
import { createWebSearchTools, WEB_SEARCH_TOOL_NAMES, type WebSearchConfig } from "./web-search.ts";

const FRAGMENT_INTERVAL_MS = 250;

/** 请求前最终检查失败（预算/配对/选择缺失/记录落盘失败）：阻断发送。 */
export class ContextSendBlocked extends Error {
  readonly code: string;
  constructor(reason: string) {
    super(reason);
    this.code = reason.split(":", 1)[0] ?? "context_send_blocked";
  }
}

/**
 * 配对完整性：视图内 assistant 的每个 toolCall 必须有对应 toolResult，
 * 每个 toolResult 必须能回溯到同视图内的 toolCall（不可拆分组）。
 */
export function checkToolPairing(messages: any[], exemptCallIds?: Set<string>): string | null {
  const exempt = exemptCallIds ?? new Set<string>();
  const callIds = new Set<string>();
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type === "toolCall" && typeof part.id === "string" && !exempt.has(part.id)) callIds.add(part.id);
    }
  }
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m?.role === "toolResult" && typeof m.toolCallId === "string" && !exempt.has(m.toolCallId)) {
      if (!callIds.has(m.toolCallId)) return `toolResult 缺少对应 toolCall：${m.toolCallId}`;
      resultIds.add(m.toolCallId);
    }
  }
  for (const id of callIds) {
    if (!resultIds.has(id)) return `toolCall 缺少对应 toolResult：${id}`;
  }
  return null;
}

export interface DriverDeps {
  store: Store;
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
  /** GitHub 集成（issue 06）：未配置时 GitHub 宿主工具不注册。 */
  github?: Omit<GitHubToolsDeps, "store" | "artifacts" | "credentials" | "taskContext" | "bindCall" | "emit">;
  /** Web Search（issue 20）：Tavily 目标/超时覆盖（仅测试注入；生产缺省官方端点）。 */
  webSearch?: WebSearchConfig;
  /** 自动审查（issue 15）：auto-review 任务的审批请求先经其裁决；缺省时退化为纯人工。 */
  reviewer?: ApprovalReviewer;
}

type ConfirmationDecision = "approved" | "rejected" | "canceled" | "superseded";

export class Driver {
  readonly session: Session;
  private readonly deps: DriverDeps;
  private sdk: AgentSession | null = null;
  private registry: ManagedProcessRegistry;
  readonly router: ToolRouter;
  private currentTask: Task | null = null;
  private stopRequested = false;
  private confirmationWaiters = new Map<string, (decision: ConfirmationDecision) => void>();
  private pendingConfirmationCount = 0;
  /** 进行中的自动审查（按审批 id）；人工接管/停止时中止，迟到结果忽略。 */
  private reviewAborters = new Map<string, AbortController>();
  /** 本次任务中 sdkCallId → 宿主操作 id（结果记录与事件引用的关联键）。 */
  private callMap = new Map<string, string>();
  private flushedEntryIds = new Set<string>();
  private lastFragmentAt = 0;
  /**
   * 流式 assistant 消息标识：SDK 的 message_update 每次携带新的对象副本，
   * 不能按引用识别；改为 message_start 时按序分配，flushEntryRefs 按条目
   * 顺序消费（条目落盘顺序与 message_start 顺序一致）。
   */
  private currentMsgId: string | null = null;
  private pendingEntryMsgIds: string[] = [];
  /** 当前任务的最新输出预览（全量在内存；事件只发有界尾部）。 */
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
  /** 本轮模型调用的选择结果（context 钩子填充；最终检查核对）。 */
  private pendingSelection: SelectorOutput | null = null;
  /** 选择/资料读取失败的阻断原因（最终检查发现即拒绝发送）。 */
  private selectionBlockReason: string | null = null;
  /** 原始 streamFunction（包装前保存；最终检查在委托前执行）。 */
  private originalStreamFn: any = null;
  /**
   * 任务开始时钉版的上下文前缀：项目指令（受限读取 + 捕获产物）与继续
   * 来源任务要求。任务内不变；下一任务开始时重新读取（= 拥有者刷新入口）。
   */
  private pinnedContext: {
    instructions: { text: string; version: string; problems: string[] } | null;
    resumedFrom: { taskId: string; input: string } | null;
  } = { instructions: null, resumedFrom: null };

  constructor(session: Session, deps: DriverDeps) {
    this.session = session;
    this.deps = deps;
    this.registry = createManagedProcessRegistry();
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
        return deps.access.canAccess({ kind: "agent", projectId: this.session.projectId }, artifactSession.projectId, "artifact");
      },
      bridge: {
        awaitApproval: (input) => this.awaitApproval(input),
        supersedeAllWaiters: () => this.supersedeAllWaiters(),
      },
    });
  }

  get busy(): boolean {
    return this.currentTask !== null;
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

  private async ensureSdk(model: any, thinkingLevel: ThinkingLevel): Promise<AgentSession> {
    if (this.sdk) return this.sdk;
    const hostDataTools = createHostDataTools({
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
    // GitHub 宿主工具（issue 06）：与资料工具同一身份注入/绑定机制
    const githubTools = this.deps.github
      ? createGitHubTools({
          store: this.deps.store,
          artifacts: this.deps.artifacts,
          credentials: this.deps.credentials,
          taskContext: () => this.hostToolCtx,
          bindCall: this.bindHostCall,
          emit: (body, refs) => {
            this.deps.store.withTx(() => this.deps.store.appendEvent(body, refs));
          },
          ...this.deps.github,
        })
      : [];
    // Web Search 宿主工具（issue 20）：同一身份注入；项目禁用与否在任务开始
    // 钉版工具清单时判定（runInner），调用时另有新鲜检查
    const webSearchTools = createWebSearchTools({
      store: this.deps.store,
      artifacts: this.deps.artifacts,
      credentials: this.deps.credentials,
      taskContext: () => this.hostToolCtx,
      bindCall: this.bindHostCall,
      baseUrl: this.deps.webSearch?.baseUrl,
      timeoutMs: this.deps.webSearch?.timeoutMs,
    });
    const allTools = [
      ...this.deps.toolFactory({ registry: this.registry, router: this.router }),
      ...hostDataTools,
      ...githubTools,
      ...webSearchTools,
    ];
    this.allToolNames = allTools.map((t) => t.name);
    this.sdk = await createSdkSession({
      session: this.session,
      sessionsDir: this.deps.sessionsDir,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.modelRuntime,
      model,
      thinkingLevel,
      tools: allTools,
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

  // ---------- 上下文选择与请求前最终检查（issue 05 §3/§4） ----------

  private budgetConfig(): SelectorBudgetConfig {
    const model = this.sdk?.model;
    if (!model) throw new Error("model_not_applied:任务模型尚未应用");
    const response = modelResponseBudget(model);
    return validateBudgetConfig({
      ...DEFAULT_BUDGET_CONFIG,
      ...response,
      ...this.deps.budgetOverrides,
      contextWindow: Math.min(response.contextWindow, this.deps.budgetOverrides?.contextWindow ?? response.contextWindow),
      maxTokens: Math.min(response.maxTokens, this.deps.budgetOverrides?.maxTokens ?? response.maxTokens),
    });
  }

  /**
   * context 扩展钩子：每次模型调用前返回新消息视图。
   * pi 会捕获扩展异常继续运行，因此这里不抛错：失败原因记入
   * selectionBlockReason，由 streamFunction 包装（最终检查）拒绝发送。
   */
  private handleContext(messages: any[]): { messages: any[] } | undefined {
    const task = this.currentTask;
    if (!task || !this.sdk) return undefined;
    try {
      // 记忆注入前重校来源范围（§5：引用受限来源的派生记忆在授权撤销后
      // 不再注入；只记录可访问候选，排除原因不含他项目内容）
      const accessor = { kind: "agent", projectId: this.session.projectId } as const;
      const memories: MemoryWithContent[] = [];
      const preExcludedMemories: Array<{ memoryId: string; version: number; reason: string }> = [];
      for (const memory of this.deps.memories.listActiveFor(this.session.projectId)) {
        const version = this.deps.memories.getVersion(memory.id, memory.currentVersion);
        const refs = version?.sourceRefs ?? [];
        if (refs.every((ref) => this.deps.access.sourceRefAccessible(accessor, ref))) {
          memories.push(memory);
        } else {
          preExcludedMemories.push({
            memoryId: memory.id,
            version: memory.currentVersion,
            reason: "source_scope_revoked",
          });
        }
      }
      const selection = selectContext({
        messages,
        systemPrompt: this.sdk.systemPrompt ?? "",
        tools: (this.sdk.agent.state.tools ?? []) as any[],
        projectInstructions: this.pinnedContext.instructions,
        resumedFrom: this.pinnedContext.resumedFrom,
        memories,
        preExcludedMemories,
        budget: this.budgetConfig(),
      });
      if (!selection.ok) {
        this.pendingSelection = null;
        this.selectionBlockReason = selection.failure ?? "上下文预算不足";
        return undefined; // 返回 undefined = 不修改；最终检查会阻断
      }
      this.pendingSelection = selection;
      this.selectionBlockReason = null;
      return { messages: selection.messages };
    } catch (err) {
      this.pendingSelection = null;
      this.selectionBlockReason = `上下文选择失败：${(err as Error).message}`;
      return undefined;
    }
  }

  /**
   * 任务开始时钉版上下文前缀（§3）：
   * - 项目指令：从显式配置的工作区相对路径经受限读取（realpath 后必须仍在
   *   工作区内；缺失/不可读/超大分别说明，不偷偷取祖先目录文件）；内容
   *   捕获为任务产物，版本 = 内容哈希 + 产物 id，任务内固定；
   * - 继续来源：人工继续已中断任务时，原任务要求作为必留参考注入，
   *   不能只发一句"继续"就丢失原要求（§4）。
   */
  private loadPinnedContext(task: Task): {
    instructions: { text: string; version: string; problems: string[] } | null;
    resumedFrom: { taskId: string; input: string } | null;
  } {
    let resumedFrom: { taskId: string; input: string } | null = null;
    try {
      if (task.resumesTaskId) {
        const old = this.deps.store.getTask(task.resumesTaskId);
        if (old) resumedFrom = { taskId: old.id, input: old.input };
      }
      return { instructions: this.loadProjectInstructions(task), resumedFrom };
    } catch (err) {
      // 钉版读取失败不阻断任务：以明确说明注入，不静默省略
      return {
        instructions: { text: "", version: "", problems: [`项目指令/继续来源读取失败：${(err as Error).message}`] },
        resumedFrom,
      };
    }
  }

  private loadProjectInstructions(task: Task): { text: string; version: string; problems: string[] } | null {
    const project = this.deps.store.getProject(this.session.projectId);
    const files = project?.instructionFiles ?? [];
    if (files.length === 0) return null;
    const MAX_INSTRUCTION_BYTES = 256 * 1024;
    const problems: string[] = [];
    const parts: string[] = [];
    for (const file of files) {
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
        problems.push(`项目指令文件 ${file}：须为工作区相对路径且不含 ..（已跳过）`);
        continue;
      }
      let real: string;
      try {
        real = fs.realpathSync(path.resolve(this.session.cwdReal, file));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        problems.push(`项目指令文件 ${file}：${code === "ENOENT" ? "缺失" : `不可读（${(err as Error).message}）`}`);
        continue;
      }
      if (!grantCoversPath(this.session.cwdReal, real)) {
        problems.push(`项目指令文件 ${file}：越出工作区（符号链接逃逸），已拒绝`);
        continue;
      }
      try {
        const stat = fs.statSync(real);
        if (stat.size > MAX_INSTRUCTION_BYTES) {
          problems.push(`项目指令文件 ${file}：超大（${stat.size} 字节 > ${MAX_INSTRUCTION_BYTES}），未注入`);
          continue;
        }
        parts.push(`--- ${file} ---\n${fs.readFileSync(real, "utf8")}`);
      } catch (err) {
        problems.push(`项目指令文件 ${file}：不可读（${(err as Error).message}）`);
      }
    }
    const text = parts.join("\n\n");
    let version = `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
    try {
      // 任务实际使用的指令内容须可追溯到捕获产物，而非日后可能变化的工作区路径
      const artifact = this.deps.artifacts.begin({ taskId: task.id, sessionId: task.sessionId, name: "project-instructions" });
      this.deps.artifacts.append(artifact.id, Buffer.from(text, "utf8"));
      this.deps.artifacts.complete(artifact.id);
      version += `;artifact:${artifact.id}`;
    } catch (err) {
      // 捕获失败 = 无法追溯：不注入正文，只留明确说明
      problems.push(`项目指令捕获产物失败（未注入正文）：${(err as Error).message}`);
      return { text: "", version, problems };
    }
    return { text, version, problems };
  }

  /**
   * 包装公开的 sdk.agent.streamFunction：委托原发送函数前做最终核对
   * （选择记录落盘、阻断原因、配对与预算）。扩展异常被 pi 吞掉，只有这里
   * 能可靠阻止发送；不重写模型循环，保留取消信号与事件语义。
   */
  private wrapStreamFunction(sdk: AgentSession): void {
    const agent = sdk.agent as any;
    if (this.originalStreamFn) return; // 已包装
    this.originalStreamFn = agent.streamFunction;
    const original = this.originalStreamFn;
    agent.streamFunction = async (model: any, context: any, options: any) => {
      const task = this.currentTask;
      if (task) {
        try {
          const config = this.budgetConfig();
          options = { ...options, maxTokens: config.maxTokens };
          // 部分适配器会在显式 maxTokens 上追加思考预算；同时限定模型总响应上限。
          model = { ...model, maxTokens: config.maxTokens };
          this.finalCheckBeforeSend(task, model, context, options);
          this.capturePromptSnapshot(task, model, context, options);
        } catch (err) {
          if (err instanceof ContextSendBlocked) this.lastBlockedReason = err.message;
          throw err;
        }
      }
      const stream = await original.call(agent, model, context, options);
      this.noteUsageAfterSend(stream);
      return stream;
    };
  }

  /** 最终检查：失败即抛（宿主原因已保存；Driver 据此中断任务）。 */
  private finalCheckBeforeSend(task: Task, model: any, context: any, options: any): void {
    const expected = task.modelSelection;
    if (!expected || model?.provider !== expected.provider || model?.id !== expected.modelId ||
        this.sdk?.thinkingLevel !== expected.thinkingLevel || (options?.reasoning ?? "off") !== expected.thinkingLevel) {
      throw new ContextSendBlocked("model_selection_mismatch:实际模型或思考强度与任务记录不一致");
    }
    if (this.selectionBlockReason) {
      const reason = this.selectionBlockReason;
      throw new ContextSendBlocked(`context_budget_exceeded:${reason}`);
    }
    const selection = this.pendingSelection;
    if (!selection || !selection.ok) {
      // context 钩子未运行（异常被吞）或策略未产生结果：拒绝发送，不退回全量
      throw new ContextSendBlocked("context_selection_missing:上下文选择未产生有效结果（扩展异常或策略失败），拒绝发送");
    }
    // 配对完整性：视图内每个 toolResult 必须有对应 toolCall，反之亦然。
    // 选择器已剔除的缺配对消息（崩溃恢复残留的孤儿 toolCall/toolResult）
    // 豁免——它们不在视图中，但 convertToLlm 可能保留引用（如 details）。
    const exemptIds = new Set((selection.droppedUnpaired ?? []).map((d) => d.toolCallId));
    const pairingError = checkToolPairing(context?.messages ?? [], exemptIds);
    if (pairingError) {
      throw new ContextSendBlocked(`context_pairing_invalid:${pairingError}`);
    }
    // 预算复核：对实际发送的消息重新估算（含系统提示与工具定义）
    const config = this.budgetConfig();
    let total = selection.estimates.systemPrompt + selection.estimates.toolSchemas;
    for (const message of context?.messages ?? []) {
      total += estimateMessageTokens(message, config.calibration);
    }
    if (total > selection.budget) {
      throw new ContextSendBlocked(
        `context_budget_exceeded:最终检查估算 ${total} 超过输入预算 ${selection.budget}（选择时估算 ${selection.estimatedTotal}）`,
      );
    }
    // 选择记录先于请求落盘；落盘失败即拒绝发送
    const recordId = randomId("sel");
    this.pendingRecordId = recordId;
    this.deps.store.withTx(() => {
      this.deps.store.insertSelectionRecord({
        id: recordId,
        taskId: task.id,
        sessionId: task.sessionId,
        callIndex: this.deps.store.countSelectionRecords(task.id) + 1,
        strategy: SELECTOR_STRATEGY,
        configVersion: budgetConfigVersion(config),
        model: `${model?.provider ?? "?"}/${model?.id ?? "?"}`,
        totalMessages: selection.includedIndices.length + selection.excluded.length,
        includedIndices: selection.includedIndices,
        excluded: [
          ...selection.excluded,
          ...(selection.droppedUnpaired ?? []).map((d) => ({
            index: d.index,
            reason: `unpaired_tool_call:${d.toolCallId}`,
          })),
        ],
        includedMemories: selection.includedMemories,
        excludedMemories: selection.excludedMemories,
        instructionVersion: selection.instructionVersion,
        cappedToolResults: selection.cappedToolResults,
        estimates: selection.estimates,
        budget: selection.budget,
        estimatedTotal: selection.estimatedTotal,
        promptArtifactId: null,
        windowSnapshot: {
          contextWindow: config.contextWindow,
          maxTokens: config.maxTokens,
          thinkingBudget: config.thinkingBudget,
          toolResultReserve: config.toolResultReserve,
          safetyMargin: config.safetyMargin,
        },
        createdAt: new Date().toISOString(),
      });
    });
  }

  private pendingRecordId: string | null = null;
  /** 最终检查抛出的阻断原因（发送侧记录，任务结束路径据此识别）。 */
  private lastBlockedReason: string | null = null;

  /**
   * 发送前输入快照（issue 13）：把交给 SDK 提供方发送函数的
   * systemPrompt/messages/tools 原样序列化为受保护产物，并与刚落盘的
   * 选择记录同事务关联。快照在委托发送函数之前捕获；发送失败/中断时
   * 快照保留，usage 留空表示发送结果未回填。捕获失败即拒绝发送——
   * 不能在没有可追溯输入的情况下发出请求。
   */
  private capturePromptSnapshot(task: Task, model: any, context: any, options: any): void {
    const recordId = this.pendingRecordId;
    if (!recordId) return;
    const snapshot = {
      v: 1,
      capturedAt: new Date().toISOString(),
      capturePoint: "sdk.agent.streamFunction 委托提供方发送函数之前（systemPrompt/messages/tools 为模型上下文范围；不等同于适配器转换后的 HTTP 请求体）",
      recordId,
      taskId: task.id,
      sessionId: task.sessionId,
      callIndex: this.deps.store.countSelectionRecords(task.id),
      model: { provider: model?.provider ?? "?", id: model?.id ?? "?" },
      thinkingLevel: this.sdk?.thinkingLevel ?? task.modelSelection?.thinkingLevel ?? null,
      reasoning: options?.reasoning ?? "off",
      maxTokens: options?.maxTokens ?? null,
      systemPrompt: typeof context?.systemPrompt === "string" ? context.systemPrompt : "",
      messages: Array.isArray(context?.messages) ? context.messages : [],
      tools: Array.isArray(context?.tools) ? context.tools : [],
    };
    try {
      const artifact = this.deps.artifacts.begin({ taskId: task.id, sessionId: task.sessionId, name: `prompt-snapshot:${recordId}` });
      this.deps.artifacts.append(artifact.id, Buffer.from(JSON.stringify(snapshot), "utf8"));
      this.deps.artifacts.complete(artifact.id);
      this.deps.store.setSelectionRecordPromptArtifact(recordId, artifact.id);
    } catch (err) {
      // 快照捕获失败不阻断发送：记录保留，详情如实显示"快照缺失"；
      // 失败原因写 stderr（后台诊断输出，不含正文内容）
      process.stderr.write(`[ruukoto] prompt 快照捕获失败（记录 ${recordId}）：${(err as Error).message}\n`);
    }
  }

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
      for (const prefix of ["context_budget_exceeded", "context_selection_missing", "context_pairing_invalid"]) {
        if (message.includes(prefix)) {
          const idx = message.indexOf(prefix);
          return message.slice(idx).split("\n", 1)[0] ?? prefix;
        }
      }
    }
    return null;
  }

  /** 发送后补记实际 usage（流结束时从最终消息读取；失败时留空）。 */
  private noteUsageAfterSend(stream: any): void {
    const recordId = this.pendingRecordId;
    this.pendingRecordId = null;
    if (!recordId || !stream?.result) return;
    void Promise.resolve(stream.result())
      .then((message: any) => {
        const usage = message?.usage;
        if (!usage) return;
        const input = Number(usage.input ?? usage.inputTokens ?? 0);
        const output = Number(usage.output ?? usage.outputTokens ?? 0);
        if (input > 0 || output > 0) {
          this.deps.store.withTx(() => this.deps.store.setSelectionRecordUsage(recordId, { input, output }));
        }
      })
      .catch(() => {});
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
    this.registry.clear();
    this.hostToolCtx = null;
    this.hostToolCalls = new Map();
    this.pendingSelection = null;
    this.selectionBlockReason = null;
    this.lastBlockedReason = null;
    this.pendingRecordId = null;
    this.pinnedContext = this.loadPinnedContext(task);
    this.runPromise = this.runInner(task);
    try {
      await this.runPromise;
    } finally {
      this.runPromise = null;
      this.currentTask = null;
    }
  }

  private async runInner(task: Task): Promise<void> {
    let sdk: AgentSession;
    try {
      if (!task.modelSelection) throw new Error("model_selection_missing:任务未记录模型配置");
      const model = await this.deps.modelCatalog.resolve(task.modelSelection);
      sdk = await this.ensureSdk(model, task.modelSelection.thinkingLevel);
      if (sdk.model?.provider !== model.provider || sdk.model?.id !== model.id) await sdk.setModel(model);
      sdk.setThinkingLevel(task.modelSelection.thinkingLevel);
      if (sdk.model?.provider !== model.provider || sdk.model?.id !== model.id || sdk.thinkingLevel !== task.modelSelection.thinkingLevel) {
        throw new Error("model_selection_mismatch:SDK 未应用任务模型配置");
      }
    } catch (err) {
      this.finalize(task, "failed", { errorMessage: `SDK 会话创建失败：${(err as Error).message}` });
      return;
    }

    // 任务开始固定工具清单（issue 20）：项目禁用 Web Search 时本任务不注册
    // web_search（模型不可见、系统提示同步重建）；任务内不随配置变化，新配置
    // 从下一任务生效。任务内的禁用由工具按调用新鲜检查立即阻止。
    const webSearchEnabled = this.deps.store.getProject(this.session.projectId)?.webSearch !== "disabled";
    sdk.setActiveToolsByName(
      webSearchEnabled
        ? this.allToolNames
        : this.allToolNames.filter((n) => !(WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(n)),
    );

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

    this.appendMarker(TASK_START_MARKER, { taskId: task.id, requestId: task.requestId });
    try {
      await sdk.prompt(task.input);
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

    // 1. 提交停止意图（独立事务持久化）
    this.deps.store.withTx(() => {
      this.deps.store.setCancelRequested(task.id, opts.cancelIntent);
    });

    // 在中止与回收之前快照"结果未知"的操作：审批未消费 = 已知未执行（排除），
    // 已经开始执行的命令是否已产生外部效果不确定，必须沿用 effect_unknown
    const confirmations = this.deps.store.listConfirmationsByTask(task.id);
    const uncertainAtStop = this.deps.store
      .listUnresolvedToolOps(task.id)
      .filter((op) => isToolOpExecutionUncertain(op, confirmations))
      .map((op) => op.id);

    // 2. 解除确认等待（门以 block 结束，不执行该操作）；进行中的自动审查一并中止
    for (const resolve of this.confirmationWaiters.values()) resolve("canceled");
    this.confirmationWaiters.clear();
    for (const aborter of this.reviewAborters.values()) aborter.abort();
    this.reviewAborters.clear();

    // 3. 中止模型调用与确认等待；受管工具进程组的终止与 abort 并行进行：
    //    abort() 会等待在执行的工具返回，若工具在等待子进程退出，必须同时
    //    回收进程组（TERM → 超时 KILL）才能解除等待，否则互相死锁。
    const abortPromise = this.sdk?.isStreaming ? this.sdk.abort().catch(() => {}) : null;
    const reaped = await this.killManagedProcesses();
    if (abortPromise) await abortPromise;

    // 4. 终态与占用释放（仅当尚未被自然完成抢先）
    this.finalize(task, opts.terminal, {
      interruptReason: opts.reason,
      effectUnknownOpIds: uncertainAtStop,
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

    // 资料与记忆宿主工具（issue 05）、GitHub 宿主工具（issue 06）与
    // Web Search 宿主工具（issue 20）：身份由宿主注入，不经路由器/工作进程
    if (
      (HOST_DATA_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (GITHUB_TOOL_NAMES as readonly string[]).includes(event.toolName) ||
      (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(event.toolName)
    ) {
      this.hostToolCalls.set(event.toolCallId, {
        taskId: task.id,
        sessionId: task.sessionId,
        projectId: this.session.projectId,
        hostOpId,
      });
      return undefined;
    }

    // mock 测试路径：confirmTools 门（仅模拟测试使用，不决定生产权限）
    if (!this.session.confirmTools.includes(event.toolName)) {
      return undefined;
    }

    // 需要确认：登记请求、任务转入等待确认、阻塞到应答
    const confirmation = store.withTx(() => {
      const scope: ApprovalScope = { kind: "tool", workspaceOnly: true };
      const c = store.createConfirmation({
        taskId: task.id,
        sessionId: task.sessionId,
        toolOpId: hostOpId,
        toolName: event.toolName,
        params,
        scope,
        permissionVersion: task.permissionVersion,
      });
      store.transitionTask(task.id, ["running"], "awaiting_confirmation", {});
      return c;
    });

    this.pendingConfirmationCount++;
    try {
      const decision = await new Promise<ConfirmationDecision>((resolve) => {
        this.confirmationWaiters.set(confirmation.id, resolve);
      });
      if (decision === "approved") return undefined;
      // 拒绝/取消/失效：工具未执行，结果是已知的（不产生 effect_unknown）
      store.withTx(() => {
        const summary =
          decision === "rejected"
            ? `拥有者拒绝执行 ${event.toolName}`
            : decision === "superseded"
              ? `模式已切换，${event.toolName} 审批失效（未执行）`
              : `任务停止，确认等待解除（${event.toolName} 未执行）`;
        const recorded = store.recordToolResult(hostOpId, summary, true);
        if (recorded) {
          store.appendEvent(
            { type: "task.tool_result", taskId: task.id, toolOpId: hostOpId, summary, isError: true, artifactIds: [] },
            { taskId: task.id, sessionId: task.sessionId },
          );
        }
      });
      if (decision === "rejected") {
        return { block: true, reason: `拥有者拒绝执行 ${event.toolName}` };
      }
      return { block: true, reason: "任务已停止，确认等待解除" };
    } finally {
      this.pendingConfirmationCount--;
      if (this.pendingConfirmationCount === 0) {
        store.withTx(() => {
          store.transitionTask(task.id, ["awaiting_confirmation"], "running", {});
        });
      }
    }
  }

  /** 结构化审批操作的路由器桥：登记请求并等待决定（auto-review 任务先经自动审查）。 */
  private async awaitApproval(input: {
    task: Task;
    hostOpId: string;
    toolName: string;
    params: Record<string, unknown>;
    scope: ApprovalScope;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome> {
    const store = this.deps.store;
    // 自动审查只覆盖 auto-review 任务且需要任务固定的模型配置；缺任一条件退化为纯人工
    const reviewSelection =
      input.task.accessMode === "auto-review" && this.deps.reviewer ? input.task.modelSelection : null;
    const confirmation = store.withTx(() => {
      const c = store.createConfirmation({
        taskId: input.task.id,
        sessionId: input.task.sessionId,
        toolOpId: input.hostOpId,
        toolName: input.toolName,
        params: input.params,
        scope: input.scope,
        permissionVersion: input.task.permissionVersion,
        review: reviewSelection
          ? { model: `${reviewSelection.provider}/${reviewSelection.modelId}`, policyVersion: REVIEW_POLICY_VERSION }
          : undefined,
      });
      store.transitionTask(input.task.id, ["running"], "awaiting_confirmation", {});
      return c;
    });

    if (input.signal?.aborted) {
      store.withTx(() => {
        store.stalePendingConfirmations(input.task.id);
        store.transitionTask(input.task.id, ["awaiting_confirmation"], "running", {});
      });
      return { decision: "superseded", source: null, reviewReason: null };
    }

    this.pendingConfirmationCount++;
    try {
      const decisionPromise = new Promise<ConfirmationDecision>((resolve) => {
        this.confirmationWaiters.set(confirmation.id, resolve);
        if (input.signal) {
          const onAbort = () => resolve("superseded");
          input.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      // 等待者注册后再启动自动审查，避免审查同步完成时结果无处投递
      if (reviewSelection) {
        void this.runAutoReview(confirmation, input.task, input).catch(() => {
          // 审查失败不得打断审批等待；可落盘的失败已在 runAutoReview 内转人工
        });
      }
      const decision = await decisionPromise;
      // 自动拒绝不能显示成"拥有者拒绝"：重读落库的来源与理由（与决定同事务写入）
      const resolved = store.getConfirmation(confirmation.id);
      const source = resolved?.decisionSource ?? null;
      const reviewReason = resolved?.reviewReason ?? null;
      if (decision === "approved") return { decision, source, reviewReason };
      // 未批准 = 已知未执行（拒绝/取消/失效都不产生外部效果）
      const rejectedSummary =
        source === "auto_review"
          ? `自动审查拒绝执行 ${input.toolName}：${reviewReason ?? "未给出理由"}`
          : `拥有者拒绝执行 ${input.toolName}`;
      store.withTx(() => {
        const summary =
          decision === "rejected"
            ? rejectedSummary
            : decision === "superseded"
              ? `审批已失效（模式切换或任务停止），${input.toolName} 未执行`
              : `任务停止，确认等待解除（${input.toolName} 未执行）`;
        const recorded = store.recordToolResult(input.hostOpId, summary, true);
        if (recorded) {
          store.appendEvent(
            { type: "task.tool_result", taskId: input.task.id, toolOpId: input.hostOpId, summary, isError: true, artifactIds: [] },
            { taskId: input.task.id, sessionId: input.task.sessionId },
          );
        }
      });
      return decision === "rejected"
        ? { decision: "rejected", source, reviewReason }
        : { decision: "superseded", source, reviewReason };
    } finally {
      // 等待结束（含人工抢先/取消/模式切换）：中止仍在进行的审查，迟到结果忽略
      const aborter = this.reviewAborters.get(confirmation.id);
      if (aborter) {
        aborter.abort();
        this.reviewAborters.delete(confirmation.id);
      }
      this.pendingConfirmationCount--;
      if (this.pendingConfirmationCount === 0) {
        store.withTx(() => {
          store.transitionTask(input.task.id, ["awaiting_confirmation"], "running", {});
        });
      }
    }
  }

  /**
   * 单次自动审查（issue 15）：确定性策略先行，可审查的交给无工具模型调用。
   * 决定、理由、来源与事件在同一事务落盘；与人工决定/取消/模式切换竞争时
   * 只有一方条件更新成功，失败方把审查标记为 superseded 并忽略结果。
   */
  private async runAutoReview(
    confirmation: ConfirmationRequest,
    task: Task,
    input: { toolName: string; params: Record<string, unknown>; scope: ApprovalScope },
  ): Promise<void> {
    const store = this.deps.store;
    const reviewer = this.deps.reviewer;
    const selection = task.modelSelection;
    if (!reviewer || !selection) return;

    // 确定性策略：不可审查的范围直接转人工，不发起模型调用
    if (classifyForReview(input.scope) === "ask_owner") {
      this.markReviewAskedOwner(task, confirmation.id, "该操作不属于自动批准范围，转拥有者确认");
      return;
    }

    const aborter = new AbortController();
    this.reviewAborters.set(confirmation.id, aborter);
    try {
      const outcome = await reviewer.review({
        selection,
        taskInput: task.input,
        toolName: input.toolName,
        params: input.params,
        scope: input.scope,
        signal: aborter.signal,
      });
      if (outcome.decision === "ask_owner") {
        // 上下文不足/模型失败/超时/输出非法：转人工并说明原因，等待者不动
        this.markReviewAskedOwner(task, confirmation.id, outcome.reason);
        return;
      }
      // approve/reject：条件更新要求仍 pending、权限版本匹配、任务仍活动
      const decision = outcome.decision === "approve" ? "approved" : "rejected";
      const applied = store.withTx(() =>
        store.respondConfirmation(confirmation.id, decision, {
          source: "auto_review",
          expectedPermissionVersion: confirmation.permissionVersion,
          reviewDecision: outcome.decision,
          reviewReason: outcome.reason,
        }),
      );
      if (!applied) {
        // 人工抢先/已失效：迟到结果不得落盘
        store.withTx(() => store.markConfirmationReviewSuperseded(confirmation.id));
        return;
      }
      store.withTx(() =>
        store.appendEvent(
          { type: "task.confirmation_resolved", taskId: task.id, confirmationId: confirmation.id, decision, source: "auto_review", reason: outcome.reason },
          { taskId: task.id, sessionId: task.sessionId },
        ),
      );
      this.confirmationWaiters.get(confirmation.id)?.(decision);
    } catch (err) {
      if (err instanceof ReviewAbortedError) {
        // 人工接管/停止：仅标记审查被取代，不动审批状态
        store.withTx(() => store.markConfirmationReviewSuperseded(confirmation.id));
        return;
      }
      // reviewer 约定只抛中止；防御性兜底：任何意外异常一律转人工
      this.markReviewAskedOwner(task, confirmation.id, `审查异常：${(err as Error).message}`);
    } finally {
      this.reviewAborters.delete(confirmation.id);
    }
  }

  /** 转人工（条件更新仍 pending；人工已抢先时不覆盖其决定、不发事件）。 */
  private markReviewAskedOwner(task: Task, confirmationId: string, reason: string): void {
    const store = this.deps.store;
    const marked = store.withTx(() => store.markConfirmationAskedOwner(confirmationId, reason));
    if (marked) {
      store.withTx(() =>
        store.appendEvent(
          { type: "task.confirmation_reviewed", taskId: task.id, confirmationId, decision: "ask_owner", reason },
          { taskId: task.id, sessionId: task.sessionId },
        ),
      );
    }
  }

  /** 模式切换应用前解除全部等待：审批失效，后续执行重新判定。 */
  private supersedeAllWaiters(): void {
    for (const resolve of this.confirmationWaiters.values()) resolve("superseded");
    this.confirmationWaiters.clear();
  }

  /** 运行时入口：等待中的审批因模式切换立即失效（Runtime 调用）。 */
  supersedeWaiters(): void {
    this.supersedeAllWaiters();
  }

  /** 当前任务运行的完成信号（无任务运行时 resolve）。用于审批桥外的等待方
   * 在任务自然结束时回落（避免控制面请求永久悬挂）。 */
  taskCompletion(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  /** 控制面应答确认：条件更新 pending → approved/rejected；失效应答返回 false。 */
  resolveConfirmation(confirmationId: string, decision: "approved" | "rejected"): boolean {
    const waiter = this.confirmationWaiters.get(confirmationId);
    if (!waiter) return false;
    const store = this.deps.store;
    // 人工决定：记录来源；进行中的自动审查同事务标记 superseded
    const applied = store.withTx(() => store.respondConfirmation(confirmationId, decision, { source: "owner" }));
    if (!applied) return false;
    store.withTx(() => {
      const task = this.currentTask;
      if (task) {
        store.appendEvent(
          { type: "task.confirmation_resolved", taskId: task.id, confirmationId, decision, source: "owner" },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
    });
    waiter(decision);
    return true;
  }

  // ---------- 会话事件观察 ----------

  /** 任务当前的输出预览（全量在内存；供重连重建，事件只发有界尾部）。 */
  currentOutputPreview(taskId: string): { messageId: string; text: string } | null {
    if (this.currentTask?.id !== taskId || !this.currentPreview) return null;
    return this.currentPreview;
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    const task = this.currentTask;
    if (!task) return;

    switch (event.type) {
      case "message_start": {
        // 新 assistant 消息开始：按序分配消息标识（片段与最终条目的关联键）
        const message = (event as any).message;
        if (message?.role === "assistant") {
          const id = randomId("msg");
          this.pendingEntryMsgIds.push(id);
          this.currentMsgId = id;
        }
        return;
      }
      case "message_update": {
        const message = (event as any).message;
        if (message?.role !== "assistant") return;
        if (!this.currentMsgId) {
          // 防御：未观察到 message_start（如直接 done 路径）
          this.currentMsgId = randomId("msg");
          this.pendingEntryMsgIds.push(this.currentMsgId);
        }
        const messageId = this.currentMsgId;
        const text = extractText(message?.content);
        if (text.length === 0) return;
        // 内存中的预览每次都更新（重连重建取最新）；事件发送保持节流
        this.currentPreview = { messageId, text };
        const now = Date.now();
        if (now - this.lastFragmentAt < FRAGMENT_INTERVAL_MS) return;
        this.lastFragmentAt = now;
        // 有界预览：只保留尾部；完整文本落盘后由历史条目提供
        const capped = tailTextByBytes(text, FRAGMENT_TEXT_CAP);
        this.deps.store.withTx(() => {
          this.deps.store.appendEvent(
            {
              type: "task.output_fragment",
              taskId: task.id,
              sessionId: task.sessionId,
              messageId,
              text: capped.text,
              totalBytes: capped.totalBytes,
              truncated: capped.truncated,
              partial: true,
            },
            { taskId: task.id, sessionId: task.sessionId },
          );
        });
        return;
      }
      case "tool_execution_end": {
        const summary = summarizeToolResult(event.result);
        // SDK 调用 id → 宿主操作 id（不同任务复用调用 id 时不串用记录）
        const hostOpId = this.callMap.get(event.toolCallId) ?? event.toolCallId;
        const artifactIds = this.deps.store.getToolOp(hostOpId) ? this.router.artifactIdsFor(hostOpId) : [];
        this.deps.store.withTx(() => {
          const recorded = this.deps.store.recordToolResult(hostOpId, summary, event.isError);
          if (recorded) {
            this.deps.store.appendEvent(
              { type: "task.tool_result", taskId: task.id, toolOpId: hostOpId, summary, isError: event.isError, artifactIds },
              { taskId: task.id, sessionId: task.sessionId },
            );
          }
        });
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
