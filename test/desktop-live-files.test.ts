import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { resolveDirIdentitySync } from "@ruukoto/core/dir-identity.ts";
import type { Project, Session } from "@ruukoto/core/types.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { listWorkspaceFiles, readWorkspaceFile } from "@ruukoto/runtime/workspace-files.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";
import { handleRequest, ipcResult } from "../apps/desktop/src/main/ipc.ts";
import { startFilesRefresh } from "../apps/desktop/src/renderer/files-refresh.ts";
import { FILE_PAGE_BYTES, readSnapshotFile } from "../apps/desktop/src/renderer/read-snapshot.ts";
import type { InspectorTab } from "../apps/desktop/src/renderer/inspector.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

const at = "2026-10-17T00:00:00Z";
const session: Session = { id: "session", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "s", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: at };
function harness(root: string, handlers: FakeHandlers = {}) {
  const identity = resolveDirIdentitySync(root);
  const project: Project = { id: "workspace", name: "工作区", rootDir: identity, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at };
  const transport = new FakeTransport({ handlers: { work_list: () => ({ works: [] }), list_workspace_files: params => listWorkspaceFiles(params.workspace_id, identity, params.path ?? "", params.cursor), read_workspace_file: params => readWorkspaceFile(params.workspace_id, identity, params.path, params), ...handlers } });
  const model = new CodeState({ request: (_target, op, params) => ipcResult(() => transport.request(op as TuiOp, params as OpParams<TuiOp>)) }, () => {});
  model.view.applySnapshot({ snapshot: fakeSnapshot({ projects: [project], sessions: [{ ...session, cwd: identity.cwdReal, cwdReal: identity.cwdReal }] }), replay: [], seq: 0 }, false);
  model.status = { type: "state", state: "online" };
  model.inspector.openParent(session.id);
  return { model, inspector: model.inspector, transport };
}
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-live-files-"));
  const root = path.join(parent, "work"); fs.mkdirSync(root);
  return { parent, root, close: () => fs.rmSync(parent, { recursive: true, force: true }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const directoryReady = (h: ReturnType<typeof harness>, path = "") => waitFor("目录读取完成", () => h.inspector.directories.get(`workspace:${path}`)?.loading === false);

for (const source of ["snapshot", "workspace"] as const) for (const format of ["image", "text"] as const) test(`${source}${format}转换内存失败可见且可重试`, async context => {
  const kit = fixture();
  try {
    const data = format === "image" ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from("合法文本");
    const name = format === "image" ? "image.png" : "text.txt";
    fs.writeFileSync(path.join(kit.root, name), data);
    const h = harness(kit.root, { read_artifact: () => captured(data) });
    if (format === "image") context.mock.method(globalThis, "btoa", () => { throw new RangeError("模拟图片转换内存限制"); });
    else {
      const decode = TextDecoder.prototype.decode;
      context.mock.method(TextDecoder.prototype, "decode", function(this: TextDecoder, ...args: Parameters<TextDecoder["decode"]>) { if (this.fatal) throw new RangeError("模拟文本解码内存限制"); return decode.apply(this, args); });
    }
    if (source === "snapshot") { await h.inspector.openToolFile(session.id, readTool(`/tmp/${name}`)); await settle(); }
    else { h.inspector.openFile("workspace", name); await settle(); }
    const tab = h.inspector.activeTab()!;
    const failed = source === "snapshot" ? h.inspector.snapshots.get(tab.id) : h.inspector.files.get(`workspace:${name}`);
    assert.equal(failed?.loading, false); assert.match(failed?.error ?? "", /内存/);
    context.mock.restoreAll();
    if (tab.kind === "read-snapshot") { await h.inspector.loadReadSnapshot(tab, true); assert.equal(h.inspector.snapshots.get(tab.id)?.file?.kind, format); }
    else { await h.inspector.loadFile("workspace", name, true); assert.equal(h.inspector.files.get(`workspace:${name}`)?.value?.kind, format); }
  } finally { kit.close(); }
});
const readTool = (path: string, extra: Partial<DiffTool> = {}): DiffTool => ({ kind: "tool", key: "read", name: "read", target: path, params: { path }, paramsTruncated: false, status: "done", entryId: "entry", taskId: "task", toolOpId: "op", toolCallId: "sdk", at, seq: 1, summary: null, artifactIds: ["artifact"], ...extra });
function captured(bytes: Buffer, extra: Partial<OpResult<"read_artifact">["artifact"]> = {}, offset = 0): OpResult<"read_artifact"> {
  return { artifact: { id: "artifact", taskId: "task", sessionId: session.id, name: "展示名称可更改", byteCount: bytes.length, status: "complete", createdAt: at, ...extra }, encoding: "base64", data: bytes.subarray(offset, offset + FILE_PAGE_BYTES).toString("base64") };
}
function gate() { let release!: () => void; return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
class RefreshHost extends EventTarget {
  timers = new Map<number, () => void>();
  private next = 0;
  setTimeout(callback: () => void, delay: number): number { assert.equal(delay, 3000); const id = ++this.next; this.timers.set(id, callback); return id; }
  clearTimeout(id: number): void { this.timers.delete(id); }
  tick(): void { const callbacks = [...this.timers.values()]; this.timers.clear(); for (const callback of callbacks) callback(); }
}

test("重新激活文件树会看到磁盘新增和删除，而不是永久复用目录缓存", async () => {
  const kit = fixture();
  try {
    const h = harness(kit.root);
    fs.writeFileSync(path.join(kit.root, "old.txt"), "old");
    h.inspector.openFiles(); await directoryReady(h);
    assert.deepEqual(h.inspector.directories.get("workspace:")?.value?.entries.map(entry => entry.name), ["old.txt"]);
    fs.unlinkSync(path.join(kit.root, "old.txt")); fs.writeFileSync(path.join(kit.root, "new.txt"), "new");
    h.inspector.openBrowser(); h.inspector.openFiles(); await directoryReady(h);
    assert.deepEqual(h.inspector.directories.get("workspace:")?.value?.entries.map(entry => entry.name), ["new.txt"]);
  } finally { kit.close(); }
});

test("成功 Read 的工作区外文件删除后仍可打开已捕获快照，不读取任意宿主路径", async () => {
  const kit = fixture();
  try {
    const outside = path.join(kit.parent, "already-read.ts"), bytes = Buffer.from("const captured = 1;\n");
    fs.writeFileSync(outside, bytes); fs.unlinkSync(outside);
    const h = harness(kit.root, { read_artifact: params => ({ artifact: { id: "artifact", taskId: "task", sessionId: session.id, name: "read 文件正文", byteCount: bytes.length, status: "complete", createdAt: at }, encoding: "base64", data: bytes.subarray(params.offset ?? 0, (params.offset ?? 0) + (params.length ?? bytes.length)).toString("base64") }) });
    const read = readTool(outside);
    assert.equal(await h.inspector.openToolFile(session.id, read), true);
    await settle();
    const opened = h.inspector.activeTab();
    assert.equal(opened?.kind, "read-snapshot");
    assert.ok(h.transport.requests.some(request => request.op === "read_artifact"));
    assert.ok(!h.transport.requests.some(request => request.op === "read_workspace_file"));
    const state = h.inspector.snapshots.get(opened!.id);
    assert.equal(state?.file?.kind === "text" && state.file.content, bytes.toString());
  } finally { kit.close(); }
});

test("活动文件树按周期和focus刷新，未展开层不读，卸载/关闭/离线停止", async () => {
  const kit = fixture();
  try {
    fs.mkdirSync(path.join(kit.root, "expanded")); fs.mkdirSync(path.join(kit.root, "closed"));
    const h = harness(kit.root), host = new RefreshHost();
    h.inspector.folders.set("workspace:expanded", true);
    h.inspector.openFiles(); await directoryReady(h); await h.inspector.refreshDirectories("workspace");
    const stop = startFilesRefresh(h.inspector, "workspace", host); await waitFor("目录刷新完成", () => host.timers.size === 1);
    assert.equal(host.timers.size, 1);
    fs.writeFileSync(path.join(kit.root, "expanded", "new.txt"), "new"); host.tick(); await waitFor("子目录新增可见", () => h.inspector.directories.get("workspace:expanded")?.value?.entries[0]?.name === "new.txt");
    assert.equal(h.inspector.directories.get("workspace:expanded")?.value?.entries[0].name, "new.txt");
    fs.unlinkSync(path.join(kit.root, "expanded", "new.txt")); host.dispatchEvent(new Event("focus")); await waitFor("子目录删除可见", () => h.inspector.directories.get("workspace:expanded")?.value?.entries.length === 0);
    assert.equal(h.inspector.directories.get("workspace:expanded")?.value?.entries.length, 0);
    assert.ok(h.transport.requests.filter(request => request.op === "list_workspace_files").every(request => (request.params as OpParams<"list_workspace_files">).path !== "closed"));
    h.inspector.visible = false; const count = h.transport.requests.length;
    host.tick(); host.dispatchEvent(new Event("focus")); await settle(); assert.equal(h.transport.requests.length, count);
    h.inspector.visible = true; h.model.update({ type: "state", state: "reconnecting" });
    host.tick(); await settle(); assert.equal(h.transport.requests.length, count);
    stop(); assert.equal(host.timers.size, 0); host.dispatchEvent(new Event("focus")); await settle(); assert.equal(h.transport.requests.length, count);
  } finally { kit.close(); }
});

test("刷新保留成功树，在途focus不重复；失败可重试，删除使已开文件缓存失效", async () => {
  const kit = fixture();
  try {
    fs.writeFileSync(path.join(kit.root, "old.txt"), "old"); const blocked = gate(); let wait = false, fail = false;
    const h = harness(kit.root, { list_workspace_files: async params => { if (wait) await blocked.wait; if (fail) throw new Error("刷新失败"); return listWorkspaceFiles(params.workspace_id, resolveDirIdentitySync(kit.root), params.path ?? "", params.cursor); } });
    h.inspector.openFiles(); await directoryReady(h); await h.inspector.refreshDirectories("workspace");
    h.inspector.files.set("workspace:old.txt", { loading: false, value: { path: "old.txt", kind: "text", content: "old", size: 3 } });
    const host = new RefreshHost(); wait = true; const stop = startFilesRefresh(h.inspector, "workspace", host);
    const count = h.transport.requests.length;
    host.dispatchEvent(new Event("focus")); host.dispatchEvent(new Event("focus"));
    assert.equal(h.transport.requests.length, count);
    assert.equal(h.inspector.directories.get("workspace:")?.loading, true);
    assert.equal(h.inspector.directories.get("workspace:")?.value?.entries[0].name, "old.txt");
    fail = true; blocked.release(); await waitFor("刷新失败可见", () => !!h.inspector.directories.get("workspace:")?.error);
    assert.match(h.inspector.directories.get("workspace:")?.error ?? "", /刷新失败/);
    assert.equal(h.inspector.directories.get("workspace:")?.value?.entries[0].name, "old.txt");
    fail = false; wait = false; fs.unlinkSync(path.join(kit.root, "old.txt"));
    host.dispatchEvent(new Event("focus")); await waitFor("根目录删除可见", () => h.inspector.directories.get("workspace:")?.value?.entries.length === 0);
    assert.equal(h.inspector.directories.get("workspace:")?.value?.entries.length, 0);
    assert.equal(h.inspector.files.has("workspace:old.txt"), false);
    stop();
  } finally { kit.close(); }
});

test("切换面板后在途刷新不继续扫描展开目录，离线不再发请求", async () => {
  const kit = fixture();
  try {
    fs.mkdirSync(path.join(kit.root, "expanded")); const blocked = gate(); let wait = false;
    const h = harness(kit.root, { list_workspace_files: async params => { if (wait) await blocked.wait; return listWorkspaceFiles(params.workspace_id, resolveDirIdentitySync(kit.root), params.path ?? "", params.cursor); } });
    h.inspector.folders.set("workspace:expanded", true); h.inspector.openFiles(); await directoryReady(h); await h.inspector.refreshDirectories("workspace");
    wait = true; const refresh = h.inspector.refreshDirectories("workspace"); const count = h.transport.requests.length;
    h.inspector.openBrowser(); blocked.release(); await refresh;
    assert.equal(h.transport.requests.length, count);
    h.inspector.update({ type: "state", state: "reconnecting" });
    await h.inspector.loadDirectory("workspace", ""); assert.equal(h.transport.requests.length, count);
  } finally { kit.close(); }
});

test("组件卸载取消刷新后续层，即使保留的Code Inspector仍标为visible", async () => {
  const kit = fixture();
  try {
    fs.mkdirSync(path.join(kit.root, "expanded")); const blocked = gate(); let wait = false;
    const h = harness(kit.root, { list_workspace_files: async params => { if (wait) await blocked.wait; return listWorkspaceFiles(params.workspace_id, resolveDirIdentitySync(kit.root), params.path ?? "", params.cursor); } });
    h.inspector.folders.set("workspace:expanded", true); h.inspector.openFiles(); await directoryReady(h); await h.inspector.refreshDirectories("workspace");
    wait = true; const host = new RefreshHost(), stop = startFilesRefresh(h.inspector, "workspace", host);
    const count = h.transport.requests.length; stop(); blocked.release(); await settle();
    assert.equal(h.inspector.visible, true); assert.equal(h.inspector.activeTab()?.kind, "files");
    assert.equal(h.transport.requests.length, count); assert.equal(host.timers.size, 0);
  } finally { kit.close(); }
});

for (const mismatch of ["id", "taskId", "sessionId"] as const) test(`Read 快照拒绝不匹配的 ${mismatch}，不依赖近期产物缓存`, async () => {
  const kit = fixture();
  try {
    const h = harness(kit.root, { read_artifact: () => captured(Buffer.from("snapshot"), { [mismatch]: "other" }) });
    assert.equal(h.model.view.artifacts.size, 0);
    assert.equal(await h.inspector.openToolFile(session.id, readTool("/tmp/mismatch.txt")), true); await settle();
    const state = h.inspector.snapshots.get(h.inspector.activeTab()!.id);
    assert.match(state?.error ?? "", /来源/); assert.equal(state?.file, undefined);
  } finally { kit.close(); }
});

test("只接受成功canonical Read的唯一捕获，空文件无捕获和多义记录不猜测", async () => {
  const kit = fixture();
  try {
    const h = harness(kit.root);
    for (const extra of [{ name: "bash" }, { name: "Read" }, { status: "error" as const }, { status: "running" as const }, { artifactIds: [] }, { artifactIds: ["a", "b"] }, { taskId: undefined }]) assert.equal(await h.inspector.openToolFile(session.id, readTool("/tmp/file.txt", extra)), false);
    assert.equal(h.inspector.tabs().length, 0);
    assert.ok(!h.transport.requests.some(request => request.op === "read_artifact"));
  } finally { kit.close(); }
});

test("Read捕获与工作区文件超过256KiB仍展示完整正文，中文跨页不损坏", async () => {
  const kit = fixture();
  try {
    const content = "x".repeat(FILE_PAGE_BYTES - 1) + "中".repeat(FILE_PAGE_BYTES) + "完整末尾", bytes = Buffer.from(content);
    const h = harness(kit.root, { read_artifact: params => captured(bytes, { status: "partial" }, params.offset) });
    await h.inspector.openToolFile(session.id, readTool("/tmp/large.ts"));
    await waitFor("Read捕获完整读取", () => !h.inspector.snapshots.get(h.inspector.activeTab()!.id)?.loading);
    const snapshot = h.inspector.snapshots.get(h.inspector.activeTab()!.id)!;
    assert.equal(snapshot.partial, true); assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.file?.kind === "text" && snapshot.file.content, content);
    assert.deepEqual(h.transport.requests.filter(request => request.op === "read_artifact").map(request => (request.params as OpParams<"read_artifact">).offset), [0, FILE_PAGE_BYTES, FILE_PAGE_BYTES * 2, FILE_PAGE_BYTES * 3, FILE_PAGE_BYTES * 4]);
    fs.writeFileSync(path.join(kit.root, "large.ts"), content);
    await h.inspector.loadFile("workspace", "large.ts");
    const current = h.inspector.files.get("workspace:large.ts")!;
    assert.equal(current.error, undefined); assert.equal(current.value?.kind === "text" && current.value.content, content);
    const pages = h.transport.requests.filter(request => request.op === "read_workspace_file").map(request => request.params as OpParams<"read_workspace_file">);
    assert.equal(pages.length, 5); assert.equal(pages[0].version, undefined);
    assert.ok(pages.slice(1).every(page => typeof page.version === "string" && page.version === pages[1].version));
    assert.ok(pages.every(page => page.length === FILE_PAGE_BYTES));
  } finally { kit.close(); }
});

for (const kind of ["snapshot", "workspace"] as const) for (const action of ["close", "offline"] as const) test(`${kind}后页在途时${action}不安装迟到内容或继续请求`, async () => {
  const kit = fixture();
  try {
    const bytes = Buffer.from("x".repeat(FILE_PAGE_BYTES * 2 + 1)), blocked = gate(); let calls = 0;
    fs.writeFileSync(path.join(kit.root, "late.txt"), bytes);
    const h = harness(kit.root, {
      read_artifact: async params => { if (++calls === 2) await blocked.wait; return captured(bytes, {}, params.offset); },
      read_workspace_file: async params => { if (++calls === 2) await blocked.wait; return readWorkspaceFile(params.workspace_id, resolveDirIdentitySync(kit.root), params.path, params); },
    });
    if (kind === "snapshot") await h.inspector.openToolFile(session.id, readTool("/tmp/late.txt")); else h.inspector.openFile("workspace", "late.txt");
    await waitFor("第二页已开始", () => calls === 2);
    const id = h.inspector.activeTab()!.id;
    if (action === "close") h.inspector.closeTab(id); else h.model.update({ type: "state", state: "reconnecting" });
    blocked.release(); await settle();
    assert.equal(calls, 2);
    assert.equal(kind === "snapshot" ? h.inspector.snapshots.has(id) : h.inspector.files.has("workspace:late.txt"), false);
  } finally { kit.close(); }
});

for (const mismatch of ["size", "status", "invalid-base64", "short-page"] as const) test(`Read捕获后页${mismatch}不展示不完整正文`, async () => {
  const kit = fixture();
  try {
    const bytes = Buffer.from("x".repeat(FILE_PAGE_BYTES + 3)); let calls = 0;
    const h = harness(kit.root, { read_artifact: params => {
      const page = captured(bytes, {}, params.offset); calls++;
      if (params.offset) {
        if (mismatch === "size") page.artifact.byteCount++;
        if (mismatch === "status") page.artifact.status = "partial";
        if (mismatch === "invalid-base64") page.data = "%%%";
        if (mismatch === "short-page") page.data = Buffer.from("x").toString("base64");
      }
      return page;
    } });
    await h.inspector.openToolFile(session.id, readTool("/tmp/bad-page.txt"));
    await waitFor("后页拒绝已完成", () => !h.inspector.snapshots.get(h.inspector.activeTab()!.id)?.loading);
    const state = h.inspector.snapshots.get(h.inspector.activeTab()!.id)!;
    assert.equal(calls, 2); assert.ok(state.error); assert.equal(state.file, undefined);
  } finally { kit.close(); }
});

for (const mismatch of ["size", "version", "offset", "path", "workspace", "invalid-base64", "short-page"] as const) test(`工作区文件后页${mismatch}不拼接混合版本`, async () => {
  const kit = fixture();
  try {
    const bytes = Buffer.from("x".repeat(FILE_PAGE_BYTES + 3)); let calls = 0;
    fs.writeFileSync(path.join(kit.root, "bad-page.txt"), bytes);
    const h = harness(kit.root, { read_workspace_file: params => {
      const page = readWorkspaceFile(params.workspace_id, resolveDirIdentitySync(kit.root), params.path, params); calls++;
      if (params.offset) {
        if (mismatch === "size") page.size++;
        if (mismatch === "version") page.version = "other-version";
        if (mismatch === "offset") page.offset = 0;
        if (mismatch === "path") page.path = "other.txt";
        if (mismatch === "workspace") page.workspaceId = "other-workspace";
        if (mismatch === "invalid-base64") page.data = "%%%";
        if (mismatch === "short-page") page.data = Buffer.from("x").toString("base64");
      }
      return page;
    } });
    await h.inspector.loadFile("workspace", "bad-page.txt");
    const state = h.inspector.files.get("workspace:bad-page.txt")!;
    assert.equal(calls, 2); assert.ok(state.error); assert.equal(state.value, undefined);
  } finally { kit.close(); }
});

test("损坏的base64/长度明确报错，预览不把二进制或截断图片当文本", async () => {
  const kit = fixture();
  try {
    for (const data of ["%%%", "YQ=="]) {
      const h = harness(kit.root, { read_artifact: () => ({ ...captured(Buffer.from("expected")), data }) });
      await h.inspector.openToolFile(session.id, readTool("/tmp/bad.txt")); await settle();
      assert.ok(h.inspector.snapshots.get(h.inspector.activeTab()!.id)?.error);
    }
    assert.equal(readSnapshotFile("/tmp/binary", new Uint8Array([0, 255]), 2).kind, "unsupported");
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(readSnapshotFile("/tmp/image.png", png, 9).kind, "unsupported");
    assert.equal(readSnapshotFile("/tmp/image.png", png, 8).kind, "image");
  } finally { kit.close(); }
});

test("Read快照重试和同实例重同步只安装新响应，关闭重开保留调用身份", async () => {
  const kit = fixture();
  try {
    const blocked = gate(); let calls = 0;
    const h = harness(kit.root, { read_artifact: async () => { const count = ++calls; if (count === 1) await blocked.wait; return captured(Buffer.from(count === 1 ? "stale" : "fresh")); } });
    const tool = readTool("/tmp/version.txt"); await h.inspector.openToolFile(session.id, tool);
    const tab = h.inspector.activeTab()!; assert.equal(tab.kind, "read-snapshot"); if (tab.kind !== "read-snapshot") return;
    await h.inspector.loadReadSnapshot(tab, true); blocked.release(); await settle();
    const initial = h.inspector.snapshots.get(tab.id)?.file;
    assert.equal(initial?.kind === "text" && initial.content, "fresh");
    h.inspector.update({ type: "snapshot", instanceChanged: false, result: { snapshot: fakeSnapshot({ projects: h.model.view.projects, sessions: h.model.view.sessions }), replay: [], seq: 1 } });
    assert.equal(h.inspector.snapshots.has(tab.id), false);
    await h.inspector.loadReadSnapshot(tab);
    const restored = h.inspector.snapshots.get(tab.id)?.file;
    assert.equal(restored?.kind === "text" && restored.content, "fresh");
    h.inspector.closeTab(tab.id); await h.inspector.openToolFile(session.id, tool); await settle();
    assert.equal(h.inspector.activeTab()?.id, tab.id); assert.equal(calls, 4);
    assert.equal(h.inspector.tabs().filter(item => item.kind === "read-snapshot").length, 1);
  } finally { kit.close(); }
});

test("Desktop只向Code开放现有产物查询，不向Personal添加文件入口", async () => {
  let count = 0;
  const request = async () => { count++; return captured(Buffer.from("saved")); };
  assert.equal((await handleRequest("code", "read_artifact", { task_id: "task", artifact_id: "artifact" }, async () => {}, request)).ok, true);
  assert.equal((await handleRequest("personal", "read_artifact", { task_id: "task", artifact_id: "artifact" }, async () => {}, request)).ok, false);
  assert.equal(count, 1);
});

let server: ViteDevServer;
let ReadSnapshotPreview: ComponentType<{ model: CodeState; tab: Extract<InspectorTab, { kind: "read-snapshot" }> }>;
let WorkspaceFiles: ComponentType<{ model: CodeState; workspaceId: string }>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  ({ ReadSnapshotPreview, WorkspaceFiles } = await server.ssrLoadModule("/inspector-panels.tsx"));
});
after(async () => { await server?.close(); });
test("实际预览不显示捕获版本说明、partial紧凑提示与上限，静默刷新不把成功树换成spinner", async () => {
  const kit = fixture();
  try {
    const h = harness(kit.root, { read_artifact: () => captured(Buffer.from("const safe = '<script>';\n"), { status: "partial" }) });
    await h.inspector.openToolFile(session.id, readTool("/tmp/safe.ts")); await settle();
    const tab = h.inspector.activeTab()!;
    assert.equal(tab.kind, "read-snapshot"); if (tab.kind !== "read-snapshot") return;
    const html = renderToStaticMarkup(createElement(ReadSnapshotPreview, { model: h.model, tab }));
    assert.doesNotMatch(html, /Read 时捕获的版本|class="file-panel-empty"/); assert.match(html, /class="file-preview-note".*仅捕获了部分内容/);
    const snapshot = h.inspector.snapshots.get(tab.id)!; snapshot.partial = false;
    const complete = renderToStaticMarkup(createElement(ReadSnapshotPreview, { model: h.model, tab }));
    assert.doesNotMatch(complete, /file-preview-note|Read 时捕获的版本/); assert.match(html, /hljs/); assert.doesNotMatch(html, /<script>/);
    fs.writeFileSync(path.join(kit.root, "saved.txt"), "saved"); await h.inspector.loadDirectory("workspace", "");
    const state = h.inspector.directories.get("workspace:")!; state.loading = true;
    const tree = renderToStaticMarkup(createElement(WorkspaceFiles, { model: h.model, workspaceId: "workspace" }));
    assert.match(tree, /saved.txt/); assert.doesNotMatch(tree, /正在读取/);
    state.error = "刷新失败";
    const failed = renderToStaticMarkup(createElement(WorkspaceFiles, { model: h.model, workspaceId: "workspace" }));
    assert.match(failed, /saved.txt/); assert.match(failed, /刷新失败/);
  } finally { kit.close(); }
});

