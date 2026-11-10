import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import { bootstrapProfile, selectProfile, readProfile, profileStorage } from "@ruukoto/core/profile.ts";
import { acquireConfigLock, acquireInstanceLock } from "@ruukoto/core/instance-lock.ts";

const sharedDdl = fs.readFileSync(new URL("./fixtures/profile-predecessor/shared-schema58.sql", import.meta.url), "utf8");

function fixture(product = "ruukoto-code") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-predecessor-")));
  const dataDir = path.join(root, "data"), agentDir = path.join(root, "agent"), pendingDir = path.join(root, "pending");
  for (const directory of [dataDir, agentDir, pendingDir, path.join(root, "workspace"), path.join(root, "agent-work")]) fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(dataDir, "ruukoto.db"), db = new DatabaseSync(file);
  db.exec(sharedDdl);
  const insert = db.prepare("INSERT INTO meta VALUES (?, ?)");
  insert.run("schema_version", "58"); insert.run("product.type", product); insert.run("instance_id", randomUUID());
  fs.mkdirSync(path.join(dataDir, "sessions"));
  fs.writeFileSync(path.join(dataDir, "sessions", "committed.jsonl"), '{"history":"original"}\n');
  fs.writeFileSync(path.join(agentDir, "models.json"), '{"secret":"predecessor-only"}\n', { mode: 0o600 });
  // Archived e7838ea5d1b1 runtime role/workflow libraries store these exact directory names.
  fs.mkdirSync(path.join(agentDir, "agents"), { mode: 0o700 });
  fs.mkdirSync(path.join(agentDir, "workflows"), { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "agents", "reader.md"), "---\ndescription: Custom predecessor reader\ntools: [read]\n---\nRead the assigned source.\n");
  fs.writeFileSync(path.join(agentDir, "workflows", "batch.js"), "return { predecessor: true };\n");
  fs.writeFileSync(path.join(pendingDir, "pending.json"), '{"instance":"old","input":"do not replay"}\n');
  fs.writeFileSync(path.join(root, "workspace", "source.ts"), "original workspace\n");
  fs.writeFileSync(path.join(root, "agent-work", "source.ts"), "original work copy\n");
  const paths = [file, path.join(dataDir, "sessions", "committed.jsonl"), path.join(agentDir, "models.json"), path.join(agentDir, "agents", "reader.md"), path.join(agentDir, "workflows", "batch.js"), path.join(pendingDir, "pending.json"), path.join(root, "workspace", "source.ts"), path.join(root, "agent-work", "source.ts")];
  const hashes = () => paths.map(file => createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  const selection = selectProfile({ dataDir, agentDir, pendingDir }, {});
  let endpoint: string | undefined;
  return { root, dataDir, agentDir, pendingDir, db, selection, hashes, remember(socket: string) { endpoint = path.dirname(socket); }, cleanup() {
    db.close(); fs.rmSync(root, { recursive: true, force: true }); if (endpoint) fs.rmSync(endpoint, { recursive: true, force: true });
  } };
}

for (const product of ["ruukoto-code", "ruukoto"]) test(`stopped schema58 ${product} with custom roles and workflows receives blank state without changing old content`, async () => {
  const f = fixture(product);
  try {
    const before = f.hashes();
    const agentEntries = fs.readdirSync(f.agentDir, { recursive: true }).sort();
    const profile = await bootstrapProfile(f.selection);
    f.remember(profile.socketPath);
    assert.deepEqual(f.hashes(), before);
    assert.deepEqual(fs.readdirSync(f.agentDir, { recursive: true }).sort(), agentEntries);
    assert.equal(fs.existsSync(path.join(profile.agentDir, "models.json")), false);
    assert.equal(fs.existsSync(path.join(profile.agentDir, "agents")), false);
    assert.equal(fs.existsSync(path.join(profile.agentDir, "workflows")), false);
    assert.deepEqual(fs.readdirSync(profile.pendingDir).sort(), [".ruukoto-role.json", "desktop", "tui"]);
    const fresh = new DatabaseSync(path.join(profile.dataDir, "ruukoto.db"), { readOnly: true });
    try {
      assert.equal(fresh.prepare("SELECT count(*) AS count FROM tasks").get()!.count, 0);
      assert.notEqual(fresh.prepare("SELECT value FROM meta WHERE key='instance_id'").get()!.value, f.db.prepare("SELECT value FROM meta WHERE key='instance_id'").get()!.value);
    } finally { fresh.close(); }
  } finally { f.cleanup(); }
});

