/** macOS 执行的私有认领与停止证据；工作归属与效果回执由调用方持有。
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-background-processes.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { ExecutionError, workerEnv, type LaunchedUnit, type LaunchSpec } from "./launchers.ts";
import type { PreparedNativeLaunch } from "./native.ts";
import { macosNativeProfile } from "./native-macos.ts";

export interface MacosExecutionRef { executionId: string }
export interface MacosExecutionStop { ref: MacosExecutionRef; exited: boolean; outputComplete?: boolean }
interface HostIdentity { machineId: string; bootId: string }
interface Claim extends HostIdentity {
  version: 1;
  ref: MacosExecutionRef;
  claimedBy: "launch" | "stop";
  token: string;
  fingerprint: string;
  directoryDev: string;
  directoryIno: string;
}
interface Supervisor extends HostIdentity {
  type: "supervisor";
  token: string;
  fingerprint: string;
  directoryDev: string;
  directoryIno: string;
  pid: number;
  uniqueid: string;
  seconds: string;
  microseconds: string;
  pidversion: number;
}

const helper = fileURLToPath(new URL("../../../../worker/native-macos-supervisor", import.meta.url));
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^\d+$/;
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const unavailable = (message: string): ExecutionError => new ExecutionError("execution_identity_invalid", message);

function privateStat(stat: fs.Stats, directory: boolean): void {
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw unavailable("原执行证据不可信；保留占用与现场，核实原档案");
  }
}

function location(directory: string, ref: MacosExecutionRef): string {
  if (process.platform !== "darwin" || !/^native_[0-9a-f]{24}$/.test(ref.executionId)) throw unavailable("执行引用或平台不匹配；保留原占用");
  privateStat(fs.lstatSync(directory), true);
  if (fs.realpathSync(directory) !== directory) throw unavailable("执行证据目录须使用真实路径");
  return path.join(directory, ref.executionId);
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { privateStat(fs.fstatSync(fd), true); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function writeRecord(directory: string, name: string, value: object): void {
  const fd = fs.openSync(path.join(directory, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(directory);
}

function record(directory: string, name: string, journal = false): Record<string, unknown> | null {
  let fd: number;
  try { fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return null; throw error; }
  let source: string;
  try {
    const stat = fs.fstatSync(fd);
    privateStat(stat, false);
    if (stat.size > 8192) throw unavailable("原执行证据超出预算；保留占用与现场");
    source = fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
  if (journal ? !source.includes("\n") : !source.endsWith("\n")) return null;
  const raw: unknown = JSON.parse(journal ? source.split("\n", 1)[0] : source);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function readClaim(directory: string, ref: MacosExecutionRef): Claim | null {
  const stat = fs.lstatSync(directory);
  privateStat(stat, true);
  const raw = record(directory, "claim.json");
  if (!raw || raw.directoryDev !== String(stat.dev) || raw.directoryIno !== String(stat.ino) || raw.version !== 1 || typeof raw.ref !== "object" || raw.ref === null || !("executionId" in raw.ref) || raw.ref.executionId !== ref.executionId ||
      typeof raw.machineId !== "string" || !UUID.test(raw.machineId) || typeof raw.bootId !== "string" || !UUID.test(raw.bootId) ||
      typeof raw.token !== "string" || !HEX32.test(raw.token) || typeof raw.fingerprint !== "string" || !HEX64.test(raw.fingerprint) || !["launch", "stop"].includes(String(raw.claimedBy))) return null;
  return raw as unknown as Claim;
}

function readSupervisor(directory: string, claim: Claim): Supervisor | null {
  const raw = record(directory, "supervisor.jsonl", true);
  const stat = fs.lstatSync(directory);
  if (!raw || raw.type !== "supervisor" || raw.token !== claim.token || raw.fingerprint !== claim.fingerprint || raw.machineId !== claim.machineId || raw.bootId !== claim.bootId ||
      raw.directoryDev !== String(stat.dev) || raw.directoryIno !== String(stat.ino) || !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 || Number(raw.pid) > 0x7fff_ffff ||
      !Number.isInteger(raw.pidversion) || Number(raw.pidversion) < -0x8000_0000 || Number(raw.pidversion) > 0x7fff_ffff ||
      ![raw.uniqueid, raw.seconds, raw.microseconds].every(value => typeof value === "string" && DECIMAL.test(value)) || raw.uniqueid === "0") return null;
  return raw as unknown as Supervisor;
}

function receipt(directory: string, claim: Claim): boolean | null {
  const raw = record(directory, "stopped.json");
  if (!raw) return null;
  if (raw.type !== "stopped" || raw.token !== claim.token || raw.fingerprint !== claim.fingerprint || typeof raw.reaped !== "boolean" ||
      typeof raw.reason !== "string" || typeof raw.stdoutEof !== "boolean" || typeof raw.stderrEof !== "boolean" || typeof raw.outputComplete !== "boolean") return false;
  return raw.reaped && raw.stdoutEof && raw.stderrEof;
}

function helperCall(args: string[]): Promise<string | null> {
  return new Promise(resolve => execFile(helper, args, { encoding: "utf8", timeout: 5000, maxBuffer: 8192, env: { PATH: "/usr/bin:/bin" } }, (error, stdout) => resolve(error ? null : stdout)));
}

/** 继承与 direct Driver 相同的宿主责任链，只读授权位；不提示授权，也不证明实际截图可用。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
export async function readMacosCuaPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
  if (process.platform !== "darwin") throw new ExecutionError("execution_unavailable", "本机电脑权限检查仅支持 macOS；请在 Code 所在 Mac 上核实授权。");
  const output = await helperCall(["--cua-permissions"]);
  if (output === null) throw new ExecutionError("execution_unavailable", "无法读取本机电脑权限；请重建原生 helper 后重新检查。", undefined, "binary_missing");
  let raw: unknown;
  try { raw = JSON.parse(output); }
  catch (error) { throw new ExecutionError("execution_identity_invalid", "本机电脑权限结果无效；请重建原生 helper 后重新检查。", undefined, undefined, { cause: error }); }
  if (typeof raw !== "object" || raw === null || !("accessibility" in raw) || typeof raw.accessibility !== "boolean" || !("screenRecording" in raw) || typeof raw.screenRecording !== "boolean") throw unavailable("本机电脑权限结果不完整；请重建原生 helper 后重新检查。");
  return { accessibility: raw.accessibility, screenRecording: raw.screenRecording };
}

async function hostIdentity(): Promise<HostIdentity> {
  const output = await helperCall(["--host-identity"]);
  if (output === null) throw new ExecutionError("execution_unavailable", "macOS 持久监督器不可用；重建原生 helper 并核实平台能力", undefined, "binary_missing");
  const raw: unknown = JSON.parse(output);
  if (typeof raw !== "object" || raw === null || !("machineId" in raw) || typeof raw.machineId !== "string" || !UUID.test(raw.machineId) ||
      !("bootId" in raw) || typeof raw.bootId !== "string" || !UUID.test(raw.bootId)) throw unavailable("无法核实本机执行身份；保留占用");
  return { machineId: raw.machineId, bootId: raw.bootId };
}

/** 同 ID 只认领一次；宿主先持久保存 ref。受限执行沿只读挂载生成 Seatbelt，完全访问继承用户环境；失败保留原认领与停止身份。 */
export async function launchMacosExecution(directory: string, ref: MacosExecutionRef, input: PreparedNativeLaunch, spec: LaunchSpec): Promise<LaunchedUnit> {
  let claimDir: string;
  let claim: Claim;
  try {
    claimDir = location(directory, ref);
    if (input.workspace !== spec.workspace || spec.mode === "full_access" && (input.mounts.length || input.runtimeReadRoots.length || input.toolAliases.length || Object.keys(input.env).length || spec.env !== undefined)) {
      throw unavailable("持久 macOS 执行的原目录或模式输入不符");
    }
    if (directory === input.tempDir || directory.startsWith(input.tempDir + path.sep) || input.tempDir.startsWith(directory + path.sep)) throw unavailable("执行证据目录须与工作进程临时目录分开");
    const identity = await hostIdentity();
    fs.mkdirSync(claimDir, { mode: 0o700 });
    syncDirectory(directory);
    const stat = fs.lstatSync(claimDir);
    claim = { version: 1, ref, claimedBy: "launch", ...identity, directoryDev: String(stat.dev), directoryIno: String(stat.ino), token: randomBytes(16).toString("hex"), fingerprint: createHash("sha256").update(JSON.stringify({ input, spec })).digest("hex") };
    writeRecord(claimDir, "claim.json", claim);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_claim_failed", "执行身份已认领或保存失败；未启动新执行", undefined, undefined, { cause: error });
  }
  let dispatched = false;
  try {
    if (fs.existsSync(path.join(claimDir, "stop-requested"))) throw unavailable("原执行已请求停止；未启动新执行");
    if (spec.mode !== "full_access") fs.accessSync("/usr/bin/sandbox-exec", fs.constants.X_OK);
    writeRecord(claimDir, "dispatched.json", { token: claim.token, fingerprint: claim.fingerprint });
    const command = spec.mode === "full_access" ? [input.nodePath, input.workerPath] : ["/usr/bin/sandbox-exec", "-p", macosNativeProfile(input), input.nodePath, input.workerPath];
    const child = spawn(helper, ["--durable", claimDir, claim.token, claim.fingerprint, "--", ...command], {
      cwd: input.workspace, env: spec.mode === "full_access" ? workerEnv(spec) : input.env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    dispatched = child.pid !== undefined;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", error => reject(new ExecutionError("execution_unavailable", "macOS 持久监督器启动失败；保留原认领", undefined, "binary_missing", { cause: error })));
    });
    void exit.catch(() => undefined);
    if (!dispatched) { await exit; throw unavailable("macOS 持久监督器未创建"); }
    const status = child.stdio[3] as Readable;
    const control = child.stdio[4] as Writable;
    control.on("error", () => { /* 控制管道断开仍须从持久回执核实停止。 */ });
    const stop = async (): Promise<boolean> => {
      if (!control.destroyed) control.end("stop\n");
      return (await stopMacosExecution(directory, ref, claim.fingerprint)).exited;
    };
    const unit: LaunchedUnit = {
      entry: { kind: "process_group", id: ref.executionId, label: `macOS execution=${ref.executionId}`, stop },
      stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, exit,
    };
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error?: ExecutionError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { control.end(); reject(error); } else resolve();
      };
      const failed = (): void => finish(new ExecutionError("execution_identity_invalid", "原执行启动状态不可核实；保留占用并核实停止", unit));
      const timer = setTimeout(failed, 5000);
      status.setEncoding("utf8");
      status.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 8192) { failed(); return; }
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let raw: unknown;
          try { raw = JSON.parse(line); }
          catch { failed(); return; } // 不完整状态不作为停止证明。
          if (typeof raw !== "object" || raw === null || !("type" in raw)) { failed(); return; }
          if (raw.type === "started") {
            try { if (!readSupervisor(claimDir, claim)) { failed(); return; } }
            catch { failed(); return; } // 证据不可读时不放行启动成功。
            finish();
          } else if (raw.type === "failed" || raw.type === "stopped") failed();
          else { failed(); return; }
        }
      });
      status.once("error", failed);
      child.once("exit", failed);
      child.once("error", failed);
    });
    return unit;
  } catch (error) {
    if (!dispatched) {
      try { writeRecord(claimDir, "not-dispatched.json", { token: claim.token, fingerprint: claim.fingerprint }); }
      catch (proofError) {
        throw new ExecutionError("execution_identity_invalid", "启动失败且未派发证明无法保存；保留占用与现场", undefined, undefined, { cause: new AggregateError([error, proofError], "启动与证明保存均失败") });
      }
    }
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_unavailable", "原执行启动失败；保留认领并核实停止", undefined, undefined, { cause: error });
  }
}

