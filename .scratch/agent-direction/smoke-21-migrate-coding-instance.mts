/**
 * 旧开发资料迁入 Coding Agent 的产品级冒烟（agent-direction issue 21，ADR 0022）。
 *
 * 模型层打桩（MockModelServer，确定性脚本），其余全真：真实 bin/ruukoto.mjs 与
 * bin/ruukoto-code.mjs 后台进程、控制面 socket、SQLite、JSONL 历史文件、产物
 * 文件、实例锁与离线 legacy-import CLI（预览/应用/回退/列表）。
 *
 * 覆盖（与工单 21 验收对应的产品级流程）：
 *  1. 真实 bin/ruukoto.mjs 造源：dev 项目 + 会话 + 种子任务（历史 + prompt 快照
 *     产物）+ 双端授权；停止后台；
 *  2. CLI legacy-import preview --from --plan：目标（尚不存在的 ruukoto-code 档案）
 *     零写入，计划文件写回 source_instance_id 与 revision；源后台已停止可通过探测；
 *  3. CLI apply --plan：回执返回 import_id 与备份 sha256；同一计划文件再 apply
 *     返回 replayed；list 显示 applied；
 *  4. 启动 bin/ruukoto-code.mjs 目标后台：read_history 含种子输入、pong；prompt
 *     快照产物字节与源一致；授权 ID/方向保留；注入新任务实际完成；
 *  5. 重启持久化：第二次拉起目标后台，回执仍在（list），历史仍可读；
 *  6. CLI revert：行与复制文件移除，list 显示 reverted；源目录在整个流程前后
 *     逐文件 sha256 不变。
 *
 * 结果约定：0 = 全部通过；1 = 有 FAIL。所有路径位于临时档案，不碰日常实例。
 * 运行：npx tsx .scratch/agent-direction/smoke-21-migrate-coding-instance.mts
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, cleanupDirs, makeTestDirs, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
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

function hashTree(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
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

const { dirs: srcDirs } = await makeTestDirs("smoke21-src", 1);
const srcControl = path.join(srcDirs.root, "control");
const { dirs: dstDirs } = await makeTestDirs("smoke21-dst", 0);
const dstControl = path.join(dstDirs.root, "control");
const server = new MockModelServer(async () => ({ kind: "text", text: "pong-smoke21" }));
const baseUrl = await server.start();
await writeModelsJson(srcDirs, baseUrl);
await writeModelsJson(dstDirs, baseUrl);

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

interface Backend {
  child: childProcess.ChildProcess;
  stderr: () => string;
}
function spawnBackend(bin: string, dataDir: string, agentDir: string, controlDir: string, controlEnv: string): Backend {
  const captured: string[] = [];
  const child = childProcess.spawn(process.execPath, [path.join(repoRoot, "bin", bin), "server", "--data-dir", dataDir, "--agent-dir", agentDir, "--tools", "mock"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, [controlEnv]: controlDir },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr!.on("data", (c: Buffer) => captured.push(c.toString("utf8")));
  return { child, stderr: () => captured.join("") };
}

async function connect(child: childProcess.ChildProcess, controlDir: string, stderr: () => string): Promise<ControlClient> {
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`后台提前退出：${stderr().slice(0, 2000)}`);
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

async function stopBackend(client: ControlClient, backend: Backend): Promise<number | null> {
  await client.request("stop");
  client.close();
  return await new Promise<number | null>((resolve) => {
    if (backend.child.exitCode !== null) return resolve(backend.child.exitCode);
    const timer = setTimeout(() => resolve(null), 20_000);
    backend.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function runCli(args: string[], over?: { dataDir: string; agentDir: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  const t = over ?? dstDirs;
  return new Promise((resolve) => {
    const proc = childProcess.spawn(process.execPath, [path.join(repoRoot, "bin", "ruukoto-code.mjs"), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CODE_DATA_DIR: t.dataDir, RUUKOTO_CODE_AGENT_DIR: t.agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    proc.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function cliJson(args: string[], over?: { dataDir: string; agentDir: string }): Promise<any> {
  const { code, stdout, stderr } = await runCli(args, over);
  assert.equal(code, 0, `CLI ${args.join(" ")} 应成功退出（stderr: ${stderr.slice(0, 600)}）`);
  return JSON.parse(stdout);
}

// ---------- 场景 1：真实 bin/ruukoto.mjs 造源 ----------
const ws = path.join(srcDirs.root, "ws");
fs.mkdirSync(ws, { recursive: true });
let srcBackend = spawnBackend("ruukoto.mjs", srcDirs.dataDir, srcDirs.agentDir, srcControl, "RUUKOTO_CONTROL_DIR");
let promptArtifactId = "";
let promptArtifactBytes = Buffer.alloc(0);
let projL: any, projL2: any, s1: any, seed: any, grant: any;
try {
  const c = await connect(srcBackend.child, srcControl, srcBackend.stderr);
  projL = (await c.request<any>("create_project", { name: "smoke21-dev-a", request_id: "mk-l" })) as any;
  projL2 = (await c.request<any>("create_project", { name: "smoke21-dev-b", request_id: "mk-l2" })) as any;
  s1 = (await c.request<any>("create_session", { project_id: projL.id, cwd: ws, request_id: "mk-s1" })) as any;
  // projL2 至少一个普通 dev 会话才会随导入（导入单位 = 有 dev 会话的项目）
  await c.request<any>("create_session", { project_id: projL2.id, cwd: ws, request_id: "mk-s2" });
  grant = (await c.request<any>("create_data_grant", { from_project_id: projL2.id, to_project_id: projL.id, category: "history", purpose: "smoke21 授权" })) as any;
  seed = (await c.request<any>("submit", { session_id: s1.id, request_id: "seed-1", input: "smoke21 种子：琥珀扳手", model_selection: MODEL })) as any;
  await waitFor("种子任务完成", async () => (await taskStatus(c, seed.id)).task.status === "completed");
  const seedDetail = await taskStatus(c, seed.id);
  const promptArtifact = (seedDetail.artifacts as any[]).find((a) => a.name.includes("prompt"));
  assert.ok(promptArtifact, "种子任务应有 prompt 快照产物");
  promptArtifactId = promptArtifact.id;
  const part = (await c.request<any>("read_artifact", { task_id: seed.id, artifact_id: promptArtifactId, offset: 0, length: 65536 })) as any;
  promptArtifactBytes = Buffer.from(part.data, "base64");
  await check("场景1 bin/ruukoto.mjs 造源：dev 项目 + 历史 + prompt 产物 + 授权", () => {
    assert.ok(projL.id && s1.id && seed.id && grant.id);
    assert.ok(promptArtifactBytes.length > 0);
  });
  const code = await stopBackend(c, srcBackend);
  assert.equal(code, 0, "源后台正常停止");
} catch (err) {
  results.push({ name: "场景1 源后台", ok: false, detail: String((err as Error).message) });
  console.log(`FAIL 场景1 源后台: ${(err as Error).message}`);
  killProcessTree(srcBackend.child);
  await server.close();
  await cleanupDirs(srcDirs);
  await cleanupDirs(dstDirs);
  process.exit(1);
}
const sourceHashAfterStop = hashTree(srcDirs.root);

// ---------- 场景 2：CLI preview（目标零写入；源已停止可通过探测） ----------
const planFile = path.join(dstDirs.root, "import-plan.json");
let preview: any;
await check("场景2 legacy-import preview --from --plan：目标零写入、绑定修订写回计划文件", async () => {
  preview = await cliJson(["legacy-import", "preview", "--from", srcDirs.dataDir, "--plan", planFile]);
  assert.equal(fs.existsSync(path.join(dstDirs.dataDir, "ruukoto.db")), false, "预览不创建目标库");
  assert.equal(fs.existsSync(path.join(dstDirs.dataDir, "sessions")), false, "预览不创建目标 sessions 目录");
  assert.equal(preview.projects.length, 2, "两个 dev 项目纳入");
  assert.equal(preview.plan_errors.length, 0);
  assert.ok(preview.revision?.startsWith("r1."));
  const saved = JSON.parse(fs.readFileSync(planFile, "utf8"));
  assert.equal(saved.source_instance_id, preview.source.instance_id);
  assert.equal(saved.revision, preview.revision);
  assert.equal(saved.from, srcDirs.dataDir);
});

// ---------- 场景 3：CLI apply / 重放 / list ----------
let applied: any;
await check("场景3 legacy-import apply：回执与备份；同文件重放 replayed；list 显示 applied", async () => {
  applied = await cliJson(["legacy-import", "apply", "--plan", planFile]);
  assert.equal(applied.replayed, false);
  assert.ok(applied.import_id);
  assert.ok(fs.existsSync(applied.target_backup_path), "目标备份存在");
  assert.ok((applied.event_seq_to ?? 0) >= (applied.event_seq_from ?? 1));
  const replay = await cliJson(["legacy-import", "apply", "--plan", planFile]);
  assert.equal(replay.replayed, true, "同一计划文件重放返回回执");
  const list = await cliJson(["legacy-import", "list"]);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "applied");
  assert.ok(list[0].item_count > 0);
});

// ---------- 场景 4：启动目标后台：历史与产物可读、授权保留、新任务完成 ----------
await check("场景4 bin/ruukoto-code.mjs 目标后台：历史可读、产物字节一致、授权保留、新任务完成", async () => {
  const dstBackend = spawnBackend("ruukoto-code.mjs", dstDirs.dataDir, dstDirs.agentDir, dstControl, "RUUKOTO_CODE_CONTROL_DIR");
  try {
    const c = await connect(dstBackend.child, dstControl, dstBackend.stderr);
    const history = (await c.request<any>("read_history", { session_id: s1.id })) as any;
    const text = JSON.stringify(history);
    assert.ok(text.includes("smoke21 种子：琥珀扳手"), "导入会话历史可读");
    assert.ok(text.includes("pong-smoke21"), "原模型应答可读");
    const part = (await c.request<any>("read_artifact", { task_id: seed.id, artifact_id: promptArtifactId, offset: 0, length: 65536 })) as any;
    assert.deepEqual(Buffer.from(part.data, "base64"), promptArtifactBytes, "prompt 快照产物字节一致");
    const active = ((await c.request<any>("list_data_grants", {})) as any).grants as any[];
    const kept = active.find((g) => g.id === grant.id);
    assert.ok(kept && kept.fromProjectId === projL2.id && kept.toProjectId === projL.id, "授权 ID 与方向保留");
    const task = (await c.request<any>("submit", { session_id: s1.id, request_id: "after-import-1", input: "迁入后的新任务", model_selection: MODEL })) as any;
    await waitFor("迁入后新任务完成", async () => (await taskStatus(c, task.id)).task.status === "completed");
    const code = await stopBackend(c, dstBackend);
    assert.equal(code, 0, "目标后台正常停止");
  } catch (err) {
    killProcessTree(dstBackend.child);
    throw err;
  }
});

// ---------- 场景 5：重启持久化 ----------
await check("场景5 目标重启持久化：回执（list 需后台停止）与历史跨重启可读", async () => {
  const list = await cliJson(["legacy-import", "list"]);
  assert.equal(list[0].status, "applied", "回执跨进程保持");
  const dstBackend = spawnBackend("ruukoto-code.mjs", dstDirs.dataDir, dstDirs.agentDir, dstControl, "RUUKOTO_CODE_CONTROL_DIR");
  try {
    const c = await connect(dstBackend.child, dstControl, dstBackend.stderr);
    const history = (await c.request<any>("read_history", { session_id: s1.id })) as any;
    assert.ok(JSON.stringify(history).includes("smoke21 种子：琥珀扳手"), "重启后历史仍可读");
    const code = await stopBackend(c, dstBackend);
    assert.equal(code, 0, "目标第二次正常停止");
  } catch (err) {
    killProcessTree(dstBackend.child);
    throw err;
  }
});

// ---------- 场景 6：revert 阻挡与干净回退；源哈希不变 ----------
await check("场景6a 导入后自有活动阻挡回退：blockers 逐项列出、回执保持 applied", async () => {
  const rv = await runCli(["legacy-import", "revert", applied.import_id]);
  assert.equal(rv.code, 1, "有导入后活动（场景4 的新任务）时拒绝回退");
  const parsed = JSON.parse(rv.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.blockers.some((b: string) => /新任务|新事件/.test(b)), `阻挡项：${parsed.blockers}`);
  const list = await cliJson(["legacy-import", "list"]);
  assert.equal(list[0].status, "applied", "拒绝后回执不变");
});

await check("场景6b 干净回退（第二目标档）：行与复制文件移除、回执 reverted、源逐文件不变", async () => {
  const { dirs: dst2 } = await makeTestDirs("smoke21-dst2", 0);
  try {
    const plan2 = path.join(dst2.root, "import-plan.json");
    await cliJson(["legacy-import", "preview", "--from", srcDirs.dataDir, "--plan", plan2], dst2);
    const applied2 = await cliJson(["legacy-import", "apply", "--plan", plan2], dst2);
    const rv = await cliJson(["legacy-import", "revert", applied2.import_id], dst2);
    assert.equal(rv.ok, true);
    assert.ok(rv.removed.sessions > 0 && rv.files_removed.length > 0);
    const db = new DatabaseSync(path.join(dst2.dataDir, "ruukoto.db"), { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT count(*) n FROM sessions WHERE id = ?").get(s1.id) as any).n, 0, "导入的会话已移除");
      assert.equal((db.prepare("SELECT count(*) n FROM projects WHERE id = ?").get(projL.id) as any).n, 0, "导入的项目已移除");
      const status = (db.prepare("SELECT status FROM instance_imports WHERE id = ?").get(applied2.import_id) as any).status;
      assert.equal(status, "reverted", "回执保留并标 reverted");
    } finally {
      db.close();
    }
    const list2 = await cliJson(["legacy-import", "list"], dst2);
    assert.equal(list2[0].status, "reverted");
    assert.equal(hashTree(srcDirs.root), sourceHashAfterStop, "源目录全流程逐文件不变");
  } finally {
    await cleanupDirs(dst2);
  }
});

await server.close();
await cleanupDirs(srcDirs);
await cleanupDirs(dstDirs);

const failed = results.filter((r) => !r.ok);
console.log("\n模拟：模型服务（MockModelServer，本地 OpenAI 兼容打桩，确定性应答）");
console.log("真实：bin/ruukoto.mjs 与 bin/ruukoto-code.mjs 后台进程（各 1–2 次拉起）、控制面 socket、SQLite（含只读直读核对）、JSONL 历史文件、产物文件、实例锁、legacy-import CLI 离线全流程");
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过（环境：${process.platform} ${process.arch}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
if (failed.length > 0) process.exit(1);
