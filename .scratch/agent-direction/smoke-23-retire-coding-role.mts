/**
 * 固定 coding 角色退役（agent-direction issue 23）升级冒烟。
 *
 * 旧数据由退役前代码（基点 1aba2f1，可用 SMOKE23_BASE 覆盖）真实产生：
 *   1. 以旧代码工作副本启动隔离 profile 的 ruukoto 后台（local 执行后端）；
 *   2. 经旧 CLI 向 main 提交一次请求，main 经 coding_delegate 委派两个 draft
 *      子任务：A 的模型调用挂起（运行中），B 在 coding 角色会话排队；
 *   3. SIGKILL 后台，换新代码（本仓库当前状态）在同一数据目录启动。
 * 核对：旧子任务收尾（A interrupted、B canceled coding_role_retired），各补记
 * 一次结果并唤醒 main 一次、正文不重放；coding 角色行保留、角色会话拒绝提交；
 * 第二次重启幂等；ruukoto-dev 的 create-project / create-session 拒绝旧项目写入。
 *
 * 模拟（打桩）：MockModelServer（模型）。真实：两份 bin 后台进程、SIGKILL +
 * 正常停止 + 再启动、控制面 socket 与令牌、SQLite 核心库、CLI 进程。
 * 结果约定：0 = 全部通过；1 = 有 FAIL。
 * `--remote`：rsync 当前仓库与旧代码包到 tx，远端 npm ci 后自包含跑完全程。
 */

import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "../../test/helpers/mock-provider.ts";
import { authenticateClient, cleanupDirs, lastUserText, makeTestDirs, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { killProcessTree } from "../../test/helpers/backend.ts";

const BASE = process.env.SMOKE23_BASE ?? "1aba2f1";
const SELF = ".scratch/agent-direction/smoke-23-retire-coding-role.mts";
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const results: Array<{ name: string; ok: boolean }> = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}

function stageOldTree(dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(dest, "old.tar");
  execFileSync("git", ["-C", repoRoot, "archive", BASE, "-o", tar], { stdio: "inherit" });
  execFileSync("tar", ["-xf", tar, "-C", dest], { stdio: "inherit" });
  fs.rmSync(tar);
  console.log(`旧代码副本：${BASE} → ${dest}`);
}

if (process.argv.includes("--remote")) {
  const REMOTE = "tx", RDIR = "/tmp/ruukoto-smoke23-src", ROLD = "/tmp/ruukoto-smoke23-old";
  const run = (label: string, cmd: string, args: string[], allowFail = false) => {
    console.log(`\n=== ${label} ===`);
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 1_200_000 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status !== 0 && !allowFail) process.exit(1);
    return r.status ?? 1;
  };
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "smoke23-old-"));
  stageOldTree(path.join(staging, "old"));
  run("rsync 当前仓库", "rsync", ["-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", `${repoRoot}/`, `${REMOTE}:${RDIR}/`]);
  run("rsync 旧代码", "rsync", ["-az", "--delete", `${staging}/old/`, `${REMOTE}:${ROLD}/`]);
  run("远端 npm ci", "ssh", [REMOTE, `cd ${RDIR} && npm ci --no-audit --no-fund --prefer-offline && cd ${ROLD} && npm ci --no-audit --no-fund --prefer-offline`]);
  const code = run("远端冒烟（Linux）", "ssh", [REMOTE, `cd ${RDIR} && SMOKE23_OLD_TREE=${ROLD} node_modules/.bin/tsx ${SELF}`], true);
  fs.rmSync(staging, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

console.log(`环境：${process.platform} ${process.arch}，Node ${process.version}`);
const OLD_TREE = process.env.SMOKE23_OLD_TREE ?? fs.mkdtempSync(path.join(os.tmpdir(), "smoke23-old-"));
if (!fs.existsSync(path.join(OLD_TREE, "bin", "ruukoto.mjs"))) stageOldTree(OLD_TREE);
if (!fs.existsSync(path.join(OLD_TREE, "node_modules", "tsx"))) {
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: OLD_TREE, stdio: "inherit", timeout: 600_000 });
}

