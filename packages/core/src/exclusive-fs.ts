import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface FileIdentity { dev: number; ino: number }
export interface LockIdentity extends FileIdentity { ownerHash: string }
export type DirectoryPublication = "installed" | "exists" | "changed" | "released";

declare const __RUUKOTO_EXCLUSIVE_FS_SOURCE__: string | undefined;
const helperSource = typeof __RUUKOTO_EXCLUSIVE_FS_SOURCE__ === "string"
  ? __RUUKOTO_EXCLUSIVE_FS_SOURCE__
  : fs.readFileSync(fileURLToPath(new URL("./exclusive-fs.py", import.meta.url)), "utf8");

export function sameFileIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

/** Installs the recorded inode without replacing any existing target, including an empty directory. */
export function publishDirectory(input: {
  parent: string;
  parentIdentity: FileIdentity;
  stage: string;
  target: string;
  identity: FileIdentity;
  lock?: { expected: LockIdentity | null };
}): DirectoryPublication {
  return directoryOperation({ ...input, action: input.lock ? "claim" : "install", expected: input.lock?.expected });
}

/** Publishes a complete private file without a hard-link recovery window. */
export function publishFile(parent: string, stage: string, target: string): void {
  const identity = fs.lstatSync(stage);
  directoryOperation({ action: "install-file", parent, parentIdentity: fs.statSync(parent), stage, target, identity });
}

/** Releases only the exact lock inode and owner bytes originally acquired. */
export function releaseDirectoryLock(parent: string, parentIdentity: FileIdentity, target: string, expected: LockIdentity): DirectoryPublication {
  return directoryOperation({ action: "release", parent, parentIdentity, target, expected });
}

export function createPrivateDirectory(parent: string, parentIdentity: FileIdentity, target: string): void {
  directoryOperation({ action: "mkdir", parent, parentIdentity, target });
}

export function writePrivateFile(parent: string, parentIdentity: FileIdentity, target: string, content: string, exclusive: boolean): void {
  directoryOperation({ action: "write-file", parent, parentIdentity, target, content, exclusive });
}

function directoryOperation(input: {
  action: "install" | "install-file" | "claim" | "release" | "mkdir" | "write-file";
  parent: string;
  parentIdentity: FileIdentity;
  stage?: string;
  target: string;
  identity?: FileIdentity;
  expected?: LockIdentity | null;
  content?: string;
  exclusive?: boolean;
}): DirectoryPublication {
  const parentFd = fs.openSync(input.parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.realpathSync(input.parent) !== input.parent || !sameFileIdentity(fs.fstatSync(parentFd), input.parentIdentity)) {
      throw new Error(`Directory parent identity changed: ${input.parent}`);
    }
    const reply = execFileSync("python3", ["-c", helperSource], {
      input: JSON.stringify({ ...input, parent: input.parentIdentity, target: path.basename(input.target), stage: input.stage && path.basename(input.stage) }),
      stdio: ["pipe", "pipe", "pipe", parentFd], encoding: "utf8", timeout: 5000,
    });
    const result = JSON.parse(reply) as { status: DirectoryPublication };
    if (!["installed", "exists", "changed", "released"].includes(result.status)) throw new Error("Invalid directory publication response");
    return result.status;
  } finally { fs.closeSync(parentFd); }
}
