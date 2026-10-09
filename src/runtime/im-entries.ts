/**
 * 拥有者 IM 入口表（架构工单 10）：QQ 私聊与 Telegram 各是一个入口（adapter 实现
 * ImEntry），共用主会话。本模块持入口表，承担跨平台的部分：
 *
 * - 入站门按来源分派；配置/凭据变化后按来源 reconcile——只作废/取消该来源的
 *   入站与任务，不波及共享 main 会话中另一平台的工作（ADR 0011/0012）；
 * - owner 回复与工作最终汇报：目标须与当前钉版目标一致，否则跳过、不改发；
 * - 凭据变化：事务内推进引用该凭据的入口代次，写入凭据后重连并 reconcile；
 * - 缺省通知渠道（Telegram，ADR 0010；测试经 config.scheduler.channel 覆盖）。
 *
 * GitHub webhook 等事件来源不是拥有者 IM 入口，不进本表。
 */

import type { Store } from "../core/store.ts";
import type { InboundEvent, NotifyTarget, Task } from "../core/types.ts";
import { ACTIVE_TASK_STATUSES } from "../core/types.ts";
import { sameTarget } from "../core/notify-target.ts";
import type { SchedulerStore } from "../scheduler/store.ts";
import type { NotifyChannel } from "../scheduler/runtime.ts";
import { QQ_PRIVATE_SOURCE } from "../qq/adapter.ts";
import { TELEGRAM_SOURCE } from "../telegram/adapter.ts";
import type { ChildOutcome } from "./orchestrator.ts";
import type { WorkReport } from "./parent-delivery.ts";

/** 一个拥有者 IM 入口（各平台 adapter 实现）。 */
export interface ImEntry extends NotifyChannel {
  /** 入站来源，也是钉版目标的 channel。 */
  readonly source: string;
  /** owner 回复/工作汇报跳过时追加的持久事件名。 */
  readonly replySkippedEvent: "qq_private.reply_skipped" | "telegram.reply_skipped";
  /** 启动配置停用：不连接、target() 为 null、gate 作废（与入口停用同义，ADR 0012 修订段）。 */
  readonly startupDisabled: boolean;
  /** 入站派发/任务启动门：来源、actor 与钉版目标逐项核对；暂时离线 wait。 */
  gatePrivate(event: InboundEvent): "run" | "wait" | { drop: string };
  /** 当前配置期望的 actor；未绑定/停用为 null。 */
  expectedActor(): string | null;
  /** 单条回复字符上限。 */
  replyCapChars(): number;
  capReply(text: string): string;
  /** 钉版目标下登记的 externalId 前缀（核对消息确由同一账号 + chat 登记）。 */
  externalIdPrefix(target: NotifyTarget): string;
  usesCredential(name: string): boolean;
  /** 在调用方事务内推进配置版本并追加 *.config_changed 事件。 */
  bumpGeneration(): void;
  /** 配置事务提交后重建连接/轮询。 */
  onConfigChanged(): Promise<void>;
}

export interface ImEntriesDeps {
  store: Store;
  sched: SchedulerStore;
  entries: ImEntry[];
  /** 缺省渠道的测试覆盖（config.scheduler.channel）。 */
  defaultChannel?: NotifyChannel;
  readReply(taskId: string): string | null;
  cancelTask(taskId: string, reason: string): Promise<unknown>;
  /** 撤销该来源已死代次的 IM 审批与长期授权（由 ImApprovals 负责）。 */
  invalidateApprovals(source: string): void;
  kick(sessionId: string): void;
  kickSender(): void;
}

export class ImEntries {
  private readonly entries: Map<string, ImEntry>;

  constructor(private readonly deps: ImEntriesDeps) {
    this.entries = new Map(deps.entries.map((e) => [e.source, e]));
  }

  /** 按来源取入口；IM 审批按入口自身的钉版目标核对，不经缺省渠道的测试覆盖。 */
  entry(source: string): ImEntry | null {
    return this.entries.get(source) ?? null;
  }

  /**
   * 按已固定的渠道选择发送器：非缺省入口只发自己；缺省（Telegram）可被测试覆盖；
   * 未知渠道只有测试覆盖。启动配置停用的入口不算已加载（outbox 等待而不取消）。
   */
  channel(source: string = TELEGRAM_SOURCE): NotifyChannel | null {
    const entry = this.entries.get(source);
    const loaded = entry && !entry.startupDisabled ? entry : null;
    if (entry && source !== TELEGRAM_SOURCE) return loaded;
    return this.deps.defaultChannel ?? loaded;
  }

  /** 当前钉版目标；null = 未配置/停用/凭据不可用。 */
  target(source?: string): NotifyTarget | null {
    return this.channel(source)?.target() ?? null;
  }

  /**
   * 通知工具的目标（ADR 0010）：QQ 来源任务只在钉版目标仍一致时发 QQ，否则 null；
   * 其余走缺省渠道当前目标。
   */
  notificationTarget(sourceEvent: InboundEvent | null): NotifyTarget | null {
    if (sourceEvent?.source === QQ_PRIVATE_SOURCE) {
      const current = this.target(QQ_PRIVATE_SOURCE);
      return current && sameTarget(current, sourceEvent.replyTarget) ? current : null;
    }
    return this.target();
  }

