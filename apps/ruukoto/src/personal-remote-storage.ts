import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PersonalError } from "./personal-error.ts";

const invalid = () => new PersonalError("remote_auth_state_invalid", "远程入口私有记录无法核实，入口保持关闭；请保留原记录并在服务器检查或恢复。");

export function assertPersonalRemoteDirectory(directory: string): fs.Stats {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw invalid();
  return stat;
}

function filename(directory: string, name: string) {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw invalid();
  return path.join(directory, name);
}

export function readPersonalRemoteFile(directory: string, name: string): string {
  assertPersonalRemoteDirectory(directory);
  const target = filename(directory, name), before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600) throw invalid();
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8 * 1024 * 1024 || stat.dev !== before.dev || stat.ino !== before.ino) throw invalid();
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export function writePersonalRemoteFile(directory: string, name: string, raw: string): void {
  assertPersonalRemoteDirectory(directory);
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw invalid();
  const target = filename(directory, name), before = fs.lstatSync(target, { throwIfNoEntry: false });
  if (before) readPersonalRemoteFile(directory, name);
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    if (readPersonalRemoteFile(directory, name) !== raw) throw invalid();
  } catch (error) { throw new PersonalError("remote_auth_write_failed", "远程入口私有记录提交未核实，请保留原记录并在服务器检查后重新启动。", { cause: error }); }
}