let releaseHang: () => void = () => {};
const hang = new Promise<void>((r) => (releaseHang = r));
const responder: Responder = async (req: RecordedRequest) => {
  const text = lastUserText(req);
  const afterTool = req.messages.at(-1)?.role === "tool";
  if (text.includes("SMOKE23-CHILD-A")) {
    await hang;
    return { kind: "text", text: "A 不应在新代码完成" };
  }
  if (text.includes("SMOKE23-CHILD-B")) return { kind: "text", text: "B 不应被执行" };
  if (text.includes("SMOKE23-DELEGATE")) {
    const done = req.messages.filter((m) => m.role === "tool").length;
    if (done === 0) return { kind: "tool_calls", calls: [{ id: "da", name: "coding_delegate", arguments: { request: "SMOKE23-CHILD-A 生成草稿", mode: "draft", key: "a" } }] };
    if (done === 1) return { kind: "tool_calls", calls: [{ id: "db", name: "coding_delegate", arguments: { request: "SMOKE23-CHILD-B 生成草稿", mode: "draft", key: "b" } }] };
    return afterTool ? { kind: "text", text: "已委派两项" } : { kind: "text", text: "?" };
  }
  return { kind: "text", text: "WAKE-OK" };
};

const { dirs } = await makeTestDirs("smoke23", 0);
const controlDir = path.join(dirs.root, "control");
const model = new MockModelServer(responder);
await writeModelsJson(dirs, await model.start());
const env = { PATH: process.env.PATH, HOME: process.env.HOME, RUUKOTO_CONTROL_DIR: controlDir };

