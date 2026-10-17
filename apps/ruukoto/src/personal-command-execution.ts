/** Linux 单次命令的宿主证据；工作、权限和未知效果由 durable 调用方持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-command-execution.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { launchLinuxExecution, stopLinuxExecution, type LinuxExecutionRef } from "@ruukoto/agent/execution/native-linux-identity.ts";
import { ExecutionError, type LaunchedUnit, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import type { PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";
import { PersonalError } from "./personal-error.ts";

interface Output { bytes: number; sha256: string }
interface Binding { version: 1; ref: LinuxExecutionRef; fingerprint: string; launchFingerprint: string; temp: { path: string; dev: number; ino: number } }
export interface PersonalCommandReceipt {
  version: 1;
  ref: LinuxExecutionRef;
  fingerprint: string;
  exit: { code: number; signal: null };
  stdout: Output;
  stderr: Output;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const personalCommandFingerprint = (command: string, spec: LaunchSpec, input: PreparedNativeLaunch) => digest(JSON.stringify({ command, spec, input }));
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const invalid = () => new PersonalError("command_record_invalid", "原命令证据无法核实，请保留现场并查询原工作，勿重新执行。");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const covers = (root: string, target: string) => root === target || target.startsWith(root + path.sep);

function privateObject(target: string, directory: boolean) {
  const stat = fs.lstatSync(target);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw invalid();
  return stat;
}

function location(directory: string, ref: LinuxExecutionRef) {
  if (!/^native_[0-9a-f]{24}$/.test(ref.executionId) || !/^[0-9a-f]{32}$/.test(ref.machineId)) throw invalid();
  privateObject(directory, true);
  if (fs.realpathSync(directory) !== directory || fs.readFileSync("/etc/machine-id", "utf8").trim() !== ref.machineId) throw invalid();
  return path.join(directory, `command-${ref.executionId}`);
}

function readJson(target: string): unknown {
  privateObject(target, false);
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function writeJson(target: string, value: object) {
  fs.writeFileSync(target, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
}

function tempPath(target: string) {
  return path.dirname(target) === fs.realpathSync(os.tmpdir()) && /^ruukoto-native-[a-zA-Z0-9]+$/.test(path.basename(target));
}

const tempClaim = (directory: string, temp: Binding["temp"]) => path.join(directory, `temp-${digest(temp.path)}-${temp.dev}-${temp.ino}.json`);

function readBinding(record: string, ref: LinuxExecutionRef): Binding | undefined {
  try { privateObject(record, true); } catch (error) { if (missing(error)) return; throw error; }
  let raw: unknown;
  try { raw = readJson(path.join(record, "request.json")); } catch (error) { if (missing(error)) return; throw error; }
  if (!object(raw) || raw.version !== 1 || !isDeepStrictEqual(raw.ref, ref) || !hex(raw.fingerprint) || !object(raw.temp) ||
      typeof raw.temp.path !== "string" || !tempPath(raw.temp.path) || !Number.isSafeInteger(raw.temp.dev) || !Number.isSafeInteger(raw.temp.ino) ||
      !object(raw.request) || !object(raw.request.input) || !object(raw.request.spec) || raw.request.input.tempDir !== raw.temp.path || digest(JSON.stringify(raw.request)) !== raw.fingerprint) throw invalid();
  const owner = readJson(tempClaim(path.dirname(record), { path: raw.temp.path, dev: Number(raw.temp.dev), ino: Number(raw.temp.ino) }));
  if (!isDeepStrictEqual(owner, { ref, temp: raw.temp })) throw invalid();
  return { version: 1, ref, fingerprint: raw.fingerprint, launchFingerprint: digest(JSON.stringify({ input: raw.request.input, spec: raw.request.spec })), temp: { path: raw.temp.path, dev: Number(raw.temp.dev), ino: Number(raw.temp.ino) } };
}

async function outputDigest(target: string): Promise<Output> {
  privateObject(target, false);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(target)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}

/** 缺回执返回 undefined；损坏、异机器或异版本拒绝。只读原结果，不取得执行权。 */
export async function readPersonalCommandReceipt(directory: string, ref: LinuxExecutionRef, expectedFingerprint?: string): Promise<PersonalCommandReceipt | undefined> {
  try {
    const record = location(directory, ref), binding = readBinding(record, ref);
    if (expectedFingerprint !== undefined && binding?.fingerprint !== expectedFingerprint) throw invalid();
    let raw: unknown;
    try { raw = readJson(path.join(record, "receipt.json")); } catch (error) { if (missing(error)) return; throw error; }
    if (!binding || !object(raw) || raw.version !== 1 || !isDeepStrictEqual(raw.ref, ref) || raw.fingerprint !== binding.fingerprint ||
        !object(raw.exit) || !Number.isInteger(raw.exit.code) || Number(raw.exit.code) < 0 || Number(raw.exit.code) > 255 || raw.exit.signal !== null) throw invalid();
    const stdout = await outputDigest(path.join(record, "stdout")), stderr = await outputDigest(path.join(record, "stderr"));
    if (!isDeepStrictEqual(raw.stdout, stdout) || !isDeepStrictEqual(raw.stderr, stderr)) throw invalid();
    return { version: 1, ref, fingerprint: binding.fingerprint, exit: { code: Number(raw.exit.code), signal: null }, stdout, stderr };
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("command_record_invalid", "原命令证据无法读取，请保留现场并查询原工作，勿重新执行。", { cause: error });
  }
}

