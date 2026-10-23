import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { DirIdentityError, verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";

export const WORKSPACE_DIRECTORY_LIMIT = 200;
export const WORKSPACE_FILE_PAGE_BYTES = 256 * 1024;
export interface WorkspaceFileEntry { name: string; path: string; kind: "directory" | "file" }
export interface WorkspaceFileList { workspaceId: string; path: string; entries: WorkspaceFileEntry[]; nextCursor: string | null }
export interface WorkspaceFileChunk { workspaceId: string; path: string; size: number; version: string; offset: number; encoding: "base64"; data: string }

function io<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) { return unavailable(cause); }
}

function unavailable(cause: unknown): never {
  if (cause instanceof RuntimeApiError) throw cause;
  const code = cause instanceof Error && "code" in cause ? cause.code : null;
  throw new RuntimeApiError(code === "ENOENT" ? "workspace_file_not_found" : "workspace_file_unavailable", code === "ENOENT" ? "文件已不存在，请刷新文件树。" : "无法读取此文件或目录，请核实权限后重试。");
}

function relativeParts(value: string, rootAllowed: boolean): string[] {
  if (value === "" && rootAllowed) return [];
  const parts = value.split("/");
  if (!value || Buffer.byteLength(value) > 4096 || parts.length > 64 || value.includes("\\") || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || parts.some(part => !part || part === "." || part === "..")) throw new RuntimeApiError("invalid_params", "文件路径必须是工作区内的相对路径。");
  return parts;
}

function verifyRoot(root: DirIdentity): void {
  try { verifyDirIdentitySync(root); }
  catch (cause) { if (!(cause instanceof DirIdentityError)) throw cause; throw new RuntimeApiError("workspace_directory_changed", "工作区目录已失效或被替换，请重新打开工作区。"); }
}

function locate(root: DirIdentity, parts: string[]): { target: string; chain: fs.Stats[] } {
  verifyRoot(root);
  let target = root.cwdReal;
  const chain = [io(() => fs.lstatSync(target))];
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    const stat = io(() => fs.lstatSync(target));
    if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory() || io(() => fs.realpathSync(target)) !== target) throw new RuntimeApiError("workspace_path_unsafe", "文件路径包含符号链接或不安全的目录，不能预览。");
    chain.push(stat);
  }
  return { target, chain };
}

function unchanged(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode;
}

function verifyPath(root: DirIdentity, parts: string[], previous: fs.Stats[]): fs.Stats[] {
  const current = locate(root, parts).chain;
  if (previous.some((stat, index) => !unchanged(stat, current[index]))) throw new RuntimeApiError("workspace_file_changed", "文件或目录在读取期间发生变化，请重新打开。");
  return current;
}

