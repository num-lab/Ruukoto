/**
 * 报告一次改动相对 merge base 的显式范围，供选择检查用。
 * 输出带版本号的 JSON：已提交、暂存、未暂存、未跟踪四类路径，
 * 以及解析后的 base／head／merge base 提交号。
 *
 * 用法：npm run change-scope -- --base <ref> [--head <ref>]
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseArgs, TextDecoder } from "node:util";

const FORMAT_VERSION = 1;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface ChangeScopeReport {
  formatVersion: typeof FORMAT_VERSION;
  repositoryRoot: string;
  input: { base: string; head: string };
  resolved: { baseSha: string; headSha: string; mergeBaseSha: string };
  paths: { committed: string[]; staged: string[]; unstaged: string[]; untracked: string[] };
}

interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

function executeGitBytes(cwd: string, args: string[]): { status: number | null; stdout: Buffer; stderr: Buffer; error: Error | undefined } {
  const result = spawnSync("git", ["-C", cwd, "-c", "core.fsmonitor=false", ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error ?? undefined };
}

function decodeGitText(output: Buffer, context: string, stream: "stdout" | "stderr"): string {
  try {
    return UTF8_DECODER.decode(output);
  } catch {
    throw new Error(`${context}：Git ${stream} 不是合法 UTF-8`);
  }
}

function executeGit(cwd: string, args: string[]): GitCommandResult {
  const result = executeGitBytes(cwd, args);
  return {
    status: result.status,
    stdout: decodeGitText(result.stdout, "读取 Git 输出失败", "stdout"),
    stderr: decodeGitText(result.stderr, "读取 Git 输出失败", "stderr"),
    error: result.error,
  };
}

function failureDetail(result: GitCommandResult): string {
  return result.error?.message ?? (result.stderr.trim() || `Git 退出码 ${String(result.status)}`);
}

function requireGit(cwd: string, args: string[], context: string): string {
  const result = executeGit(cwd, args);
  if (result.status !== 0) throw new Error(`${context}：${failureDetail(result)}`);
  return result.stdout;
}

function requireGitBytes(cwd: string, args: string[], context: string): Buffer {
  const result = executeGitBytes(cwd, args);
  if (result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.toString("utf8").trim() || `Git 退出码 ${String(result.status)}`);
    throw new Error(`${context}：${detail}`);
  }
  return result.stdout;
}

function parseOptions(args: string[]): { base: string; head: string } {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: { base: { type: "string" }, head: { type: "string", default: "HEAD" } },
    strict: true,
  });
  if (values.base === undefined) throw new Error("缺少必需的 --base <ref>；change-scope 不猜测也不抓取基点，请传入已核实的引用");
  return { base: values.base, head: values.head ?? "HEAD" };
}

function resolveCommit(root: string, label: "base" | "head", ref: string): string {
  const result = executeGit(root, ["-c", "core.warnAmbiguousRefs=true", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (/\bambiguous\b/iu.test(result.stderr)) {
    throw new Error(`${label} 引用 ${JSON.stringify(ref)} 有歧义；请用完整引用或提交号`);
  }
  if (result.status !== 0) throw new Error(`${label} 引用 ${JSON.stringify(ref)} 未解析到提交：${failureDetail(result)}`);
  const commits = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (commits.length !== 1) throw new Error(`${label} 引用 ${JSON.stringify(ref)} 未解析到恰好一个提交`);
  return commits[0] as string;
}

function resolveMergeBase(root: string, baseSha: string, headSha: string): string {
  const result = executeGit(root, ["merge-base", "--all", baseSha, headSha]);
  if (result.status !== 0) throw new Error(`基点和终点没有共同祖先：${failureDetail(result)}`);
  const mergeBases = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (mergeBases.length !== 1) throw new Error(`基点和终点没有唯一的共同祖先，找到 ${mergeBases.length} 个`);
  return mergeBases[0] as string;
}

function parsePathSet(output: Buffer, context: string): string[] {
  const paths: string[] = [];
  let start = 0;
  for (let end = 0; end < output.length; end += 1) {
    if (output[end] !== 0) continue;
    if (end > start) {
      try {
        paths.push(UTF8_DECODER.decode(output.subarray(start, end)));
      } catch {
        throw new Error(`${context}：Git 路径不是合法 UTF-8`);
      }
    }
    start = end + 1;
  }
  return [...new Set(paths)].sort();
}

function diffPaths(root: string, args: string[], context: string): string[] {
  return parsePathSet(
    requireGitBytes(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", "--name-only", "-z", ...args, "--"], context),
    context,
  );
}

function stripGitLineTerminator(output: string): string {
  const withoutLineFeed = output.endsWith("\n") ? output.slice(0, -1) : output;
  return process.platform === "win32" && withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
}

function collectReport(options: { base: string; head: string }, cwd: string): ChangeScopeReport {
  const root = stripGitLineTerminator(requireGit(cwd, ["rev-parse", "--show-toplevel"], "未找到 Git 工作树"));
  const baseSha = resolveCommit(root, "base", options.base);
  const headSha = resolveCommit(root, "head", options.head);
  const mergeBaseSha = resolveMergeBase(root, baseSha, headSha);
  return {
    formatVersion: FORMAT_VERSION,
    repositoryRoot: root,
    input: { base: options.base, head: options.head },
    resolved: { baseSha, headSha, mergeBaseSha },
    paths: {
      committed: diffPaths(root, [mergeBaseSha, headSha], "无法读取已提交路径"),
      staged: diffPaths(root, ["--cached"], "无法读取暂存路径"),
      unstaged: diffPaths(root, [], "无法读取未暂存路径"),
      untracked: parsePathSet(requireGitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"], "无法读取未跟踪路径"), "无法读取未跟踪路径"),
    },
  };
}

/**
 * 校验参数并渲染一份完整的带版本号报告。
 * @param args 脚本路径之后的命令行参数。
 * @param cwd 要检查的 Git 工作树所在目录。
 * @returns 以换行结尾的 JSON 报告。
 */
export function renderChangeScope(args: string[], cwd: string): string {
  return `${JSON.stringify(collectReport(parseOptions(args), cwd), null, 2)}\n`;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(renderChangeScope(process.argv.slice(2), process.cwd()));
  } catch (error) {
    process.stderr.write(`change-scope：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
