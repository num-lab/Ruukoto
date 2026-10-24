import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { activityGroups, conversationActivity, conversationSections, executionDuration } from "../apps/desktop/src/renderer/activity.ts";
import { DesktopInspector } from "../apps/desktop/src/renderer/inspector.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { FakeTransport } from "./helpers/fake-control.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";

const at = "2026-10-16T00:00:00Z";
const task = (): TaskView => ({ id: "task", sessionId: "a", requestId: "r", input: "问题", inputPurpose: "user", modelSelection: null, submissionDigest: null, status: "running", accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: at, endedAt: null });
const thinking = (extra: Partial<Extract<FlowEntry, { kind: "thinking" }>> = {}): Extract<FlowEntry, { kind: "thinking" }> => ({ kind: "thinking", key: "thinking", taskId: "task", at, seq: 0, startedAt: at, endedAt: "2026-10-16T00:00:05Z", text: "实际记录的 reasoning\n保留原有换行", ...extra });
const tool = (extra: Partial<DiffTool> = {}): DiffTool => ({ kind: "tool", key: "tool", taskId: "task", at, seq: 1, name: "bash", target: "echo preview", toolOpId: "op", toolCallId: "call", status: "done", entryId: "entry", params: { command: "echo 完整命令" }, paramsTruncated: false, summary: null, artifactIds: [], ...extra });
const result = (text: string | null, extra: Partial<OpResult<"read_tool_result">> = {}): OpResult<"read_tool_result"> => ({ text: text ?? "", patch: null, writeContent: null, toolName: "bash", isError: false, truncated: false, content: text === null ? null : { text, offset: 0, totalBytes: Buffer.byteLength(text), truncated: false }, ...extra });
function harness(request: DesktopBridge["request"]) {
  const view = new ViewState(); view.tasks.set("task", task());
  const inspector = new DesktopInspector({ request }, view, async () => {}, () => {});
  inspector.parentSessionId = "a";
  return { view, inspector };
}
function paramPage(text: string, offset = 0, totalBytes = Buffer.byteLength(text)): OpResult<"get_tool_op_params"> {
  return { toolOp: { id: "op", taskId: "task", toolName: "bash", sdkCallId: "call", intentRecordedAt: at, authorization: null, resultSummary: null, isError: false, effectUnknown: false, recordedResultAt: at }, params: { text, offset, totalBytes, truncated: offset + Buffer.byteLength(text) < totalBytes } };
}

