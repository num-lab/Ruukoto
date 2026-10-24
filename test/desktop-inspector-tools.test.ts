import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { PersistentEvent, Project, Session } from "@ruukoto/core/types.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { browserAddress, browserNavigation, moveBrowser, navigateBrowser, type BrowserNavigation } from "../apps/desktop/src/renderer/browser-navigation.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";
import { FILE_PAGE_BYTES, type PreviewFile } from "../apps/desktop/src/renderer/read-snapshot.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";

const at = "2026-10-16T00:00:00.000Z";
const workspace = (id: string): Project => ({ id, name: `真实工作区 ${id}`, createRequestId: null, rootDir: { cwd: `/work/${id}`, cwdReal: `/work/${id}`, dev: 1, ino: id === "w1" ? 1 : 2 }, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at });
const session = (id: string, projectId = "w1"): Session => ({ id, projectId, kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: `/work/${projectId}`, cwdReal: `/work/${projectId}`, cwdDev: 1, cwdIno: projectId === "w1" ? 1 : 2, piSessionId: id, sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: at });
const directory = (workspaceId = "w1", path = "", name = "actual.txt"): OpResult<"list_workspace_files"> => ({ workspaceId, path, entries: [{ kind: "file", path: path ? `${path}/${name}` : name, name }], nextCursor: null });
const file = (workspaceId = "w1", path = "actual.txt", content = `真实文件内容 ${workspaceId}`, offset = 0, version = "version"): OpResult<"read_workspace_file"> => { const bytes = Buffer.from(content); return { workspaceId, path, size: bytes.length, version, offset, encoding: "base64", data: bytes.subarray(offset, offset + FILE_PAGE_BYTES).toString("base64") }; };
function gate() {
  let release!: () => void;
  return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function harness(handlers: FakeHandlers = {}, target: "code" | "personal" = "code") {
  const transport = new FakeTransport({ handlers: { work_list: () => ({ works: [] }), list_workspace_files: params => directory(params.workspace_id, params.path), read_workspace_file: params => file(params.workspace_id, params.path), ...handlers } });
  const bridge: Pick<DesktopBridge, "request"> = { request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) };
  const model = new CodeState(bridge, () => {}, target);
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

test("present 实时成功打开来源会话，失败/重放不打开，历史可重开且不调用文件树", async () => {
  const h = harness({ read_artifact: () => ({ artifact: { id: "art", taskId: "task", sessionId: "b", name: "present 文件正文", byteCount: 0, status: "complete", createdAt: at }, data: "", encoding: "base64" }) });
  h.inspector.openParent("a"); h.inspector.visible = false;
  let seq = 0;
  const emit = (sessionId: string, body: PersistentEvent["body"], kind: "live" | "replay" = "live") => h.model.update({ type: "event", kind, event: { seq: ++seq, sessionId, taskId: "task", createdAt: at, body } });
  const intent = (id: string, params: Record<string, unknown>) => ({ type: "task.tool_intent" as const, taskId: "task", toolOpId: id, sdkCallId: id, toolName: "present", params });
  const result = (id: string, isError = false, artifactIds: string[] = []) => ({ type: "task.tool_result" as const, taskId: "task", toolOpId: id, summary: "预览请求已记录", isError, artifactIds });
  emit("a", intent("failed", { url: "https://example.com" })); emit("a", result("failed", true));
  emit("a", intent("replayed", { url: "https://example.com" }), "replay"); emit("a", result("replayed"), "replay");
  assert.equal(h.inspector.visible, false); assert.equal(h.inspector.tabs().length, 0);
  emit("b", intent("file", { path: "empty.txt" })); emit("b", result("file", false, ["art"]));
  assert.equal(h.inspector.parentSessionId, "a"); assert.equal(h.inspector.visible, false); assert.equal(h.inspector.tabs().length, 0);
  h.inspector.openParent("b");
  assert.equal(h.inspector.visible, true);
  const tab = h.inspector.activeTab(); assert.equal(tab?.kind, "read-snapshot");
  await waitFor("空文件产物预览完成", () => tab && h.inspector.snapshots.get(tab.id)?.loading === false);
  assert.deepEqual(h.inspector.snapshots.get(tab!.id)?.file, { path: "empty.txt", size: 0, kind: "text", content: "" });
  assert.ok(!h.transport.requests.some(request => request.op === "read_workspace_file"));
  h.inspector.closeTab(tab!.id); h.inspector.visible = false;
  emit("b", result("file", false, ["art"]));
  assert.equal(h.inspector.visible, false, "重复 live 不重开已关闭预览");
  const fileTool = h.view.openSession("b").flow.items.find((item): item is DiffTool => item.kind === "tool" && item.toolOpId === "file")!;
  assert.equal(await h.inspector.openPresentation("b", fileTool), true);
  assert.equal(h.inspector.visible, true);
  h.inspector.openParent("a"); emit("a", intent("url", { url: "https://example.com/page" })); emit("a", result("url"));
  const browser = h.inspector.activeTab(); assert.equal(browser?.kind, "browser");
  if (browser?.kind === "browser") assert.equal(browser.navigation.history[browser.navigation.index], "https://example.com/page");
  for (const url of ["file:///tmp/secret", "javascript:evil", "https://user:password@example.com"]) {
    const tool = { ...fileTool, params: { url }, artifactIds: [] };
    assert.equal(await h.inspector.openPresentation("a", tool), false);
  }
});

test("内置浏览器接受无凭据网页和本机文件地址，域名和本机简写归一化", () => {
  for (const address of ["", " ", "javascript:alert(1)", "data:text/html,<script>x</script>", "file://remote/tmp/file", "blob:https://example.com/id", "mailto:a@example.com", "http://user:password@example.com", "https://user@example.com", "http://", "http://[bad]"]) assert.equal(browserAddress(address), null, address);
  assert.equal(browserAddress("file:///tmp/file"), "file:///tmp/file");
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
  const first = h.inspector.files.get("w1:actual.txt")?.value, second = h.inspector.files.get("w2:actual.txt")?.value;
  assert.equal(first?.kind === "text" && first.content, "真实文件内容 w1");
  assert.equal(second?.kind === "text" && second.content, "真实文件内容 w2");
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
let FilePreview: ComponentType<{ file: PreviewFile | undefined; path: string; mode: "preview" | "source"; onMode: (mode: "preview" | "source") => void; onFiles: () => void; onUrl: (url: string) => void }>;
let WorkspaceFiles: ComponentType<{ model: CodeState; workspaceId: string }>;
let BrowserPanel: ComponentType<{ navigation: BrowserNavigation; onChange: (navigation: BrowserNavigation) => void }>;
let Conversation: ComponentType<{ model: CodeState; sessionId: string }>;
let InspectorPanel: ComponentType<{ model: CodeState; open: boolean; onWidthChange: (width: number) => void }>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], ssr: { noExternal: ["@xterm/xterm", "@xterm/addon-fit"] }, define: { "window.location.origin": JSON.stringify("http://127.0.0.1:9999"), "window.location.protocol": JSON.stringify("http:") }, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ FilePreview, WorkspaceFiles, BrowserPanel } = await server.ssrLoadModule("/inspector-panels.tsx"));
  ({ Conversation } = await server.ssrLoadModule("/conversation.tsx"));
  ({ InspectorPanel } = await server.ssrLoadModule("/inspector-panel.tsx"));
});

