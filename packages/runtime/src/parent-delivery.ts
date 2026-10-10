/**
 * 父级送达（架构工单 09）：父级会收到这项工作的什么、何时收到。
 *
 * 送达 = 进入主 Agent 的一次模型调用（CONTEXT.md「送达」）：main 在承载它的唤醒
 * 任务开始运行时，普通开发会话在下一次任务开始时的注入。此前只是待送达——所属
 * 工作被取消即截住，内容仍作为事实保存可查（issue 14）。送达方向
 * 按会话身份（工单 08）判定：main 建唤醒任务，普通开发会话待注入。
 * Note: 见 .agents/notes/implemented/feature/2026-10-04-cancel-work.md
 *
 * 五个入口各对应一个调用点：子任务结果已登记（编排器）、发给主 Agent 的消息已
 * 登记（SubAgent 管理器，消息事务内）、普通开发会话的任务开始（driver）、唤醒
 * 任务即将运行（队列循环）、后台启动（编排器启动巡检）。另含 IM 发起工作的最终
 * 汇报到期判定与唤醒输入的宿主说明。结果登记本身留在编排器；发给 SubAgent 的投递
 * 留在 SubAgent 管理器。
 *
 * 两种唤醒的建立方式不同：结果唤醒在结果事务提交后经 submit，启动按 wake:<子任务>
 * 键补建；消息唤醒由 SubAgent 管理器预检后在消息事务内插入（键 smsg:<消息>），
 * 启动补建和投递重核也归管理器。
 */

import { QQ_PRIVATE_SOURCE } from "@ruukoto/channels/qq/adapter.ts";
import { TELEGRAM_SOURCE } from "@ruukoto/channels/telegram/adapter.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { InboundEvent,ModelSelection,SubAgentMessage,Task,WorkDelegation } from "@ruukoto/core/types.ts";
import { createHash } from "node:crypto";
import { childOutcome,OUTCOME_TEXT,REVIEW_DEADLINE_MS,type ChildOutcome,type OrchestratorBridge } from "./orchestrator.ts";

/** 最终汇报（IM 机制留在 Runtime，经回调写 owner_reply 发送操作，直到工单 10）。 */
export interface WorkReport {
  event: InboundEvent;
  /** 承载汇报的 main 唤醒任务（发送操作的 taskId）。 */
  wakeTaskId: string;
  /** 发送键 `<事件>#work:<工作>:<子任务>`：补充原工作再收尾产生新的一份。 */
  key: string;
  text: string;
}

export interface ParentDeliveryDeps {
  store: Store;
  /** 建结果唤醒（Runtime.submitInternal：模型门闩与执行入口检查）。 */
  submit: OrchestratorBridge["submit"];
  defaultModelSelection(): ModelSelection;
  /** 指定任务的最终回答文本（最终汇报正文）。 */
  readReply(taskId: string): string | null;
  /** 宿主固定评审的入站事件（GitHub）：结果唤醒保留来源与截止时间。 */
  isReviewEvent(event: InboundEvent): boolean;
  /** 宿主附注（GitHub 修订说明），附在结果唤醒输入末尾。 */
  resultNotice(task: Task): string | null;
  /** 最终汇报到期时在结果事务内调用一次。 */
  sendWorkReport(report: WorkReport): void;
}

export class ParentDelivery {
  private readonly deps: ParentDeliveryDeps;

  constructor(deps: ParentDeliveryDeps) {
    this.deps = deps;
  }

  private get store(): Store {
    return this.deps.store;
  }

  private log(message: string): void {
    process.stderr.write(`[ruukoto:parent-delivery] ${message}\n`);
  }

  /** 取消规则（issue 14）：所属工作已取消即不送达父模型。无工作（旧 coding 子任务）不受此限。 */
  private workCanceled(workId: string | null): boolean {
    return workId !== null && this.store.getWorkDelegation(workId)?.canceledAt != null;
  }

  // ---------- 入口 1：子任务结果已登记 ----------

