/**
 * 调度器持久层（issue 03）：计划、调度运行与发送操作账本三张核心库表的窄读写。
 *
 * - 写方法都在调用方的 Store.withTx() 内执行（不嵌套事务）；状态与对应事件
 *   同事务提交，提交后才广播；
 * - 状态转换一律条件更新（WHERE status = ...），重复/并发调用只有一次生效；
 * - (source_kind, source_key) 与 create_key 唯一：同键同参返回原记录，同键异参冲突。
 */

import { createHash } from "node:crypto";
import type { Store } from "@ruukoto/core/store.ts";
import { randomId, type NotifyTarget } from "@ruukoto/core/types.ts";
import type { ScheduleRule } from "./time.ts";
import type { NewsResult, NewsSpec } from "./news.ts";

export type ScheduleAction = "wake_main" | "notify" | "news";
export type ScheduleStatus = "active" | "completed" | "canceled";
export type NotificationStatus = "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled";
export type NotificationSourceKind = "schedule_run" | "confirmation" | "owner_reply" | "inbound_event";

/** 来源快照引用（登记时解析为最终文本；发送前按引用复核可撤销的授权）。 */
export interface SourceRef {
  kind: "text" | "task_result" | "artifact" | "app_data" | "chat_result";
  /** 规范引用串（task:<id> / artifact:<id>@off+len / app_data:<table>#<row>.<field>）。 */
  ref: string;
  /** 读取时版本（行版本、产物字节数等；text 为空）。 */
  version: string;
  sha256: string;
}

export interface SchedulePayload {
  /** wake_main：有界触发说明；notify：已批准的固定正文。 */
  text: string;
  sourceRefs: SourceRef[];
  /** news：已批准的固定采集范围；text 保存审批时的策略说明。 */
  news?: NewsSpec;
}

export interface Schedule {
  id: string;
  createKey: string;
  paramsDigest: string;
  createTaskId: string | null;
  createOpId: string | null;
  action: ScheduleAction;
  rule: ScheduleRule;
  payload: SchedulePayload;
  target: NotifyTarget | null;
  approvalId: string | null;
  status: ScheduleStatus;
  nextDueAt: string | null;
  currentRunId: string | null;
  version: number;
  tzData: string;
  reason: string;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduleVersion: number;
  scheduledFor: string;
  localTime: string;
  registeredAt: string;
  delayMs: number;
  coalescedFrom: string | null;
  coalescedTo: string | null;
  inboundEventId: string | null;
  notificationOpId: string | null;
  newsResult?: NewsResult | null;
  closedAt: string | null;
}

export interface NotificationOp {
  id: string;
  sourceKind: NotificationSourceKind;
  sourceKey: string;
  taskId: string | null;
  hostOpId: string | null;
  target: NotifyTarget;
  text: string;
  textSha256: string;
  sourceRefs: SourceRef[];
  status: NotificationStatus;
  waitReason: string | null;
  /** 限流退回后最早再次领取时间（null = 立即可领取）。 */
  notBefore: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  platformMessageId: string | null;
  cancelRequested: boolean;
  lateReceipt: string | null;
  createdAt: string;
  sendingAt: string | null;
  settledAt: string | null;
  updatedAt: string;
}

export class SchedulerConflictError extends Error {
  readonly code = "request_conflict";
}

export const PAGE_LIMIT = 50;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 分页游标：created_at|id，按创建时间倒序。 */
function parseCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf("|");
  return at > 0 ? [cursor.slice(0, at), cursor.slice(at + 1)] : null;
}

function page<T extends { createdAt: string; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null };
}

export class SchedulerStore {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  // ---------- 计划 ----------

  findScheduleByCreateKey(key: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE create_key = ?").get(key) as any;
    return row ? rowToSchedule(row) : null;
  }

  getSchedule(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as any;
    return row ? rowToSchedule(row) : null;
  }

  countActive(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'").get() as any).n);
  }

