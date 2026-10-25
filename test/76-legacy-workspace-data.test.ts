/**
 * 把旧开发会话和资料映射到工作区（agent-direction issue 07）。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 *
 * 测试接缝（步骤 1：增加会话组织归属，保留所有来源标识）：
 * 1. schema v20 → v21 纯加列迁移：旧库升级只补 sessions.workspace_project_id，
 *    旧会话组织归属默认 NULL；project_id、会话 ID、pi 会话 ID、历史文件路径
 *    原样可读，不扫描目录、不迁移业务记录；重复打开不再迁移；
 * 2. 新会话组织归属默认 NULL；open_workspace 结果与重连快照携带
 *    workspaceProjectId（快照携带组织归属）；
 * 3. Store.mapSessionToWorkspace：目标必须带根目录归属；同值幂等不产生事件；
 *    null 恢复未映射；session.workspace_mapped 事件携带组织归属与来源项目；
 * 4. control/workspace.ts 的 sessionDisplayAttribution：显式映射优先、来源项目
 *    是工作区时用来源项目、其余仍列在旧项目下（仅展示规则）;
 * 5. 任务 TUI ViewState 投影 session.workspace_mapped：更新组织归属，来源标识不变。
 *
 * 测试接缝（步骤 2/3：只读预览与事务化应用）：
 * 6. preview_workspace_migration：多目录分组与建议、同目录其他旧项目、失效/被
 *    替换目录、历史缺失/未落盘/损坏、混合项目与角色/群聊排除、已认领根外会话、
 *    嵌套根、worktree、截断如实报告；预览零写入；
 * 7. 安全认领全条件（无根/纯 dev 非空/单目录有效/目标即目录/无占用/无已映射），
 *    部分/祖先/混合认领拒绝；apply claim 幂等与同键异参冲突；
 * 8. 修订：无关任务输出不过期；来源新增会话/设置版本变化/选择被编辑/组织映射
 *    变化即过期；
 * 9. 回执先行：同键重放返回原成果，同键异参 request_conflict；相同映射的新请求
 *    复用已有归属不重复创建；事务中途故障（部分 SQL 已执行）整体回滚；
 * 10. revert：只恢复显式组织映射并校验当前值；claim 不可回退；已新建工作区保留；
 * 11. 目录入口收紧：open_workspace 与 findWorkspaceProjects 不认领多目录旧项目。
 *
 * 测试接缝（验证与验收场景补齐）：
 * 12. 接入边界：两旧项目归入同一工作区后原授权方向/项目内访问保留、跨来源仍拒；
 *    新会话不因映射获得源资料；显式授权→撤销最后一条→拒绝；
 * 13. 配置来源：映射旧会话后续任务用原指令；实例 MCP 服务 ID/版本、凭据
 *    绑定、记忆版本不被动；新会话用目标配置；认领后新会话延续原 ID 配置；
 * 14. 标识与字节核对：pi ID/历史路径/JSONL 与产物字节/任务/选择记录迁移前后不变；
 * 15. 回退只恢复显式组织字段，新任务/配置修改/授权撤销保留；目标根被替换拒绝且
 *    零副作用；回执跨进程重启核实（meta 持久 + 同键重放）。
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "@ruukoto/core/db.ts";
import { Store, StoreConflictError } from "@ruukoto/core/store.ts";
import { findWorkspaceProjects, sessionDisplayAttribution } from "@ruukoto/control/workspace.ts";
import type { DirIdentity } from "@ruukoto/core/dir-identity.ts";
import type { MigrationPreview } from "@ruukoto/runtime/workspace-migration.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import type { PersistentEvent, Project, Session } from "@ruukoto/core/types.ts";
import { startTestRuntime, createProjectSession, waitFor, lastUserText, type TestRuntime } from "./helpers/testkit.ts";
import { seedCodingRole } from "./helpers/legacy-coding.ts";
import { previewWorkspaceMigration, applyWorkspaceMigration } from "@ruukoto/runtime/workspace-migration.ts";

// ---------- 新会话默认 NULL；快照携带组织归属 ----------

test("新会话组织归属默认 NULL；open_workspace 结果与重连快照携带 workspaceProjectId", async () => {
  const t = await startTestRuntime("ws76-null", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId, sessionId } = await createProjectSession(t.client, t.work[0]!, { projectName: "旧项目" });
    assert.equal(t.runtime.store.getSession(sessionId)!.workspaceProjectId, null);
    // 旧 API 未带组织参数，保持旧语义：不认领、不映射
    assert.equal(t.runtime.store.getProject(projectId)!.rootDir, null);
    const opened = (await t.client.request<any>("open_workspace", { cwd: t.work[1]!, request_id: "boot-1" })) as any;
    assert.equal(opened.session.workspaceProjectId, null, "op 结果的会话载荷携带组织归属");
    const before = await t.client.handshake();
    assert.ok(before.snapshot.sessions.every((s) => s.workspaceProjectId === null), "未映射会话在快照中为 NULL");

    // 组织映射后重连快照携带归属；来源标识保持
    t.runtime.store.withTx(() => t.runtime.store.mapSessionToWorkspace(sessionId, opened.session.projectId));
    const after = await t.client.handshake();
    const mapped = after.snapshot.sessions.find((s) => s.id === sessionId)!;
    assert.equal(mapped.workspaceProjectId, opened.session.projectId, "快照携带组织归属");
    assert.equal(mapped.projectId, projectId, "来源项目标识不受映射影响");
  } finally {
    await t.shutdown();
  }
});

// ---------- Store.mapSessionToWorkspace ----------

test("mapSessionToWorkspace：校验、幂等、事件载荷与恢复未映射", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ws76-map-"));
  const db = new Db(dataDir);
  try {
    const store = new Store(db);
    const legacy = store.withTx(() => store.createProject("旧项目"));
    const plain = store.withTx(() => store.createProject("无根目录项目"));
    const ws = store.withTx(() => store.createProject("工作区", null, { cwd: "/w", cwdReal: "/w", dev: 1, ino: 2 }));
    const session = store.withTx(() =>
      store.createSession({ projectId: legacy.id, cwd: "/l", cwdReal: "/l", cwdDev: 3, cwdIno: 4, piSessionId: "pi-l", confirmTools: [] }),
    );
    const mappedEvents = () => store.getEventsAfter(0).filter((e) => e.body.type === "session.workspace_mapped");

    // 目标必须是带根目录归属的工作区项目
    assert.throws(
      () => store.mapSessionToWorkspace(session.id, plain.id),
      (err: any) => err instanceof StoreConflictError && err.code === "invalid_params",
      "无根目录归属的项目不能成为组织归属目标",
    );
    assert.throws(
      () => store.mapSessionToWorkspace(session.id, "proj_nope"),
      (err: any) => err instanceof StoreConflictError && err.code === "invalid_params",
    );
    assert.throws(
      () => store.mapSessionToWorkspace("sess_nope", ws.id),
      (err: any) => err instanceof StoreConflictError && err.code === "not_found",
    );
    assert.equal(mappedEvents().length, 0, "拒绝不产生事件");

    store.withTx(() => store.mapSessionToWorkspace(session.id, ws.id));
    assert.equal(store.getSession(session.id)!.workspaceProjectId, ws.id);
    assert.equal(store.getSession(session.id)!.projectId, legacy.id, "来源项目标识保留");
    assert.equal(mappedEvents().length, 1, "映射产生持久事件");
    const body = mappedEvents()[0]!.body as Extract<PersistentEvent["body"], { type: "session.workspace_mapped" }>;
    assert.equal(body.sessionId, session.id);
    assert.equal(body.projectId, legacy.id, "事件带来源项目标识");
    assert.equal(body.workspaceProjectId, ws.id, "事件携带组织归属");

    // 同值幂等：不重复产生事件
    store.withTx(() => store.mapSessionToWorkspace(session.id, ws.id));
    assert.equal(mappedEvents().length, 1);

    // null 恢复未映射（事件留痕）
    store.withTx(() => store.mapSessionToWorkspace(session.id, null));
    assert.equal(store.getSession(session.id)!.workspaceProjectId, null);
    assert.equal(mappedEvents().length, 2);
    assert.equal((mappedEvents()[1]!.body as typeof body).workspaceProjectId, null);
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- 展示归属规则（仅展示） ----------

test("sessionDisplayAttribution：显式映射优先，工作区来源次之，其余仍列在旧项目下", () => {
  const projects = [
    { id: "p_ws", rootDir: { cwd: "/w", cwdReal: "/w", dev: 1, ino: 2 } },
    { id: "p_ws2", rootDir: { cwd: "/v", cwdReal: "/v", dev: 3, ino: 4 } },
    { id: "p_leg", rootDir: null },
  ];
  assert.deepEqual(
    sessionDisplayAttribution({ projectId: "p_leg", workspaceProjectId: "p_ws" }, projects),
    { projectId: "p_ws", kind: "mapped" },
    "显式工作区映射优先",
  );
  assert.deepEqual(
    sessionDisplayAttribution({ projectId: "p_ws2", workspaceProjectId: null }, projects),
    { projectId: "p_ws2", kind: "workspace" },
    "无映射且来源项目已有根目录时使用来源项目",
  );
  assert.deepEqual(
    sessionDisplayAttribution({ projectId: "p_leg", workspaceProjectId: null }, projects),
    { projectId: "p_leg", kind: "legacy" },
    "其余仍列在旧项目下",
  );
});

// ---------- TUI 事件投影 ----------

function fakeSession(over: Partial<Session> & { id: string; projectId: string }): Session {
  return {
    kind: "dev",
    cwd: "/w",
    cwdReal: "/w",
    cwdDev: 1,
    cwdIno: 1,
    piSessionId: "pi",
    sessionFile: null,
    confirmTools: [],
    createRequestId: null,
    workspaceProjectId: null,
    name: null,
    branchSource: null,
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

test("ViewState 投影 session.workspace_mapped：更新组织归属，来源标识不变", () => {
  const state = new ViewState();
  state.applySnapshot(
    {
      seq: 1,
      replay: [],
      snapshot: {
        product: "ruukoto-code", mainSessionId: null,
        projects: [
          { id: "p_leg", name: "旧项目", createRequestId: null, rootDir: null, instructionFiles: [], settingsVersion: 1, createdAt: "2026-01-01T00:00:00Z" },
          { id: "p_ws", name: "工作区", createRequestId: null, rootDir: { cwd: "/w", cwdReal: "/w", dev: 1, ino: 2 }, instructionFiles: [], settingsVersion: 1, createdAt: "2026-01-01T00:00:00Z" },
        ],
        sessions: [fakeSession({ id: "sess_1", projectId: "p_leg" })],
        tasks: [],
        confirmations: [],
        artifacts: [],
        previews: {},
        instanceId: "inst-1",
        execution: { backend: "local", note: "" },
        defaultModel: { provider: "mock", id: "mock-model", name: "Mock", thinkingLevel: "off" },
      },
    },
    false,
  );
  const event: PersistentEvent = {
    seq: 2,
    taskId: null,
    sessionId: "sess_1",
    body: { type: "session.workspace_mapped", sessionId: "sess_1", projectId: "p_leg", workspaceProjectId: "p_ws" },
    createdAt: "2026-01-01T00:00:01Z",
  };
  state.applyEvent(event, "live");
  const session = state.sessions.find((s) => s.id === "sess_1")!;
  assert.equal(session.workspaceProjectId, "p_ws", "组织归属随事件更新");
  assert.equal(session.projectId, "p_leg", "来源项目标识不受映射影响");
});

// ==================== 步骤 2/3：预览与应用 ====================

function dirIdentityOf(dir: string): DirIdentity {
  const real = fs.realpathSync(dir);
  const stat = fs.statSync(real);
  return { cwd: path.resolve(dir), cwdReal: real, dev: stat.dev, ino: stat.ino };
}

async function preview(t: TestRuntime, projectId: string, extra: Record<string, unknown> = {}): Promise<MigrationPreview> {
  return t.client.request<MigrationPreview>("preview_workspace_migration", { project_id: projectId, ...extra });
}

async function applyPlan(t: TestRuntime, instanceId: string, projectId: string, requestId: string, plan: MigrationPreview["plan"], revision: string | null) {
  return t.client.request<any>("apply_workspace_migration", {
    project_id: projectId,
    instance_id: instanceId,
    request_id: requestId,
    plan,
    expected_revision: revision ?? undefined,
  });
}

/** 含 s1@repo-a、s2@repo-b、s3@dirX 的多目录旧项目（repo-a/repo-b 同父目录 multi）。 */
async function seedMultiDirLegacy(t: TestRuntime) {
  const multi = path.join(t.dirs.root, "multi");
  const repoA = path.join(multi, "repo-a");
  const repoB = path.join(multi, "repo-b");
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  const dirX = t.work[0]!;
  const { projectId, sessionId: s1 } = await createProjectSession(t.client, repoA, { projectName: "多目录旧项目" });
  const s2res = (await t.client.request<any>("create_session", { project_id: projectId, cwd: repoB })) as any;
  const s3res = (await t.client.request<any>("create_session", { project_id: projectId, cwd: dirX })) as any;
  return { projectId, multi, repoA, repoB, dirX, s1: s1 as string, s2: s2res.id as string, s3: s3res.id as string };
}

