/**
 * 按工作区创建和切换开发会话（agent-direction issue 05）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 *
 * 测试接缝（预先约定）：
 * 1. open_workspace op：新建工作区并记录根目录身份；别名（符号链接/路径变体）复用
 *    同一工作区且每次新建会话；同名不同目录各自成工作区不合并；同一请求标识重发
 *    幂等；旧项目经 project_id 认领根目录后自动归属，已归属他目录的项目拒绝改归属；
 *    保护根拒绝且不留空项目；认领冲突返回 duplicate（事务回滚，不留会话与归属），
 *    混合旧项目不可认领、目录打开直接新建工作区（评审 R1/R2/R5）；
 * 2. 兼容：create_project/create_session 旧行为不变（不写根目录归属），v18 库升级
 *    到 v19 后旧项目/会话仍可读；
 * 3. 完整路径：open_workspace → submit 执行 → read_history 查看历史；
 * 4. workspace.ts 纯函数：findWorkspaceByRoot / findWorkspaceProjects（已归属工作区
 *    不再充当遗留候选；混合旧项目不作目录候选）/ workspacePickerProjects（工作区与
 *    旧项目分列，角色与群聊项目不进入普通列表）；
 * 5. store 层目录身份：attachProjectRoot 对相同 dev+ino 的挂载别名拒绝认领（评审 R1）；
 * 6. TUI 选择面板：ruukoto-code 产品下列出工作区与旧项目、不出现角色与群聊项目；
 *    ruukoto 产品下行为不变（角色项目仍列出）。
 *
 * 本文件只做离线进程级断言（模型打桩，进程/文件/socket/SQLite/Pseudo-Terminal 真实）；
 * 真实环境（macOS 本机真实 bin）验证记录见 .scratch/agent-direction/smoke-05-workspace-sessions.mts
 * 与工单 Comments。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store, StoreConflictError } from "@ruukoto/core/store.ts";
import {
  findWorkspaceByRoot,
  findWorkspaceProjects,
  workspacePickerProjects,
} from "@ruukoto/control/workspace.ts";
import type { DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { Project, Session } from "@ruukoto/core/types.ts";
import { ViewState, sessionTitleAttribution } from "@ruukoto/tui/tui/state.ts";
import { TuiApp } from "@ruukoto/tui/tui/app.ts";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { FakeTerminal } from "./helpers/fake-terminal.ts";
import { LEGACY_PROJECT_WRITE_HINT } from "@ruukoto/tui/tui/commands.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

// ---------- 类型夹具 ----------

function fakeProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: over.id,
    createRequestId: null,
    instructionFiles: [],
    webSearch: "enabled",
    settingsVersion: 1,
    rootDir: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function fakeSession(over: Partial<Session> & { id: string; projectId: string }): Session {
  return {
    kind: "dev",
    workspaceProjectId: null,
    name: null,
    branchSource: null,
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
    queuePauseReason: null, archivedAt: null,
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

test("open_workspace：旧项目按 project_id 认领根目录后自动归属；归属他目录的项目拒绝改归属", async () => {
  const t = await startTestRuntime("ws74-adopt", async () => ({ kind: "text", text: "x" }));
  try {
    // 旧关系：create_session 建的项目没有根目录归属
    const { projectId } = await createProjectSession(t.client, t.work[0]!, { projectName: "旧项目" });
    assert.equal(t.runtime.store.getProject(projectId)!.rootDir, null);

    const adopted = (await t.client.request<any>("open_workspace", {
      cwd: t.work[0]!,
      project_id: projectId,
      request_id: "boot-adopt",
    })) as any;
    assert.equal(adopted.session.projectId, projectId);
    assert.equal(adopted.createdProject, false);
    const identity = dirIdentityOf(t.work[0]!);
    assert.deepEqual(t.runtime.store.getProject(projectId)!.rootDir, identity, "旧项目认领根目录");

    // 认领后再次打开同目录（不带 project_id）自动归属该项目
    const auto = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-auto" })) as any;
    assert.equal(auto.session.projectId, projectId);
    assert.notEqual(auto.session.id, adopted.session.id, "仍新建会话");

    // 已归属其他目录的项目不得改归属
    await assert.rejects(
      () => t.client.request("open_workspace", { cwd: t.work[1]!, project_id: projectId, request_id: "boot-move" }),
      (err: any) => err.code === "invalid_params",
      "已归属他目录的项目拒绝改归属",
    );
    assert.deepEqual(t.runtime.store.getProject(projectId)!.rootDir, identity, "根目录归属未被改写");
    // 认领事件留痕
    const events = t.runtime.store.getEventsAfter(0);
    assert.ok(
      events.some((e) => e.body.type === "project.root_attached" && (e.body as any).projectId === projectId),
      "认领产生 project.root_attached 事件",
    );
  } finally {
    await t.shutdown();
  }
});

// ---------- 认领冲突（评审 R1/R2） ----------

test("attachProjectRoot：相同 dev+ino 的挂载别名认领冲突；同项目相同身份幂等", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ws74-attach-"));
  const db = new Db(dataDir);
  try {
    const store = new Store(db);
    const ws = store.withTx(() => store.createProject("工作区", null, { cwd: "/first", cwdReal: "/first", dev: 1, ino: 2 }));
    const legacy = store.withTx(() => store.createProject("旧项目"));
    // Linux bind mount 别名：realpath 不同、dev+ino 相同——部分唯一索引拦不住，必须按目录身份拒绝
    assert.throws(
      () => store.attachProjectRoot(legacy.id, { cwd: "/bind-alias", cwdReal: "/bind-alias", dev: 1, ino: 2 }),
      (err: any) => err instanceof StoreConflictError && err.code === "duplicate",
      "同一目录身份已归属他项目，认领必须冲突",
    );
    assert.equal(store.getProject(legacy.id)!.rootDir, null, "冲突后旧项目不新增归属");
    assert.ok(
      !store.getEventsAfter(0).some((e) => e.body.type === "project.root_attached" && (e.body as any).projectId === legacy.id),
      "冲突后不产生认领事件",
    );
    // 同项目相同身份（含别名）幂等返回，不重复发事件
    const before = store.getEventsAfter(0).length;
    store.attachProjectRoot(ws.id, { cwd: "/first", cwdReal: "/first", dev: 1, ino: 2 });
    store.attachProjectRoot(ws.id, { cwd: "/alias-of-first", cwdReal: "/first", dev: 1, ino: 2 });
    assert.equal(store.getEventsAfter(0).length, before, "幂等认领不重复发事件");
    // 真正的别目录仍是合法认领
    store.attachProjectRoot(legacy.id, { cwd: "/other", cwdReal: "/other", dev: 3, ino: 4 });
    assert.equal(store.getProject(legacy.id)!.rootDir?.cwdReal, "/other");
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("open_workspace：认领已被占用的同 realpath 根目录返回 duplicate，不留会话与归属", async () => {
  const t = await startTestRuntime("ws74-clash", async () => ({ kind: "text", text: "x" }));
  try {
    // 工作区先行占用根目录 realpath
    await t.client.request("open_workspace", { cwd: t.work[0]!, request_id: "boot-own" });
    const legacy = (await t.client.request<any>("create_project", { name: "旧项目" })) as any;
    const err = await t.client
      .request("open_workspace", { cwd: t.work[0]!, project_id: legacy.id, request_id: "boot-clash" })
      .then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error, "必须拒绝认领");
    assert.equal((err as any).code, "duplicate", "SQLite 唯一索引冲突必须翻译为明确的归属冲突");
    assert.equal((err as any).outcome, "rejected", "明确拒绝：客户端不进入应答丢失处理");
    assert.equal(t.runtime.store.getProject(legacy.id)!.rootDir, null, "事务回滚：不留下根目录归属");
    assert.ok(!t.runtime.store.listSessions().some((s) => s.createRequestId === "boot-clash"), "事务回滚：不留下新会话");
  } finally {
    await t.shutdown();
  }
});

test("open_workspace：混合旧项目（dev 与群聊并存）不可认领，目录打开直接新建工作区", async () => {
  const t = await startTestRuntime("ws74-mixed", async () => ({ kind: "text", text: "x" }));
  try {
    // 混合旧项目：普通 dev 会话 + 群聊会话，目录相同
    const { projectId: mixedId, sessionId: devSessionId } = await createProjectSession(t.client, t.work[0]!, { projectName: "mixed" });
    const identity = dirIdentityOf(t.work[0]!);
    t.runtime.store.createSession({
      projectId: mixedId, kind: "qq_group", cwd: identity.cwd, cwdReal: identity.cwdReal,
      cwdDev: identity.dev, cwdIno: identity.ino, piSessionId: "pi-qq-mixed", confirmTools: [],
    });
    // 客户端候选筛选与后台防御一致：混合旧项目不作目录候选（否则路径入口自动发出必遭拒绝的认领请求）
    const hs = (await t.client.handshake()) as any;
    const candidates = findWorkspaceProjects(
      { projects: hs.snapshot.projects, sessions: hs.snapshot.sessions, roleSessionIds: hs.snapshot.roleSessionIds ?? [] },
      identity,
    ).map((p) => p.id);
    assert.ok(!candidates.includes(mixedId), "混合旧项目不作目录候选");
    // 目录打开走自动路径：新建工作区，混合旧项目关系保留
    const res = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-mixed" })) as any;
    assert.equal(res.createdProject, true, "唯一候选必遭拒绝的场景消失：目录打开正常建新工作区");
    assert.notEqual(res.session.projectId, mixedId, "不认领混合旧项目");
    assert.equal(t.runtime.store.getProject(mixedId)!.rootDir, null, "混合旧项目归属不变");
    assert.equal(t.runtime.store.getSession(devSessionId)!.projectId, mixedId, "普通会话保留在混合旧项目供查看与切换");
  } finally {
    await t.shutdown();
  }
});

test("open_workspace：角色与群聊项目不能作为工作区认领", async () => {
  const t = await startTestRuntime("ws74-internal", async () => ({ kind: "text", text: "x" }));
  try {
    const roleProject = t.runtime.store.listAgentRoles()[0]!.projectId;
    await assert.rejects(
      () => t.client.request("open_workspace", { cwd: t.work[0]!, project_id: roleProject, request_id: "boot-role" }),
      (err: any) => err.code === "invalid_params",
      "角色项目拒绝认领",
    );
    const qq = await t.client.request<any>("create_project", { name: "qq-x" });
    const identity = dirIdentityOf(t.work[0]!);
    t.runtime.store.createSession({
      projectId: qq.id, kind: "qq_group", cwd: identity.cwd, cwdReal: identity.cwdReal,
      cwdDev: identity.dev, cwdIno: identity.ino, piSessionId: "pi-qq2", confirmTools: [],
    });
    await assert.rejects(
      () => t.client.request("open_workspace", { cwd: t.work[0]!, project_id: qq.id, request_id: "boot-qq" }),
      (err: any) => err.code === "invalid_params",
      "群聊项目拒绝认领",
    );
    assert.equal(t.runtime.store.getProject(roleProject)!.rootDir, null, "角色项目归属未被改写");
  } finally {
    await t.shutdown();
  }
});

test("open_workspace：保护根与不存在目录明确拒绝，不留空项目", async () => {
  const t = await startTestRuntime("ws74-protected", async () => ({ kind: "text", text: "x" }));
  try {
    const projectCount = t.runtime.store.listProjects().length;
    await assert.rejects(
      () => t.client.request("open_workspace", { cwd: t.dirs.dataDir, request_id: "boot-p" }),
      (err: any) => err.code === "invalid_params",
    );
    await assert.rejects(
      () => t.client.request("open_workspace", { cwd: path.join(t.dirs.root, "nope"), request_id: "boot-n" }),
      (err: any) => err.code === "invalid_params",
    );
    assert.equal(t.runtime.store.listProjects().length, projectCount, "拒绝不留空项目");
    assert.ok(!t.runtime.store.listSessions().some((s) => s.createRequestId === "boot-p"));
  } finally {
    await t.shutdown();
  }
});

// ---------- 兼容：旧 op 与旧库 ----------

test("旧 op 不变：create_project/create_session 不写根目录归属，快照仍可读", async () => {
  const t = await startTestRuntime("ws74-legacy-ops", async () => ({ kind: "text", text: "x" }));
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

/** 迁移测试内直接经存储层建带归属的项目（runtime 路径在别处覆盖）。 */
function store2Workspace(store: Store, root: string): Project {
  return store.withTx(() => store.createProject("带归属", null, { cwd: root, cwdReal: root, dev: 1, ino: 1 }));
}

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

