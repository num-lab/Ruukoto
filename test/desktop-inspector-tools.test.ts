import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { Project, Session } from "@ruukoto/core/types.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { browserAddress, browserNavigation, moveBrowser, navigateBrowser, type BrowserNavigation } from "../apps/desktop/src/renderer/browser-navigation.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

const at = "2026-10-16T00:00:00.000Z";
const workspace = (id: string): Project => ({ id, name: `真实工作区 ${id}`, createRequestId: null, rootDir: { cwd: `/work/${id}`, cwdReal: `/work/${id}`, dev: 1, ino: id === "w1" ? 1 : 2 }, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at });
const session = (id: string, projectId = "w1"): Session => ({ id, projectId, kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: `/work/${projectId}`, cwdReal: `/work/${projectId}`, cwdDev: 1, cwdIno: projectId === "w1" ? 1 : 2, piSessionId: id, sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, createdAt: at });
const directory = (workspaceId = "w1", path = "", name = "actual.txt"): OpResult<"list_workspace_files"> => ({ workspaceId, path, entries: [{ kind: "file", path: path ? `${path}/${name}` : name, name }], truncated: false });
const file = (workspaceId = "w1", path = "actual.txt", content = "真实文件内容"): OpResult<"read_workspace_file"> => ({ workspaceId, path, kind: "text", size: Buffer.byteLength(content), content });
function gate() {
  let release!: () => void;
  return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function harness(handlers: FakeHandlers = {}) {
  const transport = new FakeTransport({ handlers: { work_list: () => ({ works: [] }), list_workspace_files: params => directory(params.workspace_id, params.path), read_workspace_file: params => file(params.workspace_id, params.path), ...handlers } });
  const bridge: Pick<DesktopBridge, "request"> = { request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) };
  const model = new CodeState(bridge, () => {});
  const initial = { snapshot: fakeSnapshot({ projects: [workspace("w1"), workspace("w2")], sessions: [session("a"), session("b"), session("c", "w2")] }), replay: [], seq: 0 };
  model.view.applySnapshot(initial, false);
  model.status = { type: "state", state: "online" };
  const snapshot = (instanceId = "inst-1") => {
    const update: Extract<DesktopUpdate, { type: "snapshot" }> = { type: "snapshot", instanceChanged: instanceId !== model.view.instanceId, result: { ...initial, snapshot: { ...initial.snapshot, instanceId }, seq: 100 } };
    model.view.applySnapshot(update.result, update.instanceChanged);
    model.inspector.update(update);
  };
  return { model, inspector: model.inspector, view: model.view, transport, snapshot };
}

test("内置浏览器仅接受无凭据 HTTP(S)，域名和本机简写归一化", () => {
  for (const address of ["", " ", "javascript:alert(1)", "data:text/html,<script>x</script>", "file:///tmp/file", "blob:https://example.com/id", "mailto:a@example.com", "http://user:password@example.com", "https://user@example.com", "http://", "http://[bad]"]) assert.equal(browserAddress(address), null, address);
  assert.equal(browserAddress(" example.com/path "), "https://example.com/path");
  assert.equal(browserAddress("localhost:5173/page"), "http://localhost:5173/page");
  assert.equal(browserAddress("127.0.0.1:8000/"), "http://127.0.0.1:8000/");
  assert.equal(browserAddress("[::1]:8000/"), "http://[::1]:8000/");
  assert.equal(browserAddress("https://example.com/a?q=b#c"), "https://example.com/a?q=b#c");
});
test("浏览器前后退保留分支边界，重复地址刷新，非法地址不改变当前页", () => {
  const initial = browserNavigation("about:blank");
  assert.equal(initial.draft, "");
  assert.equal(moveBrowser(initial, -1), initial);
  const first = navigateBrowser(initial, "example.com/first");
  const second = navigateBrowser(first, "example.com/second");
  const previous = moveBrowser(second, -1);
  assert.equal(previous.history[previous.index], "https://example.com/first");
  assert.equal(moveBrowser(previous, 1).draft, "https://example.com/second");
  const branch = navigateBrowser(previous, "example.com/branch");
  assert.deepEqual(branch.history, ["about:blank", "https://example.com/first", "https://example.com/branch"]);
  assert.equal(moveBrowser(branch, 1), branch);
  const again = navigateBrowser(branch, branch.draft);
  assert.deepEqual(again.history, branch.history);
  assert.equal(again.revision, branch.revision + 1);
  const invalid = navigateBrowser(again, "javascript:x");
  assert.equal(invalid.error, true);
  assert.equal(invalid.draft, "javascript:x");
  assert.equal(invalid.history, again.history);
  assert.equal(invalid.index, again.index);
  assert.equal(invalid.revision, again.revision);
  assert.deepEqual(initial, browserNavigation("about:blank"));
});

