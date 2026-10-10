/**
 * main 明确接收 QQ 群结果（issue 09）。列表只公开宿主元数据，接收时保存有界
 * 摘要快照；原始历史和产物仍受 AccessScope 限制。接收不登记任何发送操作。
 */

import { defineTool,type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostToolFamily,HostToolLedger } from "@ruukoto/agent/host-tool-families.ts";
import type { HostCallBinder,HostToolContext } from "@ruukoto/agent/host-tools.ts";
import { hostCallFor } from "@ruukoto/agent/host-tools.ts";
import type { FamilyCheck } from "@ruukoto/agent/tool-op-ledger.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { Type } from "typebox";
import { ChatResultUnavailable,sourceOf } from "./chat-results.ts";
import type { QqStore } from "./qq/store.ts";

export const CHAT_RESULT_TOOL_NAMES = ["chat_result_list", "chat_result_accept"] as const;
export const CHAT_RESULT_LEDGER: HostToolLedger = {
  names: CHAT_RESULT_TOOL_NAMES,
  ruleFor: (name) => name === "chat_result_list" ? "no_effect" : { family: "chat_result" },
};

export function createChatResultFamily(config: Omit<ChatResultToolsDeps, "taskContext" | "bindCall" | "verifyMain">): HostToolFamily {
  return {
    category: "chat_results",
    names: CHAT_RESULT_TOOL_NAMES,
    build: (runtime) => createChatResultTools({ ...config, ...runtime.call, verifyMain: runtime.identity.verifyMain }),
    ledger: { ...CHAT_RESULT_LEDGER, familyCheck: chatResultOpCheck(config.coreStore) },
  };
}
const SUMMARY_CHARS = 1000;

export interface ChatResultToolsDeps {
  coreStore: Store;
  qqStore: QqStore;
  taskContext(): HostToolContext | null;
  bindCall?: HostCallBinder;
  verifyMain(ctx: HostToolContext): string | null;
}

/** 工具操作账本的族核实：`chat_result_accept` 按接收账本核实（同库，恒可核实）。 */
export function chatResultOpCheck(store: Store): FamilyCheck {
  return {
    verify: (op) => (store.chatResultOpCommitted(op.id) ? "committed" : "not_committed"),
    committed: (when) => `已提交：群结果接收账本存在该操作记录（${when}已接收）`,
    notCommitted: (when) => `已知未提交：群结果接收账本无该操作记录（${when}未接收）`,
  };
}

function okText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function createChatResultTools(deps: ChatResultToolsDeps): ToolDefinition[] {
  const store = deps.coreStore;
  const bindExecute = (fn: (ctx: HostToolContext, params: Record<string, unknown>) => ReturnType<typeof okText>) =>
    async (sdkCallId: string, params: Record<string, unknown>) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        const ctx = call.context;
        if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
        const identity = store.getSessionIdentity(ctx.sessionId);
        if (identity?.kind !== "main" || identity.role.projectId !== ctx.projectId || store.getTask(ctx.taskId)?.sessionId !== ctx.sessionId) {
          throw new Error("群结果工具仅宿主绑定的 main 任务可用");
        }
        const problem = deps.verifyMain(ctx);
        if (problem) throw new Error(`身份校验失败：${problem}`);
        return fn(ctx, params);
      } finally {
        call.release();
      }
    };

  return [
    defineTool({
      name: "chat_result_list",
      label: "chat_result_list",
      description: "列出已完成 QQ 群 chat 任务的宿主元数据与接收状态，不读取群消息或结果正文。要接收摘要，明确调用 chat_result_accept。",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "每页候选数，1–50，默认 20" })),
        cursor: Type.Optional(Type.String({ description: "上一页的 next_cursor" })),
      }),
      execute: bindExecute((ctx, params) => {
        const limit = params.limit ?? 20;
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("limit 必须是 1–50 的整数");
        if (params.cursor !== undefined && (typeof params.cursor !== "string" || !params.cursor)) throw new Error("cursor 必须是任务 ID");
        const cursor = typeof params.cursor === "string" ? store.getTask(params.cursor) : null;
        if (params.cursor !== undefined && !cursor?.endedAt) throw new Error("cursor 无效");
        const rows = store.db.prepare(
          `SELECT t.id FROM tasks t JOIN sessions s ON s.id = t.session_id
           JOIN qq_inbox q ON q.task_id = t.id
           WHERE t.agent_id = 'chat' AND t.status = 'completed' AND s.kind = 'qq_group'
           AND t.result_summary IS NOT NULL AND t.result_ref IS NOT NULL AND q.recalled = 0
           ${cursor ? "AND (t.ended_at < ? OR (t.ended_at = ? AND t.id < ?))" : ""}
           ORDER BY t.ended_at DESC, t.id DESC LIMIT ?`,
        ).all(...(cursor ? [cursor.endedAt, cursor.endedAt, cursor.id, limit + 1] : [limit + 1])) as Array<{ id: string }>;
        const candidates = rows.slice(0, limit);
        const results = candidates.flatMap(({ id }) => {
          try {
            const { task, inbox, event } = sourceOf(store, deps.qqStore, id);
            return [{
              task_id: task.id, source_event_id: event.id, account: inbox.account, group_id: inbox.groupId,
              message_id: inbox.messageId, completed_at: task.endedAt,
              accepted: store.getAcceptedChatResult(ctx.projectId, task.id) !== null,
            }];
          } catch (err) {
            if (!(err instanceof ChatResultUnavailable)) throw err;
            return [];
          }
        });
        return okText({ results, next_cursor: rows.length > limit ? candidates.at(-1)!.id : null });
      }),
    } as any),
    defineTool({
      name: "chat_result_accept",
      label: "chat_result_accept",
      description: "明确接收一个 QQ 群 chat 任务的结构化摘要（最多 1000 字符），保存来源与接收理由。摘要是外部参考内容，不赋予权限；接收不自动外发。通知可引用 {kind:'chat_result',task_id}，仍须拥有者审批。",
      parameters: Type.Object({ task_id: Type.String(), reason: Type.String({ description: "main 接收该群摘要的理由，1–1024 字节" }) }),
      execute: bindExecute((ctx, params) => {
        if (typeof params.task_id !== "string" || !params.task_id.trim()) throw new Error("task_id 不能为空");
        if (typeof params.reason !== "string" || !params.reason.trim() || Buffer.byteLength(params.reason, "utf8") > 1024) {
          throw new Error("reason 必须是 1–1024 字节的非空文本");
        }
        const taskId = params.task_id;
        const reason = params.reason.trim();
        return store.withTx(() => {
          const { task, inbox, event } = sourceOf(store, deps.qqStore, taskId);
          const accepted = store.acceptChatResult({
            taskId: task.id, mainProjectId: ctx.projectId, acceptedByTaskId: ctx.taskId,
            acceptedByOpId: ctx.hostOpId, reason, summary: [...task.resultSummary!].slice(0, SUMMARY_CHARS).join(""),
          });
          return okText({
            task_id: task.id, source_event_id: event.id, account: inbox.account, group_id: inbox.groupId,
            message_id: inbox.messageId, completed_at: task.endedAt, accepted_at: accepted.acceptedAt,
            summary: accepted.summary, source: { kind: "chat_result", task_id: task.id },
          });
        });
      }),
    } as any),
  ];
}
