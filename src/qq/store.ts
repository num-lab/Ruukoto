/**
 * QQ 群聊入口的持久化（issue 07，NapCat OneBot v11）。
 *
 * - qq_config：单行连接配置（端点、凭据绑定名、预期登录账号、群允许列表、
 *   启停、运行保护参数）；任何变化递增 config_version 并随事件提交；
 *   token 等秘密值只在 CredentialStore，本表只存绑定名。
 * - qq_sessions：登录账号+群 → 独立项目/会话/专用工作目录（不同群隔离）。
 * - qq_inbox：收件登记（先持久化再入队；dedup_key = account:group:message_id）。
 * - qq_outbox：发送记录（先保存固定目标/正文/本地操作 id 再发送；
 *   unknown = effect_unknown，不自动重发）。
 */

import type { Db } from "../core/db.ts";
import { randomId } from "../core/types.ts";

export interface QqConfig {
  /** OneBot 正向 WebSocket 端点（ws://host:port；生产默认回环/受控私网）。 */
  endpoint: string;
  /** 凭据绑定名（CredentialStore；null = 无 token 鉴权）。 */
  credentialName: string | null;
  /** 预期登录账号（QQ 号字符串）；事件 self_id 不一致时不接纳。 */
  selfId: string;
  /** 允许触发的群号列表（全体成员可 @ 触发；空 = 不接纳任何群）。 */
  groups: string[];
  enabled: boolean;
  /** 单条回复字符上限（超过即缩短；默认值未经真实平台核实，部署时按实测调整）。 */
  maxReplyChars: number;
  /** 排队过期（毫秒）：未开始执行的请求超过该时长即跳过（固定 5 分钟，见工单已确认规则）。 */
  queueTtlMs: number;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}

export class QqVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(expected: number, current: number) {
    super(`QQ 配置版本冲突：期望 v${expected}，当前 v${current}（请刷新后重试）`);
  }
}

export interface QqGroupSession {
  account: string;
  groupId: string;
  sessionId: string;
  projectId: string;
  workDir: string;
  createdAt: string;
}

export type QqInboxStatus = "registered" | "queued" | "done" | "reply_failed" | "reply_unknown" | "skipped";

export interface QqInboxRow {
  dedupKey: string;
  account: string;
  groupId: string;
  userId: string;
  senderName: string;
  messageId: string;
  requestId: string;
  sessionId: string | null;
  taskId: string | null;
  /** 群消息原文（展示与引用解析用）。 */
  text: string;
  /** 提交运行时的完整任务输入（含标记/发言人/引用前缀；恢复时按原文重提，保证幂等摘要一致）。 */
  input: string;
  status: QqInboxStatus;
  recalled: boolean;
  messageTime: string | null;
  createdAt: string;
}

export type QqOutboxStatus = "pending" | "sent" | "failed" | "unknown" | "canceled";

export interface QqOutboxRow {
  opId: string;
  taskId: string;
  account: string;
  groupId: string;
  replyToMessageId: string | null;
  text: string;
  status: QqOutboxStatus;
  sentMessageId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function qqDedupKey(account: string, groupId: string, messageId: string): string {
  return `${account}:${groupId}:${messageId}`;
}

export class QqStore {
  constructor(private readonly db: Db) {}

  // ---------- 配置 ----------

  getConfig(): QqConfig | null {
    const row = this.db.prepare("SELECT * FROM qq_config WHERE id = 1").get() as any;
    return row ? rowToConfig(row) : null;
  }

