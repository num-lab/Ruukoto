import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { bootstrapProfile, readProfile, selectProfile, profileChildEnv, PROFILE_ROLES, type ProfilePaths, type ProfileDirectoryOptions } from "@ruukoto/core/profile.ts";
import { profileStorage } from "@ruukoto/core/profile.ts";
import { ProfileError } from "@ruukoto/core/profile-files.ts";
import { Db } from "@ruukoto/core/db.ts";
import { acquireConfigLock, acquireDirectoryLock, acquireInstanceLock } from "@ruukoto/core/instance-lock.ts";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-profile-")));
  const endpoints: string[] = [];
  return { root, endpoints, cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
    for (const endpoint of endpoints) fs.rmSync(endpoint, { recursive: true, force: true });
  } };
}

for (const customData of [false, true]) test(`profile selection maps every partial override (custom data ${customData})`, async () => {
  const f = fixture();
  try {
    for (let mask = 0; mask < 8; mask++) {
      const base = path.join(f.root, `case-${mask}`);
      fs.mkdirSync(base);
      const dataDir = path.join(base, customData ? "application-data" : "data");
      const options: ProfileDirectoryOptions = { dataDir };
      const roles = ["agent", "control", "pending"] as const;
      for (let bit = 0; bit < roles.length; bit++) if (mask & (1 << bit)) options[`${roles[bit]}Dir`] = path.join(base, `external-${roles[bit]}`);
      const selection = selectProfile(options, {});
      const implicit = profileStorage(selection);
      const explicit = selectProfile({ dataDir: selection.dataDir, agentDir: selection.agentDir, controlDir: selection.controlDir, pendingDir: selection.pendingDir }, {});
      assert.deepEqual(profileStorage(explicit), implicit);
      assert.deepEqual(profileStorage(selectProfile({}, profileChildEnv(selection, {}))), implicit);
      const profile = await bootstrapProfile(selection);
      f.endpoints.push(path.dirname(profile.socketPath));
      const restarted = await bootstrapProfile(selectProfile(options, {}));
      assert.equal(restarted.instanceId, profile.instanceId);
      assert.equal(restarted.dataDir, path.join(implicit.rootDir, "data"));
      assert.equal(restarted.socketPath, profile.socketPath);
      assert.equal(fs.existsSync(path.join(profile.agentDir, "models.json")), false, "activation needs no model credentials");
      for (const role of PROFILE_ROLES) assert.equal(fs.existsSync(path.join(profile[`${role}Dir`], ".ruukoto-role.json")), true);
      const db = new Db(profile.dataDir, "ruukoto.db", profile);
      try { assert.equal(db.getInstanceId(), profile.instanceId); assert.equal(db.prepare("SELECT count(*) AS count FROM tasks").get()!.count, 0); }
      finally { db.close(); }
      for (const role of PROFILE_ROLES) {
        assert.throws(() => selectProfile({ [`${role}Dir`]: profile[`${role}Dir`] }, {}), (error: unknown) => error instanceof ProfileError && error.code === "profile_resolved_path");
      }
    }
  } finally { f.cleanup(); }
});

test("profile omitted and explicit defaults and safe aliases bind one instance", async () => {
  const f = fixture();
  try {
    const implicit = selectProfile({}, {}, f.root);
    const explicit = selectProfile({ dataDir: path.join(f.root, ".ruukoto", "data"), agentDir: path.join(f.root, ".ruukoto", "agent"), controlDir: path.join(f.root, ".ruukoto", "control"), pendingDir: path.join(f.root, ".ruukoto", "pending") }, {}, f.root);
    assert.deepEqual(implicit, explicit);
    const profile = await bootstrapProfile(implicit);
    f.endpoints.push(path.dirname(profile.socketPath));
    fs.symlinkSync(f.root, path.join(f.root, "alias"));
    const viaAlias = await bootstrapProfile(selectProfile({ dataDir: path.join(f.root, "alias", ".ruukoto", "data") }, {}));
    assert.equal(viaAlias.instanceId, profile.instanceId);
    assert.equal(profile.rootDir, path.join(f.root, ".ruukoto", "single-v1"));
    assert.deepEqual(readProfile(explicit), profile);
  } finally { f.cleanup(); }
});

test("profile rejects a changed role tuple without another database", async () => {
  const f = fixture();
  try {
    const dataDir = path.join(f.root, "data"), profile = await bootstrapProfile(selectProfile({ dataDir }, {}));
    f.endpoints.push(path.dirname(profile.socketPath));
    const changed = selectProfile({ dataDir, agentDir: path.join(f.root, "elsewhere") }, {});
    await assert.rejects(bootstrapProfile(changed), { code: "profile_selection_conflict" });
    assert.equal(fs.existsSync(path.join(f.root, "elsewhere.ruukoto-single-v1")), false);
    assert.equal(readProfile(profile.selection)!.instanceId, profile.instanceId);
  } finally { f.cleanup(); }
});