test("findWorkspaceProjects：已归属根目录的项目不再充当遗留候选", () => {
  const identity = { cwd: "/w", cwdReal: "/w", dev: 1, ino: 1 };
  const ws = fakeProject({ id: "p_ws", rootDir: identity });
  const legacy = fakeProject({ id: "p_leg" });
  const snapshot = {
    projects: [ws, legacy],
    sessions: [
      fakeSession({ id: "s1", projectId: "p_ws" }),
      fakeSession({ id: "s2", projectId: "p_leg" }),
    ],
    roleSessionIds: [],
  };
  assert.deepEqual(
    findWorkspaceProjects(snapshot, identity).map((p) => p.id),
    ["p_leg"],
    "只有未归属根目录的遗留项目是候选",
  );
});

test("findWorkspaceProjects：混合旧项目（dev 与角色/群聊并存）不充当目录候选", () => {
  const identity = { cwd: "/w", cwdReal: "/w", dev: 1, ino: 1 };
  const projects = [fakeProject({ id: "p_pure" }), fakeProject({ id: "p_mixed_qq" }), fakeProject({ id: "p_mixed_role" })];
  const sessions = [
    fakeSession({ id: "s_pure", projectId: "p_pure" }),
    fakeSession({ id: "s_mq_dev", projectId: "p_mixed_qq" }),
    fakeSession({ id: "s_mq_qq", projectId: "p_mixed_qq", kind: "qq_group" }),
    fakeSession({ id: "s_mr_dev", projectId: "p_mixed_role" }),
    fakeSession({ id: "s_mr_role", projectId: "p_mixed_role" }),
  ];
  const candidates = findWorkspaceProjects({ projects, sessions, roleSessionIds: ["s_mr_role"] }, identity).map((p) => p.id);
  assert.deepEqual(candidates, ["p_pure"], "会话不全是普通 dev 的项目后台不可认领，不作目录候选");
});

