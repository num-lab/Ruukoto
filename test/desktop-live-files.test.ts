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
import { listWorkspaceFiles } from "@ruukoto/runtime/workspace-files.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import type { DiffTool } from "../apps/desktop/src/renderer/diff.ts";
import { handleRequest, ipcResult } from "../apps/desktop/src/main/ipc.ts";
import { startFilesRefresh } from "../apps/desktop/src/renderer/files-refresh.ts";
import { READ_SNAPSHOT_BYTES, readSnapshotFile } from "../apps/desktop/src/renderer/read-snapshot.ts";
import type { InspectorTab } from "../apps/desktop/src/renderer/inspector.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";

const at = "2026-10-17T00:00:00Z";
const session: Session = { id: "session", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "s", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, createdAt: at };
function harness(root: string, handlers: FakeHandlers = {}) {
  const identity = resolveDirIdentitySync(root);
  const project: Project = { id: "workspace", name: "工作区", rootDir: identity, createRequestId: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at };
  const transport = new FakeTransport({ handlers: { work_list: () => ({ works: [] }), list_workspace_files: params => listWorkspaceFiles(params.workspace_id, identity, params.path ?? "", []), ...handlers } });
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
const readTool = (path: string, extra: Partial<DiffTool> = {}): DiffTool => ({ kind: "tool", key: "read", name: "read", target: path, params: { path }, paramsTruncated: false, status: "done", entryId: "entry", taskId: "task", toolOpId: "op", toolCallId: "sdk", at, seq: 1, summary: null, artifactIds: ["artifact"], ...extra });
function captured(bytes: Buffer, extra: Partial<OpResult<"read_artifact">["artifact"]> = {}): OpResult<"read_artifact"> {
  return { artifact: { id: "artifact", taskId: "task", sessionId: session.id, name: "展示名称可更改", byteCount: bytes.length, status: "complete", createdAt: at, ...extra }, encoding: "base64", data: bytes.subarray(0, READ_SNAPSHOT_BYTES).toString("base64") };
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
    h.inspector.openFiles(); await settle();
    assert.deepEqual(h.inspector.directories.get("workspace:")?.value?.entries.map(entry => entry.name), ["old.txt"]);
    fs.unlinkSync(path.join(kit.root, "old.txt")); fs.writeFileSync(path.join(kit.root, "new.txt"), "new");
    h.inspector.openBrowser(); h.inspector.openFiles(); await settle();
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
    h.inspector.openFiles(); await settle(); await h.inspector.refreshDirectories("workspace");
    const stop = startFilesRefresh(h.inspector, "workspace", host); await settle();
    assert.equal(host.timers.size, 1);
    fs.writeFileSync(path.join(kit.root, "expanded", "new.txt"), "new"); host.tick(); await settle();
    assert.equal(h.inspector.directories.get("workspace:expanded")?.value?.entries[0].name, "new.txt");
    fs.unlinkSync(path.join(kit.root, "expanded", "new.txt")); host.dispatchEvent(new Event("focus")); await settle();
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
    const h = harness(kit.root, { list_workspace_files: async params => { if (wait) await blocked.wait; if (fail) throw new Error("刷新失败"); return listWorkspaceFiles(params.workspace_id, resolveDirIdentitySync(kit.root), params.path ?? "", []); } });
    h.inspector.openFiles(); await settle(); await h.inspector.refreshDirectories("workspace");
    h.inspector.files.set("workspace:old.txt", { loading: false, value: { workspaceId: "workspace", path: "old.txt", kind: "text", content: "old", size: 3 } });
    const host = new RefreshHost(); wait = true; const stop = startFilesRefresh(h.inspector, "workspace", host);
    const count = h.transport.requests.length;
    host.dispatchEvent(new Event("focus")); host.dispatchEvent(new Event("focus"));
    assert.equal(h.transport.requests.length, count);
    assert.equal(h.inspector.directories.get("workspace:")?.loading, true);
    assert.equal(h.inspector.directories.get("workspace:")?.value?.entries[0].name, "old.txt");
    fail = true; blocked.release(); await settle();
    assert.match(h.inspector.directories.get("workspace:")?.error ?? "", /刷新失败/);
    assert.equal(h.inspector.directories.get("workspace:")?.value?.entries[0].name, "old.txt");
    fail = false; wait = false; fs.unlinkSync(path.join(kit.root, "old.txt"));
    host.dispatchEvent(new Event("focus")); await settle();
    assert.equal(h.inspector.directories.get("workspace:")?.value?.entries.length, 0);
    assert.equal(h.inspector.files.has("workspace:old.txt"), false);
    stop();
  } finally { kit.close(); }
});

