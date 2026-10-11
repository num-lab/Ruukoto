import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { PersistentEvent, Task } from "@ruukoto/core/types.ts";
import type { ToolOpView } from "@ruukoto/core/views.ts";
import { EventFlow } from "@ruukoto/tui/tui/event-flow.ts";
import { EventFlowView } from "@ruukoto/tui/tui/event-flow-view.ts";
import { MAX_LOADED_ENTRIES, ViewState } from "@ruukoto/tui/tui/state.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 22, 13, 16, seconds)).toISOString();
const event = (seq: number, body: PersistentEvent["body"]): PersistentEvent => ({ seq, body, sessionId: "session", taskId: "task", createdAt: at(seq) });
const messages = (flow: EventFlow) => flow.items.filter((entry) => entry.kind === "message");
function task(id = "task", extra: Partial<Task> = {}): Task {
  return {
    id, sessionId: "session", requestId: `request:${id}`, input: "same input", modelSelection: null,
    submissionDigest: null, status: "running", accessMode: "confirm", planMode: false, permissionVersion: 1,
    sourcePermissionVersion: null, grantedPaths: [],
    pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null,
    historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null,
    resultSummary: null, resultRef: null,
    workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at(0), startedAt: at(1), endedAt: null, ...extra,
  };
}
function history(entryId: string, role: string, text: string, extra: Partial<HistoryEntryView> = {}): HistoryEntryView {
  return { entryId, parentId: null, role, text, timestamp: at(1), offset: 0, totalBytes: Buffer.byteLength(text), truncated: false,
    toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false, ...extra };
}
function fragment(seq: number, text: string, extra: Partial<Extract<PersistentEvent["body"], { type: "task.output_fragment" }>> = {}): PersistentEvent {
  return event(seq, { type: "task.output_fragment", taskId: "task", sessionId: "session", messageId: "message", text,
    offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, partial: true, startedAt: at(seq), ...extra });
}
function reference(seq: number, entryId: string, role = "assistant", taskId = "task", messageId: string | null = "message"): PersistentEvent {
  return event(seq, { type: "task.output_entry", taskId, sessionId: "session", entryId, role, messageId, sessionFile: "/session.jsonl" });
}
const intent = event(2, { type: "task.tool_intent", taskId: "task", toolOpId: "operation", sdkCallId: "call", toolName: "edit", params: { path: "script.py" } });
const result = event(4, { type: "task.tool_result", taskId: "task", toolOpId: "operation", summary: "updated", isError: false, artifactIds: [], editStats: { added: 3, removed: 1 } });
const toolHistory = history("tool-entry", "toolResult", "updated", { timestamp: at(4), toolCallId: "call", toolName: "edit", isError: false, editStats: { added: 3, removed: 1 } });
const operation: ToolOpView = {
  id: "operation", taskId: "task", toolName: "edit", sdkCallId: "call", params: { path: "script.py" },
  paramsBytes: 20, paramsTruncated: false, authorization: null, intentRecordedAt: at(2), recordedResultAt: null,
  resultSummary: null, isError: null, effectUnknown: false,
};

test("向前翻页超过初始历史条数上限时保留更早页面与已有正文", () => {
  const state = new ViewState();
  const entries = Array.from({ length: MAX_LOADED_ENTRIES + 20 }, (_, i) =>
    history(`entry-${i}`, "assistant", `正文 ${i}`, { timestamp: at(i) }));
  state.installHistoryPage("session", { fileAvailable: true, hasPartialTail: false,
    entries: entries.slice(20), nextBefore: entries[20]!.entryId }, "replace");
  state.installHistoryPage("session", { fileAvailable: true, hasPartialTail: false,
    entries: entries.slice(0, 21), nextBefore: null }, "prepend");
  const view = state.openSession("session");
  assert.equal(view.flow.historyEntries.length, entries.length, "前插更早历史不被初始窗口上限立即淘汰，重叠条目去重");
  assert.ok(view.flow.items.some((entry) => entry.kind === "message" && entry.entryId === entries[0]!.entryId));
  assert.ok(view.flow.items.some((entry) => entry.kind === "message" && entry.entryId === entries.at(-1)!.entryId));
  assert.equal(view.historyCursor, null, "最早一页完整安装后停止翻页");
});

