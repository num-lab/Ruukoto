import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Db, SCHEMA_VERSION, type DatabaseBinding } from "./db.ts";
import { acquireDirectoryLock, InstanceLockError, type AcquiredLock } from "./instance-lock.ts";
import { publishDirectory, publishFile, sameFileIdentity } from "./exclusive-fs.ts";
import { directoryIdentity, ensurePrivateDirectory, fileExists, plainRecord, ProfileError, readPrivateJson, savePrivateJson, syncDirectory, validPin, verifyPinned, type PinnedDirectory } from "./profile-files.ts";
import { PROFILE_LAYOUT, PROFILE_ROLES, ROLE_MARKER, profileStorage, profileStorageFromRoles, selectionTuple, type ProfilePaths, type ProfileRole, type ProfileSelection } from "./profile.ts";
import { excludePredecessorProfiles, type PredecessorExclusion } from "./profile-predecessor.ts";
import { PRODUCT, PRODUCT_META_KEY } from "./product.ts";
import { PROTOCOL_VERSION } from "./types.ts";

interface RolePreparation { parent: PinnedDirectory; stage: PinnedDirectory | null; installed: boolean }
interface Preparation {
  layout: typeof PROFILE_LAYOUT;
  schema: number;
  protocol: number;
  instanceId: string;
  preparationId: string;
  selection: ProfileSelection;
  effective: Record<ProfileRole, string>;
  temporaryRoot: PinnedDirectory;
  root: PinnedDirectory;
  roles: Record<ProfileRole, RolePreparation | null>;
  socketPath: string;
  controlBindingDigest: string;
}
interface Activation extends Preparation { activated: true }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Internal crash/byte-limit seam; ordinary entry points supply only the raw selection. */
export interface ProfileBootstrapHooks { checkpoint?(name: string): void; socketByteLimit?: number }

function binding(record: Preparation): DatabaseBinding {
  return { instanceId: record.instanceId, layout: PROFILE_LAYOUT, preparationId: record.preparationId };
}

function makePaths(record: Preparation): ProfilePaths {
  return { ...profileStorageFromRoles(record.selection, record.root.path, record.effective), ...binding(record), layout: PROFILE_LAYOUT,
    socketPath: record.socketPath, controlBindingDigest: record.controlBindingDigest,
    desktopDraftKey: `${PROFILE_LAYOUT}:${record.instanceId}:draft` };
}

function readRecord(file: string, selection: ProfileSelection, active: boolean): Preparation {
  const value = readPrivateJson(file);
  if (!plainRecord(value) || !plainRecord(value.selection) || !plainRecord(value.effective) || !plainRecord(value.roles)) {
    throw new ProfileError("profile_record_invalid", `Malformed profile record: ${file}`);
  }
  const raw = value.selection, effective = value.effective;
  if (value.layout !== PROFILE_LAYOUT || value.schema !== SCHEMA_VERSION || value.protocol !== PROTOCOL_VERSION ||
      !UUID.test(String(value.instanceId)) || !UUID.test(String(value.preparationId)) || raw.kind !== "selection" ||
      !Array.isArray(raw.pins) || raw.pins.length === 0 || !raw.pins.every(validPin) || !validPin(value.root) || !validPin(value.temporaryRoot) ||
      Object.keys(value.roles).sort().join(",") !== "agent,control,data,pending" ||
      Object.keys(effective).sort().join(",") !== "agent,control,data,pending" ||
      Object.keys(raw).sort().join(",") !== "agentDir,controlDir,dataDir,kind,pendingDir,pins" ||
      !PROFILE_ROLES.every(role => typeof raw[`${role}Dir`] === "string" && path.isAbsolute(String(raw[`${role}Dir`])) && typeof effective[role] === "string") ||
      typeof value.socketPath !== "string" || !/^[0-9a-f]{64}$/.test(String(value.controlBindingDigest)) ||
      (active ? value.activated !== true : Object.hasOwn(value, "activated"))) {
    throw new ProfileError("profile_version_or_record", `Unsupported or corrupt profile record: ${file}`);
  }
  const pins = raw.pins as PinnedDirectory[];
  if (!PROFILE_ROLES.every(role => pins.some(pin => pin.path === raw[`${role}Dir`] || String(raw[`${role}Dir`]).startsWith(pin.path === path.sep ? pin.path : pin.path + path.sep)))) {
    throw new ProfileError("profile_record_invalid", `Raw selections lack ancestor bindings: ${file}`);
  }
  const record = value as unknown as Preparation;
  if (JSON.stringify(selectionTuple(record.selection)) !== JSON.stringify(selectionTuple(selection))) {
    throw new ProfileError("profile_selection_conflict", `This generation is bound to ${JSON.stringify(selectionTuple(record.selection))}; selected ${JSON.stringify(selectionTuple(selection))}`);
  }
  for (const role of PROFILE_ROLES) {
    const item = record.roles[role];
    if (item !== null && (!plainRecord(item) || !validPin(item.parent) || item.stage !== null && !validPin(item.stage) || typeof item.installed !== "boolean")) {
      throw new ProfileError("profile_record_invalid", `Invalid ${role} preparation in ${file}`);
    }
    if (item && (item.parent.path !== path.dirname(record.effective[role]) || item.stage &&
        (path.dirname(item.stage.path) !== item.parent.path || !path.basename(item.stage.path).startsWith(".profile-stage-role-")))) {
      throw new ProfileError("profile_record_invalid", `Invalid ${role} staging path in ${file}`);
    }
  }
  verifyPreparationBindings(record);
  return record;
}

