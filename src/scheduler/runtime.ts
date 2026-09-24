/**
 * 调度器宿主组件（issue 03）：一个不重入的扫描循环 + 一个独立发送循环。
 *
 * - 内存定时器只负责唤醒扫描；规则、下次时间、运行记录与发送状态以数据库为准；
 * - 到期在一次短事务中核对计划、创建或合并运行、推进下一触发时间，并登记
 *   入站事件（wake_main）或发送操作（notify）；事务内不等网络、模型或应用库；
 * - 漏过多个周期每计划只补一次：无未完成运行时取截点前最近一次，已有未完成
 *   运行时并入原运行（原键、原正文），不建第二个；
 * - 发送一次只有一个在途操作；网络调用在领取事务提交后执行一次，明确成功 sent、
 *   可证明未发送 failed、限流退回 pending 延迟再领取（ADR 0011）、其余（超时/断线/
 *   中止/模糊错误）effect_unknown，不自动重发；
 * - 不进入 coding 会话的任务队列，也不占用其工作目录。
 */

import type { Store } from "../core/store.ts";
import { isTerminalTaskStatus, randomId, type NotifyTarget } from "../core/types.ts";
import { SchedulerStore, type NotificationOp, type Schedule, type ScheduleRun } from "./store.ts";
import { latestAtOrBefore, localTimeOf, nextAfter } from "./time.ts";

/** 发送函数可证明未产生发送时抛出（平台拒绝/参数非法/未发出请求）→ failed。 */
export class NotSentError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message);
  }
}

/**
 * 平台明确拒绝且可证明未发送、但允许稍后再试时抛出（如 Telegram 429 限流）：
 * 操作回到 pending，retryAfterMs 之后才可再次领取。
 */
export class RetryLaterError extends Error {
  constructor(readonly retryAfterMs: number, message: string) {
    super(message);
  }
}

/** 宿主注入的通知渠道（生产为 Telegram 适配器，issue 04；测试注入模拟渠道）。 */
export interface NotifyChannel {
  /** 当前可信 owner 目标；null = 未配置或已停用。 */
  target(): NotifyTarget | null;
  /** 渠道暂时离线时返回 false（操作保留 pending 并显示等待原因）。 */
  available?(): boolean;
  /** 发送一次：返回平台消息 ID；可证明未发送抛 NotSentError（可稍后再试抛 RetryLaterError）；不得隐藏重试或拆分多条。 */
  send(input: { opId: string; target: NotifyTarget; text: string; signal: AbortSignal }): Promise<{ platformMessageId: string }>;
}

export interface SchedulerDeps {
  store: Store;
  sched: SchedulerStore;
  now(): number;
  channel(source: string): NotifyChannel | null;
  /** 编排器：派发已持久化的 registered 入站事件（原串行链，重复调用不重复建任务）。 */
  dispatchRegistered(): Promise<void>;
  /** 编排器串行边界（取消与派发在同一链上核对）。 */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  cancelTask(taskId: string): Promise<unknown>;
  /** 发送前复核来源引用的可撤销授权；null = 通过。 */
  verifySources(op: NotificationOp): string | null;
  log(message: string): void;
  /** 扫描间隔（默认 1s；0 = 不自动扫描，测试手动 tick）。 */
  tickMs?: number;
  /** 单次发送时限（默认 15s）。 */
  sendTimeoutMs?: number;
}

export const SCHEDULER_LIMITS = {
  batch: 50,
  batchesPerTick: 20,
  maxActive: 1000,
  sendTimeoutMs: 15_000,
  /** 超过此延迟即标记为延迟补发。 */
  lateMs: 60_000,
  /** 登记后仍未派发的入站事件（所有来源）的补派间隔。 */
  redispatchMs: 30_000,
};

