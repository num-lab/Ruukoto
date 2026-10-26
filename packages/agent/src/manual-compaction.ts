/** 手动压缩只生成候选；会话占用、历史核实与原子提交归 Runtime。
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-manual-context-compaction.md
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ParsedSessionEntry } from "@ruukoto/core/history.ts";
import type { ContextCheckpoint } from "@ruukoto/core/types.ts";
import { checkpointFingerprint, COMPACTION_PROMPT_VERSION, generateRollingSummary, type SummaryFailureCode } from "./compaction.ts";
import {
  DEFAULT_BUDGET_CONFIG, estimateCompletedHistory, isClearableToolResult, planManualCompaction,
  type CheckpointInput, type HistoryViewBudget, type ManualCompactionPlan,
} from "./context-selector.ts";

export class ManualCompactionError extends Error {
  constructor(readonly code: SummaryFailureCode | "checkpoint_invalid" | "history_corrupt", message: string) { super(message); }
}

export interface ManualCheckpointCandidate extends CheckpointInput {
  fingerprint: string;
  clearedResults: number;
  summaryModel: string;
  summaryStatus: "ok";
  summaryError: null;
  promptVersion: string;
  usage: Record<string, unknown> | null;
  estimateBefore: number;
  estimateAfter: number;
}

export type ManualCompactionResult =
  | { kind: "noop"; estimateBefore: number; reason: string }
  | { kind: "completed"; checkpoint: ManualCheckpointCandidate };

/** 压缩序号与上下文装配一致；SDK 系统提示与工具登记不计入对话消息。 */
function historyMessages(entries: ParsedSessionEntry[]): AgentMessage[] {
  return entries.filter(entry => entry.type === "message" && (entry.message as { role?: unknown } | undefined)?.role !== "system").map(entry => {
    // 严格历史读取与 SDK 消息之间的 JSON 边界。
    const message = entry.message as Record<string, unknown> | null | undefined;
    const role = message?.role;
    const content = message?.content;
    const validParts = Array.isArray(content) && content.every((part: unknown) => {
      if (!part || typeof part !== "object") return false;
      const block = part as Record<string, unknown>;
      if (block.type === "text") return typeof block.text === "string";
      if (block.type === "thinking") return role === "assistant" && typeof block.thinking === "string";
      if (block.type === "image") return role !== "assistant" && typeof block.data === "string" && typeof block.mimeType === "string";
      return block.type === "toolCall" && role === "assistant" && typeof block.id === "string" &&
        typeof block.name === "string" && !!block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments);
    });
    const validContent = role === "user" || role === "custom" ? typeof content === "string" || validParts :
      role === "assistant" ? validParts && ["stop", "length", "toolUse", "error", "aborted", "pending", "deferred"].includes(String(message?.stopReason)) :
      role === "toolResult" ? validParts && typeof message?.toolCallId === "string" && typeof message.toolName === "string" && typeof message.isError === "boolean" :
      role === "bashExecution" ? typeof message?.command === "string" && typeof message.output === "string" :
      role === "branchSummary" || role === "compactionSummary" ? typeof message?.summary === "string" : false;
    if (!message || !validContent || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) ||
        Number.isNaN(new Date(message.timestamp).getTime())) {
      throw new ManualCompactionError("history_corrupt", "历史消息内容或时间戳无法核实，请先修复历史");
    }
    return message as unknown as AgentMessage;
  });
}

/** 核实已完成历史并规划压缩；不解析模型或调用摘要，不读写历史与存储。
 * 估算仅含完成历史的模型视图与压缩摘要，不包含下一任务的参考块、工具定义与输入。
 * 历史损坏或原点无效时抛带 code 的错误，由调用方决定作废与持久报告。
 */