test("工具完成及历史补齐保持开始位置，不越过开始后到达的正文", () => {
  const flow = new EventFlow();
  flow.apply(intent);
  flow.apply(fragment(3, "解释工具操作"));
  const keys = flow.items.map((entry) => entry.key);
  const original = { ...flow.tools[0]! };
  flow.apply(result);
  flow.apply(reference(5, "tool-entry", "toolResult", "task", null));
  flow.addHistory(toolHistory);
  assert.deepEqual(flow.items.map((entry) => entry.key), keys);
  assert.equal(flow.tools[0]!.at, original.at);
  assert.equal(flow.tools[0]!.seq, original.seq);
  assert.equal(flow.tools[0]!.entryId, "tool-entry");
  assert.equal(flow.tools[0]!.status, "done");
  assert.deepEqual(flow.tools[0]!.editStats, { added: 3, removed: 1 });
});

test("工具实时事件和历史异步到达时合并为一个条目，重复补读不丢目标", () => {
  for (const order of [["intent", "result", "ref", "history"], ["history", "intent", "ref", "result"], ["ref", "history", "intent", "result"], ["intent", "history", "result", "ref"]]) {
    const flow = new EventFlow();
    const actions: Record<string, () => void> = {
      intent: () => flow.apply(intent), result: () => flow.apply(result),
      ref: () => flow.apply(reference(5, "tool-entry", "toolResult", "task", null)), history: () => flow.addHistory(toolHistory),
    };
    for (let pass = 0; pass < 2; pass++) {
      for (const action of order) actions[action]!();
      assert.equal(flow.tools.length, 1, order.join(" → "));
      assert.equal(flow.tools[0]!.toolOpId, "operation");
      assert.equal(flow.tools[0]!.target, "script.py");
      assert.equal(flow.tools[0]!.entryId, "tool-entry");
      assert.deepEqual(flow.tools[0]!.editStats, { added: 3, removed: 1 });
    }
  }
});

test("同样正文的两次提交按任务身份关联历史，任何回传顺序都不合并输入", () => {
  for (const historyFirst of [false, true]) {
    const flow = new EventFlow();
    flow.task(task("first"));
    flow.task(task("second", { createdAt: at(3), startedAt: at(4) }));
    const entries = [history("input-first", "user", "same input"), history("input-second", "user", "same input", { timestamp: at(3) })];
    if (historyFirst) entries.forEach((entry) => flow.addHistory(entry));
    flow.apply(reference(2, "input-first", "user", "first", null));
    flow.apply(reference(5, "input-second", "user", "second", null));
    if (!historyFirst) entries.forEach((entry) => flow.addHistory(entry));
    flow.task(task("first"));
    flow.task(task("second", { createdAt: at(3), startedAt: at(4) }));
    const inputs = messages(flow).filter((entry) => entry.role === "user");
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs.map((entry) => entry.entryId), ["input-first", "input-second"]);
    assert.deepEqual(inputs.map((entry) => entry.text), ["same input", "same input"]);
  }
});

test("乱序和重复正文增量按 UTF-8 字节补齐，不重复字符且迟到片段不回滚完整历史", () => {
  const flow = new EventFlow();
  const pieces = ["你", "👩‍💻", "好"];
  const text = pieces.join("");
  const fragments = pieces.map((piece, index) => fragment(index + 1, piece, {
    offset: Buffer.byteLength(pieces.slice(0, index).join("")), totalBytes: Buffer.byteLength(pieces.slice(0, index + 1).join("")), startedAt: at(1),
  }));
  for (const index of [2, 1, 0, 1, 0, 2]) flow.apply(fragments[index]!);
  assert.equal(messages(flow).length, 1);
  assert.equal(messages(flow)[0]!.text, text);
  assert.equal(messages(flow)[0]!.totalBytes, Buffer.byteLength(text));
  assert.equal(messages(flow)[0]!.truncated, false);
  const key = messages(flow)[0]!.key;
  flow.apply(reference(5, "answer"));
  flow.addHistory(history("answer", "assistant", text));
  flow.apply(fragments[1]!);
  assert.equal(messages(flow)[0]!.key, key);
  assert.equal(messages(flow)[0]!.text, text);
  assert.equal(messages(flow)[0]!.streaming, false);
});

