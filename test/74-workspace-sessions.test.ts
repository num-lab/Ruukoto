/** Registered workspace identity, idempotent creation, execution history and conversation visibility. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store, StoreConflictError } from "@ruukoto/core/store.ts";
import { findWorkspaceByRoot } from "@ruukoto/control/workspace.ts";
import type { DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { Project, Session } from "@ruukoto/core/types.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { TuiApp } from "@ruukoto/tui/tui/app.ts";
import {
startTestRuntime,
waitFor,
createProjectSession,
taskStatus,
type TestRuntime,
} from "./helpers/testkit.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

// ---------- 类型夹具 ----------

function fakeProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: over.id,
    createRequestId: null,
    instructionFiles: [],

    settingsVersion: 1,
    rootDir: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}


function dirIdentityOf(dir: string): DirIdentity {
  const real = fs.realpathSync(dir);
  const stat = fs.statSync(real);
  return { cwd: path.resolve(dir), cwdReal: real, dev: stat.dev, ino: stat.ino };
}

// ---------- open_workspace：创建与复用 ----------

test("open_workspace：新建工作区记录根目录身份，快照与存储均可读", async () => {
  const t = await startTestRuntime("ws74-create", async () => ({ kind: "text", text: "x" }));
  try {
    const res = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-1" })) as any;
    assert.ok(res.session.id.startsWith("sess_"), "返回新会话");
    assert.equal(res.createdProject, true);
    const identity = dirIdentityOf(t.work[0]!);
    assert.equal(res.projectName, path.basename(identity.cwdReal), "项目名取根目录名");
    const project = t.runtime.store.getProject(res.session.projectId)!;
    assert.deepEqual(project.rootDir, identity, "工作区根目录身份落库");
    const handshake = await t.client.handshake();
    const snapProject = handshake.snapshot.projects.find((p) => p.id === project.id)!;
    assert.deepEqual(snapProject.rootDir, identity, "快照携带根目录身份");
    assert.equal(t.runtime.store.getSession(res.session.id)!.cwdReal, identity.cwdReal);
  } finally {
    await t.shutdown();
  }
});

test("open_workspace：符号链接别名复用同一工作区且每次新建会话；同名目录不合并", async () => {
  const t = await startTestRuntime("ws74-alias", async () => ({ kind: "text", text: "x" }));
  try {
    const first = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-a" })) as any;
    const link = path.join(t.dirs.root, "link-alias");
    fs.symlinkSync(t.work[0]!, link);
    const again = (await t.client.request<any>("open_workspace", { cwd: link, request_id: "boot-b" })) as any;
    assert.equal(again.session.projectId, first.session.projectId, "别名复用同一工作区");
    assert.notEqual(again.session.id, first.session.id, "每次打开仍新建会话");
    assert.equal(again.createdProject, false);
    const viaDot = (await t.client.request<any>("open_workspace", {
      cwd: path.join(t.work[0]!, "."),
      request_id: "boot-c",
    })) as any;
    assert.equal(viaDot.session.projectId, first.session.projectId, "路径变体复用同一工作区");
    assert.equal(
      t.runtime.store.listProjects().filter((p) => p.rootDir).length,
      1,
      "别名不重复创建工作区",
    );

    // 同名不同目录：各自成工作区，名称仅展示层去重
    const parentA = path.join(t.dirs.root, "parent-a");
    const parentB = path.join(t.dirs.root, "parent-b");
    fs.mkdirSync(path.join(parentA, "app"), { recursive: true });
    fs.mkdirSync(path.join(parentB, "app"), { recursive: true });
    const wa = (await t.client.request<any>("open_workspace", { cwd: path.join(parentA, "app"), request_id: "boot-d" })) as any;
    const wb = (await t.client.request<any>("open_workspace", { cwd: path.join(parentB, "app"), request_id: "boot-e" })) as any;
    assert.notEqual(wa.session.projectId, wb.session.projectId, "同名目录不合并");
    assert.equal(wa.projectName, "app");
    assert.equal(wb.projectName, "app (2)", "重名追加序号，仅展示层去重");
  } finally {
    await t.shutdown();
  }
});

test("open_workspace：根目录无需是 Git 仓库，含多个仓库的根目录照常打开", async () => {
  const t = await startTestRuntime("ws74-multirepo", async () => ({ kind: "text", text: "x" }));
  try {
    const mono = path.join(t.dirs.root, "mono");
    fs.mkdirSync(path.join(mono, "repo-a", ".git"), { recursive: true });
    fs.mkdirSync(path.join(mono, "repo-b", ".git"), { recursive: true });
    const res = (await t.client.request<any>("open_workspace", { cwd: mono, request_id: "boot-m" })) as any;
    assert.ok(t.runtime.store.getProject(res.session.projectId)!.rootDir, "多仓库根目录是一个工作区");
    assert.equal(t.runtime.store.getSession(res.session.id)!.cwdReal, fs.realpathSync(mono));
  } finally {
    await t.shutdown();
  }
});

test("open_workspace：同一请求标识重发返回原会话，不重复创建项目/会话", async () => {
  const t = await startTestRuntime("ws74-idem", async () => ({ kind: "text", text: "x" }));
  try {
    const first = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-r" })) as any;
    const again = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-r" })) as any;
    assert.equal(again.session.id, first.session.id);
    assert.equal(again.createdProject, false);
    const sessions = t.runtime.store.listSessions().filter((s) => s.createRequestId === "boot-r");
    assert.equal(sessions.length, 1, "重发不重复创建会话");
    const projects = t.runtime.store.listProjects().filter((p) => p.createRequestId === "boot-r");
    assert.equal(projects.length, 1, "重发不重复创建项目");
  } finally {
    await t.shutdown();
  }
});

test("open_workspace reuses a bound project but cannot move its root", async () => {
  const t = await startTestRuntime("ws74-bound", async () => ({ kind: "text", text: "x" }));
  try {
    const first = await t.runtime.openWorkspace({ cwd: t.work[0], createRequestId: "bound" });
    const projectId = first.session.projectId;
    const identity = dirIdentityOf(t.work[0]);
    const opened = await t.runtime.openWorkspace({ cwd: t.work[0], projectId, createRequestId: "explicit" });
    assert.equal(opened.session.projectId, projectId);
    assert.equal(opened.createdProject, false);
    assert.notEqual(opened.session.id, first.session.id);
    const auto = await t.runtime.openWorkspace({ cwd: t.work[0], createRequestId: "auto" });
    assert.equal(auto.session.projectId, projectId);
    await assert.rejects(t.runtime.openWorkspace({ cwd: t.work[1], projectId, createRequestId: "move" }), { code: "invalid_params" });
    assert.deepEqual(t.runtime.store.getProject(projectId)!.rootDir, identity);
    assert.equal(t.runtime.store.findSessionByCreateRequestId("move"), null);
  } finally { await t.shutdown(); }
});


test("createProject rejects duplicate directory identities without publishing a project", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ws74-root-"));
  const db = new Db(dataDir);
  try {
    const store = new Store(db);
    const root = { cwd: "/first", cwdReal: "/first", dev: 1, ino: 2 };
    const workspace = store.withTx(() => store.createProject("workspace", "first", root));
    const before = store.getMaxSeq();
    for (const alias of [{ ...root, cwd: "/alias" }, { cwd: "/bind", cwdReal: "/bind", dev: 1, ino: 2 }]) {
      assert.throws(() => store.withTx(() => store.createProject("duplicate", "duplicate", alias)), error => error instanceof StoreConflictError && error.code === "duplicate");
      assert.equal(store.getMaxSeq(), before);
      assert.equal(store.findProjectByCreateRequestId("duplicate"), null);
      assert.equal(store.findProjectByRoot(alias)!.id, workspace.id);
    }
    assert.equal(store.withTx(() => store.createProject("workspace", "first", root)).id, workspace.id);
    assert.equal(store.getMaxSeq(), before);
    const other = store.withTx(() => store.createProject("other", null, { cwd: "/other", cwdReal: "/other", dev: 3, ino: 4 }));
    assert.notEqual(other.id, workspace.id);
  } finally { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("open_workspace rejects an unbound project without assigning a root or creating a conversation", async () => {
  const t = await startTestRuntime("ws74-unbound", async () => ({ kind: "text", text: "x" }));
  try {
    const bound = await t.runtime.openWorkspace({ cwd: t.work[0] });
    const project = t.runtime.createProject("unbound");
    const before = t.runtime.store.getMaxSeq();
    await assert.rejects(t.client.request("open_workspace", { cwd: t.work[0], project_id: project.id, request_id: "unbound-open" }), { code: "invalid_params", outcome: "rejected" });
    assert.equal(t.runtime.store.getProject(project.id)!.rootDir, null);
    assert.equal(t.runtime.store.findSessionByCreateRequestId("unbound-open"), null);
    assert.equal(t.runtime.store.getMaxSeq(), before);
    assert.equal((await t.runtime.openWorkspace({ cwd: t.work[0] })).session.projectId, bound.session.projectId);
  } finally { await t.shutdown(); }
});



test("open_workspace：保护根可登记，不存在目录明确拒绝且不留空项目", async () => {
  const t = await startTestRuntime("ws74-protected", async () => ({ kind: "text", text: "x" }));
  try {
    const projectCount = t.runtime.store.listProjects().length;
    const opened = await t.runtime.openWorkspace({ cwd: t.dirs.dataDir, createRequestId: "boot-p" });
    assert.equal(opened.session.cwdReal, fs.realpathSync(t.dirs.dataDir));
    await assert.rejects(
      () => t.client.request("open_workspace", { cwd: path.join(t.dirs.root, "nope"), request_id: "boot-n" }),
      (err: any) => err.code === "invalid_params",
    );
    assert.equal(t.runtime.store.listProjects().length, projectCount + 1, "不存在目录不留空项目");
    assert.ok(t.runtime.store.listSessions().some((s) => s.createRequestId === "boot-p"));
  } finally {
    await t.shutdown();
  }
});


test("create_project and create_session leave root ownership unset and publish readable snapshots", async () => {
  const t = await startTestRuntime("ws74-unbound-ops", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!, { projectName: "手工项目" });
    assert.equal(t.runtime.store.getProject(projectId)!.rootDir, null, "旧 op 不写归属");
    const auto = (await t.client.request<any>("create_session", { project_name: "自动项目", cwd: t.work[1]! })) as any;
    assert.equal(t.runtime.store.getProject(auto.projectId)!.rootDir, null, "自动建项目旧路径不写归属");
    const handshake = await t.client.handshake();
    assert.equal(handshake.snapshot.projects.find((p) => p.id === projectId)!.rootDir, null);
    assert.ok(handshake.snapshot.sessions.some((s) => s.id === sessionId), "旧会话仍可读");
  } finally {
    await t.shutdown();
  }
});

// ---------- 完整路径：创建 → 执行 → 历史 ----------

test("open_workspace 完整路径：新会话可执行任务并在历史中查到", async () => {
  const t = await startTestRuntime("ws74-e2e", async () => ({ kind: "text", text: "pong" }));
  try {
    const res = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-e2e" })) as any;
    const sessionId = res.session.id as string;
    const task = (await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "e2e-1",
      input: "hello-workspace",
      model_selection: MODEL,
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    const page = (await t.client.request<any>("read_history", { session_id: sessionId })) as any;
    const text = JSON.stringify(page);
    assert.ok(text.includes("hello-workspace"), "历史含本次输入");
    assert.ok(text.includes("pong"), "历史含模型应答");
  } finally {
    await t.shutdown();
  }
});

// ---------- workspace.ts 纯函数 ----------

test("findWorkspaceByRoot：按 cwdReal 与 dev+ino 命中已归属工作区", () => {
  const wsRoot = { cwd: "/w", cwdReal: "/real/w", dev: 10, ino: 20 };
  const snapshot = {
    projects: [fakeProject({ id: "p1" }), fakeProject({ id: "p2", rootDir: wsRoot })],
  };
  assert.equal(findWorkspaceByRoot(snapshot, { cwd: "/a", cwdReal: "/real/w", dev: 99, ino: 99 })?.id, "p2", "cwdReal 命中");
  assert.equal(findWorkspaceByRoot(snapshot, { cwd: "/a", cwdReal: "/other", dev: 10, ino: 20 })?.id, "p2", "dev+ino 命中");
  assert.equal(findWorkspaceByRoot(snapshot, { cwd: "/a", cwdReal: "/other", dev: 11, ino: 21 }), null, "无关目录不命中");
});




// Workspace selection uses registered roots.

interface AppHarness {
  app: TuiApp;
  terminal: FakeTerminal;
  state: ViewState;
  exitCode(): number | null;
}

let harnessCounter = 74_000;

async function startPickerApp(t: TestRuntime): Promise<AppHarness> {
  const state = new ViewState();
  let appRef: TuiApp | null = null;
  const connection = new ControlConnection(
    {
      profile: t.dirs.profile,
      token: readOwnerToken(t.runtime.controlDir())!,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
    },
    {
      onState: (s, d) => appRef?.onConnectionState(s, d),
      onSnapshot: (r, ctx) => appRef?.onSnapshot(r, ctx),
      onEvent: (e, kind) => appRef?.onEvent(e, kind),
    },
  );
  const pendingStore = new PendingRequestStore(path.join(t.dirs.root, `pending-74-${harnessCounter++}`));
  const guard = new SubmissionGuard(pendingStore, connection);
  const terminal = new FakeTerminal();
  let exitCode: number | null = null;
  const app = new TuiApp({
    connection,
    guard,
    pendingStore,
    state,
    terminal,
    onExit: (code) => {
      exitCode = code;
    },
  });
  appRef = app;
  await app.start();
  await waitFor("TUI 上线", () => connection.state === "online" || exitCode !== null);
  return { app, terminal, state, exitCode: () => exitCode };
}


test("workspace picker lists registered roots and opens their conversations", async () => {
  const t = await startTestRuntime("ws74-tui-dev", async () => ({ kind: "text", text: "x" }));
  try {
    await t.client.request("open_workspace", { cwd: t.work[0]!, request_id: "boot-picker" });
    await t.client.request("open_workspace", { cwd: t.work[1]!, request_id: "boot-picker-second" });
    const h = await startPickerApp(t);
    try {
      await waitFor("选择面板出现", () => h.terminal.output().includes("选择工作区"));
      await waitFor("条目渲染", () => h.terminal.output().includes(path.basename(fs.realpathSync(t.work[1]!))));
      const out = h.terminal.output();
      const wsName = path.basename(fs.realpathSync(t.work[0]!));
      assert.ok(out.includes(wsName), "列出工作区");
      // No workspace precedes ordinary workspace choices.
      h.terminal.send("\x1b[B\r");
      await waitFor("会话选择面板", () => h.terminal.output().includes("选择会话"));
      h.app.quit(0);
      await waitFor("退出", () => h.exitCode() === 0);
    } finally {
      h.app.quit(0);
    }
  } finally {
    await t.shutdown();
  }
});




test("会话存档只影响列表可见性：历史任务保留，取消存档后恢复，架构间事件可重放", async () => {
  const t = await startTestRuntime("session-archive", async () => ({ kind: "text", text: "完成" }), { workDirs: 1 });
  try {
    const workspace = await t.runtime.openWorkspace({ cwd: t.work[0] });
    const session = workspace.session;
    const task = await t.runtime.submit({ sessionId: session.id, requestId: "archive-task", input: "先跑一次", modelSelection: t.runtime.defaultSelection });
    await waitFor("任务完成", () => t.runtime.store.getTask(task.id)?.status === "completed");
    const archived = await t.client.request<Session>("set_session_archived", { session_id: session.id, archived: true });
    assert.ok(archived.archivedAt, "存档写入时间戳");
    const stored = t.runtime.store.getSession(session.id)!;
    assert.deepEqual({ archivedAt: stored.archivedAt, queueState: stored.queueState, projectId: stored.projectId }, { archivedAt: archived.archivedAt, queueState: "active", projectId: session.projectId }, "只改存档标记");
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 1, "任务不受影响");
    assert.ok((await t.client.request<{ entries: unknown[] }>("read_history", { session_id: session.id })).entries.length > 0, "历史仍可读");
    const event = t.runtime.store.getEventsAfter(0).filter(item => item.body.type === "session.archive_changed").at(-1)!;
    const state = new ViewState();
    state.applySnapshot(await t.client.handshake(), false);
    state.applyEvent(event, "live");
    assert.equal(state.sessions.find(item => item.id === session.id)?.archivedAt, archived.archivedAt, "事件把存档状态投影进视图");
    const restored = await t.client.request<Session>("set_session_archived", { session_id: session.id, archived: false });
    assert.equal(restored.archivedAt, null);
    const again = await t.client.request<Session>("set_session_archived", { session_id: session.id, archived: false });
    assert.equal(again.archivedAt, null, "同值幂等");
    await assert.rejects(t.client.request("set_session_archived", { session_id: "sess_missing", archived: true }), /不存在/);
  } finally { await t.shutdown(); }
});
