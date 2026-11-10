import * as fs from "node:fs";
import * as path from "node:path";
import { createPrivateDirectory, sameFileIdentity, writePrivateFile, type FileIdentity } from "./exclusive-fs.ts";

export class ProfileError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); }
}

export interface PinnedDirectory extends FileIdentity { path: string }

export function fileExists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function directoryIdentity(directory: string, privateMode = false): PinnedDirectory {
  let info: fs.Stats, canonical: string;
  try {
    info = fs.lstatSync(directory);
    canonical = info.isDirectory() && !info.isSymbolicLink() ? fs.realpathSync(directory) : directory;
  }
  catch (cause) { throw new ProfileError("profile_path_unavailable", `Required profile directory is unavailable: ${directory}`, { cause }); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== directory ||
      privateMode && (info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700)) {
    throw new ProfileError("profile_path_unsafe", `Expected ${privateMode ? "private owned" : "canonical"} directory: ${directory}`);
  }
  return { path: directory, dev: info.dev, ino: info.ino };
}

export function verifyPinned(pin: PinnedDirectory): void {
  let actual: PinnedDirectory;
  try { actual = directoryIdentity(pin.path); }
  catch (cause) { throw new ProfileError("profile_path_changed", `Pinned directory is unavailable: ${pin.path}`, { cause }); }
  if (!sameFileIdentity(actual, pin)) throw new ProfileError("profile_path_changed", `Pinned directory was replaced: ${pin.path}`);
}

/** Existing ancestors are resolved before absent suffixes, so equivalent aliases share one selection. */
export function canonicalPath(input: string): { path: string; pin: PinnedDirectory } {
  if (!input || input.includes("\0")) throw new ProfileError("profile_path_invalid", "Profile directories must be nonempty filesystem paths");
  const absolute = path.isAbsolute(input) ? input : process.cwd() + path.sep + input;
  let current = path.parse(absolute).root;
  let pin = directoryIdentity(current);
  for (const component of absolute.slice(current.length).split(path.sep)) {
    if (!component || component === ".") continue;
    const next = component === ".." ? path.dirname(current) : path.join(current, component);
    if (fileExists(next)) {
      current = fs.realpathSync(next);
      pin = directoryIdentity(current);
    } else current = next;
  }
  return { path: current, pin };
}

export function containsPath(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export function ensurePrivateDirectory(directory: string): PinnedDirectory {
  if (!fileExists(directory)) {
    const parentPath = path.dirname(directory);
    const parent = fileExists(parentPath) ? directoryIdentity(parentPath) : ensurePrivateDirectory(parentPath);
    createPrivateDirectory(parent.path, parent, directory);
    verifyPinned(parent);
  }
  return directoryIdentity(directory, true);
}

export function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function readPrivateJson(file: string): unknown {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (cause) { throw new ProfileError("profile_record_invalid", `Cannot open required profile record: ${file}`, { cause }); }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || info.size > 1_048_576) {
      throw new ProfileError("profile_record_unsafe", `Invalid private record: ${file}`);
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError("profile_record_invalid", `Cannot read profile record: ${file}`, { cause });
  } finally { fs.closeSync(fd); }
}

export function savePrivateJson(file: string, value: unknown, exclusive = false, parent = directoryIdentity(path.dirname(file), true)): void {
  if (parent.path !== path.dirname(file)) throw new ProfileError("profile_path_changed", `Record parent differs: ${file}`);
  verifyPinned(parent);
  writePrivateFile(parent.path, parent, file, JSON.stringify(value) + "\n", exclusive);
  verifyPinned(parent);
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validPin(value: unknown): value is PinnedDirectory {
  return plainRecord(value) && typeof value.path === "string" && path.isAbsolute(value.path) &&
    Number.isSafeInteger(value.dev) && Number.isSafeInteger(value.ino) && Number(value.ino) > 0;
}
