import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireConfigLock, acquireInstanceLock, type AcquiredLock } from "./instance-lock.ts";
import { sameFileIdentity } from "./exclusive-fs.ts";
import { directoryIdentity, fileExists, ProfileError, verifyPinned, type PinnedDirectory } from "./profile-files.ts";
import type { ProfileSelection } from "./profile.ts";
import { inspectSharedPredecessor } from "./profile-predecessor-shared.ts";
import { inspectDurablePredecessor, validateDurableManifest } from "./profile-predecessor-durable.ts";

interface FileSnapshot { file: string; dev: number; ino: number; size: number; digest: string }
export interface PredecessorExclusion { verify(): void; release(): void }

function snapshot(file: string, copy?: string): FileSnapshot {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid!()) throw new ProfileError("old_profile_unrecognized", `Unsafe predecessor file: ${file}`);
    const digest = createHash("sha256");
    const output = copy ? fs.openSync(copy, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600) : null;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        digest.update(buffer.subarray(0, count));
        if (output !== null) {
          let written = 0;
          while (written < count) written += fs.writeSync(output, buffer, written, count - written);
        }
      }
      if (output !== null) fs.fsyncSync(output);
    } finally { if (output !== null) fs.closeSync(output); }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!sameFileIdentity(before, after) || !sameFileIdentity(before, named) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new ProfileError("old_profile_changed", `Predecessor changed during inspection: ${file}`);
    }
    return { file, dev: before.dev, ino: before.ino, size: before.size, digest: digest.digest("hex") };
  } finally { fs.closeSync(fd); }
}

function coherentDatabaseCopy(file: string, inspect: (copy: string) => void): { verify(): void } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-profile-inspect-"));
  fs.chmodSync(temporary, 0o700);
  const suffixes = ["", "-wal", "-shm", "-journal"];
  const expected = new Map<string, FileSnapshot>();
  try {
    if (!fileExists(file)) throw new ProfileError("old_profile_unrecognized", `Missing predecessor database: ${file}`);
    if (fileExists(file + "-journal")) {
      const journal = fs.readFileSync(file + "-journal");
      if (journal.length && journal.subarray(0, 8).some(byte => byte !== 0)) throw new ProfileError("old_profile_journal_unverified", `Predecessor has an unresolved rollback journal: ${file}`);
    }
    for (const suffix of suffixes) if (fileExists(file + suffix)) expected.set(suffix, snapshot(file + suffix, suffix === "-shm" ? undefined : path.join(temporary, path.basename(file) + suffix)));
    const verify = () => {
      for (const suffix of suffixes) {
        const old = expected.get(suffix), exists = fileExists(file + suffix);
        if (exists !== Boolean(old)) throw new ProfileError("old_profile_changed", `Predecessor sidecar set changed: ${file}`);
        if (old && JSON.stringify(snapshot(file + suffix)) !== JSON.stringify(old)) throw new ProfileError("old_profile_changed", `Predecessor bytes changed: ${file + suffix}`);
      }
    };
    verify();
    inspect(path.join(temporary, path.basename(file)));
    verify();
    return { verify };
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError("old_profile_inspection_failed", `Cannot inspect predecessor database: ${file}`, { cause });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function nonempty(directory: string, ignored: readonly string[] = []): boolean {
  return fileExists(directory) && fs.readdirSync(directory).some(name => !ignored.includes(name) && !name.startsWith(".runtime.lock.") && !name.startsWith(".config.lock."));
}

function inspectRoleFiles(directory: string, role: "agent" | "control" | "pending", recognized: boolean): void {
  if (!fileExists(directory) || !nonempty(directory, ["config.lock"])) return;
  if (!recognized) throw new ProfileError("old_profile_unrecognized", `Selected ${role} has data without a recognized predecessor: ${directory}`);
  // Archived e7838ea5d1b1: runtime/subagent-role-library.ts and runtime/workflow-library.ts.
  const allowed = role === "agent" ? /^(models\.json|auth\.json|default-model\.json|summary-model\.json|credentials\.json|model-metadata\.json|config\.lock|skills|managed-skills|agents|workflows|mcp.*|web-search.*)$/
    : role === "control" ? /^(owner\.token|control\.sock|spawn\.log)$/ : /^(?:[A-Za-z0-9_.-]+\.json|desktop|tui)$/;
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith(".config.lock.")) continue;
    if (!allowed.test(name)) throw new ProfileError("old_profile_unrecognized", `Unrecognized predecessor ${role} entry: ${path.join(directory, name)}`);
    const info = fs.lstatSync(path.join(directory, name));
    if (info.isSymbolicLink() || info.uid !== process.getuid!() || !info.isDirectory() && !info.isFile() && !(role === "control" && name === "control.sock" && info.isSocket())) {
      throw new ProfileError("old_profile_unrecognized", `Unsafe predecessor ${role} entry: ${path.join(directory, name)}`);
    }
  }
}