test("切换面板后在途刷新不继续扫描展开目录，离线不再发请求", async () => {
  const kit = fixture();
  try {
    fs.mkdirSync(path.join(kit.root, "expanded")); const blocked = gate(); let wait = false;
    const h = harness(kit.root, { list_workspace_files: async params => { if (wait) await blocked.wait; return listWorkspaceFiles(params.workspace_id, resolveDirIdentitySync(kit.root), params.path ?? "", []); } });
    h.inspector.folders.set("workspace:expanded", true); h.inspector.openFiles(); await settle(); await h.inspector.refreshDirectories("workspace");
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
    const h = harness(kit.root, { list_workspace_files: async params => { if (wait) await blocked.wait; return listWorkspaceFiles(params.workspace_id, resolveDirIdentitySync(kit.root), params.path ?? "", []); } });
    h.inspector.folders.set("workspace:expanded", true); h.inspector.openFiles(); await settle(); await h.inspector.refreshDirectories("workspace");
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

test("快照读取有界，partial与截断可见；关闭/离线丢弃迟到内容", async () => {
  const kit = fixture();
  try {
    const bytes = Buffer.from("中".repeat(READ_SNAPSHOT_BYTES));
    const h = harness(kit.root, { read_artifact: () => captured(bytes, { status: "partial" }) });
    assert.equal(await h.inspector.openToolFile(session.id, readTool("/tmp/large.ts")), true); await settle();
    const active = h.inspector.activeTab()!, state = h.inspector.snapshots.get(active.id);
    assert.equal(state?.partial, true); assert.equal(state?.truncated, true);
    assert.equal(state?.file?.kind === "text" && Buffer.byteLength(state.file.content), READ_SNAPSHOT_BYTES - 1);
    assert.equal((h.transport.requests.find(request => request.op === "read_artifact")!.params as OpParams<"read_artifact">).length, READ_SNAPSHOT_BYTES);
    for (const action of ["close", "offline"] as const) {
      const blocked = gate(), late = harness(kit.root, { read_artifact: async () => { await blocked.wait; return captured(Buffer.from("old")); } });
      await late.inspector.openToolFile(session.id, readTool("/tmp/late.txt")); const id = late.inspector.activeTab()!.id;
      if (action === "close") late.inspector.closeTab(id); else late.model.update({ type: "state", state: "reconnecting" });
      blocked.release(); await settle(); assert.equal(late.inspector.snapshots.has(id), false);
    }
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
    assert.equal(readSnapshotFile("/tmp/binary", new Uint8Array([0, 255]), "AP8=", 2).kind, "unsupported");
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(readSnapshotFile("/tmp/image.png", png, Buffer.from(png).toString("base64"), 9).kind, "unsupported");
    assert.equal(readSnapshotFile("/tmp/image.png", png, Buffer.from(png).toString("base64"), 8).kind, "image");
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
test("实际预览标明Read捕获/partial/上限，静默刷新不把成功树换成spinner", async () => {
  const kit = fixture();
  try {
    const h = harness(kit.root, { read_artifact: () => captured(Buffer.from("const safe = '<script>';\n"), { status: "partial" }) });
    await h.inspector.openToolFile(session.id, readTool("/tmp/safe.ts")); await settle();
    const tab = h.inspector.activeTab()!;
    assert.equal(tab.kind, "read-snapshot"); if (tab.kind !== "read-snapshot") return;
    const html = renderToStaticMarkup(createElement(ReadSnapshotPreview, { model: h.model, tab }));
    assert.match(html, /Read 时捕获的版本.*仅捕获了部分内容/); assert.match(html, /hljs/); assert.doesNotMatch(html, /<script>/);
    fs.writeFileSync(path.join(kit.root, "saved.txt"), "saved"); await h.inspector.loadDirectory("workspace", "");
    const state = h.inspector.directories.get("workspace:")!; state.loading = true;
    const tree = renderToStaticMarkup(createElement(WorkspaceFiles, { model: h.model, workspaceId: "workspace" }));
    assert.match(tree, /saved.txt/); assert.doesNotMatch(tree, /正在读取/);
    state.error = "刷新失败";
    const failed = renderToStaticMarkup(createElement(WorkspaceFiles, { model: h.model, workspaceId: "workspace" }));
    assert.match(failed, /saved.txt/); assert.match(failed, /刷新失败/);
  } finally { kit.close(); }
});
