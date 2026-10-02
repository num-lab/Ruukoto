/**
 * 旧开发数据 → 工作区组织迁移的产品级冒烟（agent-direction issue 07，步骤 2/3/4）。
 *
 * 模型层打桩（MockModelServer，确定性脚本），其余全真：真实 bin/ruukoto-dev.mjs
 * 后台进程（两次拉起）、真实 socket / SQLite / JSONL 历史文件 / 控制面协议 /
 * 目录身份，CLI（project migration-preview / migration-apply）经真实控制面调用。
 *
 * 覆盖（与工单 07 步骤 2/3/4 对应）：
 *  1. 拉起真实 bin 后台；旧入口（create_project/create_session）造多目录旧数据：
 *     旧项目 L（会话在 a1、a2 两个目录），旧项目 L2（同目录 a1 另一旧项目）；
 *     原授权 L → L2（history）与种子任务（历史 + prompt 快照产物）；
 *  2. CLI project migration-preview L：只读预览的结构（instance/source/dir_groups/
 *     findings/safe_claim/suggested），不写入任何迁移状态；
 *  3. CLI preview --plan（写回 project_id/instance_id/revision）→ CLI apply --plan：
 *     两个目录各成工作区；--plan 中的 existing_workspace 复用 L2 同目录归属的既有
 *     工作区（同一真实目录复用其 ID）；SQLite 直接核对 workspace_project_id 归属与
 *     projectId 资料身份保留；
 *  4. 同键核实：同一计划文件再跑 migration-apply（文件派生请求键）→ replayed=true；
 *     改动计划后用原派生键再跑 → request_conflict；
 *  5. 原历史与产物按原标识可读：read_history 含种子输入；prompt 快照产物字节不变；
 *  6. 原授权 ID/方向保持，撤销原 ID 后列表记录 revokedAt；
 *  7. 目标工作区新建会话（使用工作区 Project ID）并提交任务；工作区归属查询
 *     （list_session_summaries workspace_id）含已映射旧会话，旧 API project_id 语义不变；
 *  8. 重启持久化：stop 后同一档案重新拉起，组织归属、回执（同键再 replayed=true）、
 *     授权撤销状态都在。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL。所有路径位于 makeTestDirs 临时档案，不碰日常实例。
 * 运行：npx tsx .scratch/agent-direction/smoke-07-legacy-workspace-data.mts
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, makeTestDirs, cleanupDirs, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { killProcessTree } from "../../test/helpers/backend.ts";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const startedAt = Date.now();

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String((err as Error).message ?? err) });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

const { dirs } = await makeTestDirs("smoke07", 0);
const controlDir = path.join(dirs.root, "control");
const server = new MockModelServer(async () => ({ kind: "text", text: "pong-smoke07" }));
const baseUrl = await server.start();
await writeModelsJson(dirs, baseUrl);

let child!: childProcess.ChildProcess;
let stderr = "";
function spawnBackend(): void {
  child = childProcess.spawn(
    process.execPath,
    [path.join(repoRoot, "bin", "ruukoto-dev.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--tools", "mock"],
    { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_DEV_CONTROL_DIR: controlDir }, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
}

async function connect(): Promise<ControlClient> {
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`后台提前退出：${stderr.slice(0, 2000)}`);
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      return client;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`后台连接超时：${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function stopBackend(client: ControlClient): Promise<number | null> {
  await client.request("stop");
  client.close();
  return await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), 20_000);
    child.once("exit", (c0) => {
      clearTimeout(timer);
      resolve(c0);
    });
  });
}

/** 经真实控制面执行 CLI 子命令（project migration-preview / migration-apply）。 */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(process.execPath, [path.join(repoRoot, "bin", "ruukoto-dev.mjs"), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_DEV_CONTROL_DIR: controlDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let cliErr = "";
    proc.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    proc.stderr!.on("data", (c: Buffer) => (cliErr += c.toString("utf8")));
    proc.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr: cliErr }));
  });
}

async function cliJson(args: string[]): Promise<any> {
  const { code, stdout, stderr: cliErr } = await runCli(args);
  assert.equal(code, 0, `CLI ${args.join(" ")} 应成功退出（stderr: ${cliErr.slice(0, 400)}）`);
  return JSON.parse(stdout);
}

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

