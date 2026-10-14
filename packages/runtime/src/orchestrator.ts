/**
 * 后台编排器（issue 01 日常助手）：main 角色的引导、持久入站事件的登记与
 * 派发、子任务结果回传与有界唤醒、子任务超时取消、重启恢复。固定角色已退役：
 * chat（agent-direction issue 20）与 coding（issue 23）不再引导、不接受新任务，
 * 旧安装的角色行保留为归档标识；已登记的群入站事件由入站门卫弃，退役前在途
 * 的旧 coding 子任务经启动收尾与巡检补记一次结果后唤醒 main，不重放。
 *
 * 窄入口：只经 OrchestratorBridge 调用 Runtime 的少量方法；不持有拥有者
 * token，不能审批、改权限、开完全访问或读取其他项目资料。委派经通用
 * SubAgent 管理器（宿主固定评审由本组件直接登记），控制面 ops 不接受编排字段。
 *
 * 角色配置（项目/会话/工作目录/模型/工具白名单）只由本组件在引导时写入
 * agent_roles 表；输入正文、项目指令与模型结果不能修改。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import { QQ_GROUP_SOURCE, type QqStore } from "@ruukoto/channels/qq/store.ts";
import {
  isTerminalTaskStatus,
  type AccessMode,
  type AgentRole,
  type AgentRoleId,
  type InboundEvent,
  type GrantedPath,
  type ModelSelection,
  type NotifyTarget,
  type PersistentEvent,
  type Task,
} from "@ruukoto/core/types.ts";
import { sessionToolCategories } from "@ruukoto/agent/tool-availability.ts";
import { QQ_PRIVATE_SOURCE, TELEGRAM_SOURCE } from "@ruukoto/core/notify-target.ts";
import { canonicalParamsDigest } from "@ruukoto/agent/mcp/tools.ts";
import type { SubAgentDelegateInput, SubAgentDelegation, SubAgentManager } from "@ruukoto/runtime/subagents.ts";
import type { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { getWorkflowDeliveryRun } from "@ruukoto/core/workflow.ts";

/** 编排器需要的 Runtime 窄接口（宿主注入；除此之外的能力编排器不可见）。 */
export interface OrchestratorBridge {
  submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode?: AccessMode;
    grantedPaths?: GrantedPath[];
    modelSelection: ModelSelection;
    agentId?: AgentRoleId | null;
    parentTaskId?: string | null;
    sourcePermissionVersion?: number | null;
    sourceEventId?: string | null;
    deadline?: string | null;
    workflowRunId?: string;
    reportKey?: string;
  }): Promise<Task>;
  cancelTask(taskId: string, reason?: string): Promise<Task>;
  findProjectByName(name: string): { id: string } | null;
  createProject(name: string): { id: string };
  createSession(input: { projectId: string; cwd: string }): Promise<{ id: string }>;
  /** 指定任务的最终 assistant 文本（按任务关联的历史条目，不取会话最新一条）。 */
  readTaskReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  resumeQueue(sessionId: string): Promise<unknown>;
  kickSession(sessionId: string): void;
  defaultModelSelection(): ModelSelection;
}