/** 为 SDK 的三管道 stdio 启动保存原生认领；运行与停止仍由同一个持久监督器核实。 */
export async function prepareMacosStdioExecution(directory: string, ref: MacosExecutionRef, program: { command: string; args: string[]; env: Record<string, string>; cwd?: string }): Promise<{ command: string; args: string[]; env: Record<string, string>; cwd?: string; fingerprint: string }> {
  try {
    const claimDir = location(directory, ref);
    const identity = await hostIdentity();
    const fingerprint = createHash("sha256").update(JSON.stringify(program)).digest("hex");
    fs.mkdirSync(claimDir, { mode: 0o700 });
    syncDirectory(directory);
    const stat = fs.lstatSync(claimDir);
    const claim: Claim = { version: 1, ref, claimedBy: "launch", ...identity, directoryDev: String(stat.dev), directoryIno: String(stat.ino), token: randomBytes(16).toString("hex"), fingerprint };
    writeRecord(claimDir, "claim.json", claim);
    writeRecord(claimDir, "dispatched.json", { token: claim.token, fingerprint });
    return { command: helper, args: ["--durable-stdio", claimDir, claim.token, fingerprint, "--", program.command, ...program.args], env: program.env, cwd: program.cwd, fingerprint };
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_claim_failed", "电脑执行身份无法保存；未创建新连接，保留现场并核实原档案。", undefined, undefined, { cause: error });
  }
}

