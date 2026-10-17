/** Linux 受限执行的持久认领；效果回执与工作占用仍由调用方持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-native-linux-execution-identity.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { ExecutionError, type LaunchSpec, type LaunchedUnit } from "./launchers.ts";
import { launchLinuxNative, linuxNativeScopeEmpty } from "./native-linux.ts";
import type { PreparedNativeLaunch } from "./native.ts";

export interface LinuxExecutionRef {
  executionId: string;
  machineId: string;
}

export interface LinuxExecutionStop {
  ref: LinuxExecutionRef;
  exited: boolean;
}

interface Claim {
  version: 1;
  ref: LinuxExecutionRef;
  bootId: string;
  claimedBy: "launch" | "stop";
  scope: string;
  token: string;
  fingerprint: string;
}

interface LauncherIdentity { pid: number; startTime: string; processGroup: number }
interface Observation { group: string; invocationId: string; dev: number; ino: number }

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const unavailable = (message: string): ExecutionError => new ExecutionError("execution_identity_invalid", message);
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code));
const covers = (root: string, target: string): boolean => root === target || target.startsWith(root + path.sep);

function privatePath(target: string, directory: boolean): fs.Stats {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw unavailable("原执行证据目录或文件不可信；保留占用并核实原档案");
  }
  return stat;
}

function location(directory: string, ref: LinuxExecutionRef): { claimDir: string; bootId: string; scope: string } {
  if (!/^native_[0-9a-f]{24}$/.test(ref.executionId) || !HEX32.test(ref.machineId)) throw unavailable("原执行引用非法；保留占用并核实原档案");
  privatePath(directory, true);
  if (fs.realpathSync(directory) !== directory) throw unavailable("执行证据目录须使用真实路径");
  if (fs.readFileSync("/etc/machine-id", "utf8").trim() !== ref.machineId) throw unavailable("原执行不属于本机；保留占用并核实原机器");
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!UUID.test(bootId)) throw unavailable("无法核实本机启动身份；保留占用");
  return { claimDir: path.join(directory, ref.executionId), bootId, scope: `ruukoto-${ref.executionId}.scope` };
}

function record(claimDir: string, name: string): Record<string, unknown> | null {
  const target = path.join(claimDir, name);
  privatePath(target, false);
  const value: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function writeRecord(claimDir: string, name: string, value: object): void {
  fs.writeFileSync(path.join(claimDir, name), JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
}

function readClaim(claimDir: string, ref: LinuxExecutionRef, scope: string): Claim | null {
  privatePath(claimDir, true);
  const raw = record(claimDir, "claim.json");
  if (!raw || raw.version !== 1 || !raw.ref || typeof raw.ref !== "object") return null;
  const saved = raw.ref as Record<string, unknown>;
  if (saved.executionId !== ref.executionId || saved.machineId !== ref.machineId || raw.scope !== scope ||
      typeof raw.bootId !== "string" || !UUID.test(raw.bootId) || typeof raw.token !== "string" || !HEX32.test(raw.token) ||
      typeof raw.fingerprint !== "string" || !HEX64.test(raw.fingerprint) || !["launch", "stop"].includes(String(raw.claimedBy))) return null;
  return raw as unknown as Claim;
}

function processIdentity(pid: number): LauncherIdentity {
  const source = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = source.slice(source.lastIndexOf(") ") + 2).trim().split(/\s+/);
  const processGroup = Number(fields[2]);
  if (!Number.isSafeInteger(processGroup) || processGroup !== pid || !/^\d+$/.test(fields[19] ?? "")) throw unavailable("无法核实独立启动器身份；保留执行占用");
  return { pid, startTime: fields[19], processGroup };
}

function launcherExited(raw: Record<string, unknown> | null): boolean {
  if (!raw || !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 || raw.processGroup !== raw.pid ||
      typeof raw.startTime !== "string" || !/^\d+$/.test(raw.startTime)) return false;
  let current: LauncherIdentity;
  try { current = processIdentity(Number(raw.pid)); }
  catch (error) { if (!isMissing(error)) return false; current = { pid: 0, processGroup: 0, startTime: "" }; }
  if (current.startTime === raw.startTime) return false;
  // 持久进程组只用于观察；PID/PGID 复用至多保守阻塞，不能成为发信号的依据。
  try { process.kill(-Number(raw.processGroup), 0); return false; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
}

function observation(raw: Record<string, unknown> | null, scope: string): Observation | null {
  if (!raw || typeof raw.group !== "string" || !path.isAbsolute(raw.group) || path.normalize(raw.group) !== raw.group ||
      !raw.group.startsWith("/sys/fs/cgroup/") || path.basename(raw.group) !== scope ||
      typeof raw.invocationId !== "string" || !HEX32.test(raw.invocationId) || /^0+$/.test(raw.invocationId) ||
      !Number.isSafeInteger(raw.dev) || !Number.isSafeInteger(raw.ino)) return null;
  return raw as unknown as Observation;
}

async function unitState(scope: string): Promise<Record<string, string> | null> {
  return new Promise(resolve => execFile("/usr/bin/systemctl", ["--user", "show", scope, "--property", "LoadState,ActiveState,ControlGroup,InvocationID,Description"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const fields: Record<string, string> = {};
      for (const line of stdout.trim().split("\n")) {
        const index = line.indexOf("=");
        if (index <= 0 || Object.hasOwn(fields, line.slice(0, index))) { resolve(null); return; }
        fields[line.slice(0, index)] = line.slice(index + 1);
      }
      resolve(fields);
    }));
}

/** 同 ID 永不重启；调用前由宿主持久保存 ref。已创建单元的失败仍交出停止句柄。 */
export async function launchLinuxExecution(directory: string, ref: LinuxExecutionRef, input: PreparedNativeLaunch, spec: LaunchSpec): Promise<LaunchedUnit> {
  let claimDir: string;
  let claim: Claim;
  try {
    const locationInfo = location(directory, ref);
    claimDir = locationInfo.claimDir;
    if (spec.mode === "full_access") throw unavailable("持久原生执行只支持受限模式");
    for (const root of [input.tempDir, ...input.mounts.map(mount => mount.path), ...input.runtimeReadRoots, ...input.toolAliases.flatMap(alias => [alias.path, alias.target])]) {
      if (covers(root, directory) || covers(directory, root)) throw unavailable("执行证据目录与工作进程可见范围重叠；请使用独立保护目录");
    }
    claim = { version: 1, ref, bootId: locationInfo.bootId, scope: locationInfo.scope, claimedBy: "launch",
      token: randomBytes(16).toString("hex"), fingerprint: createHash("sha256").update(JSON.stringify({ input, spec })).digest("hex") };
    fs.mkdirSync(claimDir, { mode: 0o700 });
    writeRecord(claimDir, "claim.json", claim);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_claim_failed", "执行身份认领失败或已被认领；未启动新执行", undefined, undefined, { cause: error });
  }
  let attempted = false;
  let launcher: LauncherIdentity | undefined;
  const stop = async (): Promise<boolean> => (await stopLinuxExecution(directory, ref)).exited;
  try {
    const unit = await launchLinuxNative(input, spec, {
      scope: claim.scope, description: `ruukoto-execution-${claim.token}`,
      beforeSpawn() {
        if (fs.existsSync(path.join(claimDir, "stop-requested"))) throw unavailable("原执行已请求停止；未启动新执行");
        attempted = true;
      },
      spawned(pid) { launcher = processIdentity(pid); writeRecord(claimDir, "launcher.json", launcher); },
      observed(state) {
        if (!launcher || state.description !== `ruukoto-execution-${claim.token}` ||
            !fs.readFileSync(`/proc/${launcher.pid}/cgroup`, "utf8").split("\n").includes(`0::${state.group}`)) throw unavailable("原执行的单元归属无法核实；保留占用");
        const group = path.join("/sys/fs/cgroup", state.group);
        const stat = fs.statSync(group);
        const saved = observation({ group, invocationId: state.invocationId, dev: stat.dev, ino: stat.ino }, claim.scope);
        if (!saved) throw unavailable("原执行的单元身份无法核实；保留占用");
        writeRecord(claimDir, "observation.json", saved);
      },
    });
    unit.entry.stop = stop;
    return unit;
  } catch (error) {
    if (error instanceof ExecutionError && error.unit) { error.unit.entry.stop = stop; throw error; }
    if (!attempted) {
      try { writeRecord(claimDir, "not-dispatched.json", { token: claim.token }); }
      catch (proofError) {
        throw new ExecutionError("execution_identity_invalid", "原执行启动失败且未派发证据无法保存；保留占用与现场", undefined, undefined,
          { cause: new AggregateError([error, proofError], "启动与证据写入均失败") });
      }
    }
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_unavailable", "原执行启动失败；保留认领并核实停止", undefined, undefined, { cause: error });
  }
}

