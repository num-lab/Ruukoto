import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { grantCoversPath } from "@ruukoto/core/worktree.ts";
import { FILE_SEARCH_BYTES, FILE_SEARCH_PREVIEW_BYTES, FILE_SEARCH_TIMEOUT_MS, FileSearchError, fileSearchArgv, fileSearchParams, rgText, searchUtf8,
  type FileSearchEntry, type FileSearchName, type FileSearchResult } from "../file-search.ts";
import type { DataStream } from "./protocol.ts";

export interface SearchRoot { path: string; dev?: number; ino?: number }

/** 由宿主解析已安装工具，模型不能指定可执行文件或触发下载。 */
export function resolveFileSearchExecutable(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(item => path.isAbsolute(item))) {
    const candidate = path.join(directory, "rg");
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); }
    catch { /* 忽略 PATH 中不存在或不可执行的 rg 候选，缺失由调用结果报告。 */ }
  }
  return undefined;
}

function noLinks(target: string): void {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new FileSearchError("file_search_path_denied", "检索路径包含符号链接；请使用已授权的真实目录。");
  }
}

function verifyRoots(roots: SearchRoot[] | null): void {
  for (const root of roots ?? []) {
    noLinks(root.path);
    const stat = fs.statSync(root.path);
    if ((root.dev !== undefined && stat.dev !== root.dev) || (root.ino !== undefined && stat.ino !== root.ino)) {
      throw new FileSearchError("file_search_directory_changed", "读取根身份已变化；本次检索停止，请核实目录后重新提交任务。");
    }
  }
}