/** 可跨进程重复停止；仅匹配原认领与完整监督器身份。缺回执、身份换代或核实失败返回 false，不能重放命令或释放占用。 */
export async function stopMacosExecution(directory: string, ref: MacosExecutionRef, expectedFingerprint?: string): Promise<MacosExecutionStop> {
  let outputComplete: boolean | undefined;
  const result = (exited: boolean): MacosExecutionStop => ({ ref, exited, ...(outputComplete === undefined ? {} : { outputComplete }) });
  const stoppedReceipt = (claimDir: string, claim: Claim): boolean | null => {
    const stopped = receipt(claimDir, claim);
    if (stopped !== null) {
      const saved = record(claimDir, "stopped.json");
      if (typeof saved?.outputComplete === "boolean") outputComplete = saved.outputComplete;
    }
    return stopped;
  };
  try {
    const claimDir = location(directory, ref);
    const identity = await hostIdentity();
    if (expectedFingerprint === undefined) {
      let created = false;
      try { fs.mkdirSync(claimDir, { mode: 0o700 }); created = true; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      if (created) {
        syncDirectory(directory);
        const stat = fs.lstatSync(claimDir);
        writeRecord(claimDir, "claim.json", { version: 1, ref, claimedBy: "stop", ...identity, directoryDev: String(stat.dev), directoryIno: String(stat.ino), token: randomBytes(16).toString("hex"), fingerprint: "0".repeat(64) });
      }
    } else if (!HEX64.test(expectedFingerprint)) return result(false);
    let claim: Claim | null;
    try { claim = readClaim(claimDir, ref); }
    catch (error) { if (missing(error)) return result(false); throw error; }
    if (!claim || claim.machineId !== identity.machineId || claim.bootId !== identity.bootId ||
        expectedFingerprint !== undefined && (claim.claimedBy !== "launch" || claim.fingerprint !== expectedFingerprint)) return result(false);
    try { fs.mkdirSync(path.join(claimDir, "stop-requested"), { mode: 0o700 }); syncDirectory(claimDir); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    privateStat(fs.lstatSync(path.join(claimDir, "stop-requested")), true);
    if (claim.claimedBy === "stop") return result(true);
    const proof = record(claimDir, "not-dispatched.json");
    if (proof?.token === claim.token && proof.fingerprint === claim.fingerprint) return result(true);
    const deadline = Date.now() + 6500;
    let signaled = false;
    do {
      const stopped = stoppedReceipt(claimDir, claim);
      if (stopped !== null) return result(stopped);
      const supervisor = readSupervisor(claimDir, claim);
      if (supervisor && !signaled) {
        const sent = await helperCall(["--signal-supervisor", supervisor.machineId, supervisor.bootId, String(supervisor.pid), supervisor.uniqueid, supervisor.seconds, supervisor.microseconds, String(supervisor.pidversion >>> 0)]);
        if (sent === null) return result(stoppedReceipt(claimDir, claim) === true);
        signaled = true;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return result(false);
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError("execution_identity_invalid", "原执行证据无法核实；保留占用与现场", undefined, undefined, { cause: error });
  }
}
