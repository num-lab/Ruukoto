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
import type { Store } from "../core/store.ts";
import type { HistoryEntryView } from "../core/history.ts";
import { QQ_GROUP_SOURCE, type QqStore } from "../qq/store.ts";
import {
  isTerminalTaskStatus,
  type AccessMode,
  type AgentRole,
  type AgentRoleId,
  type InboundEvent,
  type ModelSelection,
  type NotifyTarget,
  type PersistentEvent,
  type Task,
} from "../core/types.ts";
import { sessionToolCategories } from "../agent/tool-availability.ts";
import { canonicalParamsDigest } from "../agent/mcp/tools.ts";
import type { SubAgentDelegateInput, SubAgentDelegation } from "./subagents.ts";

/** 编排器需要的 Runtime 窄接口（宿主注入；除此之外的能力编排器不可见）。 */
export interface OrchestratorBridge {
  submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode?: AccessMode;
    modelSelection: ModelSelection;
    agentId?: AgentRoleId | null;
    parentTaskId?: string | null;
    sourceEventId?: string | null;
    deadline?: string | null;
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
  /** 超时巡检间隔（默认 1s；测试可压短）。 */
  deadlineCheckMs?: number;
  /**
   * 入站事件关联任务的结果事务内回调（issue 04 owner 回复）：与结果/事件终态
   * 同事务提交，重启巡检补记结果时一并补登，不会重复。
   */
  onInboundTerminal?(event: InboundEvent, task: Task, outcome: ChildOutcome): void;
  /**
   * main 唤醒任务（requestId 以 wake: 开头）的结果事务内回调（agent-direction
   * issue 18 工作收尾汇报）；与结果同事务提交，重启巡检补记结果时一并补登，
   * 不重复。
   */
  onWakeTerminal?(task: Task, outcome: ChildOutcome): void;
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
    flushPending?(parentSessionId?: string): void;
  };
  /** 结果落库前保存交付产物与来源元数据；重启补记走同一路径。 */
  resultData?(task: Task, outcome: ChildOutcome): Record<string, unknown>;
  resultNotice?(task: Task): string | null;
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
const REVIEW_DEADLINE_MS = 60 * 60_000;

/** 子任务终态口径（completed/failed/timeout/unknown），事件、摘要与唤醒共用。 */
export type ChildOutcome = "completed" | "failed" | "timeout" | "unknown";