type DirectoryCursor = Pick<WorkspaceFileEntry, "kind" | "name"> & { revision: string };
function directoryCursor(value: string | undefined): DirectoryCursor | null {
  if (value === undefined) return null;
  const invalid = (): never => { throw new RuntimeApiError("invalid_params", "目录游标无效，请刷新文件树。"); };
  if (typeof value !== "string" || value.length > 8192 || !/^[\w-]+$/.test(value)) return invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { return invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
  const cursor = parsed as Record<string, unknown>;
  if (Object.keys(cursor).some(key => !["revision", "kind", "name"].includes(key)) || typeof cursor.revision !== "string" || !/^[a-f0-9]{64}$/.test(cursor.revision) || cursor.kind !== "file" && cursor.kind !== "directory" || typeof cursor.name !== "string" || !cursor.name || cursor.name === "." || cursor.name === ".." || cursor.name.includes("/") || cursor.name.includes("\0")) return invalid();
  return { revision: cursor.revision, kind: cursor.kind, name: cursor.name };
}
function compareEntries(a: Pick<WorkspaceFileEntry, "kind" | "name">, b: Pick<WorkspaceFileEntry, "kind" | "name">): number {
  return Number(b.kind === "directory") - Number(a.kind === "directory") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function directoryRevision(workspaceId: string, root: DirIdentity, relative: string, chain: fs.Stats[]): string {
  const directory = chain.at(-1)!;
  return createHash("sha256").update(JSON.stringify([workspaceId, root.cwdReal, relative, chain.map(stat => [stat.dev, stat.ino, stat.mode]), directory.mtimeMs, directory.ctimeMs])).digest("hex");
}
function directoryChanged(): never { throw new RuntimeApiError("workspace_file_changed", "目录已变化，请刷新文件树后继续浏览。"); }

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
// Note: 见 .agents/notes/implemented/feature/2026-10-24-owner-workspace-browsing.md
// Note: 见 .agents/notes/implemented/feature/2026-10-24-directory-pages-lazy-git.md
export async function listWorkspaceFiles(workspaceId: string, root: DirIdentity, relative: string, cursor?: string): Promise<WorkspaceFileList> {
  const page = directoryCursor(cursor);
  const parts = relativeParts(relative, true);
  const { target, chain } = locate(root, parts);
  const stat = chain.at(-1)!;
  if (!stat.isDirectory()) throw new RuntimeApiError("workspace_path_unsafe", "此路径不是可展开的目录。");
  const revision = directoryRevision(workspaceId, root, relative, chain);
  if (page && page.revision !== revision) directoryChanged();
  const directory = await fs.promises.opendir(target, { bufferSize: 256 }).catch(unavailable);
  const candidates: WorkspaceFileEntry[] = [];
  try {
    if (directoryRevision(workspaceId, root, relative, verifyPath(root, parts, chain)) !== revision) directoryChanged();
    for (;;) {
      const entry = await directory.read().catch(unavailable);
      if (!entry) break;
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) continue;
      const item: WorkspaceFileEntry = { name: entry.name, path: [...parts, entry.name].join("/"), kind: entry.isDirectory() ? "directory" : "file" };
      if (page && compareEntries(item, page) <= 0 || candidates.length > WORKSPACE_DIRECTORY_LIMIT && compareEntries(item, candidates.at(-1)!) >= 0) continue;
      let low = 0, high = candidates.length;
      while (low < high) { const middle = (low + high) >>> 1; if (compareEntries(candidates[middle], item) < 0) low = middle + 1; else high = middle; }
      candidates.splice(low, 0, item);
      if (candidates.length > WORKSPACE_DIRECTORY_LIMIT + 1) candidates.pop();
    }
    if (directoryRevision(workspaceId, root, relative, verifyPath(root, parts, chain)) !== revision) directoryChanged();
    const entries: WorkspaceFileEntry[] = [];
    let bytes = 0;
    for (const item of candidates) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (entries.length === WORKSPACE_DIRECTORY_LIMIT || bytes > 768 * 1024) break;
      entries.push(item);
    }
    const last = entries.at(-1);
    const nextCursor = last && entries.length < candidates.length ? Buffer.from(JSON.stringify({ revision, kind: last.kind, name: last.name })).toString("base64url") : null;
    return { workspaceId, path: relative, entries, nextCursor };
  } finally { await directory.close().catch(unavailable); }
}

// Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-read-check-overhead.md
export function readWorkspaceFile(workspaceId: string, root: DirIdentity, relative: string, page: { offset?: number; length?: number; version?: string } = {}): WorkspaceFileChunk {
  const offset = page.offset === undefined ? 0 : page.offset, pageLength = page.length === undefined ? WORKSPACE_FILE_PAGE_BYTES : page.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageLength) || pageLength < 1 || page.version !== undefined && typeof page.version !== "string" || offset > 0 && !page.version) throw new RuntimeApiError("invalid_params", "文件分页参数无效，请重新打开文件。");
  const parts = relativeParts(relative, false);
  const { target, chain } = locate(root, parts);
  const stat = chain.at(-1)!;
  if (!stat.isFile()) throw new RuntimeApiError("workspace_path_unsafe", "此路径不是普通文件，不能预览。");
  const version = createHash("sha256").update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs])).digest("hex");
  if (page.version !== undefined && page.version !== version) throw new RuntimeApiError("workspace_file_changed", "文件在读取期间发生变化，请重新打开。");
  if (offset > stat.size) throw new RuntimeApiError("invalid_params", "文件读取位置超出范围，请重新打开文件。");
  const fd = io(() => fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
  let bytes: Buffer;
  try {
    const opened = io(() => fs.fstatSync(fd));
    if (!opened.isFile() || !unchanged(stat, opened) || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) throw new RuntimeApiError("workspace_file_changed", "文件在打开时发生变化，请重新打开。");
    verifyPath(root, parts, chain);
    bytes = Buffer.alloc(Math.min(pageLength, WORKSPACE_FILE_PAGE_BYTES, stat.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const count = io(() => fs.readSync(fd, bytes, length, bytes.length - length, offset + length));
      if (!count) break;
      length += count;
    }
    const after = io(() => fs.fstatSync(fd));
    if (length !== bytes.length || !unchanged(opened, after) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new RuntimeApiError("workspace_file_changed", "文件在读取期间发生变化，请重新打开。");
    verifyPath(root, parts, chain);
    bytes = bytes.subarray(0, length);
  } finally { io(() => fs.closeSync(fd)); }
  return { workspaceId, path: relative, size: stat.size, version, offset, encoding: "base64", data: bytes.toString("base64") };
}