function verifyPreparationBindings(record: Preparation): void {
  for (const pin of record.selection.pins) verifyPinned(pin);
  verifyPinned(record.root);
  verifyPinned(record.temporaryRoot);
  if (record.temporaryRoot.path !== fs.realpathSync("/tmp")) throw new ProfileError("profile_path_changed", "Canonical temporary root changed");
  const storage = profileStorage(record.selection);
  if (record.root.path !== storage.rootDir || PROFILE_ROLES.some(role => record.effective[role] !== storage[`${role}Dir`])) {
    throw new ProfileError("profile_path_changed", `Prepared storage tuple changed: ${record.root.path}`);
  }
  const expected = endpointIdentity(record.selection, record.instanceId, record.effective.control, record.temporaryRoot.path);
  if (expected.digest !== record.controlBindingDigest || expected.socketPath !== record.socketPath) {
    throw new ProfileError("profile_endpoint_binding", `Stored endpoint identity differs: ${record.socketPath}`);
  }
}

function endpointIdentity(selection: ProfileSelection, instanceId: string, controlDir: string, temporary: string) {
  const digest = createHash("sha256").update(JSON.stringify([PROFILE_LAYOUT, selectionTuple(selection), instanceId, controlDir])).digest("hex");
  const address = digest.slice(0, 32);
  const socketPath = path.join(temporary, `ruukoto-${process.getuid!()}`, address, "control.sock");
  return { digest, socketPath };
}

function verifySocketLength(socketPath: string, hooks: ProfileBootstrapHooks = {}): void {
  const limit = hooks.socketByteLimit ?? (process.platform === "darwin" ? 103 : process.platform === "linux" ? 107 : 0);
  if (!limit || Buffer.byteLength(socketPath) > limit) throw new ProfileError("profile_socket_path_too_long", `Socket path uses ${Buffer.byteLength(socketPath)} bytes, limit ${limit}: ${socketPath}`);
}

function endpointBinding(profile: ProfilePaths) {
  return { layout: profile.layout, instanceId: profile.instanceId, preparationId: profile.preparationId,
    digest: profile.controlBindingDigest, controlDir: profile.controlDir, socketPath: profile.socketPath };
}

function verifyEndpoint(profile: ProfilePaths): void {
  const uidDir = path.dirname(path.dirname(profile.socketPath)), endpoint = path.dirname(profile.socketPath);
  if (!fileExists(uidDir)) return;
  directoryIdentity(uidDir, true);
  if (!fileExists(endpoint)) return;
  directoryIdentity(endpoint, true);
  const file = path.join(endpoint, "binding.json");
  if (!fileExists(file) || JSON.stringify(readPrivateJson(file)) !== JSON.stringify(endpointBinding(profile))) {
    throw new ProfileError("profile_endpoint_collision", `Socket address belongs to another binding: ${endpoint}`);
  }
  if (fileExists(profile.socketPath)) {
    const info = fs.lstatSync(profile.socketPath);
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid!()) {
      throw new ProfileError("profile_endpoint_occupied", `Socket address is occupied by an unrecognized object: ${profile.socketPath}`);
    }
  }
}