/** 原字节分页；没有完成回执时只提供已捕获片段，不能据此确认效果。 */
export async function readPersonalCommandOutput(directory: string, ref: LinuxExecutionRef, fingerprint: string, stream: "stdout" | "stderr", offset = 0) {
  try {
    if (!["stdout", "stderr"].includes(stream) || !Number.isSafeInteger(offset) || offset < 0) throw invalid();
    const record = location(directory, ref), binding = readBinding(record, ref);
    if (!binding || binding.fingerprint !== fingerprint) throw invalid();
    const receipt = await readPersonalCommandReceipt(directory, ref);
    if (receipt && receipt.fingerprint !== fingerprint) throw invalid();
    const target = path.join(record, stream);
    let stat: fs.Stats;
    try { stat = privateObject(target, false); } catch (error) { if (missing(error) && !receipt) return { data: "", bytes: 0, complete: false }; throw error; }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) throw invalid();
      const buffer = Buffer.alloc(Math.min(3072, Math.max(0, stat.size - offset)));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
      return { data: buffer.subarray(0, bytes).toString("base64"), bytes: stat.size, complete: !!receipt, ...(offset + bytes < stat.size ? { nextOffset: offset + bytes } : {}) };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("command_record_invalid", "原命令输出无法核实，请保留现场并报告拥有者。", { cause: error });
  }
}

/** 无内存句柄也按原引用停止；仅在退出且原目录身份相符时清理，命令证据保留。
 * 恢复传原请求指纹，强制核对请求与原 launch 认领，缺证据不新建停止认领。
 */
export async function stopPersonalCommand(directory: string, ref: LinuxExecutionRef, expectedFingerprint?: string) {
  try {
    const original = expectedFingerprint === undefined ? undefined : readBinding(location(directory, ref), ref);
    if (expectedFingerprint !== undefined && original?.fingerprint !== expectedFingerprint) throw invalid();
    const stopped = await stopLinuxExecution(directory, ref, original?.launchFingerprint);
    if (!stopped.exited) return { ...stopped, cleaned: false };
    const binding = readBinding(location(directory, ref), ref);
    if (!binding) return { ...stopped, cleaned: false };
    let stat: fs.Stats;
    try { stat = fs.lstatSync(binding.temp.path); } catch (error) { if (missing(error)) return { ...stopped, cleaned: true }; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.dev !== binding.temp.dev || stat.ino !== binding.temp.ino) return { ...stopped, cleaned: false };
    fs.rmSync(binding.temp.path, { recursive: true });
    return { ...stopped, cleaned: true };
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("command_stop_unverified", "原命令停止或临时目录清理无法核实，请保留占用与现场。", { cause: error });
  }
}

async function capture(source: NodeJS.ReadableStream, target: string, signal: AbortSignal): Promise<Output> {
  const hash = createHash("sha256");
  let bytes = 0;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); } });
  await pipeline(source, counter, fs.createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal });
  return { bytes, sha256: hash.digest("hex") };
}

/** 调用前持久保存工作与 ref，input 由个人 worker/空依赖 prepare；任何重复调用均拒绝。
 * 返回回执仅证明宿主观察到运行返回，不证明业务效果；exited 为独立停止事实。
 */