export function inspectManualCompaction(opts: {
  entries: ParsedSessionEntry[];
  sessionId: string;
  checkpoint: ContextCheckpoint | null;
  prompt?: string;
  budget: HistoryViewBudget;
}): { messages: AgentMessage[]; plan: ManualCompactionPlan | null; estimateBefore: number } {
  const messages = historyMessages(opts.entries);
  const previous = opts.checkpoint;
  const entryIds = new Set(opts.entries.map(entry => entry.id));
  if (previous && (!Number.isSafeInteger(previous.summarizedCount) || !Number.isSafeInteger(previous.clearedCount) ||
      previous.summarizedCount < 0 || previous.summarizedCount > previous.clearedCount || previous.clearedCount > messages.length ||
      (previous.summarizedCount > 0 && !previous.summary?.trim()) ||
      Object.values(previous.clearedRefs).some(id => id !== null && !entryIds.has(id)) ||
      checkpointFingerprint(messages, previous.clearedCount) !== previous.fingerprint)) {
    throw new ManualCompactionError("checkpoint_invalid", "原压缩点与历史不一致，已无法使用；请核实历史后再重试");
  }
  const prompt = opts.prompt?.trim();
  const plan = planManualCompaction({ messages, checkpoint: previous, sessionId: opts.sessionId, budget: opts.budget, prompt });
  return { messages, plan, estimateBefore: plan?.estimateBefore ?? estimateCompletedHistory(messages, opts.budget, opts.sessionId, previous) };
}

/** 摘要候选只生成、不提交，不创建任务、Driver 或工具 worker；失败时抛带 code 的错误，不应用清理或改写旧点。 */
export async function generateManualCompaction(opts: {
  entries: ParsedSessionEntry[];
  sessionId: string;
  checkpoint: ContextCheckpoint | null;
  checkpointId: string;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  signal: AbortSignal;
  prompt?: string;
  budget?: HistoryViewBudget;
  timeoutMs?: number;
}): Promise<ManualCompactionResult> {
  const previous = opts.checkpoint;
  const budget = opts.budget ?? DEFAULT_BUDGET_CONFIG;
  const { messages, plan, estimateBefore } = inspectManualCompaction({ ...opts, budget });
  if (!plan) return { kind: "noop", estimateBefore,
    reason: previous?.summary ? "没有新的可压缩内容" : "暂无可压缩内容" };
  const outcome = await generateRollingSummary({ modelRuntime: opts.modelRuntime, model: opts.model, messages: plan.messages,
    previousSummary: previous?.summary ?? null, signal: opts.signal, prompt: opts.prompt, manual: true, timeoutMs: opts.timeoutMs });
  if (!outcome.ok) throw new ManualCompactionError(outcome.code ?? "summary_failed", outcome.error);
  const clearedRefs: Record<string, string | null> = {};
  for (let index = plan.summarizedCount; index < plan.clearedCount; index++) {
    const message = messages[index];
    if (message.role === "toolResult" && isClearableToolResult(message)) clearedRefs[message.toolCallId] = previous?.clearedRefs[message.toolCallId] ?? null;
  }
  const until = messages[plan.summarizedCount - 1]?.timestamp;
  const checkpoint: ManualCheckpointCandidate = {
    id: opts.checkpointId, summarizedCount: plan.summarizedCount, clearedCount: plan.clearedCount,
    summary: outcome.text, summaryUntil: typeof until === "number" ? new Date(until).toISOString() : previous?.summaryUntil ?? null,
    clearedRefs, fingerprint: checkpointFingerprint(messages, plan.clearedCount), clearedResults: Object.keys(clearedRefs).length,
    summaryModel: `${opts.model.provider}/${opts.model.id}`, summaryStatus: "ok", summaryError: null,
    promptVersion: COMPACTION_PROMPT_VERSION, usage: outcome.usage, estimateBefore: plan.estimateBefore,
    estimateAfter: 0,
  };
  checkpoint.estimateAfter = estimateCompletedHistory(messages, budget, opts.sessionId, checkpoint);
  return { kind: "completed", checkpoint };
}