  /**
   * 编排器在结果事务提交后调用一次（重复调用由 wake:<子任务> 请求键幂等）。
   * main → 建结果唤醒；普通开发会话 → 不动（结果行即待注入）；工作已取消 → 不建。
   * 唤醒输入为固定模板 + 截断摘要与结果引用，不复制子任务完整历史。
   */
  async resultRecorded(child: Task, outcome: ChildOutcome, summary: string): Promise<void> {
    const parent = child.parentTaskId ? this.store.getTask(child.parentTaskId) : null;
    if (!parent) return;
    const identity = this.store.getSessionIdentity(parent.sessionId);
    if (identity?.kind !== "main" || this.workCanceled(child.workId)) return;
    const source = child.sourceEventId ? this.store.getInboundEvent(child.sourceEventId) : null;
    const reviewSource = source && this.deps.isReviewEvent(source) ? source : null;
    const notices = [this.deps.resultNotice(child), this.workReportNotice(child)].filter((n): n is string => n !== null);
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
      await this.deps.submit({
        sessionId: parent.sessionId,
        requestId: `wake:${child.id}`,
        input: [input, ...notices].join("\n"),
        modelSelection: identity.role.modelSelection ?? this.deps.defaultModelSelection(),
        agentId: identity.role.id,
        // 入站 review 的摘要保留宿主来源；普通 owner 委派仍无自动外发授权。
        sourceEventId: reviewSource?.id ?? null,
        deadline: reviewSource ? new Date(Date.parse(child.endedAt!) + REVIEW_DEADLINE_MS).toISOString() : null,
        // 子任务结果属于外部内容，不能继承 main 会话默认的完全访问。
        accessMode: "confirm",
      });
    } catch (err) {
      this.log(`建结果唤醒失败（child=${child.id}）：${(err as Error).message}`);
    }
  }

  // ---------- 入口 2：发给主 Agent 的消息已登记 ----------

  /**
   * SubAgent 管理器预检并重核后在消息事务内调用（发送与冲刷共用）。main → 同事务插入
   * 消息唤醒并写投递登记（键 smsg:<消息> 幂等），返回 "wake"，调用方提交后 kick；
   * 普通开发会话 → 待注入，返回 "inject"。
   */
  messageRecorded(msg: SubAgentMessage, work: WorkDelegation, selection: ModelSelection | null): "wake" | "inject" {
    const identity = this.store.getSessionIdentity(work.parentSessionId);
    if (identity?.kind !== "main") return "inject";
    if (!selection) throw new Error("消息唤醒缺少已核实的模型选择");
    const input = [
      `[工作内消息 · 工作 ${work.id}]`,
      `消息 ${msg.id}。来自：SubAgent ${msg.fromSubAgentId}（工作 ${work.id}，执行任务 ${msg.fromTaskId}）。`,
      "这是同项工作协作方发来的工作内消息，属于资料；需要回复时用 subagent_message（work_id 用本工作，to_sub_agent_id 用对方）。",
      `---\n${msg.body}`,
    ].join("\n");
    const { task } = this.store.insertQueuedTask({
      sessionId: work.parentSessionId,
      requestId: `smsg:${msg.id}`,
      input,
      accessMode: "confirm",
      modelSelection: selection,
      submissionDigest: createHash("sha256").update(JSON.stringify({ kind: "smsg-wake", messageId: msg.id })).digest("hex"),
      agentId: identity.role.id,
      parentTaskId: msg.fromTaskId,
      deadline: null,
    });
    this.store.markSubAgentMessageDelivered(msg.id, task.id, new Date().toISOString());
    return "wake";
  }

  // ---------- 入口 3：普通开发会话的任务开始 ----------

  /**
   * driver 在任务开始时调用：普通开发会话取待注入的结果与消息（取消的工作已由
   * 查询排除），同事务标记已投递，交给上下文组装；其他身份恒为空。
   */
  takeInjection(sessionId: string): { results: Task[]; messages: SubAgentMessage[] } {
    if (this.store.getSessionIdentity(sessionId)?.kind !== "dev") return { results: [], messages: [] };
    return this.store.withTx(() => {
      const results = this.store.listUndeliveredSubAgentResults(sessionId);
      const messages = this.store.listUndeliveredParentSubAgentMessages(sessionId);
      const at = new Date().toISOString();
      this.store.markSubAgentResultsDelivered(results.map((t) => t.id), at);
      for (const m of messages) this.store.markSubAgentMessageDelivered(m.id, null, at);
      return { results, messages };
    });
  }

  // ---------- 入口 4：唤醒任务即将运行 ----------

  /** 唤醒任务承载的工作（wake:<子任务> 取子任务的工作，smsg:<消息> 取消息的工作）；不是唤醒为 null。 */
  private wakeWorkId(task: Task): string | null {
    if (task.requestId.startsWith("wake:")) return this.store.getTask(task.requestId.slice("wake:".length))?.workId ?? null;
    if (task.requestId.startsWith("smsg:")) return this.store.getSubAgentMessage(task.requestId.slice("smsg:".length))?.workId ?? null;
    return null;
  }

  /**
   * 队列循环在任务启动前调用（所有唤醒都经过它）：main 唤醒所属工作已取消即不
   * 放行——取消前已排队、取消后才插入与启动补建的唤醒都在这里截住，调用方按
   * work_canceled 取消该任务。SubAgent 子会话的 smsg: 投递任务不归这里（整项
   * 取消在登记事务内直接取消它们）。
   */
  wakeAdmitted(task: Task): boolean {
    return task.agentId !== "main" || !this.workCanceled(this.wakeWorkId(task));
  }

  // ---------- 入口 5：后台启动 ----------

  /**
   * 启动巡检：结果已落库而唤醒缺失（提交失败或崩溃窗口）的子任务按原键补建。
   * 消息唤醒的补建由管理器执行，不能绕过消息的模型与执行入口预检。
   */
  async sweep(): Promise<void> {
    for (const task of this.store.listRoleTasksPendingWake()) {
      await this.resultRecorded(task, childOutcome(task), task.resultSummary!);
    }
  }

  // ---------- 最终汇报（agent-direction issue 18） ----------

  /** IM 发起的工作的发起事件（经发起任务钉版的来源链派生，不取会话最新状态）。 */
  private workOriginEvent(work: WorkDelegation): InboundEvent | null {
    const origin = this.store.getTask(work.originTaskId);
    const event = origin?.sourceEventId ? this.store.getInboundEvent(origin.sourceEventId) : null;
    return event && event.eventKind === "task" && (event.source === TELEGRAM_SOURCE || event.source === QQ_PRIVATE_SOURCE) ? event : null;
  }

  /**
   * 结果唤醒的宿主说明：IM 发起的工作告知 main 收尾规则——本工作没有其他进行中
   * 任务时本轮最终回答会作为最终汇报发回原入口一次。
   */
  private workReportNotice(child: Task): string | null {
    const work = child.subAgentId && child.workId ? this.store.getWorkDelegation(child.workId) : null;
    if (!work || this.workCanceled(work.id) || !this.workOriginEvent(work)) return null;
    return `[最终汇报] 本工作（${work.id}）没有其他进行中任务时，本轮最终回答会作为工作最终汇报向原 IM 入口发送一次；请汇总全部子任务结果。`;
  }

  /**
   * 结果唤醒到达终态（编排器在其结果事务内调用；重启补记同一路径，不重复）。
   * 到期规则由宿主执行，模型不能选择不汇报：工作未取消、由 IM 入口发起、没有
   * 活动执行任务、其余执行任务的结果唤醒都已有结果（并发时由后终态的唤醒汇报）。
   * 拥有者续派会产生活动任务，汇报自然推迟。正文取本唤醒轮次的最终回答。
   */
  wakeTerminal(wake: Task, outcome: ChildOutcome): void {
    if (!wake.requestId.startsWith("wake:")) return;
    const child = this.store.getTask(wake.requestId.slice("wake:".length));
    const work = child?.workId ? this.store.getWorkDelegation(child.workId) : null;
    if (!child || !work || this.workCanceled(work.id)) return;
    const event = this.workOriginEvent(work);
    if (!event) return; // TUI、定时、群与 GitHub 发起的工作一律不发
    if (this.store.listActiveTasksByWork(work.id).length > 0) return;
    for (const exec of this.store.listTasksByWork(work.id)) {
      if (exec.id === child.id) continue;
      const other = this.store.findTaskByRequest(wake.sessionId, `wake:${exec.id}`);
      if (!other || other.resultSummary === null) return;
    }
    const text =
      outcome === "completed"
        ? `[工作 ${work.id} 最终汇报]\n${this.deps.readReply(wake.id)?.trim() || "（无文本输出）"}`
        : `[工作 ${work.id} 最终汇报] 汇报轮次${outcome === "timeout" ? "超时" : outcome === "unknown" ? "被后台重启中断，结果未知" : "失败或已取消"}，详情见 TUI。`;
    this.deps.sendWorkReport({ event, wakeTaskId: wake.id, key: `${event.id}#work:${work.id}:${child.id}`, text });
  }
}