test("执行状态只用真实阶段，保留思考批次与任务边界，Working 不重复历史", () => {
  assert.deepEqual(activityGroups([tool(), tool({ taskId: "other", key: "other" })]).map(group => group.length), [1, 1]);
  const view = new ViewState(); view.tasks.set("task", task());
  const flow = view.openSession("a").flow;
  flow.apply({ seq: 1, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.thinking", taskId: "task", sessionId: "a", thinkingId: "thinking", messageId: "message", startedAt: at, endedAt: null, text: "实际记录的正文" } });
  assert.equal(conversationActivity(view, "a", true).phase, "thinking");
  assert.equal(conversationActivity(view, "a", false).phase, null);
  for (const status of ["awaiting_confirmation", "completed", "interrupted", "canceled", "failed"] as const) { view.tasks.get("task")!.status = status; assert.equal(conversationActivity(view, "a", true).phase, null); }
  view.tasks.get("task")!.status = "running";
  view.tasks.get("task")!.cancelRequested = true;
  assert.equal(conversationActivity(view, "a", true).phase, null);
  view.tasks.get("task")!.cancelRequested = false;
  view.openSession("a").queueState = "paused";
  assert.equal(conversationActivity(view, "a", true).phase, null);
  view.openSession("a").queueState = "active";
  for (const [seq, id] of [[2, "one"], [3, "two"]] as const) flow.apply({ seq, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.tool_intent", taskId: "task", toolOpId: id, sdkCallId: id, toolName: "bash", params: { command: id } } });
  flow.apply({ seq: 4, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.tool_result", taskId: "task", toolOpId: "one", summary: "完成", isError: false, artifactIds: [] } });
  const working = conversationActivity(view, "a", true);
  assert.equal(working.phase, "working");
  assert.deepEqual(working.tools.map(item => item.status), ["done", "running"]);
  assert.equal(working.groups.flat().filter(item => item.kind === "tool").length, 0);
  view.tasks.get("task")!.status = "completed";
  assert.equal(conversationActivity(view, "a", true).phase, null);
  assert.equal(conversationActivity(view, "a", true).groups.flat().filter(item => item.kind === "tool").length, 2);
  const agentView = new ViewState(); agentView.tasks.set("task", task());
  agentView.openSession("a").flow.apply({ seq: 1, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.tool_intent", taskId: "task", toolOpId: "agent", sdkCallId: "agent", toolName: "subagent_delegate", params: { role: "general" } } });
  assert.equal(conversationActivity(agentView, "a", true).phase, "working");
});

test("请求前、工具参数生成和轮间持续显示状态，只让最新正文阶段替代 Thinking", () => {
  const view = new ViewState(); view.tasks.set("task", task());
  const activity = (items: FlowEntry[]) => conversationActivity(view, "a", true, items);
  assert.equal(activity([]).phase, "thinking");
  assert.equal(activity([thinking()]).phase, "thinking");
  assert.equal(activity([tool()]).phase, "thinking");
  assert.equal(activity([tool()]).thinking, undefined, "轮间不复用已经归属工具组的 reasoning");
  const message: FlowEntry = { kind: "message", key: "message", taskId: "task", at, seq: 0, role: "assistant", text: "正在输出", streaming: true, entryId: null, totalBytes: 0, truncated: false };
  assert.equal(activity([message]).phase, null);
  assert.equal(activity([message, thinking()]).phase, "thinking", "旧正文的 streaming 标记不得压住新阶段");
  const working = activity([message, thinking(), tool({ status: "running" })]);
  assert.equal(working.phase, "working"); assert.equal(working.thinking?.text, thinking().text);
  assert.equal(working.groups.flat().filter(item => item.kind === "thinking").length, 0);
});

test("reasoning 开启同任务工具批次，空事件仍隔开批次，消息与 Agent 不跨组", () => {
  const first = thinking(), second = thinking({ key: "second", text: "第二轮" }), empty = thinking({ key: "empty", text: "" });
  const groups = activityGroups([first, tool(), second, tool({ key: "two" }), empty, tool({ key: "three" }), tool({ key: "agent", name: "subagent_delegate" }), tool({ key: "four" }), thinking({ key: "other", taskId: "other" }), tool({ key: "five" })]);
  assert.deepEqual(groups.map(group => group.map(item => item.key)), [["thinking", "tool"], ["second", "two"], ["empty", "three"], ["agent"], ["four"], ["other"], ["five"]]);
  const view = new ViewState(); view.tasks.set("task", { ...task(), status: "completed" });
  const history = conversationActivity(view, "a", true, [first, tool(), second, tool({ key: "two" }), empty]);
  assert.equal(history.phase, null); assert.equal(history.groups.length, 2);
  assert.equal(history.groups[0][0].kind, "thinking");
  assert.equal(conversationActivity(view, "a", true, [first]).groups.length, 1, "无工具的真实 reasoning 保留独立行");
});

test("工具历史的空 assistant 不拆开 reasoning 与工具组，附件与正文保留边界", () => {
  const view = new ViewState(); view.tasks.set("task", task());
  const flow = view.openSession("a").flow;
  flow.apply({ seq: 1, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.thinking", taskId: "task", sessionId: "a", thinkingId: "recorded", messageId: "message", startedAt: at, endedAt: at, text: "实际原文" } });
  flow.addHistory({ entryId: "empty-call", taskId: "task", inputPurpose: "user", parentId: null, role: "assistant", text: "", timestamp: at, offset: 0, totalBytes: 0, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: true });
  flow.apply({ seq: 2, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.tool_intent", taskId: "task", toolOpId: "op", sdkCallId: "call", toolName: "bash", params: { command: "echo fixture" } } });
  const working = conversationActivity(view, "a", true);
  assert.equal(working.phase, "working"); assert.equal(working.thinking?.text, "实际原文");
  assert.equal(working.groups.flat().filter(item => item.kind === "thinking").length, 0);
  const attachment: FlowEntry = { kind: "message", key: "file", taskId: "task", at, seq: 1, role: "user", text: "", entryId: "file", totalBytes: 0, truncated: false, streaming: false, attachments: [{ id: "attachment", name: "a.txt", size: 1 }] };
  assert.equal(conversationActivity(view, "a", true, [thinking(), attachment, tool({ status: "running" })]).thinking, undefined);
});

test("inline 结果复用字节分页，失配可重试，迟到快照应答无效", async () => {
  const calls: number[] = []; let wrong = true;
  const h = harness(async (_target, op, params) => {
    assert.equal(op, "read_tool_result");
    const offset = Number(params.offset); calls.push(offset);
    return { ok: true, value: result(offset ? "👩‍💻" : "中文", { content: { text: offset ? "👩‍💻" : "中文", offset: offset && wrong ? offset + 1 : offset, totalBytes: Buffer.byteLength("中文👩‍💻"), truncated: true } }) };
  });
  const entry = tool(); await h.inspector.loadTool("a", entry);
  await h.inspector.moreTool("a", entry);
  assert.match(h.inspector.toolResult("a", entry)?.moreError ?? "", /不连续/);
  assert.equal(h.inspector.toolResult("a", entry)?.value?.text, "中文");
  wrong = false; await h.inspector.moreTool("a", entry);
  assert.equal(h.inspector.toolResult("a", entry)?.value?.text, "中文👩‍💻");
  assert.deepEqual(calls, [0, 6, 6]);
  let release!: (value: Awaited<ReturnType<DesktopBridge["request"]>>) => void;
  const late = harness(async () => new Promise(resolve => { release = resolve; }));
  const reading = late.inspector.loadTool("a", entry);
  late.inspector.update({ type: "state", state: "reconnecting" });
  release({ ok: true, value: result("迟到") }); await reading;
  assert.equal(late.inspector.toolResult("a", entry), undefined);
});

test("完整命令按 UTF-8 分页，核实来源后解析，不把截断参数当正文", async () => {
  const text = JSON.stringify({ command: `printf '${"中文👩‍💻".repeat(2000)}'` });
  const first = text.slice(0, text.indexOf("👩"));
  const rest = text.slice(first.length); const offsets: number[] = [];
  const h = harness(async (_target, op, params) => { assert.equal(op, "get_tool_op_params"); const offset = Number(params.offset); offsets.push(offset); return { ok: true, value: paramPage(offset ? rest : first, offset, Buffer.byteLength(text)) }; });
  const entry = tool({ paramsTruncated: true }); await h.inspector.loadToolParams("a", entry);
  assert.equal(h.inspector.toolParams("a", entry)?.value?.command, JSON.parse(text).command);
  assert.deepEqual(offsets, [0, Buffer.byteLength(first)]);
  const bad = harness(async () => ({ ok: true, value: { ...paramPage('{}'), toolOp: { ...paramPage('{}').toolOp, taskId: "other" } } }));
  await bad.inspector.loadToolParams("a", entry);
  assert.match(bad.inspector.toolParams("a", entry)?.error ?? "", /来源/);
  assert.equal(bad.inspector.toolParams("a", entry)?.value, undefined);
});

test("Read 从来源 cwd 映射登记根，截断路径迟到不打开新父会话", async () => {
  const h = harness(async () => ({ ok: true, value: { ...paramPage('{"path":"file.ts"}'), toolOp: { ...paramPage('{}').toolOp, toolName: "read" } } }));
  const session = { id: "a", projectId: "workspace", kind: "dev" as const, workspaceProjectId: null, name: null, branchSource: null, cwd: "/work/root/sub", cwdReal: "/work/root/sub", cwdDev: 1, cwdIno: 1, piSessionId: "a", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm" as const, defaultAccessModeVersion: 0, queueState: "active" as const, queuePauseReason: null, archivedAt: null, createdAt: at };
  h.view.sessions = [session];
  h.view.projects = [{ id: "workspace", name: "工作区", createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at, rootDir: { cwd: "/work/root", cwdReal: "/work/root", dev: 1, ino: 1 } }];
  const read = tool({ name: "read", params: { path: "../file.ts" } });
  assert.equal(await h.inspector.openToolFile("a", read), true);
  const opened = h.inspector.activeTab(); assert.equal(opened?.kind === "file" && opened.path, "file.ts");
  assert.equal(await h.inspector.openToolFile("a", { ...read, params: { path: "../../../outside.ts" } }), false);
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const late = new DesktopInspector({ request: async () => { await wait; return { ok: true, value: { ...paramPage('{"path":"file.ts"}'), toolOp: { ...paramPage('{}').toolOp, toolName: "read" } } }; } }, h.view, async () => {}, () => {});
  late.parentSessionId = "a";
  const loading = late.openToolFile("a", { ...read, paramsTruncated: true });
  late.parentSessionId = "b"; release();
  assert.equal(await loading, null);
  assert.deepEqual(late.tabs(), []);
});

let server: ViteDevServer;
let ToolActivity: ComponentType<{ model: CodeState; sessionId: string; tools: DiffTool[]; thinking?: Extract<FlowEntry, { kind: "thinking" }>; phase?: "thinking" | "working"; expanded: Record<string, boolean>; onExpand(): void }>;
let submitOnEnter: (event: { key: string; shiftKey: boolean; repeat: boolean; nativeEvent: { isComposing?: boolean; keyCode?: number }; preventDefault(): void }, canSend: boolean, send: () => void) => void;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ ToolActivity } = await server.ssrLoadModule("/tool-activity.tsx"));
  ({ submitOnEnter } = await server.ssrLoadModule("/composer.tsx"));
});
after(async () => { await server?.close(); });

test("Enter 发送资格与 IME／Shift／repeat，空输入不调用停止分支", () => {
  let sent = 0, prevented = 0;
  const event = { key: "Enter", shiftKey: false, repeat: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { prevented++; } };
  submitOnEnter(event, true, () => sent++);
  submitOnEnter(event, false, () => sent++);
  for (const extra of [{ shiftKey: true }, { repeat: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) submitOnEnter({ ...event, ...extra }, true, () => sent++);
  assert.equal(sent, 1); assert.equal(prevented, 2);
});

test("Trace 详情显示真实 patch／完整失败命令，Read 不折叠，按任务隔离展开", async () => {
  const model = new CodeState({ request: async () => ({ ok: true, value: result("错误正文", { isError: true }) }) }, () => {});
  model.view.tasks.set("task", task()); model.status = { type: "state", state: "online" };
  const entry = tool({ status: "error" }); await model.inspector.loadTool("a", entry);
  const props = { model, sessionId: "a", tools: [entry], stateKey: "group", expanded: { group: true, "a:task:tool:op": true }, onExpand() {} };
  const html = renderToStaticMarkup(createElement(ToolActivity, props));
  assert.match(html, /Failed to run/); assert.match(html, /data-variant="destructive"/); assert.match(html, /\$ echo 完整命令/); assert.match(html, /错误正文/);
  const agentError = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [{ ...entry, name: "subagent_delegate" }] }));
  assert.match(agentError, /Failed to subagent_delegate/); assert.match(agentError, /错误正文/);
  const uncertain = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [{ ...entry, status: "effect_unknown" }] }));
  assert.match(uncertain, /效果未知/); assert.doesNotMatch(uncertain, /Failed to run|data-variant="destructive"/);
  const waiting = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [tool({ status: "running", toolOpId: "pending-op", toolCallId: "pending-call", entryId: null })] }));
  assert.doesNotMatch(waiting, /等待结果/); assert.match(waiting, /Running/);
  const next = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [{ ...entry, taskId: "next", toolOpId: "next-op" }] }));
  assert.doesNotMatch(next, /\$ echo 完整命令/);
  const withoutOp = { ...props, tools: [{ ...entry, toolOpId: null }], expanded: { group: true, "a:task:tool:call": true } };
  assert.match(renderToStaticMarkup(createElement(ToolActivity, withoutOp)), /\$ echo 完整命令/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ToolActivity, { ...withoutOp, tools: [{ ...entry, toolOpId: null, taskId: "next" }] })), /\$ echo 完整命令/);
  const read = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [tool({ name: "read", params: { path: "actual.ts" }, target: "actual.ts" })] }));
  assert.match(read, /aria-label="打开文件 actual.ts"/);
  assert.equal((read.match(/data-slot="trace-collapsible-trigger"/g) ?? []).length, 0);
  const preview = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [tool({ name: "present", status: "done", params: { path: "actual.ts" }, target: "actual.ts" })] }));
  assert.match(preview, /aria-label="打开预览 actual.ts"/);
  assert.equal((preview.match(/data-slot="trace-collapsible-trigger"/g) ?? []).length, 0);
  const edit = tool({ name: "write", status: "done", entryId: "write" });
  const patch = "@@ -1 +1 @@\n-old\n+new\n";
  let verified = true;
  const writeModel = new CodeState({ request: async () => ({ ok: true, value: result(patch, { patch, toolName: "write", isError: verified ? false : null }) }) }, () => {});
  await writeModel.inspector.loadTool("a", edit);
  const diff = renderToStaticMarkup(createElement(ToolActivity, { ...props, model: writeModel, tools: [edit] }));
  assert.match(diff, /data-variant="added"/); assert.match(diff, /data-variant="removed"/);
  verified = false; await writeModel.inspector.loadTool("a", edit, true);
  const unverified = renderToStaticMarkup(createElement(ToolActivity, { ...props, model: writeModel, tools: [edit] }));
  assert.match(unverified, /未记录可核实的成功结果/); assert.doesNotMatch(unverified, /data-variant="added"/);
});