// Note: 见 .agents/notes/implemented/feature/2026-10-21-controlled-file-search.md
export async function runFileSearch(input: {
  name: FileSearchName; params: Record<string, unknown>; cwd: string; executable?: string; roots: SearchRoot[] | null;
  signal: AbortSignal; onData: (stream: DataStream, bytes: Buffer) => void;
  track: (pid: number) => void; stop: (pid: number) => Promise<boolean>;
}): Promise<FileSearchResult> {
  const result: FileSearchResult = { root: input.cwd, entries: [], capturedCount: 0, scanComplete: false, previewTruncated: false, partial: false,
    filtering: "无 glob：遵循根内 ignore、跳过隐藏；显式 glob：沿 rg 覆盖 ignore/隐藏。不跟随链接、跳过二进制，不读取父级/global ignore/config。" };
  const failure = (error: FileSearchError): FileSearchResult => ({ ...result, scanComplete: false, partial: true, code: error.code, message: error.message });
  let params: ReturnType<typeof fileSearchParams>;
  let rootStat: fs.Stats;
  try {
    params = fileSearchParams(input.name, input.params);
    result.root = path.resolve(input.cwd, params.path ?? ".");
    verifyRoots(input.roots);
    if (input.roots && !input.roots.some(root => grantCoversPath(root.path, result.root))) throw new FileSearchError("file_search_path_denied", "检索目录超出当前读取范围；请拥有者先通过路径授予入口开放该目录。");
    noLinks(result.root);
    rootStat = fs.statSync(result.root);
    if (!rootStat.isDirectory()) throw new FileSearchError("file_search_not_directory", "path 必须是现有目录；请改用目录路径，已知文件可用 read 读取。");
    if (!input.executable) throw new FileSearchError("file_search_unavailable", "宿主未安装可用 rg，未开始检索；请拥有者安装 ripgrep 并重启任务。");
  } catch (error) {
    return failure(error instanceof FileSearchError ? error : new FileSearchError("file_search_path_unavailable", "检索目录不可访问或已变化；请核实当前读取范围与目录后重新提交。"));
  }
  const deadline = Date.now() + FILE_SEARCH_TIMEOUT_MS;
  let previewBytes = Buffer.byteLength(JSON.stringify(result), "utf8") + 1024;
  let capturedBytes = 0;
  let pending = Buffer.alloc(0);
  let issue: FileSearchError | undefined;
  let checkpoint: { count: number; length: number; bytes: number; truncated: boolean } | undefined;
  const checkTime = (): void => {
    if (Date.now() >= deadline) throw new FileSearchError("file_search_timeout", "检索达到10秒预算，已请求停止并保留部分证据；请收窄 path/glob。");
  };
  const add = (entry: FileSearchEntry): void => {
    result.capturedCount++;
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (result.entries.length < params.limit && previewBytes + bytes <= FILE_SEARCH_PREVIEW_BYTES) {
      result.entries.push(entry); previewBytes += bytes;
    } else result.previewTruncated = true;
    if (entry.lineTruncated) result.previewTruncated = true;
  };
  const candidate = (relative: string): string => {
    const absolute = path.resolve(result.root, relative);
    if (!grantCoversPath(result.root, absolute) || path.isAbsolute(relative)) throw new FileSearchError("file_search_output_invalid", "rg 返回范围外路径；检索已停止，请向拥有者报告。");
    noLinks(absolute);
    if (!fs.lstatSync(absolute).isFile()) throw new FileSearchError("file_search_directory_changed", "匹配文件已被替换，检索停止；请核实目录后重试。");
    return absolute;
  };
  const record = (bytes: Buffer): void => {
    checkTime();
    if (input.name === "list_files") {
      const relative = searchUtf8(bytes).replace(/^\.\//, "");
      const absolute = candidate(relative);
      const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let binary = false;
      try {
        if (!fs.fstatSync(fd).isFile()) throw new FileSearchError("file_search_directory_changed", "文件已变化，检索停止；请核实目录后重试。");
        const chunk = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          checkTime();
          const length = fs.readSync(fd, chunk);
          if (!length) break;
          if (chunk.subarray(0, length).includes(0)) { binary = true; break; }
        }
      } finally { fs.closeSync(fd); }
      if (!binary) add({ path: relative });
      return;
    }
    const item = JSON.parse(bytes.toString("utf8")) as { type: string; data: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; binary_offset?: number | null } };
    if (item.type === "begin") checkpoint = { count: result.capturedCount, length: result.entries.length, bytes: previewBytes, truncated: result.previewTruncated };
    if (item.type === "end" && item.data.binary_offset != null && checkpoint) {
      result.capturedCount = checkpoint.count; result.entries.length = checkpoint.length; previewBytes = checkpoint.bytes; result.previewTruncated = checkpoint.truncated;
    }
    if (item.type === "end") checkpoint = undefined;
    if (item.type !== "match") return;
    const relative = rgText(item.data.path!, true).replace(/^\.\//, "");
    candidate(relative);
    if (!Number.isInteger(item.data.line_number) || item.data.line_number! < 1) throw new FileSearchError("file_search_output_invalid", "检索行号无效；请检查 rg 安装后重试。");
    const line = rgText(item.data.lines!, false).replace(/\r?\n$/, "");
    const text = line.slice(0, 2048).replace(/[\uD800-\uDBFF]$/, "");
    add({ path: relative, line: item.data.line_number, text, ...(text.length < line.length ? { lineTruncated: true } : {}) });
  };
  const child = spawn(input.executable!, fileSearchArgv(input.name, params), { cwd: result.root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RIPGREP_CONFIG_PATH: "" } });
  const pid = child.pid;
  if (pid !== undefined) input.track(pid);
  const halt = (error: FileSearchError): void => {
    issue ??= error;
    if (pid !== undefined) void input.stop(pid);
  };
  const abort = (): void => halt(new FileSearchError("file_search_canceled", "检索已取消并请求停止，已捕获部分保留；可结束本轮并报告当前结果。"));
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  const timer = setTimeout(() => halt(new FileSearchError("file_search_timeout", "检索达到10秒预算，已请求停止并保留部分证据；请收窄 path/glob。")), FILE_SEARCH_TIMEOUT_MS);
  const consume = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (issue) return;
    const bytes = chunk.subarray(0, Math.max(0, FILE_SEARCH_BYTES - capturedBytes));
    capturedBytes += bytes.length;
    input.onData(stream === "stdout" ? "file_search" : "stderr", bytes);
    if (stream === "stdout") {
      pending = Buffer.concat([pending, bytes]);
      const separator = input.name === "list_files" ? 0 : 10;
      let offset = 0;
      try {
        for (;;) {
          const end = pending.indexOf(separator, offset);
          if (end < 0) break;
          record(pending.subarray(offset, end)); offset = end + 1;
        }
      } catch (error) {
        halt(error instanceof FileSearchError ? error : new FileSearchError("file_search_read_failed", "检索输出无法解析或文件不可读，已保留部分证据；请收窄目录并核实文件权限。"));
      }
      pending = pending.subarray(offset);
    }
    if (capturedBytes >= FILE_SEARCH_BYTES) halt(new FileSearchError("file_search_output_limit", "检索达到8 MiB捕获预算，已请求停止并保留部分证据；请收窄 path/glob。"));
  };
  child.stdout.on("data", (bytes: Buffer) => consume("stdout", bytes));
  child.stderr.on("data", (bytes: Buffer) => consume("stderr", bytes));
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>(resolve => {
      child.once("error", () => { halt(new FileSearchError("file_search_unavailable", "rg 无法启动，未完成检索；请拥有者检查 ripgrep 安装及执行权限。")); });
      child.once("close", code => resolve(code));
    });
    if (pid !== undefined && !await input.stop(pid)) issue ??= new FileSearchError("file_search_stop_unverified", "检索停止尚未核实，保留执行占用与部分证据；请结束本轮并向拥有者报告。");
  } finally { clearTimeout(timer); input.signal.removeEventListener("abort", abort); }
  try {
    verifyRoots(input.roots);
    const current = fs.statSync(result.root);
    if (current.dev !== rootStat.dev || current.ino !== rootStat.ino) throw new FileSearchError("file_search_directory_changed", "检索目录身份已变化，结果仅供部分观察；请核实目录后重新提交。");
  } catch (error) { issue ??= error instanceof FileSearchError ? error : new FileSearchError("file_search_directory_changed", "检索目录不可再核实，已保留部分证据；请核实目录后重新提交。"); }
  if (!issue && exitCode !== 0 && exitCode !== 1) issue = new FileSearchError("file_search_failed", `rg 退出${exitCode ?? "未知"}，扫描未完成；请查看 stderr 产物并核实目录权限。`);
  if (!issue && pending.length) issue = new FileSearchError("file_search_output_invalid", "检索输出记录不完整；保留部分证据，请收窄目录后重试。");
  if (checkpoint) {
    result.capturedCount = checkpoint.count; result.entries.length = checkpoint.length; result.previewTruncated = checkpoint.truncated;
  }
  return issue ? failure(issue) : { ...result, scanComplete: true };
}
