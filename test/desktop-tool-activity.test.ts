import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { TaskView } from "@ruukoto/core/views.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { activityGroups, conversationActivity } from "../apps/desktop/src/renderer/activity.ts";
import { DesktopInspector } from "../apps/desktop/src/renderer/inspector.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";
import type { DesktopBridge } from "../apps/desktop/src/shared/bridge.ts";

const at = "2026-10-16T00:00:00Z";
const task = (): TaskView => ({ id: "task", sessionId: "a", requestId: "r", input: "问题", inputPurpose: "user", modelSelection: null, submissionDigest: null, status: "running", accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: at, endedAt: null });
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
  flow.apply({ seq: 1, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.thinking", taskId: "task", sessionId: "a", thinkingId: "thinking", messageId: "message", startedAt: at, endedAt: null, text: "不可渲染正文" } });
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
  const session = { id: "a", projectId: "workspace", kind: "dev" as const, workspaceProjectId: null, name: null, branchSource: null, cwd: "/work/root/sub", cwdReal: "/work/root/sub", cwdDev: 1, cwdIno: 1, piSessionId: "a", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm" as const, defaultAccessModeVersion: 0, queueState: "active" as const, queuePauseReason: null, createdAt: at };
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
let ToolActivity: ComponentType<{ model: CodeState; sessionId: string; tools: DiffTool[]; stateKey: string; phase?: "thinking" | "working"; expanded: Record<string, boolean>; onExpand(): void }>;
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
  const next = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [{ ...entry, taskId: "next", toolOpId: "next-op" }] }));
  assert.doesNotMatch(next, /\$ echo 完整命令/);
  const withoutOp = { ...props, tools: [{ ...entry, toolOpId: null }], expanded: { group: true, "a:task:tool:call": true } };
  assert.match(renderToStaticMarkup(createElement(ToolActivity, withoutOp)), /\$ echo 完整命令/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ToolActivity, { ...withoutOp, tools: [{ ...entry, toolOpId: null, taskId: "next" }] })), /\$ echo 完整命令/);
  const read = renderToStaticMarkup(createElement(ToolActivity, { ...props, tools: [tool({ name: "read", params: { path: "actual.ts" }, target: "actual.ts" })] }));
  assert.match(read, /aria-label="打开文件 actual.ts"/);
  assert.equal((read.match(/data-slot="trace-collapsible-trigger"/g) ?? []).length, 1);
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