export async function runPersonalCommand(options: { directory: string; ref: LinuxExecutionRef; command: string; spec: LaunchSpec; input: PreparedNativeLaunch; timeoutMs: number; signal?: AbortSignal }) {
  const { directory, ref, command, spec, input, timeoutMs } = structuredClone({ ...options, signal: undefined });
  let record: string;
  try {
    if (!command.trim() || command.includes("\0") || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1 ||
        !["confirm", "auto-review"].includes(spec.mode) || !spec.workspaceIdentity || input.workspace !== spec.workspace) throw invalid();
    const payload = JSON.stringify({ command, workspace: { path: spec.workspace, ...spec.workspaceIdentity } });
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw invalid();
    record = location(directory, ref);
    if (fs.existsSync(record)) throw new PersonalError("command_already_claimed", "原命令已登记，请查询原回执与停止状态，勿重新执行。");
    for (const root of [input.tempDir, ...input.mounts.map(mount => mount.path), ...input.runtimeReadRoots, ...input.toolAliases.flatMap(alias => [alias.path, alias.target])]) {
      if (covers(root, directory) || covers(directory, root)) throw invalid();
    }
    if (!tempPath(input.tempDir) || fs.realpathSync(input.tempDir) !== input.tempDir) throw invalid();
    const temp = privateObject(input.tempDir, true);
    options.signal?.throwIfAborted();
    try { fs.mkdirSync(record, { mode: 0o700 }); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new PersonalError("command_already_claimed", "原命令已登记，请查询原回执与停止状态，勿重新执行。");
      throw error;
    }
    const request = { command, spec, input };
    const identity = { path: input.tempDir, dev: temp.dev, ino: temp.ino };
    writeJson(tempClaim(directory, identity), { ref, temp: identity });
    writeJson(path.join(record, "request.json"), { version: 1, ref, fingerprint: digest(JSON.stringify(request)), temp: identity, request });
  } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("command_admission_failed", "命令登记失败，未请求新执行；请查询原记录。", { cause: error });
  }
  const controller = new AbortController();
  let earlyStop: Promise<unknown> | undefined;
  let earlyError: unknown;
  let unit: LaunchedUnit | undefined;
  const interrupt = () => {
    controller.abort();
    earlyStop ??= stopLinuxExecution(directory, ref, digest(JSON.stringify({ input, spec }))).catch(error => { earlyError = error; });
  };
  const timer = setTimeout(interrupt, timeoutMs);
  options.signal?.addEventListener("abort", interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  let failure: unknown;
  let receipt: PersonalCommandReceipt | undefined;
  let captures: Promise<Output>[] = [];
  try {
    unit = await launchLinuxExecution(directory, ref, input, spec);
    const stdout = capture(unit.stdout, path.join(record, "stdout"), controller.signal);
    const stderr = capture(unit.stderr, path.join(record, "stderr"), controller.signal);
    captures = [stdout, stderr];
    const written = new Promise<void>((resolve, reject) => {
      unit!.stdin.on("error", reject);
      if (controller.signal.aborted) { reject(controller.signal.reason); return; }
      unit!.stdin.end(JSON.stringify({ command, workspace: { path: spec.workspace, ...spec.workspaceIdentity! } }), (error?: Error | null) => error ? reject(error) : resolve());
    });
    const [out, err, exit] = await Promise.all([stdout, stderr, unit.exit, written]);
    controller.signal.throwIfAborted();
    if (exit.signal !== null || exit.code === null || fs.existsSync(path.join(directory, ref.executionId, "stop-requested"))) throw new PersonalError("command_interrupted", "原命令未正常返回或已请求停止，效果待核实；请查询原工作，勿重新执行。");
    receipt = { version: 1, ref, fingerprint: digest(JSON.stringify({ command, spec, input })), exit: { code: exit.code, signal: null }, stdout: out, stderr: err };
    writeJson(path.join(record, "receipt-pending.json"), receipt);
    fs.renameSync(path.join(record, "receipt-pending.json"), path.join(record, "receipt.json"));
  } catch (error) {
    failure = error;
    if (error instanceof ExecutionError && error.unit) unit = error.unit;
    controller.abort();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", interrupt);
    unit?.stdin.destroy();
    if (unit?.stdout instanceof Readable) unit.stdout.destroy();
    if (unit?.stderr instanceof Readable) unit.stderr.destroy();
    await Promise.allSettled(captures);
  }
  await earlyStop;
  let stopped: Awaited<ReturnType<typeof stopPersonalCommand>>;
  try { stopped = await stopPersonalCommand(directory, ref, personalCommandFingerprint(command, spec, input)); } catch (error) {
    throw new PersonalError("command_stop_unverified", "原命令停止或清理无法核实，请保留占用并查询原回执。", { cause: new AggregateError([failure, earlyError, error].filter(value => value !== undefined)) });
  }
  if (failure !== undefined || !receipt) throw new PersonalError("command_result_unknown", "原命令没有完整宿主回执，效果待核实；请保留原工作，勿重新执行。", { cause: failure });
  return { receipt, ...stopped };
}
