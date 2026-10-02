/**
 * 工作区入口与创建幂等（issue 21）。
 *
 * 覆盖：
 * 1. create_project / create_session 的 request_id 幂等：同键同参返回已存在记录、
 *    同键异参 request_conflict、无键保持旧行为、格式校验、快照携带 createRequestId；
 * 2. workspace.ts 单元：目录解析（相对路径/不存在/文件/符号链接）、候选项目匹配
 *    （cwdReal 与 dev+ino、忽略 qq_group 等非 dev 类别、多目录旧项目不作候选（issue 07）、去重保序）、自动项目名去重；
 * 3. TUI 工作区入口（FakeTerminal + 真实后台）：0 项目自动创建、1 项目复用新建会话、
 *    多项目选择与取消、符号链接按相同目录身份归属、保护根拒绝、不存在路径退出、
 *    应答丢失后的重连核实（按启动请求标识找到会话，不重复创建）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ControlClient, ControlClientError } from "../src/control/client.ts";
import { ControlConnection } from "../src/control/connection.ts";
import { PendingRequestStore } from "../src/control/pending-requests.ts";
import { SubmissionGuard } from "../src/control/submission.ts";
import { readOwnerToken } from "../src/control/owner-token.ts";
import {
  findWorkspaceProjects,
  resolveWorkspaceDir,
} from "../src/control/workspace.ts";
import type { Project, Session } from "../src/core/types.ts";
import { ViewState } from "../src/tui/state.ts";
import { TuiApp } from "../src/tui/app.ts";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  makeTestDirs,
  cleanupDirs,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";

// ---------- TUI 测试装置 ----------

interface AppHarness {
  app: TuiApp;
  connection: ControlConnection;
  terminal: FakeTerminal;
  state: ViewState;
  exitCode(): number | null;
  exitMessage(): string | null;
}

let harnessCounter = 0;

async function startApp(
  t: TestRuntime,
  opts: {
    sessionId?: string;
    workspace?: { path: string };
    clientFactory?: (socketPath: string, timeoutMs: number) => Promise<ControlClient>;
  } = {},
): Promise<AppHarness> {
  // 调用方负责在 finally 中 app.quit()（失败时也不能遗留连接/定时器）
  const state = new ViewState();
  let appRef: TuiApp | null = null;
  const connection = new ControlConnection(
    {
      socketPath: t.runtime.socketPath(),
      token: readOwnerToken(t.runtime.controlDir())!,
      reconnectInitialMs: 50,
      reconnectMaxMs: 200,
      clientFactory: opts.clientFactory,
    },
    {
      onState: (s, d) => appRef?.onConnectionState(s, d),
      onSnapshot: (r, ctx) => appRef?.onSnapshot(r, ctx),
      onEvent: (e, kind) => appRef?.onEvent(e, kind),
    },
  );
  const pendingStore = new PendingRequestStore(path.join(t.dirs.root, `pending-ws-${harnessCounter++}`));
  const guard = new SubmissionGuard(pendingStore, connection);
  const terminal = new FakeTerminal();
  let exitCode: number | null = null;
  let exitMessage: string | null = null;
  const app = new TuiApp({
    connection,
    guard,
    pendingStore,
    state,
    terminal,
    initialSessionId: opts.sessionId,
    workspace: opts.workspace,
    onExit: (code, message) => {
      exitCode = code;
      exitMessage = message ?? null;
    },
  });
  appRef = app;
  await app.start();
  // 工作区解析失败会在首次握手中直接退出（不会到达 online）
  await waitFor("TUI 上线或退出", () => connection.state === "online" || exitCode !== null);
  return {
    app,
    connection,
    terminal,
    state,
    exitCode: () => exitCode,
    exitMessage: () => exitMessage,
  };
}

function quitAll(apps: AppHarness[]): void {
  for (const h of apps) h.app.quit(0);
}

async function renderFlush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

// ---------- 类型夹具 ----------

function fakeProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: over.id,
    createRequestId: null,
    rootDir: null,
    instructionFiles: [],
    webSearch: "enabled",
    settingsVersion: 1,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function fakeSession(over: Partial<Session> & { id: string; projectId: string }): Session {
  return {
    kind: "dev",
    workspaceProjectId: null,
    cwd: "/w",
    cwdReal: "/w",
    cwdDev: 1,
    cwdIno: 1,
    piSessionId: "pi",
    sessionFile: null,
    confirmTools: [],
    createRequestId: null,
    modelSelection: null,
    modelSelectionVersion: 0,
    defaultAccessMode: "confirm",
    defaultAccessModeVersion: 0,
    queueState: "active",
    queuePauseReason: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

// ---------- 创建幂等（存储/运行时/控制面） ----------

test("create_session 幂等：同键同参返回已存在会话；同键异参冲突；无键保持旧行为", async () => {
  const t = await startTestRuntime("ws-idem-session", async () => ({ kind: "text", text: "x" }));
  try {
    const project = await t.client.request<any>("create_project", { name: "idem-p" });
    const first = await t.client.request<any>("create_session", {
      project_id: project.id,
      cwd: t.work[0]!,
      request_id: "boot-key-1",
    });
    const again = await t.client.request<any>("create_session", {
      project_id: project.id,
      cwd: t.work[0]!,
      request_id: "boot-key-1",
    });
    assert.equal(again.id, first.id, "同键同参必须返回原会话");
    assert.equal(
      t.runtime.store.listSessions().filter((s) => s.projectId === project.id).length,
      1,
      "去重后不产生第二条会话",
    );

    await assert.rejects(
      () => t.client.request("create_session", { project_id: project.id, cwd: t.work[1]!, request_id: "boot-key-1" }),
      (err: any) => err.code === "request_conflict",
      "同键不同 cwd 必须冲突",
    );
    await assert.rejects(
      () =>
        t.client.request("create_session", {
          project_id: project.id,
          cwd: t.work[0]!,
          confirm_tools: ["mock_gate"],
          request_id: "boot-key-1",
        }),
      (err: any) => err.code === "request_conflict",
      "同键不同 confirm_tools 必须冲突",
    );

    // 无 request_id：每次新建（旧行为不变）
    const s1 = await t.client.request<any>("create_session", { project_id: project.id, cwd: t.work[0]! });
    const s2 = await t.client.request<any>("create_session", { project_id: project.id, cwd: t.work[0]! });
    assert.notEqual(s1.id, s2.id);

    // 格式校验：非法字符与超长都拒绝
    await assert.rejects(
      () => t.client.request("create_session", { project_id: project.id, cwd: t.work[0]!, request_id: "bad id" }),
      (err: any) => err.code === "invalid_params",
    );
    await assert.rejects(
      () => t.client.request("create_session", { project_id: project.id, cwd: t.work[0]!, request_id: "x".repeat(129) }),
      (err: any) => err.code === "invalid_params",
    );
  } finally {
    await t.shutdown();
  }
});

test("create_project 幂等：同键同名返回已存在项目；同键异名冲突；无键重名仍报 duplicate", async () => {
  const t = await startTestRuntime("ws-idem-project", async () => ({ kind: "text", text: "x" }));
  try {
    const first = await t.client.request<any>("create_project", { name: "proj-a", request_id: "pk-1" });
    const again = await t.client.request<any>("create_project", { name: "proj-a", request_id: "pk-1" });
    assert.equal(again.id, first.id, "同键同名必须返回原项目");
    assert.equal(
      t.runtime.store.listProjects().filter((p) => p.name === "proj-a").length,
      1,
      "去重后不产生第二个项目",
    );

    await assert.rejects(
      () => t.client.request("create_project", { name: "proj-b", request_id: "pk-1" }),
      (err: any) => err.code === "request_conflict",
      "同键异名必须冲突",
    );
    await assert.rejects(
      () => t.client.request("create_project", { name: "proj-a" }),
      (err: any) => err.code === "duplicate",
      "无键重名保持旧的 duplicate 行为",
    );
    await assert.rejects(
      () => t.client.request("create_project", { name: "proj-c", request_id: "bad id" }),
      (err: any) => err.code === "invalid_params",
    );
  } finally {
    await t.shutdown();
  }
});

test("快照与事件携带 createRequestId；无键创建为 null", async () => {
  const t = await startTestRuntime("ws-snapshot", async () => ({ kind: "text", text: "x" }));
  try {
    const project = await t.client.request<any>("create_project", { name: "snap-p", request_id: "snap-key" });
    const session = await t.client.request<any>("create_session", {
      project_id: project.id,
      cwd: t.work[0]!,
      request_id: "snap-key",
    });
    const plain = await t.client.request<any>("create_project", { name: "snap-plain" });

    const handshake = await t.client.handshake();
    assert.deepEqual(
      handshake.snapshot.roleSessionIds,
      t.runtime.store.listAgentRoles().map((r) => r.sessionId),
      "快照列出逻辑角色会话",
    );
    assert.ok(handshake.snapshot.roleSessionIds!.length > 0, "编排器已引导角色");
    assert.equal(
      handshake.snapshot.sessions.find((s) => s.id === session.id)?.createRequestId,
      "snap-key",
      "快照会话携带创建幂等键",
    );
    assert.equal(
      handshake.snapshot.projects.find((p) => p.id === project.id)?.createRequestId,
      "snap-key",
      "快照项目携带创建幂等键",
    );
    assert.equal(
      handshake.snapshot.projects.find((p) => p.id === plain.id)?.createRequestId,
      null,
      "无键创建的记录为 null",
    );
  } finally {
    await t.shutdown();
  }
});

// ---------- workspace.ts 单元 ----------

test("resolveWorkspaceDir：相对路径按客户端 cwd 解析；不存在/文件/符号链接", async () => {
  const { dirs, work } = await makeTestDirs("ws-resolve", 1);
  try {
    const identity = await resolveWorkspaceDir("work-0", dirs.root);
    assert.equal(identity.cwd, work[0]!, "相对路径按客户端 cwd 解析");
    assert.equal(identity.cwdReal, fs.realpathSync(work[0]!));

    await assert.rejects(
      () => resolveWorkspaceDir("nope", dirs.root),
      (err: Error) => err.message === "目录不存在：nope",
    );

    const file = path.join(dirs.root, "a-file");
    fs.writeFileSync(file, "x");
    await assert.rejects(
      () => resolveWorkspaceDir(file, dirs.root),
      (err: Error) => err.message === `工作区必须是目录：${file}`,
    );

    const link = path.join(dirs.root, "link-0");
    fs.symlinkSync(work[0]!, link);
    const viaLink = await resolveWorkspaceDir(link, dirs.root);
    assert.equal(viaLink.cwd, link, "cwd 保留调用方路径");
    assert.equal(viaLink.cwdReal, identity.cwdReal, "符号链接解析到同一真实路径");
    assert.equal(viaLink.dev, identity.dev);
    assert.equal(viaLink.ino, identity.ino);
  } finally {
    await cleanupDirs(dirs);
  }
});

test("findWorkspaceProjects：按 cwdReal 与 dev+ino 匹配，忽略非 dev 与角色会话，去重保序", () => {
  const projA = fakeProject({ id: "proj_a", name: "A" });
  const projB = fakeProject({ id: "proj_b", name: "B" });
  const projQq = fakeProject({ id: "proj_qq", name: "QQ" });
  const projRole = fakeProject({ id: "proj_role", name: "main" });
  const identity = { cwd: "/work/x", cwdReal: "/work/x", dev: 10, ino: 20 };
  const snapshot = {
    projects: [projA, projB, projQq, projRole],
    sessions: [
      // cwdReal 相同（符号链接别名）
      fakeSession({ id: "s1", projectId: "proj_a", cwd: "/alias/x", cwdReal: "/work/x", cwdDev: 10, cwdIno: 20 }),
      // cwdReal 不同（目录被移动过）但 dev+ino 相同（挂载别名）
      fakeSession({ id: "s2", projectId: "proj_b", cwd: "/old/x", cwdReal: "/old/x", cwdDev: 10, cwdIno: 20 }),
      // 同项目第二条会话：项目只出现一次
      fakeSession({ id: "s3", projectId: "proj_a", cwd: "/work/x", cwdReal: "/work/x", cwdDev: 10, cwdIno: 20 }),
      // qq_group 会话不作为工作区归属依据
      fakeSession({ id: "s4", projectId: "proj_qq", kind: "qq_group", cwd: "/work/x", cwdReal: "/work/x", cwdDev: 10, cwdIno: 20 }),
      // 逻辑角色会话（kind 仍为 dev）同样不作为归属依据
      fakeSession({ id: "s_role", projectId: "proj_role", cwd: "/work/x", cwdReal: "/work/x", cwdDev: 10, cwdIno: 20 }),
      // 无关目录；proj_b 因此分布在多个真实目录，issue 07 起不作目录候选（经迁移流程处理）
      fakeSession({ id: "s5", projectId: "proj_b", cwd: "/elsewhere", cwdReal: "/elsewhere", cwdDev: 11, cwdIno: 21 }),
    ],
    roleSessionIds: ["s_role"],
  };
  const found = findWorkspaceProjects(snapshot, identity);
  assert.deepEqual(
    found.map((p) => p.id),
    ["proj_a"],
    "按快照顺序去重返回候选项目；多目录旧项目不作候选（issue 07 收紧）",
  );
});

// ---------- TUI 工作区入口 ----------

test("工作区入口：无候选项目时自动创建项目（建议名）并进入新会话", async () => {
  const t = await startTestRuntime("ws-tui-fresh", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const h = await startApp(t, { workspace: { path: t.work[0]! } });
    apps.push(h);
    await waitFor("进入新会话", () => h.state.currentSessionId !== null);
    const sessionId = h.state.currentSessionId!;
    // 路径与项目归属以后台存储为准（事件投影的 cwdReal 只是 cwd 的占位）
    await waitFor("会话落库", () => t.runtime.store.getSession(sessionId) !== null);
    const session = t.runtime.store.getSession(sessionId)!;
    assert.equal(session.cwdReal, fs.realpathSync(t.work[0]!));
    assert.ok(session.createRequestId!.startsWith("boot-"), "会话带启动请求标识");
    const project = t.runtime.store.getProject(session.projectId)!;
    assert.equal(project.name, path.basename(fs.realpathSync(t.work[0]!)), "项目名取目录名");
    assert.equal(project.createRequestId, session.createRequestId, "项目与会话共用同一启动请求标识");
    await waitFor("自动创建提示", () => {
      const notes = h.state.sessionViews.get(sessionId)?.flow.items.filter((n) => n.kind === "note").map((n) => n.text).join("\n") ?? "";
      return notes.includes(`项目已自动创建：${project.name}`);
    });
    assert.equal(
      t.runtime.store.listSessions().filter((s) => s.projectId === project.id).length,
      1,
      "后台只有这一条该工作区会话",
    );
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口：唯一候选项目被复用，仍创建新会话", async () => {
  const t = await startTestRuntime("ws-tui-reuse", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const { projectId, sessionId: oldSessionId } = await createProjectSession(t.client, t.work[0]!, {
      projectName: "已有项目",
    });
    const baseSessions = t.runtime.store.listSessions().length;
    const baseProjects = t.runtime.store.listProjects().length;

    const h = await startApp(t, { workspace: { path: t.work[0]! } });
    apps.push(h);
    await waitFor("进入新会话", () => h.state.currentSessionId !== null);
    const sessionId = h.state.currentSessionId!;
    assert.notEqual(sessionId, oldSessionId, "每次独立启动都创建新会话");
    await waitFor("会话落库", () => t.runtime.store.getSession(sessionId) !== null);
    const session = t.runtime.store.getSession(sessionId)!;
    assert.equal(session.projectId, projectId, "复用已有项目");
    assert.equal(t.runtime.store.listSessions().length, baseSessions + 1, "只新增一条会话");
    assert.equal(t.runtime.store.listProjects().length, baseProjects, "不新建项目");
    const notes = h.state.sessionViews.get(sessionId)?.flow.items.filter((n) => n.kind === "note").map((n) => n.text).join("\n") ?? "";
    assert.ok(!notes.includes("项目已自动创建"), "复用项目不应提示自动创建");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口：多个候选项目先选择，选中后创建会话进入", async () => {
  const t = await startTestRuntime("ws-tui-pick", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const first = await createProjectSession(t.client, t.work[0]!, { projectName: "项目甲" });
    await createProjectSession(t.client, t.work[0]!, { projectName: "项目乙" });
    const baseSessions = t.runtime.store.listSessions().length;

    const h = await startApp(t, { workspace: { path: t.work[0]! } });
    apps.push(h);
    await waitFor("候选面板出现", () => {
      const out = h.terminal.output();
      return out.includes("项目甲") && out.includes("项目乙");
    });
    assert.equal(h.state.currentSessionId, null, "选择前不进入任何会话");
    // 回车选中第一项（按快照顺序为项目甲）
    h.terminal.send("\r");
    await waitFor("进入选中项目的会话", () => h.state.currentSessionId !== null);
    assert.equal(t.runtime.store.listSessions().length, baseSessions + 1, "选中后只创建一条会话");
    await waitFor("会话落库", () => t.runtime.store.getSession(h.state.currentSessionId!) !== null);
    const session = t.runtime.store.getSession(h.state.currentSessionId!)!;
    assert.equal(session.projectId, first.projectId, "进入选中项目的新会话");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口：多项目选择取消后不创建任何项目/会话，回落正常启动流程", async () => {
  const t = await startTestRuntime("ws-tui-cancel", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    await createProjectSession(t.client, t.work[0]!, { projectName: "项目甲" });
    await createProjectSession(t.client, t.work[0]!, { projectName: "项目乙" });
    const baseSessions = t.runtime.store.listSessions().length;
    const baseProjects = t.runtime.store.listProjects().length;

    const h = await startApp(t, { workspace: { path: t.work[0]! } });
    apps.push(h);
    await waitFor("候选面板出现", () => h.terminal.output().includes("项目甲"));
    h.terminal.send("\x1b"); // Esc 取消
    await renderFlush();
    assert.equal(t.runtime.store.listSessions().length, baseSessions, "取消不创建会话");
    assert.equal(t.runtime.store.listProjects().length, baseProjects, "取消不创建项目");
    assert.equal(h.state.currentSessionId, null, "不留下选中的会话");
    // 回落正常启动流程：已有会话时打开项目选择（「选择项目」面板；候选面板标题
    // 是「选择要进入的项目」、首帧页眉是「未选择会话」，两者都不含这个连续子串）
    await waitFor("回落到项目选择", () => h.terminal.output().includes("选择项目"), 30_000);
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口：符号链接路径按相同目录身份归属已有项目", async () => {
  const t = await startTestRuntime("ws-tui-symlink", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!, { projectName: "真实路径项目" });
    const link = path.join(t.dirs.root, "link-work0");
    fs.symlinkSync(t.work[0]!, link);

    const h = await startApp(t, { workspace: { path: link } });
    apps.push(h);
    await waitFor("进入新会话", () => h.state.currentSessionId !== null);
    await waitFor("会话落库", () => t.runtime.store.getSession(h.state.currentSessionId!) !== null);
    const session = t.runtime.store.getSession(h.state.currentSessionId!)!;
    assert.equal(session.projectId, projectId, "符号链接别名复用同一项目");
    assert.equal(session.cwdReal, fs.realpathSync(t.work[0]!), "cwdReal 为真实路径");
    assert.equal(session.cwd, link, "cwd 保留调用方给出的路径");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口：保护根目录被后台拒绝，提示错误且不创建会话、不留选中状态", async () => {
  const t = await startTestRuntime("ws-tui-protected", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const projectsBefore = t.runtime.store.listProjects().length;
    const h = await startApp(t, { workspace: { path: t.dirs.dataDir } });
    apps.push(h);
    await waitFor("错误提示", () =>
      h.state.globalNotes.some((n) => n.text.includes("工作区会话创建失败")),
    );
    assert.equal(h.state.currentSessionId, null, "不留下半选中状态");
    assert.ok(
      !t.runtime.store.listSessions().some((s) => s.cwdReal === fs.realpathSync(t.dirs.dataDir)),
      "保护根不创建会话",
    );
    assert.equal(t.runtime.store.listProjects().length, projectsBefore, "保护根不留下自动创建的空项目");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口：路径不存在时明确报错退出，不新建", async () => {
  const t = await startTestRuntime("ws-tui-missing", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    const missing = path.join(t.dirs.root, "不存在的目录");
    const h = await startApp(t, { workspace: { path: missing } });
    apps.push(h);
    await waitFor("报错退出", () => h.exitCode() === 1, 5000);
    assert.ok(h.exitMessage()?.includes(`目录不存在：${missing}`), `实际退出信息：${h.exitMessage()}`);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口请求超时（连接未断）：按同一启动请求标识重发，不卡住也不重复创建", async () => {
  const t = await startTestRuntime("ws-tui-timeout", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    let timedOut = false;
    // 首次 create_session 照常发往后台（服务端落库），客户端却拿到 request_timeout；连接不断开
    const clientFactory = async (socketPath: string, timeoutMs: number): Promise<ControlClient> => {
      const client = await ControlClient.connect(socketPath, timeoutMs);
      const orig = client.request.bind(client);
      (client as any).request = async (op: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown> => {
        if (op === "open_workspace" && !timedOut) {
          timedOut = true;
          await orig(op, params, timeout);
          throw new ControlClientError("request_timeout", "模拟请求超时", "unknown");
        }
        return orig(op, params, timeout);
      };
      return client;
    };
    const h = await startApp(t, { workspace: { path: t.work[0]! }, clientFactory });
    apps.push(h);
    await waitFor("重发后进入会话", () => h.state.currentSessionId !== null, 20_000);
    assert.ok(timedOut, "确实模拟了请求超时");
    const created = t.runtime.store.listSessions().filter((s) => s.createRequestId !== null);
    assert.equal(created.length, 1, "重发不重复创建会话");
    assert.equal(h.state.currentSessionId, created[0]!.id);
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});

test("工作区入口应答丢失：重连后按启动请求标识核实，不重复创建", async () => {
  const t = await startTestRuntime("ws-tui-retry", async () => ({ kind: "text", text: "x" }));
  const apps: AppHarness[] = [];
  try {
    let firstClient = true;
    let dropped = false;
    // 首个连接的 create_session：请求照常发往后台（服务端落库），但客户端拿到的是
    // 连接错误（模拟应答丢失），随后连接真正断开，触发自动重连核实
    const clientFactory = async (socketPath: string, timeoutMs: number): Promise<ControlClient> => {
      const client = await ControlClient.connect(socketPath, timeoutMs);
      if (firstClient) {
        firstClient = false;
        const orig = client.request.bind(client);
        (client as any).request = (op: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown> => {
          if (op === "open_workspace" && !dropped) {
            dropped = true;
            const real = orig(op, params, timeout);
            real.catch(() => {});
            void (async () => {
              await waitFor("会话已落库", () =>
                t.runtime.store.listSessions().some((s) => s.createRequestId !== null),
              );
              client.close();
            })();
            return Promise.reject(new ControlClientError("connection_closed", "模拟应答丢失", "disconnected"));
          }
          return orig(op, params, timeout);
        };
      }
      return client;
    };
    const h = await startApp(t, { workspace: { path: t.work[0]! }, clientFactory });
    apps.push(h);
    await waitFor("重连后进入会话", () => h.state.currentSessionId !== null, 20_000);
    assert.ok(dropped, "确实模拟了应答丢失");
    const created = t.runtime.store.listSessions().filter((s) => s.createRequestId !== null);
    assert.equal(created.length, 1, "重连核实不重复创建会话");
    assert.equal(h.state.currentSessionId, created[0]!.id, "进入的正是按标识核实到的会话");
    const createdProjects = t.runtime.store.listProjects().filter((p) => p.createRequestId !== null);
    assert.equal(createdProjects.length, 1, "项目也不重复创建");
    h.app.quit(0);
    await waitFor("退出", () => h.exitCode() === 0);
  } finally {
    quitAll(apps);
    await new Promise((r) => setTimeout(r, 100));
    await t.shutdown();
  }
});
