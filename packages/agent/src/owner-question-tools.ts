// Note: See .agents/notes/implemented/feature/2026-10-30-coding-owner-question-wait.md
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Store } from "@ruukoto/core/store.ts";
import { findOwnerQuestionByOp, OwnerQuestionError } from "@ruukoto/core/owner-questions.ts";
import { hostCallFor, type HostToolFamily } from "./host-tool-families.ts";

export const OWNER_QUESTION_TOOL_NAMES = ["ask_user"] as const;

export function createOwnerQuestionFamily(store: Store): HostToolFamily {
  return {
    category: "owner_question", names: OWNER_QUESTION_TOOL_NAMES,
    ledger: {
      names: OWNER_QUESTION_TOOL_NAMES, ruleFor: () => ({ family: "owner_question" }),
      familyCheck: {
        verify: op => findOwnerQuestionByOp(store, op.id) ? "committed" : "not_committed",
        committed: () => "问题已登记；这只核实登记，不证明回答已交给模型。停止当前任务并向拥有者说明交付未核实。",
        notCommitted: () => "问题未登记，没有等待中的新问题。向拥有者说明本次提问失败。",
      },
    },
    build: runtime => [defineTool({
      name: "ask_user", label: "ask_user", executionMode: "sequential",
      description: "向拥有者询问1–3题业务澄清，并等待回答或明确取消。每题可单选、多选或自由输入，拥有者可跳过并以空字符串作答；一个会话只能有一批待答问题。工具返回实际回答或取消事实；读到结果后再决定后续业务操作，需要时可再次提问。业务回答不批准工具操作。",
      parameters: Type.Object({ questions: Type.Array(Type.Object({
        question: Type.String({ minLength: 1, maxLength: 2000, description: "非空题目，最多2000字符。" }),
        options: Type.Optional(Type.Array(Type.Union([
          Type.String({ minLength: 1, maxLength: 200 }),
          Type.Object({
            label: Type.String({ minLength: 1, maxLength: 200, description: "非空选项名，最多200字符；同题选项名须互异。" }),
            description: Type.Optional(Type.String({ maxLength: 500, description: "选项名后展示的说明，最多500字符。" })),
            recommended: Type.Optional(Type.Boolean({ description: "显示推荐标记，不自动选中。" })),
          }, { additionalProperties: false }),
        ]), { minItems: 2, maxItems: 5, uniqueItems: true, description: "2–5个选项，选项名互异非空且最多200字符；用对象附说明和推荐标记，也可直接提供选项名。省略时自由输入，有选项时也允许自由输入。" })),
        multiple: Type.Optional(Type.Boolean({ description: "true为多选，须同时提供options；省略或false为单选。" })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }),
      execute: async (sdkCallId, params, signal) => {
        const call = hostCallFor(runtime.call.bindCall, runtime.call.taskContext, sdkCallId);
        try {
          if (!call.context || !runtime.ownerQuestions) throw new OwnerQuestionError("question_source_invalid", "当前提问来源不可用；结束本轮并向拥有者说明。");
          const question = runtime.ownerQuestions.create(call.context, params.questions);
          const settled = await runtime.ownerQuestions.wait(question.id, signal);
          const result = { questionId: settled.id, status: settled.status, questions: settled.questions,
            ...(settled.answers ? { answers: settled.answers } : {}),
            ...(settled.status === "canceled" ? { message: "拥有者取消了本批问题；没有提交答案。根据已有要求继续判断，必要时再次提问。" } : {}),
            ...(settled.status === "stale" || signal?.aborted ? { message: "提问任务已停止；已接受的回答保留，回答交付未核实。" } : {}) };
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
        } finally { call.release(); }
      },
    })],
  };
}
