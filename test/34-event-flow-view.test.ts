import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Task } from "../src/core/types.ts";
import type { FlowEntry } from "../src/tui/event-flow.ts";
import { EventFlowView } from "../src/tui/event-flow-view.ts";

initTheme("dark");
const at = new Date(2026, 8, 22, 21, 16).toISOString();
const position = { key: "event", at, seq: 1 };
const plain = (view: EventFlowView, width = 80) => view.render(width).map((line) => stripTerminalSequences(line).trimEnd());
const message = (text: string, extra: Partial<Extract<FlowEntry, { kind: "message" }>> = {}): FlowEntry => ({
  ...position, kind: "message", role: "assistant", text, entryId: "entry-1", totalBytes: Buffer.byteLength(text), truncated: false, streaming: true, ...extra,
});
const tool = (extra: Partial<Extract<FlowEntry, { kind: "tool" }>> = {}): FlowEntry => ({
  ...position, kind: "tool", toolOpId: "op-1", toolCallId: "call-1", name: "read", params: {}, target: "script.py", status: "done", summary: null, entryId: "entry-tool", paramsTruncated: false, artifactIds: [], ...extra,
});
function task(extra: Partial<Task> = {}): Task {
  return {
    id: "task-1", sessionId: "session-1", requestId: "request-1", input: "test", modelSelection: null,
    submissionDigest: null, status: "running", accessMode: "confirm", permissionVersion: 1, grantedPaths: [],
    pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null,
    historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null,
    resultSummary: null, resultRef: null, createdAt: new Date(Date.parse(at) - 60_000).toISOString(), startedAt: at,
    endedAt: null, ...extra,
  };
}

test("同一键的流式正文持续更新，包括同长度且前 128 字符相同的替换", () => {
  const view = new EventFlowView();
  const prefix = "a".repeat(140);
  view.setEntries([message(`${prefix}OLD`)]);
  assert.match(plain(view, 200).join("\n"), /OLD/);
  view.setEntries([message(`${prefix}NEW`)]);
  assert.match(plain(view, 200).join("\n"), /NEW/);
  assert.doesNotMatch(plain(view, 200).join("\n"), /OLD/);
  view.setEntries([message("最终正文", { streaming: false })]);
  assert.deepEqual(plain(view), ["● 最终正文"]);
});

