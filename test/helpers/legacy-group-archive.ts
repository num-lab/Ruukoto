/**
 * 旧群资料播种助手（agent-direction issue 20）：按核心群聊退役前（核心库 v24）
 * 的持久形态直接把归档数据写入 store——项目、qq_group 会话、qq_sessions 映射、
 * 收件登记、qq_group 入站事件、chat 任务与结果、main 接收账本、待发送回复。
 * 不经过已删除的运行路径（群收件/派发/回复）；测试据此验证归档保全、只读
 * 边界、接收复核与启动收尾。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "../../src/core/store.ts";
import { QQ_GROUP_SOURCE, qqDedupKey, type QqInboxRow, type QqOutboxRow, type QqStore } from "../../src/qq/store.ts";
import type { AcceptedChatResult, InboundEvent, ModelSelection, Task } from "../../src/core/types.ts";
import { randomId, type Session } from "../../src/core/types.ts";

// ---------- 旧群写入（QqStore 群写方法已随 issue 23 删除；只供播种旧归档） ----------

export function seedGroupSessionRow(store: Store, row: { account: string; groupId: string; sessionId: string; projectId: string; workDir: string }): void {
  store.db
    .prepare("INSERT INTO qq_sessions (account, group_id, session_id, project_id, work_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.account, row.groupId, row.sessionId, row.projectId, row.workDir, new Date().toISOString());
}

/** 旧收件登记（幂等：同键已存在返回原行）。 */
export function seedInboxRow(store: Store, qq: QqStore, input: {
  account: string; groupId: string; userId: string; senderName: string; messageId: string;
  text: string; taskInput: string; messageTime: string | null; replyToMessageId?: string | null; configVersion?: number | null;
}): { created: boolean; row: QqInboxRow } {
  const dedupKey = qqDedupKey(input.account, input.groupId, input.messageId);
  const existing = qq.getInbox(dedupKey);
  if (existing) return { created: false, row: existing };
  store.db
    .prepare(
      `INSERT INTO qq_inbox (dedup_key, account, group_id, user_id, sender_name, message_id,
       request_id, session_id, task_id, text, input, status, recalled, message_time, created_at, reply_to_message_id, config_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'registered', 0, ?, ?, ?, ?)`,
    )
    .run(dedupKey, input.account, input.groupId, input.userId, input.senderName, input.messageId, `qq:${dedupKey}`, input.text,
      input.taskInput, input.messageTime, new Date().toISOString(), input.replyToMessageId ?? null, input.configVersion ?? null);
  return { created: true, row: qq.getInbox(dedupKey)! };
}

export function seedLinkInboxTask(store: Store, dedupKey: string, sessionId: string, taskId: string): void {
  store.db
    .prepare("UPDATE qq_inbox SET session_id = ?, task_id = ?, status = CASE WHEN status = 'registered' THEN 'queued' ELSE status END WHERE dedup_key = ?")
    .run(sessionId, taskId, dedupKey);
}

export function seedPendingOutbox(store: Store, qq: QqStore, input: { taskId: string; account: string; groupId: string; replyToMessageId: string | null; text: string }): QqOutboxRow {
  const opId = randomId("qqsend");
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO qq_outbox (op_id, task_id, account, group_id, reply_to_message_id, text, status, sent_message_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    )
    .run(opId, input.taskId, input.account, input.groupId, input.replyToMessageId, input.text, now, now);
  return qq.listPendingOutbox().find((o) => o.opId === opId)!;
}

const DEFAULT_SELECTION: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const at = (seconds: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + seconds * 1000).toISOString();

export interface LegacyGroupArchive {
  store: Store;
  qq: QqStore;
  /** 旧安装的 chat 角色行（归档标识）：独立 agent-chat 项目与 dev 类别会话。 */
  seedChatRole(): { projectId: string; sessionId: string };
  /** 一个旧群：qq-<account>-<group> 项目 + qq_group 会话 + qq_sessions 映射。 */
  seedGroup(opts: { account?: string; groupId: string }): LegacyGroup;
}

export interface LegacyGroup {
  account: string;
  groupId: string;
  projectId: string;
  session: Session;
  workDir: string;
  /**
   * 按状态种子一条群消息的旧形态：
   * - inboxOnly：仅收件 registered（登记后崩溃窗口），无事件与任务；
   * - eventRegistered：收件 + 已登记未派发的 qq_group 入站事件；
   * - queued：事件与排队 chat 任务关联完成（收件 queued）；
   * - running：任务已转 running（升级时由 recover() 定 interrupted）；
   * - completed：任务完成且结果已记录，事件 done、收件 done（归档主体）。
   */
  seedTask(opts: {
    userId?: string;
    messageId: string;
    text?: string;
    state: "inboxOnly" | "eventRegistered" | "queued" | "running" | "completed";
    summary?: string;
    senderName?: string;
    time?: number;
    /** 撤回标记（含 recalled_at，模拟旧形态已完成撤回）。 */
    recalled?: boolean;
  }): { inbox: QqInboxRow; event: InboundEvent | null; task: Task | null };
  /** 该群某任务的一条遗留 pending 发送（发送后崩溃窗口）。 */
  seedPendingReply(opts: { taskId: string; messageId: string; text?: string }): QqOutboxRow;
}