for (const kind of ["directory", "file"] as const) for (const boundary of ["snapshot", "instance", "offline"] as const) for (const fails of [false, true]) test(`只读${kind}跨${boundary}不安装迟到${fails ? "错误" : "内容"}`, async () => {
  const blocked = gate();
  let fresh = false;
  let began = false;
  const pause = async () => { if (!fresh) { began = true; await blocked.wait; if (fails) throw new Error("旧读取失败"); } };
  const h = harness({
    list_workspace_files: async params => { const old = !fresh; if (kind === "directory") await pause(); return directory(params.workspace_id, params.path, old ? "stale.txt" : "fresh.txt"); },
    read_workspace_file: async params => { const old = !fresh; if (kind === "file") await pause(); return file(params.workspace_id, params.path, old ? "旧内容" : "新内容"); },
  });
  const load = () => kind === "directory" ? h.inspector.loadDirectory("w1", "src") : h.inspector.loadFile("w1", "src/actual.txt");
  const state = () => kind === "directory" ? h.inspector.directories.get(h.inspector.fileKey("w1", "src")) : h.inspector.files.get(h.inspector.fileKey("w1", "src/actual.txt"));
  const old = load();
  await waitFor("旧只读请求在途", () => began);
  if (boundary === "offline") h.inspector.update({ type: "state", state: "reconnecting" });
  else h.snapshot(boundary === "instance" ? "other" : "inst-1");
  assert.equal(state(), undefined);
  fresh = true;
  if (boundary === "offline") h.inspector.update({ type: "state", state: "online" });
  await load();
  blocked.release();
  await old;
  const current = state();
  assert.equal(current?.loading, false);
  assert.equal(current?.error, undefined);
  assert.ok(JSON.stringify(current?.value).includes(kind === "directory" ? "fresh.txt" : "新内容"));
  assert.ok(!JSON.stringify(current?.value).includes(kind === "directory" ? "stale.txt" : "旧内容"));
});

test("CodeState 真实断线路径转发只读缓存失效，迟到文件不在离线时复活", async () => {
  const blocked = gate();
  let began = false;
  const h = harness({ read_workspace_file: async () => { began = true; await blocked.wait; return file(); } });
  const old = h.inspector.loadFile("w1", "actual.txt");
  await waitFor("文件读取已开始", () => began);
  try {
    h.model.update({ type: "state", state: "reconnecting" });
    assert.equal(h.inspector.files.size, 0);
  } finally { blocked.release(); await old; }
  assert.equal(h.inspector.files.size, 0);
});

test("文件关闭重开丢弃原读取，目录手动重试只安装最新请求", async () => {
  for (const kind of ["file", "directory"] as const) {
    const blocked = gate();
    let count = 0;
    const h = harness({
      read_workspace_file: async () => { if (kind === "file" && ++count === 1) { await blocked.wait; return file("w1", "actual.txt", "过期文件"); } return file("w1", "actual.txt", "重新打开的文件"); },
      list_workspace_files: async () => { if (kind === "directory" && ++count === 1) { await blocked.wait; return directory("w1", "", "old.txt"); } return directory("w1", "", "new.txt"); },
    });
    h.inspector.openParent("a");
    const old = kind === "file" ? h.inspector.loadFile("w1", "actual.txt") : h.inspector.loadDirectory("w1", "");
    await waitFor("第一份读取已开始", () => count > 0);
    if (kind === "file") {
      h.inspector.openFile("w1", "actual.txt");
      h.inspector.closeTab(h.inspector.activeTab()!.id);
      h.inspector.openFile("w1", "actual.txt");
      await waitFor("新文件读取完成", () => !!h.inspector.files.get("w1:actual.txt")?.value);
    } else await h.inspector.loadDirectory("w1", "", true);
    blocked.release();
    await old;
    const value = kind === "file" ? h.inspector.files.get("w1:actual.txt")?.value : h.inspector.directories.get("w1:")?.value;
    assert.ok(JSON.stringify(value).includes(kind === "file" ? "重新打开的文件" : "new.txt"));
    assert.equal(count, 2);
  }
});

