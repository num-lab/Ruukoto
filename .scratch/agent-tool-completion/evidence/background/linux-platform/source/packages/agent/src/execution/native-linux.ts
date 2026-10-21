/** 受限 bubblewrap 与持久完全访问命令共用 user scope 观察。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-full-access-commands.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { ExecutionError, workerEnv, type LaunchedUnit, type LaunchSpec } from "./launchers.ts";
import type { PreparedNativeLaunch } from "./native.ts";

const BWRAP = "/usr/bin/bwrap";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMCTL = "/usr/bin/systemctl";
const hostEnv = (): NodeJS.ProcessEnv => ({ PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, LANG: "C.UTF-8" });

function command(program: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => execFile(program, args, { encoding: "utf8", timeout: 5000, env: hostEnv() },
    (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout })));
}

/** 未观察过组路径时不能证明成员为空；删除竞争只接受已知组目录确实消失。 */
export function linuxNativeScopeEmpty(cgroup: string | null): boolean {
  if (cgroup === null) return false;
  try {
    return fs.readFileSync(path.join(cgroup, "cgroup.events"), "utf8").split("\n").includes("populated 0");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["ENOENT", "ENODEV"].includes(String(error.code)))) return false;
    try { fs.statSync(cgroup); return false; }
    catch (missing) { return missing instanceof Error && "code" in missing && missing.code === "ENOENT"; }
  }
}

/** 拒绝另一 ABI 与 x32；保留 socketpair 供 libuv stdio，禁止其对外发送及 io_uring 绕行。 */
export function nativeNetworkFilter(architecture: string): Buffer {
  const data = architecture === "x64" ? { arch: 0xc000003e, calls: [41, 42, 44, 46, 307, 425] }
    : architecture === "arm64" ? { arch: 0xc00000b7, calls: [198, 203, 206, 211, 269, 425] } : null;
  if (!data) throw new ExecutionError("execution_unavailable", "原生网络过滤只支持 Linux x64 与 arm64", undefined, "sandbox_rejected");
  const instructions = [[0x20, 0, 0, 4], [0x15, 1, 0, data.arch], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000]];
  for (const call of data.calls) instructions.push([0x15, 0, 1, call], [0x06, 0, 0, 0x00050001]);
  instructions.push([0x06, 0, 0, 0x7fff0000]);
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], i) => {
    buffer.writeUInt16LE(code, i * 8); buffer[i * 8 + 2] = yes; buffer[i * 8 + 3] = no;
    buffer.writeUInt32LE(value, i * 8 + 4);
  });
  return buffer;
}

export function linuxNativeArgs(input: PreparedNativeLaunch): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  for (const root of [...input.runtimeReadRoots].sort((a, b) => a.length - b.length)) args.push("--ro-bind", root, root);
  for (const alias of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (fs.existsSync(alias) && fs.lstatSync(alias).isSymbolicLink()) args.push("--symlink", fs.readlinkSync(alias), alias);
  }
  for (const alias of input.toolAliases) {
    if (!input.runtimeReadRoots.some(root => alias.path === root || alias.path.startsWith(root + "/"))) {
      args.push("--symlink", alias.target, alias.path);
    }
  }
  args.push("--bind", input.tempDir, input.tempDir);
  for (const mount of input.mounts) args.push(mount.access === "read" ? "--ro-bind" : "--bind", mount.path, mount.path);
  for (const [key, value] of Object.entries(input.env)) args.push("--setenv", key, value);
  args.push("--remount-ro", "/", "--remount-ro", "/tmp", "--remount-ro", "/dev", "--chdir", input.workspace, "--seccomp", "3", input.nodePath, "-e",
    "require('node:fs').writeSync(4,'started\\n');require('node:fs').closeSync(4);import(require('node:url').pathToFileURL(process.argv[1]).href)", input.workerPath);
  return args;
}

async function prerequisites(fullAccess: boolean): Promise<void> {
  for (const binary of [...(fullAccess ? [] : [BWRAP]), SYSTEMD_RUN, SYSTEMCTL]) {
    try { fs.accessSync(binary, fs.constants.X_OK); }
    catch { throw new ExecutionError("execution_unavailable", fullAccess ? "Linux 完全访问命令缺少 user systemd；请核实系统前置" : "Linux 原生执行缺少 bubblewrap 或 user systemd；见 deploy/native", undefined, "binary_missing"); }
  }
  const restriction = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  if (!fullAccess && fs.existsSync(restriction) && fs.readFileSync(restriction, "utf8").trim() === "1" && !fs.existsSync("/etc/apparmor.d/ruukoto-bwrap")) {
    throw new ExecutionError("execution_unavailable", "Linux 原生执行缺少 bwrap 的 AppArmor userns 配置；按 deploy/native 安装后重试", undefined, "policy_missing");
  }
  const manager = await command(SYSTEMCTL, ["--user", "is-system-running"]);
  if (!fs.existsSync("/sys/fs/cgroup/cgroup.controllers") || !["running", "degraded"].includes(manager.stdout.trim())) {
    throw new ExecutionError("execution_unavailable", "Linux 原生执行需要 cgroup v2 与可用的 user systemd", undefined, "policy_missing");
  }
}

/** 持久认领调用方的接点；省略时沿用共享 worker 的随机 scope 与停止方式。 */
export interface LinuxNativeTracking {
  scope: string;
  description: string;
  beforeSpawn(): void;
  spawned(pid: number): void;
  observed(state: { group: string; invocationId: string; description: string }): void;
}