test("源码高亮保留全部文本、空行与转义，未知扩展名不猜测", async () => {
  const { highlightSource } = await server.ssrLoadModule("/source-highlighting.ts");
  const content = '/* 多行\n注释 */\n\nconst value = "<script>";\n';
  const highlighted: string = highlightSource("test.ts", content);
  assert.match(highlighted, /hljs-comment/); assert.doesNotMatch(highlighted, /<script>/);
  const text = (node: DefaultTreeAdapterTypes.Node): string => node.nodeName === "#text" && "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  assert.equal(text(parseFragment(highlighted)), content);
  assert.equal(highlightSource("unknown.txt", content), null);
});

test("Thinking 展示原文，平铺工具前可展开 reasoning 且只出现一次", () => {
  const model = new CodeState({ request: async () => ({ ok: true, value: {} }) }, () => {});
  const props = { model, sessionId: "a", tools: [tool()], thinking: thinking(), stateKey: "group", expanded: { group: true, "thinking:reasoning": true }, onExpand() {} };
  const active = renderToStaticMarkup(createElement(ToolActivity, { ...props, phase: "thinking" }));
  assert.match(active, /role="region" aria-label="思考内容"/); assert.match(active, /tabindex="0"/); assert.match(active, /Thinking/); assert.match(active, /实际记录的 reasoning/); assert.match(active, /保留原有换行/); assert.doesNotMatch(active, /Thought for/);
  const historical = renderToStaticMarkup(createElement(ToolActivity, props));
  assert.ok(historical.indexOf("Thought for 5s") < historical.indexOf("Ran <code>"));
  assert.equal((historical.match(/实际记录的 reasoning/g) ?? []).length, 1);
  const empty = renderToStaticMarkup(createElement(ToolActivity, { ...props, thinking: thinking({ text: "" }) }));
  assert.doesNotMatch(empty, /Thought for|实际记录的 reasoning/);
});


