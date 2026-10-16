import * as fs from "node:fs";
import * as path from "node:path";
import { isUtf8 } from "node:buffer";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { DirIdentityError, verifyDirIdentitySync, type DirIdentity } from "@ruukoto/core/dir-identity.ts";
import { ApprovedOpError, assertGrantNotProtected, assertNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";

export const WORKSPACE_DIRECTORY_LIMIT = 200;
export const WORKSPACE_PREVIEW_BYTES = 256 * 1024;
export interface WorkspaceFileEntry { name: string; path: string; kind: "directory" | "file" }
export interface WorkspaceFileList { workspaceId: string; path: string; entries: WorkspaceFileEntry[]; truncated: boolean }
export type WorkspaceFilePreview = { workspaceId: string; path: string; size: number } & (
  | { kind: "text" | "markdown"; content: string }
  | { kind: "image"; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataUrl: string }
  | { kind: "unsupported" }
);

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

function protect(root: DirIdentity, target: string, protectedRoots: string[]): void {
  try { assertGrantNotProtected(root.cwdReal, protectedRoots); }
  catch (cause) { throw new RuntimeApiError(cause instanceof ApprovedOpError ? "workspace_path_unsafe" : "workspace_file_unavailable", cause instanceof ApprovedOpError ? "此目录属于后台保护范围，不能预览。" : "无法核实目录保护范围，请稍后重试。"); }
  try { assertNotProtected(target, protectedRoots); }
  catch (cause) { throw new RuntimeApiError(cause instanceof ApprovedOpError ? "workspace_path_unsafe" : "workspace_file_unavailable", cause instanceof ApprovedOpError ? "此文件属于后台保护范围，不能预览。" : "无法核实文件保护范围，请稍后重试。"); }
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
export function listWorkspaceFiles(workspaceId: string, root: DirIdentity, relative: string, protectedRoots: string[]): WorkspaceFileList {
  const parts = relativeParts(relative, true);
  const { target, chain } = locate(root, parts);
  const stat = chain.at(-1)!;
  if (!stat.isDirectory()) throw new RuntimeApiError("workspace_path_unsafe", "此路径不是可展开的目录。");
  protect(root, target, protectedRoots);
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
    protect(root, target, protectedRoots);
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    return { workspaceId, path: relative, entries, truncated };
  } finally { io(() => directory.closeSync()); }
}

function imageType(bytes: Buffer): Extract<WorkspaceFilePreview, { kind: "image" }>['mimeType'] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "image/jpeg";
  if (bytes.length >= 7 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) && bytes.at(-1) === 59) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) === bytes.length - 8) return "image/webp";
  return null;
}

export function readWorkspaceFile(workspaceId: string, root: DirIdentity, relative: string, protectedRoots: string[]): WorkspaceFilePreview {
  const parts = relativeParts(relative, false);
  const { target, chain } = locate(root, parts);
  const stat = chain.at(-1)!;
  if (!stat.isFile() || stat.nlink !== 1) throw new RuntimeApiError("workspace_path_unsafe", "此路径不是独立的普通文件，不能预览。");
  protect(root, target, protectedRoots);
  const base = { workspaceId, path: relative, size: stat.size };
  if (stat.size > WORKSPACE_PREVIEW_BYTES) return { ...base, kind: "unsupported" };
  const fd = io(() => fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
  let bytes: Buffer;
  try {
    const opened = io(() => fs.fstatSync(fd));
    if (!opened.isFile() || opened.nlink !== 1 || !unchanged(stat, opened) || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs) throw new RuntimeApiError("workspace_file_changed", "文件在打开时发生变化，请重新打开。");
    verifyPath(root, parts, chain);
    bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = io(() => fs.readSync(fd, bytes, length, bytes.length - length, length));
      if (!count) break;
      length += count;
    }
    const after = io(() => fs.fstatSync(fd));
    if (length !== stat.size || !unchanged(opened, after) || after.nlink !== 1 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new RuntimeApiError("workspace_file_changed", "文件在读取期间发生变化，请重新打开。");
    verifyPath(root, parts, chain);
    protect(root, target, protectedRoots);
    bytes = bytes.subarray(0, length);
  } finally { io(() => fs.closeSync(fd)); }
  const mimeType = imageType(bytes);
  if (mimeType) return { ...base, kind: "image", mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"].includes(path.extname(relative).toLowerCase()) || !isUtf8(bytes) || bytes.includes(0)) return { ...base, kind: "unsupported" };
  const content = bytes.toString("utf8");
  // 控制面帧有 1 MiB 上限，控制字符经 JSON 转义后也必须保留封帧余量。
  if (Buffer.byteLength(JSON.stringify(content)) > 768 * 1024) return { ...base, kind: "unsupported" };
  return { ...base, kind: /\.(?:md|markdown)$/i.test(relative) ? "markdown" : "text", content };
}
