/** Real-model native repair, TUI detach and reconnect using an explicit isolated configuration. */
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ControlClient } from "@ruukoto/control/client.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { probeLockHolder } from "@ruukoto/core/instance-lock.ts";
import { saveDefaultModel } from "@ruukoto/agent/model-config.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { bootstrapProfile, profileChildEnv, selectProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { prerequisite } from "./gate.ts";

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const usage = "用法：--models <models.json> --model <provider/model>；--help 查看前提";
let options: { models?: string; model?: string; help?: boolean };
try {
  options = parseArgs({ options: {
    models: { type: "string" }, model: { type: "string" }, help: { type: "boolean" },
  }, allowPositionals: false, strict: true }).values;
} catch (err) {
  prerequisite(`参数无效：${(err as Error).message}\n${usage}`);
}
if (options.help) {
  process.stdout.write(`${usage}\n需要构建后的原生执行入口、Python 3 pty，以及显式配置的 provider/model；会调用真实模型，可能产生费用。\n使用临时档案，不读取日常数据库或自动发现凭据。退出码：0 通过，1 失败，2 前提缺失。\n`);
  process.exit(0);
}
let providerId = "", modelId = "", provider: any;
  if (!options.models || !options.model) prerequisite(`真实模型验收必须显式提供 --models 与 --model\n${usage}`);
  const separator = options.model.indexOf("/");
  if (separator <= 0 || separator === options.model.length - 1) prerequisite("--model 必须为 provider/model");
  providerId = options.model.slice(0, separator);
  modelId = options.model.slice(separator + 1);
  let config: any;
  try { config = JSON.parse(fs.readFileSync(options.models, "utf8")); }
  catch { prerequisite("无法读取指定的 models.json，或文件不是合法 JSON"); }
  provider = config?.providers?.[providerId];
  if (!provider || !Array.isArray(provider.models) || !provider.models.some((m: any) => m?.id === modelId)) {
    prerequisite(`指定配置中没有模型 ${options.model}`);
  }
  try { execFileSync("python3", ["-c", "import pty"], { stdio: "ignore", timeout: 15_000 }); }
  catch { prerequisite("真实模型 TUI 验收需要 Python 3 与 pty 模块"); }

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk24-")));
const children: ChildProcess[] = [];
const clients: ControlClient[] = [];
const profiles: ProfilePaths[] = [];
const backendPids = new Map<ProfilePaths, number>();
let passed = 0;
let failureCode = 1;

async function createProfile(name: string): Promise<ProfilePaths> {
  const profile = await bootstrapProfile(selectProfile({ dataDir: path.join(root, name, "data") }, {}));
  profiles.push(profile);
  return profile;
}
function childEnv(profile: ProfilePaths): NodeJS.ProcessEnv {
  return profileChildEnv(profile.selection, { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });
}

function run(command: string, args: string[], cwd = repo): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 }).trim();
}
async function waitFor(description: string, ready: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await ready()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function authenticateClient(client: ControlClient, profile: ProfilePaths): Promise<void> {
  const token = readOwnerToken(profile.controlDir);
  assert.ok(token, "The isolated profile must contain an owner token");
  await client.authenticate(token, profile);
}

async function connect(p: ProfilePaths): Promise<ControlClient> {
  let client: ControlClient | undefined;
  await waitFor("后台可认证", async () => {
    try {
      client = await ControlClient.connect(p.socketPath, 1000);
      await authenticateClient(client, p);
      await client.handshake();
      return true;
    } catch { client?.close(); return false; }
  }, 90_000);
  clients.push(client!);
  const holder = probeLockHolder(path.join(p.dataDir, "runtime.lock"));
  assert.ok(holder.held && !holder.unverifiable && holder.pid, "The authenticated backend must have verified ownership");
  backendPids.set(p, holder.pid);
  return client!;
}
function backendStopped(profile: ProfilePaths): boolean {
  const pid = backendPids.get(profile);
  if (pid) {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return false; }
  }
  return [path.join(profile.dataDir, "runtime.lock"), path.join(profile.agentDir, "config.lock")].every(lock => {
    const holder = probeLockHolder(lock);
    return !holder.held && !holder.unverifiable;
  });
}
async function stop(client: ControlClient, p: ProfilePaths): Promise<void> {
  await client.request("stop");
  client.close();
  await waitFor("Backend exit and both lock releases", () => backendStopped(p) && !fs.existsSync(p.socketPath), 30_000);
}
async function complete(client: ControlClient, session: any, key: string) {
  return client.request<any>("submit", { session_id: session.id, request_id: key,
    input: "先用 bash 运行 sleep 12 && node check.mjs，确认现有检查失败。再读取 sum.mjs 和 check.mjs，修正 sum 的初始值，然后再次用 bash 运行 node check.mjs。只修改 sum.mjs，不修改检查。最后说明检查结果。",
    model_selection: session.modelSelection });
}
async function finished(client: ControlClient, taskId: string, timeout = 60_000) {
  await waitFor("任务终态", async () => ["completed", "failed", "interrupted", "canceled"].includes((await client.request<OpResult<"get_task">>("get_task", { task_id: taskId })).task.status), timeout);
  const detail = await client.request<OpResult<"get_task">>("get_task", { task_id: taskId });
  assert.equal(detail.task.status, "completed", String(detail.task.errorMessage ?? detail.task.interruptReason ?? "任务未完成"));
  return detail;
}
function pass(name: string) { passed++; process.stderr.write("[ruukoto:smoke24] " + `PASS ${name}` + "\n"); }