test("workspacePickerProjects：工作区与旧项目分列，角色与群聊会话不进入列表", () => {
  const identity = { cwd: "/w", cwdReal: "/w", dev: 1, ino: 1 };
  const projects = [
    fakeProject({ id: "p_ws", rootDir: identity }),
    fakeProject({ id: "p_leg" }),
    fakeProject({ id: "p_role" }),
    fakeProject({ id: "p_qq" }),
    fakeProject({ id: "p_mixed" }),
  ];
  const sessions = [
    fakeSession({ id: "s_ws", projectId: "p_ws" }),
    fakeSession({ id: "s_leg", projectId: "p_leg" }),
    fakeSession({ id: "s_role", projectId: "p_role" }),
    fakeSession({ id: "s_qq", projectId: "p_qq", kind: "qq_group" }),
    // 混合项目：含普通 dev 会话的旧项目保留在列表（群聊会话在会话层被过滤）
    fakeSession({ id: "s_mixed_dev", projectId: "p_mixed", cwdReal: "/m" }),
    fakeSession({ id: "s_mixed_qq", projectId: "p_mixed", kind: "qq_group", cwdReal: "/m" }),
  ];
  const { workspaces, legacy } = workspacePickerProjects({ projects, sessions, roleSessionIds: ["s_role"] });
  assert.deepEqual(workspaces.map((p) => p.id), ["p_ws"]);
  assert.deepEqual(legacy.map((p) => p.id), ["p_leg", "p_mixed"], "纯角色/群聊项目不进普通列表，含普通会话的旧项目保留；内部子任务不形成会话故无需排除");
});