  insertSchedule(input: Omit<Schedule, "id" | "status" | "currentRunId" | "version" | "cancelReason" | "createdAt" | "updatedAt">, source: string): Schedule {
    const now = new Date().toISOString();
    const schedule: Schedule = { ...input, id: randomId("sch"), status: "active", currentRunId: null, version: 1, cancelReason: null, createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO schedules (id, create_key, params_digest, create_task_id, create_op_id, action, rule, payload, target, approval_id,
           status, next_due_at, current_run_id, version, tz_data, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, 1, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id, schedule.createKey, schedule.paramsDigest, schedule.createTaskId, schedule.createOpId, schedule.action,
        JSON.stringify(schedule.rule), JSON.stringify(schedule.payload), schedule.target ? JSON.stringify(schedule.target) : null,
        schedule.approvalId, schedule.nextDueAt, schedule.tzData, schedule.reason, now, now,
      );
    this.store.appendEvent({ type: "schedule.changed", scheduleId: schedule.id, action: "created", version: 1, source, reason: schedule.reason });
    return schedule;
  }

  listDue(nowIso: string, limit: number): Schedule[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE status = 'active' AND next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY next_due_at, id LIMIT ?")
      .all(nowIso, limit) as any[];
    return rows.map(rowToSchedule);
  }

  listSchedules(opts: { status?: ScheduleStatus; cursor?: string; limit?: number }): { items: Schedule[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(opts.limit ?? PAGE_LIMIT, 1), PAGE_LIMIT);
    const cur = parseCursor(opts.cursor);
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules WHERE (? IS NULL OR status = ?) AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(opts.status ?? null, opts.status ?? null, cur?.[0] ?? null, cur?.[0] ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1) as any[];
    return page(rows.map(rowToSchedule), limit);
  }

  /** 推进下一触发时间并登记当前未完成运行（到期事务内）。 */
  advance(id: string, nextDueAt: string | null, currentRunId: string | null): void {
    this.db
      .prepare("UPDATE schedules SET next_due_at = ?, current_run_id = ?, updated_at = ? WHERE id = ?")
      .run(nextDueAt, currentRunId, new Date().toISOString(), id);
  }

  /** 取消（带预期版本，幂等：已取消返回原记录且 changed=false；完成/版本不符报冲突）。 */
  cancelSchedule(id: string, expectedVersion: number, reason: string, source: string, cancelOpId: string | null): { schedule: Schedule; changed: boolean } {
    const current = this.getSchedule(id);
    if (!current) throw new SchedulerConflictError(`计划不存在：${id}`);
    if (current.status === "canceled") return { schedule: current, changed: false };
    if (current.status !== "active") throw new SchedulerConflictError(`计划已${current.status}，不能取消`);
    if (current.version !== expectedVersion) throw new SchedulerConflictError(`计划版本不符（当前 v${current.version}，预期 v${expectedVersion}）`);
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE schedules SET status = 'canceled', next_due_at = NULL, version = version + 1, cancel_reason = ?, cancel_op_id = ?, updated_at = ? WHERE id = ? AND status = 'active' AND version = ?",
      )
      .run(reason, cancelOpId, now, id, expectedVersion);
    this.store.appendEvent({ type: "schedule.changed", scheduleId: id, action: "canceled", version: expectedVersion + 1, source, reason });
    return { schedule: this.getSchedule(id)!, changed: true };
  }

  /** 一次性计划的运行关闭后标完成（关闭前不能提前撤销本次待发通知的授权）。 */
  completeSchedule(id: string): void {
    const info = this.db
      .prepare("UPDATE schedules SET status = 'completed', current_run_id = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'active' AND next_due_at IS NULL")
      .run(new Date().toISOString(), id);
    if (Number(info.changes) === 1) {
      const s = this.getSchedule(id)!;
      this.store.appendEvent({ type: "schedule.changed", scheduleId: id, action: "completed", version: s.version, source: "scheduler" });
    }
  }

  // ---------- 调度运行 ----------

  getRun(id: string): ScheduleRun | null {
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as any;
    return row ? rowToRun(row) : null;
  }

  insertRun(run: Omit<ScheduleRun, "closedAt">): void {
    this.db
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, schedule_version, scheduled_for, local_time, registered_at, delay_ms, coalesced_from, coalesced_to, inbound_event_id, notification_op_id, news_result, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(run.id, run.scheduleId, run.scheduleVersion, run.scheduledFor, run.localTime, run.registeredAt, run.delayMs, run.coalescedFrom, run.coalescedTo, run.inboundEventId, run.notificationOpId, run.newsResult ? JSON.stringify(run.newsResult) : null);
    this.store.appendEvent({
      type: "schedule.run", scheduleId: run.scheduleId, runId: run.id, action: "registered", scheduledFor: run.scheduledFor,
      delayMs: run.delayMs, coalescedFrom: run.coalescedFrom, coalescedTo: run.coalescedTo,
    });
  }