test("discovery is read-only; foreign generation and replaced ancestor reject", async () => {
  const f = fixture();
  try {
    const selection = selectProfile({ dataDir: path.join(f.root, "missing", "data") }, {});
    assert.equal(readProfile(selection), null);
    assert.deepEqual(fs.readdirSync(f.root), []);
    const root = profileStorage(selection).rootDir;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, "unrecognized"), "keep");
    await assert.rejects(bootstrapProfile(selection), { code: "profile_generation_unrecognized" });
    assert.equal(fs.readFileSync(path.join(root, "unrecognized"), "utf8"), "keep");
    const selected = path.join(f.root, "selected");
    fs.mkdirSync(selected);
    const pinned = selectProfile({ dataDir: path.join(selected, "data") }, {});
    fs.renameSync(selected, selected + "-original");
    fs.mkdirSync(selected);
    await assert.rejects(bootstrapProfile(pinned), { code: "profile_path_changed" });
  } finally { f.cleanup(); }
});

test("replaced installed role rejects before activation and recovers only its recorded identity", async () => {
  const f = fixture();
  try {
    const selection = selectProfile({ dataDir: path.join(f.root, "data") }, {});
    const storage = profileStorage(selection), displaced = path.join(f.root, "original-pending");
    await assert.rejects(bootstrapProfile(selection, { checkpoint(phase) {
      if (phase !== "before-activation") return;
      fs.renameSync(storage.pendingDir, displaced);
      fs.mkdirSync(storage.pendingDir, { mode: 0o700 });
    } }), { code: "profile_path_changed" });
    const preparation = JSON.parse(fs.readFileSync(path.join(storage.rootDir, "preparation.json"), "utf8")) as { instanceId: string; socketPath: string };
    f.endpoints.push(path.dirname(preparation.socketPath));
    assert.equal(fs.existsSync(path.join(storage.rootDir, "profile.json")), false);
    assert.deepEqual(fs.readdirSync(storage.pendingDir), []);
    fs.rmdirSync(storage.pendingDir);
    fs.renameSync(displaced, storage.pendingDir);
    assert.equal((await bootstrapProfile(selection)).instanceId, preparation.instanceId);
  } finally { f.cleanup(); }
});

test("independent role ancestor symlink rejects without writing through it", async () => {
  const f = fixture();
  try {
    const foreign = path.join(f.root, "foreign"), controlDir = path.join(f.root, "external-control");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "keep"), "foreign bytes");
    fs.symlinkSync(foreign, controlDir + ".ruukoto-single-v1");
    const selection = selectProfile({ dataDir: path.join(f.root, "data"), controlDir }, {});
    await assert.rejects(bootstrapProfile(selection), { code: "profile_path_unsafe" });
    assert.deepEqual(fs.readdirSync(foreign), ["keep"]);
    assert.equal(fs.readFileSync(path.join(foreign, "keep"), "utf8"), "foreign bytes");
    const preparation = JSON.parse(fs.readFileSync(path.join(f.root, "single-v1", "preparation.json"), "utf8")) as { socketPath: string };
    f.endpoints.push(path.dirname(preparation.socketPath));
    assert.equal(fs.existsSync(path.join(f.root, "single-v1", "profile.json")), false);
  } finally { f.cleanup(); }
});

test("changed default equivalence cannot redirect a prepared role", async () => {
  const f = fixture();
  try {
    const agentDir = path.join(f.root, "external-agent"), defaultAgent = path.join(f.root, "agent");
    fs.mkdirSync(agentDir);
    const selection = selectProfile({ dataDir: path.join(f.root, "data"), agentDir }, {});
    const storage = profileStorage(selection);
    await assert.rejects(bootstrapProfile(selection, { checkpoint(phase) {
      if (phase === "preparation-published") fs.symlinkSync(agentDir, defaultAgent);
    } }), { code: "profile_path_changed" });
    const preparation = JSON.parse(fs.readFileSync(path.join(storage.rootDir, "preparation.json"), "utf8")) as { instanceId: string; socketPath: string };
    f.endpoints.push(path.dirname(preparation.socketPath));
    for (const role of PROFILE_ROLES) assert.equal(fs.existsSync(path.join(storage.rootDir, role)), false);
    assert.equal(fs.existsSync(storage.agentDir), false);
    assert.equal(fs.existsSync(path.join(storage.rootDir, "profile.json")), false);
    fs.unlinkSync(defaultAgent);
    const profile = await bootstrapProfile(selection);
    assert.equal(profile.instanceId, preparation.instanceId);
    assert.equal(profile.agentDir, storage.agentDir);
  } finally { f.cleanup(); }
});

test("filesystem root conflicts with every contained raw role", () => {
  const f = fixture();
  try {
    assert.throws(() => selectProfile({ dataDir: path.join(f.root, "data"), agentDir: path.parse(f.root).root }, {}), { code: "profile_role_conflict" });
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.cleanup(); }
});