// ---------- TUI 选择面板（产品区分） ----------

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
      socketPath: t.runtime.socketPath(),
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

/** 造一个含工作区、旧项目、角色项目（编排器引导）与 qq_group 项目的数据面。 */
async function seedPickerData(t: TestRuntime): Promise<void> {
  await t.client.request("open_workspace", { cwd: t.work[0]!, request_id: "boot-picker" });
  await createProjectSession(t.client, t.work[1]!, { projectName: "legacy-proj" });
  const qq = (await t.client.request<any>("create_project", { name: "qq-1-2" })) as any;
  const identity = dirIdentityOf(t.work[1]!);
  t.runtime.store.createSession({
    projectId: qq.id,
    kind: "qq_group",
    cwd: identity.cwd,
    cwdReal: identity.cwdReal,
    cwdDev: identity.dev,
    cwdIno: identity.ino,
    piSessionId: "pi-qq",
    confirmTools: [],
  });
}

test("ruukoto-code：选择面板列出工作区与旧项目，不出现角色与群聊项目", async () => {
  const t = await startTestRuntime("ws74-tui-dev", async () => ({ kind: "text", text: "x" }));
  process.env.RUUKOTO_PRODUCT = "ruukoto-code";
  try {
    await seedPickerData(t);
    const h = await startPickerApp(t);
    try {
      await waitFor("选择面板出现", () => h.terminal.output().includes("选择工作区"));
      await waitFor("条目渲染", () => h.terminal.output().includes("legacy-proj"));
      const out = h.terminal.output();
      const wsName = path.basename(fs.realpathSync(t.work[0]!));
      assert.ok(out.includes(wsName), "列出工作区");
      assert.ok(out.includes("legacy-proj"), "列出旧项目");
      assert.ok(!out.includes("agent-main"), "角色项目不进普通列表");
      assert.ok(!out.includes("qq-1-2"), "群聊项目不进普通列表");
      // 选中工作区 → 会话选择面板只含该工作区会话
      h.terminal.send("\r");
      await waitFor("会话选择面板", () => h.terminal.output().includes("选择会话"));
      assert.ok(!h.terminal.output().includes("agent-main"), "会话面板只列工作区会话");
      h.app.quit(0);
      await waitFor("退出", () => h.exitCode() === 0);
    } finally {
      h.app.quit(0);
    }
  } finally {
    delete process.env.RUUKOTO_PRODUCT;
    await t.shutdown();
  }
});