test("真实目录逐层续页，前部新增后刷新仍保留已展示的第400项及其缓存", async () => {
  const kit = fixture();
  try {
    for (let index = 0; index < 405; index++) fs.mkdirSync(path.join(kit.root, `entry-${String(index).padStart(4, "0")}`));
    fs.mkdirSync(path.join(kit.root, "nested"));
    for (let index = 0; index < 405; index++) fs.writeFileSync(path.join(kit.root, "nested", `${String(index).padStart(4, "0")}.txt`), "");
    const h = harness(kit.root);
    h.inspector.openFiles();
    await waitFor("根目录首读", () => h.inspector.directories.get("workspace:")?.loading === false);
    assert.equal(h.inspector.directories.get("workspace:")!.value!.entries.length, 200);
    await h.inspector.loadMoreDirectory("workspace", "");
    const last = h.inspector.directories.get("workspace:")!.value!.entries.at(-1)!;
    assert.equal(h.inspector.directories.get("workspace:")!.value!.entries.length, 400);
    h.inspector.directories.set(`workspace:${last.path}`, { loading: false, value: { workspaceId: "workspace", path: last.path, entries: [], nextCursor: null } });
    fs.mkdirSync(path.join(kit.root, "000-before"));
    await h.inspector.refreshDirectories("workspace");
    const refreshed = h.inspector.directories.get("workspace:")!.value!;
    assert.ok(refreshed.entries.some(entry => entry.path === last.path));
    assert.equal(refreshed.entries.length, 407); assert.equal(refreshed.nextCursor, null);
    assert.ok(h.inspector.directories.has(`workspace:${last.path}`));
    h.inspector.folders.set("workspace:nested", true);
    await h.inspector.loadDirectory("workspace", "nested");
    await h.inspector.loadMoreDirectory("workspace", "nested"); await h.inspector.loadMoreDirectory("workspace", "nested");
    const nested = h.inspector.directories.get("workspace:nested")!.value!;
    assert.equal(nested.entries.length, 405); assert.equal(new Set(nested.entries.map(entry => entry.path)).size, 405); assert.equal(nested.nextCursor, null);
    fs.rmdirSync(path.join(kit.root, last.path));
    await h.inspector.refreshDirectories("workspace");
    assert.equal(h.inspector.directories.has(`workspace:${last.path}`), false);
    assert.equal(h.inspector.directories.get("workspace:nested")!.value!.entries.length, 405);
  } finally { kit.close(); }
});
