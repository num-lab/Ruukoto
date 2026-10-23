import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { DirIdentityError, resolveDirIdentitySync, verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";

export const WORKSPACE_GIT_COMMITS = 200;
export const WORKSPACE_GIT_OUTPUT_BYTES = 512 * 1024;
export const WORKSPACE_GIT_TIMEOUT_MS = 5000;
export interface WorkspaceGitRef { name: string; type: "branch" | "tag"; remote?: string }
export interface WorkspaceGitCommit { id: string; parents: string[]; subject: string; author: string; date: string; refs: WorkspaceGitRef[] }
export interface WorkspaceGitRepository { head: string | null; commits: WorkspaceGitCommit[]; nextCursor: string | null }
export interface WorkspaceGit { workspaceId: string; repository: WorkspaceGitRepository | null }

function io<T>(read: () => T): T {
  try { return read(); }
  catch (cause) {
    if (cause instanceof RuntimeApiError) throw cause;
    throw new RuntimeApiError("workspace_git_unavailable", "无法读取 Git 仓库，请核实目录权限后重试。");
  }
}
function optionalStat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw new RuntimeApiError("workspace_git_unavailable", "无法读取 Git 仓库，请核实目录权限后重试。");
  }
}
function unsafe(): never { throw new RuntimeApiError("workspace_git_unsafe", "Git 元数据包含不安全的外部引用，请核实仓库后重试。"); }
function verifyRoot(root: DirIdentity): void {
  try { verifyDirIdentitySync(root); }
  catch (cause) {
    if (!(cause instanceof DirIdentityError)) throw cause;
    throw new RuntimeApiError("workspace_directory_changed", "工作区目录已失效或被替换，请重新打开工作区。");
  }
}
function pointer(file: string, limit = 4096): string {
  const stat = optionalStat(file);
  if (!stat || !stat.isFile() || stat.nlink !== 1 || stat.size > limit) unsafe();
  const fd = io(() => fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
  try {
    const opened = io(() => fs.fstatSync(fd));
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) unsafe();
    const bytes = Buffer.alloc(limit + 1);
    const length = io(() => fs.readSync(fd, bytes, 0, bytes.length, 0));
    if (length !== stat.size) unsafe();
    return bytes.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
  } finally { io(() => fs.closeSync(fd)); }
}
function discover(root: DirIdentity): { gitDir: DirIdentity; commonDir: DirIdentity } | null {
  let directory = root.cwdReal;
  for (let depth = 0; depth < 128; depth++) {
    const marker = path.join(directory, ".git");
    const stat = optionalStat(marker);
    if (stat) {
      if (stat.isSymbolicLink()) unsafe();
      const gitPath = stat.isDirectory() ? marker : (() => {
        const value = pointer(marker);
        if (!value.startsWith("gitdir: ") || value.includes("\0") || value.includes("\n")) unsafe();
        return path.resolve(directory, value.slice(8));
      })();
      const gitDir = io(() => resolveDirIdentitySync(gitPath));
      const common = path.join(gitDir.cwdReal, "commondir");
      const commonPath = optionalStat(common) ? pointer(common) : null;
      if (commonPath !== null && (!commonPath || commonPath.includes("\0") || commonPath.includes("\n"))) unsafe();
      const commonDir = commonPath === null ? gitDir : io(() => resolveDirIdentitySync(path.resolve(gitDir.cwdReal, commonPath)));
      return { gitDir, commonDir };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  throw new RuntimeApiError("workspace_git_limit", "仓库目录层级过深，请打开更接近仓库根目录的工作区。");
}
function scanMetadata(directories: string[], deadline: number): void {
  const pending = [...new Set(directories)];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = io(() => fs.opendirSync(directory));
    try {
      for (;;) {
        const entry = io(() => entries.readSync());
        if (!entry) break;
        if (++count > 100_000) throw new RuntimeApiError("workspace_git_limit", "Git 元数据超出本次读取上限，请整理仓库后重试。");
        if (Date.now() >= deadline) throw new RuntimeApiError("workspace_git_timeout", "Git 元数据读取超时，请稍后重试。");
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) unsafe();
        if (entry.isDirectory()) pending.push(file);
        if (entry.isFile()) {
          const stat = io(() => fs.lstatSync(file));
          if (!stat.isFile() || stat.nlink !== 1) unsafe();
          if (directories.includes(directory) && ["config", "config.worktree"].includes(entry.name) && /^[\t \ufeff]*\[[\t ]*(?:include|includeif)(?:[\t .\]"]|$)/im.test(pointer(file, 64 * 1024))) unsafe();
        }
        if (entry.name === "alternates" || entry.name === "http-alternates") unsafe();
      }
    } finally { io(() => entries.closeSync()); }
  }
}
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"].includes(key)));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" };
}
async function git(gitDir: string, args: string[], deadline: number, missingAllowed = false): Promise<string> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new RuntimeApiError("workspace_git_timeout", "Git 历史读取超时，请稍后重试。");
  return new Promise((resolve, reject) => execFile("git", ["--no-pager", "--no-optional-locks", "--no-replace-objects", `--git-dir=${gitDir}`, "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.hooksPath=/dev/null", ...args], { env: gitEnvironment(), encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: WORKSPACE_GIT_OUTPUT_BYTES }, (error, stdout) => {
    if (!error || missingAllowed && error.code === 1) { resolve(stdout); return; }
    const code = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "workspace_git_limit" : error.killed ? "workspace_git_timeout" : error.code === "ENOENT" ? "workspace_git_missing" : "workspace_git_unavailable";
    reject(new RuntimeApiError(code, code === "workspace_git_timeout" ? "Git 历史读取超时，请稍后重试。" : code === "workspace_git_limit" ? "Git 历史超出本次读取上限，请整理仓库后重试。" : code === "workspace_git_missing" ? "未找到 Git，请在后台所在机器安装 Git 后重试。" : "无法读取 Git 历史，请核实仓库完整性和权限后重试。"));
  }));
}
function records(output: string, fields: number): string[][] {
  if (!output) return [];
  const values = output.split("\0");
  if (values.pop() !== "\n" || values.length % fields !== 0) throw new RuntimeApiError("workspace_git_invalid", "Git 返回的历史不可解析，请核实仓库后重试。");
  const rows: string[][] = [];
  for (let at = 0; at < values.length; at += fields) rows.push([values[at].replace(/^\n/, ""), ...values.slice(at + 1, at + fields)]);
  return rows;
}

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function changed(): never { throw new RuntimeApiError("workspace_git_changed", "Git 历史已变化，请刷新后继续浏览。"); }
function pageCursor(value: string | undefined): { offset: number; revision: string | null } {
  if (value === undefined) return { offset: 0, revision: null };
  const invalid = (): never => { throw new RuntimeApiError("invalid_params", "Git 历史游标无效，请刷新后重试。"); };
  if (typeof value !== "string" || value.length > 256 || !/^[\w-]+$/.test(value)) return invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { return invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
  const cursor = parsed as Record<string, unknown>;
  if (Object.keys(cursor).some(key => key !== "offset" && key !== "revision") || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 1 || Number(cursor.offset) > Number.MAX_SAFE_INTEGER - WORKSPACE_GIT_COMMITS || typeof cursor.revision !== "string" || !/^[a-f0-9]{64}$/.test(cursor.revision)) return invalid();
  return { offset: Number(cursor.offset), revision: cursor.revision };
}
async function revisionState(workspaceId: string, root: DirIdentity, gitDir: DirIdentity, commonDir: DirIdentity, deadline: number) {
  const [headOutput, refsOutput, remotesOutput] = await Promise.all([
    git(gitDir.cwdReal, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], deadline, true),
    git(gitDir.cwdReal, ["for-each-ref", "--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)%00%(symref)%00"], deadline),
    git(gitDir.cwdReal, ["remote"], deadline),
  ]);
  const shallow = [...new Set([gitDir.cwdReal, commonDir.cwdReal])].map(directory => {
    const file = path.join(directory, "shallow");
    return optionalStat(file) ? pointer(file, WORKSPACE_GIT_OUTPUT_BYTES) : null;
  });
  const grafts = [...new Set([gitDir.cwdReal, commonDir.cwdReal])].map(directory => {
    const file = path.join(directory, "info", "grafts");
    return optionalStat(file) ? pointer(file, WORKSPACE_GIT_OUTPUT_BYTES) : null;
  });
  const identity = (directory: DirIdentity) => [directory.cwdReal, directory.dev, directory.ino];
  const revision = createHash("sha256").update(JSON.stringify([workspaceId, identity(root), identity(gitDir), identity(commonDir), pointer(path.join(gitDir.cwdReal, "HEAD")), headOutput, refsOutput, remotesOutput, shallow, grafts])).digest("hex");
  return { revision, headOutput, refsOutput, remotesOutput };
}