test("断线打开 Git 不冒充非仓库，恢复后仍需读取结果", async () => {
  const h = harness({ read_workspace_git: params => ({ workspaceId: params.workspace_id, repository: null }) });
  h.inspector.openParent("a"); h.model.update({ type: "state", state: "reconnecting" }); h.inspector.openGit();
  const render = () => renderToStaticMarkup(createElement(InspectorPanel, { model: h.model, open: true, onWidthChange() {} }));
  assert.match(render(), /等待连接/); assert.doesNotMatch(render(), /没有 Git 仓库/);
  assert.equal(h.transport.requests.filter(request => request.op === "read_workspace_git").length, 0);
  h.model.update({ type: "state", state: "online" }); h.snapshot();
  await waitFor("恢复后仓库读取完成", () => h.inspector.repositories.get("w1")?.loading === false);
  assert.match(render(), /没有 Git 仓库/);
});

test("Git 入口始终可见，新标签和同步不预取，点击后区分非仓库与空仓库", async () => {
  const h = harness({ read_workspace_git: params => ({ workspaceId: params.workspace_id, repository: null }) });
  const render = () => renderToStaticMarkup(createElement(InspectorPanel, { model: h.model, open: true, onWidthChange() {} }));
  assert.match(render(), /disabled=""[^>]*><svg[^]*?<span>Git graph<\/span>/);
  h.inspector.openParent("a"); h.inspector.newTab(); h.snapshot();
  h.inspector.update({ type: "state", state: "reconnecting" }); h.inspector.update({ type: "state", state: "online" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.transport.requests.filter(request => request.op === "read_workspace_git").length, 0);
  assert.match(render(), /<span>Git graph<\/span>/);
  h.inspector.openGit();
  await waitFor("点击后读取 Git", () => h.inspector.repositories.get("w1")?.value !== undefined);
  assert.deepEqual(h.transport.requests.filter(request => request.op === "read_workspace_git").map(request => request.params), [{ workspace_id: "w1" }]);
  assert.match(render(), /此工作区没有 Git 仓库。/);
  h.inspector.repositories.set("w1", { loading: false, value: { workspaceId: "w1", repository: { head: null, commits: [], nextCursor: null } } });
  assert.match(render(), /暂无提交/); assert.doesNotMatch(render(), /没有 Git 仓库/);
});
after(async () => { await server?.close(); });

test("浏览器实际组件保持空初始页、sandbox、无 referrer，非法输入有明确结果", () => {
  const blank = renderToStaticMarkup(createElement(BrowserPanel, { navigation: browserNavigation("about:blank"), onChange() {} }));
  assert.match(blank, /src="about:blank"/);
  assert.match(blank, /sandbox="allow-scripts allow-forms"/);
  assert.match(blank, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(blank, /部分网站不允许嵌入|请输入 http/);
  const local = renderToStaticMarkup(createElement(BrowserPanel, { navigation: browserNavigation("file:///tmp/document.html"), onChange() {} }));
  assert.match(local, /正在打开本地文档/);
  assert.doesNotMatch(local, /<iframe/);
  assert.doesNotMatch(blank, /allow-same-origin|allow-top-navigation|allow-popups|allow-downloads|车票|浏览成功/);
  const invalid = renderToStaticMarkup(createElement(BrowserPanel, { navigation: navigateBrowser(browserNavigation("about:blank"), "javascript:evil"), onChange() {} }));
  assert.match(invalid, /role="alert"/);
  assert.match(invalid, /aria-invalid="true"/);
  const self = renderToStaticMarkup(createElement(BrowserPanel, { navigation: browserNavigation("http://127.0.0.1:9999/"), onChange() {} }));
  assert.match(self, /此地址是桌面界面本身/);
  assert.doesNotMatch(self, /<iframe/);
});

test("真实目录组件只展示后台返回的目录，不迁入样例或写操作", async () => {
  const h = harness({ list_workspace_files: () => ({ workspaceId: "w1", path: "", entries: [{ kind: "directory", name: "真实目录", path: "真实目录" }, { kind: "file", name: "真实文档.md", path: "真实文档.md" }], nextCursor: "next" }) });
  await h.inspector.loadDirectory("w1", "");
  const html = renderToStaticMarkup(createElement(WorkspaceFiles, { model: h.model, workspaceId: "w1" }));
  assert.match(html, /真实工作区 w1/);
  assert.match(html, /aria-label="真实目录"/);
  assert.match(html, /aria-label="预览 真实文档.md"/);
  assert.match(html, /加载更多/);
  assert.doesNotMatch(html, /此目录只显示前/);
  assert.doesNotMatch(html, /只读样例|pass\.svg|indexeddb\.ts|编辑文件|下载/);
});

test("文件预览使用真实正文，Markdown 和源码安全渲染，空文本保持零行", () => {
  const render = (value: PreviewFile | undefined, mode: "preview" | "source" = "preview") => renderToStaticMarkup(createElement(FilePreview, { file: value, path: value?.path ?? "missing.txt", mode, onMode() {}, onFiles() {}, onUrl() {} }));
  const content = '# 实际标题\n\n**实际正文** [网页](https://example.com/) [凭据](https://user:pass@example.com) [相对](./other.md) ![远端图片](https://example.com/remote.png)\n\n<script>alert("unsafe")</script>';
  const markdown: PreviewFile = { path: "actual.md", kind: "markdown", size: Buffer.byteLength(content), content };
  const preview = render(markdown);
  assert.match(preview, /<h1>实际标题<\/h1>/);
  assert.match(preview, /<strong>实际正文<\/strong>/);
  assert.equal((preview.match(/class="file-preview-link"/g) ?? []).length, 1);
  assert.match(preview, /<img src="https:\/\/example.com\/remote.png" alt="远端图片"/);
  assert.doesNotMatch(preview, /<script|<a /);
  const source = render(markdown, "source");
  assert.match(source, /aria-label="文件源码"/);
  assert.match(source, /hljs-tag/);
  assert.match(source, /&lt;/);
  assert.doesNotMatch(source, /<h1>|<script/);
  const empty = render({ path: "empty.txt", kind: "text", size: 0, content: "" });
  assert.match(empty, /<pre><code><\/code><\/pre>/);
  assert.doesNotMatch(empty, /class="file-line"|文件不可用|空文件/);
  assert.match(render({ path: "archive.bin", kind: "unsupported", size: 12 }), /暂不支持预览此文件/);
  assert.match(render(undefined), /文件不可用/);
  assert.match(render({ path: "actual.png", kind: "image", mimeType: "image/png", size: 4, dataUrl: "data:image/png;base64,iVBORw==" }), /src="data:image\/png;base64,iVBORw=="/);
});

test("消息流保留实际 reasoning 折叠行和原始记录", () => {
  const h = harness();
  const flow = h.model.view.openSession("s1").flow;
  flow.apply({ seq: 1, sessionId: "s1", taskId: "task", createdAt: at, body: { type: "task.thinking", taskId: "task", sessionId: "s1", thinkingId: "actual", messageId: "message", startedAt: at, endedAt: at, text: "已记录思考正文" } });
  const html = renderToStaticMarkup(createElement(Conversation, { model: h.model, sessionId: "s1" }));
  assert.match(html, /Thought for 0s/);
  assert.doesNotMatch(html, /已记录思考正文|Thinking/);
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
    if (loaded) assert.doesNotMatch(html, /开始一个新的会话|在下方描述|new-session-empty/);
    else assert.match(html, /正在加载会话/);
  }
});


test("PA Inspector 工具读取使用 Personal，文件／diff／Git 动作不能绕过限制", async () => {
  const h = harness({}, "personal");
  h.inspector.openParent("a");
  h.inspector.openBrowser();
  assert.equal(h.inspector.activeTab()?.kind, "browser");
  h.inspector.openFiles(); h.inspector.openFile("w1", "actual.txt"); h.inspector.openGit();
  await h.inspector.loadDirectory("w1", ""); await h.inspector.loadFile("w1", "actual.txt"); await h.inspector.loadGit("w1");
  assert.equal(h.inspector.workspace(), undefined);
  assert.equal(h.inspector.tabs().length, 1);
  assert.ok(h.transport.requests.every(request => !["read_workspace_file", "list_workspace_files", "read_workspace_git"].includes(request.op)));
});

for (const boundary of ["snapshot", "offline", "retry"] as const) test(`Git 缓存跨 ${boundary} 不安装迟到响应，非仓库仍能打开标签`, async () => {
  const blocked = gate(); let reads = 0;
  const h = harness({ read_workspace_git: async params => { const read = ++reads; if (read === 1) await blocked.wait; return { workspaceId: params.workspace_id, repository: read === 1 ? { head: null, commits: [], nextCursor: null } : null }; } });
  h.inspector.openParent("a");
  const pending = h.inspector.loadGit();
  await h.inspector.loadGit();
  assert.equal(reads, 1);
  h.inspector.openGit(); assert.equal(h.inspector.activeTab()?.kind, "git");
  if (boundary === "snapshot") h.snapshot();
  if (boundary === "offline") { h.inspector.update({ type: "state", state: "reconnecting" }); h.inspector.update({ type: "state", state: "online" }); }
  await h.inspector.loadGit("w1", true);
  blocked.release(); await pending;
  assert.equal(h.inspector.repositories.get("w1")?.value?.repository, null);
  h.inspector.openGit(); assert.equal(h.inspector.activeTab()?.kind, "git");
});

test("右栏排序保留标签对象、活动项和浏览器历史，父会话间隔离", () => {
  const h = harness(); h.inspector.openParent("a"); h.inspector.openBrowser("example.com");
  const browser = h.inspector.activeTab()!; h.inspector.newTab(); const active = h.inspector.activeTab()!;
  h.inspector.reorderTab(browser.id, active.id);
  assert.equal(h.inspector.tabs().at(-1), browser); assert.equal(h.inspector.activeTab(), active);
  h.inspector.openParent("b"); assert.equal(h.inspector.tabs().length, 0);
  h.inspector.openParent("a"); assert.equal(h.inspector.tabs().at(-1), browser); assert.equal(h.inspector.activeTab(), active);
});


test("同实例 resync 后已打开 Git 标签自动补读，不把失效缓存当非仓库", async () => {
  let reads = 0;
  const h = harness({ read_workspace_git: params => { reads++; return { workspaceId: params.workspace_id, repository: { head: null, commits: [], nextCursor: null } }; } });
  h.inspector.openParent("a"); await h.inspector.loadGit(); h.inspector.openGit();
  assert.equal(h.inspector.activeTab()?.kind, "git");
  h.snapshot();
  await waitFor("Git 重读", () => h.inspector.repositories.get("w1")?.value?.repository !== undefined);
  assert.equal(reads, 2); assert.equal(h.inspector.activeTab()?.kind, "git");
});

function gitPage(ids: string[], nextCursor: string | null, workspaceId = "w1"): OpResult<"read_workspace_git"> {
  return { workspaceId, repository: { head: "head", commits: ids.map(id => ({ id, parents: [], subject: id, author: "author", date: at, refs: [] })), nextCursor } };
}

test("Git追加按游标去重，保留前缀；错误可见并按原游标重试到尾页", async () => {
  const blocked = gate(); let pageReads = 0;
  const h = harness({ read_workspace_git: async params => {
    if (!params.cursor) return gitPage(["a"], "next");
    pageReads++;
    if (pageReads === 1) { await blocked.wait; throw new Error("读取失败，请重试"); }
    return gitPage(["b"], null);
  } });
  await h.inspector.loadGit("w1");
  const prefix = h.inspector.repositories.get("w1")!.value!.repository!.commits[0];
  const first = h.inspector.loadMoreGit("w1");
  await h.inspector.loadMoreGit("w1"); assert.equal(pageReads, 1);
  blocked.release(); await first;
  const failed = h.inspector.repositories.get("w1")!;
  assert.equal(failed.value!.repository!.commits[0], prefix);
  assert.match(failed.moreError!, /读取失败/); assert.equal(failed.loadingMore, false);
  await h.inspector.loadMoreGit("w1");
  const current = h.inspector.repositories.get("w1")!;
  assert.equal(current.value!.repository!.commits[0], prefix);
  assert.deepEqual(current.value!.repository!.commits.map(commit => commit.id), ["a", "b"]);
  assert.equal(current.moreError, undefined); assert.equal(current.value!.repository!.nextCursor, null);
  await h.inspector.loadMoreGit("w1"); assert.equal(pageReads, 2);
  assert.deepEqual(h.transport.requests.filter(request => request.op === "read_workspace_git").map(request => (request.params as OpParams<"read_workspace_git">).cursor), [undefined, "next", "next"]);
});

for (const boundary of ["refresh", "snapshot", "offline"] as const) test(`Git追加跨${boundary}不安装迟到页面`, async () => {
  const blocked = gate(); let first = true;
  const h = harness({ read_workspace_git: async params => {
    if (params.cursor) { await blocked.wait; return gitPage(["stale"], null); }
    const result = gitPage([first ? "first" : "fresh"], "next"); first = false; return result;
  } });
  await h.inspector.loadGit("w1");
  const more = h.inspector.loadMoreGit("w1");
  if (boundary === "refresh") await h.inspector.loadGit("w1", true);
  else {
    if (boundary === "snapshot") h.snapshot();
    else { h.inspector.update({ type: "state", state: "reconnecting" }); h.inspector.update({ type: "state", state: "online" }); }
    await h.inspector.loadGit("w1");
  }
  blocked.release(); await more;
  assert.deepEqual(h.inspector.repositories.get("w1")!.value!.repository!.commits.map(commit => commit.id), ["fresh"]);
});

for (const mismatch of ["workspace", "duplicate", "cursor", "head"] as const) test(`Git追加拒绝不一致的${mismatch}响应并保留已加载历史`, async () => {
  const h = harness({ read_workspace_git: params => {
    if (!params.cursor) return gitPage(["a"], "next");
    const result = gitPage([mismatch === "duplicate" ? "a" : "b"], mismatch === "cursor" ? "next" : null, mismatch === "workspace" ? "w2" : "w1");
    if (mismatch === "head") result.repository!.head = "other";
    return result;
  } });
  await h.inspector.loadGit("w1"); await h.inspector.loadMoreGit("w1");
  assert.deepEqual(h.inspector.repositories.get("w1")!.value!.repository!.commits.map(commit => commit.id), ["a"]);
  assert.match(h.inspector.repositories.get("w1")!.moreError!, /刷新/);
});

function directoryPage(names: string[], nextCursor: string | null, directoryPath = "", workspaceId = "w1"): OpResult<"list_workspace_files"> {
  return { workspaceId, path: directoryPath, entries: names.map(name => ({ name, path: directoryPath ? `${directoryPath}/${name}` : name, kind: "file" })), nextCursor };
}

test("目录续页保留前缀，重复点击只读一次，临时失败按原游标重试", async () => {
  const blocked = gate(); let pages = 0;
  const h = harness({ list_workspace_files: async params => {
    if (!params.cursor) return directoryPage(["a"], "next", "src");
    if (++pages === 1) { await blocked.wait; throw new Error("临时读取失败"); }
    return directoryPage(["b"], null, "src");
  } });
  await h.inspector.loadDirectory("w1", "src");
  const prefix = h.inspector.directories.get("w1:src")!.value!.entries[0];
  const more = h.inspector.loadMoreDirectory("w1", "src");
  await h.inspector.loadMoreDirectory("w1", "src"); assert.equal(pages, 1);
  blocked.release(); await more;
  const state = h.inspector.directories.get("w1:src")!;
  assert.match(state.moreError!, /临时读取失败/); assert.equal(state.value!.entries[0], prefix); assert.equal(state.loadingMore, false);
  await h.inspector.loadMoreDirectory("w1", "src");
  assert.deepEqual(state.value!.entries.map(entry => entry.name), ["a", "b"]); assert.equal(state.value!.entries[0], prefix);
  assert.equal(state.moreError, undefined); assert.equal(state.value!.nextCursor, null);
  await h.inspector.loadMoreDirectory("w1", "src"); assert.equal(pages, 2);
  assert.deepEqual(h.transport.requests.filter(request => request.op === "list_workspace_files").map(request => (request.params as OpParams<"list_workspace_files">).cursor), [undefined, "next", "next"]);
});

for (const boundary of ["refresh", "snapshot", "offline"] as const) test(`目录续页跨${boundary}不安装迟到页`, async () => {
  const blocked = gate(); let fresh = false;
  const h = harness({ list_workspace_files: async params => {
    if (params.cursor) { await blocked.wait; return directoryPage(["stale"], null); }
    return directoryPage([fresh ? "fresh" : "first"], "next");
  } });
  await h.inspector.loadDirectory("w1", "");
  const more = h.inspector.loadMoreDirectory("w1", ""); fresh = true;
  if (boundary === "refresh") await h.inspector.loadDirectory("w1", "", true);
  else {
    if (boundary === "snapshot") h.snapshot();
    else { h.inspector.update({ type: "state", state: "reconnecting" }); h.inspector.update({ type: "state", state: "online" }); }
    await h.inspector.loadDirectory("w1", "");
  }
  blocked.release(); await more;
  assert.deepEqual(h.inspector.directories.get("w1:")!.value!.entries.map(entry => entry.name), ["fresh"]);
});

for (const mismatch of ["workspace", "path", "duplicate", "cursor", "empty-page", "changed"] as const) test(`目录续页${mismatch}要求刷新并保留已读内容`, async () => {
  const h = harness({ list_workspace_files: params => {
    if (!params.cursor) return directoryPage(["a"], "next");
    if (mismatch === "changed") throw new ControlClientError("workspace_file_changed", "目录已变化，请刷新文件树。", "rejected");
    return directoryPage(mismatch === "empty-page" ? [] : [mismatch === "duplicate" ? "a" : "b"], mismatch === "cursor" ? "next" : mismatch === "empty-page" ? "third" : null, mismatch === "path" ? "other" : "", mismatch === "workspace" ? "w2" : "w1");
  } });
  await h.inspector.loadDirectory("w1", ""); await h.inspector.loadMoreDirectory("w1", "");
  const state = h.inspector.directories.get("w1:")!;
  assert.deepEqual(state.value!.entries.map(entry => entry.name), ["a"]); assert.match(state.error!, /刷新/);
  const count = h.transport.requests.length; await h.inspector.loadMoreDirectory("w1", ""); assert.equal(h.transport.requests.length, count);
});

test("目录刷新后页失败保留完整旧树和子缓存，重试成功才整体替换", async () => {
  let refresh = false, fail = false;
  const h = harness({ list_workspace_files: params => {
    if (params.cursor && fail) throw new Error("后页读取失败");
    return directoryPage(params.cursor ? [refresh ? "c" : "b"] : [refresh ? "a-new" : "a"], params.cursor ? null : "next");
  } });
  h.inspector.openParent("a"); h.inspector.openFiles();
  await waitFor("目录首读", () => !h.inspector.directories.get("w1:")?.loading);
  await h.inspector.loadMoreDirectory("w1", "");
  h.inspector.files.set("w1:b", { loading: false });
  refresh = true; fail = true; await h.inspector.loadDirectory("w1", "", true);
  assert.deepEqual(h.inspector.directories.get("w1:")!.value!.entries.map(entry => entry.name), ["a", "b"]);
  assert.match(h.inspector.directories.get("w1:")!.error!, /后页读取失败/); assert.ok(h.inspector.files.has("w1:b"));
  fail = false; await h.inspector.loadDirectory("w1", "", true);
  assert.deepEqual(h.inspector.directories.get("w1:")!.value!.entries.map(entry => entry.name), ["a-new", "c"]);
  assert.equal(h.inspector.files.has("w1:b"), false);
});

for (const cancel of ["collapse", "switch", "unmount"] as const) test(`目录多页刷新在${cancel}后不继续读取，保留旧树`, async () => {
  const blocked = gate(); let hold = false, reads = 0;
  const h = harness({ list_workspace_files: async params => {
    if (!params.path) return { workspaceId: "w1", path: "", entries: [{ name: "src", path: "src", kind: "directory" }], nextCursor: null };
    reads++;
    if (hold && !params.cursor) await blocked.wait;
    return directoryPage(params.cursor ? ["b"] : ["a"], params.cursor ? null : "next", "src");
  } });
  h.inspector.openParent("a"); h.inspector.openFiles(); h.inspector.folders.set("w1:src", true);
  await h.inspector.loadDirectory("w1", "src"); await h.inspector.loadMoreDirectory("w1", "src");
  hold = true; const controller = new AbortController();
  const refresh = h.inspector.refreshDirectories("w1", controller.signal);
  await waitFor("子目录刷新已开始", () => reads === 3);
  if (cancel === "collapse") h.inspector.folders.set("w1:src", false);
  if (cancel === "switch") h.inspector.openBrowser();
  if (cancel === "unmount") controller.abort();
  blocked.release(); await refresh;
  assert.equal(reads, 3); assert.equal(h.inspector.directories.get("w1:src")!.loading, false);
  assert.deepEqual(h.inspector.directories.get("w1:src")!.value!.entries.map(entry => entry.name), ["a", "b"]);
});

test("折叠祖先保留子目录展开记忆，同时停止子目录刷新后页", async () => {
  const blocked = gate(); let hold = false, childReads = 0;
  const h = harness({ list_workspace_files: async params => {
    if (params.path !== "parent/child") return { workspaceId: "w1", path: params.path ?? "", entries: [{ name: params.path ? "child" : "parent", path: params.path ? "parent/child" : "parent", kind: "directory" }], nextCursor: null };
    childReads++;
    if (hold && !params.cursor) await blocked.wait;
    return directoryPage(params.cursor ? ["b"] : ["a"], params.cursor ? null : "next", "parent/child");
  } });
  h.inspector.openParent("a"); h.inspector.openFiles();
  h.inspector.folders.set("w1:parent", true); h.inspector.folders.set("w1:parent/child", true);
  await h.inspector.loadDirectory("w1", "parent/child"); await h.inspector.loadMoreDirectory("w1", "parent/child");
  hold = true; const refresh = h.inspector.refreshDirectories("w1");
  await waitFor("孙目录刷新在途", () => childReads === 3);
  h.inspector.folders.set("w1:parent", false); blocked.release(); await refresh;
  assert.equal(childReads, 3); assert.equal(h.inspector.folders.get("w1:parent/child"), true);
  assert.equal(h.inspector.directories.get("w1:parent/child")!.loading, false);
  assert.deepEqual(h.inspector.directories.get("w1:parent/child")!.value!.entries.map(entry => entry.name), ["a", "b"]);
});