test("事件之间恰一空行，工具和命令的结果紧贴，空助手消息不显示", () => {
  const view = new EventFlowView();
  view.setEntries([
    message("ping", { key: "user", role: "user" }),
    message("", { key: "empty" }),
    tool({ key: "read" }),
    { ...position, key: "command", kind: "command", line: "/mode", result: "Switched to Full access", isError: false },
    { ...position, key: "context", kind: "command", line: "/context", result: null, isError: false },
    message("pong", { key: "answer" }),
  ]);
  assert.deepEqual(plain(view), [
    "❯ ping", "", "⚙︎ Read", "  ⎿ script.py", "", "❯ /mode", "  ⎿ Switched to Full access", "", "❯ /context", "", "● pong",
  ]);
  const rendered = view.render(80);
  assert.match(rendered[0]!, /^\x1b\[48;5;236m/);
  assert.equal(visibleWidth(rendered[0]!), 80, "用户消息灰底铺满内容行");
  assert.doesNotMatch(rendered.slice(1).join("\n"), /\x1b\[48;/, "背景不延伸到间隔和其他事件");
});

test("思考正文只显示一行最新尾部，中文与组合 emoji 完整，结束后替换为耗时", () => {
  const view = new EventFlowView();
  const thinking: FlowEntry = { ...position, kind: "thinking", text: "过去内容现在👩‍💻", startedAt: at, endedAt: null };
  view.setEntries([thinking]);
  assert.deepEqual(plain(view, 20), ["⨳ Thinking... 现在👩‍💻"]);
  assert.match(view.render(20)[0]!, /Thinking\.\.\. \x1b\[2m现在👩‍💻/);
  for (const width of [0, 1, 2, 3, 4, 12, 15, 16, 19, 20]) {
    const lines = view.render(width);
    assert.ok(lines.length <= 1);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      const text = stripTerminalSequences(line);
      assert.equal(Buffer.from(text).toString("utf8"), text);
    }
  }
  view.setEntries([{ ...thinking, text: "" }]);
  assert.deepEqual(plain(view), ["⨳ Thinking..."]);
  view.setEntries([{ ...thinking, endedAt: new Date(Date.parse(at) + 22_000).toISOString() }]);
  assert.deepEqual(plain(view), ["⨳ Thought for 22s"]);
});

test("工具显示真实增删颜色，Bash 单行截断，错误与效果未知保留", () => {
  const view = new EventFlowView();
  view.setEntries([tool({ name: "edit", editStats: { added: 114, removed: 514 } })]);
  assert.deepEqual(plain(view), ["⚙︎ Edit", "  ⎿ script.py +114 -514"]);
  assert.match(view.render(80)[1]!, /\x1b\[32m\+114\x1b\[0m/);
  assert.match(view.render(80)[1]!, /\x1b\[31m-514\x1b\[0m/);
  view.setEntries([tool({ name: "bash", target: "/home/user/venv/bin/python\nscript.py --verbose" })]);
  assert.deepEqual(plain(view, 30), ["⚙︎ Bash", "  ⎿ /home/user/venv/bin/pyt..."]);
  view.setEntries([tool({ status: "error", summary: "permission denied" })]);
  assert.match(plain(view).join("\n"), /script.py · permission denied/);
  assert.match(view.render(80).join("\n"), /\x1b\[31mpermission denied/);
  view.setEntries([tool({ name: "custom_tool", status: "effect_unknown" })]);
  assert.deepEqual(plain(view), ["⚙︎ custom_tool", "  ⎿ script.py · 效果未知"]);
});

test("Sweeping 总在最后且不计排队；终态分别显示成功、失败、取消与中断", () => {
  const view = new EventFlowView(() => Date.parse(at) + 42_000);
  const running: FlowEntry = { ...position, kind: "task", task: task() };
  view.setEntries([running, message("正在输出", { key: "answer" })]);
  assert.deepEqual(plain(view), ["● 正在输出", "", "⦿ Sweeping · Elapsed 42s"]);
  for (const [status, marker, label, color] of [
    ["completed", "✓", "Done", "32"], ["failed", "✗", "Failed", "31"],
    ["canceled", "■", "Canceled", "33"], ["interrupted", "■", "Interrupted", "33"],
  ] as const) {
    view.setEntries([{ ...running, task: task({ status, endedAt: at, startedAt: new Date(Date.parse(at) - 1000).toISOString(), errorMessage: status === "failed" ? "network failed" : null, interruptReason: status === "interrupted" || status === "canceled" ? "owner requested" : null }) }]);
    const text = plain(view).join("\n");
    assert.ok(text.startsWith(`${marker} ${label} in 1s · At Tue 09:16 PM`));
    assert.ok(view.render(80).join("\n").includes(`\x1b[${color}m`));
    if (status !== "completed") assert.doesNotMatch(text, /Done/);
    if (status === "failed") assert.match(text, /network failed/);
    if (status === "interrupted" || status === "canceled") assert.match(text, /owner requested/);
  }
  view.setEntries([{ ...running, task: task({ status: "canceled", startedAt: null, endedAt: at }) }]);
  assert.deepEqual(plain(view), ["■ Canceled · At Tue 09:16 PM"]);
  view.setEntries([{ ...running, task: task({ status: "queued", startedAt: null }) }]);
  assert.deepEqual(plain(view), []);
});

test("长正文和 Markdown 列表、代码块续行避开图标列，并净化控制序列", () => {
  const view = new EventFlowView();
  const text = "# 标题\n\n- 中文👩‍💻与很长的正文重复重复重复\n\n```python\nprint('这是长代码')\n```\n\n\x1b[2J安全内容";
  view.setEntries([message(text)]);
  for (const width of [3, 4, 12, 30, 80]) {
    const lines = view.render(width);
    assert.ok(lines.length > 0);
    for (let index = 0; index < lines.length; index++) {
      const line = stripTerminalSequences(lines[index]!);
      assert.ok(visibleWidth(lines[index]!) <= width, `${width}: ${line}`);
      assert.equal(Buffer.from(line).toString("utf8"), line);
      if (index > 0 && line.trim()) assert.ok(line.startsWith("  "), line);
    }
  }
  assert.doesNotMatch(view.render(80).join("\n"), /\x1b\[2J/);
  assert.match(plain(view).join("\n"), /安全内容/);
  view.setEntries([message("多行\n中文用户输入重复重复重复", { role: "user", truncated: true })]);
  const lines = plain(view, 18);
  assert.ok(lines[0]!.startsWith("❯ "));
  assert.ok(lines.slice(1).every((line) => line.startsWith("  ")));
  assert.match(lines.join("\n"), /\/expand/);
  for (const width of [1, 18, 80]) {
    for (const line of view.render(width)) {
      assert.equal(visibleWidth(line), width, "换行后的用户消息也铺满背景");
      assert.match(line, /^\x1b\[48;5;236m/);
      assert.match(line, /\x1b\[49m$/, "每行末尾恢复默认背景");
      assert.doesNotMatch(line, /\x1b\[0m(?!\x1b\[48;5;236m)/, "内部样式重置后仍保留灰底");
    }
  }
});
