import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ControlConnection, type ConnectionState } from "@ruukoto/control/connection.ts";
import { DatabaseIdentityError, Db, SCHEMA_VERSION, SchemaVersionError } from "@ruukoto/core/db.ts";
import { bootstrapProfile, PROFILE_LAYOUT, PROFILE_ROLES, ProfileError, readProfile, ROLE_MARKER, selectProfile, verifyProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-required-profile-")));
  const profile = await bootstrapProfile(selectProfile({ dataDir: path.join(root, "data") }, {}));
  return { root, profile, cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(profile.socketPath), { recursive: true, force: true });
  } };
}

const unavailable = (code: string) => (error: unknown): boolean => error instanceof ProfileError && error.code === code && error.cause instanceof Error;

test("activated database reopen cannot recreate a missing database with its previous binding", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.profile.dataDir, "ruukoto.db");
    verifyProfile(f.profile);
    fs.renameSync(file, path.join(f.root, "saved.db"));
    assert.throws(() => new Db(f.profile.dataDir, undefined, f.profile), unavailable("profile_database_unavailable"));
    assert.equal(fs.existsSync(file), false);
    fs.renameSync(path.join(f.root, "saved.db"), file);
    assert.deepEqual(readProfile(f.profile.selection), f.profile);
  } finally { f.cleanup(); }
});

test("runtime rejects deletion between profile verification and database reopen without resetting identity", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.profile.dataDir, "ruukoto.db");
    const activation = fs.readFileSync(path.join(f.profile.rootDir, "profile.json"));
    // start() reaches its endpoint await before the database open; deletion here is deterministic.
    const starting = Runtime.start({ profile: f.profile });
    fs.renameSync(file, path.join(f.root, "saved.db"));
    await assert.rejects(starting, unavailable("profile_database_unavailable"));
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readFileSync(path.join(f.profile.rootDir, "profile.json")), activation);
    assert.equal(fs.existsSync(path.join(f.profile.dataDir, "runtime.lock")), false);
    assert.equal(fs.existsSync(path.join(f.profile.agentDir, "config.lock")), false);
    fs.renameSync(path.join(f.root, "saved.db"), file);
    assert.equal(readProfile(f.profile.selection)!.instanceId, f.profile.instanceId);
  } finally { f.cleanup(); }
});