  /** 未完成运行吸收新增漏过区间（保留原运行、原幂等键与原正文）。 */
  coalesceRun(run: ScheduleRun, from: string, to: string): void {
    const coalescedFrom = run.coalescedFrom ?? from;
    this.db.prepare("UPDATE schedule_runs SET coalesced_from = ?, coalesced_to = ? WHERE id = ? AND closed_at IS NULL").run(coalescedFrom, to, run.id);
    this.store.appendEvent({ type: "schedule.run", scheduleId: run.scheduleId, runId: run.id, action: "coalesced", scheduledFor: run.scheduledFor, coalescedFrom, coalescedTo: to });
  }

  listOpenRuns(): ScheduleRun[] {
    const rows = this.db.prepare("SELECT * FROM schedule_runs WHERE closed_at IS NULL ORDER BY registered_at, id").all() as any[];
    return rows.map(rowToRun);
  }

  listRuns(scheduleId: string, limit: number): ScheduleRun[] {
    const rows = this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?").all(scheduleId, limit) as any[];
    return rows.map(rowToRun);
  }

  listPendingNews(limit: number): ScheduleRun[] {
    return (this.db.prepare("SELECT * FROM schedule_runs WHERE closed_at IS NULL AND json_extract(news_result, '$.status') = 'pending' ORDER BY registered_at, id LIMIT ?").all(limit) as any[]).map(rowToRun);
  }

  claimNews(run: ScheduleRun): boolean {
    const info = this.db.prepare("UPDATE schedule_runs SET news_result = json_set(news_result, '$.status', 'searching') WHERE id = ? AND closed_at IS NULL AND json_extract(news_result, '$.status') = 'pending'").run(run.id);
    if (Number(info.changes) !== 1) return false;
    this.store.appendEvent({ type: "schedule.news", scheduleId: run.scheduleId, runId: run.id, status: "searching", itemCount: 0 });
    return true;
  }

  finishNews(run: ScheduleRun, result: NewsResult, opId: string | null): void {
    this.db.prepare("UPDATE schedule_runs SET news_result = ?, notification_op_id = ? WHERE id = ? AND closed_at IS NULL").run(JSON.stringify(result), opId, run.id);
    this.store.appendEvent({ type: "schedule.news", scheduleId: run.scheduleId, runId: run.id, status: result.status, itemCount: result.items.length, errorCode: result.errorCode });
  }

  closeRun(run: ScheduleRun): boolean {
    const info = this.db.prepare("UPDATE schedule_runs SET closed_at = ? WHERE id = ? AND closed_at IS NULL").run(new Date().toISOString(), run.id);
    if (Number(info.changes) !== 1) return false;
    this.db.prepare("UPDATE schedules SET current_run_id = NULL WHERE id = ? AND current_run_id = ?").run(run.scheduleId, run.id);
    this.store.appendEvent({ type: "schedule.run", scheduleId: run.scheduleId, runId: run.id, action: "closed", scheduledFor: run.scheduledFor });
    return true;
  }

  // ---------- 发送操作 ----------

  getOp(id: string): NotificationOp | null {
    const row = this.db.prepare("SELECT * FROM notification_ops WHERE id = ?").get(id) as any;
    return row ? rowToOp(row) : null;
  }

  findOpBySource(kind: NotificationSourceKind, key: string): NotificationOp | null {
    const row = this.db.prepare("SELECT * FROM notification_ops WHERE source_kind = ? AND source_key = ?").get(kind, key) as any;
    return row ? rowToOp(row) : null;
  }