test("preview：多目录分组、已有工作区复用建议、同目录其他旧项目与指令基准；预览零写入", async () => {
  const t = await startTestRuntime("ws76-preview", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId, repoA, repoB, dirX, s1, s2, s3 } = await seedMultiDirLegacy(t);
    // dirX 上已有工作区；repo-a 下另有第二个旧项目的会话
    const ws = (await t.client.request<any>("open_workspace", { cwd: dirX, request_id: "boot-prev" })) as any;
    const { sessionId: otherSession } = await createProjectSession(t.client, repoA, { projectName: "同目录另一旧项目" });
    void otherSession;
    const seqBefore = t.runtime.store.getMaxSeq();
    const projectCountBefore = t.runtime.store.listProjects().length;

    const p = await preview(t, projectId);
    assert.equal(p.instance_id, t.runtime.snapshot().instanceId);
    assert.equal(p.source.project_id, projectId);
    assert.equal(p.source.config_source_project_id, projectId, "实际配置来源恒为源项目");
    assert.equal(p.truncated, false);
    assert.equal(p.total_sessions, 3);

    // 目录按真实身份分组；dirX 组复用已有工作区 ID（不按显示名称）
    const realOf = (dir: string) => fs.realpathSync(dir);
    const groupReals = p.dir_groups.map((g) => g.identity.cwdReal).sort();
    assert.deepEqual(groupReals, [realOf(dirX), realOf(repoA), realOf(repoB)].sort());
    assert.ok(p.dir_groups.every((g) => g.status === "valid"), "全部目录有效");
    const groupX = p.dir_groups.find((g) => g.identity.cwdReal === realOf(dirX))!;
    assert.equal(groupX.existing_workspace_id, ws.session.projectId, "同一真实目录已有工作区时复用其 ID");
    assert.deepEqual(groupX.session_ids, [s3]);

    // findings：多目录、同目录其他旧项目（保持独立资料身份，不合并）
    const kinds = p.findings.map((f) => f.kind);
    assert.ok(kinds.includes("multi_dir_project"), "一个项目多个目录如实列出");
    const shared = p.findings.find((f) => f.kind === "same_dir_multiple_projects")!;
    assert.ok(shared.message.includes("同目录另一旧项目") || (shared.project_ids ?? []).length === 1, "同目录多个旧项目分别列出");

    // 建议：dirX 组映射到已有工作区，repo 组各自新工作区；已映射会话不重复建议
    assert.equal(p.suggested?.action, "map_sessions");
    assert.deepEqual(p.suggested?.assignments?.[s1], { kind: "new_workspace", root: realOf(repoA) });
    assert.deepEqual(p.suggested?.assignments?.[s3], { kind: "existing_workspace", project_id: ws.session.projectId });
    assert.equal(p.safe_claim.eligible, false, "多目录不可安全认领");

    // 旧项目无根目录：指令基准目录按会话目录解释（issue 06 规则）
    const sv = p.sessions.find((s) => s.session_id === s1)!;
    assert.equal(sv.instruction_base_dir, realOf(repoA));
    assert.equal(sv.excluded, null);
    assert.equal(sv.history, "not_flushed", "未落盘历史如实报告，不显示为没有历史");

    // 预览零写入：无新事件、无新项目、无回执
    assert.equal(t.runtime.store.getMaxSeq(), seqBefore, "预览不产生事件");
    assert.equal(t.runtime.store.listProjects().length, projectCountBefore, "预览不创建项目");
    assert.equal(t.runtime.store.getMetaValue("migration_receipt:probe"), null);
    assert.equal(p.sessions.length, 3);
    void s2;
  } finally {
    await t.shutdown();
  }
});