test("只读缓存和文件夹按工作区隔离，browser及预览模式按父会话隔离", async () => {
  const h = harness();
  h.inspector.openParent("a");
  h.inspector.openFiles();
  assert.equal(h.inspector.activeTab()?.kind, "files");
  h.inspector.openFile("w1", "actual.txt");
  const aFile = h.inspector.activeTab();
  assert.equal(aFile?.kind, "file");
  if (aFile?.kind === "file") aFile.mode = "source";
  h.inspector.folders.set(h.inspector.fileKey("w1", "src"), true);
  h.inspector.openBrowser("https://example.com/a");
  const aBrowser = h.inspector.activeTab();
  h.inspector.openBrowser();
  assert.equal(h.inspector.tabs().filter(tab => tab.kind === "browser").length, 1);
  h.inspector.openParent("b");
  assert.equal(h.inspector.tabs().length, 0);
  h.inspector.openFile("w1", "actual.txt");
  const bFile = h.inspector.activeTab();
  assert.notEqual(aFile, bFile);
  assert.equal(bFile?.kind === "file" && bFile.mode, "preview");
  h.inspector.openBrowser();
  const bBrowser = h.inspector.activeTab();
  assert.equal(bBrowser?.kind === "browser" && bBrowser.navigation.history[0], "about:blank");
  assert.notEqual(aBrowser, bBrowser);
  h.inspector.openParent("c");
  h.inspector.openFiles();
  assert.equal(h.inspector.activeTab()?.kind === "files" && h.inspector.workspace()?.id, "w2");
  assert.equal(h.inspector.folders.get(h.inspector.fileKey("w2", "src")), undefined);
  await h.inspector.loadFile("w2", "actual.txt");
  await waitFor("两个工作区文件均已读取", () => !!h.inspector.files.get("w1:actual.txt")?.value);
  assert.equal(h.inspector.files.get("w1:actual.txt")?.value?.workspaceId, "w1");
  assert.equal(h.inspector.files.get("w2:actual.txt")?.value?.workspaceId, "w2");
  h.inspector.openParent("a");
  assert.equal(h.inspector.activeTab(), aBrowser);
  assert.equal(aFile?.kind === "file" && aFile.mode, "source");
  h.inspector.closeTab(aBrowser!.id);
  h.inspector.openBrowser();
  assert.equal(h.inspector.activeTab()?.kind === "browser" && h.inspector.activeTab() !== aBrowser, true);
  assert.ok(h.transport.requests.every(request => ["work_list", "list_workspace_files", "read_workspace_file"].includes(request.op)));
  for (const request of h.transport.requests.filter(request => request.op !== "work_list")) assert.ok(!Object.hasOwn(request.params as object, "cwd"));
});

test("文件树使用会话的工作区组织归属，不拿来源 cwd 冒充展示根", async () => {
  const h = harness();
  h.view.sessions.find(item => item.id === "a")!.workspaceProjectId = "w2";
  h.inspector.openParent("a");
  h.inspector.openFiles();
  const tab = h.inspector.activeTab();
  assert.equal(tab?.kind === "files" && tab.workspaceId, "w2");
  await waitFor("映射工作区目录已读取", () => !!h.inspector.directories.get("w2:")?.value);
  const request = h.transport.requests.find(request => request.op === "list_workspace_files");
  assert.deepEqual(request?.params, { workspace_id: "w2", path: "" });
});

