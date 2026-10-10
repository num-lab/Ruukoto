/**
 * QQ 连接配置与群聊持久化（issue 07，NapCat OneBot v11）。私聊 owner 绑定
 * 进入 qq_config，私聊收发分别复用 inbound_events / notification_ops（issue 06）。
 * 核心群聊已退役（agent-direction issue 20）：qq_sessions/qq_inbox/qq_outbox
 * 不再新增，保留为只读归档（接收复核与撤回标记仍在）；正式外挂在后续阶段交付。
 *
 * - qq_config：单行连接配置（端点、凭据绑定名、预期登录账号、启停、历史群
 *   允许列表）；任何变化递增 config_version 并随事件提交；
 *   token 等秘密值只在 CredentialStore，本表只存绑定名。
 * - qq_sessions：登录账号+群 → 独立项目/会话/专用工作目录（旧归档，不同群隔离）。
 * - qq_inbox：旧收件登记（dedup_key = account:group:message_id；撤回标记仍更新）。
 * - qq_outbox：旧发送记录（unknown = effect_unknown）。
 */

import type { Db } from "@ruukoto/core/db.ts";

export const QQ_GROUP_SOURCE = "qq_group";

export interface QqConfig {
  /** OneBot 正向 WebSocket 端点（ws://host:port；生产默认回环/受控私网）。 */
  endpoint: string;
  /** 凭据绑定名（CredentialStore；null = 无 token 鉴权）。 */
  credentialName: string | null;
  /** 预期登录账号（QQ 号字符串）；事件 self_id 不一致时不接纳。 */
  selfId: string;
  /** 拥有者好友 QQ 号；null = 不接收私聊（群配置不隐含授权私聊）。 */
  ownerUserId: string | null;
  /** 允许触发的群号列表（全体成员可 @ 触发；空 = 不接纳任何群）。 */
  groups: string[];
  enabled: boolean;
  /** 单条回复字符上限（超过即缩短；默认值未经真实平台核实，部署时按实测调整）。 */
  maxReplyChars: number;
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
  recalledAt: string | null;
  replyToMessageId: string | null;
  configVersion: number | null;
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
    ownerUserId?: string | null;
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
        ownerUserId: input.ownerUserId !== undefined ? input.ownerUserId : existing.ownerUserId,
        maxReplyChars: input.maxReplyChars ?? existing.maxReplyChars,
        configVersion: existing.configVersion + 1,
        updatedAt: now,
      };
      this.db
        .prepare("UPDATE qq_config SET endpoint = ?, credential_name = ?, self_id = ?, owner_user_id = ?, max_reply_chars = ?, config_version = ?, updated_at = ? WHERE id = 1")
        .run(next.endpoint, next.credentialName, next.selfId, next.ownerUserId, next.maxReplyChars, next.configVersion, now);
      return next;
    }
    const config: QqConfig = {
      endpoint: input.endpoint,
      credentialName: input.credentialName ?? null,
      selfId: input.selfId,
      ownerUserId: input.ownerUserId ?? null,
      groups: [],
      enabled: false,
      maxReplyChars: input.maxReplyChars ?? 1500,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO qq_config (id, endpoint, credential_name, self_id, owner_user_id, groups, enabled, max_reply_chars, config_version, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, '[]', 0, ?, 1, ?, ?)`,
      )
      .run(config.endpoint, config.credentialName, config.selfId, config.ownerUserId, config.maxReplyChars, now, now);
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

  /**
   * 凭据变化/删除触发的代次推进（agent-direction issue 08）：不改配置字段，
   * 只单调递增版本——旧连接、旧消息与旧批准全部失效，A → B → A 轮换也
   * 不会恢复旧代次。返回 null = 未配置。
   */
  bumpConfigVersion(): QqConfig | null {
    const existing = this.getConfig();
    if (!existing) return null;
    const next = { ...existing, configVersion: existing.configVersion + 1, updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE qq_config SET config_version = ?, updated_at = ? WHERE id = 1").run(next.configVersion, next.updatedAt);
    return next;
  }

  // ---------- 群会话映射 ----------

  getGroupSession(account: string, groupId: string): QqGroupSession | null {
    const row = this.db
      .prepare("SELECT * FROM qq_sessions WHERE account = ? AND group_id = ?")
      .get(account, groupId) as any;
    return row ? rowToGroupSession(row) : null;
  }

  listGroupSessions(): QqGroupSession[] {
    const rows = this.db.prepare("SELECT * FROM qq_sessions ORDER BY created_at, group_id").all() as any[];
    return rows.map(rowToGroupSession);
  }

  // ---------- 收件（只读归档） ----------

  getInbox(dedupKey: string): QqInboxRow | null {
    const row = this.db.prepare("SELECT * FROM qq_inbox WHERE dedup_key = ?").get(dedupKey) as any;
    return row ? rowToInbox(row) : null;
  }

  getInboxByTask(taskId: string): QqInboxRow | null {
    const row = this.db.prepare("SELECT * FROM qq_inbox WHERE task_id = ?").get(taskId) as any;
    return row ? rowToInbox(row) : null;
  }

  setInboxStatus(dedupKey: string, status: QqInboxStatus): void {
    this.db.prepare("UPDATE qq_inbox SET status = ? WHERE dedup_key = ?").run(status, dedupKey);
  }

  /** 启动接管旧版已排队任务，以及登记后尚未创建持久入站事件的窗口。 */
  listPendingInbox(): QqInboxRow[] {
    return (this.db.prepare("SELECT * FROM qq_inbox WHERE status IN ('registered','queued') ORDER BY created_at, rowid").all() as any[]).map(rowToInbox);
  }

  isInboxRecalled(row: QqInboxRow): boolean {
    if (row.recalled) return true;
    if (row.replyToMessageId) return this.getInbox(qqDedupKey(row.account, row.groupId, row.replyToMessageId))?.recalled === true;
    // 旧引用未存消息 ID，不能猜测来源；该群发生撤回后保守排除旧引用交互。
    return row.configVersion === null && row.input.includes("\n> 引用 ") &&
      this.db.prepare("SELECT 1 FROM qq_inbox WHERE account = ? AND group_id = ? AND recalled = 1 LIMIT 1").get(row.account, row.groupId) !== undefined;
  }

  /** 撤回标记（条件更新；重复撤回返回 false）。 */
  markRecalled(account: string, groupId: string, messageId: string): QqInboxRow | null {
    const info = this.db
      .prepare("UPDATE qq_inbox SET recalled = 1, recalled_at = ? WHERE dedup_key = ? AND recalled = 0")
      .run(new Date().toISOString(), qqDedupKey(account, groupId, messageId));
    if (Number(info.changes) !== 1) return null;
    return this.getInbox(qqDedupKey(account, groupId, messageId));
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

  getOutboxByTask(taskId: string): QqOutboxRow | null {
    const row = this.db.prepare("SELECT * FROM qq_outbox WHERE task_id = ? ORDER BY created_at, op_id LIMIT 1").get(taskId) as any;
    return row ? rowToOutbox(row) : null;
  }

  /** 终态落库（仅 pending 可转换；返回 false = 已被竞争路径定态）。 */
  settleOutbox(opId: string, to: "sent" | "failed" | "unknown" | "canceled", extra: { sentMessageId?: string | null; error?: string | null } = {}): boolean {
    const info = this.db
      .prepare("UPDATE qq_outbox SET status = ?, sent_message_id = ?, error = ?, updated_at = ? WHERE op_id = ? AND status = 'pending'")
      .run(to, extra.sentMessageId ?? null, extra.error ?? null, new Date().toISOString(), opId);
    return Number(info.changes) === 1;
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

function rowToConfig(row: any): QqConfig {
  return {
    endpoint: row.endpoint,
    credentialName: row.credential_name,
    selfId: row.self_id,
    ownerUserId: row.owner_user_id ?? null,
    groups: JSON.parse(row.groups ?? "[]") as string[],
    enabled: Number(row.enabled) === 1,
    maxReplyChars: Number(row.max_reply_chars),
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
    recalledAt: row.recalled_at ?? null,
    replyToMessageId: row.reply_to_message_id ?? null,
    configVersion: row.config_version ?? null,
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