test("preview：失效/被替换目录、历史状态、混合与角色排除、根外会话、嵌套根、worktree 与截断", async () => {
  const t = await startTestRuntime("ws76-anomaly", async () => ({ kind: "text", text: "x" }));
  try {
    // 失效目录
    const gone = path.join(t.dirs.root, "gone");
    fs.mkdirSync(gone);
    // 被替换目录
    const replaced = path.join(t.dirs.root, "replaced");
    fs.mkdirSync(replaced);
    // 嵌套 + worktree 目录
    const parent = path.join(t.dirs.root, "nest");
    const worktreeDir = path.join(parent, "wt");
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");

    const { projectId } = await createProjectSession(t.client, gone, { projectName: "异常项目" });
    const sGone = (await t.client.handshake()).snapshot.sessions.at(-1)!.id;
    const sReplaced = (await t.client.request<any>("create_session", { project_id: projectId, cwd: replaced })) as any;
    const sNest = (await t.client.request<any>("create_session", { project_id: projectId, cwd: parent })) as any;
    const sWt = (await t.client.request<any>("create_session", { project_id: projectId, cwd: worktreeDir })) as any;
    // 群聊会话 → 混合项目、明确排除
    t.runtime.store.createSession({
      projectId, kind: "qq_group", cwd: parent, cwdReal: fs.realpathSync(parent),
      cwdDev: fs.statSync(parent).dev, cwdIno: fs.statSync(parent).ino, piSessionId: "pi-qq-76", confirmTools: [],
    });
    // 历史三态：缺失 / 损坏 / 未落盘（sWt 保持未落盘）
    const missingFile = path.join(t.dirs.dataDir, "sessions", "ghost.jsonl");
    t.runtime.store.setSessionFile(sGone, missingFile);
    const corruptFile = path.join(t.dirs.dataDir, "sessions", "corrupt.jsonl");
    fs.writeFileSync(corruptFile, "not-json-line\n");
    t.runtime.store.setSessionFile(sReplaced.id, corruptFile);

    fs.rmSync(gone, { recursive: true, force: true }); // 失效
    fs.rmSync(replaced, { recursive: true, force: true }); // 被替换：同路径新目录（新 ino）
    fs.mkdirSync(replaced);

    const p = await preview(t, projectId);
    // 失效与被替换分别列出，不把当前同路径新目录当作旧目录
    const gGone = p.dir_groups.find((g) => g.identity.cwd.endsWith("gone"))!;
    assert.equal(gGone.status, "missing");
    const gReplaced = p.dir_groups.find((g) => g.reason?.includes("目录身份已变化"))!;
    assert.equal(gReplaced.status, "replaced");
    assert.ok(p.findings.some((f) => f.kind === "dir_invalid" && f.message.includes("已失效")));
    assert.ok(p.findings.some((f) => f.kind === "dir_invalid" && f.message.includes("已被替换")));
    // 嵌套根与 worktree 分别列出
    assert.ok(p.findings.some((f) => f.kind === "nested_roots"), "嵌套目录对应多个根");
    assert.ok(p.findings.some((f) => f.kind === "known_worktree"), "已知 worktree 列出");
    // 混合项目：群聊会话明确排除，普通会话仍可映射，整个项目不可认领
    assert.ok(p.findings.some((f) => f.kind === "mixed_project"));
    assert.ok(p.sessions.some((s) => s.kind === "qq_group" && s.excluded === "group_chat"));
    assert.equal(p.safe_claim.eligible, false);
    // 历史状态：缺失与损坏单独报告
    assert.equal(p.sessions.find((s) => s.session_id === sGone)!.history, "missing");
    assert.equal(p.sessions.find((s) => s.session_id === sReplaced.id)!.history, "unreadable");
    assert.equal(p.sessions.find((s) => s.session_id === sWt.id)!.history, "not_flushed");
    assert.ok(p.sessions.some((s) => s.session_id === sNest.id && s.history === "not_flushed"));

    // 角色项目：会话明确按角色排除
    const roleProjectId = t.runtime.store.listAgentRoles()[0]!.projectId;
    const rolePreview = await preview(t, roleProjectId);
    assert.ok(rolePreview.sessions.every((s) => s.excluded === "role"), "角色绑定会话明确排除");
    assert.equal(rolePreview.safe_claim.eligible, false);

    // 已认领项目：根外会话只列异常，指令实际使用认领的根目录
    const claimed = path.join(t.dirs.root, "claimed");
    const outside = path.join(t.dirs.root, "outside");
    fs.mkdirSync(claimed);
    fs.mkdirSync(outside);
    const wsRoot = (await t.client.request<any>("open_workspace", { cwd: claimed, request_id: "boot-claimed" })) as any;
    const wsProjectId = wsRoot.session.projectId as string;
    const identity = dirIdentityOf(outside);
    const rootOutside = t.runtime.store.createSession({
      projectId: wsProjectId, cwd: identity.cwd, cwdReal: identity.cwdReal,
      cwdDev: identity.dev, cwdIno: identity.ino, piSessionId: "pi-outside-76", confirmTools: [],
    });
    const claimedPreview = await preview(t, wsProjectId);
    const outsideFinding = claimedPreview.findings.find((f) => f.kind === "claimed_outside_root")!;
    assert.ok(outsideFinding.session_ids?.includes(rootOutside.id), "根外会话列异常");
    const outsideSessionRow = claimedPreview.sessions.find((s) => s.session_id === rootOutside.id)!;
    assert.equal(outsideSessionRow.instruction_base_dir, fs.realpathSync(claimed), "报告显示指令实际使用的根目录");
    assert.equal(claimedPreview.sessions.find((s) => s.session_id === wsRoot.session.id)!.excluded, null);

    // 截断：如实报告不完整，不可生成修订
    const two = path.join(t.dirs.root, "two");
    fs.mkdirSync(two);
    const many = (await createProjectSession(t.client, two, { projectName: "截断项目" })).projectId;
    fs.mkdirSync(path.join(two, "a"));
    fs.mkdirSync(path.join(two, "b"));
    await t.client.request("create_session", { project_id: many, cwd: path.join(two, "a") });
    await t.client.request("create_session", { project_id: many, cwd: path.join(two, "b") });
    const sliced = await preview(t, many, { limit: 2 });
    assert.equal(sliced.truncated, true);
    assert.equal(sliced.scanned_sessions, 2);
    assert.equal(sliced.total_sessions, 3);
    assert.equal(sliced.safe_claim.eligible, false, "截断结果不得用于认领");
    const withPlan = await preview(t, many, { limit: 2, plan: { action: "map_sessions", assignments: {} } });
    assert.equal(withPlan.revision, null, "截断不能生成修订");
    assert.ok(withPlan.plan_errors.some((m) => m.includes("截断")) || withPlan.plan_errors.length > 0);
  } finally {
    await t.shutdown();
  }
});

// ---------- 安全认领与 apply claim_source ----------

test("安全认领：全条件成立才可走快捷路径；apply claim 幂等回执与同键异参", async () => {
  const t = await startTestRuntime("ws76-claim", async () => ({ kind: "text", text: "ok-claim" }));
  try {
    const dir = t.work[0]!;
    const { projectId, sessionId } = await createProjectSession(t.client, dir, { projectName: "单目录旧项目" });
    // 既有历史与配置：认领后原样保留
    await t.client.request("set_project_instructions", { project_id: projectId, files: ["LEGACY.md"] });
    await t.client.request("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId, request_id: "claim-hist-1", input: "认领前的历史输入",
    });
    await waitFor("历史落盘", async () =>
      JSON.stringify(await t.client.request("read_history", { session_id: sessionId })).includes("认领前的历史输入"),
    );

    const p = await preview(t, projectId);
    assert.equal(p.safe_claim.eligible, true, `应可安全认领：${p.safe_claim.reasons.join(";")}`);
    assert.equal(p.safe_claim.root?.cwdReal, fs.realpathSync(dir));
    assert.deepEqual(p.suggested, { action: "claim_source", root: fs.realpathSync(dir) });

    // 目标必须是目录本身：父目录不可认领
    const parentPlan = await preview(t, projectId, { plan: { action: "claim_source", root: t.dirs.root } });
    assert.equal(parentPlan.revision, null);
    assert.ok(parentPlan.plan_errors.some((m) => m.includes("目录本身")), "共同祖先/父目录拒绝认领");

    const plan: MigrationPreview["plan"] = { action: "claim_source", root: fs.realpathSync(dir) };
    const planned = await preview(t, projectId, { plan });
    assert.ok(planned.revision, "绑定最终选择的修订");
    const seqBefore = t.runtime.store.getMaxSeq();
    const applied = await applyPlan(t, p.instance_id, projectId, "req-claim-1", plan, planned.revision);
    assert.equal(applied.ok, true);
    assert.equal(applied.action, "claim_source");
    assert.equal(applied.claimed_root.cwdReal, fs.realpathSync(dir));
    assert.equal(t.runtime.store.getProject(projectId)!.rootDir?.cwdReal, fs.realpathSync(dir), "原 ID 认领根目录");
    const events = t.runtime.store.getEventsAfter(seqBefore);
    assert.equal(events.filter((e) => e.body.type === "project.root_attached").length, 1, "认领事件留痕一次");
    assert.equal(t.runtime.store.getProject(projectId)!.settingsVersion, 2, "原配置版本保留（不复制不重置）");
    assert.equal(t.runtime.store.getSession(sessionId)!.projectId, projectId, "会话实际身份不变");
    // 历史仍可读
    const history = (await t.client.request<any>("read_history", { session_id: sessionId })) as any;
    assert.ok(JSON.stringify(history).includes("认领前的历史输入"), "认领不改写历史");
    // 回执
    const receipt = t.runtime.store.getMetaValue("migration_receipt:req-claim-1");
    assert.ok(receipt && JSON.parse(receipt).action === "claim_source", "成功回执落盘且区分认领");

    // 同键同参重放：返回原成果，不产生新事件
    const replayed = await applyPlan(t, p.instance_id, projectId, "req-claim-1", plan, planned.revision);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(
      t.runtime.store.getEventsAfter(seqBefore).filter((e) => e.body.type === "project.root_attached").length,
      1,
      "重放不重复认领",
    );
    // 同键异参：request_conflict
    await assert.rejects(
      () => applyPlan(t, p.instance_id, projectId, "req-claim-1", { action: "claim_source", root: dirIdentityOf(dir).cwdReal + "/." }, planned.revision),
      (err: any) => err.code === "request_conflict",
      "同键异参拒绝",
    );
    // 实例标识不符：拒绝
    await assert.rejects(
      () => applyPlan(t, "inst_bogus", projectId, "req-claim-x", plan, planned.revision),
      (err: any) => err.code === "invalid_params",
    );

    // 已认领项目再次预览：不可再走认领路径
    const after = await preview(t, projectId);
    assert.equal(after.safe_claim.eligible, false, "已有根目录归属的项目不可再认领");

    // 同目录第二个旧项目：目录已被占用，不可认领，只能组织映射到该工作区
    const { projectId: secondId } = await createProjectSession(t.client, dir, { projectName: "同目录第二旧项目" });
    const second = await preview(t, secondId);
    assert.equal(second.safe_claim.eligible, false);
    assert.ok(second.safe_claim.reasons.some((m) => m.includes("已被其他工作区占用")));
    assert.equal(second.dir_groups[0]!.existing_workspace_id, projectId, "复用占用该目录的工作区 ID");

    // 混合项目（dev + 群聊）：不可认领
    const { projectId: mixedId } = await createProjectSession(t.client, t.work[1]!, { projectName: "混合认领" });
    const id2 = dirIdentityOf(t.work[1]!);
    t.runtime.store.createSession({
      projectId: mixedId, kind: "qq_group", cwd: id2.cwd, cwdReal: id2.cwdReal, cwdDev: id2.dev, cwdIno: id2.ino,
      piSessionId: "pi-qq-claim", confirmTools: [],
    });
    assert.equal((await preview(t, mixedId)).safe_claim.eligible, false, "混合项目不可认领");

    // 已映射会话：不可认领
    fs.mkdirSync(path.join(t.dirs.root, "mapped-dir"));
    const { projectId: mappedId, sessionId: mappedSession } = await createProjectSession(t.client, path.join(t.dirs.root, "mapped-dir"), { projectName: "已映射认领" });
    t.runtime.store.withTx(() => t.runtime.store.mapSessionToWorkspace(mappedSession, projectId));
    const mappedPreview = await preview(t, mappedId);
    assert.equal(mappedPreview.safe_claim.eligible, false, "存在已映射会话的项目不可认领");
  } finally {
    await t.shutdown();
  }
});