test("完成且最终正文确认后收起执行记录，延迟结果和失败状态保持展开", () => {
  const view = new ViewState(); view.tasks.set("task", task());
  const reply: Extract<FlowEntry, { kind: "message" }> = { kind: "message", key: "reply", taskId: "task", at, seq: 3, role: "assistant", text: "最终回复", streaming: true, entryId: null, totalBytes: 0, truncated: false };
  const items: FlowEntry[] = [thinking(), tool(), reply];
  const sections = () => conversationSections(view, items, conversationActivity(view, "a", true, items).timeline);
  const activeKey = sections()[0].key;
  assert.equal(sections()[0].completed, false);
  view.tasks.get("task")!.status = "completed";
  assert.equal(sections()[0].completed, false, "完成事件先到，未确认历史正文不能收起");
  reply.streaming = false; reply.entryId = "final-entry";
  assert.equal(sections()[0].key, activeKey, "完成前后沿用同一个 trace 容器");
  assert.equal(sections()[0].completed, true);
  assert.deepEqual(sections().at(-1)!.groups.flat().map(item => item.key), ["reply"]);
  assert.equal(sections().at(-1)!.trace, false);
  for (const status of ["running", "failed", "canceled", "interrupted", "awaiting_confirmation"] as const) { view.tasks.get("task")!.status = status; assert.ok(sections().every(section => !section.completed), status); }
  view.tasks.get("task")!.status = "completed";
  items.push(tool({ key: "later" }));
  assert.ok(sections().every(section => !section.completed), "旧 assistant 后还有工具时不能当最终回复");
  items.pop(); items.pop();
  assert.ok(sections().every(section => !section.completed), "没有最终回复时不自动收起");
});