let child!: childProcess.ChildProcess;
let stderr = "";
function spawnBackend(tree: string): void {
  child = childProcess.spawn(process.execPath,
    [path.join(tree, "bin", "ruukoto.mjs"), "server", "--data-dir", dirs.dataDir, "--agent-dir", dirs.agentDir, "--execution", "local"],
    { cwd: tree, env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
}
function cli(tree: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(tree, "bin", args[0] === "dev" ? "ruukoto-dev.mjs" : "ruukoto.mjs"), ...args.slice(args[0] === "dev" ? 1 : 0)],
    { cwd: tree, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000 });
}
async function connect(): Promise<ControlClient> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`后台提前退出：${stderr.slice(0, 2000)}`);
    try {
      const client = await ControlClient.connect(path.join(controlDir, "control.sock"), 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      return client;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`连接超时：${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
async function stopBackend(client: ControlClient): Promise<void> {
  await client.request("stop");
  client.close();
  await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
}
const q = <T = any>(sql: string, ...args: unknown[]): T[] => {
  const db = new DatabaseSync(path.join(dirs.dataDir, "ruukoto.db"), { readOnly: true });
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
};
const q1 = <T = any>(sql: string, ...args: unknown[]): T | undefined => q<T>(sql, ...args)[0];

let client: ControlClient | null = null;
try {
  // ===== 阶段一：旧代码产生在途 coding 子任务 =====
  spawnBackend(OLD_TREE);
  await waitFor("旧后台就绪", () => fs.existsSync(path.join(controlDir, "control.sock")), 90_000);
  await waitFor("角色引导", () => q1("SELECT id FROM agent_roles WHERE id = 'coding'") !== undefined, 90_000);
  const mainSession = q1<any>("SELECT session_id FROM agent_roles WHERE id = 'main'")!.session_id as string;
  const codingSession = q1<any>("SELECT session_id FROM agent_roles WHERE id = 'coding'")!.session_id as string;
  const submit = cli(OLD_TREE, ["submit", mainSession, "smoke23-p", "SMOKE23-DELEGATE 委派两项"]);
  assert.equal(submit.status, 0, submit.stderr);
  await waitFor("A 运行中、B 排队", () => {
    const rows = q<any>("SELECT status FROM tasks WHERE session_id = ? ORDER BY created_at", codingSession).map((r) => r.status);
    return rows.length === 2 && rows[0] === "running" && rows[1] === "queued";
  }, 120_000);
  // main 父任务先收尾：杀进程时 main 不留在途执行，重启后其队列不因占用未核实而暂停
  await waitFor("main 父任务完成", () => q1<any>("SELECT status FROM tasks WHERE session_id = ? AND request_id = 'smoke23-p'", mainSession)?.status === "completed", 60_000);
  const [a, b] = q<any>("SELECT id FROM tasks WHERE session_id = ? ORDER BY created_at", codingSession).map((r) => r.id as string);
  killProcessTree(child);
  await new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", () => r())));
  const callsBefore = model.calls.length;

  // ===== 阶段二：新代码同一数据目录启动 =====
  spawnBackend(repoRoot);
  client = await connect();
  const wakes = () => q<any>("SELECT id, status, input FROM tasks WHERE session_id = ? AND request_id IN (?, ?)", mainSession, `wake:${a}`, `wake:${b}`);
  await waitFor("两个唤醒完成", () => wakes().length === 2 && wakes().every((w) => w.status === "completed"), 120_000);

  await check("收尾：A interrupted、B canceled(coding_role_retired)，各有结果", () => {
    const ta = q1<any>("SELECT * FROM tasks WHERE id = ?", a)!, tb = q1<any>("SELECT * FROM tasks WHERE id = ?", b)!;
    assert.equal(ta.status, "interrupted");
    assert.equal(tb.status, "canceled");
    assert.match(tb.error_message ?? "", /^coding_role_retired:/);
    assert.ok(ta.result_summary && tb.result_summary);
  });
  await check("唤醒 main 各一次且指向 coding_result；子任务正文未重放", () => {
    assert.ok(wakes().every((w) => String(w.input).includes("coding_result")));
    const after = model.calls.slice(callsBefore).map((c) => lastUserText(c));
    assert.ok(!after.some((t) => t.includes("SMOKE23-CHILD")), "新代码未把旧子任务交给模型");
  });
  await check("coding 角色行保留；向 coding 会话提交被拒（invalid_state）", async () => {
    assert.ok(q1("SELECT id FROM agent_roles WHERE id = 'coding'"));
    await assert.rejects(
      client!.request("submit", { session_id: codingSession, request_id: "smoke23-new", input: "新任务", model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" } }),
      (err: any) => err.code === "invalid_state" && /固定 coding 角色已退役/.test(err.message),
    );
  });
  await stopBackend(client);
  client = null;

  // ===== 阶段三：再次重启幂等 =====
  spawnBackend(repoRoot);
  client = await connect();
  await new Promise((r) => setTimeout(r, 800));
  await check("再次重启：唤醒仍各一次，coding 会话无新任务", () => {
    assert.equal(wakes().length, 2);
    assert.equal(q<any>("SELECT id FROM tasks WHERE session_id = ?", codingSession).length, 2);
  });
  await stopBackend(client);
  client = null;

  // ===== ruukoto-dev 不提供旧项目写入路径（拒绝发生在连接后台之前） =====
  await check("ruukoto-dev create-project / create-session 拒绝并提示工作区入口", () => {
    const devEnv = { RUUKOTO_DEV_DATA_DIR: path.join(dirs.root, "dev-data"), RUUKOTO_DEV_CONTROL_DIR: path.join(dirs.root, "dev-control") };
    for (const args of [["dev", "create-project", "旧项目"], ["dev", "create-session", "p", dirs.root]]) {
      const r = cli(repoRoot, args, devEnv);
      assert.equal(r.status, 1, `${args.join(" ")} 退出码`);
      assert.match(r.stderr, /ruukoto-dev 使用工作区/);
    }
  });
} catch (err) {
  console.log(`FAIL 运行中断：${(err as Error).message}\n${stderr.slice(-2000)}`);
  results.push({ name: "运行中断", ok: false });
} finally {
  releaseHang();
  if (client) await stopBackend(client).catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) killProcessTree(child);
  await model.close();
  await cleanupDirs(dirs);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