// ---------- map_sessions 应用、修订与回执 ----------

test("map_sessions：两个目录映射到两个工作区 + 父目录多仓库 + 修订稳定与过期", async () => {
  const t = await startTestRuntime("ws76-map", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId, multi, repoA, repoB, s1, s2 } = await seedMultiDirLegacy(t);
    // 修订对无关输出稳定：先在无关项目制造任务输出
    const { sessionId: unrelated } = await createProjectSession(t.client, t.work[1]!, { projectName: "无关项目" });
    const plan1: MigrationPreview["plan"] = {
      action: "map_sessions",
      assignments: {
        [s1]: { kind: "new_workspace", root: repoA },
        [s2]: { kind: "new_workspace", root: repoB },
      },
    };
    const planned1 = await preview(t, projectId, { plan: plan1 });
    assert.ok(planned1.revision);
    await t.client.request("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: unrelated, request_id: "noise-1", input: "无关任务输出",
    });
    const again1 = await preview(t, projectId, { plan: plan1 });
    assert.equal(again1.revision, planned1.revision, "无关任务输出不使预览过期");

    // 应用：一个旧项目两个目录 → 两个工作区
    const seqBefore = t.runtime.store.getMaxSeq();
    const projectsBefore = t.runtime.store.listProjects().length;
    const applied = await applyPlan(t, planned1.instance_id, projectId, "req-map-1", plan1, planned1.revision);
    assert.equal(applied.ok, true);
    assert.equal(applied.action, "map_sessions");
    assert.equal(applied.created_workspaces.length, 2, "两个目录各成一个工作区");
    assert.deepEqual(
      applied.created_workspaces.map((w: any) => w.name).sort(),
      ["repo-a", "repo-b"],
      "新工作区命名取根目录名",
    );
    const [wsA, wsB] = applied.created_workspaces;
    assert.equal(t.runtime.store.getSession(s1)!.workspaceProjectId, wsA.project_id);
    assert.equal(t.runtime.store.getSession(s2)!.workspaceProjectId, wsB.project_id);
    assert.equal(t.runtime.store.getSession(s1)!.projectId, projectId, "来源标识不变");
    const delta = t.runtime.store.getEventsAfter(seqBefore);
    assert.equal(delta.filter((e) => e.body.type === "project.created").length, 2);
    assert.equal(
      delta.filter((e) => e.body.type === "session.workspace_mapped").length,
      2,
      "每个映射一条持久事件",
    );
    assert.equal(t.runtime.store.listProjects().length, projectsBefore + 2);
    // 来源配置未复制未合并
    assert.equal(t.runtime.store.getProject(wsA.project_id)!.settingsVersion, 1, "新工作区使用既有创建默认值");
    assert.ok(t.runtime.store.getMetaValue("migration_receipt:req-map-1") !== null, "成功回执落盘");

    // 相同映射的新请求：复用已有归属，不重复创建项目，不重复产生事件
    const replayPlan: MigrationPreview["plan"] = {
      action: "map_sessions",
      assignments: {
        [s1]: { kind: "existing_workspace", project_id: wsA.project_id },
        [s2]: { kind: "existing_workspace", project_id: wsB.project_id },
      },
    };
    const planned3 = await preview(t, projectId, { plan: replayPlan });
    assert.ok(planned3.revision, `复用计划应可生成修订：${planned3.plan_errors.join(";")}`);
    const seqBefore2 = t.runtime.store.getMaxSeq();
    const applied2 = await applyPlan(t, planned3.instance_id, projectId, "req-map-2", replayPlan, planned3.revision);
    assert.equal(applied2.created_workspaces.length, 0, "不重复创建工作区");
    assert.deepEqual(
      applied2.mappings.map((m: any) => [m.from, m.to].join("→")).sort(),
      [wsA.project_id, wsB.project_id].map((id) => `${id}→${id}`).sort(),
    );
    assert.equal(t.runtime.store.getEventsAfter(seqBefore2).filter((e) => e.body.type === "session.workspace_mapped").length, 0, "同值不产生新事件");

    // 过期 1：组织映射已被应用改变 → 旧修订失效（仍合法的计划 + 旧修订拒绝）
    await assert.rejects(
      () => applyPlan(t, planned1.instance_id, projectId, "req-map-3", replayPlan, planned1.revision),
      (err: any) => err.code === "revision_conflict",
      "组织映射变化使旧预览过期",
    );
    // 过期 2：来源新增会话
    const beforeAdd = await preview(t, projectId, { plan: replayPlan });
    const idMulti = dirIdentityOf(multi);
    t.runtime.store.createSession({
      projectId, cwd: idMulti.cwd, cwdReal: idMulti.cwdReal, cwdDev: idMulti.dev, cwdIno: idMulti.ino,
      piSessionId: "pi-new-src", confirmTools: [],
    });
    const afterAdd = await preview(t, projectId, { plan: replayPlan });
    assert.notEqual(afterAdd.revision, beforeAdd.revision, "来源新增会话使修订变化");
    // 过期 3：设置版本变化
    const beforeSettings = await preview(t, projectId, { plan: replayPlan });
    await t.client.request("set_project_instructions", { project_id: projectId, files: ["NEW.md"] });
    const afterSettings = await preview(t, projectId, { plan: replayPlan });
    assert.notEqual(afterSettings.revision, beforeSettings.revision, "来源设置版本变化使修订变化");
    // 过期 4：计划文件被编辑（旧修订与提交选择不符即拒绝）
    await assert.rejects(
      () => applyPlan(t, afterSettings.instance_id, projectId, "req-map-4",
        { action: "map_sessions", assignments: { [s2]: { kind: "existing_workspace", project_id: wsB.project_id } } },
        afterSettings.revision),
      (err: any) => err.code === "revision_conflict",
      "修订与提交选择不符即拒绝",
    );

    // 父目录作多仓库工作区：所选会话真实目录逐个核对在该根内
    const parentPlan: MigrationPreview["plan"] = {
      action: "map_sessions",
      assignments: {
        [s1]: { kind: "new_workspace", root: multi },
        [s2]: { kind: "new_workspace", root: multi },
      },
    };
    const planned4 = await preview(t, projectId, { plan: parentPlan });
    assert.ok(planned4.revision, `父目录选择应可生成修订：${planned4.plan_errors.join(";")}`);
    const applied3 = await applyPlan(t, planned4.instance_id, projectId, "req-map-5", parentPlan, planned4.revision);
    assert.equal(applied3.created_workspaces.length, 1, "两个会话共用同一个父目录工作区");
    // 根外会话拒绝映射：会话目录不在目标根内
    const badPlan = await preview(t, projectId, {
      plan: { action: "map_sessions", assignments: { [s1]: { kind: "new_workspace", root: t.work[1]! } } },
    });
    assert.equal(badPlan.revision, null);
    assert.ok(badPlan.plan_errors.some((m) => m.includes("不在所选根目录")));
  } finally {
    await t.shutdown();
  }
});

function migrationFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-migration-")), db = new Db(root), store = new Store(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const dirs = ["repo-a", "repo-b", "other"].map(name => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; });
  const projectId = store.withTx(() => store.createProject("多目录旧项目")).id;
  const create = (cwd: string, projectId: string) => {
    const identity = dirIdentityOf(cwd);
    return store.withTx(() => store.createSession({ projectId, cwd: identity.cwd, cwdReal: identity.cwdReal, cwdDev: identity.dev, cwdIno: identity.ino, piSessionId: crypto.randomUUID(), confirmTools: [] }));
  };
  const sessions = dirs.map(dir => create(dir, projectId));
  return { root, store, deps: { store, instanceId: db.getInstanceId() }, projectId, repoA: dirs[0], repoB: dirs[1], s1: sessions[0].id, s2: sessions[1].id, create };
}

test("事务中途故障（部分 SQL 已执行）整体回滚；失败后以同键恢复", t => {
  const { store, deps, projectId, repoA, repoB, s1, s2 } = migrationFixture(t);
  const plan: MigrationPreview["plan"] = { action: "map_sessions", assignments: { [s1]: { kind: "new_workspace", root: repoA }, [s2]: { kind: "new_workspace", root: repoB } } };
  const planned = previewWorkspaceMigration(deps, { projectId, plan }); assert.ok(planned.revision);
  const input = { projectId, instanceId: planned.instance_id, requestId: "req-rb-1", plan, expectedRevision: planned.revision };
  const original = store.mapSessionToWorkspace.bind(store); let calls = 0;
  const replacement = t.mock.method(store, "mapSessionToWorkspace", (sessionId: string, ws: string | null) => {
    if (++calls === 2) throw Object.assign(new Error("注入故障"), { code: "injected" });
    return original(sessionId, ws);
  });
  const seqBefore = store.getMaxSeq(), projectsBefore = store.listProjects().length;
  assert.throws(() => applyWorkspaceMigration(deps, input), { code: "injected" });
  replacement.mock.restore();
  assert.equal(store.listProjects().length, projectsBefore, "不留空项目");
  assert.equal(store.getSession(s1)!.workspaceProjectId, null, "不留部分映射");
  assert.equal(store.getEventsAfter(seqBefore).length, 0, "回滚的事务不产生事件");
  assert.equal(store.getMetaValue("migration_receipt:req-rb-1"), null, "不留成功回执");
  const applied = applyWorkspaceMigration(deps, input);
  assert.equal(applied.ok, true); assert.equal(store.listProjects().length, projectsBefore + 2);
});