try {
  process.stderr.write(`[ruukoto:smoke24] 环境：${process.platform} ${process.arch}，Node ${process.version}\n`);
    const p = await createProfile("real");
    fs.writeFileSync(path.join(p.agentDir, "models.json"), JSON.stringify({ providers: { [providerId]: { ...provider, models: provider.models.filter((m: any) => m.id === modelId) } } }), { mode: 0o600 });
    saveDefaultModel(p.agentDir, { provider: providerId, modelId, thinkingLevel: "off" });
    const probe = spawnSync(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval",
      'import { probeModelConfig } from "@ruukoto/agent/model-config.ts"; const result = await probeModelConfig(process.argv[1]); process.exitCode = result.ok ? 0 : 2;',
      p.agentDir], { cwd: repo, env: childEnv(p), encoding: "utf8", timeout: 30_000 });
    if (probe.status !== 0) {
      failureCode = 2;
      throw new Error(`模型 ${providerId}/${modelId} 未通过离线配置与认证检查；--models 必须提供可独立调用的配置，不读取日常 auth.json 或继承模型 API key`);
    }
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "sum.mjs"), "export function sum(xs) { let total = 1; for (const x of xs) total += x; return total; }\n");
    const checkSource = 'import assert from "node:assert/strict"; import { sum } from "./sum.mjs"; assert.equal(sum([]), 0); assert.equal(sum([1,2,3]), 6); process.stdout.write("CHECK_PASS");\n';
    fs.writeFileSync(path.join(workspace, "check.mjs"), checkSource);
    const tui = spawn("python3", [path.join(repo, "verification/smoke/pty-run.py"), path.join(repo, "apps/ruukoto/bin/ruukoto.mjs"), workspace],
      { cwd: repo, env: { ...childEnv(p), GRACE: "10" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(tui);
    let tuiOutput = "";
    tui.stdout!.on("data", (b) => { tuiOutput += b.toString(); });
    tui.stderr!.on("data", (b) => { tuiOutput += b.toString(); });
    const tuiExit = new Promise<number | null>((resolve) => tui.once("exit", resolve));
    const client = await connect(p);
    let session: any;
    await waitFor("TUI 建立工作区会话", async () => {
      session = (await client.handshake()).snapshot.sessions.find((s) => s.cwd === workspace);
      return !!session;
    });
    const task = await complete(client, session, "real-coding");
    assert.equal(await tuiExit, 0);
    assert.equal((await client.request<OpResult<"get_task">>("get_task", { task_id: task.id })).task.status, "running", "TUI 退出时任务应仍在执行");
    const detail = await finished(client, task.id, 240_000);
    assert.equal(fs.readFileSync(path.join(workspace, "check.mjs"), "utf8"), checkSource, "模型必须修代码且保留原检查");
    assert.match(run(process.execPath, ["check.mjs"], workspace), /CHECK_PASS/);
    const checks = detail.toolOps.filter(op => op.toolName === "bash");
    assert.equal(checks[0]?.isError, true, "修前检查实际失败");
    assert.equal(checks.at(-1)?.isError, false, "修后检查实际通过");
    assert.match(checks.at(-1)?.resultSummary ?? "", /CHECK_PASS/);
    assert.ok(detail.toolOps.some(op => ["edit", "write"].includes(op.toolName) && !op.isError));
    assert.ok(detail.artifacts.length > 0, "保留真实工具产物");
    client.close();
    const reconnected = await connect(p);
    assert.equal((await reconnected.request<OpResult<"get_task">>("get_task", { task_id: task.id })).task.status, "completed");
    await stop(reconnected, p);
    pass(`真实 ${providerId}/${modelId} 在原生沙箱内修复并通过检查，TUI 退出后继续、重连查到 ${detail.artifacts.length} 项产物`);
  process.stderr.write(`[ruukoto:smoke24] 结果：${passed}/${passed} 通过；真实模型编码\n`);
} catch (err) {
  process.stderr.write("[ruukoto:smoke24] " + `${failureCode === 2 ? "前提缺失" : "FAIL 发布验收"}：${(err as Error).message}` + "\n");
  process.exitCode = failureCode;
} finally {
  let cleanupFailed = false;
  for (const profile of profiles) {
    try {
      const client = await ControlClient.connect(profile.socketPath, 1000);
      await authenticateClient(client, profile);
      await client.request("stop"); client.close();
      await waitFor("清理后台", () => !fs.existsSync(profile.socketPath), 20_000);
    } catch { /* 下方终止本次进程，并以实例锁核实是否已退出。 */ }
  }
  for (const client of clients) client.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* 锁检查决定是否保留现场。 */ } }
  }
  for (const profile of profiles) {
    const lock = path.join(profile.dataDir, "runtime.lock");
    try { await waitFor("Backend exit and both lock releases", () => backendStopped(profile), 20_000); }
    catch {
      process.stderr.write("[ruukoto:smoke24] " + `FAIL 清理：后台退出未核实，保留临时档案 ${root}；${probeLockHolder(lock).detail}` + "\n");
      process.exitCode = 1;
      cleanupFailed = true;
    }
  }
  for (const profile of profiles) {
    const database = path.join(profile.dataDir, "ruukoto.db");
    if (!fs.existsSync(database)) continue;
    try {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const rows = db.prepare("SELECT task_id FROM occupancy").all();
        assert.deepEqual(rows, [], "停止后仍有占用时必须保留现场");
      } finally { db.close(); }
    } catch (error) {
      cleanupFailed = true;
      process.exitCode = 1;
      process.stderr.write(`[ruukoto:smoke24] 停止未核实，保留档案 ${root}；${String(error)}\n`);
    }
  }
  if (!cleanupFailed && (!process.exitCode || (process.exitCode === 2 && children.length === 0))) {
    for (const profile of profiles) fs.rmSync(path.dirname(profile.socketPath), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  } else process.stderr.write(`[ruukoto:smoke24] 失败档案保留 ${root}\n`);
}