test("ruukoto：选择面板行为不变，角色项目仍列出", async () => {
  const t = await startTestRuntime("ws74-tui-ruukoto", async () => ({ kind: "text", text: "x" }));
  try {
    await createProjectSession(t.client, t.work[0]!, { projectName: "legacy-proj-b" });
    const h = await startPickerApp(t);
    try {
      await waitFor("选择面板出现", () => h.terminal.output().includes("选择项目"));
      await waitFor("条目渲染", () => h.terminal.output().includes("legacy-proj-b"));
      assert.ok(h.terminal.output().includes("agent-main"), "ruukoto 产品角色项目行为不变");
      h.app.quit(0);
      await waitFor("退出", () => h.exitCode() === 0);
    } finally {
      h.app.quit(0);
    }
  } finally {
    await t.shutdown();
  }
});

// ---------- 组织归属打通（agent-direction issue 07 步骤 4） ----------

test("ruukoto-code：已映射旧会话归入工作区计数与列表；恢复后选择状态与新建会话指向目标工作区", async () => {
  const t = await startTestRuntime("ws74-attribution", async () => ({ kind: "text", text: "x" }));
  process.env.RUUKOTO_PRODUCT = "ruukoto-code";
  try {
    const ws = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-attr" })) as any;
    const wsId = ws.session.projectId as string;
    const wsName = ws.projectName as string;
    const { projectId: legacyId, sessionId: mappedId } = await createProjectSession(t.client, t.work[1]!, { projectName: "legacy-src" });
    t.runtime.store.withTx(() => t.runtime.store.mapSessionToWorkspace(mappedId, wsId));
    const h = await startPickerApp(t);
    try {
      await waitFor("选择面板出现", () => h.terminal.output().includes("选择工作区"));
      await waitFor("计数按组织归属", () => h.terminal.output().includes(`工作区 · ${wsName} · 2 个会话`));
      assert.ok(h.terminal.output().includes("旧项目 · legacy-src · 0 个会话"), "已映射会话不计入来源项目");
      // 打开工作区会话列表：已映射旧会话在目标工作区名下（经 workspace_id 归属查询）
      h.terminal.send("\r");
      // 面板标题与会话行可能分帧到达：以已映射会话行本身为准（不误判标题先行帧）
      await waitFor("会话选择面板含已映射旧会话", () => h.terminal.output().includes(mappedId.slice(0, 14)));
      assert.ok(h.terminal.output().includes("选择会话 · "), "面板在工作区名下打开");
      // 切换走与面板选中相同的 switchSession 路径（伪终端 ENTER 在全量并行负载下
      // 有输入批处理抖动，不作本用例判定依据）；面板读侧断言在上两行
      (h.app as any).switchSession(mappedId);
      // 标题归属与工作区/配置来源标注：与渲染共用同一纯函数结论（标题渲染经既有
      // chrome 路径覆盖，不在本用例以伪终端时机判定）
      assert.deepEqual(
        sessionTitleAttribution(h.state.sessions.find((s) => s.id === mappedId)!, h.state.projects, true),
        { workspace: true, projectId: wsId, sourceProjectId: legacyId },
        "标题显示工作区与配置与资料来源",
      );
      // 选择状态继续指向目标工作区，不被 view.projectId 改回源项目
      assert.equal((h.app as any).selectedProjectId, wsId);
      // /new：从已映射旧会话创建新会话 → 使用目标工作区 Project ID 与当前目录（命令处理器与按键入口同一实现）
      await (h.app as any).cmdNew();
      await waitFor("新会话已创建", () =>
        t.runtime.store.listSessions().some((s) => s.projectId === wsId && s.id !== ws.session.id && s.id !== mappedId),
      );
      const created = t.runtime.store.listSessions().find((s) => s.projectId === wsId && s.id !== ws.session.id && s.id !== mappedId)!;
      assert.equal(created.cwdReal, fs.realpathSync(t.work[1]!), "新会话沿用当前目录，身份是目标工作区");
      await waitFor("切换到新会话", () => h.state.currentSessionId === created.id);
      h.app.quit(0);
      await waitFor("退出", () => h.exitCode() === 0);
    } finally {
      h.app.quit(0);
    }
  } finally {
    delete process.env.RUUKOTO_PRODUCT;
    await t.shutdown();
  }
});