test("完整历史、输出引用和旧流式片段任意到达顺序最终保持唯一完整正文", () => {
  for (const order of [["fragment", "ref", "history"], ["history", "fragment", "ref"], ["history", "ref", "fragment"], ["ref", "history", "fragment"]]) {
    const flow = new EventFlow();
    const actions: Record<string, () => void> = {
      fragment: () => flow.apply(fragment(2, "较短正文")),
      ref: () => flow.apply(reference(4, "answer")),
      history: () => flow.addHistory(history("answer", "assistant", "较短正文，已经完整落盘")),
    };
    for (const action of order) actions[action]!();
    assert.equal(messages(flow).length, 1, order.join(" → "));
    assert.equal(messages(flow)[0]!.text, "较短正文，已经完整落盘");
    assert.equal(messages(flow)[0]!.streaming, false);
  }
});

test("同一消息的正文段与思考交错时各守原位，历史补齐不合并或重复正文", () => {
  const flow = new EventFlow();
  const thinking = event(3, { type: "task.thinking", taskId: "task", sessionId: "session", messageId: "message", thinkingId: "thought", startedAt: at(3), endedAt: null, text: "继续推理" });
  flow.apply(fragment(2, "第一段", { contentIndex: 0 }));
  flow.apply(thinking);
  flow.apply(event(4, { ...thinking.body as Extract<PersistentEvent["body"], { type: "task.thinking" }>, endedAt: at(4) }));
  flow.apply(fragment(5, "第二段", { contentIndex: 1 }));
  const before = flow.items.map((entry) => ({ key: entry.key, kind: entry.kind }));
  assert.deepEqual(before.map((entry) => entry.kind), ["message", "thinking", "message"]);
  assert.deepEqual(messages(flow).map((entry) => entry.text), ["第一段", "第二段"]);
  flow.apply(reference(6, "answer"));
  flow.addHistory(history("answer", "assistant", "第一段第二段"));
  assert.deepEqual(flow.items.map((entry) => ({ key: entry.key, kind: entry.kind })), before);
  assert.deepEqual(messages(flow).map((entry) => entry.text), ["第一段", "第二段"]);
  assert.ok(messages(flow).every((entry) => !entry.streaming && entry.entryId === "answer"));
});

test("刷新任务详情不在现有正文段旁重复插入累计预览", () => {
  const flow = new EventFlow();
  flow.apply(fragment(2, "第一段", { contentIndex: 0 }));
  flow.apply(fragment(3, "第二段", { contentIndex: 1 }));
  flow.preview("task", { messageId: "message", text: "第一段第二段", totalBytes: 18, truncated: false, seq: 3, state: "generating" });
  assert.deepEqual(messages(flow).map((entry) => entry.text), ["第一段", "第二段"]);
});

test("完整 JSONL 正文校正缺失或过时的流式段，合并后不残留错误文本", () => {
  const flow = new EventFlow();
  flow.apply(fragment(2, "过时前文", { contentIndex: 0 }));
  flow.apply(fragment(4, "漏字", { contentIndex: 1 }));
  flow.apply(reference(5, "answer"));
  flow.addHistory(history("answer", "assistant", "修正后的完整正文"));
  const output = messages(flow);
  assert.equal(output.map((entry) => entry.text).join(""), "修正后的完整正文");
  assert.ok(output.every((entry) => !entry.streaming && !entry.truncated && entry.entryId === "answer"));
});

test("重新加载完整历史和事件恢复分段顺序，失败任务结束思考且不显示成功", () => {
  const flow = new EventFlow();
  flow.task(task("task", { status: "failed", endedAt: at(8), errorMessage: "provider failed" }));
  flow.installHistory([history("answer", "assistant", "第一段第二段")], true, 300);
  flow.apply(fragment(2, "第一段", { contentIndex: 0 }));
  flow.apply(event(3, { type: "task.thinking", taskId: "task", sessionId: "session", messageId: "message", thinkingId: "thought", startedAt: at(3), endedAt: at(4), text: "思考" }));
  flow.apply(fragment(5, "第二段", { contentIndex: 1 }));
  flow.apply(reference(6, "answer"));
  flow.apply(event(7, { type: "task.thinking", taskId: "task", sessionId: "session", messageId: "other", thinkingId: "interrupted-thought", startedAt: at(7), endedAt: null, text: "中断前思考" }));
  assert.deepEqual(messages(flow).filter((entry) => entry.role === "assistant").map((entry) => entry.text), ["第一段", "第二段"]);
  const unfinished = flow.items.find((entry) => entry.key === "thinking:interrupted-thought");
  assert.ok(unfinished?.kind === "thinking" && unfinished.endedAt === at(8));
  const view = new EventFlowView(() => Date.parse(at(10)));
  view.setEntries(flow.items);
  const output = view.render(100).map(stripTerminalSequences).join("\n");
  assert.match(output, /Failed/);
  assert.match(output, /provider failed/);
  assert.doesNotMatch(output, /Done|Sweeping|Thinking\.\.\./);
});

