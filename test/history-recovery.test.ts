import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { PersistentEvent, Session } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { HistoryRecovery, HistoryRecoveryError } from "@ruukoto/view/history-recovery.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";

const at = "2026-10-23T00:00:00Z";
const entry = (id: string, text: string, extra: Partial<HistoryEntryView> = {}): HistoryEntryView => ({
  entryId: id, taskId: "task", inputPurpose: "user", parentId: null, role: "assistant", text, timestamp: at,
  offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: null,
  toolName: null, isError: null, hasNonTextContent: false, ...extra,
});
const task: TaskView = {
  id: "task", sessionId: "session", requestId: "request", input: "问题", inputPurpose: "user", modelSelection: null,
  submissionDigest: null, status: "completed", accessMode: "confirm", planMode: false, permissionVersion: 1,
  sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false,
  effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null,
  sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null,
  resultDeliveredAt: null, createdAt: at, startedAt: at, endedAt: at,
};
const event = (seq: number, id: string): PersistentEvent => ({ seq, taskId: "task", sessionId: "session", createdAt: at,
  body: { type: "task.output_entry", taskId: "task", sessionId: "session", entryId: id, sessionFile: "/session.jsonl", role: "assistant", messageId: id },
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(handlers: FakeHandlers, assistantOnly = false) {
  const transport = new FakeTransport({ handlers });
  const state = new ViewState(), errors: unknown[] = [], changes: number[] = [];
  const recovery = new HistoryRecovery({
    state, request: (op, params) => transport.request(op, params), entryPageBytes: assistantOnly ? 48 * 1024 : 64 * 1024,
    completeEntry: item => !assistantOnly || item.role === "assistant",
    isMissingEntry: error => error instanceof ControlClientError && error.code === "entry_not_found",
    changed: () => { changes.push(state.openSession("session").flow.items.length); }, entryFailed: error => { errors.push(error); },
  });
  const reset = () => { recovery.reset(); state.applySnapshot({ snapshot: fakeSnapshot(), replay: [], seq: 0 }, true); };
  return { recovery, state, transport, errors, changes, reset };
}

for (const assistantOnly of [false, true]) test(`正文策略与 UTF-8 分页：${assistantOnly ? "TUI" : "Desktop"}`, async () => {
  const pieces = ["中文", "🙂", "尾"], offsets = [0, 6, 10];
  const h = fixture({ read_history_entry: params => {
    assert.equal(params.length, assistantOnly ? 48 * 1024 : 64 * 1024);
    const index = offsets.indexOf(params.offset ?? 0);
    assert.ok(index >= 0);
    return entry(params.entry_id, pieces[index], { role: params.entry_id === "user" ? "user" : "assistant", offset: offsets[index], totalBytes: 13, truncated: index < 2 });
  } }, assistantOnly);
  await h.recovery.loadEntry("session", "answer", 0, "task");
  await h.recovery.loadEntry("session", "user", 0, "task");
  const items = h.state.openSession("session").flow.historyEntries;
  assert.equal(items.find(item => item.entryId === "answer")?.text, pieces.join(""));
  assert.equal(items.find(item => item.entryId === "user")?.text, assistantOnly ? pieces[0] : pieces.join(""));
  assert.equal(items.find(item => item.entryId === "user")?.truncated, assistantOnly);
  assert.equal(h.recovery.historyReady("session", "task"), true);
  assert.equal(h.transport.requests.length, assistantOnly ? 4 : 6);
});

test("分支来源任务按当前历史页补齐状态", async () => {
  const branch: Session = { id: "session", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: "分支", branchSource: { sessionId: "source", number: 1, entryId: "entry", messageCount: 1, excluded: [], taskIds: ["ancestor"], artifacts: [], results: [] }, cwd: "/w", cwdReal: "/w", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: at };
  const transport = new FakeTransport({ handlers: {
    list_tasks: () => ({ tasks: [], hasMore: false }),
    get_task: params => ({ task: { ...task, id: params.task_id, sessionId: "source" }, toolOps: [], outputPreview: null, seq: 1, confirmations: [], artifacts: [] }),
  } });
  const state = new ViewState();
  state.applySnapshot({ snapshot: fakeSnapshot({ sessions: [branch] }), replay: [], seq: 0 }, false);
  const recovery = new HistoryRecovery({ state, request: (op, params) => transport.request(op, params), entryPageBytes: 64 * 1024, completeEntry: () => true, isMissingEntry: () => false, changed: () => {}, entryFailed: () => {} });
  assert.deepEqual([...(await recovery.readTasks("session", [entry("answer", "分支历史", { taskId: "ancestor" })], 0))!], []);
  assert.equal(state.getTask("ancestor")?.status, "completed");
  assert.deepEqual(transport.requests.map(request => request.op), ["list_tasks", "get_task"]);
});

test("分支会话按来源任务恢复思考与工具 trace", async () => {
  const branch: Session = { id: "session", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: "分支", branchSource: { sessionId: "source", number: 1, entryId: "entry", messageCount: 1, excluded: [], taskIds: ["ancestor"], artifacts: [], results: [] }, cwd: "/w", cwdReal: "/w", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: at };
  const events: PersistentEvent[] = [
    { seq: 1, sessionId: "source", taskId: "ancestor", createdAt: at, body: { type: "task.thinking", taskId: "ancestor", sessionId: "source", thinkingId: "thought", messageId: "message", startedAt: at, endedAt: at, text: "之前对话的思考" } },
    { seq: 2, sessionId: "source", taskId: "ancestor", createdAt: at, body: { type: "task.tool_intent", taskId: "ancestor", toolOpId: "operation", sdkCallId: "call", toolName: "read", params: { path: "old.ts" } } },
    { seq: 3, sessionId: "source", taskId: "ancestor", createdAt: at, body: { type: "task.tool_result", taskId: "ancestor", toolOpId: "operation", summary: "之前读取完成", isError: false, artifactIds: [] } },
  ];
  const transport = new FakeTransport({ handlers: {
    get_task: params => ({ task: { ...task, id: params.task_id, sessionId: "source" }, toolOps: [], outputPreview: null, seq: 3, confirmations: [], artifacts: [] }),
    read_task_events: params => ({ events: events.filter(event => event.seq > (params.after_seq ?? 0)), nextAfter: null }),
  } });
  const state = new ViewState();
  state.applySnapshot({ snapshot: fakeSnapshot({ sessions: [branch] }), replay: [], seq: 0 }, false);
  const recovery = new HistoryRecovery({ state, request: (op, params) => transport.request(op, params), entryPageBytes: 64 * 1024, completeEntry: () => true, isMissingEntry: () => false, changed: () => {}, entryFailed: () => {} });
  await recovery.restoreBranchTask("session", "ancestor", 0);
  const items = state.openSession("session").flow.items;
  assert.ok(items.some(item => item.kind === "thinking" && item.text === "之前对话的思考"));
  assert.ok(items.some(item => item.kind === "tool" && item.name === "read" && item.summary === "之前读取完成"));
  assert.equal(state.sessionViews.has("source"), false, "不打开来源会话");
});

test("任务读取去重，事件从零分页，单条失败不阻断后续正文", async () => {
  const gate = deferred<void>();
  const h = fixture({
    get_task: async () => { await gate.promise; return { task, toolOps: [], outputPreview: null, seq: 100, confirmations: [], artifacts: [] }; },
    read_task_events: params => params.after_seq === 0 ? { events: [event(1, "broken")], nextAfter: 1 } : { events: [event(2, "good")], nextAfter: null },
    read_history_entry: params => {
      if (params.entry_id === "broken") throw new ControlClientError("history_corrupt", "损坏的正文", "rejected");
      return entry("good", "最终回复");
    },
  });
  const first = h.recovery.restoreTask("task", 0), second = h.recovery.restoreTask("task", 0);
  assert.strictEqual(first, second);
  gate.resolve();
  await first;
  assert.equal(h.transport.requests.filter(item => item.op === "get_task").length, 1);
  assert.deepEqual(h.transport.requests.filter(item => item.op === "read_task_events").map(item => item.params), [{ task_id: "task", after_seq: 0, limit: 100 }, { task_id: "task", after_seq: 1, limit: 100 }]);
  assert.equal(h.errors.length, 1);
  assert.ok(h.changes.length >= 3, "每页事件与成功正文均通知投影变化");
  assert.ok(h.state.openSession("session").flow.historyEntries.some(item => item.entryId === "good"));
  assert.equal(h.recovery.historyReady("session", "task"), false, "失败正文仍未确认");
});

for (const fail of [false, true]) test(`换代后的旧${fail ? "失败" : "成功"}与 finally 不清除新请求或 pending`, async () => {
  const old = deferred<HistoryEntryView>(), fresh = deferred<HistoryEntryView>();
  let reads = 0;
  const h = fixture({ read_history_entry: () => (++reads === 1 ? old.promise : fresh.promise) });
  const previous = h.recovery.loadEntry("session", "entry", 0, "task");
  await Promise.resolve();
  h.reset();
  const current = h.recovery.loadEntry("session", "entry", h.recovery.generation, "task");
  await Promise.resolve();
  if (fail) old.reject(new Error("旧读取失败")); else old.resolve(entry("entry", "旧正文"));
  await previous;
  assert.equal(h.recovery.historyReady("session", "task"), false);
  const duplicate = h.recovery.loadEntry("session", "entry", h.recovery.generation, "task");
  assert.strictEqual(duplicate, current);
  assert.equal(reads, 2);
  assert.equal(h.state.openSession("session").flow.historyEntries.length, 0);
  fresh.resolve(entry("entry", "新正文"));
  await current;
  assert.equal(h.recovery.historyReady("session", "task"), true);
  assert.deepEqual(h.state.openSession("session").flow.historyEntries.map(item => item.text), ["新正文"]);
  assert.deepEqual(h.errors, []);
});

test("窗口任务查询完成后换代，旧阶段不能借新代次继续请求", async () => {
  const h = fixture({ list_tasks: () => ({ tasks: [task], hasMore: false }) });
  const generation = h.recovery.generation;
  const tasks = await h.recovery.readTasks("session", [], generation);
  assert.deepEqual([...tasks!], ["task"]);
  h.reset();
  for (const id of tasks!) await h.recovery.restoreTask(id, generation);
  await h.recovery.loadEntry("session", "entry", generation, "task");
  assert.equal(await h.recovery.readTasks("session", [], generation), null);
  assert.equal(h.transport.requests.length, 1);
  assert.equal(h.state.sessionViews.size, 0);
});

for (const kind of ["first-offset", "gap", "total", "empty", "overflow"] as const) test(`拒绝异常正文分页：${kind}`, async () => {
  const h = fixture({ read_history_entry: params => {
    if (!params.offset) return entry("entry", "中", { offset: kind === "first-offset" ? 1 : 0, totalBytes: kind === "overflow" ? 1 : 6, truncated: true });
    return entry("entry", kind === "empty" ? "" : "文", { offset: kind === "gap" ? 4 : 3, totalBytes: kind === "total" ? 7 : 6 });
  } });
  await h.recovery.loadEntry("session", "entry", 0, "task");
  assert.ok(h.errors[0] instanceof HistoryRecoveryError);
  assert.equal(h.errors[0].code, "history_discontinuous");
  assert.equal(h.state.openSession("session").flow.historyEntries.length, 0);
  assert.equal(h.recovery.historyReady("session", "task"), false);
});

test("暂未落盘条目不报告错误，也不把最终正文标为就绪", async () => {
  const h = fixture({ read_history_entry: () => { throw new ControlClientError("entry_not_found", "尚未落盘", "rejected"); } });
  await h.recovery.loadEntry("session", "entry", 0, "task");
  assert.deepEqual(h.errors, []);
  assert.equal(h.recovery.historyReady("session", "task"), false);
});