function prepareEndpoint(profile: ProfilePaths): void {
  const uidDir = path.dirname(path.dirname(profile.socketPath)), endpoint = path.dirname(profile.socketPath);
  const parent = ensurePrivateDirectory(uidDir);
  if (fileExists(endpoint)) { verifyEndpoint(profile); return; }
  const stage = fs.mkdtempSync(path.join(uidDir, ".profile-stage-endpoint-"));
  fs.chmodSync(stage, 0o700);
  savePrivateJson(path.join(stage, "binding.json"), endpointBinding(profile), true);
  const identity = directoryIdentity(stage, true);
  try {
    publishDirectory({ parent: uidDir, parentIdentity: parent, stage, target: endpoint, identity });
  } catch (cause) {
    if (!fileExists(endpoint)) throw new ProfileError("profile_endpoint_unavailable", `Cannot claim socket endpoint: ${endpoint}`, { cause });
    verifyEndpoint(profile);
  }
  verifyEndpoint(profile);
}

function marker(record: Preparation, role: ProfileRole) {
  const selected = Object.fromEntries(PROFILE_ROLES.map(name => [`${name}Dir`, record.selection[`${name}Dir`]]));
  return { ...binding(record), role, selection: selected };
}

function verifyRole(record: Preparation, role: ProfileRole, final: boolean): void {
  const receipt = record.roles[role];
  if (!receipt?.stage) throw new ProfileError("profile_role_missing", `No ${role} installation identity`);
  verifyPinned(receipt.parent);
  const target = final ? makePaths(record)[`${role}Dir`] : receipt.stage.path;
  const actual = directoryIdentity(target, true);
  if (!sameFileIdentity(actual, receipt.stage)) throw new ProfileError("profile_path_changed", `Recorded ${role} directory was replaced: ${target}`);
  if (JSON.stringify(readPrivateJson(path.join(target, ROLE_MARKER))) !== JSON.stringify(marker(record, role))) {
    throw new ProfileError("profile_role_binding", `Role marker differs: ${target}`);
  }
  if (role === "data") {
    const file = path.join(target, "ruukoto.db");
    let info: fs.Stats;
    try { info = fs.lstatSync(file); }
    catch (cause) { throw new ProfileError("profile_database_unavailable", `Required profile database is unavailable: ${file}`, { cause }); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid!()) throw new ProfileError("profile_database_invalid", `Invalid database file: ${file}`);
    // Current-format metadata reads may use WAL; predecessor databases use coherent private copies instead.
    let db: DatabaseSync;
    try { db = new DatabaseSync(file, { readOnly: true }); }
    catch (cause) {
      if (cause instanceof Error && "errcode" in cause && typeof cause.errcode === "number" && (cause.errcode & 0xff) === 14) {
        throw new ProfileError("profile_database_unavailable", `Cannot open required profile database: ${file}`, { cause });
      }
      throw new ProfileError("profile_database_invalid", `Cannot validate required profile database: ${file}`, { cause });
    }
    try {
      const get = (key: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
      if (get("schema_version") !== String(SCHEMA_VERSION) || get("instance_id") !== record.instanceId ||
          get("profile.layout") !== PROFILE_LAYOUT || get("profile.preparation_id") !== record.preparationId || get(PRODUCT_META_KEY) !== PRODUCT) {
        throw new ProfileError("profile_database_binding", `Database binding differs: ${file}`);
      }
    } catch (cause) {
      if (cause instanceof ProfileError) throw cause;
      throw new ProfileError("profile_database_invalid", `Cannot validate required profile database: ${file}`, { cause });
    } finally { db.close(); }
  }
  if (role === "control") {
    const tokenPath = path.join(target, "owner.token");
    let fd: number;
    try { fd = fs.openSync(tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (cause) { throw new ProfileError("profile_token_invalid", `Cannot open required owner token: ${tokenPath}`, { cause }); }
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600 ||
          info.size !== 65 || !/^[0-9a-f]{64}\n$/.test(fs.readFileSync(fd, "utf8"))) {
        throw new ProfileError("profile_token_invalid", `Invalid owner token: ${tokenPath}`);
      }
    } catch (cause) {
      if (cause instanceof ProfileError) throw cause;
      throw new ProfileError("profile_token_invalid", `Cannot read required owner token: ${tokenPath}`, { cause });
    } finally { fs.closeSync(fd); }
  }
}

function initializeRole(record: Preparation, role: ProfileRole, stage: string): void {
  const markerFile = path.join(stage, ROLE_MARKER);
  if (!fileExists(markerFile)) savePrivateJson(markerFile, marker(record, role), true);
  else if (JSON.stringify(readPrivateJson(markerFile)) !== JSON.stringify(marker(record, role))) throw new ProfileError("profile_role_binding", `Foreign role marker: ${markerFile}`);
  if (role === "data" && !fileExists(path.join(stage, "ruukoto.db"))) {
    const name = `.profile-stage-db-${randomUUID()}`;
    const db = Db.createPrepared(stage, name, binding(record));
    db.close();
    fs.chmodSync(path.join(stage, name), 0o600);
    publishFile(stage, path.join(stage, name), path.join(stage, "ruukoto.db"));
  }
  if (role === "control" && !fileExists(path.join(stage, "owner.token"))) {
    const file = path.join(stage, `.profile-stage-token-${randomUUID()}`);
    fs.writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    const fd = fs.openSync(file, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    publishFile(stage, file, path.join(stage, "owner.token"));
  }
  syncDirectory(stage);
}

function installRole(record: Preparation, role: ProfileRole, preparationFile: string, hooks: ProfileBootstrapHooks): void {
  verifyPreparationBindings(record);
  const target = record.effective[role];
  let receipt = record.roles[role];
  if (!receipt) {
    const parent = ensurePrivateDirectory(path.dirname(target));
    receipt = record.roles[role] = { parent, stage: null, installed: false };
    savePrivateJson(preparationFile, record, false, record.root);
  }
  verifyPinned(receipt.parent);
  if (fileExists(target)) {
    if (!receipt.stage || !sameFileIdentity(directoryIdentity(target, true), receipt.stage)) {
      throw new ProfileError("profile_role_foreign", `Unrecorded role target: ${target}`);
    }
    verifyRole(record, role, true);
    if (!receipt.installed) { receipt.installed = true; savePrivateJson(preparationFile, record, false, record.root); }
    return;
  }
  if (receipt.installed) throw new ProfileError("profile_role_missing", `Installed role is missing: ${target}`);
  if (!receipt.stage) {
    const stage = fs.mkdtempSync(path.join(receipt.parent.path, ".profile-stage-role-"));
    fs.chmodSync(stage, 0o700);
    syncDirectory(stage);
    syncDirectory(receipt.parent.path);
    hooks.checkpoint?.(`${role}:stage-created`);
    receipt.stage = directoryIdentity(stage, true);
    savePrivateJson(preparationFile, record, false, record.root);
    hooks.checkpoint?.(`${role}:stage-recorded`);
    verifyPreparationBindings(record);
  }
  verifyPinned(receipt.stage);
  initializeRole(record, role, receipt.stage.path);
  verifyRole(record, role, false);
  hooks.checkpoint?.(`${role}:before-install`);
  verifyPreparationBindings(record);
  verifyRole(record, role, false);
  publishDirectory({ parent: receipt.parent.path, parentIdentity: receipt.parent, stage: receipt.stage.path, target, identity: receipt.stage });
  hooks.checkpoint?.(`${role}:after-install`);
  verifyRole(record, role, true);
  receipt.installed = true;
  savePrivateJson(preparationFile, record, false, record.root);
  hooks.checkpoint?.(`${role}:installed-recorded`);
}

export function readProfile(selection: ProfileSelection): ProfilePaths | null {
  for (const pin of selection.pins) verifyPinned(pin);
  const storage = profileStorage(selection), activationFile = path.join(storage.rootDir, "profile.json");
  if (!fileExists(storage.rootDir)) return null;
  directoryIdentity(storage.rootDir, true);
  if (!fileExists(activationFile)) {
    if (fileExists(path.join(storage.rootDir, "preparation.json"))) readRecord(path.join(storage.rootDir, "preparation.json"), selection, false);
    else if (fs.readdirSync(storage.rootDir).some(name => !name.startsWith(".profile-stage-") && !name.startsWith(".bootstrap.lock") && name !== "bootstrap.lock")) {
      throw new ProfileError("profile_generation_unrecognized", `Nonempty generation has no valid preparation: ${storage.rootDir}`);
    }
    return null;
  }
  const record = readRecord(activationFile, selection, true);
  for (const role of PROFILE_ROLES) {
    if (!record.roles[role]?.installed) throw new ProfileError("profile_role_missing", `Activated role is incomplete: ${role}`);
    verifyRole(record, role, true);
  }
  const profile = makePaths(record);
  verifyEndpoint(profile);
  return profile;
}

export function verifyProfile(profile: ProfilePaths): void {
  const actual = readProfile(profile.selection);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(profile)) throw new ProfileError("profile_identity_changed", `Active profile differs: ${profile.rootDir}`);
}

export function ensureProfileEndpoint(profile: ProfilePaths): void {
  verifyProfile(profile);
  prepareEndpoint(profile);
}

async function waitForBootstrap(directory: string): Promise<AcquiredLock> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { return acquireDirectoryLock(path.join(directory, "bootstrap.lock"), "Profile bootstrap"); }
    catch (error) {
      if (!(error instanceof InstanceLockError) || error.unverifiable || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

export async function bootstrapProfile(selection: ProfileSelection, hooks: ProfileBootstrapHooks = {}): Promise<ProfilePaths> {
  const existing = readProfile(selection);
  if (existing) { prepareEndpoint(existing); return existing; }
  for (const pin of selection.pins) verifyPinned(pin);
  const storage = profileStorage(selection), root = ensurePrivateDirectory(storage.rootDir);
  const lock = await waitForBootstrap(storage.rootDir);
  let predecessor: PredecessorExclusion | null = null;
  try {
    const active = readProfile(selection);
    if (active) { prepareEndpoint(active); return active; }
    predecessor = excludePredecessorProfiles(selection);
    const preparationFile = path.join(storage.rootDir, "preparation.json"), activationFile = path.join(storage.rootDir, "profile.json");
    let record: Preparation;
    if (fileExists(preparationFile)) record = readRecord(preparationFile, selection, false);
    else {
      for (const role of PROFILE_ROLES) if (fileExists(storage[`${role}Dir`])) throw new ProfileError("profile_role_foreign", `Role target has no preparation: ${storage[`${role}Dir`]}`);
      const instanceId = randomUUID(), temporaryRoot = directoryIdentity(fs.realpathSync("/tmp"));
      const endpoint = endpointIdentity(selection, instanceId, storage.controlDir, temporaryRoot.path);
      record = { layout: PROFILE_LAYOUT, schema: SCHEMA_VERSION, protocol: PROTOCOL_VERSION, instanceId, preparationId: randomUUID(), selection, root,
        effective: { data: storage.dataDir, agent: storage.agentDir, control: storage.controlDir, pending: storage.pendingDir },
        temporaryRoot, roles: { data: null, agent: null, control: null, pending: null },
        socketPath: endpoint.socketPath, controlBindingDigest: endpoint.digest };
      savePrivateJson(preparationFile, record, true, root);
      hooks.checkpoint?.("preparation-published");
    }
    verifyPreparationBindings(record);
    verifySocketLength(record.socketPath, hooks);
    const profile = makePaths(record);
    prepareEndpoint(profile);
    if (fileExists(profile.socketPath)) throw new ProfileError("profile_endpoint_occupied", `Prepared endpoint is already occupied: ${profile.socketPath}`);
    for (const role of PROFILE_ROLES) installRole(record, role, preparationFile, hooks);
    for (const directory of [profile.workspaceDir, profile.workCopyDir, profile.logsDir, profile.tuiPendingDir, profile.desktopPendingDir]) ensurePrivateDirectory(directory);
    hooks.checkpoint?.("before-activation");
    predecessor.verify();
    const saved = readRecord(preparationFile, selection, false);
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new ProfileError("profile_identity_changed", `Preparation changed before activation: ${preparationFile}`);
    for (const role of PROFILE_ROLES) {
      if (!record.roles[role]?.installed) throw new ProfileError("profile_role_missing", `Prepared role is incomplete: ${role}`);
      verifyRole(record, role, true);
    }
    verifyEndpoint(profile);
    if (!fileExists(path.dirname(profile.socketPath))) throw new ProfileError("profile_endpoint_unavailable", `Prepared endpoint disappeared: ${profile.socketPath}`);
    if (fileExists(profile.socketPath)) throw new ProfileError("profile_endpoint_occupied", `Prepared endpoint is already occupied: ${profile.socketPath}`);
    const activation: Activation = { ...record, activated: true };
    savePrivateJson(activationFile, activation, true, record.root);
    hooks.checkpoint?.("after-activation");
    return readProfile(selection)!;
  } finally {
    predecessor?.release();
    lock.release();
  }
}