let server: ViteDevServer;
let FilePreview: ComponentType<{ file: OpResult<"read_workspace_file"> | undefined; path: string; mode: "preview" | "source"; onMode: (mode: "preview" | "source") => void; onFiles: () => void; onUrl: (url: string) => void }>;
let WorkspaceFiles: ComponentType<{ model: CodeState; workspaceId: string }>;
let BrowserPanel: ComponentType<{ navigation: BrowserNavigation; onChange: (navigation: BrowserNavigation) => void }>;
let Conversation: ComponentType<{ model: CodeState; sessionId: string }>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], define: { "window.location.origin": JSON.stringify("http://127.0.0.1:9999"), "window.location.protocol": JSON.stringify("http:") }, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ FilePreview, WorkspaceFiles, BrowserPanel } = await server.ssrLoadModule("/inspector-panels.tsx"));
  ({ Conversation } = await server.ssrLoadModule("/conversation.tsx"));
});
after(async () => { await server?.close(); });

test("浏览器实际组件保持空初始页、sandbox、无 referrer，非法输入有明确结果", () => {
  const blank = renderToStaticMarkup(createElement(BrowserPanel, { navigation: browserNavigation("about:blank"), onChange() {} }));
  assert.match(blank, /src="about:blank"/);
  assert.match(blank, /sandbox="allow-scripts allow-forms"/);
  assert.match(blank, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(blank, /allow-same-origin|allow-top-navigation|allow-popups|allow-downloads|车票|浏览成功/);
  const invalid = renderToStaticMarkup(createElement(BrowserPanel, { navigation: navigateBrowser(browserNavigation("about:blank"), "javascript:evil"), onChange() {} }));
  assert.match(invalid, /role="alert"/);
  assert.match(invalid, /aria-invalid="true"/);
  const self = renderToStaticMarkup(createElement(BrowserPanel, { navigation: browserNavigation("http://127.0.0.1:9999/"), onChange() {} }));
  assert.match(self, /此地址是桌面界面本身/);
  assert.doesNotMatch(self, /<iframe/);
});

test("真实目录组件只展示后台返回的目录，不迁入样例或写操作", async () => {
  const h = harness({ list_workspace_files: () => ({ workspaceId: "w1", path: "", entries: [{ kind: "directory", name: "真实目录", path: "真实目录" }, { kind: "file", name: "真实文档.md", path: "真实文档.md" }], truncated: true }) });
  await h.inspector.loadDirectory("w1", "");
  const html = renderToStaticMarkup(createElement(WorkspaceFiles, { model: h.model, workspaceId: "w1" }));
  assert.match(html, /真实工作区 w1/);
  assert.match(html, /aria-label="真实目录"/);
  assert.match(html, /aria-label="预览 真实文档.md"/);
  assert.match(html, /此目录只显示前 200 项/);
  assert.doesNotMatch(html, /只读样例|pass\.svg|indexeddb\.ts|编辑文件|下载/);
});

test("文件预览使用真实正文，Markdown 和源码安全渲染，空文本保持零行", () => {
  const render = (value: OpResult<"read_workspace_file"> | undefined, mode: "preview" | "source" = "preview") => renderToStaticMarkup(createElement(FilePreview, { file: value, path: value?.path ?? "missing.txt", mode, onMode() {}, onFiles() {}, onUrl() {} }));
  const content = '# 实际标题\n\n**实际正文** [网页](https://example.com/) [凭据](https://user:pass@example.com) [相对](./other.md) ![远端图片](https://example.com/remote.png)\n\n<script>alert("unsafe")</script>';
  const markdown: OpResult<"read_workspace_file"> = { workspaceId: "w1", path: "actual.md", kind: "markdown", size: Buffer.byteLength(content), content };
  const preview = render(markdown);
  assert.match(preview, /<h1>实际标题<\/h1>/);
  assert.match(preview, /<strong>实际正文<\/strong>/);
  assert.equal((preview.match(/class="file-preview-link"/g) ?? []).length, 1);
  assert.doesNotMatch(preview, /<script|<img|<a /);
  const source = render(markdown, "source");
  assert.match(source, /aria-label="文件源码"/);
  assert.match(source, /hljs-tag/);
  assert.match(source, /&lt;/);
  assert.doesNotMatch(source, /<h1>|<script/);
  const empty = render(file("w1", "empty.txt", ""));
  assert.match(empty, /<pre><code><\/code><\/pre>/);
  assert.doesNotMatch(empty, /class="file-line"|文件不可用|空文件/);
  assert.match(render({ workspaceId: "w1", path: "archive.bin", kind: "unsupported", size: 12 }), /暂不支持预览此文件/);
  assert.match(render(undefined), /文件不可用/);
  assert.match(render({ workspaceId: "w1", path: "actual.png", kind: "image", mimeType: "image/png", size: 4, dataUrl: "data:image/png;base64,iVBORw==" }), /src="data:image\/png;base64,iVBORw=="/);
});

test("消息流隐藏已记录的思考正文，保留原始记录", () => {
  const h = harness();
  const flow = h.model.view.openSession("s1").flow;
  flow.apply({ seq: 1, sessionId: "s1", taskId: "task", createdAt: at, body: { type: "task.thinking", taskId: "task", sessionId: "s1", thinkingId: "actual", messageId: "message", startedAt: at, endedAt: at, text: "已记录思考正文" } });
  const html = renderToStaticMarkup(createElement(Conversation, { model: h.model, sessionId: "s1" }));
  assert.doesNotMatch(html, /已记录思考正文|Thought for|Thinking/);
  assert.ok(flow.items.some(item => item.kind === "thinking" && item.text === "已记录思考正文"));
});

test("消息流排除空 thinking 的外层 item，避免多余空白间距", () => {
  const h = harness();
  h.model.view.openSession("s1").flow.apply({ seq: 1, sessionId: "s1", taskId: "task", createdAt: at, body: { type: "task.thinking", taskId: "task", sessionId: "s1", thinkingId: "empty", messageId: "message", startedAt: at, endedAt: at, text: " " } });
  const html = renderToStaticMarkup(createElement(Conversation, { model: h.model, sessionId: "s1" }));
  assert.doesNotMatch(html, /data-message-id="thinking:empty"|trace-step|Thought for/);
});

test("工具调用的空 assistant 正文不占消息间距", () => {
  const h = harness();
  const flow = h.model.view.openSession("s1").flow;
  flow.addHistory({ entryId: "empty-call", taskId: null, inputPurpose: "user", parentId: null, role: "assistant", text: "", timestamp: at, offset: 0, totalBytes: 0, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false });
  const html = renderToStaticMarkup(createElement(Conversation, { model: h.model, sessionId: "s1" }));
  assert.doesNotMatch(html, /data-message-id="history:empty-call"/);
  flow.addHistory({ entryId: "attachment-only", taskId: null, inputPurpose: "user", parentId: null, role: "user", text: "", timestamp: at, offset: 0, totalBytes: 0, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: true, attachments: [{ id: "file", name: "实际附件.txt", size: 3 }] });
  const attached = renderToStaticMarkup(createElement(Conversation, { model: h.model, sessionId: "s1" }));
  assert.match(attached, /data-message-id="history:attachment-only"/);
  assert.match(attached, /实际附件.txt/);
});


test("加载和空态占位不消耗消息滚动器的首次 start 定位", () => {
  const h = harness();
  const nodes = (node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Element[] => [...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(nodes) : [])];
  for (const loaded of [false, true]) {
    h.model.view.openSession("a").historyLoaded = loaded;
    const html = renderToStaticMarkup(createElement(Conversation, { model: h.model, sessionId: "a" }));
    const content = nodes(parseFragment(html)).find(node => node.attrs.some(attr => attr.name === "data-slot" && attr.value === "message-scroller-content"))!;
    assert.ok(content);
    assert.equal(nodes(content).filter(node => node.attrs.some(attr => attr.name === "class" && attr.value.includes("new-session-empty"))).length, 0);
    assert.match(html, loaded ? /开始一个新的会话/ : /正在加载会话/);
  }
});
