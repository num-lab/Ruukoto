import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
    resultSummary: null, resultRef: null,
    workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: new Date(Date.parse(at) - 60_000).toISOString(), startedAt: at,
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

test("文件工具目标相对于工作区显示，切换工作区后更新缓存", () => {
  const view = new EventFlowView();
  for (const name of ["read", "write", "edit"]) {
    const entries = [tool({ name, target: "/workspace/src/app.ts" })];
    view.setEntries(entries, "/workspace");
    assert.equal(plain(view)[1], "  ⎿ src/app.ts");
    view.setEntries(entries, "/workspace/other");
    assert.equal(plain(view)[1], "  ⎿ ../src/app.ts");
    view.setEntries([tool({ name, target: "src/app.ts" })], "/workspace");
    assert.equal(plain(view)[1], "  ⎿ src/app.ts");
  }
  view.setEntries([tool({ name: "bash", target: "/workspace/script.sh" })], "/workspace");
  assert.equal(plain(view)[1], "  ⎿ /workspace/script.sh");
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
    "❯ ping", "", "● Read", "  ⎿ script.py", "", "❯ /mode", "  ⎿ Switched to Full access", "", "❯ /context", "", "● pong",
  ]);
  const rendered = view.render(80);
  for (const index of [0, 5, 8]) {
    assert.match(rendered[index]!, /^\x1b\[48;5;236m/);
    assert.equal(visibleWidth(rendered[index]!), 80, "用户消息与命令消息灰底铺满内容行");
  }
  assert.doesNotMatch(rendered.filter((_, index) => ![0, 5, 8].includes(index)).join("\n"), /\x1b\[48;/, "背景不延伸到结果、间隔和其他事件");
  view.setEntries([{ ...position, kind: "command", line: "/search 中文关键词重复重复重复", result: "搜索结果", isError: false }]);
  const wrapped = view.render(18);
  for (const line of wrapped.slice(0, -1)) {
    assert.equal(visibleWidth(line), 18);
    assert.match(line, /^\x1b\[48;5;236m/);
    assert.match(line, /\x1b\[49m$/);
  }
  assert.doesNotMatch(wrapped.at(-1)!, /\x1b\[48;/);
});

test("/context 长条与图例保留分色，其他终端控制序列被过滤", () => {
  const view = new EventFlowView();
  view.setEntries([{ ...position, kind: "command", line: "/context", result: "\x1b[1mContext Usage\x1b[0m\n\x1b[38;5;75m████\x1b[0m\x1b[38;5;131m████\x1b[0m\n\x1b[38;5;75m■\x1b[0m 系统提示 663 (0.1%)\x1b]52;c;bad\x07\x1b[2J", isError: false }]);
  const rendered = view.render(80);
  assert.deepEqual(plain(view), ["❯ /context", "  ⎿ Context Usage", "█".repeat(80), "■ 系统提示 0.663k (0.1%)"]);
  assert.match(rendered[2]!, /\x1b\[38;5;75m█{40}\x1b\[0m\x1b\[0m\x1b\[38;5;131m█{40}/);
  assert.match(rendered[3]!, /\x1b\[38;5;75m■/);
  assert.doesNotMatch(rendered.join("\n"), /\x1b\]52|\x1b\[2J/);
  for (const width of [1, 2, 20, 120, 80]) {
    const bar = view.render(width).find((line) => /^█+$/.test(stripTerminalSequences(line)));
    assert.ok(bar);
    assert.equal(visibleWidth(bar), width, "缩窄和放大后长条保持单行并填满当前宽度");
  }
});

test("思考预览滚动展示四行，点击展开完整内容，结束后仍可收起", () => {
  let now = Date.parse(at);
  const view = new EventFlowView(() => now);
  const thinking: FlowEntry = { ...position, kind: "thinking", text: "第一行\n第二行\n第三行\n第四行\n最新👩‍💻", startedAt: at, endedAt: null };
  view.setEntries([thinking]);
  assert.deepEqual(plain(view, 30), ["⠋ Thinking...", "  ⎿ 第二行", "    第三行", "    第四行", "    最新👩‍💻"]);
  now += 80;
  assert.equal(plain(view, 30)[0], "⠙ Thinking...");
  const click: TuiMouseEvent = { y: 1, x: 5, screenX: 5, screenY: 1, width: 30, height: 20, type: "click", button: "left", shift: false, alt: false, ctrl: false };
  let changes = 0;
  view.onChange = () => changes++;
  assert.deepEqual(view.handleMouse({ ...click, type: "press" }), { handled: true });
  assert.equal(changes, 0);
  view.handleMouse(click);
  assert.equal(changes, 1);
  assert.deepEqual(plain(view, 30).slice(1), ["  ⎿ 第一行", "    第二行", "    第三行", "    第四行", "    最新👩‍💻"]);
  view.setEntries([{ ...thinking, endedAt: new Date(Date.parse(at) + 22_000).toISOString() }]);
  assert.equal(plain(view, 30)[0], "  Thought for 22s");
  view.handleMouse(click);
  assert.equal(plain(view, 30).length, 5);
  for (const width of [0, 1, 2, 3, 4, 12, 20]) {
    for (const line of view.render(width)) {
      assert.ok(visibleWidth(line) <= width);
      assert.match(line, /^\x1b\[2m/);
    }
  }
  view.setEntries([{ ...thinking, text: "" }]);
  assert.deepEqual(plain(view), ["⠙ Thinking..."]);
});

test("工具显示真实增删颜色，Bash 单行截断，错误与效果未知保留", () => {
  const view = new EventFlowView();
  view.setEntries([tool({ name: "edit", editStats: { added: 114, removed: 514 } })]);
  assert.deepEqual(plain(view), ["● Edit", "  ⎿ script.py +114 -514"]);
  assert.match(view.render(80)[0]!, /\x1b\[32m●\x1b\[0m/);
  assert.match(view.render(80)[1]!, /\x1b\[32m\+114\x1b\[0m/);
  assert.match(view.render(80)[1]!, /\x1b\[31m-514\x1b\[0m/);
  view.setEntries([tool({ name: "write", target: "output.txt", editStats: { added: 3, removed: 0 } })]);
  assert.deepEqual(plain(view), ["● Write", "  ⎿ output.txt +3 -0"]);
  view.setEntries([tool({ name: "bash", target: "/home/user/venv/bin/python\nscript.py --verbose" })]);
  assert.deepEqual(plain(view, 30), ["● Bash", "  ⎿ /home/user/venv/bin/pyt..."]);
  view.setEntries([tool({ status: "error", summary: "permission denied" })]);
  assert.match(view.render(80)[0]!, /\x1b\[31m●\x1b\[0m/);
  assert.match(plain(view).join("\n"), /script.py · permission denied/);
  assert.match(view.render(80).join("\n"), /\x1b\[31mpermission denied/);
  view.setEntries([tool({ name: "custom_tool", status: "effect_unknown" })]);
  assert.deepEqual(plain(view), ["● custom_tool", "  ⎿ script.py · 效果未知"]);
});

test("Sweeping 总在最后且不计排队；终态分别显示成功、失败、取消与中断", () => {
  let now = Date.parse(at) + 42_000;
  const view = new EventFlowView(() => now);
  const running: FlowEntry = { ...position, kind: "task", task: task() };
  view.setEntries([running, message("正在输出", { key: "answer" })]);
  assert.deepEqual(plain(view), ["● 正在输出", "", "● Sweeping · Elapsed 42s"]);
  now = Date.parse(at) + 12 * 80;
  assert.match(view.render(80).at(-1)!, /\x1b\[32mS/);
  now = Date.parse(at) + 3 * 80;
  assert.match(view.render(80).at(-1)!, /\x1b\[97mS/);
  now = Date.parse(at) + 9 * 80;
  assert.match(view.render(80).at(-1)!, /\x1b\[32mS/);
  for (const [status, marker, label, color] of [
    ["completed", " ", "Done", "2"], ["failed", "✗", "Failed", "31"],
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

test("任务耗时按天、小时、分钟和秒显示，省略零单位并向下取整", () => {
  for (const [elapsedMs, duration] of [
    [-1000, "0s"], [0, "0s"], [999, "0s"], [59_999, "59s"],
    [60_000, "1m"], [61_999, "1m 1s"], [3_599_999, "59m 59s"],
    [3_600_000, "1h"], [3_661_999, "1h 1m 1s"],
    [86_400_000, "1d"], [90_061_999, "1d 1h 1m 1s"],
  ] as const) {
    const now = Date.parse(at) + elapsedMs;
    const view = new EventFlowView(() => now);
    view.setEntries([{ ...position, kind: "task", task: task() }]);
    assert.deepEqual(plain(view), [`● Sweeping · Elapsed ${duration}`], `${elapsedMs}: Elapsed`);
    view.setEntries([{ ...position, kind: "task", task: task({ status: "completed", endedAt: new Date(now).toISOString() }) }]);
    assert.ok(plain(view)[0]!.startsWith(`  Done in ${duration} · At `), `${elapsedMs}: Done in`);
  }
});

test("运行计时显示最近成功 todo_write 进度，清单更新不保留旧缓存", () => {
  const view = new EventFlowView(() => Date.parse(at) + 42_000);
  const running: FlowEntry = { ...position, key: "task", kind: "task", task: task() };
  const todos = [{ content: "已完成", status: "completed" }, { content: "待完成", status: "pending" }];
  const successful = tool({ key: "todos", name: "todo_write", params: { todos } });
  const entries = [successful, running];
  view.setEntries([running]);
  assert.equal(plain(view).at(-1), "● Sweeping · Elapsed 42s");
  view.setEntries(entries);
  assert.equal(plain(view).at(-1), "● Sweeping · Elapsed 42s [1/2]");
  for (const status of ["error", "running"] as const) {
    view.setEntries([...entries, tool({ key: "unfinished-todos", name: "todo_write", status, params: { todos: [] } })]);
    assert.equal(plain(view).at(-1), "● Sweeping · Elapsed 42s [1/2]");
  }
  view.setEntries(entries);
  todos[1]!.status = "completed";
  assert.equal(plain(view).at(-1), "● Sweeping · Elapsed 42s [2/2]");
  running.task.status = "awaiting_confirmation";
  assert.equal(plain(view).at(-1), "● Sweeping · Elapsed 42s [2/2] · waiting for approval");
  view.setEntries([...entries, tool({ key: "cleared-todos", name: "todo_write", params: { todos: [] } })]);
  assert.equal(plain(view).at(-1), "● Sweeping · Elapsed 42s · waiting for approval");
  view.setEntries(entries);
  running.task.status = "completed";
  running.task.endedAt = new Date(Date.parse(at) + 42_000).toISOString();
  assert.ok(plain(view).at(-1)!.startsWith("  Done in 42s · At "));
  assert.doesNotMatch(plain(view).at(-1)!, /\[2\/2\]/);
});

test("长事件流刷新只排版变化的条目，换宽和失效后重新排版", () => {
  const view = new EventFlowView();
  const renderEntry = mock.method(view as unknown as { renderEntry(entry: FlowEntry, width: number): string[] }, "renderEntry");
  const entries = Array.from({ length: 1000 }, (_, index) => message(`第 ${index} 条 **历史正文**`, { key: `history:${index}` }));
  view.setEntries(entries);
  const original = view.render(80);
  assert.equal(renderEntry.mock.callCount(), entries.length);

  // 定时刷新和输入引起的布局会反复渲染，补读还可能重建相同条目。
  view.setEntries(entries.map((entry) => ({ ...entry })));
  assert.deepEqual(view.render(80), original);
  assert.equal(renderEntry.mock.callCount(), entries.length, "未变化的历史不能在每一帧重复排版");
  entries[500] = message("更新后的正文", { key: "history:500" });
  view.setEntries(entries);
  assert.match(view.render(80).join("\n"), /更新后的正文/);
  assert.equal(renderEntry.mock.callCount(), entries.length + 1, "只重新排版变化的一条");

  view.render(40);
  assert.equal(renderEntry.mock.callCount(), entries.length * 2 + 1);
  view.invalidate();
  view.render(40);
  assert.equal(renderEntry.mock.callCount(), entries.length * 3 + 1);
  view.setEntries([]);
  assert.deepEqual(view.render(40), []);
  view.setEntries(entries);
  view.render(40);
  assert.equal(renderEntry.mock.callCount(), entries.length * 4 + 1, "移出的条目释放缓存");
});

test("条目原地更新与运行计时推进均刷新显示，缓存不保留旧状态", () => {
  let now = Date.parse(at);
  const view = new EventFlowView(() => now);
  const entries: FlowEntry[] = [
    message("旧正文", { key: "message", truncated: true }),
    tool({ key: "tool", status: "running", editStats: { added: 1, removed: 0 } }),
    { ...position, key: "thinking", kind: "thinking", text: "思考", startedAt: at, endedAt: null },
    { ...position, key: "command", kind: "command", line: "/mode", result: null, isError: false },
    { ...position, key: "note", kind: "note", text: "旧提示" },
    { ...position, key: "task", kind: "task", task: task() },
  ];
  view.setEntries(entries);
  view.render(80);
  const check = () => {
    const fresh = new EventFlowView(() => now);
    fresh.setEntries(entries);
    assert.deepEqual(view.render(80), fresh.render(80));
  };
  now += 5000;
  check();
  assert.match(plain(view).join("\n"), /Elapsed 5s/);
  for (const entry of entries) {
    switch (entry.kind) {
      case "message": entry.text = "新正文"; entry.truncated = false; break;
      case "tool": entry.status = "error"; entry.summary = "失败原因"; entry.target = "other.py"; entry.editStats!.added = 10; break;
      case "thinking": entry.endedAt = new Date(now).toISOString(); break;
      case "command": entry.result = "命令失败"; entry.isError = true; break;
      case "note": entry.text = "新提示"; break;
      case "task": entry.task.status = "failed"; entry.task.endedAt = new Date(now).toISOString(); entry.task.errorMessage = "任务失败"; break;
    }
    check();
  }
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
  assert.doesNotMatch(lines.join("\n"), /\/expand/);
  for (const width of [1, 18, 80]) {
    for (const line of view.render(width)) {
      assert.equal(visibleWidth(line), width, "换行后的用户消息也铺满背景");
      assert.match(line, /^\x1b\[48;5;236m/);
      assert.match(line, /\x1b\[49m$/, "每行末尾恢复默认背景");
      assert.doesNotMatch(line, /\x1b\[0m(?!\x1b\[48;5;236m)/, "内部样式重置后仍保留灰底");
    }
  }
});

test("Mermaid 完成后渲染字符图，中文框线对齐，过宽和不支持的内容保留源码", () => {
  const view = new EventFlowView();
  const text = "前文\n\n```mermaid\nflowchart LR\n A[开始] --> B[结束]\n```\n\n后文";
  view.setEntries([message(text)]);
  assert.match(plain(view).join("\n"), /A\[开始\] --> B\[结束\]/, "流式生成时保留源码");
  view.setEntries([message(text, { streaming: false })]);
  const rendered = plain(view);
  assert.match(rendered.join("\n"), /开始.*►.*结束/);
  assert.doesNotMatch(rendered.join("\n"), /A\[开始\]/);
  assert.match(rendered.join("\n"), /前文[\s\S]*后文/);
  const diagram = rendered.filter((line) => /[┌│└]/.test(line));
  assert.ok(diagram.length >= 3);
  assert.equal(new Set(diagram.map(visibleWidth)).size, 1, "中文标签与上下边框使用相同列宽");
  assert.doesNotMatch(rendered.join("\n"), /\u200b/);
  assert.match(plain(view, 20).join("\n"), /flowchart LR/, "过宽图表回退源码");
  assert.match(plain(view, 80).join("\n"), /►/, "终端变宽后重新渲染");
  for (const code of ["pie\n\"A\": 1", "invalid syntax", "flowchart RL\n A --> B", "flowchart LR\n A[👩‍💻] --> B", "flowchart TD\n" + "%% comment\n".repeat(101)]) {
    view.setEntries([message("```mermaid\n" + code + "\n```", { streaming: false })]);
    assert.match(plain(view).join("\n"), new RegExp(code.split("\n")[0]!));
    assert.doesNotMatch(plain(view).join("\n"), /[┌┐]/);
  }
  view.setEntries([message("> ```mermaid\n> flowchart LR\n> A[开始] --> B[结束]\n> ```", { streaming: false })]);
  assert.match(plain(view, 26).join("\n"), /flowchart LR/, "引用内缩进不足时回退源码");
  view.setEntries([message("```python\nprint('hello')\n```", { streaming: false })]);
  assert.match(plain(view).join("\n"), /print\('hello'\)/, "其他语言仍正常渲染");
});

test("历史顶部按所属任务置顶已滚出的用户消息，并保留灰底", () => {
  const view = new EventFlowView();
  view.setEntries([
    message("第一项任务", { key: "input-1", role: "user", taskId: "task-1" }),
    message("", { key: "empty", taskId: "task-1" }),
    message("第一项回答", { key: "answer-1", taskId: "task-1" }),
    tool({ key: "tool-1", taskId: "task-1" }),
    message("第二项任务", { key: "input-2", role: "user", taskId: "task-2" }),
    message("第二项回答", { key: "answer-2", taskId: "task-2" }),
  ]);
  const lines = plain(view);
  assert.deepEqual(view.stickyPrompt(0, 80), [], "顶部用户消息仍可见时不重复显示");
  const first = view.stickyPrompt(lines.indexOf("● 第一项回答"), 80);
  assert.deepEqual(first.map((line) => stripTerminalSequences(line).trimEnd()), ["❯ 第一项任务"]);
  assert.match(first[0]!, /^\x1b\[48;5;236m/);
  assert.match(first[0]!, /\x1b\[49m$/);
  assert.equal(visibleWidth(first[0]!), 80);
  assert.deepEqual(view.stickyPrompt(lines.indexOf("● Read"), 80), first, "同任务工具行继续显示对应提示");
  assert.deepEqual(view.stickyPrompt(lines.indexOf("❯ 第二项任务"), 80), []);
  assert.deepEqual(view.stickyPrompt(lines.indexOf("● 第二项回答"), 80).map((line) => stripTerminalSequences(line).trimEnd()), ["❯ 第二项任务"]);
  assert.deepEqual(view.stickyPrompt(lines.indexOf("● 第一项回答"), 80), first, "向上滚动重新切回第一项任务");
});

test("置顶长用户消息限制行数并省略，换宽和更新后不保留旧提示", () => {
  const view = new EventFlowView();
  const prompt = message("第一行\n第二行\n第三行\n第四行\n第五行", { key: "input", role: "user", taskId: "task-1" });
  const answer = message("回答正文", { key: "answer", taskId: "task-1" });
  view.setEntries([prompt, answer]);
  const top = plain(view, 18).indexOf("● 回答正文");
  assert.deepEqual(view.stickyPrompt(1, 18), [], "长提示仍部分可见时不重复置顶");
  const sticky = view.stickyPrompt(top, 18);
  assert.equal(sticky.length, 3);
  assert.match(stripTerminalSequences(sticky[0]!), /第一行/);
  assert.match(stripTerminalSequences(sticky.at(-1)!), /…|\.\.\./);
  for (const line of sticky) {
    assert.equal(visibleWidth(line), 18);
    assert.match(line, /^\x1b\[48;5;236m/);
    assert.match(line, /\x1b\[49m$/);
  }
  assert.equal(view.stickyPrompt(top, 18, 1).length, 1);
  assert.deepEqual(view.stickyPrompt(top, 18, 0), []);
  assert.deepEqual(view.stickyPrompt(top, 0), []);
  assert.ok(prompt.kind === "message");
  prompt.text = "更新后的中文提示重复重复重复重复重复重复";
  view.setEntries([prompt, answer]);
  const narrowTop = plain(view, 18).indexOf("● 回答正文");
  assert.match(view.stickyPrompt(narrowTop, 18).map(stripTerminalSequences).join("\n"), /更新后的中文提示/);
  const wideTop = plain(view, 80).indexOf("● 回答正文");
  const wide = view.stickyPrompt(wideTop, 80);
  assert.equal(wide.length, 1);
  assert.equal(visibleWidth(wide[0]!), 80);
});

test("没有对应用户消息或任务标识的历史行不置顶其他任务提示", () => {
  const view = new EventFlowView();
  view.setEntries([
    message("任务输入", { key: "input", role: "user", taskId: "task-1" }),
    message("无任务的回答", { key: "unowned" }),
    message("缺少输入的回答", { key: "missing", taskId: "task-2" }),
    { ...position, key: "command", kind: "command", line: "/context", result: "Context Usage", isError: false },
  ]);
  const lines = plain(view);
  for (const text of ["● 无任务的回答", "● 缺少输入的回答", "❯ /context", "  ⎿ Context Usage"]) {
    assert.deepEqual(view.stickyPrompt(lines.indexOf(text), 80), [], text);
  }
  view.setEntries([]);
  assert.deepEqual(view.stickyPrompt(0, 80), [], "清空事件后释放旧提示");
});

test("工具返回行点击内联展开代码 diff，再次点击收起并保留鼠标选择边界", () => {
  const view = new EventFlowView();
  const entry = tool({ name: "edit" });
  view.setEntries([entry]);
  let expanded = false;
  let clicks = 0;
  view.onToggleTool = (item) => {
    clicks++;
    expanded = !expanded;
    view.setToolExpansion(item.key, expanded ? { text: "@@ -41 +42 @@\n-old\n+new\x1b[2J", diff: true, lang: "typescript" } : null);
  };
  const mouse = (y: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent => ({
    y, x: 5, screenX: 5, screenY: y, width: 40, height: 20, type, button: "left", shift: false, alt: false, ctrl: false,
  });
  view.render(40);
  assert.equal(view.handleMouse(mouse(0)), undefined, "工具标题不是展开按钮");
  assert.deepEqual(view.handleMouse(mouse(1, "press")), { handled: true });
  assert.equal(clicks, 0, "按下不展开，只在点击完成后切换");
  assert.equal(view.handleMouse({ ...mouse(1), type: "wheel" }), undefined);
  assert.deepEqual(view.handleMouse(mouse(1)), { handled: true });
  const lines = view.render(40);
  assert.match(lines.join("\n"), /\x1b\[48;5;52m/);
  assert.match(lines.join("\n"), /\x1b\[48;2;0;55;0m/);
  assert.match(plain(view, 40).join("\n"), /41 - old/);
  assert.match(plain(view, 40).join("\n"), /42 \+ new/);
  assert.doesNotMatch(plain(view, 40).join("\n"), /```|@@|参数已截断|点击结果行查看/);
  assert.doesNotMatch(lines.join("\n"), /\x1b\[2J/);
  for (const line of view.render(12)) assert.ok(visibleWidth(line) <= 12);
  view.render(40);
  view.handleMouse(mouse(1));
  assert.equal(clicks, 2);
  assert.deepEqual(plain(view, 40), ["● Edit", "  ⎿ script.py"]);
  view.setToolExpansion(entry.key, { text: "+" + "中文👩‍💻".repeat(2000), diff: true });
  assert.doesNotMatch(plain(view, 40).join("\n"), /内容过长/);
  assert.doesNotMatch(plain(view, 40).join("\n"), /\uFFFD/);
  view.setToolExpansion(entry.key, { text: "", loading: true });
  assert.match(plain(view).join("\n"), /加载中/);
  view.setToolExpansion(entry.key, { text: "离线", error: true });
  assert.match(plain(view).join("\n"), /离线/);
  view.setToolExpansion(entry.key, { text: Array.from({ length: 100 }, (_, i) => `const value${i} = ${i};`).join("\n"), lang: "typescript", totalLines: 114 });
  const write = plain(view, 80);
  assert.match(write[2]!, /1 const value0 = 0;/);
  assert.match(write.at(-1)!, /\.\.\.34 more lines/);
  assert.doesNotMatch(view.render(80).join("\n"), /48;2;0;55;0|48;5;52|```/);
  assert.match(view.render(80).join("\n"), /\x1b\[38;(?:2|5);/, "代码保留真实语法颜色");
  for (const name of ["bash", "read"]) {
    view.setEntries([tool({ name, artifactIds: ["art_1"] })]);
    view.setToolExpansion(entry.key, { text: "真实正文\n[完整正文已捕获：artifact art_1（1270 字节，stdout）——需要更多内容时用 read_artifact 工具按偏移查询]" });
    assert.match(plain(view).join("\n"), /真实正文/);
    assert.doesNotMatch(plain(view).join("\n"), /完整正文已捕获|artifact|read_artifact/);
  }
});