export interface OrchestratorDeps {
  store: Store;
  qqStore: QqStore;
  /** 后台数据目录（角色工作目录在其兄弟目录 agent-work/ 下，避开保护根）。 */
  dataDir: string;
  bridge: OrchestratorBridge;
  /** 在独立上下文创建并绑定通用调度运行；会话、任务与来源同事务登记。 */
  dispatchScheduled?(event: InboundEvent, selection: ModelSelection): Promise<Task>;
  /** 超时巡检间隔（默认 1s；测试可压短）。 */
  deadlineCheckMs?: number;
  /**
   * 入站事件关联任务的结果事务内回调（issue 04 owner 回复）：与结果/事件终态
   * 同事务提交，重启巡检补记结果时一并补登，不会重复。
   */
  onInboundTerminal?(event: InboundEvent, task: Task, outcome: ChildOutcome): void;
  /**
   * 父级送达（架构工单 09）：子任务结果登记后建结果唤醒、结果唤醒终态的最终汇报
   * （结果事务内）与启动补建。
   */
  parentDelivery: Pick<ParentDelivery, "resultRecorded" | "wakeTerminal" | "sweep"> & Partial<Pick<ParentDelivery, "needsResult" | "reserveResult">>;
  /** 入站派发前复核宿主配置与在线状态；等待保留原事件，失效则作废。 */
  inboundGate?(event: InboundEvent): "run" | "wait" | { drop: string };
  /** 宿主为已验证的入站事件安排固定 main 父任务与评审请求文本；模型不参与派发。 */
  reviewRequest?(event: InboundEvent): string | null;
  /**
   * 宿主固定评审（agent-direction issue 19）：PR 评审经通用 SubAgent 执行，
   * 编排器直接调用 delegate（hostReview 入参，不经模型工具）。缺省（如未接线）
   * 时事件保持 registered，下次派发重试。
   * flushPending（agent-direction issue 13）：SubAgent 执行任务终态与启动恢复
   * 时冲刷待投递的工作内消息（可投递则投递，资格已失记明确未投递结果）。
   */
  subagents?: {
    delegate(input: SubAgentDelegateInput): Promise<SubAgentDelegation>;
    resultRecorded: SubAgentManager["resultRecorded"];
    start: SubAgentManager["start"];
    flushPending: SubAgentManager["flushPendingMessages"];
  };
  /** 结果落库前保存交付产物与来源元数据；重启补记走同一路径。 */
  resultData?(task: Task, outcome: ChildOutcome): Record<string, unknown>;
  /** 图片在普通入站之前恢复；派发前核对视觉模型，入队事务内提升任务产物。 */
  recoverMedia?(): Promise<void>;
  prepareMedia?(event: InboundEvent, selection: ModelSelection): Promise<boolean>;
  promoteMedia?(event: InboundEvent, task: Task): void;
  cleanupMedia?(): void;
}

/** 角色静态定义（工具类别见 tool-availability 的会话类别清单）。
 *  chat（issue 20）与 coding（agent-direction issue 23）已退役：不再引导；旧
 *  agent_roles 行保留为归档标识，旧任务与历史经它们查阅。 */
const ROLE_DEFINITIONS: Array<{ id: "main"; projectName: string }> = [{ id: "main", projectName: "agent-main" }];

/** 委派/事件输入正文上限（登记时截断，超出部分不入库）。 */
const INPUT_TEXT_CAP = 8192;
/** 子任务结果摘要上限（写入任务记录与唤醒输入）。 */
const RESULT_SUMMARY_CAP = 1000;
/** 超时取消的持久化原因（canceled 事件与启动巡检据此判定 timeout，重启后不丢）。 */
const DEADLINE_REASON = "deadline_exceeded";

/** 宿主固定评审与其结果唤醒的截止时限。 */
export const REVIEW_DEADLINE_MS = 60 * 60_000;
export const MEDIA_CLEANUP_INTERVAL_MS = 60 * 60_000;

/** 子任务终态口径（completed/failed/timeout/unknown），事件、摘要与唤醒共用。 */
export type ChildOutcome = "completed" | "failed" | "timeout" | "unknown";

export const OUTCOME_TEXT: Record<ChildOutcome, string> = {
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  unknown: "结果未知",
};

/** 超时取消的判定：取消原因在取消时持久化（errorMessage/interruptReason），重启后仍可核对。 */
function isDeadlineCancel(task: Task): boolean {
  return task.errorMessage === DEADLINE_REASON || task.interruptReason === DEADLINE_REASON;
}

/** 由任务持久状态推导终态口径（启动巡检与补建唤醒共用）。 */
export function childOutcome(task: Task): ChildOutcome {
  if (task.status === "completed") return "completed";
  if (task.status === "interrupted") return "unknown";
  if (task.status === "canceled" && isDeadlineCancel(task)) return "timeout";
  return "failed";
}