function lockDurable(directory: string): { verify(): void; release(): void } {
  const file = path.join(directory, "owner.sqlite");
  if (!fileExists(file) || fileExists(file + "-wal") || fileExists(file + "-shm")) {
    throw new ProfileError("old_profile_lock_unverifiable", `Durable predecessor requires its existing rollback owner lock: ${file}`);
  }
  const before = snapshot(file);
  if (before.size > 65_536) throw new ProfileError("old_profile_lock_unverifiable", `Owner lock is not an empty lock database: ${file}`);
  const journalPath = file + "-journal";
  const journal = fileExists(journalPath) ? snapshot(journalPath) : null;
  if (journal) {
    const header = Buffer.alloc(8), journalFd = fs.openSync(journalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.readSync(journalFd, header, 0, header.length, 0); } finally { fs.closeSync(journalFd); }
    if (header.some(byte => byte !== 0)) throw new ProfileError("old_profile_journal_unverified", `Owner lock has an unresolved rollback journal: ${journalPath}`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let owner: DatabaseSync;
  try { owner = new DatabaseSync(file, { readOnly: true }); }
  catch (cause) { fs.closeSync(fd); throw new ProfileError("old_profile_lock_unverifiable", `Cannot open owner lock: ${file}`, { cause }); }
  try {
    const mode = owner.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    if (!["delete", "truncate", "persist"].includes(mode.journal_mode)) throw new ProfileError("old_profile_lock_unverifiable", `Unsupported owner journal mode: ${file}`);
    if ((owner.prepare("SELECT name FROM sqlite_schema").all()).length !== 0) throw new ProfileError("old_profile_lock_unverifiable", `Foreign owner lock schema: ${file}`);
    owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (cause) {
    owner.close(); fs.closeSync(fd);
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError("old_profile_busy", `Durable predecessor ownership cannot be excluded: ${directory}`, { cause });
  }
  const verify = () => {
    if (fileExists(journalPath) !== Boolean(journal) || journal && JSON.stringify(snapshot(journalPath)) !== JSON.stringify(journal)) {
      throw new ProfileError("old_profile_changed", `Owner journal changed: ${journalPath}`);
    }
    const current = fs.lstatSync(file), opened = fs.fstatSync(fd);
    if (!sameFileIdentity(current, before) || !sameFileIdentity(opened, before) || current.size !== before.size) throw new ProfileError("old_profile_changed", `Durable owner lock changed: ${file}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const size = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!size) throw new ProfileError("old_profile_changed", `Durable owner lock truncated: ${file}`);
      offset += size;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== before.digest) throw new ProfileError("old_profile_changed", `Durable owner lock bytes changed: ${file}`);
  };
  return { verify, release() { try { owner.exec("ROLLBACK"); } finally { owner.close(); fs.closeSync(fd); } } };
}

/** Excludes only selected predecessor paths and inspects coherent copies, never running recovery. */
export function excludePredecessorProfiles(selection: ProfileSelection): PredecessorExclusion {
  const pins: PinnedDirectory[] = [], locks: AcquiredLock[] = [], verifiers: Array<() => void> = [];
  let durableLock: { verify(): void; release(): void } | null = null;
  const release = () => {
    durableLock?.release();
    for (const lock of locks.reverse()) lock.release();
  };
  try {
    for (const pin of selection.pins) verifyPinned(pin);
    if (process.getuid!() === 0) throw new ProfileError("old_profile_lock_unverifiable", "Profile bootstrap requires an ordinary user account to exclude predecessor writers.");
    const durable = fileExists(path.join(selection.dataDir, "profile.json"));
    if (durable) {
      const manifestFile = path.join(selection.dataDir, "profile.json"), manifestSnapshot = snapshot(manifestFile);
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      validateDurableManifest(manifest);
      pins.push(directoryIdentity(selection.dataDir));
      durableLock = lockDurable(selection.dataDir);
      verifiers.push(durableLock.verify);
      verifiers.push(() => { if (JSON.stringify(snapshot(manifestFile)) !== JSON.stringify(manifestSnapshot)) throw new ProfileError("old_profile_changed", `Durable manifest changed: ${manifestFile}`); });
      const copy = coherentDatabaseCopy(path.join(selection.dataDir, "personal.sqlite"), file => inspectDurablePredecessor(file, manifest));
      verifiers.push(copy.verify);
    }
    // The same canonical order is used even when roles live on different filesystems.
    const oldRoles = [{ directory: selection.dataDir, kind: "data" }, { directory: selection.agentDir, kind: "agent" }] as const;
    for (const { directory, kind } of [...oldRoles].sort((a, b) => a.directory.localeCompare(b.directory))) {
      if (durable && kind === "data") continue;
      if (!fileExists(directory)) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      pins.push(directoryIdentity(directory));
      locks.push(kind === "data" ? acquireInstanceLock(directory) : acquireConfigLock(directory));
    }
    const shared = !durable && fileExists(path.join(selection.dataDir, "ruukoto.db"));
    if (shared) verifiers.push(coherentDatabaseCopy(path.join(selection.dataDir, "ruukoto.db"), file => inspectSharedPredecessor(file, { dataDir: selection.dataDir })).verify);
    if (shared || durable) {
      const files = shared ? /^(ruukoto\.db(?:-wal|-shm|-journal)?|runtime\.lock)$/
        : /^(profile\.json|profile\.json\.tmp|owner\.sqlite(?:-journal)?|personal\.sqlite(?:-wal|-shm)?|(?:model|skills|telegram|qq|service|command|mcp|tools|web-search|browser)\.json(?:\.tmp)?|control\.token(?:\.tmp)?|control\.sock|backend\.log|pending-[A-Za-z0-9-]+\.json)$/;
      const directories = new Set(shared
        ? ["sessions", "artifacts", "attachment-staging", "inbound-media", "agent-data", "browser", "background-executions", "background-logs", "cua-executions"]
        : ["commands", "background", "file-search", "artifacts", "attachment-staging", "browser", "agent-data", "managed-skills"]);
      for (const name of fs.readdirSync(selection.dataDir)) {
        if (name.startsWith(".runtime.lock.")) continue;
        const info = fs.lstatSync(path.join(selection.dataDir, name));
        if (info.isSymbolicLink() || info.uid !== process.getuid!() ||
            (directories.has(name) ? !info.isDirectory() : !files.test(name) || !info.isFile() && !(name === "runtime.lock" && info.isDirectory()) && !(name === "control.sock" && info.isSocket()))) {
          throw new ProfileError("old_profile_unrecognized", `Unrecognized predecessor entry: ${path.join(selection.dataDir, name)}`);
        }
      }
    }
    else if (!durable && nonempty(selection.dataDir, ["runtime.lock"])) throw new ProfileError("old_profile_unrecognized", `Selected data directory is not a recognized predecessor: ${selection.dataDir}`);
    for (const role of ["agent", "control", "pending"] as const) inspectRoleFiles(selection[`${role}Dir`], role, shared || durable);
    const verify = () => { for (const pin of pins) verifyPinned(pin); for (const check of verifiers) check(); };
    verify();
    return { verify, release };
  } catch (error) {
    release();
    if (error instanceof ProfileError) throw error;
    throw new ProfileError("old_profile_unverifiable", `Cannot exclude selected predecessor paths: ${JSON.stringify([selection.dataDir, selection.agentDir, selection.controlDir, selection.pendingDir])}`, { cause: error });
  }
}
