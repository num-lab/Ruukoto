/**
 * 后台编排器（issue 01 日常助手）：逻辑角色 main/coding/chat 的引导、持久
 * 入站事件的登记与派发、父子任务结果回传与有界唤醒、子任务超时取消、
 * 重启恢复。
 *
 * 窄入口：只经 OrchestratorBridge 调用 Runtime 的少量方法；不持有拥有者
 * token，不能审批、改权限、开完全访问或读取其他项目资料。本组件不是模型
 * 工具——模型工具清单中没有任务创建能力，控制面 ops 也不接受编排字段，
 * 只有本组件能创建子任务。
 *
 * 角色配置（项目/会话/工作目录/模型/工具白名单）只由本组件在引导时写入
 * agent_roles 表；输入正文、项目指令与模型结果不能修改。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "../core/store.ts";
import {
  AGENT_ROLE_IDS,
  normalizeIsoInstant,
  type AccessMode,
  type AgentRole,
  type AgentRoleId,
  type InboundEvent,
  type ModelSelection,
  type PersistentEvent,
  type Task,
  type ToolCategory,
} from "../core/types.ts";

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
  readLastAssistantText(sessionId: string): string | null;
  resumeQueue(sessionId: string): Promise<unknown>;
  defaultModelSelection(): ModelSelection;
}

export interface OrchestratorDeps {
  store: Store;
  /** 后台数据目录（角色工作目录在其兄弟目录 agent-work/ 下，避开保护根）。 */
  dataDir: string;
  bridge: OrchestratorBridge;
  /** 超时巡检间隔（默认 1s；测试可压短）。 */
  deadlineCheckMs?: number;
}

/** 角色静态定义：工具白名单按注册来源类别给出（Driver 三层强制）。 */
const ROLE_DEFINITIONS: Array<{ id: AgentRoleId; projectName: string; tools: ToolCategory[] }> = [
  // main：日常对话/信息整理/编排——资料与记忆、Web Search、应用数据空间（issue 02）；
  // 不持有编码工具
  { id: "main", projectName: "agent-main", tools: ["host_data", "web_search", "app_data"] },
  // coding：仓库/测试/PR 分析——编码工具 + 资料 + Web Search + MCP
  { id: "coding", projectName: "agent-coding", tools: ["coding", "host_data", "web_search", "mcp"] },
  // chat：群聊——空工具集合（与 qq_group 同一约束口径）
  { id: "chat", projectName: "agent-chat", tools: [] },
];

/** 委派/事件输入正文上限（登记时截断，超出部分不入库）。 */
const INPUT_TEXT_CAP = 8192;
/** 子任务结果摘要上限（写入任务记录与唤醒输入）。 */
const RESULT_SUMMARY_CAP = 1000;
/** 超时取消的持久化原因（canceled 事件与启动巡检据此判定 timeout，重启后不丢）。 */
const DEADLINE_REASON = "deadline_exceeded";

/** 子任务终态口径（completed/failed/timeout/unknown），事件、摘要与唤醒共用。 */
type ChildOutcome = "completed" | "failed" | "timeout" | "unknown";

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