test("revert：只恢复显式组织映射并校验当前值；claim 不可回退；新建工作区保留", t => {
  const { store, deps, root, projectId, repoA, repoB, s1, create } = migrationFixture(t);
  const plan: MigrationPreview["plan"] = { action: "map_sessions", assignments: { [s1]: { kind: "new_workspace", root: repoA } } };
  const planned = previewWorkspaceMigration(deps, { projectId, plan });
  const applied = applyWorkspaceMigration(deps, { projectId, instanceId: planned.instance_id, requestId: "req-m-1", plan, expectedRevision: planned.revision! });
  const wsId = applied.created_workspaces[0].project_id;
  const other = store.withTx(() => store.createProject("另一工作区", null, dirIdentityOf(repoB)));
  store.withTx(() => store.mapSessionToWorkspace(s1, other.id));
  const revert = { projectId, instanceId: planned.instance_id, requestId: "req-rv-1", plan: { action: "revert", revert_request_id: "req-m-1" } };
  assert.throws(() => applyWorkspaceMigration(deps, revert), { code: "revision_conflict" }, "当前值已被修改时拒绝回退");
  store.withTx(() => store.mapSessionToWorkspace(s1, wsId));
  const reverted = applyWorkspaceMigration(deps, revert);
  assert.equal(reverted.action, "revert"); assert.equal(reverted.reverted_request_id, "req-m-1");
  assert.deepEqual(reverted.mappings, [{ session_id: s1, from: wsId, to: null }]);
  assert.equal(store.getSession(s1)!.workspaceProjectId, null, "恢复原映射");
  assert.ok(store.getProject(wsId)!.rootDir, "新建工作区保留");
  assert.equal(applyWorkspaceMigration(deps, revert).replayed, true, "回退按回执幂等重放");
  const claimDir = path.join(root, "claim-src"); fs.mkdirSync(claimDir);
  const claimId = store.withTx(() => store.createProject("认领源")).id; create(claimDir, claimId);
  const claimPreview = previewWorkspaceMigration(deps, { projectId: claimId });
  assert.equal(claimPreview.safe_claim.eligible, true, claimPreview.safe_claim.reasons.join(";"));
  const claimPlan: MigrationPreview["plan"] = { action: "claim_source", root: claimPreview.safe_claim.root!.cwdReal };
  const plannedC = previewWorkspaceMigration(deps, { projectId: claimId, plan: claimPlan });
  const appliedC = applyWorkspaceMigration(deps, { projectId: claimId, instanceId: plannedC.instance_id, requestId: "req-c-1", plan: claimPlan, expectedRevision: plannedC.revision! });
  assert.equal(appliedC.action, "claim_source");
  assert.throws(() => applyWorkspaceMigration(deps, { projectId: claimId, instanceId: plannedC.instance_id, requestId: "req-rv-2", plan: { action: "revert", revert_request_id: "req-c-1" } }), { code: "invalid_params" }, "认领的根目录身份不可回退");
  assert.throws(() => applyWorkspaceMigration(deps, { ...revert, requestId: "req-rv-3", plan: { action: "revert", revert_request_id: "req-no-such" } }), { code: "not_found" });
});

// ---------- 目录入口收紧（步骤 2） ----------

test("收紧：open_workspace 与 findWorkspaceProjects 不认领多目录旧项目", async () => {
  const t = await startTestRuntime("ws76-tighten", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId, dirX, s1 } = await seedMultiDirLegacy(t);
    // 后台防御：多目录旧项目认领到其中一个目录 → invalid_params，归属不变且不留会话
    await assert.rejects(
      () => t.client.request("open_workspace", { cwd: dirX, project_id: projectId, request_id: "boot-multidir" }),
      (err: any) => err.code === "invalid_params" && /多个目录/.test(err.message),
      "多目录旧项目不能在迁移流程之外认领",
    );
    assert.equal(t.runtime.store.getProject(projectId)!.rootDir, null, "归属未被改写");
    assert.ok(!t.runtime.store.listSessions().some((s) => s.createRequestId === "boot-multidir"), "不留新会话");
    const hs = await t.client.handshake();
    const candidates = findWorkspaceProjects(
      { projects: hs.snapshot.projects, sessions: hs.snapshot.sessions, roleSessionIds: hs.snapshot.roleSessionIds ?? [] },
      dirIdentityOf(dirX),
    );
    assert.ok(!candidates.some((p) => p.id === projectId), "客户端候选同款排除（不发必遭拒绝的认领）");
    void s1;
  } finally {
    await t.shutdown();
  }
});

test("findWorkspaceProjects：多目录旧项目不作候选（纯函数）", () => {
  const identity = { cwd: "/w", cwdReal: "/w", dev: 1, ino: 1 };
  const other = { cwd: "/o", cwdReal: "/o", dev: 2, ino: 2 };
  const projects = [fakeProject({ id: "p_multi" }), fakeProject({ id: "p_single" })];
  const sessions = [
    fakeSession({ id: "s_m1", projectId: "p_multi" }),
    fakeSession({ id: "s_m2", projectId: "p_multi", cwd: "/o", cwdReal: "/o", cwdDev: 2, cwdIno: 2 }),
    fakeSession({ id: "s_s1", projectId: "p_single" }),
  ];
  const candidates = findWorkspaceProjects({ projects, sessions, roleSessionIds: [] }, identity);
  assert.deepEqual(candidates.map((p) => p.id), ["p_single"], "多目录旧项目由迁移流程处理，不作目录候选");
  assert.deepEqual(findWorkspaceProjects({ projects, sessions, roleSessionIds: [] }, other).map((p) => p.id), [], "多目录项目在任一目录上都不作候选");
});

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

// ==================== 步骤 4：归属查询与界面打通（op 缝随） ====================

test("list_session_summaries：project_id 与 workspace_id 互斥；归属查询复用摘要算法且不受映射事件影响", async () => {
  const t = await startTestRuntime("ws76-summaries", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId, sessionId: s1 } = await createProjectSession(t.client, t.work[0]!, { projectName: "旧项目 L" });
    const s2 = (await t.client.request<any>("create_session", { project_id: projectId, cwd: t.work[0]! })) as any;
    const ws = (await t.client.request<any>("open_workspace", { cwd: t.work[1]!, request_id: "boot-sum" })) as any;
    const wsId = ws.session.projectId as string;

    // s1 有实际任务活动；等任务完成后记录映射前的活跃时间（完成事件是最新活动）
    await t.client.request("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: s1, request_id: "sum-1", input: "映射前的任务",
    });
    await waitFor("任务完成", async () => {
      const detail = (await t.client.request<any>("get_task", { task_id: (await t.client.request<any>("find_task", { session_id: s1, request_id: "sum-1" })).task!.id })) as any;
      return detail.task.status === "completed";
    });
    const before = (await t.client.request<any>("list_session_summaries", { project_id: projectId })) as any[];
    const activeBefore = before.find((s) => s.sessionId === s1)!.lastActiveAt;

    // 互斥校验
    await assert.rejects(
      () => t.client.request("list_session_summaries", { project_id: projectId, workspace_id: wsId }),
      (err: any) => err.code === "invalid_params",
      "两参互斥",
    );
    await assert.rejects(
      () => t.client.request("list_session_summaries", {}),
      (err: any) => err.code === "invalid_params",
      "必填其一",
    );
    await assert.rejects(
      () => t.client.request("list_session_summaries", { workspace_id: "missing" }),
      (err: any) => err.code === "not_found",
    );

    // 映射 s1 → W
    t.runtime.store.withTx(() => t.runtime.store.mapSessionToWorkspace(s1, wsId));

    // workspace_id：组织归属查询——s1（已映射）+ 工作区自身会话；不含未映射的 s2
    const byWorkspace = (await t.client.request<any>("list_session_summaries", { workspace_id: wsId })) as any[];
    assert.deepEqual(
      byWorkspace.map((s) => s.sessionId).sort(),
      [s1, ws.session.id].sort(),
      "工作区会话列表按组织归属",
    );
    // project_id：旧 API 语义保留——按原身份仍列出 s1 与 s2
    const bySource = (await t.client.request<any>("list_session_summaries", { project_id: projectId })) as any[];
    assert.deepEqual(bySource.map((s) => s.sessionId).sort(), [s1, s2.id].sort(), "旧查询语义不变");
    // 映射事件不算任务活跃：摘要名称与活跃时间与映射前一致
    const mapped = byWorkspace.find((s) => s.sessionId === s1)!;
    assert.equal(mapped.lastActiveAt, activeBefore, "映射事件不能让旧会话显示为刚刚执行任务");
    assert.equal(mapped.name, "映射前的任务", "摘要算法与旧查询相同");
  } finally {
    await t.shutdown();
  }
});

// ==================== 验收场景补齐（验证与验收「必须覆盖」） ====================