function capInput(text: string): string {
  return text.length > INPUT_TEXT_CAP
    ? `${text.slice(0, INPUT_TEXT_CAP)}…（截断，原 ${text.length} 字符）`
    : text;
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private started = false;
  private stopping = false;
  private deadlineTimer: NodeJS.Timeout | null = null;
  /** 事件派发串行化（注册与恢复共用同一入口，避免并发重提）。 */
  private dispatchChain: Promise<void> = Promise.resolve();
  private lastMediaCleanup = 0;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  private get store(): Store {
    return this.deps.store;
  }

  private log(message: string): void {
    // 后台诊断输出（不含消息正文与秘密）
    process.stderr.write(`[ruukoto:orchestrator] ${message}\n`);
  }

  async start(): Promise<void> {
    this.started = true;
    await this.ensureRoles();
    await this.deps.recoverMedia?.();
    // 崩溃窗口恢复①：已登记未建任务的事件按原请求键核实重提（幂等，不换新键）
    await this.recoverInbound();
    // 崩溃窗口恢复②：重启期间到达终态的角色任务补记结果与事件、补唤醒；
    // interrupted 一律按结果未知处理，不自动重放任何外部副作用
    await this.sweepPendingResults();
    // SubAgent 管理器接管消息补投与安全的子会话启动恢复。
    await this.deps.subagents?.start();
    // 角色会话的队列暂停由编排器自动恢复，但仅限
    // backend_restart（排队任务在重启后继续）；occupancy_unverified 等涉及
    // 未核实旧执行的暂停必须保留给拥有者核实（docs/modules/runtime.md 恢复约定——
    // 角色任务有工具执行，不同于无工具的 QQ 会话，不能沿用其无条件恢复前提）。
    for (const role of this.store.listAgentRoles()) {
      await this.resumeRestartPausedQueue(role.sessionId, `角色 ${role.id}`);
    }
    for (const session of this.store.listSessions()) {
      const identity = this.store.getSessionIdentity(session.id);
      if (identity?.kind === "scheduled" && this.store.scheduledRunCanResume(identity.runId)) {
        await this.resumeRestartPausedQueue(session.id, `调度运行 ${identity.runId}`);
      }
      if (identity?.kind === "dev" && this.store.listQueuedTasksFifo(session.id).length > 0 &&
          this.store.listQueuedTasksFifo(session.id).every(task => getWorkflowDeliveryRun(this.store, task.id) || this.deps.parentDelivery.needsResult?.(task))) {
        await this.resumeRestartPausedQueue(session.id, "内部最终汇总");
      }
    }
    const ms = this.deps.deadlineCheckMs ?? 1_000;
    this.deadlineTimer = setInterval(() => void this.checkDeadlines(), ms);
    this.deadlineTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    if (this.deadlineTimer) {
      clearInterval(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    // 等待已有派发链收尾；关闭期间新增派发被拒绝（dispatchRegistered 检查 stopping）
    await this.dispatchChain;
  }

  /**
   * 宿主专用的有界派发入口（issue 03 调度器）：派发已持久化的 registered 事件。
   * 与登记/恢复共用串行链与原请求键，重复调用不重复建任务；提交失败的事件
   * 保持 registered，由调用方按间隔再次调用补派，不依赖重启。
   */
  dispatchRegisteredEvents(): Promise<void> {
    return this.serial(() => this.dispatchRegistered());
  }

  /** 在派发串行链上执行（取消计划与派发在同一边界核对，覆盖提交任务与回填事件之间的竞争）。 */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.dispatchChain.then(fn);
    this.dispatchChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * backend_restart 暂停的会话队列在启动时自动恢复。两层门禁：occupancy_unverified
   * 保持暂停；会话另持有遗留占用时也不自动恢复（resumeQueue 会一并释放占用——
   * 那是拥有者核实后的动作，不能自动发生；恢复事务本已按 occupancy_unverified
   * 拦截，这里再挡住人工暂停叠加遗留占用的形态）。
   */
  private async resumeRestartPausedQueue(sessionId: string, label: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session || session.queueState !== "paused" || session.queuePauseReason !== "backend_restart") return;
    if (this.store.listAllOccupancy().some((o) => o.sessionId === session.id)) return;
    await this.deps.bridge
      .resumeQueue(session.id)
      .catch((err) => this.log(`恢复${label} 队列失败：${(err as Error).message}`));
  }

  // ---------- 角色引导 ----------

  /** 幂等：已有角色行跳过（工具类别以 tool-availability 的清单为准，不读角色记录里的副本）。 */
  private async ensureRoles(): Promise<void> {
    for (const def of ROLE_DEFINITIONS) {
      if (this.store.getAgentRole(def.id)) continue;
      const project = this.deps.bridge.findProjectByName(def.projectName) ?? this.deps.bridge.createProject(def.projectName);
      const workDir = path.join(path.dirname(path.resolve(this.deps.dataDir)), "agent-work", def.id);
      fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
      // 角色会话的创建只能经此引导路径；控制面 create_session 不携带角色身份
      const session = await this.deps.bridge.createSession({ projectId: project.id, cwd: workDir });
      this.store.insertAgentRole({
        id: def.id,
        projectId: project.id,
        sessionId: session.id,
        workDir,
        modelSelection: null,
        tools: sessionToolCategories(def.id),
        createdAt: new Date().toISOString(),
      });
    }
  }

  // ---------- 入站事件 ----------

  /**
   * 登记入站事件（幂等）：重复 (source, externalId) 返回已存在事件且不重复
   * 建任务。登记与派发分离：先持久化，再在串行链上建任务；崩溃窗口由
   * 启动恢复按原请求键重提。
   */
  async registerInboundEvent(input: {
    source: string;
    externalId: string;
    actor?: string | null;
    targetRole: "main";
    body: string;
    artifactRefs?: string[];
    replyTarget?: NotifyTarget | null;
  }): Promise<{ event: InboundEvent; created: boolean }> {
    // 只有 main 接受新入站（coding/chat 已退役，agent-direction issue 20/23）
    if (input.targetRole !== "main") throw new Error(`目标角色无效：${input.targetRole}`);
    if (!input.source.trim() || !input.externalId.trim()) throw new Error("入站事件的 source 与 external_id 不能为空");
    const { event, created } = this.store.withTx(() =>
      this.store.registerInboundEvent({
        source: input.source,
        externalId: input.externalId,
        actor: input.actor ?? null,
        targetRole: input.targetRole,
        body: capInput(input.body),
        artifactRefs: input.artifactRefs,
        replyTarget: input.replyTarget,
      }),
    );
    if (created) this.enqueueDispatch();
    return { event, created };
  }

  /** 已登记未建任务的事件串行重提（启动恢复）。 */
  private async recoverInbound(): Promise<void> {
    const pending = this.store.listInboundByStatus(["registered"]);
    if (pending.length > 0) this.log(`恢复 ${pending.length} 条已登记未建任务的入站事件`);
    for (const event of pending) await this.dispatchEvent(event);
  }

  private enqueueDispatch(): void {
    void this.serial(() => this.dispatchRegistered()).catch(() => {});
  }

  private async dispatchRegistered(): Promise<void> {
    for (const event of this.store.listInboundByStatus(["registered"])) {
      if (this.stopping) return;
      await this.dispatchEvent(event);
    }
  }

  /**
   * 为事件建任务并入队。请求键 evt:<eventId> 幂等：崩溃发生在建任务与
   * 标记之间时，重提命中同一请求键返回既有任务，不重复创建。
   */
  private async dispatchEvent(event: InboundEvent): Promise<void> {
    // 列表读取后可能已被作废（如调度计划取消）：只派发仍为 registered 的事件
    if (this.store.getInboundEvent(event.id)?.status !== "registered") return;
    // 控制类别（IM 审批命令）不派发模型任务：恢复/补派显式排除，崩溃遗留的
    // registered 控制事件明确作废，不作为普通提示或新的批准自动重放
    if (event.eventKind !== "task") {
      this.store.withTx(() => {
        this.store.failRegisteredInbound(event.id);
        this.store.appendEvent({ type: "inbound.skipped", eventId: event.id, source: event.source, reason: "control_event_not_dispatched:控制消息不能派发为模型任务" });
      });
      return;
    }
    const gate = this.deps.inboundGate?.(event) ?? "run";
    // 已登记的群入站事件（issue 20 退役遗留）：入站门恒 drop，走下方作废分支
    const group = event.source === QQ_GROUP_SOURCE ? this.deps.qqStore.getInbox(event.externalId) : null;
    if (gate === "wait") return;
    if (gate !== "run") {
      this.store.withTx(() => {
        this.store.failRegisteredInbound(event.id);
        this.store.appendEvent({ type: "inbound.skipped", eventId: event.id, source: event.source, reason: gate.drop });
        if (group) this.deps.qqStore.setInboxStatus(group.dedupKey, "skipped");
      });
      const role = this.store.getAgentRole(event.targetRole);
      const previous = group?.sessionId ? this.store.findTaskByRequest(group.sessionId, group.requestId)
        : role ? this.store.findTaskByRequest(role.sessionId, `evt:${event.id}`) : null;
      const matching = previous && (group || (previous.sourceEventId === event.id && previous.agentId === role?.id)) ? previous : null;
      if (matching && !isTerminalTaskStatus(matching.status)) await this.deps.bridge.cancelTask(matching.id, gate.drop);
      return;
    }
    const role = this.store.getAgentRole(event.targetRole);
    if (!role) {
      this.log(`事件 ${event.id} 目标角色 ${event.targetRole} 未引导，跳过`);
      return;
    }
    const prior = this.store.findTaskByRequest(role.sessionId, `evt:${event.id}`);
    const selection = prior?.modelSelection ?? role.modelSelection ?? this.deps.bridge.defaultModelSelection();
    const input =
      `[入站事件] 来源：${event.source} 外部 id：${event.externalId} actor：${event.actor ?? "未知"}\n` +
      event.body +
      (event.artifactRefs.length > 0 ? `\n产物引用：${JSON.stringify(event.artifactRefs)}` : "");
    let task: Task;
    try {
      if (this.deps.prepareMedia && !await this.deps.prepareMedia(event, selection)) return;
      const review = this.deps.reviewRequest?.(event);
      if (review !== undefined && review !== null) {
        const main = this.store.getAgentRole("main")!;
        const deadline = new Date(Date.parse(event.receivedAt) + REVIEW_DEADLINE_MS).toISOString();
        const parent = this.store.findTaskByRequest(main.sessionId, `evt:${event.id}:main`) ?? await this.deps.bridge.submit({
          sessionId: main.sessionId, requestId: `evt:${event.id}:main`,
          input: `[编排器] 已接纳 review 事件 ${event.id}。宿主负责创建评审 SubAgent；本回合只确认接收，待结果唤醒后再摘要。`,
          modelSelection: main.modelSelection ?? this.deps.bridge.defaultModelSelection(),
          agentId: "main", sourceEventId: event.id, accessMode: "confirm", deadline,
        });
        // 宿主固定评审：每个修订一项新工作、一个新 SubAgent。幂等键按事件，
        // 参数摘要只含 {kind, eventId}——恢复重提与提示文案变化都命中首次记录；
        // 准备失败（模型门闩、执行入口）抛错后事件保持 registered，下次派发重试
        if (!this.deps.subagents) throw new Error("评审 SubAgent 管理器未接线");
        const delegation = await this.deps.subagents.delegate({
          parentTaskId: parent.id,
          key: `ghreview-${event.id}`,
          request: review,
          paramsDigest: canonicalParamsDigest({ kind: "ghreview", eventId: event.id }),
          hostReview: { sourceEventId: event.id },
        });
        task = delegation.task;
      } else if (event.source === "scheduler") {
        if (!this.deps.dispatchScheduled) throw new Error("通用调度执行未接线");
        task = await this.deps.dispatchScheduled(event, selection);
      } else if (prior) {
        // 已接受任务是授权与模型选择的权威记录；恢复只补关联，不重算提交参数。
        if (prior.sourceEventId !== event.id || prior.agentId !== role.id) {
          throw new RuntimeApiError("request_conflict", "入站请求键已绑定另一任务来源");
        }
        task = prior;
      } else task = await this.deps.bridge.submit({
        sessionId: role.sessionId,
        requestId: `evt:${event.id}`,
        input,
        modelSelection: selection,
        agentId: role.id,
        sourceEventId: event.id,
        // 拥有者私聊已由入站门核实身份；其余外部入口保持固定模式。
        accessMode: event.source === TELEGRAM_SOURCE || event.source === QQ_PRIVATE_SOURCE ? undefined : "confirm",
      });
    } catch (err) {
      this.log(`事件 ${event.id} 建任务失败：${(err as Error).message}`);
      return; // 保持 registered，下次启动恢复重提
    }
    try {
      this.store.withTx(() => {
        this.store.markInboundQueued(event.id, task.id);
        this.deps.promoteMedia?.(event, task);
        // 任务已落库/已结束、事件回填前崩溃的窗口也沿用原任务。
        const recorded = this.store.getTask(task.id)!;
        if (recorded.resultSummary !== null) {
          this.store.setInboundTerminal(event.id, recorded.status === "completed" ? "done" : "failed");
          this.deps.onInboundTerminal?.(this.store.getInboundEvent(event.id)!, recorded, childOutcome(recorded));
        }
      });
    } catch {
      this.log(`事件 ${event.id} 产物归属未完成，等待恢复`);
      return;
    }
    this.deps.bridge.kickSession(task.sessionId);
    if (task.subAgentId) {
      // 评审子任务（issue 19）：管理器只在新建时 kick；恢复重提命中首次登记时
      // 子会话可能仍挂着，或因崩溃留下的排队任务被恢复事务按 backend_restart
      // 暂停——宿主固定评审不经拥有者核实，直接按角色会话同口径恢复（占用
      // 未核实的 occupancy_unverified 暂停不在此解除）。
      const recorded = this.store.getTask(task.id)!;
      if (!isTerminalTaskStatus(recorded.status)) {
        const session = this.store.getSession(task.sessionId);
        if (session?.queueState === "paused" && session.queuePauseReason === "backend_restart") {
          await this.deps.bridge.resumeQueue(task.sessionId).catch((err) => this.log(`恢复评审子会话队列失败：${(err as Error).message}`));
        } else {
          this.deps.bridge.kickSession(task.sessionId);
        }
      }
    }
  }

  // ---------- 结果回传与唤醒 ----------

  /** Runtime 事件监听：角色任务到达终态时记录结果、发子任务事件、唤醒父任务。 */
  onRuntimeEvents(events: PersistentEvent[]): void {
    if (!this.started) return;
    for (const event of events) {
      const body = event.body;
      if (
        body.type !== "task.completed" &&
        body.type !== "task.failed" &&
        body.type !== "task.canceled" &&
        body.type !== "task.interrupted"
      ) {
        continue;
      }
      const task = this.store.getTask(body.taskId);
      if (!task || (!task.agentId && !task.subAgentId && this.store.getSessionIdentity(task.sessionId)?.kind !== "scheduled" &&
          !getWorkflowDeliveryRun(this.store, task.id) && !this.deps.parentDelivery.needsResult?.(task))) continue;
      const outcome: ChildOutcome =
        body.type === "task.completed"
          ? "completed"
          : body.type === "task.interrupted"
            ? "unknown"
            : isDeadlineCancel(task)
              ? "timeout"
              : "failed";
      void this.handleTerminal(task, outcome).catch((err) => this.log(`结果回传失败：${(err as Error).message}`));
    }
  }

  /**
   * 启动巡检：① 重启窗口内到达终态的角色任务补记结果与事件（handleTerminal 内含
   * 建唤醒）；② 父级送达补建缺失的结果唤醒与消息唤醒。
   */
  private async sweepPendingResults(): Promise<void> {
    const pending = new Map(this.store.listRoleTasksPendingResult().map(task => [task.id, task]));
    for (const task of this.store.listTasksByStatus(["completed", "failed", "canceled", "interrupted"])) {
      if (task.resultSummary === null && this.deps.parentDelivery.needsResult?.(task)) pending.set(task.id, task);
    }
    for (const task of pending.values()) {
      await this.handleTerminal(task, childOutcome(task));
    }
    await this.deps.parentDelivery.sweep();
  }

  /**
   * 入站事件终态回写（角色路径与 SubAgent 路径共用，均在结果事务内调用）：
   * 只有事件钉定的任务正是本任务时才写事件终态；通知/回执由 onInboundTerminal
   * 的宿主适配决定（GitHub 评审摘要、IM owner 回复）。
   */
  private recordInboundTerminal(task: Task, outcome: ChildOutcome): void {
    if (!task.sourceEventId) return;
    const event = this.store.getInboundEvent(task.sourceEventId);
    if (event?.taskId === task.id) this.store.setInboundTerminal(event.id, outcome === "completed" ? "done" : "failed");
    if (event) this.deps.onInboundTerminal?.(event, task, outcome);
  }

  private async handleTerminal(task: Task, outcome: ChildOutcome): Promise<void> {
    if (this.store.db.prepare("SELECT 1 FROM workflow_executions WHERE task_id = ?").get(task.id)) return;
    if (this.store.getTask(task.id)?.resultSummary != null) return;
    if (task.subAgentId) {
      await this.handleSubAgentTerminal(task, outcome);
      return;
    }
    const scheduled = this.store.getSessionIdentity(task.sessionId)?.kind === "scheduled";
    const workflow = getWorkflowDeliveryRun(this.store, task.id);
    const reportTask = this.deps.parentDelivery.needsResult?.(task) ?? false;
    const agentId = task.agentId!;
    const replyPage = outcome === "completed" ? this.deps.bridge.readTaskReply(task.id, 0, 4096) : null;
    const reply = replyPage?.text.trim() || null;
    const summary = this.resultSummary(task, outcome, reply);
    const resultData = this.deps.resultData?.(task, outcome) ?? {};
    const resultRef = JSON.stringify({ sessionId: task.sessionId, taskId: task.id, outcome, ...resultData });
    // 结果一次写入：重复回传（监听与巡检竞争、重启后重扫）只有第一个生效
    const recorded = this.store.withTx(() => {
      if (!this.store.setTaskResult(task.id, summary, resultRef)) return false;
      this.recordInboundTerminal(task, outcome);
      this.deps.parentDelivery.wakeTerminal(task, outcome);
      const refs = { taskId: task.id, sessionId: task.sessionId };
      if (!scheduled && !workflow && !reportTask) switch (outcome) {
        case "completed":
          this.store.appendEvent(
            { type: "child_task.completed", taskId: task.id, parentTaskId: task.parentTaskId, agentId, summary, resultRef },
            refs,
          );
          break;
        case "failed":
          this.store.appendEvent(
            {
              type: "child_task.failed",
              taskId: task.id,
              parentTaskId: task.parentTaskId,
              agentId,
              errorMessage: task.errorMessage ?? "已取消或失败",
            },
            refs,
          );
          break;
        case "timeout":
          this.store.appendEvent(
            { type: "child_task.timeout", taskId: task.id, parentTaskId: task.parentTaskId, agentId, deadline: task.deadline ?? "" },
            refs,
          );
          break;
        case "unknown":
          this.store.appendEvent(
            {
              type: "child_task.result_unknown",
              taskId: task.id,
              parentTaskId: task.parentTaskId,
              agentId,
              reason: task.interruptReason ?? "interrupted",
            },
            refs,
          );
          break;
      }
      return true;
    });
    if (recorded) {
      await this.deps.parentDelivery.resultRecorded(task, outcome, summary);
      if (reportTask) await this.deps.parentDelivery.sweep();
    }
  }

  /**
   * SubAgent 执行任务终态（agent-direction issue 11）：结果与空闲状态在同一
   * 事务登记——正常退出且占用已核实回收入 idle；执行单元尚未确认退出
   * （keepOccupancy）记 unverified。重复终态通知或补记只产生一份逻辑结果。
   * 不自动重试；后台异常沿用 interrupted/占用保留路径。
   */
  private async handleSubAgentTerminal(task: Task, outcome: ChildOutcome): Promise<void> {
    const work = task.workId ? this.store.getWorkDelegation(task.workId) : null;
    const agent = this.store.getSubAgent(task.subAgentId!);
    if (!work || !agent) {
      this.log(`SubAgent 任务 ${task.id} 缺少工作/身份记录，跳过结果登记`);
      return;
    }
    const replyPage = outcome === "completed" ? this.deps.bridge.readTaskReply(task.id, 0, 4096) : null;
    const reply = replyPage?.text.trim() || null;
    const summary = this.resultSummary(task, outcome, reply);
    // 宿主评审（issue 19）：定稿产物与 review 引用先落盘（补记重入时复用已定稿
    // 产物）；artifactIds 在其后计算，结果清单才包含刚定稿的评审产物
    const resultData = this.deps.resultData?.(task, outcome) ?? {};
    // 结果引用：工作/身份/本次执行/原直接父任务/所属父会话分别核实
    const resultRef = JSON.stringify({
      sessionId: task.sessionId,
      taskId: task.id,
      workId: work.id,
      subAgentId: agent.id,
      parentSessionId: work.parentSessionId,
      parentTaskId: task.parentTaskId,
      outcome,
      artifactIds: this.store
        .listArtifactsByTask(task.id)
        .filter((a) => !a.name.startsWith("prompt-snapshot:"))
        .map((a) => a.id),
      failure: outcome === "completed" ? null : (task.errorMessage ?? task.interruptReason ?? OUTCOME_TEXT[outcome]),
      ...resultData,
    });
    const recorded = this.store.withTx(() => {
      if (!this.store.setTaskResult(task.id, summary, resultRef)) return false;
      this.deps.parentDelivery.reserveResult?.(this.store.getTask(task.id)!);
      // 宿主评审任务带来源事件：与角色路径同一处回写入站终态并登记通知（issue 19）
      this.recordInboundTerminal(task, outcome);
      this.deps.subagents?.resultRecorded(task);
      const refs = { taskId: task.id, sessionId: work.parentSessionId };
      switch (outcome) {
        case "completed":
          this.store.appendEvent(
            {
              type: "subagent_task.completed",
              workId: work.id,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId: work.parentSessionId,
              parentTaskId: task.parentTaskId!,
              summary,
              resultRef,
            },
            refs,
          );
          break;
        case "failed":
          this.store.appendEvent(
            {
              type: "subagent_task.failed",
              workId: work.id,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId: work.parentSessionId,
              parentTaskId: task.parentTaskId!,
              errorMessage: task.errorMessage ?? "已取消或失败",
            },
            refs,
          );
          break;
        case "timeout":
          this.store.appendEvent(
            {
              type: "subagent_task.timeout",
              workId: work.id,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId: work.parentSessionId,
              parentTaskId: task.parentTaskId!,
              deadline: task.deadline ?? "",
            },
            refs,
          );
          break;
        case "unknown":
          this.store.appendEvent(
            {
              type: "subagent_task.result_unknown",
              workId: work.id,
              subAgentId: agent.id,
              taskId: task.id,
              parentSessionId: work.parentSessionId,
              parentTaskId: task.parentTaskId!,
              reason: task.interruptReason ?? "interrupted",
            },
            refs,
          );
          break;
      }
      return true;
    });
    if (!recorded) return;
    // 终态登记后冲刷待投递消息；异步准备后在事务内重核当前工作与活动执行。
    await this.deps.subagents?.flushPending(work.parentSessionId);
    await this.deps.parentDelivery.resultRecorded(task, outcome, summary);
  }

  private resultSummary(task: Task, outcome: ChildOutcome, reply: string | null): string {
    const cap = (s: string) => {
      const chars = [...s], suffix = "…（截断）";
      return chars.length > RESULT_SUMMARY_CAP ? chars.slice(0, RESULT_SUMMARY_CAP - suffix.length).join("") + suffix : s;
    };
    switch (outcome) {
      case "completed":
        return cap(reply || "（无文本输出）");
      case "failed":
        return cap(`子任务失败：${task.errorMessage ?? "已取消"}`);
      case "timeout":
        return `子任务超过截止时间 ${task.deadline ?? "?"}，已取消`;
      case "unknown":
        return "子任务被后台重启/中断，结果未知（未自动重放任何外部副作用）";
    }
  }

  // ---------- 超时巡检 ----------

  private async checkDeadlines(): Promise<void> {
    if (!this.started) return;
    if (Date.now() - this.lastMediaCleanup >= MEDIA_CLEANUP_INTERVAL_MS) {
      this.lastMediaCleanup = Date.now();
      this.deps.cleanupMedia?.();
    }
    const now = new Date().toISOString();
    for (const task of this.store.listOverdueTasks(now)) {
      try {
        // 取消原因持久化（deadline_exceeded）：canceled 事件与启动巡检据此判定 timeout
        await this.deps.bridge.cancelTask(task.id, DEADLINE_REASON);
      } catch {
        // 已到终态等竞争路径，交还给事件/巡检
      }
    }
  }
}