for (const kind of ["instance", "configuration", "ownerless"] as const) test(`old ${kind} ownership rejects before activating`, async () => {
  const f = fixture();
  const lock = kind === "instance" ? acquireInstanceLock(f.dataDir) : kind === "configuration" ? acquireConfigLock(f.agentDir) : null;
  if (kind === "ownerless") fs.mkdirSync(path.join(f.dataDir, "runtime.lock"));
  try {
    const before = f.hashes();
    await assert.rejects(bootstrapProfile(f.selection), { code: "old_profile_unverifiable" });
    assert.equal(readProfile(f.selection), null);
    assert.equal(fs.existsSync(path.join(profileStorage(f.selection).rootDir, "data")), false);
    assert.deepEqual(f.hashes(), before);
  } finally { lock?.release(); f.cleanup(); }
});

test("WAL-only residual occupancy rejects and preserves every original sidecar byte", async () => {
  const f = fixture();
  try {
    f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    f.db.prepare("INSERT INTO occupancy(cwd_real,cwd_dev,cwd_ino,session_id,task_id,acquired_at) VALUES ('/old',1,2,'gone','gone','2026-11-01T00:00:00Z')").run();
    const names = ["ruukoto.db", "ruukoto.db-wal", "ruukoto.db-shm"];
    const bytes = names.map(name => fs.readFileSync(path.join(f.dataDir, name)));
    await assert.rejects(bootstrapProfile(f.selection), { code: "old_profile_execution_unverified" });
    assert.equal(readProfile(f.selection), null);
    assert.deepEqual(names.map(name => fs.readFileSync(path.join(f.dataDir, name))), bytes);
    assert.equal(fs.existsSync(path.join(profileStorage(f.selection).rootDir, "profile.json")), false);
  } finally { f.cleanup(); }
});

test("unknown raw directory stays unchanged and is never adopted", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-unknown-profile-")));
  try {
    const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir); fs.writeFileSync(path.join(dataDir, "unrelated.txt"), "keep\n");
    await assert.rejects(bootstrapProfile(selectProfile({ dataDir }, {})), { code: "old_profile_unrecognized" });
    assert.deepEqual(fs.readdirSync(dataDir), ["unrelated.txt"]);
    assert.equal(fs.readFileSync(path.join(dataDir, "unrelated.txt"), "utf8"), "keep\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const directory of ["subagent-roles", "workflow-definitions", "unrecognized"]) test(`unknown predecessor agent directory ${directory} rejects without altering custom configuration`, async () => {
  const f = fixture();
  try {
    const unknown = path.join(f.agentDir, directory);
    fs.mkdirSync(unknown, { mode: 0o700 });
    fs.writeFileSync(path.join(unknown, "original.txt"), "leave untouched\n");
    const before = f.hashes(), names = fs.readdirSync(f.agentDir, { recursive: true }).sort();
    await assert.rejects(bootstrapProfile(f.selection), { code: "old_profile_unrecognized" });
    assert.equal(readProfile(f.selection), null);
    assert.equal(fs.existsSync(path.join(profileStorage(f.selection).rootDir, "data")), false);
    assert.deepEqual(f.hashes(), before);
    assert.deepEqual(fs.readdirSync(f.agentDir, { recursive: true }).sort(), names);
    assert.equal(fs.readFileSync(path.join(unknown, "original.txt"), "utf8"), "leave untouched\n");
  } finally { f.cleanup(); }
});