const OUTCOME_TEXT: Record<ChildOutcome, string> = {
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  unknown: "结果未知",
};

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
    // 崩溃窗口恢复①：已登记未建任务的事件按原请求键核实重提（幂等，不换新键）
    await this.recoverInbound();
    // 崩溃窗口恢复②：重启期间到达终态的角色任务补记结果与事件、补唤醒；
    // interrupted 一律按结果未知处理，不自动重放任何外部副作用
    await this.sweepPendingResults();
    // 崩溃窗口恢复③（issue 13）：待投递的工作内消息统一重核投递资格（边栏触发
    // 丢失时由这里兜底；资格已失记明确未投递结果）
    this.deps.subagents?.flushPending?.();
    // 角色会话与 SubAgent 子会话的队列暂停由编排器自动恢复，但仅限
    // backend_restart（排队任务在重启后继续）；occupancy_unverified 等涉及
    // 未核实旧执行的暂停必须保留给拥有者核实（docs/runtime.md 恢复约定——
    // 角色任务有工具执行，不同于无工具的 QQ 会话，不能沿用其无条件恢复前提）。
    // 拥有者/主 Agent 委派的 SubAgent 排队任务已由恢复事务定 interrupted
    // （runtime.ts recover），这里能命中的子会话只剩宿主固定评审的排队任务。
    for (const role of this.store.listAgentRoles()) {
      await this.resumeRestartPausedQueue(role.sessionId, `角色 ${role.id}`);
    }
    for (const agent of this.store.listSubAgents()) {
      await this.resumeRestartPausedQueue(agent.sessionId, `SubAgent ${agent.id}`);
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
      const previous = group?.sessionId ? this.store.findTaskByRequest(group.sessionId, group.requestId) : null;
      if (previous && !isTerminalTaskStatus(previous.status)) await this.deps.bridge.cancelTask(previous.id, gate.drop);
      return;
    }
    const role = this.store.getAgentRole(event.targetRole);
    if (!role) {
      this.log(`事件 ${event.id} 目标角色 ${event.targetRole} 未引导，跳过`);
      return;
    }
    const input =
      `[入站事件] 来源：${event.source} 外部 id：${event.externalId} actor：${event.actor ?? "未知"}\n` +
      event.body +
      (event.artifactRefs.length > 0 ? `\n产物引用：${JSON.stringify(event.artifactRefs)}` : "");
    let task: Task;
    try {
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
      } else task = await this.deps.bridge.submit({
        sessionId: role.sessionId,
        requestId: `evt:${event.id}`,
        input,
        modelSelection: role.modelSelection ?? this.deps.bridge.defaultModelSelection(),
        agentId: role.id,
        sourceEventId: event.id,
        // 入站事件（定时唤醒、Telegram 等）一律采用宿主固定的 confirm 模式：
        // 正文不能设置权限，也不继承会话默认的完全访问
        accessMode: "confirm",
      });
    } catch (err) {
      this.log(`事件 ${event.id} 建任务失败：${(err as Error).message}`);
      return; // 保持 registered，下次启动恢复重提
    }
    this.store.withTx(() => {
      this.store.markInboundQueued(event.id, task.id);
      // 任务已落库/已结束、事件回填前崩溃的窗口也沿用原任务。
      const recorded = this.store.getTask(task.id)!;
      if (recorded.resultSummary !== null) this.store.setInboundTerminal(event.id, recorded.status === "completed" ? "done" : "failed");
    });
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
      if (!task || (!task.agentId && !task.subAgentId)) continue; // 只处理角色任务与 SubAgent 执行任务
      const outcome: ChildOutcome =
        body.type === "task.completed"
          ? "completed"
          : body.type === "task.interrupted"
            ? "unknown"
            : this.isDeadlineCancel(task)
              ? "timeout"
              : "failed";
      void this.handleTerminal(task, outcome).catch((err) => this.log(`结果回传失败：${(err as Error).message}`));
    }
  }

  /** 超时取消的判定：取消原因在取消时持久化（errorMessage/interruptReason），重启后仍可核对。 */
  private isDeadlineCancel(task: Task): boolean {
    return task.errorMessage === DEADLINE_REASON || task.interruptReason === DEADLINE_REASON;
  }

  /** 由任务持久状态推导终态口径（启动巡检与补发唤醒共用）。 */
  private outcomeFromStatus(task: Task): ChildOutcome {
    if (task.status === "completed") return "completed";
    if (task.status === "interrupted") return "unknown";
    if (task.status === "canceled" && this.isDeadlineCancel(task)) return "timeout";
    return "failed";
  }

  /**
   * 启动巡检：
   * ① 重启窗口内到达终态的角色任务补记结果与事件（handleTerminal 内含唤醒）；
   * ② 结果已落库但唤醒缺失（提交失败或①之前的崩溃窗口）的子任务，按原
   *   幂等键 wake:<childId> 补发——唤醒任务的存在即投递记录，重复恢复不重复
   *   投递。
   */
  private async sweepPendingResults(): Promise<void> {
    for (const task of this.store.listRoleTasksPendingResult()) {
      await this.handleTerminal(task, this.outcomeFromStatus(task));
    }
    for (const task of this.store.listRoleTasksPendingWake()) {
      const parent = this.store.getTask(task.parentTaskId!);
      if (!parent || !this.store.getAgentRoleBySession(parent.sessionId)) continue; // 与 wakeParent 同一口径
      await this.wakeParent(task, this.outcomeFromStatus(task), task.resultSummary!);
    }
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
    if (this.store.getTask(task.id)?.resultSummary != null) return;
    if (task.subAgentId) {
      await this.handleSubAgentTerminal(task, outcome);
      return;
    }
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
      if (task.requestId.startsWith("wake:")) this.deps.onWakeTerminal?.(task, outcome);
      const refs = { taskId: task.id, sessionId: task.sessionId };
      switch (outcome) {
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
    if (recorded && task.parentTaskId) {
      await this.wakeParent(task, outcome, summary);
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
      // 宿主评审任务带来源事件：与角色路径同一处回写入站终态并登记通知（issue 19）
      this.recordInboundTerminal(task, outcome);
      const occupancyHeld = this.store.listAllOccupancy().some((o) => o.sessionId === task.sessionId);
      this.store.setSubAgentState(agent.id, occupancyHeld ? "unverified" : "idle", {
        activeWorkId: work.id,
        currentTaskId: null,
      });
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
    // 工作内消息（issue 13）：终态登记后冲刷该父会话的待投递消息——刚空闲的
    // 接收方立即投递（在同一同步续段内，早于任何新委派登记），资格已失记未投递
    this.deps.subagents?.flushPending?.(work.parentSessionId);
    // dev 父会话不产生唤醒任务：结果经下次模型调用的宿主资料注入送达
    // （result_delivered_at），持久事件已指向父会话；main 按稳定 wake 键回报。
    const parent = task.parentTaskId ? this.store.getTask(task.parentTaskId) : null;
    if (!parent) return;
    if (!this.store.getAgentRoleBySession(parent.sessionId)) return;
    // 已取消的工作（issue 14）不建 wake：迟到结果已保存为事实（上文登记，事件与
    // subagent_result 可查），但不再唤醒父模型——排除主 Agent 据此重启这项工作的
    // 可能，需要时由主 Agent 主动 subagent_result 读取。
    if (this.store.getWorkDelegation(work.id)?.canceledAt) return;
    await this.wakeParent(task, outcome, summary);
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

  /**
   * main 的有界唤醒输入：固定模板 + 截断摘要（上限 RESULT_SUMMARY_CAP），
   * 只带固定字段与结果引用，不复制子任务完整历史；请求键 wake:<childId>
   * 幂等，重复结果回传只唤醒一次。唤醒只投向角色会话（main 等）——父任务
   * 在拥有者交互会话时结果经 get_task 查询，不向该会话注入输入。
   */
  private async wakeParent(child: Task, outcome: ChildOutcome, summary: string): Promise<void> {
    const parent = this.store.getTask(child.parentTaskId!);
    if (!parent) return;
    const parentRole = this.store.getAgentRoleBySession(parent.sessionId);
    if (!parentRole) return;
    const source = child.sourceEventId ? this.store.getInboundEvent(child.sourceEventId) : null;
    const reviewSource = source && this.deps.reviewRequest?.(source) ? source : null;
    const notice = this.deps.resultNotice?.(child);
    const input = child.subAgentId
        ? `[编排器] 子任务${OUTCOME_TEXT[outcome]}\n` +
          `子任务：${child.id}（SubAgent ${child.subAgentId} · 工作 ${child.workId}）\n` +
          `摘要：${summary}\n` +
          `完整结果：用 subagent_result 按 work_id ${child.workId} 读取（part=reply 分页读最终回答，part=artifact 读产物）`
        // 旧 coding 子任务（agent-direction issue 23 退役前在途，启动收尾后补记一次）
        : `[编排器] 子任务${OUTCOME_TEXT[outcome]}\n` +
          `子任务：${child.id}（角色 ${child.agentId}）\n` +
          `摘要：${summary}\n` +
          `完整结果：用 coding_result 读取（task_id ${child.id}；part=reply 分页读最终回答，part=artifact 读产物）`;
    try {
      await this.deps.bridge.submit({
        sessionId: parent.sessionId,
        requestId: `wake:${child.id}`,
        input: input + (notice ? `\n${notice}` : ""),
        modelSelection: parentRole.modelSelection ?? this.deps.bridge.defaultModelSelection(),
        agentId: parentRole.id,
        // 入站 review 的摘要保留宿主来源；普通 owner 委派仍无自动外发授权。
        sourceEventId: reviewSource?.id ?? null,
        deadline: reviewSource ? new Date(Date.parse(child.endedAt!) + REVIEW_DEADLINE_MS).toISOString() : null,
        // 子任务结果属于外部内容，不能继承 main 会话默认的完全访问。
        accessMode: "confirm",
      });
    } catch (err) {
      this.log(`唤醒父任务会话失败（child=${child.id}）：${(err as Error).message}`);
    }
  }

  // ---------- 超时巡检 ----------

  private async checkDeadlines(): Promise<void> {
    if (!this.started) return;
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
