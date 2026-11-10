import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { bootstrapProfile, ensureProfileEndpoint, readProfile, selectProfile, type ProfilePaths } from "@ruukoto/core/profile.ts";
import { savePrivateJson } from "@ruukoto/core/profile-files.ts";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-profile-socket-")));
  let endpoint: string | undefined;
  return { root, remember(profile: ProfilePaths) { endpoint = path.dirname(profile.socketPath); }, cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
    if (endpoint) fs.rmSync(endpoint, { recursive: true, force: true });
  } };
}

test("long independent persistent control uses the bounded authoritative socket", async () => {
  const f = fixture();
  const server = createServer(socket => { socket.end("current-profile\n"); });
  try {
    const profile = await bootstrapProfile(selectProfile({ dataDir: path.join(f.root, "data"), controlDir: path.join(f.root, "long-home-".repeat(15), "independent-control") }, {}));
    f.remember(profile);
    assert.ok(Buffer.byteLength(profile.controlDir) > 150);
    assert.ok(Buffer.byteLength(profile.socketPath) <= (process.platform === "darwin" ? 103 : 107));
    assert.equal(profile.socketPath.startsWith(fs.realpathSync("/tmp") + path.sep), true);
    server.listen(profile.socketPath);
    await once(server, "listening");
    const socket = createConnection(profile.socketPath);
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(chunk));
    await once(socket, "end");
    assert.equal(Buffer.concat(chunks).toString(), "current-profile\n");
    assert.equal(readProfile(profile.selection)!.socketPath, profile.socketPath);
  } finally {
    if (server.listening) { server.close(); await once(server, "close"); }
    f.cleanup();
  }
});

test("temporary endpoint loss recreates only its original binding", async () => {
  const f = fixture();
  try {
    const profile = await bootstrapProfile(selectProfile({ dataDir: path.join(f.root, "data") }, {}));
    f.remember(profile);
    const token = fs.readFileSync(path.join(profile.controlDir, "owner.token"));
    fs.rmSync(path.dirname(profile.socketPath), { recursive: true });
    ensureProfileEndpoint(profile);
    const reopened = readProfile(profile.selection)!;
    assert.equal(reopened.instanceId, profile.instanceId);
    assert.equal(reopened.socketPath, profile.socketPath);
    assert.deepEqual(fs.readFileSync(path.join(profile.controlDir, "owner.token")), token);
  } finally { f.cleanup(); }
});

test("short-address collision preserves the foreign binding and leaves preparation inactive", async () => {
  const f = fixture();
  let foreign = "";
  try {
    const selection = selectProfile({ dataDir: path.join(f.root, "data") }, {});
    await assert.rejects(bootstrapProfile(selection, { checkpoint(phase) {
      if (phase !== "preparation-published") return;
      const prep = JSON.parse(fs.readFileSync(path.join(f.root, "single-v1", "preparation.json"), "utf8")) as { socketPath: string };
      const directory = path.dirname(prep.socketPath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      foreign = path.join(directory, "binding.json");
      savePrivateJson(foreign, { digest: "foreign-full-digest", instanceId: "foreign" }, true);
    } }), { code: "profile_endpoint_collision" });
    assert.equal(readProfile(selection), null);
    assert.equal(fs.readFileSync(foreign, "utf8"), JSON.stringify({ digest: "foreign-full-digest", instanceId: "foreign" }) + "\n");
  } finally { if (foreign) fs.rmSync(path.dirname(foreign), { recursive: true, force: true }); f.cleanup(); }
});

for (const problem of ["symlink", "permissions", "occupied"] as const) test(`profile endpoint rejects ${problem} without repair`, async () => {
  const f = fixture();
  try {
    const profile = await bootstrapProfile(selectProfile({ dataDir: path.join(f.root, "data") }, {}));
    f.remember(profile);
    const endpoint = path.dirname(profile.socketPath);
    if (problem === "symlink") {
      const original = path.join(f.root, "endpoint");
      fs.renameSync(endpoint, original); fs.symlinkSync(original, endpoint);
    } else if (problem === "permissions") fs.chmodSync(endpoint, 0o755);
    else fs.writeFileSync(profile.socketPath, "keep");
    assert.throws(() => ensureProfileEndpoint(profile), { code: problem === "occupied" ? "profile_endpoint_occupied" : "profile_path_unsafe" });
    if (problem === "occupied") assert.equal(fs.readFileSync(profile.socketPath, "utf8"), "keep");
    if (problem === "permissions") assert.equal(fs.statSync(endpoint).mode & 0o777, 0o755);
  } finally { f.cleanup(); }
});

test("platform encoded socket limit rejects before activation", async () => {
  const f = fixture();
  try {
    const selection = selectProfile({ dataDir: path.join(f.root, "data") }, {});
    await assert.rejects(bootstrapProfile(selection, { socketByteLimit: 1 }), { code: "profile_socket_path_too_long" });
    assert.equal(readProfile(selection), null);
    assert.equal(fs.existsSync(path.join(f.root, "single-v1", "data")), false);
    const preparation = JSON.parse(fs.readFileSync(path.join(f.root, "single-v1", "preparation.json"), "utf8")) as { instanceId: string; socketPath: string };
    assert.equal(fs.existsSync(path.dirname(preparation.socketPath)), false);
    const recovered = await bootstrapProfile(selection);
    f.remember(recovered);
    assert.equal(recovered.instanceId, preparation.instanceId);
    assert.equal(recovered.socketPath, preparation.socketPath);
  } finally { f.cleanup(); }
});
