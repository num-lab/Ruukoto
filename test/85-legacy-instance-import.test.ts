/**
 * 旧开发资料迁入 Coding Agent（agent-direction issue 21，ADR 0022）。
 *
 * 测试接缝：
 * 1. 预览完整且两侧零写入：源目录逐文件 sha256 不变；目标零写入（连副本读取都
 *    不产生文件）；预览覆盖项目/会话归属、历史状态、未终态收尾、待处理审批、
 *    记忆分类、授权分类、凭据缺口、agentDir 差异、修订；
 * 2. 门禁：源后台存活拒绝；源/目标产品错配拒绝；
 * 3. 应用后目标启动：历史与产物字节逐项一致、任务/审批/工具操作/选择记录一致、
 *    事件按序完整、组织映射保留、会话默认降级、有效 cwd 可执行、cwd 失效拒绝执行；
 * 4. 不重放：queued→canceled、running/awaiting_confirmation→interrupted 且
 *    结果未登记的工具操作与任务 effect_unknown、未消费审批 stale、目标启动模型
 *    请求为零、没有入站/调度/通知记录；
 * 5. 跨实例来源：引用 main 的记忆不导入并列待处理、未选中的 personal 不导入、
 *    选中后可导入、跨实例授权只进回执、MCP/Jev 缺凭据以停用导入、目标凭据为空；
 * 6. 冲突、中断续跑与回退：重名未改名拒绝、改名可通过；同 ID 冲突拒绝；
 *    文件复制后故障→同计划重跑无重复；事务内故障整体回滚；同键重放返回回执；
 *    同键异参 request_conflict；源/目标变化 revision_conflict；两批导入识别；
 *    有导入后活动拒绝回退，干净回退移除行/事件/文件且回执保留、源不变、
 *    回执跨进程重启可核实；备份存在且 sha 一致；
 * 7. v20 旧库 fixture：快照迁移只在副本上执行，源 sha 不变，导入成功；
 * 8. CLI：真实 bin 入口 preview/apply/list/revert 与 ruukoto 产品门拒绝。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { randomId, type ModelSelection } from "../src/core/types.ts";
import type { DirIdentity } from "../src/core/dir-identity.ts";
import { ControlServer } from "../src/control/server.ts";
import { Runtime } from "../src/runtime/runtime.ts";
import {
  LegacyImportError,
  applyLegacyImport,
  listLegacyImports,
  previewLegacyImport,
  revertLegacyImport,
} from "../src/runtime/legacy-import.ts";
import {
  connectAuthedClient,
  createProjectSession,
  makeTestDirs,
  startTestRuntime,
  waitFor,
  writeModelsJson,
  type TestRuntime,
} from "./helpers/testkit.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { legacyGroupArchive } from "./helpers/legacy-group-archive.ts";
import { seedCodingRole } from "./helpers/legacy-coding.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_SEL: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
const NOW = "2026-10-04T00:00:00.000Z";

function hashTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else entries.push(`${path.relative(root, p)}:${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function identityOf(dir: string): DirIdentity {
  const cwdReal = fs.realpathSync(dir);
  const st = fs.statSync(cwdReal);
  return { cwd: dir, cwdReal, dev: st.dev, ino: st.ino };
}

async function submitAndWait(client: any, sessionId: string, requestId: string, input: string): Promise<any> {
  await client.request("submit", { model_selection: MOCK_SEL, session_id: sessionId, request_id: requestId, input });
  let detail: any = null;
  await waitFor("任务终态", async () => {
    const found = await client.request("find_task", { session_id: sessionId, request_id: requestId });
    detail = found.task ? await client.request("get_task", { task_id: found.task.id }) : null;
    return detail && ["completed", "failed", "canceled", "interrupted"].includes(detail.task.status);
  });
  return detail.task;
}

function errCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LegacyImportError) return err.code;
    throw err;
  }
  throw new Error("预期抛错但未抛");
}

interface SourceFixture {
  srcDataDir: string;
  srcAgentDir: string;
  root: string;
  work: string[];
  ids: {
    projA: string;
    sa1: string;
    sa2: string;
    taskDone: string;
    taskQueued: string;
    taskRunning: string;
    taskAwaiting: string;
    opUnresolved: string;
    opConfirm: string;
    confPending: string;
    confApproved: string;
    projB: string;
    sb1: string;
    sb2: string;
    mainProj: string;
    codingProj: string;
    codingDev: string;
    sessMain: string;
    sessCoding: string;
    sessChat: string;
    sessQq: string;
    wsProj: string;
    wsSession: string;
    subAgent: string;
    subSession: string;
    work: string;
    artGood: string;
    artMissing: string;
    memProjectOk: string;
    memProjectMainRef: string;
    memPersonalUnselected: string;
    memPersonalSelected: string;
    grantBoth: string;
    grantCross: string;
    mcpId: string;
  };
  cleanup(): void;
}

/** 构造代表性源实例（ruukoto 产品）：两个普通 dev 项目（一个混有角色会话与
 * 工作区映射）、角色会话、QQ 群会话、SubAgent、各状态任务、产物、记忆、授权、
 * 带凭据的 MCP 与 Jev、平台配置与入站。停止后台后保目录返回。 */
async function buildSource(prefix: string): Promise<SourceFixture> {
  const t = await startTestRuntime(prefix, async () => ({ kind: "text", text: "源回答" }));
  try {
    return await buildSourceInner(t);
  } catch (err) {
    // 构造中途失败也要释放后台与目录，避免测试进程被打开句柄拖住
    try {
      t.client.close();
      await t.runtime.stop("fixture_error");
      await t.server.close();
    } finally {
      fs.rmSync(t.dirs.root, { recursive: true, force: true });
    }
    throw err;
  }
}

