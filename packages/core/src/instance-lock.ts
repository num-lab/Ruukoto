// Note: See .agents/notes/implemented/bug-fix/2026-11-10-atomic-lock-publication.md
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { processIdentity, validProcessIdentity } from "./process-identity.ts";
import { publishDirectory, releaseDirectoryLock, sameFileIdentity, type LockIdentity } from "./exclusive-fs.ts";

export class InstanceLockError extends Error {
  readonly code: "instance_lock_busy" | "instance_lock_unverifiable";
  constructor(message: string, readonly unverifiable = false) {
    super(message);
    this.code = unverifiable ? "instance_lock_unverifiable" : "instance_lock_busy";
  }
}

/** Only a verified competing owner receives this exit code; unverifiable ownership is terminal. */
export const INSTANCE_LOCK_EXIT_CODE = 42;

interface LockOwner {
  pid: number;
  command: string;
  startedAt: string;
  processIdentity?: string;
}
interface LockSnapshot extends LockIdentity { owner: LockOwner }

function lockSnapshot(lockDir: string): LockSnapshot | null | undefined {
  let directory: fs.Stats;
  try { directory = fs.lstatSync(lockDir); }
  catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? undefined : null;
  }
  try {
    const ownerPath = path.join(lockDir, "owner.json"), ownerStat = fs.lstatSync(ownerPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() ||
        !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.nlink !== 1 || ownerStat.uid !== process.getuid!() || ownerStat.size > 16_384) return null;
    const bytes = fs.readFileSync(ownerPath);
    const owner = JSON.parse(bytes.toString("utf8")) as LockOwner;
    if (!owner || typeof owner !== "object" || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.command !== "string" || !owner.command || typeof owner.startedAt !== "string" || !Number.isFinite(Date.parse(owner.startedAt))) return null;
    return { dev: directory.dev, ino: directory.ino, ownerHash: createHash("sha256").update(bytes).digest("hex"), owner };
  } catch {
    // An unreadable, partial or replaced owner cannot prove that the lock is stale.
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3_000 }).trim() || null;
  } catch {
    // Failure to inspect a live PID is not evidence of exit.
    return null;
  }
}

export interface AcquiredLock { release(): void }
export interface LockProbe {
  held: boolean;
  pid: number | null;
  command: string | null;
  unverifiable: boolean;
  detail: string;
}

/** Read-only ownership inspection; malformed and ownerless legacy locks remain held. */
export function probeLockHolder(lockDir: string): LockProbe {
  return probeOwner(lockSnapshot(lockDir));
}

function probeOwner(snapshot: LockSnapshot | null | undefined): LockProbe {
  if (snapshot === undefined) return { held: false, pid: null, command: null, unverifiable: false, detail: "No lock directory" };
  if (snapshot === null) return { held: true, pid: null, command: null, unverifiable: true, detail: "Lock owner is missing, malformed or replaced" };
  const { owner } = snapshot;
  if (Object.hasOwn(owner, "processIdentity") && !validProcessIdentity(owner.processIdentity)) {
    return { held: true, pid: owner.pid, command: null, unverifiable: true, detail: "Stored process identity is malformed" };
  }
  if (!isAlive(owner.pid)) return { held: false, pid: owner.pid, command: null, unverifiable: false, detail: `Owner pid ${owner.pid} has exited` };
  const hasIdentity = Object.hasOwn(owner, "processIdentity");
  if (hasIdentity) {
    const identity = processIdentity(owner.pid);
    if (identity === null) return { held: true, pid: owner.pid, command: null, unverifiable: true, detail: `Cannot verify process identity for pid ${owner.pid}` };
    if (identity !== owner.processIdentity) {
      return { held: false, pid: owner.pid, command: processCommand(owner.pid), unverifiable: false, detail: `Pid ${owner.pid} was reused` };
    }
  }
  const command = processCommand(owner.pid);
  if (command === null) return { held: true, pid: owner.pid, command: null, unverifiable: true, detail: `Cannot inspect pid ${owner.pid}` };
  if (hasIdentity || command.includes("ruukoto") || command.includes("cli.ts") || command.includes("dev.ts")) {
    return { held: true, pid: owner.pid, command, unverifiable: false, detail: `Live owner: pid ${owner.pid}` };
  }
  return { held: false, pid: owner.pid, command, unverifiable: false, detail: `Legacy pid ${owner.pid} belongs to another command` };
}

/** Atomically publishes a complete owner; the parent inode serializes conditional takeover and release. */
export function acquireDirectoryLock(lockDir: string, label = "Profile lock"): AcquiredLock {
  const identity = processIdentity(process.pid);
  if (identity === null) throw new InstanceLockError(`${label}: cannot verify this process; inspect ${lockDir}`, true);
  const parent = fs.realpathSync(path.dirname(lockDir)), target = path.basename(lockDir), parentIdentity = fs.statSync(parent);
  lockDir = path.join(parent, target);
  const stage = fs.mkdtempSync(path.join(parent, `.${target}.prepare-`));
  fs.chmodSync(stage, 0o700);
  const stageIdentity = fs.lstatSync(stage);
  const owner: LockOwner = { pid: process.pid, command: "ruukoto-backend", startedAt: new Date().toISOString(), processIdentity: identity };
  const bytes = JSON.stringify(owner) + "\n";
  const owned: LockIdentity = { dev: stageIdentity.dev, ino: stageIdentity.ino, ownerHash: createHash("sha256").update(bytes).digest("hex") };
  let installed = false;
  try {
    const ownerPath = path.join(stage, "owner.json");
    fs.writeFileSync(ownerPath, bytes, { mode: 0o600, flag: "wx" });
    const ownerFd = fs.openSync(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(ownerFd); } finally { fs.closeSync(ownerFd); }
    fs.chmodSync(ownerPath, 0o400);
    // Linux blocks predecessor unlink through the directory mode; macOS seals the owner before publication.
    fs.chmodSync(stage, process.platform === "darwin" ? 0o700 : 0o500);
    const stageFd = fs.openSync(stage, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(stageFd); } finally { fs.closeSync(stageFd); }
    for (let attempt = 0; attempt < 16; attempt++) {
      const expected = lockSnapshot(lockDir);
      const probe = probeOwner(expected);
      if (probe.held) throw new InstanceLockError(`${label}: ${probe.detail}; inspect ${lockDir}`, probe.unverifiable);
      const result = publishDirectory({ parent, parentIdentity, stage, target, identity: stageIdentity, lock: { expected: expected ?? null } });
      if (result === "installed") { installed = true; break; }
    }
    if (!installed) throw new InstanceLockError(`${label}: concurrent ownership changed; retry ${lockDir}`, true);
  } finally {
    if (!installed && fs.existsSync(stage) && sameFileIdentity(fs.lstatSync(stage), stageIdentity)) {
      fs.chmodSync(stage, 0o700);
      fs.rmSync(stage, { recursive: true });
    }
  }
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    try { releaseDirectoryLock(parent, parentIdentity, target, owned); }
    catch (error) {
      // Leaving a verifiable stale lock is safer than deleting an unverified successor.
      process.stderr.write(`[ruukoto:lock] Could not release ${lockDir}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  } };
}

export function acquireInstanceLock(dataDir: string): AcquiredLock {
  return acquireDirectoryLock(path.join(dataDir, "runtime.lock"), "Instance lock");
}

export function acquireConfigLock(agentDir: string): AcquiredLock {
  return acquireDirectoryLock(path.join(agentDir, "config.lock"), "Configuration lock");
}