/** 最后一个 tool 结果消息在最后一个 user 消息之后 = 本轮工具已返回（与 test/75 同款判定）。 */
function toolRoundDone(req: { messages: Array<{ role?: string }> }): boolean {
  let lastUser = -1;
  let lastTool = -1;
  req.messages.forEach((m, i) => {
    if (m?.role === "user") lastUser = i;
    if (m?.role === "tool" && i > lastUser) lastTool = i;
  });
  return lastTool > lastUser;
}

async function submitAndWait(t: TestRuntime, sessionId: string, requestId: string, input: string): Promise<{ id: string; detail: any }> {
  const task = (await t.client.request<any>("submit", {
    model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" }, session_id: sessionId, request_id: requestId, input,
  })) as any;
  await waitFor(`任务终态 ${requestId}`, async () => {
    const s = await t.client.request<any>("find_task", { session_id: sessionId, request_id: requestId });
    return s.task && ["completed", "failed", "canceled", "interrupted"].includes(s.task.status);
  });
  const found = (await t.client.request<any>("find_task", { session_id: sessionId, request_id: requestId })) as any;
  const detail = (await t.client.request<any>("get_task", { task_id: found.task.id })) as any;
  assert.equal(detail.task.status, "completed", `任务 ${requestId} 应完成（实际 ${detail.task.status}）`);
  return { id: found.task.id, detail };
}

function toolOp(detail: any, toolName: string): any {
  const op = (detail.toolOps as any[]).find((o) => o.toolName === toolName);
  assert.ok(op, `任务 ${detail.task?.id} 应记录 ${toolName} 工具操作`);
  return op;
}

test("接入边界：两旧项目归入同一工作区后跨来源仍拒；新会话不因映射获得源资料；原授权 ID/方向/撤销保持", async () => {
  let seq = 0;
  const oneCall = (name: string, args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ id: `c${++seq}`, name, arguments: args }] });
  const responder = (req: Parameters<typeof lastUserText>[0]): any => {
    if (toolRoundDone(req)) return { kind: "text", text: "完成" };
    const text = lastUserText(req);
    if (text === "查甲") return oneCall("history_search", { query: "青铜灯塔", role: "user" });
    if (text === "查乙") return oneCall("history_search", { query: "绯红水车", role: "user" });
    return { kind: "text", text: "好" };
  };
  const t = await startTestRuntime("ws76-boundary", responder, { workDirs: 1 });
  try {
    const root = path.join(t.dirs.root, "bigws");
    const a1 = path.join(root, "a1");
    const a2 = path.join(root, "a2");
    const a3 = path.join(root, "a3");
    fs.mkdirSync(a1, { recursive: true });
    fs.mkdirSync(a2, { recursive: true });
    fs.mkdirSync(a3, { recursive: true });
    // 两个旧项目（各有暗号），迁移前已有原授权 L1→L2
    const { projectId: l1, sessionId: s1 } = await createProjectSession(t.client, a1, { projectName: "旧项目甲" });
    const { projectId: l2, sessionId: s2 } = await createProjectSession(t.client, a2, { projectName: "旧项目乙" });
    const preGrant = (await t.client.request<any>("create_data_grant", { from_project_id: l1, to_project_id: l2, category: "history", purpose: "迁移前原授权" })) as any;
    await submitAndWait(t, s1, "seed-jia", "甲信号：青铜灯塔");
    await submitAndWait(t, s2, "seed-yi", "乙信号：绯红水车");

    // 分两次应用：甲的会话新建工作区（父目录多仓库根），乙的会话归入同一工作区
    const p1 = await preview(t, l1, { plan: { action: "map_sessions", assignments: { [s1]: { kind: "new_workspace", root } } } });
    const a1res = await applyPlan(t, p1.instance_id, l1, "req-b-1", p1.plan, p1.revision);
    const wsId = a1res.created_workspaces[0].project_id as string;
    const p2 = await preview(t, l2, { plan: { action: "map_sessions", assignments: { [s2]: { kind: "existing_workspace", project_id: wsId } } } });
    await applyPlan(t, p2.instance_id, l2, "req-b-2", p2.plan, p2.revision);
    const sW = (await t.client.request<any>("create_session", { project_id: wsId, cwd: a3 })) as any;

    // 原授权 ID 与方向保持（迁移不产生第二份授权状态）
    const grantsAfter = ((await t.client.request<any>("list_data_grants", {})) as any).grants as any[];
    const kept = grantsAfter.find((g) => g.id === preGrant.id)!;
    assert.ok(kept && kept.fromProjectId === l1 && kept.toProjectId === l2 && kept.revokedAt === null, "原授权 ID 与方向保持");

    // 原授权方向保持：归入同一工作区后，乙经原授权（L1→L2）仍可读甲（项目内访问不被迁移破坏）
    let d = await submitAndWait(t, s2, "q-jia-0", "查甲");
    let op = toolOp(d.detail, "history_search");
    assert.ok(String(op.resultSummary ?? "").includes("青铜灯塔"), "原授权（L1→L2）方向保持：乙仍可读甲");
    // 目标工作区新会话（其他 Project 身份）不因映射获得源资料
    d = await submitAndWait(t, sW.id, "q-w-0", "查甲");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "目标工作区新会话不因组织映射获得旧项目资料");
    d = await submitAndWait(t, sW.id, "q-w-0b", "查乙");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "新会话对两个旧项目同源拒绝");
    // 方向保持的反侧：甲没有 L2→L1 授权，读乙仍拒
    d = await submitAndWait(t, s1, "q-yi-deny", "查乙");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "授权有方向：甲读乙仍拒");

    // 授权 L1→W 后新会话可读；撤销最后一条有效授权后拒绝
    const grantW = (await t.client.request<any>("create_data_grant", { from_project_id: l1, to_project_id: wsId, category: "history" })) as any;
    d = await submitAndWait(t, sW.id, "q-w-1", "查甲");
    op = toolOp(d.detail, "history_search");
    assert.ok(String(op.resultSummary ?? "").includes("青铜灯塔"), "显式授权后目标工作区新会话可读");
    await t.client.request("revoke_data_grant", { grant_id: grantW.id });
    d = await submitAndWait(t, sW.id, "q-w-2", "查甲");
    op = toolOp(d.detail, "history_search");
    assert.match(op.resultSummary ?? "", /命中 0 条/, "撤销最后一条有效授权后拒绝");
  } finally {
    await t.shutdown();
  }
});

test("映射后任务配置与资料来源不变：指令/记忆按源项目，MCP 归实例；新会话用目标配置；认领后新会话延续原 ID", async () => {
  const t = await startTestRuntime("ws76-config-src", async () => ({ kind: "text", text: "好" }));
  try {
    // 来源项目保留指令与记忆；MCP 使用实例服务。
    const dirS = t.work[0]!;
    fs.writeFileSync(path.join(dirS, "AGENTS.md"), "旧项目约定：SRC-INSTRUCTION-MARK");
    const { projectId: l1, sessionId: s1 } = await createProjectSession(t.client, dirS, { projectName: "来源项目" });
    await t.client.request("set_project_instructions", { project_id: l1, files: ["AGENTS.md"] });
    await t.client.request("add_credential", { name: "legacy-key", host: "docs.example.com", header: "Authorization", purpose: "mcp", secret: "smoke-dummy-secret" });
    const mcpBefore = (await t.client.request<any>("mcp_configure", {
      name: "docs", endpoint: "https://docs.example.com/mcp", credential: "legacy-key", tool_allowlist: ["search"],
    })) as any;
    const mem = (await t.client.request<any>("save_memory", {
      project_id: l1, category: "convention", content: "源项目记忆：墨色门环", source_refs: [{ kind: "owner_note", note: "n" }],
    })) as any;
    // 目标工作区
    const dirW = t.work[1]!;
    fs.writeFileSync(path.join(dirW, "TEAM.md"), "工作区约定：WS-INSTRUCTION-MARK");
    const ws = (await t.client.request<any>("open_workspace", { cwd: dirW, request_id: "boot-cfg" })) as any;
    const wsId = ws.session.projectId as string;
    await t.client.request("set_project_instructions", { project_id: wsId, files: ["TEAM.md"] });

    // 映射
    t.runtime.store.withTx(() => t.runtime.store.mapSessionToWorkspace(s1, wsId));
    // 映射不改变实例 MCP 配置，也不改变其他资料的来源。
    const services = ((await t.client.request<any>("mcp_list", {})) as any).services as any[];
    assert.equal(services[0]!.id, mcpBefore.id, "MCP 服务 ID 保持");
    assert.equal(services[0]!.configVersion, mcpBefore.configVersion, "MCP 配置版本保持");
    assert.equal(services[0]!.credential, "legacy-key", "实例凭据引用保持");
    const creds = (await t.client.request<any>("list_credentials", {})) as any;
    assert.deepEqual(
      creds.map((x: any) => [x.name, x.host, x.purpose]),
      [["legacy-key", "docs.example.com", "mcp"]],
      "凭据绑定未被映射改动",
    );
    const memNow = (await t.client.request<any>("get_memory", { memory_id: mem.id })) as any;
    assert.equal(memNow.memory.currentVersion, 1, "记忆来源与版本保持");
    assert.equal(memNow.memory.projectId, l1, "记忆留在来源项目");

    // 映射旧会话的后续任务：使用原项目指令
    let before = t.server.calls.length;
    await submitAndWait(t, s1, "cfg-after-1", "映射后的任务");
    const offPayload = JSON.stringify(t.server.calls.slice(before).map((c) => c.messages));
    assert.ok(offPayload.includes("SRC-INSTRUCTION-MARK"), "映射旧会话任务使用原项目指令");
    assert.ok(!offPayload.includes("WS-INSTRUCTION-MARK"), "不注入目标工作区指令");

    // 工作区新会话：使用目标工作区配置（指令）
    const sW = (await t.client.request<any>("create_session", { project_id: wsId, cwd: dirW })) as any;
    before = t.server.calls.length;
    await submitAndWait(t, sW.id, "cfg-after-2", "工作区新任务");
    const onPayload = JSON.stringify(t.server.calls.slice(before).map((c) => c.messages));
    assert.ok(onPayload.includes("WS-INSTRUCTION-MARK"), "目标工作区新会话使用目标指令");
    assert.ok(!onPayload.includes("SRC-INSTRUCTION-MARK"), "目标工作区不注入旧项目指令");

    // 安全认领：新会话延续原 ID 已有的配置与资料范围（指令按认领根目录读取）
    const dirC = path.join(t.dirs.root, "claim-src2");
    fs.mkdirSync(dirC);
    fs.writeFileSync(path.join(dirC, "CLAIM.md"), "认领源约定：CLAIM-INSTRUCTION-MARK");
    const { projectId: l2 } = await createProjectSession(t.client, dirC, { projectName: "认领源项目" });
    await t.client.request("set_project_instructions", { project_id: l2, files: ["CLAIM.md"] });
    const p2 = await preview(t, l2, { plan: { action: "claim_source", root: fs.realpathSync(dirC) } });
    await applyPlan(t, p2.instance_id, l2, "req-cfg-claim", p2.plan, p2.revision);
    const sNew = (await t.client.request<any>("create_session", { project_id: l2, cwd: dirC })) as any;
    before = t.server.calls.length;
    await submitAndWait(t, sNew.id, "cfg-claim-1", "认领后新任务");
    assert.ok(
      JSON.stringify(t.server.calls.slice(before).map((c) => c.messages)).includes("CLAIM-INSTRUCTION-MARK"),
      "认领后新会话延续原 ID 的指令配置",
    );
  } finally {
    await t.shutdown();
  }
});

