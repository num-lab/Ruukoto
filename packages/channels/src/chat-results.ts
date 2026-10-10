import type { Store } from "@ruukoto/core/store.ts";
import type { AcceptedChatResult } from "@ruukoto/core/types.ts";
import type { QqStore } from "./qq/store.ts";

export class ChatResultUnavailable extends Error {}

/** 只接收宿主已关联且完成的群任务；正文、角色名或跨项目授权不能替代该关联。 */
export function sourceOf(store: Store, qq: QqStore, taskId: string) {
  const task = store.getTask(taskId);
  if (!task || task.agentId !== "chat" || task.status !== "completed" || task.resultSummary === null ||
      task.resultRef === null || !task.startedAt || !task.endedAt || !task.sourceEventId) {
    throw new ChatResultUnavailable("只能接收已完成且已记录结果的 QQ 群 chat 任务");
  }
  const session = store.getSession(task.sessionId);
  const inbox = qq.getInboxByTask(task.id);
  const event = store.getInboundEvent(task.sourceEventId);
  const group = inbox ? qq.getGroupSession(inbox.account, inbox.groupId) : null;
  if (!session || session.kind !== "qq_group" || !inbox || inbox.sessionId !== session.id ||
      !group || group.sessionId !== session.id || group.projectId !== session.projectId ||
      !event || event.source !== "qq_group" || event.targetRole !== "chat" || event.taskId !== task.id ||
      event.status !== "done" || event.externalId !== inbox.dedupKey || event.actor !== inbox.userId) {
    throw new ChatResultUnavailable("群任务的入站事件、收件与会话映射不匹配");
  }
  // ponytail: 按同群时间窗保守失效；若误拒影响使用，再保存模型实际读取的消息 ID。
  const recalled = store.db.prepare(
    `SELECT 1 FROM qq_inbox WHERE account = ? AND group_id = ? AND recalled = 1
     AND created_at <= ? AND (recalled_at IS NULL OR recalled_at >= ?) LIMIT 1`,
  ).get(inbox.account, inbox.groupId, task.endedAt, task.startedAt);
  if (inbox.recalled || recalled) throw new ChatResultUnavailable("群结果可能包含已撤回消息，不能接收或继续外发");
  return { task, inbox, event };
}

/** 已接收快照供通知引用；每次解析、查询与发送仍复核撤回及宿主来源。 */
export function resolveAcceptedChatResult(store: Store, qq: QqStore, mainProjectId: string, taskId: string): AcceptedChatResult {
  if (store.getAgentRole("main")?.projectId !== mainProjectId) throw new Error("群结果快照仅 main 可读取");
  const accepted = store.getAcceptedChatResult(mainProjectId, taskId);
  if (!accepted) throw new Error("群结果尚未经 main 明确接收");
  sourceOf(store, qq, taskId);
  return accepted;
}
