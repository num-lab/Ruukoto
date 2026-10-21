import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { defineExtension } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { FILE_SEARCH_BYTES, FILE_SEARCH_TIMEOUT_MS, fileSearchParams, type FileSearchName, type FileSearchResult } from "@ruukoto/agent/file-search.ts";
import { resolveFileSearchExecutable, type SearchRoot } from "@ruukoto/agent/tool-worker/file-search.ts";
import { backgroundExecutionRef, stopBackgroundExecution } from "@ruukoto/agent/execution/background.ts";
import { launchLinuxExecution, stopLinuxExecution } from "@ruukoto/agent/execution/native-linux-identity.ts";
import { launchMacosExecution, stopMacosExecution } from "@ruukoto/agent/execution/native-macos-identity.ts";
import { prepareNativeLaunch, type PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";
import { ExecutionError, type LaunchSpec, type LaunchedUnit } from "@ruukoto/agent/execution/launchers.ts";
import { restrictedResolve } from "@ruukoto/agent/execution/approved-ops.ts";
import { personalProtectedRoots } from "./personal-command-config.ts";
import { PersonalError } from "./personal-error.ts";

export const PERSONAL_FILE_SEARCH = "personal-file-search";
export const personalFileSearch = defineExtension({ name: PERSONAL_FILE_SEARCH });
export type PersonalFileSearchRequest = { name: FileSearchName; params: Record<string, JsonValue>; cwd: string; executable: string; roots: { [K in keyof SearchRoot]: SearchRoot[K] }[] | null };
export type PreparedPersonalFileSearch = { request: PersonalFileSearchRequest; ref: { [K in keyof ReturnType<typeof backgroundExecutionRef>]: ReturnType<typeof backgroundExecutionRef>[K] }; input: { [K in keyof PreparedNativeLaunch]: PreparedNativeLaunch[K] }; spec: Omit<LaunchSpec, "grantedPaths"> & { grantedPaths: Array<Pick<LaunchSpec["grantedPaths"][number], keyof LaunchSpec["grantedPaths"][number]>> }; fingerprint: string; scratch: { path: string; dev: number; ino: number; birthtimeMs: number }; temporary: { path: string; dev: number; ino: number; birthtimeMs: number } };
const workerPath = fileURLToPath(new URL("../../../worker/personal-file-search-worker.mjs", import.meta.url));
const executionDirectory = (profile: string) => path.join(profile, "file-search");
const fingerprint = (input: PreparedNativeLaunch, spec: LaunchSpec) => createHash("sha256").update(JSON.stringify({ input, spec })).digest("hex");
function pinSearchDirectory(target: string) {
  const root = restrictedResolve(target), stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new PersonalError("file_search_not_directory", "path必须是现有目录，已知文件请用read_file读取。");
  return { path: root, dev: stat.dev, ino: stat.ino };
}
export function personalSearchDirectory(target: string) {
  try { return pinSearchDirectory(target); }
  catch (cause) { if (cause instanceof PersonalError) throw cause; throw new PersonalError("file_search_path_unavailable", "检索目录不可访问或包含链接，未扫描；请核实资料目录后重新提交。", { cause }); }
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-personal-file-search.md
export async function preparePersonalFileSearch(profile: string, operation: string, request: PersonalFileSearchRequest, mode: "confirm" | "auto-review" | "full_access"): Promise<PreparedPersonalFileSearch> {
  fileSearchParams(request.name, request.params);
  const scratchPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-search-"))), stat = fs.statSync(scratchPath);
  const spec: LaunchSpec = { taskId: operation, mode, workspace: scratchPath, workspaceIdentity: { dev: stat.dev, ino: stat.ino }, grantedPaths: [], ...(request.roots ? { readRoots: request.roots } : {}) };
  try {
    const input = mode === "full_access" ? { workspace: scratchPath, workerPath: fs.realpathSync(workerPath), nodePath: fs.realpathSync(process.execPath), tempDir: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-native-"))), mounts: [], runtimeReadRoots: [], toolAliases: [], env: {} } : await prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots: personalProtectedRoots(profile) }, spec);
    const temporary = fs.statSync(input.tempDir);
    return { request, spec, input, ref: backgroundExecutionRef(), fingerprint: fingerprint(input, spec), scratch: { path: scratchPath, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }, temporary: { path: input.tempDir, dev: temporary.dev, ino: temporary.ino, birthtimeMs: temporary.birthtimeMs } };
  } catch (cause) {
    fs.rmdirSync(scratchPath);
    throw new PersonalError("file_search_unavailable", "检索的原生只读执行入口不可用，未扫描；请由拥有者检查原生前提与构建。", { cause });
  }
}

export function personalSearchExecutable(): string {
  const executable = resolveFileSearchExecutable();
  if (!executable) throw new PersonalError("file_search_unavailable", "宿主未安装可用 rg，未扫描；请由拥有者安装 ripgrep 并重启后台。");
  return executable;
}

export function verifyPersonalFileSearch(value: PreparedPersonalFileSearch, launching = false) {
  if (!value?.request || !value.spec || !value.input || !value.scratch || !value.temporary || !Array.isArray(value.input.mounts) || !value.ref || !/^native_[0-9a-f]{24}$/.test(value.ref.executionId) || !["linux", "darwin"].includes(value.ref.platform)) throw new PersonalError("file_search_record_invalid", "检索执行记录不完整，已停止恢复；请保留档案。");
  if (value.temporary.path !== value.input.tempDir || value.fingerprint !== fingerprint(value.input, value.spec) || value.input.workspace !== value.scratch.path || value.spec.workspace !== value.scratch.path || value.spec.workspaceIdentity?.dev !== value.scratch.dev || value.spec.workspaceIdentity?.ino !== value.scratch.ino || value.spec.mode !== "full_access" && (value.input.mounts.some(mount => mount.access === "read_write" && mount.path !== value.scratch.path) || value.request.roots === null)) throw new PersonalError("file_search_record_invalid", "检索的原执行或只读范围无法核实，已停止恢复；请保留档案。");
  if (launching) {
    const stat = fs.lstatSync(value.scratch.path, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== value.scratch.dev || stat.ino !== value.scratch.ino || stat.birthtimeMs !== value.scratch.birthtimeMs) throw new PersonalError("file_search_directory_changed", "检索临时目录已变化，未开始扫描；请保留原执行记录并报告拥有者。");
  }
}

function cleanSearchTemporary(value: PreparedPersonalFileSearch) {
  for (const identity of [value.scratch, value.temporary]) {
    const stat = fs.lstatSync(identity.path, { throwIfNoEntry: false });
    if (path.dirname(identity.path) === fs.realpathSync(os.tmpdir()) && /^ruukoto-(?:search|native)-[A-Za-z0-9]+$/.test(path.basename(identity.path)) && stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.dev === identity.dev && stat.ino === identity.ino && stat.birthtimeMs === identity.birthtimeMs) fs.rmSync(identity.path, { recursive: true });
  }
}

export async function stopPersonalFileSearch(profile: string, value: PreparedPersonalFileSearch) {
  verifyPersonalFileSearch(value);
  fs.mkdirSync(executionDirectory(profile), { recursive: true, mode: 0o700 });
  let proof: Awaited<ReturnType<typeof stopBackgroundExecution>>;
  try { proof = await stopBackgroundExecution(executionDirectory(profile), value.ref, value.fingerprint); }
  catch (cause) { throw new PersonalError("file_search_stop_unverified", "原检索停止证据无法核实，已保留占用；请保留档案并由拥有者核实原执行。", { cause }); }
  const stopped = proof.exited;
  if (stopped) cleanSearchTemporary(value);
  return stopped;
}

export async function executePersonalFileSearch(profile: string, value: PreparedPersonalFileSearch, signal?: AbortSignal) {
  verifyPersonalFileSearch(value, true);
  fs.mkdirSync(executionDirectory(profile), { recursive: true, mode: 0o700 });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, buffer = "", result: FileSearchResult | undefined, issue: string | undefined, unit: LaunchedUnit | undefined, attempted = false;
  let stop: Promise<boolean> | undefined, interrupted!: () => void;
  const interruption = new Promise<void>(resolve => { interrupted = resolve; });
  const halt = () => { stop ??= stopPersonalFileSearch(profile, value); void stop.then(interrupted, interrupted); };
  const abort = () => { issue ??= "file_search_canceled"; halt(); };
  const timer = setTimeout(() => { issue ??= "file_search_timeout"; halt(); }, FILE_SEARCH_TIMEOUT_MS + 5000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    attempted = true;
    unit = value.ref.platform === "linux" && value.ref.machineId ? await launchLinuxExecution(executionDirectory(profile), { executionId: value.ref.executionId, machineId: value.ref.machineId }, value.input, value.spec) : await launchMacosExecution(executionDirectory(profile), value.ref, value.input, value.spec);
    if (signal?.aborted || issue) { unit.stdin.end(); throw new PersonalError("file_search_canceled", "检索已取消，正在核实原执行停止。"); }
    let ended = false;
    const closed = new Promise<void>(resolve => { unit!.stdout.once("end", () => { ended = true; resolve(); }); unit!.stdout.once("error", () => { issue ??= "file_search_output_invalid"; halt(); resolve(); }); });
    unit.stdout.setEncoding("utf8");
    unit.stdout.on("data", (chunk: string) => {
      if (issue) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 512 * 1024) { issue = "file_search_output_invalid"; halt(); return; }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { type: string; stream?: string; bytes?: string; result?: FileSearchResult };
          if (message.type === "result" && message.result && !result) result = message.result;
          else if (message.type === "data" && !result && ["file_search", "stderr"].includes(message.stream!) && typeof message.bytes === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.bytes)) {
            const chunk = Buffer.from(message.bytes, "base64"); bytes += chunk.length;
            if (bytes > FILE_SEARCH_BYTES) throw new Error("capture_limit");
            (message.stream === "file_search" ? stdout : stderr).push(chunk);
          } else throw new Error("protocol_invalid");
        } catch { issue ??= "file_search_output_invalid"; halt(); }
      }
    });
    unit.stderr.on("data", (chunk: Buffer) => { const remaining = FILE_SEARCH_BYTES - bytes; const captured = Buffer.from(chunk).subarray(0, remaining); stderr.push(captured); bytes += captured.length; if (chunk.length > remaining) { issue ??= "file_search_output_limit"; halt(); } });
    const written = new Promise<void>((resolve, reject) => { unit!.stdin.once("error", reject); unit!.stdin.end(JSON.stringify(value.request), (error?: Error | null) => error ? reject(error) : resolve()); });
    const exit = await Promise.race([Promise.all([unit.exit, written]).then(([exit]) => exit), interruption.then(() => undefined)]);
    if (exit && !ended) await Promise.race([closed, interruption]);
    if (!exit || exit.code !== 0 || buffer.length || !result) issue ??= "file_search_interrupted";
  } catch (error) {
    if (error instanceof ExecutionError && error.unit) unit = error.unit;
    issue ??= error instanceof ExecutionError ? error.code : "file_search_canceled";
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  // 当前调用尚未触达 launch 时以停止先手封住原 ID；崩溃恢复仍须核对原 launch 指纹。
  const firstStop = stop ? await stop : false;
  const stopped = attempted ? firstStop || await stopPersonalFileSearch(profile, value) : value.ref.platform === "linux" && value.ref.machineId ? (await stopLinuxExecution(executionDirectory(profile), { executionId: value.ref.executionId, machineId: value.ref.machineId })).exited : (await stopMacosExecution(executionDirectory(profile), value.ref)).exited;
  unit?.stdin.destroy();
  if (unit?.stdout instanceof Readable) unit.stdout.destroy();
  if (unit?.stderr instanceof Readable) unit.stderr.destroy();
  if (stopped) cleanSearchTemporary(value);
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  if (!stopped) issue = "file_search_stop_unverified";
  const view: FileSearchResult = result ? { ...result, ...(issue ? { code: issue, scanComplete: false, partial: true } : {}) } : { root: path.resolve(value.request.cwd, String(value.request.params.path ?? ".")), entries: [], capturedCount: 0, scanComplete: false, previewTruncated: false, partial: true, filtering: "检索未完成，原字节只表示已捕获部分。", code: issue ?? "file_search_interrupted" };
  return { effect: view.scanComplete ? "returned" as const : "no_write" as const, code: view.code ?? "returned", stopped, bytes: Buffer.concat([out, err]), partial: view.partial, view: { ...view, rawStreams: { stdoutBytes: out.length, stderrBytes: err.length } } };
}