test("迁移前后标识与字节可核对：pi ID/文件路径/JSONL 与产物字节/任务与选择记录不变", async () => {
  const BIG_TEXT = "中文-abc-0123\n";
  const responder = (req: { messages: Array<{ role?: string }> }): any => {
    const done = req.messages.filter((m) => m?.role === "tool").length;
    if (done === 0) {
      return { kind: "tool_calls", calls: [{ id: "c_big", name: "bash", arguments: { command: `node -e 'process.stdout.write(${JSON.stringify(BIG_TEXT)}.repeat(30000))'` } }] };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("ws76-bytes", responder, { workDirs: 1, config: (await import("./helpers/testkit.ts")).realTools() });
  try {
    const { projectId: legacyId, sessionId: s1 } = await createProjectSession(t.client, t.work[0]!, { projectName: "核对项目" });
    // 产物任务（大 stdout → 产物文件）
    const task = (await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: s1, request_id: "bytes-1", input: "产生大输出",
    })) as any;
    await waitFor("任务完成", async () => (await t.client.request<any>("get_task", { task_id: task.id })).task.status === "completed", 120_000);
    const before1 = (await t.client.request<any>("get_task", { task_id: task.id })) as any;
    const artifact = (before1.artifacts as any[]).find((a) => a.name.includes("stdout"))!;

    // 迁移前快照：标识、JSONL 字节、产物字节、选择记录
    const sBefore = t.runtime.store.getSession(s1)!;
    await waitFor("历史文件落盘", () => fs.existsSync(sBefore.sessionFile!) && fs.statSync(sBefore.sessionFile!).size > 0);
    const sessionIdList = s1;
    const piBefore = sBefore.piSessionId;
    const fileBefore = sBefore.sessionFile!;
    const jsonlBefore = fs.readFileSync(fileBefore);
    const readArtifactBytes = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for (let offset = 0; ; offset += 65536) {
        const part = (await t.client.request<any>("read_artifact", { task_id: task.id, artifact_id: artifact.id, offset, length: 65536 })) as any;
        const chunk = Buffer.from(part.data, "base64");
        chunks.push(chunk);
        if (chunk.length < 65536) break;
      }
      return Buffer.concat(chunks);
    };
    const artifactBefore = await readArtifactBytes();
    const recordsBefore = ((await t.client.request<any>("list_selection_records", { session_id: sessionIdList })) as any).records as any[];
    assert.ok(recordsBefore.length > 0, "迁移前已有选择记录");

    // 应用到根目录包含旧会话目录的工作区
    const ws = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-bytes" })) as any;
    const p = await preview(t, legacyId, { plan: { action: "map_sessions", assignments: { [s1]: { kind: "existing_workspace", project_id: ws.session.projectId } } } });
    assert.ok(p.revision, `计划应可生成修订：${p.plan_errors.join(";")}`);
    await applyPlan(t, p.instance_id, legacyId, "req-bytes-1", p.plan, p.revision);

    // 迁移后逐项核对：全部保持
    const sAfter = t.runtime.store.getSession(s1)!;
    assert.equal(sAfter.piSessionId, piBefore, "pi 会话 ID 保持");
    assert.equal(sAfter.sessionFile, fileBefore, "历史文件路径保持");
    assert.equal(sAfter.projectId, legacyId, "资料身份（projectId）保持");
    assert.equal(sAfter.workspaceProjectId, ws.session.projectId, "组织归属已映射");
    assert.deepEqual(fs.readFileSync(fileBefore), jsonlBefore, "JSONL 字节不变（迁移不改写历史）");
    assert.deepEqual(await readArtifactBytes(), artifactBefore, "产物字节不变");
    assert.deepEqual(await readArtifactBytes(), Buffer.from(BIG_TEXT.repeat(30000), "utf8"), "产物与原始输出一致");
    const recordsAfter = ((await t.client.request<any>("list_selection_records", { session_id: sessionIdList })) as any).records as any[];
    assert.deepEqual(recordsAfter.map((r) => r.id), recordsBefore.map((r) => r.id), "prompt/选择记录仍可读取且不变");
    const history = (await t.client.request<any>("read_history", { session_id: s1 })) as any;
    assert.ok(JSON.stringify(history).includes("产生大输出"), "原历史仍按会话 ID 可读");
    const taskAfter = (await t.client.request<any>("get_task", { task_id: task.id })) as any;
    assert.equal(taskAfter.task.input, "产生大输出", "任务与引用保持");
  } finally {
    await t.shutdown();
  }
});

test("回退只恢复显式组织字段：已修改配置、新任务与授权撤销事实全部保留", async () => {
  const t = await startTestRuntime("ws76-revert-keep", async () => ({ kind: "text", text: "好" }));
  try {
    const ws = (await t.client.request<any>("open_workspace", { cwd: t.work[0]!, request_id: "boot-rk" })) as any;
    const wsId = ws.session.projectId as string;
    // 旧会话目录在工作区根内（inside-root 规则：映射只核真实目录位于根内的会话）
    const leg = path.join(t.work[0]!, "leg");
    fs.mkdirSync(leg);
    const { projectId: legacyId, sessionId: s1 } = await createProjectSession(t.client, leg, { projectName: "回退项目" });
    const plan: MigrationPreview["plan"] = { action: "map_sessions", assignments: { [s1]: { kind: "existing_workspace", project_id: wsId } } };
    const p = await preview(t, legacyId, { plan });
    await applyPlan(t, p.instance_id, legacyId, "req-rk-map", plan, p.revision);

    // 迁移后产生的事实：工作区配置修改、（映射组织字段不影响的）新任务、授权与其撤销
    await t.client.request("set_project_instructions", { project_id: wsId, files: ["W.md"] });
    const grant = (await t.client.request<any>("create_data_grant", { from_project_id: legacyId, to_project_id: wsId, category: "history" })) as any;
    await t.client.request("revoke_data_grant", { grant_id: grant.id });
    const sW = (await t.client.request<any>("create_session", { project_id: wsId, cwd: t.work[0]! })) as any;
    await submitAndWait(t, sW.id, "rk-new-task", "迁移后的新任务");
    await submitAndWait(t, s1, "rk-legacy-task", "映射后旧会话的任务");

    // 回退：只恢复显式组织映射
    const reverted = await t.client.request<any>("apply_workspace_migration", {
      project_id: legacyId, instance_id: p.instance_id, request_id: "req-rk-revert",
      plan: { action: "revert", revert_request_id: "req-rk-map" },
    });
    assert.equal(reverted.action, "revert");

    // 事实全部保留
    assert.equal(t.runtime.store.getSession(s1)!.workspaceProjectId, null, "显式组织字段被恢复");
    assert.equal(t.runtime.store.getProject(wsId)!.settingsVersion, 2, "配置修改保留");
    const grants = ((await t.client.request<any>("list_data_grants", { include_revoked: true })) as any).grants as any[];
    assert.ok(grants.find((g) => g.id === grant.id)!.revokedAt, "已发生的授权撤销保留");
    const newTask = (await t.client.request<any>("find_task", { session_id: sW.id, request_id: "rk-new-task" })) as any;
    assert.equal(newTask.task.status, "completed", "迁移后新任务保留且可读");
    const legacyTask = (await t.client.request<any>("find_task", { session_id: s1, request_id: "rk-legacy-task" })) as any;
    assert.equal(legacyTask.task.status, "completed", "映射期间的旧会话任务保留（组织映射不改变任务身份）");
    assert.ok(t.runtime.store.getProject(wsId)!.rootDir, "工作区保留不随回退删除");
  } finally {
    await t.shutdown();
  }
});