test("ruukoto-code：无映射旧会话选择状态不变；旧项目不再新建会话（/new 只提示工作区入口，issue 23）", async () => {
  const t = await startTestRuntime("ws74-unmapped", async () => ({ kind: "text", text: "x" }));
  process.env.RUUKOTO_PRODUCT = "ruukoto-code";
  try {
    const { projectId: legacyId, sessionId: legacySession } = await createProjectSession(t.client, t.work[0]!, { projectName: "unmapped-legacy" });
    const h = await startPickerApp(t);
    try {
      await waitFor("选择面板出现", () => h.terminal.output().includes("选择工作区"));
      await waitFor("旧项目条目", () => h.terminal.output().includes("旧项目 · unmapped-legacy"));
      // 切换与新建走与按键/面板相同的 switchSession、cmdNew 处理器（理由同上）
      (h.app as any).switchSession(legacySession);
      assert.equal(h.state.currentSessionId, legacySession);
      assert.equal((h.app as any).selectedProjectId, legacyId, "无映射旧会话选择状态不变");
      assert.ok(!h.terminal.output().includes("配置与资料来源"), "无映射不显示配置来源标注");
      const notes: string[] = [];
      const notify = (h.app as any).notify.bind(h.app);
      (h.app as any).notify = (text: string) => { notes.push(text); notify(text); };
      await (h.app as any).cmdNew();
      assert.deepEqual(notes, [LEGACY_PROJECT_WRITE_HINT], "只提示工作区入口");
      assert.equal(t.runtime.store.listSessions().filter((s) => s.projectId === legacyId).length, 1, "旧项目不新建会话");
      h.app.quit(0);
      await waitFor("退出", () => h.exitCode() === 0);
    } finally {
      h.app.quit(0);
    }
  } finally {
    delete process.env.RUUKOTO_PRODUCT;
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