const iso = (ms: number) => new Date(ms).toISOString();
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private sending: Promise<void> | null = null;
  private inflight: AbortController | null = null;
  private stopping = false;
  /** 关闭屏障：数据库关闭后，未及时结束的发送回调不得再写入。 */
  private closed = false;
  private lastRedispatch = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  private get store(): Store {
    return this.deps.store;
  }

  private get sched(): SchedulerStore {
    return this.deps.sched;
  }

  /**
   * 启动前恢复准备（须在 Runtime.recover() 改写 running 任务之前）：
   * ① 关联记录早已终态、只是关闭标记未回填的运行先补关闭（不能吸收之后漏过的周期）；
   * ② 到期计划按正常规则处理——仍 registered/queued/running/pending/sending 的运行吸收
   *   漏过区间，没有未完成运行的计划补一次；
   * ③ 最后把遗留 sending 定为 effect_unknown（位置由之后的正常关闭释放）。
   */
  prepareRecovery(): void {
    this.closeFinished();
    const now = this.deps.now();
    for (const s of this.sched.listDue(iso(now), SCHEDULER_LIMITS.maxActive)) {
      try {
        this.fire(s, now);
      } catch (err) {
        this.deps.log(`恢复时计划 ${s.id} 到期登记失败：${(err as Error).message}`);
      }
    }
    this.store.withTx(() => this.sched.markSendingUnknown());
  }

  start(): void {
    const ms = this.deps.tickMs ?? 1_000;
    if (ms > 0) {
      this.timer = setInterval(() => void this.tick().catch((err) => this.deps.log(`扫描失败：${(err as Error).message}`)), ms);
      this.timer.unref?.();
    }
    this.kickSender();
  }

  /** 不重入扫描：进行中时返回同一次扫描。 */
  tick(now?: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick(now ?? this.deps.now()).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(now: number): Promise<void> {
    this.closeFinished();
    let created = false;
    for (let b = 0; b < SCHEDULER_LIMITS.batchesPerTick && !this.stopping; b++) {
      const due = this.sched.listDue(iso(now), SCHEDULER_LIMITS.batch);
      if (due.length === 0) break;
      for (const s of due) {
        try {
          if (this.fire(s, now)) created = true;
        } catch (err) {
          this.deps.log(`计划 ${s.id} 到期登记失败：${(err as Error).message}`);
        }
      }
      await yieldLoop();
    }
    // 登记事务提交后派发；提交后派发失败的事件保持 registered，按间隔补派（不依赖重启）
    const wallNow = Date.now();
    if (!this.stopping && (created || (wallNow - this.lastRedispatch >= SCHEDULER_LIMITS.redispatchMs && this.hasUndispatched()))) {
      this.lastRedispatch = wallNow;
      await this.deps.dispatchRegistered().catch((err) => this.deps.log(`派发调度事件失败：${(err as Error).message}`));
    }
    this.kickSender();
  }

  private hasUndispatched(): boolean {
    // 所有来源（调度、Telegram 等）已登记未派发的事件都按间隔补派
    return this.store.db.prepare("SELECT 1 FROM inbound_events WHERE status = 'registered' LIMIT 1").get() !== undefined;
  }

  /** 一个计划的到期处理（单事务）；返回是否新登记了需要派发的入站事件。 */
  private fire(candidate: Schedule, now: number): boolean {
    return this.store.withTx(() => {
      const s = this.sched.getSchedule(candidate.id);
      if (!s || s.status !== "active" || !s.nextDueAt || Date.parse(s.nextDueAt) > now) return false;
      const due = s.nextDueAt;
      // 截点前最近一次应发生时刻（不早于持久化的下一时刻：时钟回拨/时区数据更新不回退处理范围）
      const latest = latestAtOrBefore(s.rule, now);
      const scheduledFor = latest && latest > due ? latest : due;
      const next = s.rule.kind === "once" ? null : nextAfter(s.rule, Math.max(now, Date.parse(scheduledFor)));
      const open = s.currentRunId ? this.sched.getRun(s.currentRunId) : null;
      if (open && !open.closedAt) {
        // 已有未完成运行：并入原运行，不建第二个
        this.sched.coalesceRun(open, due, scheduledFor);
        this.sched.advance(s.id, next, open.id);
        return false;
      }
      const run: Omit<ScheduleRun, "closedAt"> = {
        id: randomId("run"),
        scheduleId: s.id,
        scheduleVersion: s.version,
        scheduledFor,
        localTime: localTimeOf(scheduledFor, s.rule.timeZone),
        registeredAt: iso(now),
        delayMs: Math.max(0, now - Date.parse(scheduledFor)),
        coalescedFrom: scheduledFor !== due ? due : null,
        coalescedTo: scheduledFor !== due ? scheduledFor : null,
        inboundEventId: null,
        notificationOpId: null,
      };
      if (s.action === "wake_main") {
        const { event } = this.store.registerInboundEvent({
          source: "scheduler",
          externalId: run.id,
          actor: "scheduler",
          targetRole: "main",
          body: wakeBody(s, run),
          artifactRefs: [],
        });
        run.inboundEventId = event.id;
      } else {
        const { op } = this.sched.insertOp({
          sourceKind: "schedule_run",
          sourceKey: run.id,
          taskId: null,
          hostOpId: null,
          target: s.target!,
          text: s.payload.text,
          sourceRefs: s.payload.sourceRefs,
        });
        run.notificationOpId = op.id;
      }
      this.sched.insertRun(run);
      this.sched.advance(s.id, next, run.id);
      return s.action === "wake_main";
    });
  }

  /** 关联任务/发送已终态的运行补关闭；一次性计划随之完成。 */
  closeFinished(): void {
    // 未关闭运行数 ≤ 计划数（活跃上限 1,000 + 取消后仍在执行的少量）；全量检查，
    // 不能只看最旧一批，否则卡住的等待运行会让已结束的新运行永不关闭
    for (const run of this.sched.listOpenRuns()) {
      if (!this.runFinished(run)) continue;
      this.store.withTx(() => {
        if (!this.sched.closeRun(run)) return;
        const s = this.sched.getSchedule(run.scheduleId);
        if (s && s.status === "active" && s.rule.kind === "once" && s.nextDueAt === null) this.sched.completeSchedule(s.id);
      });
    }
  }

  private runFinished(run: ScheduleRun): boolean {
    if (run.notificationOpId) {
      const op = this.sched.getOp(run.notificationOpId);
      return !op || (op.status !== "pending" && op.status !== "sending");
    }
    const event = run.inboundEventId ? this.store.getInboundEvent(run.inboundEventId) : null;
    if (!event || event.status === "done" || event.status === "failed") return true;
    if (event.status === "registered" || !event.taskId) return false;
    const task = this.store.getTask(event.taskId);
    return !task || isTerminalTaskStatus(task.status);
  }

  /**
   * 取消计划：立即停止未来触发，取消尚未发送的关联 pending 操作；未派发的运行
   * 不再派发；已排队的关联任务经现有取消入口处理。在编排器串行链上执行，覆盖
   * 与派发的竞争；已运行的任务与在途发送保留真实执行事实。
   */
  cancelSchedule(input: { scheduleId: string; expectedVersion: number; reason: string; source: string; cancelOpId: string | null }): Promise<Schedule> {
    return this.deps.serial(async () => {
      let queuedTaskId: string | null = null;
      const result = this.store.withTx(() => {
        const r = this.sched.cancelSchedule(input.scheduleId, input.expectedVersion, input.reason, input.source, input.cancelOpId);
        if (!r.changed) return r;
        const run = r.schedule.currentRunId ? this.sched.getRun(r.schedule.currentRunId) : null;
        if (run?.notificationOpId) this.sched.cancelOp(run.notificationOpId, "计划已取消", input.cancelOpId);
        if (run?.inboundEventId) {
          const event = this.store.getInboundEvent(run.inboundEventId);
          if (event?.status === "registered") this.store.failRegisteredInbound(event.id);
          else if (event?.status === "queued" && event.taskId && this.store.getTask(event.taskId)?.status === "queued") queuedTaskId = event.taskId;
        }
        return r;
      });
      if (queuedTaskId) await this.deps.cancelTask(queuedTaskId).catch(() => {});
      this.closeFinished();
      return result.schedule;
    });
  }

  // ---------- 发送循环 ----------

  kickSender(): void {
    if (this.sending || this.stopping) return;
    this.sending = this.drainSends()
      .catch((err) => this.deps.log(`发送循环失败：${(err as Error).message}`))
      .finally(() => {
        this.sending = null;
      });
  }

  /** 等待当前发送轮次（测试与停止路径用）。 */
  async idle(): Promise<void> {
    while (this.ticking || this.sending) await (this.ticking ?? this.sending);
  }

  private async drainSends(): Promise<void> {
    // 每个 pending 每轮只检查一次：暂时不可用的保留等待原因，下一轮再查
    for (const op of this.sched.listPending(iso(this.deps.now()), SCHEDULER_LIMITS.batch)) {
      if (this.stopping) return;
      await this.sendOne(op);
    }
  }

  private async sendOne(op: NotificationOp): Promise<void> {
    const channel = this.deps.channel(op.target.channel);
    const cancel = (reason: string) => this.store.withTx(() => this.sched.cancelOp(op.id, reason, null));
    if (!channel) {
      this.store.withTx(() => this.sched.setWaitReason(op.id, "sender_unavailable：发送器未加载"));
      return;
    }
    const target = channel.target();
    if (!target) return void cancel("target_disabled：可信目标未配置或已停用，旧授权不再可用");
    if (JSON.stringify(target) !== JSON.stringify(op.target)) return void cancel("target_changed：目标配置版本已变化，不自动改发到新目标");
    if (op.sourceKind === "schedule_run") {
      const run = this.sched.getRun(op.sourceKey);
      const s = run ? this.sched.getSchedule(run.scheduleId) : null;
      if (!s || s.status === "canceled") return void cancel("schedule_canceled：计划已取消");
    }
    const problem = this.deps.verifySources(op);
    if (problem) return void cancel(`source_revoked：${problem}`);
    if (channel.available && !channel.available()) {
      this.store.withTx(() => this.sched.setWaitReason(op.id, "channel_offline：渠道暂时离线"));
      return;
    }
    if (!this.store.withTx(() => this.sched.claim(op.id))) return;

    const aborter = new AbortController();
    this.inflight = aborter;
    const timeoutMs = this.deps.sendTimeoutMs ?? SCHEDULER_LIMITS.sendTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const aborted = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        aborter.abort();
        reject(new Error(`发送超过 ${timeoutMs}ms 时限`));
      }, timeoutMs);
      aborter.signal.addEventListener("abort", () => reject(new Error("发送被中止（后台停止）")), { once: true });
    });
    // 同步抛错的渠道也按发送结果收尾（不留 sending、超时拒绝有处理者）
    const sendPromise = Promise.resolve().then(() => channel.send({ opId: op.id, target: op.target, text: op.text, signal: aborter.signal }));
    aborted.catch(() => {});
    let outcome:
      | { status: "sent"; id: string }
      | { status: "retry"; retryAfterMs: number; message: string }
      | { status: "failed" | "effect_unknown"; kind: string; message: string };
    try {
      const r = await Promise.race([sendPromise, aborted]);
      outcome = { status: "sent", id: r.platformMessageId };
    } catch (err) {
      outcome = err instanceof RetryLaterError
        ? { status: "retry", retryAfterMs: err.retryAfterMs, message: err.message }
        : err instanceof NotSentError
          ? { status: "failed", kind: err.kind, message: err.message }
          : { status: "effect_unknown", kind: aborter.signal.aborted ? "timeout_or_abort" : "ambiguous_error", message: (err as Error).message };
      if (!(err instanceof NotSentError) && !(err instanceof RetryLaterError)) {
        // 迟到回执按原操作保存，不触发重发；关闭屏障后不再写库
        sendPromise.then(
          (r) => !this.closed && this.safe(() => this.sched.recordLateReceipt(op.id, `late_success:${r.platformMessageId}`)),
          () => {},
        );
      }
    } finally {
      clearTimeout(timer);
      this.inflight = null;
    }
    if (this.closed) return;
    // 本地结果写入失败：保留 sending（重启转 effect_unknown），不回退 pending
    this.safe(() =>
      this.store.withTx(() =>
        outcome.status === "sent"
          ? this.sched.settle(op.id, "sent", { platformMessageId: outcome.id })
          : outcome.status === "retry"
            ? this.sched.release(op.id, iso(this.deps.now() + outcome.retryAfterMs), `rate_limited：${outcome.message}`)
            : this.sched.settle(op.id, outcome.status, { errorKind: outcome.kind, errorMessage: outcome.message }),
      ),
    );
    this.closeFinished();
  }

  private safe(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.deps.log(`发送结果写入失败：${(err as Error).message}`);
    }
  }

  /** 停止：先拒绝扫描与领取，再中止在途发送并等待收尾；之后关闭屏障生效。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inflight?.abort();
    await this.idle().catch(() => {});
    this.closed = true;
  }
}

function wakeBody(s: Schedule, run: Omit<ScheduleRun, "closedAt">): string {
  const lines = [
    `[调度器] 计划 ${s.id} 到期（wake_main）`,
    `原定时间：${run.localTime}（UTC ${run.scheduledFor}）`,
  ];
  if (run.delayMs > SCHEDULER_LIMITS.lateMs || run.coalescedFrom) {
    lines.push(`延迟补发：延迟 ${Math.round(run.delayMs / 1000)} 秒${run.coalescedFrom ? `；合并漏过周期 ${run.coalescedFrom} – ${run.coalescedTo}` : ""}`);
  }
  lines.push(`触发说明：${s.payload.text}`);
  if (s.payload.sourceRefs.length > 0) lines.push(`来源引用：${s.payload.sourceRefs.map((r) => r.ref).join(", ")}`);
  lines.push("（本次唤醒不继承外发授权；需要发送通知请用 notification_enqueue 另行确认）");
  return lines.join("\n");
}