export async function launchLinuxNative(input: PreparedNativeLaunch, spec: LaunchSpec, tracking?: LinuxNativeTracking): Promise<LaunchedUnit> {
  const fullAccess = spec.mode === "full_access";
  if (fullAccess && !tracking) throw new ExecutionError("execution_unavailable", "完全访问命令需要持久执行认领", undefined, "policy_missing");
  await prerequisites(fullAccess);
  const scope = tracking?.scope ?? `ruukoto-native-${randomUUID()}.scope`;
  let filter: number | undefined;
  if (!fullAccess) {
    const filterPath = path.join(input.tempDir, "network.bpf");
    fs.writeFileSync(filterPath, nativeNetworkFilter(process.arch), { mode: 0o400 });
    filter = fs.openSync(filterPath, "r");
  }
  let child;
  try {
    tracking?.beforeSpawn();
    child = spawn(SYSTEMD_RUN, ["--user", "--scope", "--quiet", "--unit", scope, "--property", "Delegate=yes",
      ...(tracking ? ["--property", `Description=${tracking.description}`] : []),
      ...(fullAccess ? [input.nodePath, "-e", "require('node:fs').writeSync(4,'started\\n');require('node:fs').closeSync(4);import(require('node:url').pathToFileURL(process.argv[1]).href)", input.workerPath] : [BWRAP, ...linuxNativeArgs(input)])],
      { stdio: ["pipe", "pipe", "pipe", filter ?? "ignore", "pipe"], env: fullAccess ? workerEnv(spec) : hostEnv(),
        ...(fullAccess ? { cwd: input.workspace } : {}), ...(tracking ? { detached: true } : {}) });
  } finally { if (filter !== undefined) fs.closeSync(filter); }
  let exited = false;
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
    child.on("error", () => { exited = true; reject(new ExecutionError("execution_unavailable", "Linux 原生执行入口启动失败", undefined, "sandbox_rejected")); });
  });
  void exit.catch(() => undefined); // 启动取消仍由同一单元记录消费退出信息。
  if (child.pid === undefined) {
    await exit;
    throw new ExecutionError("execution_unavailable", "Linux 原生执行未创建单元", undefined, "sandbox_rejected");
  }
  let cgroup: string | null = null;
  let groupChanged = false;
  let stopped: Promise<boolean> | null = null;
  const query = async (): Promise<{ load: string; active: string; group: string; invocationId: string; description: string } | null> => {
    const result = await command(SYSTEMCTL, ["--user", "show", scope, "--property",
      `LoadState,ActiveState,ControlGroup${tracking ? ",InvocationID,Description" : ""}`]);
    if (result.code !== 0) return null;
    const fields = new Map(result.stdout.trim().split("\n").map(line => {
      const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
    }));
    const group = fields.get("ControlGroup") ?? "";
    if (group) {
      if (!path.isAbsolute(group) || path.normalize(group) !== group || path.basename(group) !== scope) {
        groupChanged = true; return null;
      }
      const current = path.join("/sys/fs/cgroup", group);
      if (cgroup !== null && cgroup !== current) groupChanged = true;
      cgroup = current;
    }
    return { load: fields.get("LoadState") ?? "", active: fields.get("ActiveState") ?? "", group,
      invocationId: fields.get("InvocationID") ?? "", description: fields.get("Description") ?? "" };
  };
  const stop = (): Promise<boolean> => stopped ??= (async () => {
    await query();
    if (cgroup && fs.existsSync(cgroup)) {
      try { fs.writeFileSync(path.join(cgroup, "cgroup.kill"), "1"); }
      catch { /* cgroup 删除可能与停止竞争；仍须核实单元与成员。 */ }
    }
    await command(SYSTEMCTL, ["--user", "kill", "--signal=SIGKILL", scope]);
    await command(SYSTEMCTL, ["--user", "stop", scope]);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await query();
      const empty = !groupChanged && linuxNativeScopeEmpty(cgroup);
      if (state && exited && empty && (state.load === "not-found" || ["inactive", "failed"].includes(state.active))) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })();
  const unit: LaunchedUnit = { entry: { kind: "systemd_unit", id: scope,
    label: `tool-worker native scope=${scope} task=${spec.taskId}`, stop },
    stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exit };
  try {
    tracking?.spawned(child.pid);
    const marker = child.stdio[4];
    if (!(marker instanceof Readable)) throw new ExecutionError("execution_unavailable", "原生启动核实通道不可用", unit, "sandbox_rejected");
    const started = new Promise<boolean>(resolve => {
      let buffer = "";
      const timer = setTimeout(() => resolve(false), 10_000);
      marker.setEncoding("utf8");
      marker.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("started\n")) { clearTimeout(timer); resolve(true); }
      });
      void exit.then(() => { clearTimeout(timer); resolve(false); }, () => { clearTimeout(timer); resolve(false); });
    });
    if (!await started) throw new ExecutionError("execution_unavailable", fullAccess ? "完全访问命令入口未能启动；核实原执行与停止状态" : "bubblewrap 策略或 namespace 启动被拒绝；核对 deploy/native 前置", unit, "sandbox_rejected");
    const status = await query();
    if (!status?.group || path.basename(status.group) !== scope) {
      throw new ExecutionError("execution_unavailable", "无法核实原生执行的 user scope 身份", unit, exited ? "worker_failed" : "policy_missing");
    }
    tracking?.observed(status);
    fs.accessSync(path.join(cgroup!, "cgroup.kill"), fs.constants.W_OK);
    return unit;
  } catch (error) {
    if (error instanceof ExecutionError && error.unit) throw error;
    throw new ExecutionError("execution_unavailable", "原生执行无法核实 cgroup 回收能力", unit, "policy_missing");
  }
}
