/** 真实 Linux launcher 的活动 scope 与启动失败回收；不修改系统设置。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { launchLinuxNative } from "../../../../packages/agent/src/execution/native-linux.ts";
import { ExecutionError, type LaunchedUnit, type LaunchSpec } from "../../../../packages/agent/src/execution/launchers.ts";
import type { PreparedNativeLaunch } from "../../../../packages/agent/src/execution/native.ts";

if (process.platform !== "linux") throw new Error("本探针仅用于真实 Linux 环境");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-linux-scope-proof-")));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
const stat = fs.statSync(workspace);
const spec: LaunchSpec = { taskId: `linux-scope-proof-${process.pid}`, workspace,
  workspaceIdentity: { dev: stat.dev, ino: stat.ino }, mode: "confirm", grantedPaths: [] };
const rows: Array<{ probe: string; pass: boolean; detail: Record<string, unknown> }> = [];
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
let cleanupSafe = true;

async function status(id: string): Promise<{ success: boolean; load: string; active: string; group: string }> {
  const result = await new Promise<{ success: boolean; stdout: string }>(resolve => {
    execFile("/usr/bin/systemctl", ["--user", "show", id, "--property", "LoadState,ActiveState,ControlGroup"],
      { encoding: "utf8", timeout: 5000 }, (error, stdout) => resolve({ success: !error, stdout }));
  });
  const fields = new Map(result.stdout.trim().split("\n").map(line => {
    const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return { success: result.success, load: fields.get("LoadState") ?? "", active: fields.get("ActiveState") ?? "", group: fields.get("ControlGroup") ?? "" };
}

function prepared(name: string, source: string): PreparedNativeLaunch {
  const workerPath = path.join(root, `${name}.mjs`), tempDir = path.join(root, `${name}-private`);
  fs.writeFileSync(workerPath, source); fs.mkdirSync(tempDir, { mode: 0o700 });
  return { workspace, workerPath, tempDir, nodePath: fs.realpathSync(process.execPath),
    runtimeReadRoots: ["/usr", workerPath], toolAliases: [], mounts: [{ path: workspace, access: "read_write" }],
    env: { PATH: "/usr/bin:/bin", HOME: tempDir, TMPDIR: tempDir, LANG: "C.UTF-8" } };
}

async function launch(input: PreparedNativeLaunch): Promise<{ unit: LaunchedUnit; launched: boolean; reason?: string }> {
  try { return { unit: await launchLinuxNative(input, spec), launched: true }; }
  catch (error) {
    if (!(error instanceof ExecutionError && error.unit)) throw error;
    return { unit: error.unit, launched: false, reason: error.reason };
  }
}

try {
  const heartbeat = path.join(workspace, "heartbeat");
  const child = `process.on('SIGTERM',()=>{});setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'h'),25)`;
  const live = await launch(prepared("active", `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`));
  const deadline = Date.now() + 5000;
  while ((!fs.existsSync(heartbeat) || fs.statSync(heartbeat).size < 3) && Date.now() < deadline) await pause(25);
  const before = await status(live.unit.entry.id);
  const stopped = await live.unit.entry.stop();
  await live.unit.exit;
  const size = fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0;
  await pause(200);
  const after = await status(live.unit.entry.id);
  const frozen = size >= 3 && fs.statSync(heartbeat).size === size;
  const repeated = await live.unit.entry.stop();
  cleanupSafe &&= stopped;
  rows.push({ probe: "scope.active-detached-stop", pass: live.launched && Boolean(before.group) && stopped && frozen && repeated,
    detail: { launched: live.launched, before, stopped, repeated, heartbeatBytes: size, heartbeatFrozen: frozen, after } });

  for (const [name, input] of [
    ["fast-exit", prepared("fast-exit", "process.exit(0)")],
    ["pre-entry-failure", { ...prepared("pre-entry-failure", "process.exit(0)"), nodePath: "/virtual-native-node-missing" }],
  ] as const) {
    const result = await launch(input);
    const exited = await result.unit.exit;
    await pause(200);
    const beforeStop = await status(result.unit.entry.id);
    const start = Date.now(), verified = await result.unit.entry.stop(), elapsedMs = Date.now() - start;
    const afterStop = await status(result.unit.entry.id);
    const gone = beforeStop.success && beforeStop.load === "not-found" && afterStop.success && afterStop.load === "not-found";
    const observed = result.launched || result.reason === "policy_missing";
    // 这两段虚拟入口不创建后代；外部确认 scope 删除才清理探针资料，仍保留 launcher 的未核实结论。
    cleanupSafe &&= verified || gone;
    rows.push({ probe: `scope.${name}`, pass: gone && (observed ? verified : !verified),
      detail: { launched: result.launched, reason: result.reason, groupObservedBeforeExit: observed, exited, beforeStop, verified, elapsedMs, afterStop } });
  }
} finally {
  if (cleanupSafe) fs.rmSync(root, { recursive: true });
}
const report = { timestamp: new Date().toISOString(), platform: process.platform, release: os.release(), arch: process.arch,
  scope: "直接调用正式 Linux launcher；模拟工作程序只验证活动回收、快速退出和 worker 入口前失败，不验证授权装配。",
  probes: rows, pass: rows.length === 3 && rows.every(row => row.pass), fixtureCleaned: !fs.existsSync(root),
  retainedFixture: fs.existsSync(root) ? root : undefined };
const output = path.resolve(process.argv[2] ?? "verification/foundation/results");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "native-linux-scope-report.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report) + "\n");
if (!report.pass || !report.fixtureCleaned) process.exitCode = 1;
