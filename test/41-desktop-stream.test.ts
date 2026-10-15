import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { PersistentEvent, Session } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import type { OpParams } from "@ruukoto/control/ops.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

const at = (second: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, second)).toISOString();
function task(): TaskView {
  return { id: "task", sessionId: "session", requestId: "request", input: "问题", inputPurpose: "user", modelSelection: null, submissionDigest: null, status: "completed", accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: ["answer"], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at(0), startedAt: at(1), endedAt: at(8) };
}
function history(entryId: string, text: string, extra: Partial<HistoryEntryView> = {}): HistoryEntryView {
  return { entryId, taskId: "task", inputPurpose: "user", parentId: null, role: "assistant", text, timestamp: at(5), offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false, ...extra };
}
const event = (seq: number, body: PersistentEvent["body"]): PersistentEvent => ({ seq, body, sessionId: "session", taskId: "task", createdAt: at(seq) });
const session: Session = { id: "session", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/w", cwdReal: "/w", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, createdAt: at(0) };
function harness(handlers: FakeHandlers) {
  const transport = new FakeTransport({ handlers: { list_session_summaries: () => [], list_tasks: () => ({ tasks: [], hasMore: false }), read_history: () => ({ fileAvailable: true, hasPartialTail: false, entries: [], nextBefore: null }), ...handlers } });
  const model = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {});
  const snapshot = (changed = false) => model.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ instanceId: changed ? "other" : "inst-1", sessions: changed ? [] : [session] }), replay: [], seq: 100 }, instanceChanged: changed });
  snapshot();
  model.update({ type: "state", state: "online" });
  return { model, transport, snapshot };
}

test("桌面冷启动与重连恢复思考、工具身份及多页 UTF-8 正文，翻页不丢已有条目", async () => {
  const text = "中文👩‍💻正文\n".repeat(10_000);
  const pieces = [text.slice(0, 20_000), text.slice(20_000, 40_000), text.slice(40_000)];
  const offsets = pieces.map((_, index) => Buffer.byteLength(pieces.slice(0, index).join("")));
  const events = [
    event(2, { type: "task.thinking", sessionId: "session", taskId: "task", thinkingId: "thought", messageId: "message", startedAt: at(1), endedAt: at(2), text: "恢复的思考" }),
    event(3, { type: "task.tool_intent", taskId: "task", toolOpId: "operation", sdkCallId: "call", toolName: "read", params: { path: "file.ts" } }),
    event(4, { type: "task.tool_result", taskId: "task", toolOpId: "operation", summary: "读取完成", isError: false, artifactIds: [] }),
    event(5, { type: "task.output_entry", taskId: "task", sessionId: "session", entryId: "answer", sessionFile: "/session.jsonl", role: "assistant", messageId: "message" }),
  ];
  const { model, transport, snapshot } = harness({
    read_history: params => ({ fileAvailable: true, hasPartialTail: false, entries: params.before ? [history("older", "更早正文", { taskId: null, timestamp: at(0) })] : [history("answer", "预览", { totalBytes: Buffer.byteLength(text), truncated: true })], nextBefore: params.before ? null : "answer" }),
    list_tasks: () => ({ tasks: [task()], hasMore: false }),
    get_task: () => ({ task: task(), toolOps: [], confirmations: [], artifacts: [], outputPreview: null, seq: 100 }),
    read_task_events: params => ({ events: events.filter(event => event.seq > (params.after_seq ?? 0)).slice(0, 2), nextAfter: (params.after_seq ?? 0) < 3 ? 3 : null }),
    read_history_entry: params => {
      const index = offsets.indexOf(params.offset ?? 0);
      assert.ok(index >= 0, "按实际 UTF-8 字节推进");
      return history("answer", pieces[index], { offset: offsets[index], totalBytes: Buffer.byteLength(text), truncated: index < pieces.length - 1 });
    },
  });
  await model.loadHistory("session");
  const items = () => model.view.openSession("session").flow.items;
  assert.equal(items().filter(entry => entry.kind === "thinking").length, 1);
  const tool = items().find(entry => entry.kind === "tool");
  assert.ok(tool?.kind === "tool");
  assert.equal(tool.toolOpId, "operation");
  assert.equal(tool.status, "done");
  assert.ok(items().some(entry => entry.kind === "message" && entry.text === text && !entry.truncated));
  assert.ok(transport.requests.some(request => request.op === "read_task_events" && (request.params as OpParams<"read_task_events">).after_seq === 0), "不以 get_task 的 seq 为事件起点");
  const keys = items().map(entry => entry.key);
  snapshot();
  await model.loadHistory("session");
  for (const entry of events) model.update({ type: "event", event: entry, kind: "replay" });
  assert.deepEqual(items().map(entry => entry.key), keys);
  assert.ok(items().some(entry => entry.kind === "message" && entry.text === text));
  await model.loadHistory("session", "prepend");
  assert.ok(items().some(entry => entry.kind === "message" && entry.text === "更早正文"));
  assert.ok(items().some(entry => entry.kind === "message" && entry.text === text));
  assert.equal(model.view.openSession("session").historyCursor, null);
});