// Note: 见 .agents/notes/implemented/feature/2026-10-17-desktop-git-history-pages.md
// Note: 见 .agents/notes/implemented/feature/2026-10-24-owner-workspace-browsing.md
export async function readWorkspaceGit(workspaceId: string, root: DirIdentity, cursor?: string): Promise<WorkspaceGit> {
  const page = pageCursor(cursor);
  const deadline = Date.now() + WORKSPACE_GIT_TIMEOUT_MS;
  verifyRoot(root);
  const location = discover(root);
  if (!location) { verifyRoot(root); if (cursor !== undefined) changed(); return { workspaceId, repository: null }; }
  const { gitDir, commonDir } = location;
  scanMetadata([gitDir.cwdReal, commonDir.cwdReal], deadline);
  const before = await revisionState(workspaceId, root, gitDir, commonDir, deadline);
  if (page.revision !== null && page.revision !== before.revision) changed();
  const logOutput = await git(gitDir.cwdReal, ["log", "--all", "--topo-order", `--skip=${page.offset}`, `--max-count=${WORKSPACE_GIT_COMMITS + 1}`, "--no-show-signature", "--no-use-mailmap", "--no-notes", "--no-decorate", "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00"], deadline);
  const after = await revisionState(workspaceId, root, gitDir, commonDir, deadline);
  verifyRoot(root); verifyRoot(gitDir); verifyRoot(commonDir);
  const current = discover(root);
  if (!current || current.gitDir.cwdReal !== gitDir.cwdReal || current.commonDir.cwdReal !== commonDir.cwdReal) changed();
  scanMetadata([gitDir.cwdReal, commonDir.cwdReal], deadline);
  if (before.revision !== after.revision) changed();
  const { headOutput, refsOutput, remotesOutput } = before;
  const remotes = remotesOutput.trim().split("\n").filter(Boolean).sort((a, b) => b.length - a.length);
  const references = new Map<string, WorkspaceGitRef[]>();
  for (const [object, kind, peeled, peeledKind, ref, symref] of records(refsOutput, 6)) {
    if (symref || kind !== "commit" && peeledKind !== "commit") continue;
    const id = kind === "commit" ? object : peeled;
    let value: WorkspaceGitRef;
    if (ref.startsWith("refs/tags/")) value = { name: ref.slice(10), type: "tag" };
    else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice(13);
      const remote = remotes.find(item => name.startsWith(`${item}/`)) ?? name.split("/")[0];
      value = { name: name.slice(remote.length + 1), type: "branch", remote };
    } else if (ref.startsWith("refs/heads/")) value = { name: ref.slice(11), type: "branch" };
    else continue;
    references.set(id, [...references.get(id) ?? [], value]);
  }
  const rows = records(logOutput, 5);
  if (headOutput.trim() && !objectId.test(headOutput.trim()) || rows.some(([id, parents, , , date]) => !objectId.test(id) || parents && parents.split(" ").some(parent => !objectId.test(parent)) || !Number.isFinite(Date.parse(date)))) throw new RuntimeApiError("workspace_git_invalid", "Git 返回的历史不可解析，请核实仓库后重试。");
  const commits = rows.slice(0, WORKSPACE_GIT_COMMITS).map(([id, parents, subject, author, date]) => ({ id, parents: parents ? parents.split(" ") : [], subject, author, date, refs: references.get(id) ?? [] }));
  const nextCursor = rows.length > WORKSPACE_GIT_COMMITS ? Buffer.from(JSON.stringify({ offset: page.offset + commits.length, revision: before.revision })).toString("base64url") : null;
  const result = { workspaceId, repository: { head: headOutput.trim() || null, commits, nextCursor } };
  if (Buffer.byteLength(JSON.stringify(result)) > 768 * 1024) throw new RuntimeApiError("workspace_git_limit", "Git 历史超出本次读取上限，请整理仓库后重试。");
  return result;
}