async function buildSourceInner(t: TestRuntime): Promise<SourceFixture> {
  const store = t.runtime.store;
  const db = t.runtime.store.db;
  const dataDir = t.dirs.dataDir;
  const agentDir = t.dirs.agentDir;
  const work0 = identityOf(t.work[0]!);
  const work1 = identityOf(t.work[1]!);

  // 开发会话 a（完成任务 + 产物 + 检查点 + SubAgent）
  const a = await createProjectSession(t.client, t.work[0]!, { projectName: "dev-a" });
  const tDone = await submitAndWait(t.client, a.sessionId, "req-done", "第一个任务");
  const sa2 = (await t.client.request<any>("create_session", { project_id: a.projectId, cwd: t.work[0] })) as any;
  db.prepare("UPDATE sessions SET default_access_mode = 'full_access' WHERE id = ?").run(sa2.id);

  // dev-b（混有 coding 角色会话；sb2 有 07 的工作区映射）
  const b = await createProjectSession(t.client, t.work[1]!, { projectName: "dev-b" });
  const sb1 = await submitAndWait(t.client, b.sessionId, "req-b1", "b 项目任务") as any;
  const sb2 = (await t.client.request<any>("create_session", { project_id: b.projectId, cwd: t.work[1] })) as any;
  const ws = store.withTx(() => {
    const proj = store.createProject("工作区W");
    store.attachProjectRoot(proj.id, work1);
    return proj;
  });
  const wsSession = store.withTx(() =>
    store.createSession({ projectId: ws.id, cwd: work1.cwd, cwdReal: work1.cwdReal, cwdDev: work1.dev, cwdIno: work1.ino, piSessionId: randomId("pi"), confirmTools: [] }),
  );
  store.withTx(() => store.mapSessionToWorkspace(sb2.id, ws.id));

  // 角色会话与 main 项目：启动时已登记 main，直接复用；chat/coding 已退役
  // （issue 20/23），源是旧安装，两个角色行按归档形态手动播种
  const main = store.getAgentRole("main")!;
  const mainProj = { id: main.projectId };
  const sessMain = { id: main.sessionId };
  const coding = seedCodingRole(store, t.dirs.root);
  const sessCoding = { id: coding.sessionId };
  const sessChat = { id: legacyGroupArchive({ store, qq: t.runtime.qqStore, workRoot: t.dirs.root }).seedChatRole().sessionId };
  const codingProj = { id: coding.projectId };
  // 混在 coding 角色项目里的普通 dev 会话：issue 20 起控制面拒绝在角色项目新建，
  // 源是旧安装，直接按旧行形态写库
  const codingDev = store.withTx(() =>
    store.createSession({ projectId: codingProj.id, cwd: work1.cwd, cwdReal: work1.cwdReal, cwdDev: work1.dev, cwdIno: work1.ino, piSessionId: randomId("pi"), confirmTools: [] }),
  );
  const sessQq = store.withTx(() =>
    store.createSession({ projectId: mainProj.id, kind: "qq_group", cwd: work0.cwd, cwdReal: work0.cwdReal, cwdDev: work0.dev, cwdIno: work0.ino, piSessionId: randomId("pi"), confirmTools: [] }),
  );
  store.withTx(() =>
    db.prepare("INSERT INTO qq_sessions (account, group_id, session_id, project_id, work_dir, created_at) VALUES ('100', '200', ?, ?, ?, ?)").run(sessQq.id, mainProj.id, work0.cwdReal, NOW),
  );

  // SubAgent（独立子会话 + 工作 + 委派任务，未关闭——导入应以关闭状态登记）
  const subSession = store.withTx(() =>
    store.createSession({ projectId: a.projectId, cwd: work0.cwd, cwdReal: work0.cwdReal, cwdDev: work0.dev, cwdIno: work0.ino, piSessionId: randomId("pi"), confirmTools: [] }),
  );
  const sub = { id: randomId("sub"), parentSessionId: a.sessionId, sessionId: subSession.id, workDir: work0.cwdReal, activeWorkId: null, currentTaskId: null, state: "idle" as const, closedAt: null, closedBy: null, createdAt: NOW };
  const wk = { id: randomId("work"), parentSessionId: a.sessionId, originTaskId: tDone.id, subAgentId: sub.id, requestKey: "k-sub", paramsDigest: "d-sub", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: NOW };
  store.withTx(() => {
    store.insertSubAgent(sub);
    store.insertWorkDelegation(wk as never);
  });
  const subTask = store.withTx(() =>
    store.insertQueuedTask({ sessionId: subSession.id, requestId: "sub-r1", input: "分析", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  db.prepare("UPDATE tasks SET status = 'completed', work_id = ?, sub_agent_id = ?, started_at = ?, ended_at = ? WHERE id = ?").run(wk.id, sub.id, NOW, NOW, subTask.id);

  // 产物：正文完整 + 正文缺失各一
  fs.mkdirSync(path.join(dataDir, "artifacts"), { recursive: true });
  const artGood = store.withTx(() => store.createArtifact({ id: randomId("art"), taskId: tDone.id, sessionId: a.sessionId, name: "prompt-snapshot:test" }));
  const artBody = Buffer.from("提示词正文 0123456789", "utf8");
  fs.writeFileSync(path.join(dataDir, "artifacts", `${artGood.id}.bin`), artBody);
  store.withTx(() => {
    store.addArtifactBytes(artGood.id, artBody.length);
    store.setArtifactStatus(artGood.id, "complete");
  });
  const artMissing = store.withTx(() => store.createArtifact({ id: randomId("art"), taskId: tDone.id, sessionId: a.sessionId, name: "missing-body" }));

  // 上下文压缩点（随会话导入）
  db.prepare(
    `INSERT INTO context_checkpoints (id, session_id, status, summarized_count, cleared_count, fingerprint, summary, summary_until,
      cleared_refs, cleared_results, summary_model, summary_status, summary_error, prompt_version, usage, estimate_before, estimate_after,
      task_id, call_index, created_at)
     VALUES (?, ?, 'superseded', 3, 1, 'fp', '摘要', NULL, '{}', 0, 'mock-model', 'ok', NULL, 'p1', NULL, 10, 5, ?, 0, ?)`,
  ).run(randomId("ckpt"), a.sessionId, tDone.id, NOW);

  // 记忆：来源在范围 / 引用 main / personal 未选中与选中
  const m1 = await t.client.request<any>("save_memory", { project_id: a.projectId, category: "convention", content: "项目约定甲", source_refs: [{ kind: "owner_note", note: "建单录入" }] });
  const m2 = await t.client.request<any>("save_memory", { project_id: a.projectId, category: "experience", content: "引用 main 历史的经验", source_refs: [{ kind: "history_entry", sessionId: sessMain.id, entryId: "e-1" }] });
  const m3 = await t.client.request<any>("save_memory", { project_id: null, category: "preference", content: "未选中的个人偏好", source_refs: [{ kind: "owner_note", note: "个人" }] });
  const m4 = await t.client.request<any>("save_memory", { project_id: null, category: "preference", content: "选中发布的个人偏好", source_refs: [{ kind: "owner_note", note: "个人" }] });

  // 授权：双端 dev / 跨到 main 各一
  const g1 = await t.client.request<any>("create_data_grant", { from_project_id: b.projectId, to_project_id: a.projectId, category: "history", purpose: "共享历史" });
  const g2 = await t.client.request<any>("create_data_grant", { from_project_id: b.projectId, to_project_id: mainProj.id, category: "memory", purpose: "跨到 main" });

  // MCP（带凭据）与 Jev（meta）；目标凭据缺失 → 停用导入
  await t.client.request<any>("add_credential", { name: "cred-x", host: "x.example", header: "Authorization", purpose: "mcp", secret: "s3cret-source" });
  const mcp = await t.client.request<any>("mcp_configure", { project_id: a.projectId, name: "svc-x", endpoint: "https://x.example/mcp", credential: "cred-x", tool_allowlist: ["read"], enabled: true });
  store.setMetaValue(`jev.project.${a.projectId}`, JSON.stringify({ enabled: true, credential: "jev-cred", configVersion: 1 }));

  // 平台配置与入站（一律排除）
  db.prepare("INSERT INTO qq_config (id, endpoint, self_id, enabled, created_at, updated_at) VALUES (1, 'ws://qq.local', '100', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO telegram_config (id, api_base, credential_name, owner_user_id, owner_chat_id, enabled, created_at, updated_at) VALUES (1, 'https://api.telegram.org', 'tg-cred', 'u1', 'c1', 1, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO inbound_events (id, source, external_id, target_role, body, status, received_at) VALUES (?, 'qq_private', 'x1', 'main', '{}', 'done', ?)").run(randomId("evt"), NOW);

  t.client.close();
  await t.runtime.stop("test_end");
  await t.server.close();

  // 未终态任务态（后台停止后写入，模拟崩溃留下的在途状态；在线插入会被驱动器
  // 实际执行，正常停止也会把 running/awaiting 收尾为 backend_stop）：
  // queued / running（结果未登记的工具操作）/ awaiting_confirmation（待审批 +
  // 已批准未消费）；审批挡住的工具操作按「已知未执行」不标 effect_unknown
  const post = new Db(dataDir);
  const pstore = new Store(post);
  const tq = pstore.withTx(() =>
    pstore.insertQueuedTask({ sessionId: sa2.id, requestId: "q1", input: "排队任务", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  const tr = pstore.withTx(() =>
    pstore.insertQueuedTask({ sessionId: sa2.id, requestId: "r2", input: "运行中任务", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  post.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(NOW, tr.id);
  const opUnresolved = randomId("op");
  const ta = pstore.withTx(() =>
    pstore.insertQueuedTask({ sessionId: sa2.id, requestId: "a1", input: "审批中任务", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }).task,
  );
  post.prepare("UPDATE tasks SET status = 'awaiting_confirmation', started_at = ? WHERE id = ?").run(NOW, ta.id);
  const opConfirm = randomId("op");
  pstore.withTx(() => {
    pstore.recordToolIntent({ id: opUnresolved, taskId: tr.id, sessionId: sa2.id, toolName: "bash", params: { command: "ls" } });
    pstore.recordToolIntent({ id: opConfirm, taskId: ta.id, sessionId: sa2.id, toolName: "bash", params: {} });
  });
  const confPending = pstore.withTx(() =>
    pstore.createConfirmation({ taskId: ta.id, sessionId: sa2.id, toolOpId: opConfirm, toolName: "bash", params: { command: "ls" }, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 }),
  );
  const confApproved = pstore.withTx(() =>
    pstore.createConfirmation({ taskId: ta.id, sessionId: sa2.id, toolOpId: opConfirm, toolName: "bash", params: { command: "pwd" }, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 }),
  );
  post.prepare("UPDATE confirmations SET status = 'approved', responded_at = ? WHERE id = ?").run(NOW, confApproved.id);
  post.close();
  const artGoodId = artGood.id;
  return {
    srcDataDir: dataDir,
    srcAgentDir: agentDir,
    root: t.dirs.root,
    work: t.work,
    ids: {
      projA: a.projectId,
      sa1: a.sessionId,
      sa2: sa2.id,
      taskDone: tDone.id,
      taskQueued: tq.id,
      taskRunning: tr.id,
      taskAwaiting: ta.id,
      opUnresolved,
      opConfirm,
      confPending: confPending.id,
      confApproved: confApproved.id,
      projB: b.projectId,
      sb1: b.sessionId,
      sb2: sb2.id,
      mainProj: mainProj.id,
      codingProj: codingProj.id,
      codingDev: codingDev.id,
      sessMain: sessMain.id,
      sessCoding: sessCoding.id,
      sessChat: sessChat.id,
      sessQq: sessQq.id,
      wsProj: ws.id,
      wsSession: wsSession.id,
      subAgent: sub.id,
      subSession: subSession.id,
      work: wk.id,
      artGood: artGoodId,
      artMissing: artMissing.id,
      memProjectOk: m1.id ?? m1.memoryId,
      memProjectMainRef: m2.id ?? m2.memoryId,
      memPersonalUnselected: m3.id ?? m3.memoryId,
      memPersonalSelected: m4.id ?? m4.memoryId,
      grantBoth: g1.id ?? g1.grantId,
      grantCross: g2.id ?? g2.grantId,
      mcpId: mcp.id ?? mcp.serviceId,
    },
    cleanup() {
      fs.rmSync(t.dirs.root, { recursive: true, force: true });
    },
  };
}

async function bootTarget(root: string, dataDir: string, agentDir: string) {
  const server = new MockModelServer(async () => ({ kind: "text", text: "目标回答" }));
  const baseUrl = await server.start();
  await writeModelsJson({ root, dataDir, agentDir }, baseUrl);
  const runtime = await Runtime.start({
    dataDir,
    agentDir,
    socketPath: path.join(root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    productType: "ruukoto-code",
  });
  await ControlServer.start(runtime);
  const client = await connectAuthedClient(runtime);
  await client.handshake();
  return {
    runtime,
    client,
    server,
    async stop() {
      client.close();
      await runtime.stop("test_end");
      await server.close();
    },
  };
}

function allRows(db: Db, sql: string, params: unknown[] = []): any[] {
  return db.prepare(sql).all(...(params as never[])) as any[];
}

// ---------- 1. 预览完整且两侧零写入 ----------

test("预览：源 sha 不变、目标零写入、内容完整覆盖验收项", async () => {
  const src = await buildSource("li-prev");
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-li-tprev-"));
  const deps = { targetDataDir: path.join(targetRoot, "data"), targetAgentDir: path.join(targetRoot, "agent") };
  try {
    const before = hashTree(src.root);
    const preview = previewLegacyImport(deps, { from: src.srcDataDir, plan: { personal_memories: [src.ids.memPersonalSelected] } });
    assert.equal(hashTree(src.root), before, "源目录逐文件不变");
    assert.equal(fs.existsSync(deps.targetDataDir), false, "目标目录零写入（预览不创建）");

    assert.equal(preview.target.exists, false);
    assert.ok(preview.source.instance_id);
    const projectIds = preview.projects.map((p) => p.id).sort();
    assert.deepEqual(projectIds, [src.ids.projA, src.ids.projB, src.ids.codingProj, src.ids.wsProj].sort(), "含 dev 会话的项目全部纳入（含混有角色会话的 coding 项目）");
    assert.ok(preview.excluded_projects.some((p) => p.id === src.ids.mainProj), "main 项目排除");
    assert.ok(preview.excluded_sessions.some((s) => s.id === src.ids.sessMain), "main 角色会话排除");
    assert.ok(preview.excluded_sessions.some((s) => s.id === src.ids.sessCoding), "混入 dev-b 的角色会话排除");
    assert.ok(preview.excluded_sessions.some((s) => s.id === src.ids.sessQq), "QQ 群会话排除");

    const sa2 = preview.sessions.find((s) => s.id === src.ids.sa2)!;
    assert.equal(sa2.full_access_downgrade, true, "full_access 降级报告");
    assert.equal(sa2.pending_approvals, 2, "待处理审批两笔");
    assert.deepEqual(sa2.unfinished.map((u) => u.task_id).sort(), [src.ids.taskAwaiting, src.ids.taskQueued, src.ids.taskRunning].sort());
    const sa1 = preview.sessions.find((s) => s.id === src.ids.sa1)!;
    assert.equal(sa1.history, "ok", "完成任务的历史完好");
    assert.equal(sa1.session_file, "copy");
    const wsMapping = preview.sessions.find((s) => s.id === src.ids.sb2)!;
    assert.deepEqual(wsMapping.workspace, { from: src.ids.wsProj, to: src.ids.wsProj, reason: null }, "工作区映射随项目保留");
    assert.ok(preview.sessions.every((s) => s.exec_usable), "本机目录身份均可核实");

    assert.deepEqual(preview.memories.import.sort(), [src.ids.memPersonalSelected, src.ids.memProjectOk].sort());
    assert.ok(preview.memories.pending.some((m) => m.id === src.ids.memProjectMainRef && /未导入/.test(m.reason)), "引用 main 的记忆待处理");
    assert.ok(preview.memories.pending.some((m) => m.id === src.ids.memPersonalUnselected), "未选中的 personal 待处理");
    assert.deepEqual(preview.grants.import, [src.ids.grantBoth]);
    assert.deepEqual(preview.grants.cross_instance.map((g) => g.id), [src.ids.grantCross]);
    assert.deepEqual(preview.mcp, [{ project_id: src.ids.projA, name: "svc-x", disabled: true, reason: preview.mcp[0]!.reason }]);
    assert.equal(preview.mcp[0]!.disabled, true);
    assert.deepEqual(preview.jev, [{ key: `jev.project.${src.ids.projA}`, disabled: true, credential: "jev-cred" }]);
    assert.ok(preview.files.copy >= 2, "JSONL 与产物正文计入复制");
    assert.ok(preview.files.missing.some((f) => f.item.includes(src.ids.artMissing)), "正文缺失如实列出");
    assert.equal(preview.closings.canceled, 1);
    assert.equal(preview.closings.interrupted, 2);
    assert.equal(preview.closings.stale_confirmations, 2);
    assert.equal(preview.closings.effect_unknown_tasks, 1, "仅 running 任务有结果未登记的工具操作");
    assert.ok(preview.sub_agents === 1 && preview.work_delegations === 1);
    assert.ok(preview.events > 0);
    assert.ok(Array.isArray(preview.agent_dir_names) && preview.agent_dir_names.includes("models.json"), "agentDir 差异只列名称");
    assert.ok(preview.revision?.startsWith("r1."));
    assert.deepEqual(preview.plan_errors, []);
  } finally {
    src.cleanup();
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});

// ---------- 2. 门禁 ----------

test("门禁：源后台存活拒绝；源/目标产品错配拒绝", async () => {
  const live = await startTestRuntime("li-gate", async () => ({ kind: "text", text: "x" }));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-li-tgate-"));
  const deps = { targetDataDir: path.join(targetRoot, "data"), targetAgentDir: path.join(targetRoot, "agent") };
  try {
    assert.equal(
      errCode(() => previewLegacyImport(deps, { from: live.dirs.dataDir })),
      "source_active",
      "源后台存活时拒绝",
    );
    // 停止源后台（保留目录），其后按已停止源继续门禁核查
    live.client.close();
    await live.runtime.stop("test_end");
    await live.server.close();
    // 目标是 ruukoto 产品目录：拒绝
    fs.mkdirSync(deps.targetDataDir, { recursive: true });
    const tdb = new Db(deps.targetDataDir);
    new Store(tdb).setMetaValue("product.type", "ruukoto");
    tdb.close();
    assert.equal(errCode(() => previewLegacyImport(deps, { from: live.dirs.dataDir })), "product_mismatch");
    fs.rmSync(deps.targetDataDir, { recursive: true, force: true });
    // 来源是 ruukoto-code 目录：拒绝
    const devSrc = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-li-devsrc-"));
    fs.mkdirSync(path.join(devSrc, "data"), { recursive: true });
    const sdb = new Db(path.join(devSrc, "data"));
    new Store(sdb).setMetaValue("product.type", "ruukoto-code");
    sdb.close();
    const deps2 = { targetDataDir: path.join(targetRoot, "data2"), targetAgentDir: path.join(targetRoot, "agent2") };
    assert.equal(errCode(() => previewLegacyImport(deps2, { from: path.join(devSrc, "data") })), "product_mismatch");
    fs.rmSync(devSrc, { recursive: true, force: true });
    fs.rmSync(live.dirs.root, { recursive: true, force: true });
  } finally {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});

// ---------- 3/4. 应用 + 目标启动：资料逐项一致、不重放 ----------

test("应用后目标启动：历史与产物字节一致、组织映射保留、不重放收尾、可继续与失效拒绝", async () => {
  const src = await buildSource("li-apply");
  const { dirs } = await makeTestDirs("li-tapply");
  const deps = { targetDataDir: dirs.dataDir, targetAgentDir: dirs.agentDir };
  let target: Awaited<ReturnType<typeof bootTarget>>;
  try {
    // sb2 的 cwd 在本机失效（导入标记仅可查阅，继续执行由既有身份核查拒绝）
    const poison = new Db(src.srcDataDir);
    poison.prepare("UPDATE sessions SET cwd = '/no/such/dir', cwd_real = '/no/such/dir', cwd_dev = 9, cwd_ino = 9 WHERE id = ?").run(src.ids.sb2);
    poison.close();

    const plan = { personal_memories: [src.ids.memPersonalSelected] };
    const preview = previewLegacyImport(deps, { from: src.srcDataDir, plan });
    assert.equal(preview.sessions.find((s) => s.id === src.ids.sb2)!.exec_usable, false, "cwd 失效标记仅可查阅");
    const applied = applyLegacyImport(deps, {
      plan: { from: src.srcDataDir, ...plan },
      source_instance_id: preview.source.instance_id,
      revision: preview.revision!,
      request_id: "imp-test-apply1",
    });
    assert.equal(applied.replayed, false);
    // “核对备份”：备份存在且 sha256 与回执一致
    assert.ok(fs.existsSync(applied.target_backup_path));
    assert.equal(
      createHash("sha256").update(fs.readFileSync(applied.target_backup_path)).digest("hex"),
      applied.target_backup_sha256,
    );
    assert.equal((applied.event_seq_to! - applied.event_seq_from! + 1), preview.events, "事件区间与导入数量一致");

    const srcSessionFile = (name: string) => fs.readFileSync(path.join(src.srcDataDir, "sessions", name));
    target = await bootTarget(dirs.root, dirs.dataDir, dirs.agentDir);
    try {
      // 不重放：导入后目标启动模型请求为零（全部任务已终态收尾）
      const callsAtBoot = target.server.calls.length;
      assert.equal(callsAtBoot, 0, "目标启动不发起任何旧任务模型调用");

      // 历史字节逐项一致（JSONL 复制到目标 sessions/ 下同名文件）
      const store = target.runtime.store;
      const sa1 = store.getSession(src.ids.sa1)!;
      assert.ok(sa1.sessionFile?.startsWith(dirs.dataDir), "session_file 已改写为目标路径");
      const srcFiles = fs.readdirSync(path.join(src.srcDataDir, "sessions")).filter((f) => f.endsWith(`_${sa1.piSessionId}.jsonl`));
      assert.equal(srcFiles.length, 1);
      assert.deepEqual(fs.readFileSync(sa1.sessionFile!), srcSessionFile(srcFiles[0]!), "历史 JSONL 与源字节一致");
      const history = await target.client.request<any>("read_history", { session_id: src.ids.sa1 });
      assert.ok(history.entries.length > 0, "导入会话历史可查阅");

      // 产物字节一致
      let artifactBody = Buffer.alloc(0);
      for (let offset = 0; ; ) {
        const page = await target.client.request<any>("read_artifact", { task_id: src.ids.taskDone, artifact_id: src.ids.artGood, offset, length: 65536 });
        const chunk = Buffer.from(page.data ?? page, "base64");
        artifactBody = Buffer.concat([artifactBody, chunk]);
        if (chunk.length < 65536) break;
        offset += chunk.length;
      }
      assert.deepEqual(artifactBody, fs.readFileSync(path.join(src.srcDataDir, "artifacts", `${src.ids.artGood}.bin`)));

      // 任务/工具操作/审批/选择记录逐项一致（含收尾改写）
      const done = await target.client.request<any>("get_task", { task_id: src.ids.taskDone });
      assert.equal(done.task.status, "completed");
      const queued = await target.client.request<any>("get_task", { task_id: src.ids.taskQueued });
      assert.equal(queued.task.status, "canceled");
      assert.match(queued.task.errorMessage, /migration/, "排队任务以 migration 标注取消");
      const running = await target.client.request<any>("get_task", { task_id: src.ids.taskRunning });
      assert.equal(running.task.status, "interrupted");
      assert.equal(running.task.interruptReason, "migration");
      assert.equal(running.task.effectUnknown, true, "有结果未登记工具操作的运行中任务置 effect_unknown");
      assert.equal(running.toolOps.find((o: any) => o.id === src.ids.opUnresolved)?.effectUnknown, true);
      const awaiting = await target.client.request<any>("get_task", { task_id: src.ids.taskAwaiting });
      assert.equal(awaiting.task.status, "interrupted");
      assert.equal(awaiting.task.effectUnknown, false, "审批未消费的操作属已知未执行，不标 effect_unknown");
      assert.equal(awaiting.toolOps.find((o: any) => o.id === src.ids.opConfirm)?.effectUnknown, false);
      const confs = awaiting.confirmations as any[];
      assert.equal(confs.find((c) => c.id === src.ids.confPending)?.status, "stale");
      assert.equal(confs.find((c) => c.id === src.ids.confApproved)?.status, "stale", "已批准未消费也失效");
      // stale 审批无法再批准
      await assert.rejects(target.client.request("respond_confirmation", { confirmation_id: src.ids.confApproved, decision: "approve" }));
      const sels = await target.client.request<any>("list_selection_records", { task_id: src.ids.taskDone });
      assert.ok(sels.records.length > 0, "选择记录随任务导入");
      const srcSelDb = new Db(src.srcDataDir);
      const srcSelIds = new Store(srcSelDb).listSelectionRecordsByTask(src.ids.taskDone).map((r) => r.id).sort();
      srcSelDb.close();
      assert.deepEqual(sels.records.map((r: any) => r.id).sort(), srcSelIds, "选择记录逐项一致");

      // 组织映射保留；SubAgent 以关闭状态登记
      assert.equal(store.getSession(src.ids.sb2)!.workspaceProjectId, src.ids.wsProj);
      const sub = store.getSubAgent(src.ids.subAgent)!;
      assert.ok(sub.closedAt !== null && sub.closedBy === "owner", "SubAgent 以关闭状态登记");
      assert.equal(store.getSession(src.ids.subSession)?.id, src.ids.subSession);

      // 降级与凭据边界
      assert.equal(store.getSession(src.ids.sa2)!.defaultAccessMode, "confirm", "full_access 降为 confirm");
      assert.equal(fs.existsSync(path.join(dirs.agentDir, "credentials.json")), false, "目标无凭据文件");
      assert.equal(store.getSession(src.ids.sa2)!.createRequestId, null, "创建幂等键不跨实例");

      // 排除类：目标侧没有入站、调度、通知与平台配置记录
      const tdb = target.runtime.store.db;
      for (const table of ["inbound_events", "schedules", "schedule_runs", "notification_ops", "qq_config", "telegram_config", "standing_permissions"]) {
        assert.equal((tdb.prepare(`SELECT count(*) c FROM ${table}`).get() as any).c, 0, `${table} 为空`);
      }

      // 事件顺序完整：回执区间内事件按序连续，且没有目标事件混入
      const rangeEvents = allRows(tdb, "SELECT seq, task_id, session_id FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq", [applied.event_seq_from, applied.event_seq_to]);
      assert.equal(rangeEvents.length, preview.events);
      assert.deepEqual(rangeEvents.map((e) => e.seq), rangeEvents.map((_: unknown, i: number) => applied.event_seq_from! + i));
      // 事件正文原样（body/归属/时刻逐字节核对；目标分配新 seq）
      {
        const srcDb2 = new Db(src.srcDataDir);
        const importedSessionIds = preview.sessions.map((s) => s.id);
        const srcTaskIds = allRows(srcDb2, `SELECT id FROM tasks WHERE session_id IN (${importedSessionIds.map(() => "?").join(",")})`, importedSessionIds).map((r) => r.id as string);
        const srcEvents = allRows(
          srcDb2,
          `SELECT session_id, task_id, body, created_at FROM events WHERE (session_id IS NOT NULL AND session_id IN (${importedSessionIds.map(() => "?").join(",")}))
             OR (task_id IS NOT NULL AND task_id IN (${srcTaskIds.map(() => "?").join(",")})) ORDER BY seq`,
          [...importedSessionIds, ...srcTaskIds],
        );
        srcDb2.close();
        const dstEvents = allRows(tdb, "SELECT session_id, task_id, body, created_at FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq", [applied.event_seq_from, applied.event_seq_to]);
        assert.deepEqual(dstEvents, srcEvents, "事件正文与归属原样导入");
      }

      // 有效 cwd 可继续执行（使用原项目配置与导入的记忆）
      const modelCallsBefore = target.server.calls.length;
      const newTask = await submitAndWait(target.client, src.ids.sa1, "req-after-import", "导入后的新任务");
      assert.equal(newTask.status, "completed");
      assert.ok(target.server.calls.length > modelCallsBefore, "新任务实际调用模型");
      // cwd 失效会话：任务在启动时由既有目录身份核查拒绝执行（不调用模型）
      const callsBeforeInvalid = target.server.calls.length;
      await target.client.request("submit", { model_selection: MOCK_SEL, session_id: src.ids.sb2, request_id: "req-invalid-cwd", input: "x" });
      let invalidTask: any = null;
      await waitFor("失效目录任务终态", async () => {
        const found = await target.client.request<any>("find_task", { session_id: src.ids.sb2, request_id: "req-invalid-cwd" });
        invalidTask = found.task ? (await target.client.request<any>("get_task", { task_id: found.task.id })).task : null;
        return invalidTask && ["completed", "failed", "canceled", "interrupted"].includes(invalidTask.status);
      });
      assert.equal(invalidTask.status, "failed");
      assert.match(invalidTask.errorMessage, /目录/, "失效目录任务以目录核查失败收尾");
      assert.equal(target.server.calls.length, callsBeforeInvalid, "失效目录任务不调用模型");
    } finally {
      await target.stop();
    }
  } finally {
    src.cleanup();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ---------- 5. 跨实例来源边界 ----------

test("跨实例来源：记忆/授权按范围处理，凭据不迁移，选择记录证明注入规则", async () => {
  const src = await buildSource("li-scope");
  const { dirs } = await makeTestDirs("li-tscope");
  const deps = { targetDataDir: dirs.dataDir, targetAgentDir: dirs.agentDir };
  try {
    const preview = previewLegacyImport(deps, { from: src.srcDataDir, plan: { personal_memories: [src.ids.memPersonalSelected] } });
    const applied = applyLegacyImport(deps, {
      plan: { from: src.srcDataDir, personal_memories: [src.ids.memPersonalSelected] },
      source_instance_id: preview.source.instance_id,
      revision: preview.revision!,
      request_id: "imp-test-scope",
    });
    const tdb = new Db(dirs.dataDir);
    try {
      const tstore = new Store(tdb);
      assert.equal(tstore.getSession(src.ids.sessMain), null, "main 会话未导入");
      // 记忆边界
      assert.deepEqual(allRows(tdb, "SELECT id FROM memories ORDER BY id").map((r) => r.id).sort(), [src.ids.memPersonalSelected, src.ids.memProjectOk].sort());
      const pendingIds = (applied.report.memory_pending as any[]).map((m) => m.id);
      assert.ok(pendingIds.includes(src.ids.memProjectMainRef), "引用 main 的记忆列入待处理");
      assert.ok(pendingIds.includes(src.ids.memPersonalUnselected), "未选中的 personal 列入待处理");
      // 授权：跨实例只在回执，data_grants 只有双端都在导入范围的
      assert.deepEqual(allRows(tdb, "SELECT id FROM data_grants").map((r) => r.id), [src.ids.grantBoth]);
      assert.deepEqual((applied.report.grants_cross_instance as any[]).map((g) => g.id), [src.ids.grantCross]);
      // MCP 与 Jev 缺凭据 → 停用导入
      assert.equal(allRows(tdb, "SELECT enabled FROM mcp_services WHERE id = ?", [src.ids.mcpId])[0]!.enabled, 0);
      const jev = JSON.parse(tstore.getMetaValue(`jev.project.${src.ids.projA}`)!);
      assert.equal(jev.enabled, false);
      assert.equal(jev.credential, "jev-cred", "绑定名保留供重新绑定");
    } finally {
      tdb.close();
    }

    // 选择记录证明导入的记忆按来源规则注入（owner_note 对 agent 可访问）
    const target = await bootTarget(dirs.root, dirs.dataDir, dirs.agentDir);
    try {
      const newTask = await submitAndWait(target.client, src.ids.sa1, "req-memory-inject", "验证记忆注入");
      const sels = await target.client.request<any>("list_selection_records", { task_id: newTask.id });
      const last = sels.records.at(-1)!;
      assert.ok(
        (last.includedMemories as any[]).some((m) => m.memoryId === src.ids.memProjectOk),
        "范围内记忆随新任务注入",
      );
      assert.ok(
        !(last.includedMemories as any[]).some((m) => m.memoryId === src.ids.memProjectMainRef),
        "跨实例来源记忆不注入",
      );
    } finally {
      await target.stop();
    }
  } finally {
    src.cleanup();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ---------- 6. 冲突、中断续跑与回退 ----------

test("中断、续跑与回退：故障续跑无重复、同键重放、修订冲突、两批识别、回退阻挡与干净回退", async () => {
  const src = await buildSource("li-rerun");
  const { dirs } = await makeTestDirs("li-trerun");
  const deps = { targetDataDir: dirs.dataDir, targetAgentDir: dirs.agentDir };
  try {
    const sourceHashBefore = hashTree(src.root);
    const preview = previewLegacyImport(deps, { from: src.srcDataDir });
    const input = (requestId: string) => ({
      plan: { from: src.srcDataDir },
      source_instance_id: preview.source.instance_id,
      revision: preview.revision!,
      request_id: requestId,
    });

    // 文件复制后、事务前故障：同一计划重跑成功，没有重复的行或文件
    assert.throws(
      () =>
        applyLegacyImport(
          {
            ...deps,
            __testHooks: {
              afterFilesCopied: () => {
                throw new Error("注入：复制后故障");
              },
            },
          },
          input("imp-test-rerun"),
        ),
      /注入：复制后故障/,
    );
    const ok = applyLegacyImport(deps, input("imp-test-rerun"));
    assert.equal(ok.replayed, false);
    let tdb = new Db(dirs.dataDir);
    const tstore = new Store(tdb);
    assert.equal(allRows(tdb, "SELECT count(*) c FROM sessions")[0]!.c, preview.sessions.length, "续跑没有重复行");
    const sessionsDirFiles = fs.readdirSync(path.join(dirs.dataDir, "sessions"));
    assert.equal(sessionsDirFiles.filter((f) => f.endsWith(".import-tmp")).length, 0, "没有残留临时文件");
    assert.ok(sessionsDirFiles.length >= 2, "JSONL 复制到位");
    tdb.close();

    // 成功后同键重放返回原回执；同键异参报冲突
    const replay = applyLegacyImport(deps, input("imp-test-rerun"));
    assert.equal(replay.replayed, true);
    assert.equal(replay.import_id, ok.import_id);
    assert.equal(
      errCode(() =>
        applyLegacyImport(deps, {
          plan: { from: src.srcDataDir, personal_memories: [src.ids.memPersonalSelected] },
          source_instance_id: preview.source.instance_id,
          revision: preview.revision!,
          request_id: "imp-test-rerun",
        }),
      ),
      "request_conflict",
    );

    // 事务进行中、部分 SQL 已执行时注入故障：整体回滚
    const { dirs: dirs2 } = await makeTestDirs("li-trerun2");
    const deps2 = { targetDataDir: dirs2.dataDir, targetAgentDir: dirs2.agentDir };
    assert.throws(
      () =>
        applyLegacyImport(
          {
            ...deps2,
            __testHooks: {
              insideImportTx: () => {
                throw new Error("注入：事务内故障");
              },
            },
          },
          input("imp-test-rerun-tx"),
        ),
      /注入：事务内故障/,
    );
    const tdb2 = new Db(dirs2.dataDir);
    assert.equal(allRows(tdb2, "SELECT count(*) c FROM projects")[0]!.c, 0, "事务内故障整体回滚");
    assert.equal(allRows(tdb2, "SELECT count(*) c FROM instance_imports")[0]!.c, 0, "回执未登记");
    tdb2.close();

    // 干净回退：行、事件区间与经核对的文件全部移除，回执保留，源不变
    const { dirs: dirs3 } = await makeTestDirs("li-trerun3");
    const deps3 = { targetDataDir: dirs3.dataDir, targetAgentDir: dirs3.agentDir };
    const ok3 = applyLegacyImport(deps3, input("imp-test-revert-clean"));
    const reverted = revertLegacyImport(deps3, ok3.import_id);
    assert.equal(reverted.ok, true);
    assert.ok(reverted.removed.sessions! > 0 && reverted.removed.projects! > 0);
    assert.ok(reverted.removed.events! > 0, "事件区间移除");
    assert.ok(reverted.files_removed.length >= 2, "复制文件移除");
    const tdb3 = new Db(dirs3.dataDir);
    for (const table of ["projects", "sessions", "tasks", "tool_ops", "confirmations", "events", "memories", "memory_versions", "data_grants", "mcp_services", "sub_agents", "work_delegations"]) {
      assert.equal(allRows(tdb3, `SELECT count(*) c FROM ${table}`)[0]!.c, 0, `${table} 回到导入前`);
    }
    assert.equal(allRows(tdb3, "SELECT status FROM instance_imports WHERE id = ?", [ok3.import_id])[0]!.status, "reverted", "回执保留并标 reverted");
    assert.equal(allRows(tdb3, "SELECT count(*) c FROM instance_import_items")[0]!.c, 0, "账本清空");
    tdb3.close();
    assert.equal(fs.readdirSync(path.join(dirs3.dataDir, "sessions")).length, 0, "复制文件已移除");
    assert.ok(fs.existsSync(ok3.target_backup_path), "目标备份保留（整库恢复路径）");
    // 跨进程重启后仍能核实回执（新连接重开）
    const listed = listLegacyImports(deps3);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.status, "reverted");

    // 源或目标变化后报 revision_conflict（源侧新增会话）
    assert.equal(hashTree(src.root), sourceHashBefore, "前几步（导入/回退）未改动源");
    const modDb = new Db(src.srcDataDir);
    const modStore = new Store(modDb);
    const newIdent = identityOf(src.work[1]!);
    const newSession = modStore.withTx(() =>
      modStore.createSession({ projectId: src.ids.projB, cwd: newIdent.cwd, cwdReal: newIdent.cwdReal, cwdDev: newIdent.dev, cwdIno: newIdent.ino, piSessionId: randomId("pi"), confirmTools: [] }),
    );
    modDb.close();
    // 源侧新增是本次测试的故意修改；之后的导入不得再改动源
    const sourceHashAfterMod = hashTree(src.root);
    assert.equal(errCode(() => applyLegacyImport(deps, input("imp-test-stale"))), "revision_conflict");
    tdb = new Db(dirs.dataDir);
    assert.equal(
      allRows(tdb, "SELECT count(*) c FROM sessions")[0]!.c,
      preview.sessions.length,
      "revision_conflict 零写入",
    );

    // 两批导入：已导入项识别，源侧新增只导入新增部分
    const preview2 = previewLegacyImport(deps, { from: src.srcDataDir });
    assert.ok(preview2.projects.every((p) => p.decision === "already_imported"), "项目识别为已导入");
    assert.ok(preview2.source_new_since_last_import.count > 0, "源侧新增计入报告");
    const ok2 = applyLegacyImport(deps, {
      plan: { from: src.srcDataDir },
      source_instance_id: preview2.source.instance_id,
      revision: preview2.revision!,
      request_id: "imp-test-batch2",
    });
    assert.equal(ok2.counts.sessions, 1, "第二批只导入新增会话");
    assert.ok((ok2.report.skipped_already_imported as string[]).length > 0, "已导入项逐项识别");
    assert.ok(new Store(tdb).getSession(newSession.id));

    // 有导入后活动时拒绝回退并列出阻挡项
    const tstore2 = new Store(tdb);
    tstore2.withTx(() =>
      tstore2.insertQueuedTask({ sessionId: src.ids.sa1, requestId: "post-import-task", input: "导入后的任务", resumesTaskId: null, modelSelection: MOCK_SEL, submissionDigest: randomId("d") }),
    );
    const blocked = revertLegacyImport(deps, ok.import_id);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, "applied", "回退被挡时响应与回执状态一致");
    assert.ok(blocked.blockers!.some((b) => /新任务|新事件/.test(b)), `阻挡项逐项列出：${blocked.blockers}`);
    assert.equal(allRows(tdb, "SELECT status FROM instance_imports WHERE id = ?", [ok.import_id])[0]!.status, "applied", "拒绝后状态不变");
    tdb.close();

    // 源目录在故意修改之后的整个流程中仍逐文件不变
    assert.equal(hashTree(src.root), sourceHashAfterMod, "任何路径都不修改源资料");
    fs.rmSync(dirs2.root, { recursive: true, force: true });
    fs.rmSync(dirs3.root, { recursive: true, force: true });
  } finally {
    src.cleanup();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ---------- 7. v20 旧库：快照迁移只在副本上 ----------

test("v20 旧库：快照迁移只在副本上执行，源 sha 不变，导入成功", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-li-v20-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-li-tv20-"));
  const dirs = { root: tRoot, dataDir: path.join(tRoot, "data"), agentDir: path.join(tRoot, "agent") };
  try {
    const db = new Db(dataDir);
    const store = new Store(db);
    const project = store.withTx(() => store.createProject("旧v20项目"));
    const session = store.withTx(() =>
      store.createSession({
        projectId: project.id,
        cwd: dataDir,
        cwdReal: fs.realpathSync(dataDir),
        cwdDev: 1,
        cwdIno: 1,
        piSessionId: "pi-v20",
        sessionFile: path.join(dataDir, "sessions", "s_pi-v20.jsonl"),
        confirmTools: [],
      }),
    );
    fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
    fs.writeFileSync(session.sessionFile!, `${JSON.stringify({ type: "message", role: "user", content: "旧内容" })}\n`);
    // 回到 v20：去掉组织归属列并回退版本号（沿用 test/76 的做法）
    db.exec("ALTER TABLE sessions DROP COLUMN workspace_project_id");
    db.exec("UPDATE meta SET value = '20' WHERE key = 'schema_version'");
    db.close();
    const before = hashTree(root);

    const deps = { targetDataDir: dirs.dataDir, targetAgentDir: dirs.agentDir };
    const preview = previewLegacyImport(deps, { from: dataDir });
    assert.equal(preview.source.schema_version_original, 20, "记录原始版本");
    assert.equal(preview.source.schema_version_current, SCHEMA_VERSION);
    assert.equal(preview.sessions.length, 1);
    assert.equal(preview.sessions[0]!.history, "ok");
    const applied = applyLegacyImport(deps, {
      plan: { from: dataDir },
      source_instance_id: preview.source.instance_id,
      revision: preview.revision!,
      request_id: "imp-test-v20",
    });
    assert.equal(applied.counts.sessions, 1);
    assert.equal(hashTree(root), before, "旧库只在快照上迁移，源逐文件不变");
    const tdb = new Db(dirs.dataDir);
    const tstore = new Store(tdb);
    const imported = tstore.getSession(session.id)!;
    assert.equal(imported.workspaceProjectId, null, "v20 行迁来后组织归属为 NULL");
    assert.deepEqual(fs.readFileSync(imported.sessionFile!), fs.readFileSync(path.join(dataDir, "sessions", "s_pi-v20.jsonl")), "历史字节一致");
    tdb.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

// ---------- 8. CLI：真实 bin 入口与产品分流 ----------

test("CLI：preview/apply/list/revert 全流程与 ruukoto 侧分流", async () => {
  const src = await buildSource("li-cli");
  const { dirs } = await makeTestDirs("li-tcli");
  const personal = await makeTestDirs("li-tcli-personal");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    RUUKOTO_CODE_DATA_DIR: dirs.dataDir,
    RUUKOTO_CODE_AGENT_DIR: dirs.agentDir,
    RUUKOTO_DATA_DIR: personal.dirs.dataDir,
    RUUKOTO_AGENT_DIR: personal.dirs.agentDir,
  };
  const run = (bin: string, args: string[]) =>
    spawnSync(process.execPath, [path.join(repoRoot, "bin", bin), ...args], {
      env,
      cwd: repoRoot,
      timeout: 180_000,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  try {
    const sourceHashBefore = hashTree(src.root);
    // issue 22 起两产品都提供 legacy-import 并按产品分流：ruukoto 侧为个人方向；
    // 环境变量指向独立临时目录，不触碰真实档案
    const gate = run("ruukoto.mjs", ["legacy-import", "list"]);
    assert.equal(gate.status, 0, `ruukoto 侧分流到个人方向（list 空目标）：${gate.stderr}`);
    assert.deepEqual(JSON.parse(gate.stdout), [], "ruukoto 侧空目标无导入回执");

    const planFile = path.join(dirs.root, "plan.json");
    const preview = run("ruukoto-code.mjs", ["legacy-import", "preview", "--from", src.srcDataDir, "--plan", planFile]);
    assert.equal(preview.status, 0, preview.stderr);
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    assert.ok(typeof plan.source_instance_id === "string" && plan.source_instance_id.length > 0);
    assert.ok(typeof plan.revision === "string" && plan.revision.startsWith("r1."));
    assert.equal(fs.existsSync(path.join(dirs.dataDir, "ruukoto.db")), false, "预览对目标零写入");

    const applied = run("ruukoto-code.mjs", ["legacy-import", "apply", "--plan", planFile]);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedJson = JSON.parse(applied.stdout);
    assert.equal(appliedJson.replayed, false);
    assert.ok(appliedJson.import_id);
    const replay = run("ruukoto-code.mjs", ["legacy-import", "apply", "--plan", planFile]);
    assert.equal(replay.status, 0);
    assert.equal(JSON.parse(replay.stdout).replayed, true, "同一计划文件重放返回回执");

    const list = run("ruukoto-code.mjs", ["legacy-import", "list"]);
    assert.equal(list.status, 0);
    const items = JSON.parse(list.stdout);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "applied");
    assert.ok(items[0].item_count > 0);

    const reverted = run("ruukoto-code.mjs", ["legacy-import", "revert", appliedJson.import_id]);
    assert.equal(reverted.status, 0, reverted.stderr);
    assert.equal(JSON.parse(reverted.stdout).ok, true);
    const listedAfter = run("ruukoto-code.mjs", ["legacy-import", "list"]);
    assert.equal(JSON.parse(listedAfter.stdout)[0].status, "reverted");
    assert.equal(hashTree(src.root), sourceHashBefore, "CLI 全流程后源目录不变");
  } finally {
    src.cleanup();
    fs.rmSync(dirs.root, { recursive: true, force: true });
    fs.rmSync(personal.dirs.root, { recursive: true, force: true });
  }
});