/** main 的接收账本行（归档接收事实；acceptedByTaskId 由调用方给定，通常为某个 main 任务）。 */
export function seedAcceptedResult(
  store: Store,
  input: { mainProjectId: string; acceptedByTaskId: string; taskId: string; reason?: string; summary: string },
): AcceptedChatResult {
  return store.acceptChatResult({
    taskId: input.taskId,
    mainProjectId: input.mainProjectId,
    acceptedByTaskId: input.acceptedByTaskId,
    acceptedByOpId: randomId("op"),
    reason: input.reason ?? "整理群讨论结果",
    summary: input.summary,
  });
}

export function legacyGroupArchive(deps: { store: Store; qq: QqStore; workRoot: string; modelSelection?: ModelSelection }): LegacyGroupArchive {
  const { store, qq, workRoot } = deps;
  const modelSelection = deps.modelSelection ?? DEFAULT_SELECTION;

  const seedChatRole = (): { projectId: string; sessionId: string } => {
    const project = store.createProject("agent-chat");
    const workDir = path.join(workRoot, "agent-work", "chat");
    fs.mkdirSync(workDir, { recursive: true });
    const stat = fs.statSync(workDir);
    const session = store.createSession({
      projectId: project.id, kind: "dev", cwd: workDir, cwdReal: fs.realpathSync(workDir),
      cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: randomId("pi"), confirmTools: [], modelSelection,
    });
    store.insertAgentRole({ id: "chat", projectId: project.id, sessionId: session.id, workDir, modelSelection, tools: [], createdAt: session.createdAt });
    return { projectId: project.id, sessionId: session.id };
  };

  const seedGroup = (opts: { account?: string; groupId: string }): LegacyGroup => {
    const account = opts.account ?? "990001";
    const project = store.createProject(`qq-${account}-${opts.groupId}`);
    const workDir = path.join(workRoot, "qq-work", `${account}_${opts.groupId}`);
    fs.mkdirSync(workDir, { recursive: true });
    const stat = fs.statSync(workDir);
    const session = store.createSession({
      projectId: project.id, kind: "qq_group", cwd: workDir, cwdReal: fs.realpathSync(workDir),
      cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: randomId("pi"), confirmTools: [], modelSelection,
    });
    seedGroupSessionRow(store, { account, groupId: opts.groupId, sessionId: session.id, projectId: project.id, workDir });
    let seq = 0;

    const group: LegacyGroup = {
      account,
      groupId: opts.groupId,
      projectId: project.id,
      session,
      workDir,
      seedTask(topts) {
        const userId = topts.userId ?? "880001";
        const senderName = topts.senderName ?? `user-${userId}`;
        const text = topts.text ?? `群消息-${topts.messageId}`;
        const time = topts.time ?? ++seq;
        const { row } = seedInboxRow(store, qq, {
          account, groupId: opts.groupId, userId, senderName,
          messageId: topts.messageId, text, taskInput: `[qq:${opts.groupId}:${topts.messageId}] ${senderName}(${userId}): ${text}`,
          messageTime: at(time),
        });
        store.db.prepare("UPDATE qq_inbox SET created_at = ? WHERE dedup_key = ?").run(at(time), row.dedupKey);
        if (topts.recalled) {
          qq.markRecalled(account, opts.groupId, topts.messageId);
          store.db.prepare("UPDATE qq_inbox SET recalled_at = ? WHERE dedup_key = ?").run(at(time + 1), row.dedupKey);
        }
        if (topts.state === "inboxOnly") return { inbox: qq.getInbox(row.dedupKey)!, event: null, task: null };
        // 旧流程先入站绑定会话再登记事件（收件保持 registered，linkInboxTask 才转 queued）
        store.db.prepare("UPDATE qq_inbox SET session_id = ? WHERE dedup_key = ? AND session_id IS NULL").run(group.session.id, row.dedupKey);
        const { event } = store.registerInboundEvent({
          source: QQ_GROUP_SOURCE, externalId: row.dedupKey, actor: userId, targetRole: "chat", body: row.input,
          replyTarget: { channel: QQ_GROUP_SOURCE, account, chatId: opts.groupId, configVersion: 1 },
        });
        if (topts.state === "eventRegistered") return { inbox: qq.getInbox(row.dedupKey)!, event, task: null };
        const { task } = store.insertQueuedTask({
          sessionId: group.session.id, requestId: row.requestId, input: row.input, modelSelection,
          submissionDigest: row.dedupKey, agentId: "chat", sourceEventId: event.id, accessMode: "confirm",
        });
        seedLinkInboxTask(store, row.dedupKey, group.session.id, task.id);
        store.markInboundQueued(event.id, task.id);
        if (topts.state === "running" || topts.state === "completed") {
          store.transitionTask(task.id, ["queued"], "running", { startedAt: at(time + 1) });
        }
        if (topts.state === "completed") {
          store.transitionTask(task.id, ["running"], "completed", { endedAt: at(time + 2) });
          store.setTaskResult(task.id, topts.summary ?? `群结果摘要-${topts.messageId}`, JSON.stringify({ taskId: task.id, sessionId: group.session.id }));
          store.setInboundTerminal(event.id, "done");
          qq.setInboxStatus(row.dedupKey, "done");
        }
        return { inbox: qq.getInbox(row.dedupKey)!, event, task: store.getTask(task.id)! };
      },
      seedPendingReply(popts) {
        return seedPendingOutbox(store, qq, {
          taskId: popts.taskId, account, groupId: opts.groupId,
          replyToMessageId: popts.messageId, text: popts.text ?? "未确认是否送达的群回复",
        });
      },
    };
    return group;
  };

  return { store, qq, seedChatRole, seedGroup };
}