/** 可跨进程重复重核；false 保留原占用，不证明效果或允许重放。
 * 传预期启动指纹时只接受原 launch 认领，缺记录或 stop 先手均不能证明原执行退出。
 */
export async function stopLinuxExecution(directory: string, ref: LinuxExecutionRef, expectedFingerprint?: string): Promise<LinuxExecutionStop> {
  const result = (exited: boolean): LinuxExecutionStop => ({ ref, exited });
  try {
    const { claimDir, bootId, scope } = location(directory, ref);
    if (expectedFingerprint !== undefined) {
      const claim = readClaim(claimDir, ref, scope);
      if (!HEX64.test(expectedFingerprint) || claim?.claimedBy !== "launch" || claim.fingerprint !== expectedFingerprint) return result(false);
    } else {
      let created = false;
      try { fs.mkdirSync(claimDir, { mode: 0o700 }); created = true; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      if (created) writeRecord(claimDir, "claim.json", { version: 1, ref, bootId, scope, claimedBy: "stop", token: randomBytes(16).toString("hex"), fingerprint: "0".repeat(64) });
    }
    privatePath(claimDir, true);
    try { fs.mkdirSync(path.join(claimDir, "stop-requested"), { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    privatePath(path.join(claimDir, "stop-requested"), true);
    const claim = readClaim(claimDir, ref, scope);
    if (!claim) return result(false);
    if (expectedFingerprint !== undefined && (claim.claimedBy !== "launch" || claim.fingerprint !== expectedFingerprint)) return result(false);
    if (claim.claimedBy === "stop" || claim.bootId !== bootId) return result(true);
    const optionalRecord = (name: string): Record<string, unknown> | null => {
      try { return record(claimDir, name); }
      catch (error) { if (isMissing(error)) return null; throw error; }
    };
    if (optionalRecord("not-dispatched.json")?.token === claim.token) return result(true);
    const deadline = Date.now() + 5000;
    do {
      const saved = observation(optionalRecord("observation.json"), scope);
      if (!saved) return result(false);
      const state = await unitState(scope);
      if (!state) return result(false);
      const sameUnit = state.InvocationID === saved.invocationId && state.Description === `ruukoto-execution-${claim.token}`;
      const inactive = state.LoadState === "not-found" || (sameUnit && state.LoadState === "loaded" && ["inactive", "failed"].includes(state.ActiveState));
      let directoryFd: number | undefined;
      try {
        directoryFd = fs.openSync(saved.group, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      } catch (error) { if (!isMissing(error)) return result(false); }
      try {
        if (directoryFd === undefined) {
          if (inactive && launcherExited(optionalRecord("launcher.json"))) return result(true);
          return result(false);
        }
        const stat = fs.fstatSync(directoryFd);
        if (stat.dev !== saved.dev || stat.ino !== saved.ino) return result(false);
        if (!inactive) {
          if (!sameUnit || path.join("/sys/fs/cgroup", state.ControlGroup ?? "") !== saved.group) return result(false);
          const killFd = fs.openSync(`/proc/self/fd/${directoryFd}/cgroup.kill`, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
          try { fs.writeSync(killFd, "1"); } finally { fs.closeSync(killFd); }
        }
        if (linuxNativeScopeEmpty(`/proc/self/fd/${directoryFd}`) && inactive && launcherExited(optionalRecord("launcher.json"))) return result(true);
      } catch { return result(false); } // 原组证据或停止写入失败不能证明已退出。
      finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return result(false);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_identity_invalid", "原执行证据无法核实；保留占用与现场", undefined, undefined, { cause: error });
  }
}