test("prepared creation reserves one identity and writable URI reopening preserves encoded filenames", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-db-uri-")));
  const binding = { instanceId: randomUUID(), preparationId: randomUUID(), layout: PROFILE_LAYOUT };
  const file = "reserved ?#% 数据.db";
  try {
    const created = Db.createPrepared(root, file, binding);
    try {
      assert.equal(created.getInstanceId(), binding.instanceId);
      created.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("reopen-sentinel", "before");
    } finally { created.close(); }
    assert.throws(() => Db.createPrepared(root, file, binding), { code: "EEXIST" });
    const reopened = new Db(root, file, binding);
    try {
      assert.equal(reopened.getInstanceId(), binding.instanceId);
      assert.equal(reopened.prepare("SELECT value FROM meta WHERE key = 'reopen-sentinel'").get()!.value, "before");
      reopened.prepare("UPDATE meta SET value = 'after' WHERE key = 'reopen-sentinel'").run();
    } finally { reopened.close(); }
    const again = new Db(root, file, binding);
    try { assert.equal(again.prepare("SELECT value FROM meta WHERE key = 'reopen-sentinel'").get()!.value, "after"); }
    finally { again.close(); }
    assert.deepEqual(fs.readdirSync(root), [file]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const requiredObjects: { name: string; target(profile: ProfilePaths): string; code: string }[] = [
  ...PROFILE_ROLES.map(role => ({ name: `${role} role`, target: (profile: ProfilePaths) => profile[`${role}Dir`], code: "profile_path_unavailable" })),
  ...PROFILE_ROLES.map(role => ({ name: `${role} marker`, target: (profile: ProfilePaths) => path.join(profile[`${role}Dir`], ROLE_MARKER), code: "profile_record_invalid" })),
  { name: "database", target: profile => path.join(profile.dataDir, "ruukoto.db"), code: "profile_database_unavailable" },
  { name: "owner token", target: profile => path.join(profile.controlDir, "owner.token"), code: "profile_token_invalid" },
];

for (const required of requiredObjects) test(`missing activated ${required.name} is a terminal profile rejection`, async () => {
  const f = await fixture();
  const states: ConnectionState[] = [];
  let connection: ControlConnection | undefined;
  try {
    const activationFile = path.join(f.profile.rootDir, "profile.json"), preparationFile = path.join(f.profile.rootDir, "preparation.json");
    const activation = fs.readFileSync(activationFile), preparation = fs.readFileSync(preparationFile);
    const target = required.target(f.profile), displaced = path.join(f.root, "displaced");
    fs.renameSync(target, displaced);
    assert.throws(() => readProfile(f.profile.selection), unavailable(required.code));
    assert.throws(() => verifyProfile(f.profile), unavailable(required.code));
    await assert.rejects(bootstrapProfile(f.profile.selection), unavailable(required.code));
    let tokenReads = 0;
    connection = new ControlConnection({ profile: f.profile, token: async () => { tokenReads++; return "unused"; } }, {
      onState(state, _detail, error) {
        states.push(state);
        if (state === "failed") { assert.equal(error?.code, required.code); assert.equal(error?.outcome, "rejected"); }
      },
      onSnapshot() { assert.fail("missing required storage must reject before connecting"); },
      onEvent() { assert.fail("missing required storage must reject before observing"); },
    });
    await assert.rejects(connection.start(), unavailable(required.code));
    assert.equal(connection.state, "failed");
    assert.deepEqual(states, ["failed"], "reconnecting must never be scheduled");
    assert.equal(tokenReads, 0);
    assert.equal(fs.existsSync(target), false, "required state must not be reconstructed");
    assert.deepEqual(fs.readFileSync(activationFile), activation);
    assert.deepEqual(fs.readFileSync(preparationFile), preparation);
    fs.renameSync(displaced, target);
    assert.deepEqual(readProfile(f.profile.selection), f.profile);
  } finally { connection?.close(); f.cleanup(); }
});

test("database diagnostics retain their codes while corrupt profile validation fails terminally", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.profile.dataDir, "ruukoto.db");
    const update = (key: string, value: string) => {
      const raw = new DatabaseSync(file);
      try { raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, key); }
      finally { raw.close(); }
    };
    update("schema_version", String(SCHEMA_VERSION + 1));
    assert.throws(() => new Db(f.profile.dataDir, undefined, f.profile), error => error instanceof SchemaVersionError && error.code === "schema_version_unsupported");
    assert.throws(() => readProfile(f.profile.selection), { code: "profile_database_binding" });
    update("schema_version", String(SCHEMA_VERSION));
    update("instance_id", randomUUID());
    assert.throws(() => new Db(f.profile.dataDir, undefined, f.profile), error => error instanceof DatabaseIdentityError && error.code === "database_identity_mismatch");
    assert.throws(() => readProfile(f.profile.selection), { code: "profile_database_binding" });
    fs.writeFileSync(file, "not a SQLite database\n");
    assert.throws(() => new Db(f.profile.dataDir, undefined, f.profile), error => error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" && "errcode" in error && error.errcode === 26);
    assert.throws(() => readProfile(f.profile.selection), unavailable("profile_database_invalid"));
    const states: ConnectionState[] = [];
    const connection = new ControlConnection({ profile: f.profile, token: "unused" }, {
      onState(state) { states.push(state); },
      onSnapshot() { assert.fail("corrupt storage must reject before connecting"); },
      onEvent() { assert.fail("corrupt storage must reject before observing"); },
    });
    try {
      await assert.rejects(connection.start(), unavailable("profile_database_invalid"));
      assert.equal(connection.state, "failed");
      assert.deepEqual(states, ["failed"]);
    } finally { connection.close(); }
  } finally { f.cleanup(); }
});
