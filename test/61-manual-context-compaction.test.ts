/** 手动规划以已完成历史为输入，摘要候选不触碰宿主任务与会话历史。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { checkpointFingerprint } from "@ruukoto/agent/compaction.ts";
import { generateManualCompaction, ManualCompactionError, type ManualCheckpointCandidate } from "@ruukoto/agent/manual-compaction.ts";
import { DEFAULT_BUDGET_CONFIG, planCompaction, planManualCompaction, selectContext, type SelectorBudgetConfig } from "@ruukoto/agent/context-selector.ts";
import type { ParsedSessionEntry } from "@ruukoto/core/history.ts";
import type { ContextCheckpoint } from "@ruukoto/core/types.ts";
import { startAssemblyKit } from "./helpers/testkit.ts";

const metadata = { api: "openai-completions" as const, provider: "mock", model: "mock-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const user = (text: string, timestamp = 1): UserMessage => ({ role: "user", content: text, timestamp });
const call = (id: string, name = "bash", timestamp = 2): AssistantMessage => ({ ...metadata, role: "assistant", content: [{ type: "toolCall", id, name, arguments: { command: id } }], stopReason: "toolUse", timestamp });
const result = (id: string, text: string, name = "bash", timestamp = 3): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp });
const reply = (text: string, timestamp = 4): AssistantMessage => ({ ...metadata, role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp });
const entries = (messages: object[]): ParsedSessionEntry[] => messages.map((message, index) => ({ type: "message", id: `entry_${index}`, message }));
const budget: SelectorBudgetConfig = { ...DEFAULT_BUDGET_CONFIG, contextWindow: 200_000, maxTokens: 1_000 };
const checkpoint = (candidate: ManualCheckpointCandidate): ContextCheckpoint => ({ ...candidate, sessionId: "session_1", status: "active", taskId: null, callIndex: null, createdAt: new Date().toISOString() });
const promptOf = (kit: Awaited<ReturnType<typeof startAssemblyKit>>) => JSON.stringify(kit.server.calls.at(-1)?.messages ?? []);

test("手动规划：低水位也摘要单个任务的较早批次与要求，不保底旧清单，最后配对批次整批保留", () => {
  const messages = [user("保留要求"), call("old-todo", "todo_write"), result("old-todo", "旧清单", "todo_write"), call("last"), result("last", "尾部原文"), user("尾部新文本")];
  const automatic = { messages, systemPrompt: "sys", tools: [], memories: [], budget, compaction: { sessionId: "session_1", checkpoint: null } };
  assert.equal(planCompaction(automatic, selectContext(automatic)), null);
  const plan = planManualCompaction({ messages, budget, sessionId: "session_1", checkpoint: null })!;
  assert.equal(plan.summarizedCount, 3);
  assert.equal(plan.clearedCount, 3);
  assert.deepEqual(plan.messages, messages.slice(0, 3));
  assert.deepEqual(messages.slice(plan.summarizedCount), [messages[3], messages[4], messages[5]]);
});

test("手动规划：旧孤儿批次只从摘要视图移出，不截掉后续正常对话；无完整回复不规划", () => {
  const messages = [user("旧要求"), call("orphan"), user("新要求"), reply("正常历史"), call("last"), result("last", "正常结果")];
  const plan = planManualCompaction({ messages, budget, sessionId: "session_1", checkpoint: null })!;
  assert.equal(plan.summarizedCount, 4);
  assert.deepEqual(plan.messages, [messages[0], messages[2], messages[3]]);
  assert.equal(planManualCompaction({ messages: [user("要求"), call("orphan")], budget, sessionId: "session_1", checkpoint: null }), null);
  assert.equal(planManualCompaction({ messages: [user("要求"), { ...reply("未完成"), stopReason: "aborted" }], budget, sessionId: "session_1", checkpoint: null }), null);
});

test("手动摘要：指引内部空白保留；重复无新增不调用，指引改写仅使用旧摘要，范围与历史原文不回退", async () => {
  const kit = await startAssemblyKit("manual-summary", { responder: () => ({ kind: "text", text: "中文结构化摘要".repeat(40) }) });
  try {
    const messages = [user("拥有者原始要求"), call("old"), result("old", "原始结果"), reply("最后回复")];
    const history = entries(messages);
    const original = JSON.stringify(history);
    const opts = { entries: history, sessionId: "session_1", checkpoint: null, checkpointId: "checkpoint_1", modelRuntime: kit.deps.modelRuntime, model: kit.model, signal: new AbortController().signal, budget };
    const completed = await generateManualCompaction({ ...opts, prompt: "  保留  迁移细节\n和错误原文  " });
    assert.equal(completed.kind, "completed");
    if (completed.kind !== "completed") return;
    const cp = checkpoint(completed.checkpoint);
    assert.equal(cp.summarizedCount, 3);
    assert.equal(cp.summaryModel, "mock/mock-model");
    assert.equal(cp.summaryStatus, "ok");
    assert.equal(cp.promptVersion, "compaction-v2");
    assert.ok(cp.estimateAfter > cp.estimateBefore, "手动压缩如实接受估算上升，不套用自动收益门槛");
    assert.ok(promptOf(kit).includes("保留  迁移细节\\n和错误原文"));
    assert.ok(promptOf(kit).includes("拥有者原始要求"));
    assert.ok(promptOf(kit).includes("区分拥有者原话"));
    assert.ok(promptOf(kit).includes("未完成工作"));
    assert.ok(!promptOf(kit).includes("最后回复"));
    assert.ok(!("reasoning_effort" in kit.server.calls[0].raw));
    const noop = await generateManualCompaction({ ...opts, checkpoint: cp, prompt: " \n " });
    assert.equal(noop.kind, "noop");
    assert.equal(kit.server.calls.length, 1);
    const rewritten = await generateManualCompaction({ ...opts, checkpoint: cp, checkpointId: "checkpoint_2", prompt: "关注迁移" });
    assert.equal(rewritten.kind, "completed");
    if (rewritten.kind === "completed") assert.equal(rewritten.checkpoint.summarizedCount, cp.summarizedCount);
    assert.ok(promptOf(kit).includes("<previous-summary>"));
    assert.ok(!promptOf(kit).includes("拥有者原始要求"));
    assert.equal(JSON.stringify(history), original);
    history.push(...entries([user("新增要求", 5), reply("新增最后回复", 6)]).map((entry, index) => ({ ...entry, id: `next_${index}` })));
    const progressed = await generateManualCompaction({ ...opts, checkpoint: cp, checkpointId: "checkpoint_3" });
    assert.equal(progressed.kind, "completed");
    if (progressed.kind === "completed") assert.equal(progressed.checkpoint.summarizedCount, 5);
    assert.ok(promptOf(kit).includes("最后回复") && promptOf(kit).includes("新增要求"));
    assert.ok(!promptOf(kit).includes("拥有者原始要求") && !promptOf(kit).includes("新增最后回复"));
    assert.equal(kit.store.getActiveCheckpoint("session_1"), null);
    assert.equal(kit.store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get()!.count, 0);
  } finally { await kit.close(); }
});

test("手动摘要：预算包含固定摘要规则与本次指引；超限和预先取消不调用模型", async () => {
  const kit = await startAssemblyKit("manual-budget");
  try {
    const opts = { entries: entries([user("旧要求"), reply("最后回复")]), sessionId: "session_1", checkpoint: null, checkpointId: "checkpoint_1", modelRuntime: kit.deps.modelRuntime, model: { ...kit.model, contextWindow: 8_200, maxTokens: 1_000 }, signal: new AbortController().signal, budget };
    await assert.rejects(generateManualCompaction({ ...opts, prompt: "指引".repeat(20_000) }), error => error instanceof ManualCompactionError && error.code === "summary_input_budget_exceeded");
    await assert.rejects(generateManualCompaction({ ...opts, model: { ...opts.model, contextWindow: 3_050 } }), error => error instanceof ManualCompactionError && error.code === "summary_input_budget_exceeded");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(generateManualCompaction({ ...opts, signal: controller.signal }), error => error instanceof ManualCompactionError && error.code === "summary_canceled");
    assert.equal(kit.server.calls.length, 0);
  } finally { await kit.close(); }
});

test("手动摘要：无效旧点明确失败；空输出、输出触顶和超时产生机器可判的错误", async () => {
  const kit = await startAssemblyKit("manual-failures", { responder: (_request, index) => index === 0 ? { kind: "text", text: "" } : index === 1 ? { kind: "text", text: "部分摘要", finishReason: "length" } : { kind: "text", text: "迟到摘要", chunkDelayMs: 200 } });
  try {
    const history = entries([user("旧要求"), reply("最后回复")]);
    const opts = { entries: history, sessionId: "session_1", checkpoint: null, checkpointId: "checkpoint_1", modelRuntime: kit.deps.modelRuntime, model: kit.model, signal: new AbortController().signal, budget };
    await assert.rejects(generateManualCompaction({ ...opts, entries: [{ type: "message", id: "bad", message: { role: "user", content: 42, timestamp: 1 } }] }), error => error instanceof ManualCompactionError && error.code === "history_corrupt");
    await assert.rejects(generateManualCompaction(opts), error => error instanceof ManualCompactionError && error.code === "summary_empty");
    await assert.rejects(generateManualCompaction(opts), error => error instanceof ManualCompactionError && error.code === "summary_output_limit");
    await assert.rejects(generateManualCompaction({ ...opts, timeoutMs: 30 }), error => error instanceof ManualCompactionError && error.code === "summary_timeout");
    const cp = checkpoint({ id: "old", summarizedCount: 1, clearedCount: 1, summary: "旧摘要", summaryUntil: null, clearedRefs: {}, fingerprint: checkpointFingerprint([], 0), clearedResults: 0, summaryModel: "mock/mock-model", summaryStatus: "ok", summaryError: null, promptVersion: "compaction-v1", usage: null, estimateBefore: 0, estimateAfter: 0 });
    await assert.rejects(generateManualCompaction({ ...opts, checkpoint: cp, prompt: "改写" }), error => error instanceof ManualCompactionError && error.code === "checkpoint_invalid");
    assert.equal(kit.server.calls.length, 3);
    assert.equal(cp.status, "active");
    assert.equal(cp.summary, "旧摘要");
  } finally { await kit.close(); }
});
