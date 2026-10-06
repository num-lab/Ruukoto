/**
 * 发布联合冒烟：真实模型 + macOS 容器编码/TUI 退出后继续；双产品独立安装和升级。
 * npx tsx .scratch/agent-direction/smoke-24-release-acceptance.mts
 * --upgrade-only 跳过真实模型（可在 Linux 复跑）。SMOKE24_BASE 默认 1aba2f1；
 * 无 .git 的远端副本通过 SMOKE24_BASE_TAR 指定 git archive 生成的旧版本包。
 * 模型配置只复制指定 provider/model；不连接真实 IM，不读取日常实例数据库。
 * 升级部分使用模拟模型，后台进程、独立安装、控制面和持久历史均为真实。
 */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlClient } from "../../src/control/client.ts";
import { probeLockHolder } from "../../src/core/instance-lock.ts";
import { authenticateClient, taskStatus, waitFor, writeModelsJson } from "../../test/helpers/testkit.ts";
import { MockModelServer } from "../../test/helpers/mock-provider.ts";

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk24-")));
const base = process.env.SMOKE24_BASE ?? "1aba2f1";
const children: ChildProcess[] = [];
const clients: ControlClient[] = [];
const controls = new Map<string, string>();
let passed = 0;
const model = new MockModelServer(() => ({ kind: "text", text: "独立运行完成" }));

function profile(name: string, product: "ruukoto" | "ruukoto-dev") {
  const dir = path.join(root, name);
  const dataDir = path.join(dir, "data"), agentDir = path.join(dir, "agent"), controlDir = path.join(dir, "control");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  controls.set(controlDir, path.join(dataDir, "runtime.lock"));
  const prefix = product === "ruukoto" ? "RUUKOTO" : "RUUKOTO_DEV";
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "xterm-256color",
    [`${prefix}_DATA_DIR`]: dataDir, [`${prefix}_AGENT_DIR`]: agentDir,
    [`${prefix}_CONTROL_DIR`]: controlDir, [`${prefix}_PENDING_DIR`]: path.join(dir, "pending") };
  return { root: dir, dataDir, agentDir, controlDir, env, product };
}
type Profile = ReturnType<typeof profile>;

