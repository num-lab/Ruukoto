import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { DirIdentityError, verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";

export const WORKSPACE_DIRECTORY_LIMIT = 200;
export const WORKSPACE_FILE_PAGE_BYTES = 256 * 1024;
export interface WorkspaceFileEntry { name: string; path: string; kind: "directory" | "file" }
export interface WorkspaceFileList { workspaceId: string; path: string; entries: WorkspaceFileEntry[]; truncated: boolean }
export interface WorkspaceFileChunk { workspaceId: string; path: string; size: number; version: string; offset: number; encoding: "base64"; data: string }

function io<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) {
    if (cause instanceof RuntimeApiError) throw cause;
    const code = cause instanceof Error && "code" in cause ? cause.code : null;
    throw new RuntimeApiError(code === "ENOENT" ? "workspace_file_not_found" : "workspace_file_unavailable", code === "ENOENT" ? "文件已不存在，请刷新文件树。" : "无法读取此文件或目录，请核实权限后重试。");
  }
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

function verifyPath(root: DirIdentity, parts: string[], previous: fs.Stats[]): void {
  const current = locate(root, parts).chain;
  if (previous.some((stat, index) => !unchanged(stat, current[index]))) throw new RuntimeApiError("workspace_file_changed", "文件或目录在读取期间发生变化，请重新打开。");
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
// Note: 见 .agents/notes/implemented/feature/2026-10-24-owner-workspace-browsing.md
export function listWorkspaceFiles(workspaceId: string, root: DirIdentity, relative: string): WorkspaceFileList {
  const parts = relativeParts(relative, true);
  const { target, chain } = locate(root, parts);
  const stat = chain.at(-1)!;
  if (!stat.isDirectory()) throw new RuntimeApiError("workspace_path_unsafe", "此路径不是可展开的目录。");
  const directory = io(() => fs.opendirSync(target, { bufferSize: 32 }));
  const entries: WorkspaceFileEntry[] = [];
  let scanned = 0, bytes = 0, truncated = false;
  try {
    verifyPath(root, parts, chain);
    for (;;) {
      const entry = io(() => directory.readSync());
      if (!entry) break;
      if (++scanned > WORKSPACE_DIRECTORY_LIMIT) { truncated = true; break; }
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) continue;
      const item: WorkspaceFileEntry = { name: entry.name, path: [...parts, entry.name].join("/"), kind: entry.isDirectory() ? "directory" : "file" };
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 768 * 1024) { truncated = true; break; }
      entries.push(item);
    }
    verifyPath(root, parts, chain);
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    return { workspaceId, path: relative, entries, truncated };
  } finally { io(() => directory.closeSync()); }
}

export function readWorkspaceFile(workspaceId: string, root: DirIdentity, relative: string, page: { offset?: number; length?: number; version?: string } = {}): WorkspaceFileChunk {
  const offset = page.offset === undefined ? 0 : page.offset, pageLength = page.length === undefined ? WORKSPACE_FILE_PAGE_BYTES : page.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageLength) || pageLength < 1 || page.version !== undefined && typeof page.version !== "string" || offset > 0 && !page.version) throw new RuntimeApiError("invalid_params", "文件分页参数无效，请重新打开文件。");
  const parts = relativeParts(relative, false);
  const { target, chain } = locate(root, parts);
  const stat = chain.at(-1)!;
  if (!stat.isFile() || stat.nlink !== 1) throw new RuntimeApiError("workspace_path_unsafe", "此路径不是独立的普通文件，不能预览。");
  const version = createHash("sha256").update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs])).digest("hex");
  if (page.version !== undefined && page.version !== version) throw new RuntimeApiError("workspace_file_changed", "文件在读取期间发生变化，请重新打开。");
  if (offset > stat.size) throw new RuntimeApiError("invalid_params", "文件读取位置超出范围，请重新打开文件。");
  const fd = io(() => fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
  let bytes: Buffer;
  try {
    const opened = io(() => fs.fstatSync(fd));
    if (!opened.isFile() || opened.nlink !== 1 || !unchanged(stat, opened) || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) throw new RuntimeApiError("workspace_file_changed", "文件在打开时发生变化，请重新打开。");
    verifyPath(root, parts, chain);
    bytes = Buffer.alloc(Math.min(pageLength, WORKSPACE_FILE_PAGE_BYTES, stat.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const count = io(() => fs.readSync(fd, bytes, length, bytes.length - length, offset + length));
      if (!count) break;
      length += count;
    }
    const after = io(() => fs.fstatSync(fd));
    if (length !== bytes.length || !unchanged(opened, after) || after.nlink !== 1 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new RuntimeApiError("workspace_file_changed", "文件在读取期间发生变化，请重新打开。");
    verifyPath(root, parts, chain);
    bytes = bytes.subarray(0, length);
  } finally { io(() => fs.closeSync(fd)); }
  return { workspaceId, path: relative, size: stat.size, version, offset, encoding: "base64", data: bytes.toString("base64") };
}