for (const phase of ["preparation-published", ...PROFILE_ROLES.flatMap(role => ["stage-created", "stage-recorded", "before-install", "after-install", "installed-recorded"].map(event => `${role}:${event}`)), "before-activation", "after-activation"]) {
  test(`profile SIGKILL at ${phase} resumes the reserved instance`, { timeout: 30_000 }, async () => {
    const f = fixture();
    const selection = selectProfile({ dataDir: path.join(f.root, "data"), agentDir: path.join(f.root, "external-agent"), controlDir: path.join(f.root, "external-control"), pendingDir: path.join(f.root, "external-pending") }, {});
    const storage = profileStorage(selection);
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { bootstrapProfile, selectProfile } from ${JSON.stringify(new URL("../packages/core/src/profile.ts", import.meta.url).href)};
      await bootstrapProfile(selectProfile({}, process.env), { checkpoint(name) {
        if (name === ${JSON.stringify(phase)}) process.kill(process.pid, "SIGKILL");
      } });
    `], { cwd: new URL("../", import.meta.url), env: profileChildEnv(selection, process.env), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const exited = once(child, "exit");
    try {
      const [code, signal] = await exited;
      assert.equal(code, null, stderr);
      assert.equal(signal, "SIGKILL", stderr);
      const owner = JSON.parse(fs.readFileSync(path.join(storage.rootDir, "bootstrap.lock", "owner.json"), "utf8")) as { pid: number };
      assert.equal(owner.pid, child.pid, "abrupt exit must leave ownership for verified stale takeover");
      const preparation = JSON.parse(fs.readFileSync(path.join(storage.rootDir, "preparation.json"), "utf8")) as { instanceId: string; preparationId: string; socketPath: string };
      f.endpoints.push(path.dirname(preparation.socketPath));
      const interruptedRole = PROFILE_ROLES.find(role => phase === `${role}:stage-created`);
      const stageParent = interruptedRole ? path.dirname(storage[`${interruptedRole}Dir`]) : null;
      const unreferencedStages = stageParent
        ? fs.readdirSync(stageParent).filter(name => name.startsWith(".profile-stage-role-")).map(name => {
          const directory = path.join(stageParent, name);
          return { directory, ino: fs.lstatSync(directory).ino };
        }) : [];
      if (interruptedRole) assert.equal(unreferencedStages.length, 1);
      assert.equal(readProfile(selection)?.instanceId ?? null, phase === "after-activation" ? preparation.instanceId : null);
      const recovered = await bootstrapProfile(selection);
      assert.equal(recovered.instanceId, preparation.instanceId);
      assert.equal(recovered.preparationId, preparation.preparationId);
      assert.equal(fs.existsSync(path.join(storage.rootDir, "bootstrap.lock")), phase === "after-activation", "only an unactivated profile needs bootstrap takeover");
      for (const stage of unreferencedStages) {
        assert.equal(fs.lstatSync(stage.directory).ino, stage.ino);
        assert.deepEqual(fs.readdirSync(stage.directory), [], "unrecorded crash debris must not be adopted");
      }
      const db = new Db(recovered.dataDir, "ruukoto.db", recovered);
      try { assert.equal(db.getInstanceId(), preparation.instanceId); }
      finally { db.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      const lock = path.join(storage.rootDir, "bootstrap.lock");
      if (fs.existsSync(lock)) acquireDirectoryLock(lock).release();
      if (fs.existsSync(path.join(selection.dataDir, "runtime.lock"))) acquireInstanceLock(selection.dataDir).release();
      if (fs.existsSync(path.join(selection.agentDir, "config.lock"))) acquireConfigLock(selection.agentDir).release();
      f.cleanup();
    }
  });
}

test("concurrent processes publish exactly one profile identity", { timeout: 30_000 }, async () => {
  const f = fixture();
  const selection = selectProfile({ dataDir: path.join(f.root, "data") }, {});
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { bootstrapProfile,selectProfile } from ${JSON.stringify(new URL("../packages/core/src/profile.ts", import.meta.url).href)};
    const profile = await bootstrapProfile(selectProfile({},process.env)); process.stdout.write(JSON.stringify(profile));
  `], { cwd: new URL("../", import.meta.url), env: profileChildEnv(selection, process.env), stdio: ["ignore", "pipe", "pipe"] }));
  try {
    const results = await Promise.all(children.map(async child => {
      let out = "", err = "";
      child.stdout.on("data", chunk => { out += chunk.toString(); });
      child.stderr.on("data", chunk => { err += chunk.toString(); });
      const [code] = await once(child, "exit");
      assert.equal(code, 0, err);
      return JSON.parse(out) as ProfilePaths;
    }));
    f.endpoints.push(...results.map(profile => path.dirname(profile.socketPath)));
    assert.equal(new Set(results.map(profile => profile.instanceId)).size, 1);
    assert.equal(new Set(results.map(profile => profile.preparationId)).size, 1);
    assert.equal(readProfile(selection)!.instanceId, results[0].instanceId);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    f.cleanup();
  }
});