  /** 新建或更新连接配置（调用方在事务内追加事件）；版本校验后递增。 */
  upsertConfig(input: {
    endpoint: string;
    credentialName?: string | null;
    selfId: string;
    maxReplyChars?: number;
    expectedVersion?: number;
  }): QqConfig {
    const existing = this.getConfig();
    if (input.expectedVersion !== undefined) {
      const current = existing?.configVersion ?? 0;
      if (input.expectedVersion !== current) throw new QqVersionConflictError(input.expectedVersion, current);
    }
    const now = new Date().toISOString();
    if (existing) {
      const next: QqConfig = {
        ...existing,
        endpoint: input.endpoint,
        credentialName: input.credentialName !== undefined ? input.credentialName : existing.credentialName,
        selfId: input.selfId,
        maxReplyChars: input.maxReplyChars ?? existing.maxReplyChars,
        configVersion: existing.configVersion + 1,
        updatedAt: now,
      };
      this.db
        .prepare("UPDATE qq_config SET endpoint = ?, credential_name = ?, self_id = ?, max_reply_chars = ?, config_version = ?, updated_at = ? WHERE id = 1")
        .run(next.endpoint, next.credentialName, next.selfId, next.maxReplyChars, next.configVersion, now);
      return next;
    }
    const config: QqConfig = {
      endpoint: input.endpoint,
      credentialName: input.credentialName ?? null,
      selfId: input.selfId,
      groups: [],
      enabled: false,
      maxReplyChars: input.maxReplyChars ?? 1500,
      queueTtlMs: 300_000,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO qq_config (id, endpoint, credential_name, self_id, groups, enabled, max_reply_chars, queue_ttl_ms, config_version, created_at, updated_at)
         VALUES (1, ?, ?, ?, '[]', 0, ?, 300000, 1, ?, ?)`,
      )
      .run(config.endpoint, config.credentialName, config.selfId, config.maxReplyChars, now, now);
    return config;
  }

  setEnabled(enabled: boolean, expectedVersion?: number): QqConfig | null {
    const existing = this.getConfig();
    if (!existing) return null;
    if (expectedVersion !== undefined && expectedVersion !== existing.configVersion) {
      throw new QqVersionConflictError(expectedVersion, existing.configVersion);
    }
    if (existing.enabled === enabled) return existing;
    const next = { ...existing, enabled, configVersion: existing.configVersion + 1, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE qq_config SET enabled = ?, config_version = ?, updated_at = ? WHERE id = 1")
      .run(enabled ? 1 : 0, next.configVersion, next.updatedAt);
    return next;
  }

  /** 群允许列表增删（配置变化，版本递增）。返回 null = 未配置。 */
  setGroups(groups: string[], expectedVersion?: number): QqConfig | null {
    const existing = this.getConfig();
    if (!existing) return null;
    if (expectedVersion !== undefined && expectedVersion !== existing.configVersion) {
      throw new QqVersionConflictError(expectedVersion, existing.configVersion);
    }
    const next = { ...existing, groups, configVersion: existing.configVersion + 1, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE qq_config SET groups = ?, config_version = ?, updated_at = ? WHERE id = 1")
      .run(JSON.stringify(groups), next.configVersion, next.updatedAt);
    return next;
  }

  // ---------- 群会话映射 ----------

  getGroupSession(account: string, groupId: string): QqGroupSession | null {
    const row = this.db
      .prepare("SELECT * FROM qq_sessions WHERE account = ? AND group_id = ?")
      .get(account, groupId) as any;
    return row ? rowToGroupSession(row) : null;
  }

  getGroupSessionBySessionId(sessionId: string): QqGroupSession | null {
    const row = this.db.prepare("SELECT * FROM qq_sessions WHERE session_id = ?").get(sessionId) as any;
    return row ? rowToGroupSession(row) : null;
  }

  insertGroupSession(row: { account: string; groupId: string; sessionId: string; projectId: string; workDir: string }): void {
    this.db
      .prepare(
        `INSERT INTO qq_sessions (account, group_id, session_id, project_id, work_dir, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.account, row.groupId, row.sessionId, row.projectId, row.workDir, new Date().toISOString());
  }

  listGroupSessions(): QqGroupSession[] {
    const rows = this.db.prepare("SELECT * FROM qq_sessions ORDER BY created_at, group_id").all() as any[];
    return rows.map(rowToGroupSession);
  }

  // ---------- 收件登记 ----------

  /** 幂等登记：已存在同键记录返回 { created: false, row }（不重复入队）。 */
  registerInbox(input: {
    account: string;
    groupId: string;
    userId: string;
    senderName: string;
    messageId: string;
    text: string;
    taskInput: string;
    messageTime: string | null;
  }): { created: boolean; row: QqInboxRow } {
    const dedupKey = qqDedupKey(input.account, input.groupId, input.messageId);
    const existing = this.getInbox(dedupKey);
    if (existing) return { created: false, row: existing };
    const row: QqInboxRow = {
      dedupKey,
      account: input.account,
      groupId: input.groupId,
      userId: input.userId,
      senderName: input.senderName,
      messageId: input.messageId,
      requestId: `qq:${dedupKey}`,
      sessionId: null,
      taskId: null,
      text: input.text,
      input: input.taskInput,
      status: "registered",
      recalled: false,
      messageTime: input.messageTime,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO qq_inbox (dedup_key, account, group_id, user_id, sender_name, message_id,
         request_id, session_id, task_id, text, input, status, recalled, message_time, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'registered', 0, ?, ?)`,
      )
      .run(row.dedupKey, row.account, row.groupId, row.userId, row.senderName, row.messageId, row.requestId, row.text, row.input, row.messageTime, row.createdAt);
    return { created: true, row };
  }

  getInbox(dedupKey: string): QqInboxRow | null {
    const row = this.db.prepare("SELECT * FROM qq_inbox WHERE dedup_key = ?").get(dedupKey) as any;
    return row ? rowToInbox(row) : null;
  }

  getInboxByTask(taskId: string): QqInboxRow | null {
    const row = this.db.prepare("SELECT * FROM qq_inbox WHERE task_id = ?").get(taskId) as any;
    return row ? rowToInbox(row) : null;
  }

  /** 登记 → 入队关联（同事务记录会话与任务；恢复时据此核实）。 */
  linkInboxTask(dedupKey: string, sessionId: string, taskId: string): void {
    this.db
      .prepare("UPDATE qq_inbox SET session_id = ?, task_id = ?, status = 'queued' WHERE dedup_key = ?")
      .run(sessionId, taskId, dedupKey);
  }

  setInboxStatus(dedupKey: string, status: QqInboxStatus): void {
    this.db.prepare("UPDATE qq_inbox SET status = ? WHERE dedup_key = ?").run(status, dedupKey);
  }

  /** 已登记但尚未关联任务的记录（崩溃窗口恢复用；按原请求键核实重提）。 */
  listUnlinkedInbox(): QqInboxRow[] {
    const rows = this.db
      .prepare("SELECT * FROM qq_inbox WHERE status = 'registered' AND recalled = 0 ORDER BY created_at, dedup_key")
      .all() as any[];
    return rows.map(rowToInbox);
  }

  /** 撤回标记（条件更新；重复撤回返回 false）。 */
  markRecalled(account: string, groupId: string, messageId: string): QqInboxRow | null {
    const info = this.db
      .prepare("UPDATE qq_inbox SET recalled = 1 WHERE dedup_key = ? AND recalled = 0")
      .run(qqDedupKey(account, groupId, messageId));
    if (Number(info.changes) !== 1) return null;
    return this.getInbox(qqDedupKey(account, groupId, messageId));
  }

  /** 该会话已撤回消息的标记集合（上下文注入前过滤用；标签 = 输入首行标记）。 */
  recalledTagsForSession(sessionId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT group_id, message_id FROM qq_inbox WHERE session_id = ? AND recalled = 1")
      .all(sessionId) as any[];
    return new Set(rows.map((r) => qqMessageTag(r.group_id as string, r.message_id as string)));
  }

  listInbox(opts: { groupId?: string; limit?: number } = {}): QqInboxRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const rows = (
      opts.groupId
        ? this.db.prepare("SELECT * FROM qq_inbox WHERE group_id = ? ORDER BY created_at DESC, dedup_key DESC LIMIT ?").all(opts.groupId, limit)
        : this.db.prepare("SELECT * FROM qq_inbox ORDER BY created_at DESC, dedup_key DESC LIMIT ?").all(limit)
    ) as any[];
    return rows.map(rowToInbox);
  }

  // ---------- 发送记录 ----------

  /** 发送前登记（固定目标 + 正文 + 本地操作 id）；pending 状态先于网络写入。 */
  createPendingOutbox(input: {
    taskId: string;
    account: string;
    groupId: string;
    replyToMessageId: string | null;
    text: string;
  }): QqOutboxRow {
    const now = new Date().toISOString();
    const row: QqOutboxRow = {
      opId: randomId("qqsend"),
      taskId: input.taskId,
      account: input.account,
      groupId: input.groupId,
      replyToMessageId: input.replyToMessageId,
      text: input.text,
      status: "pending",
      sentMessageId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO qq_outbox (op_id, task_id, account, group_id, reply_to_message_id, text, status, sent_message_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      )
      .run(row.opId, row.taskId, row.account, row.groupId, row.replyToMessageId, row.text, now, now);
    return row;
  }

  /**
   * 启动时核对遗留 pending 发送（崩溃窗口：已发送/未发送不可知）：
   * 一律定 unknown（effect_unknown，不自动重发），对应收件标记 reply_unknown。
   */
  reconcilePendingOutboxOnBoot(): number {
    const pending = this.listPendingOutbox();
    for (const row of pending) {
      if (this.settleOutbox(row.opId, "unknown", { error: "后台重启时发送结果未确认（effect_unknown）" })) {
        this.db
          .prepare("UPDATE qq_inbox SET status = 'reply_unknown' WHERE task_id = ? AND status = 'queued'")
          .run(row.taskId);
      }
    }
    return pending.length;
  }

  /** 终态落库（仅 pending 可转换；返回 false = 已被竞争路径定态）。 */
  settleOutbox(opId: string, to: "sent" | "failed" | "unknown" | "canceled", extra: { sentMessageId?: string | null; error?: string | null } = {}): boolean {
    const info = this.db
      .prepare("UPDATE qq_outbox SET status = ?, sent_message_id = ?, error = ?, updated_at = ? WHERE op_id = ? AND status = 'pending'")
      .run(to, extra.sentMessageId ?? null, extra.error ?? null, new Date().toISOString(), opId);
    return Number(info.changes) === 1;
  }

  /** 取消后平台才返回的迟到结果：如实补记说明（不改动已定态的 status）。 */
  noteLateOutcome(opId: string, note: string): void {
    this.db
      .prepare("UPDATE qq_outbox SET error = COALESCE(error, '') || ?, updated_at = ? WHERE op_id = ?")
      .run(note, new Date().toISOString(), opId);
  }

  listPendingOutbox(): QqOutboxRow[] {
    const rows = this.db.prepare("SELECT * FROM qq_outbox WHERE status = 'pending' ORDER BY created_at, op_id").all() as any[];
    return rows.map(rowToOutbox);
  }

  listOutbox(opts: { groupId?: string; limit?: number } = {}): QqOutboxRow[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const rows = (
      opts.groupId
        ? this.db.prepare("SELECT * FROM qq_outbox WHERE group_id = ? ORDER BY created_at DESC, op_id DESC LIMIT ?").all(opts.groupId, limit)
        : this.db.prepare("SELECT * FROM qq_outbox ORDER BY created_at DESC, op_id DESC LIMIT ?").all(limit)
    ) as any[];
    return rows.map(rowToOutbox);
  }
}

/** 任务输入首行的消息标记（撤回过滤与回复关联共用；格式变动需同步两处）。 */
export function qqMessageTag(groupId: string, messageId: string): string {
  return `[qq:${groupId}:${messageId}]`;
}

function rowToConfig(row: any): QqConfig {
  return {
    endpoint: row.endpoint,
    credentialName: row.credential_name,
    selfId: row.self_id,
    groups: JSON.parse(row.groups ?? "[]") as string[],
    enabled: Number(row.enabled) === 1,
    maxReplyChars: Number(row.max_reply_chars),
    queueTtlMs: Number(row.queue_ttl_ms),
    configVersion: Number(row.config_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToGroupSession(row: any): QqGroupSession {
  return {
    account: row.account,
    groupId: row.group_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    workDir: row.work_dir,
    createdAt: row.created_at,
  };
}

function rowToInbox(row: any): QqInboxRow {
  return {
    dedupKey: row.dedup_key,
    account: row.account,
    groupId: row.group_id,
    userId: row.user_id,
    senderName: row.sender_name,
    messageId: row.message_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    text: row.text,
    input: row.input,
    status: row.status as QqInboxStatus,
    recalled: Number(row.recalled) === 1,
    messageTime: row.message_time,
    createdAt: row.created_at,
  };
}

function rowToOutbox(row: any): QqOutboxRow {
  return {
    opId: row.op_id,
    taskId: row.task_id,
    account: row.account,
    groupId: row.group_id,
    replyToMessageId: row.reply_to_message_id,
    text: row.text,
    status: row.status as QqOutboxStatus,
    sentMessageId: row.sent_message_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