  /** 登记发送操作：同来源键同正文/目标返回原操作（created=false），异参冲突；不能换键重试同一来源。 */
  insertOp(input: {
    sourceKind: NotificationSourceKind;
    sourceKey: string;
    taskId: string | null;
    hostOpId: string | null;
    target: NotifyTarget;
    text: string;
    sourceRefs: SourceRef[];
    /** 采集明确未产生可发送正文：直接登记失败，不伪装成已调用平台。 */
    failure?: { kind: string; message: string };
  }): { op: NotificationOp; created: boolean } {
    const existing = this.findOpBySource(input.sourceKind, input.sourceKey);
    const textSha256 = sha256(input.text);
    if (existing) {
      if (existing.textSha256 !== textSha256 || JSON.stringify(existing.target) !== JSON.stringify(input.target)) {
        throw new SchedulerConflictError(`发送键 ${input.sourceKind}:${input.sourceKey} 已绑定不同的正文或目标（操作 ${existing.id}）`);
      }
      return { op: existing, created: false };
    }
    const now = new Date().toISOString();
    const id = randomId("nop");
    this.db
      .prepare(
        `INSERT INTO notification_ops (id, source_kind, source_key, task_id, host_op_id, target, text, text_sha256, source_refs, status, error_kind, error_message, settled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sourceKind, input.sourceKey, input.taskId, input.hostOpId, JSON.stringify(input.target), input.text, textSha256, JSON.stringify(input.sourceRefs), input.failure ? "failed" : "pending", input.failure?.kind ?? null, input.failure?.message.slice(0, 500) ?? null, input.failure ? now : null, now, now);
    this.store.appendEvent({ type: "notification.changed", opId: id, status: input.failure ? "failed" : "pending", sourceKind: input.sourceKind, ...(input.failure ? { reason: input.failure.kind } : {}) });
    return { op: this.getOp(id)!, created: true };
  }

  listOps(opts: { status?: NotificationStatus; cursor?: string; limit?: number }): { items: NotificationOp[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(opts.limit ?? PAGE_LIMIT, 1), PAGE_LIMIT);
    const cur = parseCursor(opts.cursor);
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_ops WHERE (? IS NULL OR status = ?) AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(opts.status ?? null, opts.status ?? null, cur?.[0] ?? null, cur?.[0] ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1) as any[];
    return page(rows.map(rowToOp), limit);
  }

  /** 每渠道取一批可领取操作；离线渠道的积压不能挡住另一渠道，限流仍遵守 not_before。 */
  listPending(nowIso: string, limit: number): NotificationOp[] {
    const rows = this.db
      .prepare(`SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY json_extract(target, '$.channel') ORDER BY created_at, id) AS channel_position
        FROM notification_ops WHERE status = 'pending' AND (not_before IS NULL OR not_before <= ?)
      ) WHERE channel_position <= ? ORDER BY created_at, id`)
      .all(nowIso, limit) as any[];
    return rows.map(rowToOp);
  }

  /** 等待原因（渠道离线/发送器未加载）：只在变化时写入，避免每轮产生事件。 */
  setWaitReason(id: string, reason: string | null): void {
    this.db.prepare("UPDATE notification_ops SET wait_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND wait_reason IS NOT ?").run(reason, new Date().toISOString(), id, reason);
  }

  /** 领取：pending → sending 条件更新，只有成功领取者可调用发送函数。 */
  claim(id: string): boolean {
    const now = new Date().toISOString();
    const info = this.db
      .prepare("UPDATE notification_ops SET status = 'sending', sending_at = ?, wait_reason = NULL, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, now, id);
    if (Number(info.changes) !== 1) return false;
    const op = this.getOp(id)!;
    this.store.appendEvent({ type: "notification.changed", opId: id, status: "sending", sourceKind: op.sourceKind });
    return true;
  }

  /** 收尾：只从 sending 转终态（迟到/重复收尾不覆盖）。 */
  settle(id: string, status: "sent" | "failed" | "effect_unknown", fields: { platformMessageId?: string | null; errorKind?: string | null; errorMessage?: string | null }): boolean {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        "UPDATE notification_ops SET status = ?, platform_message_id = ?, error_kind = ?, error_message = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'",
      )
      .run(status, fields.platformMessageId ?? null, fields.errorKind ?? null, fields.errorMessage?.slice(0, 500) ?? null, now, now, id);
    if (Number(info.changes) !== 1) return false;
    const op = this.getOp(id)!;
    this.store.appendEvent({ type: "notification.changed", opId: id, status, sourceKind: op.sourceKind, ...(fields.errorKind ? { reason: fields.errorKind } : {}) });
    return true;
  }

  /**
   * 退回：平台明确拒绝且可证明未发送（限流）时 sending → pending，not_before 之后
   * 再领取；领取期间已有取消意图的直接 canceled。
   */
  release(id: string, notBefore: string, reason: string): boolean {
    const op = this.getOp(id);
    if (!op || op.status !== "sending") return false;
    const now = new Date().toISOString();
    const status = op.cancelRequested ? "canceled" : "pending";
    this.db
      .prepare("UPDATE notification_ops SET status = ?, sending_at = NULL, not_before = ?, wait_reason = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
      .run(status, status === "pending" ? notBefore : null, reason.slice(0, 500), status === "canceled" ? now : null, now, id);
    this.store.appendEvent({ type: "notification.changed", opId: id, status, sourceKind: op.sourceKind, reason: reason.slice(0, 200) });
    return true;
  }

  /** 迟到回执按原操作保存（不改状态、不触发重发）。 */
  recordLateReceipt(id: string, receipt: string): void {
    this.db.prepare("UPDATE notification_ops SET late_receipt = ?, updated_at = ? WHERE id = ?").run(receipt.slice(0, 500), new Date().toISOString(), id);
  }

  /**
   * 取消：确定未发送的 pending 直接 canceled；sending 只记录取消意图（按真实结果收尾）；
   * 终态不变。返回操作最新状态。
   */
  cancelOp(id: string, reason: string, cancelOpId: string | null): NotificationOp | null {
    const op = this.getOp(id);
    if (!op) return null;
    const now = new Date().toISOString();
    if (op.status === "pending") {
      this.db
        .prepare("UPDATE notification_ops SET status = 'canceled', error_kind = 'canceled', error_message = ?, cancel_op_id = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(reason.slice(0, 500), cancelOpId, now, now, id);
      this.store.appendEvent({ type: "notification.changed", opId: id, status: "canceled", sourceKind: op.sourceKind, reason: reason.slice(0, 200) });
    } else if (op.status === "sending" && !op.cancelRequested) {
      this.db.prepare("UPDATE notification_ops SET cancel_requested = 1, cancel_op_id = ?, updated_at = ? WHERE id = ?").run(cancelOpId, now, id);
    }
    return this.getOp(id);
  }

  /** 重启恢复：遗留 sending 一律 effect_unknown（含"已提交 sending、调用前崩溃"窗口），不重发。 */
  markSendingUnknown(): number {
    const rows = this.db.prepare("SELECT id FROM notification_ops WHERE status = 'sending'").all() as Array<{ id: string }>;
    for (const { id } of rows) this.settle(id, "effect_unknown", { errorKind: "backend_restart", errorMessage: "后台重启时发送结果未知，不自动重发" });
    return rows.length;
  }

  /** 宿主操作 ID 是否已登记（工具调用崩溃窗口核实：同库，恒可核实）。 */
  hostOpCommitted(hostOpId: string): boolean {
    // Node 22 将 ?1 视为命名参数，须按名称绑定。
    const hit = this.db
      .prepare(
        `SELECT 1 FROM schedules WHERE create_op_id = ?1 OR cancel_op_id = ?1
         UNION ALL SELECT 1 FROM notification_ops WHERE host_op_id = ?1 OR cancel_op_id = ?1 LIMIT 1`,
      )
      .get({ "?1": hostOpId });
    return hit !== undefined;
  }
}

function rowToSchedule(row: any): Schedule {
  return {
    id: row.id,
    createKey: row.create_key,
    paramsDigest: row.params_digest,
    createTaskId: row.create_task_id ?? null,
    createOpId: row.create_op_id ?? null,
    action: row.action,
    rule: JSON.parse(row.rule),
    payload: JSON.parse(row.payload),
    target: row.target ? JSON.parse(row.target) : null,
    approvalId: row.approval_id ?? null,
    status: row.status,
    nextDueAt: row.next_due_at ?? null,
    currentRunId: row.current_run_id ?? null,
    version: Number(row.version),
    tzData: row.tz_data,
    reason: row.reason,
    cancelReason: row.cancel_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: any): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleVersion: Number(row.schedule_version),
    scheduledFor: row.scheduled_for,
    localTime: row.local_time,
    registeredAt: row.registered_at,
    delayMs: Number(row.delay_ms),
    coalescedFrom: row.coalesced_from ?? null,
    coalescedTo: row.coalesced_to ?? null,
    inboundEventId: row.inbound_event_id ?? null,
    notificationOpId: row.notification_op_id ?? null,
    newsResult: row.news_result ? JSON.parse(row.news_result) : null,
    closedAt: row.closed_at ?? null,
  };
}

function rowToOp(row: any): NotificationOp {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    taskId: row.task_id ?? null,
    hostOpId: row.host_op_id ?? null,
    target: JSON.parse(row.target),
    text: row.text,
    textSha256: row.text_sha256,
    sourceRefs: JSON.parse(row.source_refs ?? "[]"),
    status: row.status,
    waitReason: row.wait_reason ?? null,
    notBefore: row.not_before ?? null,
    errorKind: row.error_kind ?? null,
    errorMessage: row.error_message ?? null,
    platformMessageId: row.platform_message_id ?? null,
    cancelRequested: Number(row.cancel_requested) === 1,
    lateReceipt: row.late_receipt ?? null,
    createdAt: row.created_at,
    sendingAt: row.sending_at ?? null,
    settledAt: row.settled_at ?? null,
    updatedAt: row.updated_at,
  };
}