/** 一次委派的已核实参数（delegate 校验后经串行链交给 delegateChecked）。 */
interface DelegateArgs {
  parentTaskId: string;
  requestId: string;
  roleId: AgentRoleId;
  sessionId: string;
  modelSelection: ModelSelection;
  body: string;
  deadline: string | null;
  sourceEventId: string | null;
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private started = false;
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
    // 角色会话的队列暂停由编排器自动恢复，但仅限 backend_restart（排队任务
    // 在重启后继续）；occupancy_unverified 等涉及未核实旧执行的暂停必须保留
    // 给拥有者核实（docs/runtime.md 恢复约定——角色任务有工具执行，不同于
    // 无工具的 QQ 会话，不能沿用其无条件恢复前提）
    for (const role of this.store.listAgentRoles()) {
      const session = this.store.getSession(role.sessionId);
      if (session && session.queueState === "paused" && session.queuePauseReason === "backend_restart") {
        await this.deps.bridge
          .resumeQueue(session.id)
          .catch((err) => this.log(`恢复角色 ${role.id} 队列失败：${(err as Error).message}`));
      }
    }
    const ms = this.deps.deadlineCheckMs ?? 1_000;
    this.deadlineTimer = setInterval(() => void this.checkDeadlines(), ms);
    this.deadlineTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.deadlineTimer) {
      clearInterval(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  // ---------- 角色引导 ----------

  /** 幂等：已有角色行跳过重建；仅工具清单按定义幂等升级（issue 02：既有 main 获得 app_data，身份不变）。 */
  private async ensureRoles(): Promise<void> {
    for (const def of ROLE_DEFINITIONS) {
      const existing = this.store.getAgentRole(def.id);
      if (existing) {
        this.store.updateAgentRoleTools(def.id, def.tools);
        continue;
      }
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
        tools: def.tools,
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
    targetRole: AgentRoleId;
    body: string;
    artifactRefs?: string[];
  }): Promise<{ event: InboundEvent; created: boolean }> {
    if (!AGENT_ROLE_IDS.includes(input.targetRole)) throw new Error(`目标角色无效：${input.targetRole}`);
    if (!input.source.trim() || !input.externalId.trim()) throw new Error("入站事件的 source 与 external_id 不能为空");
    const { event, created } = this.store.withTx(() =>
      this.store.registerInboundEvent({
        source: input.source,
        externalId: input.externalId,
        actor: input.actor ?? null,
        targetRole: input.targetRole,
        body: capInput(input.body),
        artifactRefs: input.artifactRefs,
      }),
    );
    if (created) this.enqueueDispatch();
    return { event, created };
  }

  /**
   * 内部委派（issue 01）：只有编排器能创建子任务。幂等键在父任务范围内唯一
   * （请求键 deleg:<parentTaskId>:<key>）：同一父任务重复委派同参返回同一
   * 子任务；同键换参数（如更换目标角色，会落到另一角色会话）明确冲突，不
   * 产生第二个子任务。查重与提交串行执行（跨会话的唯一约束覆盖不到同键）。
   */
  async delegate(input: {
    parentTaskId: string;
    targetRole: AgentRoleId;
    input: string;
    deadline?: string | null;
    idempotencyKey: string;
    sourceEventId?: string | null;
  }): Promise<Task> {
    const parent = this.store.getTask(input.parentTaskId);
    if (!parent) throw new Error(`父任务不存在：${input.parentTaskId}`);
    const role = this.store.getAgentRole(input.targetRole);
    if (!role) throw new Error(`角色未引导：${input.targetRole}`);
    if (!input.idempotencyKey.trim()) throw new Error("委派幂等键不能为空");
    let deadline: string | null = null;
    if (input.deadline != null) {
      deadline = normalizeIsoInstant(input.deadline);
      if (deadline === null) throw new Error(`截止时间无效：${input.deadline}`);
    }
    const args: DelegateArgs = {
      parentTaskId: parent.id,
      requestId: `deleg:${parent.id}:${input.idempotencyKey}`,
      roleId: role.id,
      sessionId: role.sessionId,
      modelSelection: role.modelSelection ?? this.deps.bridge.defaultModelSelection(),
      // 跨角色传递只带固定字段：委派正文 + 截止；不复制父任务的会话历史
      body: capInput(input.input),
      deadline,
      sourceEventId: input.sourceEventId ?? null,
    };
    const run = this.dispatchChain.then(() => this.delegateChecked(args));
    this.dispatchChain = run.then(() => {}, () => {});
    return run;
  }

  private async delegateChecked(args: DelegateArgs): Promise<Task> {
    const existing = this.store.findChildTask(args.parentTaskId, args.requestId);
    if (existing) {
      const same =
        existing.agentId === args.roleId &&
        existing.input === args.body &&
        (existing.deadline ?? null) === args.deadline &&
        (existing.sourceEventId ?? null) === args.sourceEventId;
      if (!same) {
        throw new Error(`委派幂等键冲突：${args.requestId} 已绑定参数不同的子任务 ${existing.id}`);
      }
      return existing;
    }
    return this.deps.bridge.submit({
      sessionId: args.sessionId,
      requestId: args.requestId,
      input: args.body,
      modelSelection: args.modelSelection,
      agentId: args.roleId,
      parentTaskId: args.parentTaskId,
      sourceEventId: args.sourceEventId,
      deadline: args.deadline,
    });
  }

  /** 已登记未建任务的事件串行重提（启动恢复）。 */
  private async recoverInbound(): Promise<void> {
    const pending = this.store.listInboundByStatus(["registered"]);
    if (pending.length > 0) this.log(`恢复 ${pending.length} 条已登记未建任务的入站事件`);
    for (const event of pending) await this.dispatchEvent(event);
  }

  private enqueueDispatch(): void {
    this.dispatchChain = this.dispatchChain.then(() => this.dispatchRegistered()).catch(() => {});
  }

  private async dispatchRegistered(): Promise<void> {
    for (const event of this.store.listInboundByStatus(["registered"])) {
      await this.dispatchEvent(event);
    }
  }

  /**
   * 为事件建任务并入队。请求键 evt:<eventId> 幂等：崩溃发生在建任务与
   * 标记之间时，重提命中同一请求键返回既有任务，不重复创建。
   */
  private async dispatchEvent(event: InboundEvent): Promise<void> {
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
      task = await this.deps.bridge.submit({
        sessionId: role.sessionId,
        requestId: `evt:${event.id}`,
        input,
        modelSelection: role.modelSelection ?? this.deps.bridge.defaultModelSelection(),
        agentId: role.id,
        sourceEventId: event.id,
      });
    } catch (err) {
      this.log(`事件 ${event.id} 建任务失败：${(err as Error).message}`);
      return; // 保持 registered，下次启动恢复重提
    }
    this.store.withTx(() => this.store.markInboundQueued(event.id, task.id));
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
      if (!task || !task.agentId) continue; // 只处理编排器创建的角色任务
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

  private async handleTerminal(task: Task, outcome: ChildOutcome): Promise<void> {
    const agentId = task.agentId!;
    const summary = this.resultSummary(task, outcome);
    const resultRef = JSON.stringify({ sessionId: task.sessionId, taskId: task.id });
    // 结果一次写入：重复回传（监听与巡检竞争、重启后重扫）只有第一个生效
    const recorded = this.store.withTx(() => {
      if (!this.store.setTaskResult(task.id, summary, resultRef)) return false;
      if (task.sourceEventId) {
        this.store.setInboundTerminal(task.sourceEventId, outcome === "completed" ? "done" : "failed");
      }
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

  private resultSummary(task: Task, outcome: ChildOutcome): string {
    const cap = (s: string) => (s.length > RESULT_SUMMARY_CAP ? `${s.slice(0, RESULT_SUMMARY_CAP)}…（截断）` : s);
    switch (outcome) {
      case "completed":
        return cap(this.deps.bridge.readLastAssistantText(task.sessionId)?.trim() || "（无文本输出）");
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
    const input =
      `[编排器] 子任务${OUTCOME_TEXT[outcome]}\n` +
      `子任务：${child.id}（角色 ${child.agentId}）\n` +
      `摘要：${summary}\n` +
      `完整结果：session ${child.sessionId} task ${child.id}（经 get_task / read_history 查询）`;
    try {
      await this.deps.bridge.submit({
        sessionId: parent.sessionId,
        requestId: `wake:${child.id}`,
        input,
        modelSelection: parentRole.modelSelection ?? this.deps.bridge.defaultModelSelection(),
        agentId: parentRole.id,
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