function run(command: string, args: string[], cwd = repo): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 }).trim();
}
async function connect(p: Profile): Promise<ControlClient> {
  let client: ControlClient | undefined;
  await waitFor("后台可认证", async () => {
    try {
      client = await ControlClient.connect(path.join(p.controlDir, "control.sock"), 1000);
      await authenticateClient(client, p.controlDir);
      await client.handshake();
      return true;
    } catch { client?.close(); return false; }
  }, 90_000);
  clients.push(client!);
  return client!;
}
function launch(tree: string, p: Profile): ChildProcess {
  const child = spawn(process.execPath, [path.join(tree, "bin", `${p.product}.mjs`), "server", "--execution", "local", "--thinking", "off"],
    { cwd: tree, env: p.env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  children.push(child);
  child.stderr!.on("data", () => {});
  return child;
}
async function stop(client: ControlClient, p: Profile): Promise<void> {
  await client.request("stop");
  client.close();
  await waitFor("后台显式停止", () => !fs.existsSync(path.join(p.controlDir, "control.sock")), 30_000);
}
async function complete(client: ControlClient, session: any, key: string, real = false) {
  const task = await client.request<any>("submit", { session_id: session.id, request_id: key,
    input: real
      ? "先用 bash 运行 sleep 12 && node check.mjs，确认现有检查失败。再读取 sum.mjs 和 check.mjs，修正 sum 的初始值，然后再次用 bash 运行 node check.mjs。只修改 sum.mjs，不修改检查。最后说明检查结果。"
      : `发布验收 ${key}，请回复独立运行完成。`,
    model_selection: session.modelSelection });
  return task;
}
async function finished(client: ControlClient, taskId: string, timeout = 60_000) {
  await waitFor("任务终态", async () => ["completed", "failed", "interrupted", "canceled"].includes((await taskStatus(client, taskId)).task.status), timeout);
  const detail = await taskStatus(client, taskId);
  assert.equal(detail.task.status, "completed", String(detail.task.errorMessage ?? detail.task.interruptReason ?? "任务未完成"));
  return detail;
}
function pass(name: string) { passed++; console.log(`PASS ${name}`); }

try {
  console.log(`环境：${process.platform} ${process.arch}，Node ${process.version}；升级基点 ${base}`);
  if (!process.argv.includes("--upgrade-only")) {
    const p = profile("real", "ruukoto-dev");
    const source = process.env.SMOKE24_MODELS ?? path.join(os.homedir(), ".ruukoto-dev/ruukoto-2159f2e3/agent/models.json");
    const config = JSON.parse(fs.readFileSync(source, "utf8"));
    const provider = config.providers?.mirasim;
    assert.ok(provider?.models?.some((m: any) => m.id === "kimi-k3"), "需要 mirasim/kimi-k3 模型配置");
    fs.writeFileSync(path.join(p.agentDir, "models.json"), JSON.stringify({ providers: { mirasim: { ...provider, models: provider.models.filter((m: any) => m.id === "kimi-k3") } } }), { mode: 0o600 });
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "sum.mjs"), "export function sum(xs) { let total = 1; for (const x of xs) total += x; return total; }\n");
    const checkSource = 'import assert from "node:assert/strict"; import { sum } from "./sum.mjs"; assert.equal(sum([]), 0); assert.equal(sum([1,2,3]), 6); console.log("CHECK_PASS");\n';
    fs.writeFileSync(path.join(workspace, "check.mjs"), checkSource);
    const tui = spawn("python3", [path.join(repo, ".scratch/agent-direction/pty-run.py"), path.join(repo, "bin/ruukoto-dev.mjs"), workspace],
      { cwd: repo, env: { ...p.env, GRACE: "10" }, stdio: ["ignore", "pipe", "pipe"] });
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
    const task = await complete(client, session, "real-coding", true);
    assert.equal(await tuiExit, 0);
    assert.match(tuiOutput, /已按需拉起 ruukoto-dev 后台/);
    assert.match(tuiOutput, /已退出 TUI；后台任务继续运行/);
    assert.equal((await taskStatus(client, task.id)).task.status, "running", "TUI 退出时任务应仍在执行");
    const detail = await finished(client, task.id, 240_000);
    assert.equal(fs.readFileSync(path.join(workspace, "check.mjs"), "utf8"), checkSource, "模型必须修代码且保留原检查");
    assert.match(run(process.execPath, ["check.mjs"], workspace), /CHECK_PASS/);
    const checks = detail.toolOps.filter((op: any) => op.toolName === "bash");
    assert.equal(checks[0]?.isError, true, "修前检查实际失败");
    assert.equal(checks.at(-1)?.isError, false, "修后检查实际通过");
    assert.match(checks.at(-1)?.resultSummary ?? "", /CHECK_PASS/);
    assert.ok(detail.toolOps.some((op: any) => ["edit", "write"].includes(op.toolName) && !op.isError));
    assert.ok(detail.artifacts.length > 0, "保留真实工具产物");
    client.close();
    const reconnected = await connect(p);
    assert.equal((await taskStatus(reconnected, task.id)).task.status, "completed");
    await stop(reconnected, p);
    pass(`真实 mirasim/kimi-k3 在容器内修复并通过检查，TUI 退出后继续、重连查到 ${detail.artifacts.length} 项产物`);
  }

  const endpoint = await model.start();
  const personal = profile("p", "ruukoto"), coding = profile("d", "ruukoto-dev");
  const trees = [path.join(root, "install-personal"), path.join(root, "install-coding")];
  for (const [index, tree] of trees.entries()) {
    fs.mkdirSync(tree);
    const archive = path.join(root, `install-${index}.tar`);
    if (process.env.SMOKE24_BASE_TAR) fs.copyFileSync(process.env.SMOKE24_BASE_TAR, archive);
    else run("git", ["archive", base, "-o", archive]);
    run("tar", ["-xf", archive, "-C", tree]);
    run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], tree);
  }
  await writeModelsJson(personal, endpoint);
  await writeModelsJson(coding, endpoint);
  const oldPersonal = launch(trees[0]!, personal);
  launch(trees[1]!, coding);
  let pClient = await connect(personal), dClient = await connect(coding);
  const pSnapshot = (await pClient.handshake()).snapshot, dSnapshot = (await dClient.handshake()).snapshot;
  assert.notEqual(pSnapshot.instanceId, dSnapshot.instanceId);
  const pWorkspace = path.join(root, "personal-work"), dWorkspace = path.join(root, "coding-work");
  fs.mkdirSync(pWorkspace); fs.mkdirSync(dWorkspace);
  const pSession = (await pClient.request<any>("open_workspace", { cwd: pWorkspace, request_id: "p-workspace" })).session;
  const dSession = (await dClient.request<any>("open_workspace", { cwd: dWorkspace, request_id: "d-workspace" })).session;
  const originalTask = await complete(dClient, dSession, "before-upgrade");
  await finished(dClient, originalTask.id);
  pass("两份独立安装以各自配置、数据、控制面并存且实例标识不同");

  for (const [index, p] of [coding, personal].entries()) {
    const client = index === 0 ? dClient : pClient;
    const survivor = index === 0 ? oldPersonal : children.at(-1)!;
    const survivorClient = index === 0 ? pClient : dClient;
    const survivorProfile = index === 0 ? personal : coding;
    const survivorSession = index === 0 ? pSession : dSession;
    await stop(client, p);
    assert.equal(survivor.exitCode, null);
    assert.equal((await survivorClient.handshake()).snapshot.instanceId, index === 0 ? pSnapshot.instanceId : dSnapshot.instanceId);
    await finished(survivorClient, (await complete(survivorClient, survivorSession, `other-stopped-${index}`)).id);
    const tree = index === 0 ? trees[1]! : trees[0]!;
    for (const name of ["src", "bin"]) { fs.rmSync(path.join(tree, name), { recursive: true }); fs.cpSync(path.join(repo, name), path.join(tree, name), { recursive: true }); }
    for (const name of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(repo, name), path.join(tree, name));
    run("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], tree);
    const updated = launch(tree, p);
    const next = await connect(p);
    if (index === 0) dClient = next; else pClient = next;
    assert.equal((await next.handshake()).snapshot.instanceId, index === 0 ? dSnapshot.instanceId : pSnapshot.instanceId);
    assert.equal(survivor.exitCode, null);
    assert.ok(updated.pid && survivor.pid && updated.pid !== survivor.pid);
    await finished(next, (await complete(next, index === 0 ? dSession : pSession, `after-upgrade-${index}`)).id);
    pass(`${p.product} 从 ${base} 独立升级到当前源码，另一端未重启且停端期间仍完成任务`);
    assert.ok(survivorProfile.controlDir !== p.controlDir);
  }
  assert.equal((await taskStatus(dClient, originalTask.id)).task.status, "completed");
  const history = await dClient.request<any>("read_history", { session_id: dSession.id, limit: 100 });
  assert.match(JSON.stringify(history), /before-upgrade/);
  await stop(pClient, personal);
  await finished(dClient, (await complete(dClient, dSession, "personal-offline")).id);
  await stop(dClient, coding);
  pass("升级前历史可查，分别停止，个人端离线后编码端完成本地任务");
  console.log(`结果：${passed}/${passed} 通过；真实 IM 未涉及，升级任务模型为桩`);
} finally {
  for (const controlDir of controls.keys()) {
    try {
      const client = await ControlClient.connect(path.join(controlDir, "control.sock"), 1000);
      await authenticateClient(client, controlDir);
      await client.request("stop"); client.close();
      await waitFor("清理后台", () => !fs.existsSync(path.join(controlDir, "control.sock")), 20_000);
    } catch {}
  }
  for (const client of clients) client.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
  await model.close();
  for (const lock of controls.values()) {
    try { await waitFor("核实本次后台已退出", () => !probeLockHolder(lock).held, 10_000); }
    catch { throw new Error(`后台退出未核实，保留临时档案 ${root}；${probeLockHolder(lock).detail}`); }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