test("最终回复的全部分段保持可见，排队用户消息不重排或藏进 trace", () => {
  const view = new ViewState(); view.tasks.set("task", { ...task(), status: "completed" });
  const message = (key: string, role: string, taskId = "task"): FlowEntry => ({ kind: "message", key, taskId, at, seq: 3, role, text: key, streaming: false, entryId: role === "assistant" ? "final-entry" : key, totalBytes: 0, truncated: false });
  const items = [thinking(), tool(), message("queued", "user", "next"), tool({ key: "after-queue" }), message("part:0", "assistant"), message("part:1", "assistant")];
  const sections = conversationSections(view, items, activityGroups(items));
  assert.deepEqual(sections.flatMap(section => section.groups.flat()).map(item => item.key), items.map(item => item.key));
  for (const section of sections) if (section.trace) assert.ok(section.groups.flat().every(item => item.kind !== "message" || item.role !== "user"));
  const final = sections.filter(section => section.groups.flat().some(item => item.key.startsWith("part:")));
  assert.equal(final.length, 2); assert.ok(final.every(section => !section.trace));
  const unknown = conversationSections(view, [tool({ taskId: undefined })], [[tool({ taskId: undefined })]]);
  assert.equal(unknown[0].completed, false);
});


test("没有 delta 的最终正文补读成功前保持展开，缺失或失败不误认中间回复", async () => {
  let release!: (value: Awaited<ReturnType<DesktopBridge["request"]>>) => void;
  const model = new CodeState({ request: async () => new Promise(resolve => { release = resolve; }) }, () => {});
  const view = model.view; view.tasks.set("task", { ...task(), status: "completed" });
  const flow = view.openSession("a").flow;
  flow.apply({ seq: 1, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.thinking", taskId: "task", sessionId: "a", thinkingId: "first", messageId: "first", startedAt: at, endedAt: at, text: "准备" } });
  const intermediate = { entryId: "intermediate", taskId: "task", inputPurpose: "user" as const, parentId: null, role: "assistant" as const, text: "中间回复", timestamp: "2026-10-16T00:00:01Z", offset: 0, totalBytes: 12, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false };
  flow.addHistory(intermediate);
  flow.apply({ seq: 2, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.output_entry", taskId: "task", sessionId: "a", messageId: "final", entryId: "final-entry", role: "assistant", sessionFile: "/fixture/session.jsonl" } });
  const sections = () => { const items = flow.items; return conversationSections(view, items, activityGroups(items), undefined, id => model.historyReady("a", id)); };
  assert.equal(sections()[0].completed, true, "补读尚未开始时，当前最后正文确实是中间回复");
  const reading = model.loadEntry("a", "final-entry", "task");
  assert.equal(model.historyReady("a", "task"), false); assert.ok(sections().every(section => !section.completed));
  release({ ok: true, value: { ...intermediate, entryId: "final-entry", text: "最终回复", timestamp: "2026-10-16T00:00:02Z" } }); await reading;
  assert.equal(model.historyReady("a", "task"), true); assert.equal(sections()[0].completed, true);
  const failed = model.loadEntry("a", "missing", "task");
  release({ ok: false, error: { code: "entry_not_found", outcome: "rejected", message: "not found" } }); await failed;
  assert.equal(model.historyReady("a", "task"), false); assert.ok(sections().every(section => !section.completed));
  view.tasks.set("old", { ...task(), id: "old", status: "completed" });
  const oldItems: FlowEntry[] = [thinking({ taskId: "old" }), { kind: "message", key: "old-final", taskId: "old", at, seq: 3, role: "assistant", text: "旧最终回复", entryId: "old-final", streaming: false, totalBytes: 15, truncated: false }];
  assert.equal(conversationSections(view, oldItems, activityGroups(oldItems), undefined, id => model.historyReady("a", id))[0].completed, true, "新任务补读或失败不重开旧任务 trace");
});


test("打开会话先装入历史窗口任务状态，已收起的 trace 不先展开再收起", async () => {
  const completed = { ...task(), status: "completed" as const, historyEntryIds: ["final-entry"] };
  const entry = (entryId: string, role: string, text: string, timestamp: string, extra: Partial<HistoryEntryView> = {}): HistoryEntryView => ({ entryId, taskId: "task", inputPurpose: "user", parentId: null, role, text, timestamp, offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false, ...extra });
  const transport = new FakeTransport({ handlers: {
    list_session_summaries: () => [],
    read_history: () => ({ fileAvailable: true, hasPartialTail: false, nextBefore: null, entries: [entry("ask", "user", "问题", "2026-10-16T00:00:01Z"), entry("progress", "assistant", "中间进度", "2026-10-16T00:00:02Z"), entry("final-entry", "assistant", "最终回复", "2026-10-16T00:00:03Z", { truncated: true, totalBytes: 40 })] }),
    list_tasks: async () => { await settled; return { tasks: [completed], hasMore: false }; },
    get_task: () => ({ task: completed, toolOps: [], confirmations: [], artifacts: [], outputPreview: null, seq: 5 }),
    read_task_events: () => ({ events: [], nextAfter: null }),
    read_history_entry: () => entry("final-entry", "assistant", "最终回复", "2026-10-16T00:00:03Z"),
  } });
  let resolveStatuses!: () => void;
  const settled = new Promise<void>(resolve => { resolveStatuses = resolve; });
  const observed: boolean[] = [];
  const model = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, () => {
    if (!model.view.sessionViews.get("a")?.historyLoaded) return;
    const view = model.view, items = model.view.openSession("a").flow.items;
    for (const section of conversationSections(view, items, activityGroups(items), undefined, id => model.historyReady("a", id))) if (section.trace) observed.push(section.completed);
  });
  const loading = model.loadHistory("a");
  resolveStatuses();
  await loading;
  assert.ok(observed.length > 0, "历史页可见后 trace 至少渲染过一次");
  assert.ok(observed.every(Boolean), "任务状态先于历史页装入，trace 从首次可见起就保持收起");
});

test("历史页已含条目的正文补全不挡自动收起", async () => {
  let release!: (value: Awaited<ReturnType<DesktopBridge["request"]>>) => void;
  const model = new CodeState({ request: async () => new Promise(resolve => { release = resolve; }) }, () => {});
  const view = model.view; view.tasks.set("task", { ...task(), status: "completed" });
  const final = { entryId: "final-entry", taskId: "task", inputPurpose: "user" as const, parentId: null, role: "assistant" as const, text: "最终回复", timestamp: "2026-10-16T00:00:02Z", offset: 0, totalBytes: 40, truncated: true, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false };
  view.openSession("a").flow.addHistory(final);
  const reading = model.loadEntry("a", "final-entry", "task");
  assert.equal(model.historyReady("a", "task"), true, "条目身份已在历史页里，补全正文不重开 trace");
  release({ ok: true, value: { ...final, text: "最终回复的完整正文", totalBytes: Buffer.byteLength("最终回复的完整正文"), truncated: false } }); await reading;
  assert.equal(model.historyReady("a", "task"), true);
});


test("Worked for 使用实际任务开始结束时间，不推测缺失耗时", async () => {
  const { ExecutionTrace } = await server.ssrLoadModule("/tool-activity.tsx");
  const props = { completed: true, failed: false, duration: "5s", stateKey: "run", expanded: {}, onExpand() {}, children: "actual calls" };
  const closed = renderToStaticMarkup(createElement(ExecutionTrace, props));
  assert.match(closed, /Worked for 5s/); assert.doesNotMatch(closed, /actual calls/);
  assert.match(renderToStaticMarkup(createElement(ExecutionTrace, { ...props, expanded: { run: true } })), /actual calls/);
  assert.equal(executionDuration(at, "2026-10-16T00:00:05Z"), "5s");
  assert.equal(executionDuration(at, "2026-10-16T00:01:25Z"), "1m 25s");
  assert.equal(executionDuration("2026-10-16T00:00:00.100Z", "2026-10-16T00:00:00.000Z"), undefined);
  assert.equal(executionDuration(null, at), undefined);
  assert.equal(executionDuration(at, null), undefined);
  assert.equal(executionDuration(at, "invalid"), undefined);
  assert.equal(executionDuration("2026-10-16T00:01:00Z", at), undefined);
});


test("Trace 按动作显示思考、委派、读取、编辑、写入、命令和搜索图标", async () => {
  const model = new CodeState({ request: async () => ({ ok: true, value: {} }) }, () => {});
  const render = (tools: DiffTool[]) => renderToStaticMarkup(createElement(ToolActivity, { model, sessionId: "a", tools, expanded: {}, onExpand() {} }));
  for (const [name, icon] of [["read", "file-text"], ["edit", "file-pen-line"], ["write", "file-plus-2"], ["bash", "terminal"], ["grep", "search"], ["web_search", "search"], ["unknown", "wrench"], ["subagent_delegate", "bot"]]) {
    const html = render([tool({ name })]);
    assert.match(html, new RegExp(`lucide-${icon}(?: |")`));
    assert.doesNotMatch(html, /lucide-circle-check/);
  }
  const thought = renderToStaticMarkup(createElement(ToolActivity, { model, sessionId: "a", tools: [], thinking: thinking(), expanded: {}, onExpand() {} }));
  assert.match(thought, /lucide-brain/);
  assert.match(render([tool({ status: "error" })]), /lucide-circle-alert/);
  model.view.tasks.set("task", task()); model.status = { type: "state", state: "online" };
  assert.match(render([tool({ status: "running" })]), /class="[^"]*\blucide-loader-circle\b[^"]*\banimate-spin\b/);
  const { ExecutionTrace } = await server.ssrLoadModule("/tool-activity.tsx");
  assert.match(renderToStaticMarkup(createElement(ExecutionTrace, { completed: true, failed: false, duration: "5s", stateKey: "run", expanded: {}, onExpand() {} })), /lucide-list-checks/);
});