test("迟到 get_task 详情不能把已失败任务及工具回滚为运行中", () => {
  const state = new ViewState();
  state.installTaskDetail(task(), [operation], null, 2);
  state.applyEvent(event(8, { type: "task.tool_result", taskId: "task", toolOpId: "operation", summary: "permission denied", isError: true, artifactIds: ["artifact"] }), "live");
  state.applyEvent(event(9, { type: "task.failed", taskId: "task", sessionId: "session", errorMessage: "tool failed" }), "live");
  state.installTaskDetail(task(), [operation], null, 3);
  assert.equal(state.getTask("task")!.status, "failed");
  const flow = state.openSession("session").flow;
  assert.equal(flow.tools[0]!.status, "error");
  assert.equal(flow.tools[0]!.summary, "permission denied");
  assert.deepEqual(flow.tools[0]!.artifactIds, ["artifact"]);
  const taskEntry = flow.items.find((entry) => entry.kind === "task");
  assert.ok(taskEntry?.kind === "task" && taskEntry.task.status === "failed");
});

test("较新工具详情与较旧结果事件合并展示元数据，详情状态和摘要不回滚", () => {
  const flow = new EventFlow();
  flow.tool({ ...operation, recordedResultAt: at(4), resultSummary: "latest summary", isError: false }, 20);
  flow.apply(event(10, { type: "task.tool_result", taskId: "task", toolOpId: "operation", summary: "older summary", isError: false, artifactIds: ["diff-artifact"], editStats: { added: 3, removed: 1 } }));
  assert.equal(flow.tools[0]!.status, "done");
  assert.equal(flow.tools[0]!.summary, "latest summary");
  assert.deepEqual(flow.tools[0]!.editStats, { added: 3, removed: 1 });
  assert.deepEqual(flow.tools[0]!.artifactIds, ["diff-artifact"]);
});

test("不同任务复用 SDK 调用 ID 时，晚到的历史关联不串工具状态和目标", () => {
  const flow = new EventFlow();
  const first = event(2, { type: "task.tool_intent", taskId: "first", toolOpId: "op-first", sdkCallId: "reused", toolName: "read", params: { path: "first.py" } });
  const second = event(4, { type: "task.tool_intent", taskId: "second", toolOpId: "op-second", sdkCallId: "reused", toolName: "read", params: { path: "second.py" } });
  flow.apply(first);
  flow.apply(second);
  // 历史 API 可能先于各任务的 output_entry 补读返回；不能只凭 SDK ID 关联。
  flow.addHistory(history("second-result", "toolResult", "access denied", { timestamp: at(5), toolCallId: "reused", toolName: "read", isError: true }));
  flow.addHistory(history("first-result", "toolResult", "first content", { timestamp: at(3), toolCallId: "reused", toolName: "read", isError: false }));
  flow.apply(reference(6, "second-result", "toolResult", "second", null));
  flow.apply(reference(7, "first-result", "toolResult", "first", null));
  assert.equal(flow.tools.length, 2);
  const firstTool = flow.tools.find((entry) => entry.toolOpId === "op-first")!;
  const secondTool = flow.tools.find((entry) => entry.toolOpId === "op-second")!;
  assert.equal(firstTool.entryId, "first-result");
  assert.equal(firstTool.status, "done");
  assert.equal(firstTool.target, "first.py");
  assert.equal(firstTool.summary, "first content");
  assert.equal(secondTool.entryId, "second-result");
  assert.equal(secondTool.status, "error");
  assert.equal(secondTool.target, "second.py");
  assert.equal(secondTool.summary, "access denied");
});