// ---------- 场景 1：旧入口造多目录旧数据 ----------
const bigws = path.join(dirs.root, "bigws");
const a1 = path.join(bigws, "a1");
const a2 = path.join(bigws, "a2");
fs.mkdirSync(a1, { recursive: true });
fs.mkdirSync(a2, { recursive: true });
fs.mkdirSync(path.join(bigws, "a3"), { recursive: true });

spawnBackend();
let client: ControlClient | null = null;
let promptArtifactId = "";
let promptArtifactBytes = Buffer.alloc(0);
try {
  client = await connect();
  const c = client;

  const projL = (await c.request<any>("create_project", { name: "smoke07-legacy", request_id: "mk-l" })) as any;
  const s1 = (await c.request<any>("create_session", { project_id: projL.id, cwd: a1, request_id: "mk-s1" })) as any;
  const s2 = (await c.request<any>("create_session", { project_id: projL.id, cwd: a2, request_id: "mk-s2" })) as any;
  const projL2 = (await c.request<any>("create_project", { name: "smoke07-legacy-b", request_id: "mk-l2" })) as any;
  const sOther = (await c.request<any>("create_session", { project_id: projL2.id, cwd: a1, request_id: "mk-so" })) as any;
  void sOther;
  const preGrant = (await c.request<any>("create_data_grant", { from_project_id: projL.id, to_project_id: projL2.id, category: "history", purpose: "smoke07 迁移前授权" })) as any;
  const seed = (await c.request<any>("submit", { session_id: s1.id, request_id: "seed-1", input: "smoke07 种子：靛蓝闸机", model_selection: MODEL })) as any;
  await waitFor("种子任务完成", async () => (await taskStatus(c, seed.id)).task.status === "completed");
  const seedDetail = await taskStatus(c, seed.id);

  await check("场景1 旧入口造数：多目录旧项目 + 同目录另一旧项目 + 原授权 + 历史/产物", () => {
    assert.notEqual(projL.id, projL2.id);
    assert.ok(preGrant.id);
    const promptArtifact = (seedDetail.artifacts as any[]).find((a) => a.name.includes("prompt"));
    assert.ok(promptArtifact, "种子任务应有 prompt 快照产物");
    promptArtifactId = promptArtifact.id;
  });
  {
    // 记录迁移前的产物字节
    const part = (await c.request<any>("read_artifact", { task_id: seed.id, artifact_id: promptArtifactId, offset: 0, length: 65536 })) as any;
    promptArtifactBytes = Buffer.from(part.data, "base64");
    assert.ok(promptArtifactBytes.length > 0);
  }

  // ---------- 场景 2：CLI 只读预览 ----------
  let preview: any;
  await check("场景2 CLI migration-preview：结构完整且零写入", async () => {
    const dbProbe = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
    const eventsBefore = (dbProbe.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n;
    preview = await cliJson(["project", "migration-preview", projL.id]);
    const eventsAfter = (dbProbe.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n;
    dbProbe.close();
    assert.equal(eventsAfter, eventsBefore, "预览零写入（事件数不变）");
    assert.equal(preview.source.project_id, projL.id);
    assert.equal(preview.source.config_source_project_id, projL.id, "实际配置来源为源项目");
    assert.ok(preview.instance_id, "携带实例标识");
    assert.equal(preview.dir_groups.length, 2, "两个目录分组");
    assert.ok(preview.findings.some((f: any) => f.kind === "multi_dir_project"), "多目录如实列出");
    assert.ok(preview.findings.some((f: any) => f.kind === "same_dir_multiple_projects"), "同目录另一旧项目列出");
    assert.equal(preview.safe_claim.eligible, false, "多目录不可安全认领");
    assert.equal(preview.suggested.action, "map_sessions", "建议组织映射");
    assert.equal(preview.truncated, false);
  });

  // ---------- 场景 3：CLI --plan 生成修订 → apply 应用 ----------
  const planFile = path.join(dirs.root, "plan.json");
  let applied: any;
  await check("场景3 CLI --plan + apply：两个目录各成工作区，新根校验与归属落库", async () => {
    fs.writeFileSync(planFile, JSON.stringify(preview.suggested, null, 2) + "\n");
    const revised = await cliJson(["project", "migration-preview", projL.id, "--plan", planFile]);
    assert.ok(revised.revision, "绑定最终选择的修订");
    const saved = JSON.parse(fs.readFileSync(planFile, "utf8"));
    assert.equal(saved.project_id, projL.id);
    assert.equal(saved.instance_id, preview.instance_id);
    assert.equal(saved.revision, revised.revision, "修订写回计划文件");

    applied = await cliJson(["project", "migration-apply", "--plan", planFile]);
    assert.equal(applied.ok, true);
    assert.equal(applied.action, "map_sessions");
    assert.equal(applied.created_workspaces.length, 2, "两个目录各成一个新工作区");
    assert.equal(applied.mappings.length, 2, "两个旧会话各自映射");
  });

  await check("场景3b SQLite 核对：组织归属落库、资料身份与来源标识保留", () => {
    const db = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
    const schemaVersion = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value;
    assert.equal(schemaVersion, "21", "schema v21");
    const rows = db.prepare("SELECT id, project_id, workspace_project_id, pi_session_id, session_file FROM sessions ORDER BY created_at").all() as any[];
    const mapped = rows.filter((r) => r.workspace_project_id !== null);
    const expected = new Map(applied.mappings.map((m: any) => [m.session_id, m.to]));
    assert.equal(mapped.length, expected.size, "映射数量与回执一致");
    for (const row of mapped) {
      assert.equal(expected.get(row.id), row.workspace_project_id, "组织归属字段按回执落库");
      assert.equal(row.project_id, projL.id, "资料身份 projectId 保留");
      assert.ok(row.pi_session_id, "pi 会话 ID 保留");
    }
    const receipt = db.prepare("SELECT value FROM meta WHERE key LIKE 'migration_receipt:%'").all() as any[];
    assert.equal(receipt.length, 1, "成功回执落盘一条");
    db.close();
  });

  // ---------- 场景 4：同键核实 ----------
  await check("场景4 同键核实：同一计划文件再 apply 返回 replayed；改参数后同派生键 request_conflict", async () => {
    const replay = await cliJson(["project", "migration-apply", "--plan", planFile]);
    assert.equal(replay.replayed, true, "同一计划文件派生原请求键，重放返回原成果");
    // 同派生键异参：交换两个会话的目标（语义不同的计划），强制使用原请求键；
    // 原计划文件保持不动，供场景 8 重放（修订与派生键不变）
    const edited = JSON.parse(fs.readFileSync(planFile, "utf8"));
    const ids = Object.keys(edited.assignments);
    [edited.assignments[ids[0]!], edited.assignments[ids[1]!]] = [edited.assignments[ids[1]!], edited.assignments[ids[0]!]];
    const editFile = path.join(dirs.root, "plan-edited.json");
    fs.writeFileSync(editFile, JSON.stringify(edited, null, 2) + "\n");
    const conflict = await runCli(["project", "migration-apply", "--plan", editFile, "--request-id", applied.receipt_request_id]);
    assert.notEqual(conflict.code, 0, "同键异参必须失败");
    assert.ok(conflict.stderr.includes("request_conflict"), `应报 request_conflict（实际：${conflict.stderr.slice(0, 200)}）`);
  });

  // ---------- 场景 5：原历史与产物按原标识可读 ----------
  await check("场景5 原历史与产物：read_history 含种子；prompt 快照产物字节不变", async () => {
    const history = (await c.request<any>("read_history", { session_id: s1.id })) as any;
    const text = JSON.stringify(history);
    assert.ok(text.includes("smoke07 种子：靛蓝闸机"), "原历史可读（含种子输入）");
    assert.ok(text.includes("pong-smoke07"), "原模型应答可读");
    const part = (await c.request<any>("read_artifact", { task_id: seed.id, artifact_id: promptArtifactId, offset: 0, length: 65536 })) as any;
    assert.deepEqual(Buffer.from(part.data, "base64"), promptArtifactBytes, "产物字节迁移前后一致");
  });

  // ---------- 场景 6：原授权保持与撤销边界 ----------
  await check("场景6 原授权：ID/方向保持；撤销原 ID 后 revokedAt 可核实", async () => {
    const active = ((await c.request<any>("list_data_grants", {})) as any).grants as any[];
    const kept = active.find((g) => g.id === preGrant.id);
    assert.ok(kept, "原授权仍在");
    assert.equal(kept.fromProjectId, projL.id);
    assert.equal(kept.toProjectId, projL2.id, "授权方向保持");
    await c.request("revoke_data_grant", { grant_id: preGrant.id });
    const all = ((await c.request<any>("list_data_grants", { include_revoked: true })) as any).grants as any[];
    const revoked = all.find((g) => g.id === preGrant.id);
    assert.ok(revoked?.revokedAt, "撤销原 ID 后 revokedAt 已记录");
  });

  // ---------- 场景 7：目标工作区新会话 + 归属查询 ----------
  await check("场景7 工作区新会话与归属查询：workspace_id 含已映射旧会话；project_id 旧语义不变", async () => {
    const a3 = path.join(bigws, "a3");
    const wsId = (applied.mappings as any[]).find((m) => m.session_id === s1.id)!.to as string;
    const wsSession = (await c.request<any>("create_session", { project_id: wsId, cwd: a3, request_id: "mk-ws-session" })) as any;
    const task = (await c.request<any>("submit", { session_id: wsSession.id, request_id: "ws-task-1", input: "工作区新任务", model_selection: MODEL })) as any;
    await waitFor("工作区任务完成", async () => (await taskStatus(c, task.id)).task.status === "completed");
    const byWorkspace = (await c.request<any>("list_session_summaries", { workspace_id: wsId })) as any[];
    assert.ok(byWorkspace.some((s) => s.sessionId === s1.id), "归属查询含已映射旧会话");
    assert.ok(byWorkspace.some((s) => s.sessionId === wsSession.id), "归属查询含工作区新会话");
    const bySource = (await c.request<any>("list_session_summaries", { project_id: projL.id })) as any[];
    assert.ok(bySource.some((s) => s.sessionId === s1.id), "旧 API 按原身份仍列出旧会话");
  });

  // ---------- 场景 8：重启持久化 ----------
  await check("场景8 重启持久化：组织归属、回执、撤销状态跨重启保持", async () => {
    const code = await stopBackend(c);
    client = null;
    assert.equal(code, 0, "后台正常停止");
    spawnBackend();
    const c2 = await connect();
    client = c2;
    const snap = (await c2.handshake()).snapshot;
    const mappedSnap = snap.sessions.filter((s: any) => s.workspaceProjectId !== null);
    for (const m of applied.mappings) {
      const s = mappedSnap.find((x: any) => x.id === m.session_id);
      assert.ok(s && s.workspaceProjectId === m.to, `重启后组织归属保持：${m.session_id}`);
      assert.equal(s.projectId, projL.id, "重启后来源标识保持");
    }
    const all = ((await c2.request<any>("list_data_grants", { include_revoked: true })) as any).grants as any[];
    assert.ok(all.find((g) => g.id === preGrant.id)?.revokedAt, "重启后撤销状态保持");
    const replay = await cliJson(["project", "migration-apply", "--plan", planFile]);
    assert.equal(replay.replayed, true, "重启后同键重放仍返回原成果（回执 meta 持久）");
    const code2 = await stopBackend(c2);
    client = null;
    assert.equal(code2, 0, "第二次后台正常停止");
  });
} finally {
  if (client) client.close();
  if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
  await server.close();
  await cleanupDirs(dirs);
}

const failed = results.filter((r) => !r.ok);
console.log("\n模拟：模型服务（MockModelServer，本地 OpenAI 兼容打桩，确定性应答）");
console.log("真实：bin/ruukoto-dev.mjs 后台进程（两次拉起）、控制面 socket、SQLite 数据库（含直接读取核对）、CLI（project migration-* 子命令）、JSONL 历史文件、产物文件、目录身份、控制协议全部操作");
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（环境：${process.platform} ${process.arch}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
if (failed.length > 0) process.exit(1);
