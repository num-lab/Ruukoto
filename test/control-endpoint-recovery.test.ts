import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { bootstrapProfile, ensureProfileEndpoint, readProfile, selectProfile } from "@ruukoto/core/profile.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { ensureBackend } from "@ruukoto/control/ensure-backend.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, routeResponder, writeModelsJson } from "./helpers/testkit.ts";

async function startEndpointRuntime(longControl = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-control-repair-")));
  const profile = await bootstrapProfile(selectProfile({
    dataDir: path.join(root, "data"),
    ...(longControl ? { controlDir: path.join(root, "ordinary-long-home-".repeat(10), "independent-control") } : {}),
  }, {}));
  const model = new MockModelServer(routeResponder([]));
  let runtime: Runtime | undefined;
  try {
    await writeModelsJson(profile, await model.start());
    runtime = await Runtime.start({ profile, thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model" });
    await ControlServer.start(runtime);
    const token = readOwnerToken(profile.controlDir)!;
    async function connect() {
      const client = await ControlClient.connect(profile.socketPath, 1000);
      try { await client.authenticate(token, profile); return client; }
      catch (error) { client.close(); throw error; }
    }
    return { root, profile, runtime, token, connect, async shutdown() {
      await runtime!.stop("test_end");
      await model.close();
      await cleanupDirs({ root, profile });
    } };
  } catch (error) {
    await runtime?.stop("test_start_failed");
    await model.close();
    await cleanupDirs({ root, profile });
    throw error;
  }
}

function identity(file: string) {
  const { dev, ino } = fs.lstatSync(file);
  return { dev, ino };
}

for (const loss of ["socket", "address"] as const) test(`live endpoint ${loss} loss repairs authenticated access without restarting the owner`, async () => {
  const fixture = await startEndpointRuntime(true);
  const { profile } = fixture;
  const original = await fixture.connect();
  let recovered: ControlClient | undefined;
  try {
    assert.ok(Buffer.byteLength(profile.controlDir) > 200);
    assert.ok(Buffer.byteLength(profile.socketPath) <= (process.platform === "darwin" ? 103 : 107));
    const created = await original.request<{ id: string }>("create_project", { name: "survives-endpoint-loss" });
    const activation = fs.readFileSync(path.join(profile.rootDir, "profile.json"));
    const lockPath = path.join(profile.dataDir, "runtime.lock");
    const lock = identity(lockPath);
    const owner = fs.readFileSync(path.join(lockPath, "owner.json"));
    const database = identity(path.join(profile.dataDir, "ruukoto.db"));
    const token = fs.readFileSync(path.join(profile.controlDir, "owner.token"));
    if (loss === "address") fs.rmSync(path.dirname(profile.socketPath), { recursive: true });
    else fs.unlinkSync(profile.socketPath);
    // Recreating the binding alone must not leave the live backend unreachable.
    ensureProfileEndpoint(profile);
    assert.deepEqual(await ensureBackend({ profile, spawnExecPath: path.join(fixture.root, "must-not-spawn"), deadlineMs: 5000, pollMs: 40 }), { ok: true, spawned: false });
    recovered = await fixture.connect();
    const { snapshot } = await recovered.handshake();
    assert.equal(snapshot.instanceId, profile.instanceId);
    assert.ok(snapshot.projects.some(project => project.id === created.id));
    assert.deepEqual(await original.request("ping", {}), { pong: true, stopping: false });
    assert.deepEqual(fs.readFileSync(path.join(profile.rootDir, "profile.json")), activation);
    assert.deepEqual(identity(lockPath), lock);
    assert.deepEqual(fs.readFileSync(path.join(lockPath, "owner.json")), owner);
    assert.deepEqual(identity(path.join(profile.dataDir, "ruukoto.db")), database);
    assert.deepEqual(fs.readFileSync(path.join(profile.controlDir, "owner.token")), token);
    assert.equal(readProfile(profile.selection)!.instanceId, profile.instanceId);
    assert.equal(fixture.runtime.stopping, false);
  } finally {
    original.close();
    recovered?.close();
    await fixture.shutdown();
  }
});

for (const replacement of ["foreign-binding", "file", "socket"] as const) test(`live endpoint repair and shutdown preserve a ${replacement} replacement`, async () => {
  const fixture = await startEndpointRuntime();
  const { profile } = fixture;
  const endpoint = path.dirname(profile.socketPath);
  const bindingPath = path.join(endpoint, "binding.json");
  const binding = fs.readFileSync(bindingPath);
  const foreign = net.createServer(socket => socket.end("foreign-owner\n"));
  try {
    fs.rmSync(endpoint, { recursive: true });
    fs.mkdirSync(endpoint, { mode: 0o700 });
    fs.writeFileSync(bindingPath, replacement === "foreign-binding" ? "{\"instanceId\":\"foreign\"}\n" : binding, { mode: 0o600 });
    if (replacement === "socket") {
      foreign.listen(profile.socketPath);
      await once(foreign, "listening");
    } else {
      fs.writeFileSync(profile.socketPath, "foreign-object\n", { mode: 0o600 });
    }
    const expectedBinding = fs.readFileSync(bindingPath);
    const expectedEndpoint = identity(endpoint);
    const expectedObject = identity(profile.socketPath);
    await delay(1200);
    assert.equal(fixture.runtime.stopping, false);
    assert.deepEqual(identity(endpoint), expectedEndpoint);
    assert.deepEqual(identity(profile.socketPath), expectedObject);
    assert.deepEqual(fs.readFileSync(bindingPath), expectedBinding);
    await fixture.runtime.stop("test_collision_preservation");
    assert.deepEqual(identity(profile.socketPath), expectedObject);
    assert.deepEqual(fs.readFileSync(bindingPath), expectedBinding);
    if (replacement === "socket") {
      const socket = net.createConnection(profile.socketPath);
      const bytes: Buffer[] = [];
      socket.on("data", chunk => bytes.push(chunk));
      await once(socket, "end");
      assert.equal(Buffer.concat(bytes).toString(), "foreign-owner\n");
    } else {
      assert.equal(fs.readFileSync(profile.socketPath, "utf8"), "foreign-object\n");
    }
  } finally {
    if (foreign.listening) {
      const closed = once(foreign, "close");
      foreign.close();
      await closed;
    }
    await fixture.shutdown();
  }
});

test("a stopped owner does not recreate a deleted endpoint", async () => {
  const fixture = await startEndpointRuntime();
  try {
    await fixture.runtime.stop("test_stop_repair");
    fs.rmSync(path.dirname(fixture.profile.socketPath), { recursive: true });
    await delay(1200);
    assert.equal(fs.existsSync(path.dirname(fixture.profile.socketPath)), false);
  } finally { await fixture.shutdown(); }
});

test("endpoint repair rejects changed runtime lock ownership", async () => {
  const fixture = await startEndpointRuntime();
  const ownerPath = path.join(fixture.profile.dataDir, "runtime.lock", "owner.json");
  const owner = fs.readFileSync(ownerPath);
  try {
    fs.chmodSync(ownerPath, 0o600);
    fs.writeFileSync(ownerPath, "{}\n");
    fs.chmodSync(ownerPath, 0o400);
    fs.rmSync(path.dirname(fixture.profile.socketPath), { recursive: true });
    await delay(1200);
    assert.equal(fs.existsSync(path.dirname(fixture.profile.socketPath)), false);
    assert.equal(fixture.runtime.stopping, false);
    assert.equal(fixture.runtime.instanceId(), fixture.profile.instanceId);
  } finally {
    fs.chmodSync(ownerPath, 0o600);
    fs.writeFileSync(ownerPath, owner);
    fs.chmodSync(ownerPath, 0o400);
    await fixture.shutdown();
  }
});

test("on-demand startup times out without spawning while the current owner has no listener", async () => {
  const fixture = await startEndpointRuntime();
  try {
    await fixture.runtime.onCloseServer!();
    const result = await ensureBackend({ profile: fixture.profile, spawnExecPath: path.join(fixture.root, "must-not-spawn"), deadlineMs: 300, pollMs: 40 });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("An unreachable owner cannot be reported ready");
    assert.equal(result.code, "control_endpoint_unavailable");
    assert.equal(fs.existsSync(fixture.profile.spawnLogPath), false);
    assert.equal(fixture.runtime.stopping, false);
    assert.equal(fixture.runtime.instanceId(), fixture.profile.instanceId);
  } finally { await fixture.shutdown(); }
});