test("目标根预览后被替换：应用明确拒绝且零副作用（失效/替换如实拒绝，重新核实）", async () => {
  const t = await startTestRuntime("ws76-stale-target", async () => ({ kind: "text", text: "x" }));
  try {
    const dirT = path.join(t.dirs.root, "target-root");
    fs.mkdirSync(dirT);
    const ws = (await t.client.request<any>("open_workspace", { cwd: dirT, request_id: "boot-stale" })) as any;
    // 旧会话目录在目标根内（inside-root 规则）
    const sub = path.join(dirT, "sub");
    fs.mkdirSync(sub);
    const { projectId: legacyId, sessionId: s1 } = await createProjectSession(t.client, sub, { projectName: "源项目" });
    const plan: MigrationPreview["plan"] = { action: "map_sessions", assignments: { [s1]: { kind: "existing_workspace", project_id: ws.session.projectId } } };
    const planned = await preview(t, legacyId, { plan });
    assert.ok(planned.revision);
    // 预览后目标工作区根目录被替换（同路径新目录，不当作旧目录）
    fs.rmSync(dirT, { recursive: true, force: true });
    fs.mkdirSync(dirT);
    const seqBefore = t.runtime.store.getMaxSeq();
    await assert.rejects(
      () => applyPlan(t, planned.instance_id, legacyId, "req-stale-1", planned.plan, planned.revision),
      (err: any) => err.code === "invalid_params" && /失效|被替换/.test(err.message),
      "目标根失效/被替换明确拒绝并要求重新预览",
    );
    assert.equal(t.runtime.store.getSession(s1)!.workspaceProjectId, null, "拒绝不改组织字段");
    assert.equal(t.runtime.store.getEventsAfter(seqBefore).length, 0, "拒绝零事件零副作用");
    assert.equal(t.runtime.store.getMetaValue("migration_receipt:req-stale-1"), null, "拒绝不留回执");
  } finally {
    await t.shutdown();
  }
});

test("回执跨进程重启核实：meta 持久，重开后同键重放返回原成果", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ws76-restart-"));
  const dirR = path.join(dataDir, "root-target");
  fs.mkdirSync(dirR);
  try {
    const db1 = new Db(dataDir);
    const store1 = new Store(db1);
    const legacy = store1.withTx(() => store1.createProject("旧项目"));
    const idR = dirIdentityOf(dirR);
    const s1 = store1.withTx(() =>
      store1.createSession({ projectId: legacy.id, cwd: idR.cwd, cwdReal: idR.cwdReal, cwdDev: idR.dev, cwdIno: idR.ino, piSessionId: "pi-rs", confirmTools: [] }),
    );
    const deps1 = { store: store1, instanceId: db1.getInstanceId() };
    const plan = { action: "map_sessions" as const, assignments: { [s1.id]: { kind: "new_workspace" as const, root: dirR } } };
    const planned = previewWorkspaceMigration(deps1, { projectId: legacy.id, plan });
    const input = { projectId: legacy.id, instanceId: deps1.instanceId, requestId: "req-restart-1", plan, expectedRevision: planned.revision! };
    const applied = applyWorkspaceMigration(deps1, input);
    assert.equal(applied.ok, true);
    db1.close();

    // 模拟进程重启：全新 Db/Store，同一数据文件
    const db2 = new Db(dataDir);
    const store2 = new Store(db2);
    const deps2 = { store: store2, instanceId: db2.getInstanceId() };
    assert.equal(deps2.instanceId, deps1.instanceId, "实例标识跨重启保持");
    const seqBefore = store2.getMaxSeq();
    const replay = applyWorkspaceMigration(deps2, input);
    assert.equal(replay.replayed, true, "重启后同键重放返回原成果（答丢失/重启后以原请求 ID 核实）");
    assert.deepEqual(replay.mappings, applied.mappings);
    assert.equal(store2.getMaxSeq(), seqBefore, "重放零事件零副作用");
    assert.ok(store2.getMetaValue("migration_receipt:req-restart-1") !== null, "回执持久留存");
    db2.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- 评审修复：历史逐行核实与角色翻转过期 ----------

test("历史文件逐行核实：中段损坏报 unreadable；样本截断的末段不作损坏判定", async () => {
  const t = await startTestRuntime("ws76-history-check", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId } = await createProjectSession(t.client, t.work[0]!, { projectName: "核实项目" });
    const mk = (name: string, content: string): string => {
      const file = path.join(t.dirs.dataDir, "sessions", name);
      fs.writeFileSync(file, content);
      return file;
    };
    const sOk = t.runtime.store.createSession({
      projectId, cwd: t.work[0]!, cwdReal: fs.realpathSync(t.work[0]!), cwdDev: 1, cwdIno: 1, piSessionId: "pi-h-ok", confirmTools: [],
    });
    const sCorrupt = t.runtime.store.createSession({
      projectId, cwd: t.work[0]!, cwdReal: fs.realpathSync(t.work[0]!), cwdDev: 1, cwdIno: 2, piSessionId: "pi-h-corrupt", confirmTools: [],
    });
    const sTrunc = t.runtime.store.createSession({
      projectId, cwd: t.work[0]!, cwdReal: fs.realpathSync(t.work[0]!), cwdDev: 1, cwdIno: 3, piSessionId: "pi-h-trunc", confirmTools: [],
    });
    t.runtime.store.setSessionFile(sOk.id, mk("valid.jsonl", '{"a":1}\n{"b":2}\n{"c":3}\n'));
    t.runtime.store.setSessionFile(sCorrupt.id, mk("corrupt.jsonl", '{"a":1}\nNOT-JSON\n{"b":2}\n'));
    // 超过 64 KiB 样本且截断处落在行中段：样本内每一条完整行都合法 → ok（截断段不作损坏判定）
    const longLine = `{"text":"${"x".repeat(3000)}"}`;
    t.runtime.store.setSessionFile(sTrunc.id, mk("long.jsonl", Array.from({ length: 40 }, () => longLine).join("\n") + "\n"));

    const p = await preview(t, projectId);
    const hist = (id: string) => p.sessions.find((s) => s.session_id === id)!;
    assert.equal(hist(sOk.id).history, "ok", "完整合法 JSONL");
    assert.equal(hist(sCorrupt.id).history, "unreadable", "中段损坏单独报告，不显示为没有历史");
    assert.match(hist(sCorrupt.id).history_reason ?? "", /第 2 行/);
    assert.equal(hist(sTrunc.id).history, "ok", "样本截断的末段按不完整处理，不误报损坏");
  } finally {
    await t.shutdown();
  }
});

test("角色绑定变化使预览修订过期（角色绑定是修订输入）", async () => {
  const t = await startTestRuntime("ws76-role-stale", async () => ({ kind: "text", text: "x" }));
  try {
    const { projectId, sessionId: s1 } = await createProjectSession(t.client, t.work[0]!, { projectName: "角色过期项目" });
    seedCodingRole(t.runtime.store, t.dirs.root); // 旧安装保留的 coding 角色行（issue 23 起不再引导）
    const plan: MigrationPreview["plan"] = { action: "claim_source", root: fs.realpathSync(t.work[0]!) };
    const before = await preview(t, projectId, { plan });
    assert.ok(before.revision, `初始修订：${before.plan_errors.join(";")}`);

    // 翻转角色绑定：把 coding 角色改绑到源项目的普通会话（该会话随之被排除）
    const coding = t.runtime.store.listAgentRoles().find((r) => r.id === "coding")!;
    t.runtime.store.db.exec("DELETE FROM agent_roles WHERE id = 'coding'");
    t.runtime.store.withTx(() =>
      t.runtime.store.insertAgentRole({ ...coding, sessionId: s1, projectId }),
    );

    const after = await preview(t, projectId, { plan });
    assert.notEqual(after.revision, before.revision, "角色绑定变化使旧预览修订过期");
    assert.equal(after.sessions.find((s) => s.session_id === s1)!.excluded, "role", "被绑定会话随即明确排除");
    assert.equal(after.safe_claim.eligible, false, "普通会话集合含角色绑定后不可安全认领");
  } finally {
    await t.shutdown();
  }
});

test("拥有者组织迁移可登记保护根祖先且同键重放不改执行模式", async () => {
  const t = await startTestRuntime("owner-map-root", () => ({ kind: "text", text: "不会调用模型" }));
  try {
    const source = await t.runtime.createSession({ projectName: "待归类", cwd: t.work[0]!, mode: "full_access" });
    const protectedRoots = t.runtime.protectedRoots;
    t.runtime.protectedRoots = () => { throw new Error("组织迁移不应计算保护范围"); };
    try {
      const plan = { action: "map_sessions", assignments: { [source.id]: { kind: "new_workspace", root: fs.realpathSync(t.dirs.root) } } };
      const preview = t.runtime.previewWorkspaceMigration({ projectId: source.projectId, plan });
      assert.deepEqual(preview.plan_errors, []);
      assert.ok(preview.revision);
      const input = { projectId: source.projectId, instanceId: preview.instance_id, requestId: "owner-map", plan, expectedRevision: preview.revision };
      const applied = t.runtime.applyWorkspaceMigration(input);
      assert.equal(applied.created_workspaces.length, 1);
      assert.equal(t.runtime.store.getSession(source.id)!.defaultAccessMode, "full_access");
      assert.equal(t.runtime.store.getSession(source.id)!.projectId, source.projectId);
      assert.equal(t.runtime.applyWorkspaceMigration(input).replayed, true);
      assert.equal(t.server.calls.length, 0);
    } finally { t.runtime.protectedRoots = protectedRoots; }
  } finally { await t.shutdown(); }
});