for (const op of ["read_history", "get_task", "read_task_events", "read_history_entry"] as const) test(`桌面同连接重同步丢弃迟到 ${op}`, async () => {
  let release!: () => void;
  let blocked = false;
  let fresh = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wait = async (name: string) => { if (name === op && !fresh) { blocked = true; await gate; } };
  const { model, snapshot } = harness({
    read_history: async () => { const old = !fresh; await wait("read_history"); return { fileAvailable: true, hasPartialTail: false, entries: [history(old ? "stale" : "fresh", old ? "旧代次正文" : "新代次正文", { truncated: old && op === "read_history_entry" })], nextBefore: null }; },
    list_tasks: () => ({ tasks: fresh ? [] : [task()], hasMore: false }),
    get_task: async () => { await wait("get_task"); return { task: task(), toolOps: [], confirmations: [], artifacts: [], outputPreview: null, seq: 100 }; },
    read_task_events: async () => { await wait("read_task_events"); return { events: [event(2, { type: "task.thinking", sessionId: "session", taskId: "task", thinkingId: "stale-thought", messageId: "message", startedAt: at(1), endedAt: at(2), text: "旧代次思考" })], nextAfter: null }; },
    read_history_entry: async () => { await wait("read_history_entry"); return history("stale", "旧代次补读"); },
  });
  const old = model.loadHistory("session");
  await waitFor("旧请求已发出", () => blocked);
  fresh = true;
  snapshot();
  await model.loadHistory("session");
  release();
  await old;
  const items = model.view.openSession("session").flow.items;
  assert.ok(items.some(entry => entry.kind === "message" && entry.text === "新代次正文"));
  assert.ok(!items.some(entry => (entry.kind === "message" || entry.kind === "thinking") && entry.text.includes("旧代次")));
  assert.equal(model.view.getTask("task"), null);
});

test("桌面快照换代中断多个截断条目的旧恢复循环", async () => {
  let release!: () => void;
  let blocked = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { model, transport, snapshot } = harness({
    read_history: () => ({ fileAvailable: true, hasPartialTail: false, entries: [history("old-1", "预览", { truncated: true }), history("old-2", "预览", { truncated: true })], nextBefore: null }),
    read_history_entry: async params => { blocked = true; await gate; return history(params.entry_id, "旧正文"); },
  });
  const old = model.loadHistory("old-session");
  await waitFor("首个条目补读在途", () => blocked);
  snapshot(true);
  release();
  await old;
  assert.equal(transport.requests.filter(request => request.op === "read_history_entry").length, 1);
  assert.equal(model.view.sessionViews.size, 0, "不会向新实例安装第二个旧条目");
});

test("桌面不连续正文分页显示失败，不安装伪完整内容", async () => {
  const { model } = harness({ read_history_entry: params => history("answer", "中文", { offset: params.offset ? params.offset - 1 : 0, totalBytes: 100, truncated: true }) });
  await model.loadEntry("session", "answer");
  assert.match(model.readError!, /分页未连续/);
  assert.equal(model.view.openSession("session").flow.historyEntries.length, 0);
});

test("桌面人工重连创建了新连接时，仍以实例身份清空旧标签与视图", async () => {
  const { model } = harness({ read_history: () => ({ fileAvailable: true, hasPartialTail: false, entries: [history("old", "原实例正文")], nextBefore: null }) });
  model.openSession("session");
  await model.loadHistory("session");
  assert.equal(model.tabs.length, 1);
  model.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ instanceId: "new-instance" }), replay: [], seq: 0 }, instanceChanged: false });
  assert.equal(model.view.currentSessionId, null);
  assert.equal(model.tabs.length, 0);
  assert.equal(model.view.sessionViews.size, 0);
});

test("桌面通知导航按实例定位后消费，同实例快照不抢回已切换的会话", () => {
  const model = new CodeState({ request: async () => ({ ok: true, value: undefined }) }, () => {}, "personal");
  const result = { seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [session, { ...session, id: "second" }] }) };
  model.update({ type: "snapshot", result, instanceChanged: false });
  model.update({ type: "navigate", instanceId: "inst-1", navigation: { sessionId: "session", taskId: "task" } });
  assert.equal(model.view.currentSessionId, "session");
  assert.deepEqual(model.notificationSelection, { sessionId: "session", taskId: "task" });
  model.openSession("second"); model.closeSession("session");
  model.update({ type: "snapshot", result, instanceChanged: false });
  assert.equal(model.view.currentSessionId, "second"); assert.ok(!model.tabs.includes("session"));
  model.update({ type: "navigate", instanceId: "old", navigation: { sessionId: "session", taskId: "task" } });
  assert.equal(model.view.currentSessionId, "second"); assert.match(model.message!, /原目标已经变化/);
});