  /** 拥有者 IM 来源的门；其他来源不归本表管（"run"）。 */
  gate(event: InboundEvent): "run" | "wait" | { drop: string } {
    return this.entries.get(event.source)?.gatePrivate(event) ?? "run";
  }

  /** 配置事务提交后：重建连接并撤销该来源旧授权。 */
  async applyConfig(source: string): Promise<void> {
    await this.entries.get(source)!.onConfigChanged();
    await this.reconcile(source);
  }

  /**
   * 撤销该来源旧授权：门已作废的 registered 入站标 failed、活动任务按 drop 原因
   * 取消、IM 审批失效；不动另一平台在共享 main 会话中的工作。
   */
  async reconcile(source: string): Promise<void> {
    const { store } = this.deps;
    for (const event of store.listInboundByStatus(["registered", "queued"])) {
      if (event.source !== source) continue;
      const gate = this.gate(event);
      if (gate === "run" || gate === "wait") continue;
      if (event.status === "registered") {
        store.withTx(() => store.failRegisteredInbound(event.id));
      } else if (event.taskId) {
        const task = store.getTask(event.taskId);
        if (task && (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) {
          await this.deps.cancelTask(task.id, gate.drop);
        }
      }
    }
    this.deps.invalidateApprovals(source);
    const main = store.getAgentRole("main");
    if (main) this.deps.kick(main.sessionId);
    this.deps.kickSender();
  }

  /**
   * 凭据写入前的代次推进（agent-direction issue 08，同步事务部分）：单调递增
   * 引用该凭据的入口 configVersion——旧连接、旧入站与旧批准立即失效，A→B→A
   * 轮换也不恢复旧代次。SQLite 与凭据文件没有跨文件事务，先保证旧授权失效。
   */
  bumpForCredential(name: string): void {
    const affected = [...this.entries.values()].filter((e) => e.usesCredential(name));
    if (affected.length) this.deps.store.withTx(() => affected.forEach((e) => e.bumpGeneration()));
  }

  /** 凭据写入后的重连与旧代次授权撤销（读到的是新凭据事实，与磁盘一致）。 */
  async reconcileAfterCredential(name: string): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.usesCredential(name)) await this.applyConfig(entry.source);
    }
  }

  /**
   * owner 回复（issue 04/06）：私聊入站任务到达终态时，在编排器的结果事务内
   * 登记一条发送操作——发送键为入站事件 id，目标由宿主固定，正文取本任务的
   * 最终回答（失败/超时/未知只发宿主固定提示）。定时唤醒与子任务唤醒产生的
   * 任务没有私聊来源事件，不会自动外发。
   */
  enqueueOwnerReply(event: InboundEvent, task: Task, outcome: ChildOutcome): void {
    if (!this.entries.has(event.source)) return;
    const text =
      task.errorMessage?.includes("image_input_unsupported")
        ? "[ruukoto] 当前模型不支持图片输入，这条图片消息未执行。请在配置中选择支持图片的模型后重新发送。"
        : outcome === "completed"
        ? this.deps.readReply(task.id)?.trim() || "（无文本输出）"
        : `[ruukoto] 这条消息的处理${outcome === "timeout" ? "超时" : outcome === "unknown" ? "被后台重启中断，结果未知" : "失败或已取消"}，详情见 TUI。`;
    this.enqueueReply(event, event.id, task.id, text, "");
  }

  /**
   * 工作最终汇报的 IM 发送（agent-direction issue 18；到期判定、键与正文由父级送达
   * 决定）：发送目标沿用入站钉版核对，离线等待/限流重试/结果未知不重发全部沿用
   * outbox 语义。在结果唤醒的结果事务内调用。
   */
  sendWorkReport(report: WorkReport): void {
    this.enqueueReply(report.event, report.key, report.wakeTaskId, report.text, "work_report:");
  }

  /**
   * 目标只能是登记该消息的同一账号 + chat，且须与当前钉版目标一致（配置换了
   * bot/chat 不改发新目标）；旧 Telegram 事件 replyTarget=null 无法证明接收时
   * 版本，明确失效。
   */
  private enqueueReply(event: InboundEvent, sourceKey: string, taskId: string, text: string, skipPrefix: string): void {
    const entry = this.entries.get(event.source)!;
    const skip = (reason: string) =>
      this.deps.store.appendEvent({ type: entry.replySkippedEvent, eventId: event.id, taskId, reason: `${skipPrefix}${reason}` }, { taskId });
    const current = this.target(event.source);
    const target = event.replyTarget;
    if (!target || !current || !sameTarget(current, target) || !event.externalId.startsWith(entry.externalIdPrefix(target))) {
      return skip(target ? "target_changed" : "target_unavailable");
    }
    try {
      this.deps.sched.insertOp({ sourceKind: "owner_reply", sourceKey, taskId, hostOpId: null, target, text: entry.capReply(text), sourceRefs: [] });
    } catch (err) {
      skip(`enqueue_failed：${(err as Error).message}`.slice(0, 200 - skipPrefix.length));
    }
  }
}
