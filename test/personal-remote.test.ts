import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { initializePersonalRemote, startPersonalRemote } from "../apps/ruukoto/src/personal-remote.ts";
import { personalSettingsDirectoryIdentity } from "../apps/ruukoto/src/personal-settings.ts";
import { PersonalRemoteAuth } from "../apps/ruukoto/src/personal-remote-auth.ts";
import { PERSONAL_FORMAT } from "../apps/ruukoto/src/personal-profile.ts";

type Envelope = { v: number; product: string; ok: boolean; code?: string; result: Record<string, unknown> };
function request(socketPath: string, route: string, headers: http.OutgoingHttpHeaders = {}, body?: unknown) {
  return new Promise<{ status: number; value: Envelope }>((resolve, reject) => {
    const input = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, path: route, method: input === undefined ? "GET" : "POST", headers: { ...headers, ...(input ? { "content-type": "application/json", "content-length": Buffer.byteLength(input) } : {}) } });
    req.on("response", response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Envelope }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("test_timeout")));
    req.end(input);
  });
}
async function fixture(t: test.TestContext, beforeReturn?: (route: string, body: unknown) => Promise<void>) {
  const home = fs.realpathSync(fs.mkdtempSync("/tmp/pr-")), directory = path.join(home, "profile");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "profile.json"), JSON.stringify(PERSONAL_FORMAT), { mode: 0o600 });
  const profile = personalSettingsDirectoryIdentity(directory), runId = randomUUID();
  const config = { v: 1 as const, origin: "https://probe.example", owner: "owner@example", profile };
  await initializePersonalRemote(config, () => home);
  const calls: string[] = [], nativeCalls: { body: unknown; credential?: string }[] = [];
  const remote = await startPersonalRemote({ home: () => home, backend: async <T>(method: string, route: string, body?: unknown, credential?: string) => {
    calls.push(`${method} ${route}`);
    if (route === "/desktop/action") nativeCalls.push({ body, credential });
    await beforeReturn?.(route, body);
    return (route === "/desktop/identity" ? { v: 1, product: "ruukoto", profile, runId } : { accepted: true }) as T;
  } });
  t.after(async () => { await remote.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const authorization = `Bearer ${randomUUID()}.${randomBytes(32).toString("base64url")}`;
  const headers = { authorization, "tailscale-user-login": config.owner };
  const pair = async () => {
    const opened = await request(remote.adminPath, "/pair/open", {}, {});
    const paired = await request(remote.socketPath, "/pair", headers, { v: 1, code: opened.value.result.code, label: "fixture desktop" });
    assert.equal(paired.value.ok, true);
    const handshake = await request(remote.socketPath, "/handshake", headers);
    assert.equal(handshake.value.ok, true);
    return { ...headers, "x-ruukoto-remote-id": String(handshake.value.result.remoteId), "x-ruukoto-profile-id": profile.id };
  };
  return { ...remote, home, directory, config, calls, nativeCalls, headers, authorization, pair };
}

test("Native action forwarding binds the authenticated paired credential and excludes arbitrary recovery routes", async t => {
  const f = await fixture(t), bound = await f.pair(), requestId = randomUUID();
  const action = { v: 1, requestId, family: "browser", operation: 8, admission: 12, occurrence: 12, action: "cleanup" };
  const result = await request(f.socketPath, "/desktop/action", { ...bound, "x-ruukoto-native-credential": randomUUID() }, action);
  assert.equal(result.value.ok, true);
  assert.deepEqual(f.nativeCalls, [{ body: action, credential: f.authorization.slice(7).split(".")[0] }]);
  assert.equal((await request(f.socketPath, `/desktop/action?requestId=${requestId}`, bound)).value.ok, true);
  for (const route of ["/browser/stop", "/command/stop", "/service/stop", "/mcp/cua-recover", "/background/stop", "/tools/resolve"]) assert.equal((await request(f.socketPath, route, bound, {})).status, 404);
  const id = f.authorization.slice(7).split(".")[0];
  await request(f.adminPath, "/credentials/revoke", {}, { id });
  assert.equal((await request(f.socketPath, "/desktop/action", bound, action)).value.code, "remote_credential_revoked");
  assert.equal(f.nativeCalls.length, 1);
});

test("remote HTTP：双重身份、Origin拒绝、私有admin与显式路由名单", async t => {
  const f = await fixture(t);
  assert.equal((await request(f.socketPath, "/handshake", { "tailscale-user-login": f.config.owner })).status, 401);
  const bound = await f.pair();
  for (const login of ["other@example", ""]) assert.equal((await request(f.socketPath, "/status", { ...bound, "tailscale-user-login": login })).status, 403);
  assert.equal((await request(f.socketPath, "/status", { ...bound, origin: "https://hostile.example" })).status, 403);
  assert.equal((await request(f.socketPath, "/credentials", bound)).status, 404);
  assert.equal((await request(f.socketPath, "/stop", bound, {})).status, 404);
  assert.equal((await request(f.socketPath, "/tools/export", bound, {})).status, 404);
  assert.equal((await request(f.socketPath, "/commands", bound)).status, 404);
  assert.equal((await request(f.socketPath, "/tools/grant", bound, { path: "/tmp" })).status, 404);
  assert.equal((await request(f.socketPath, "/settings", bound, { v: 1, op: "config.save", profile: f.config.profile, target: "model", expectedRevision: "missing", value: {} })).status, 409);
  assert.equal((await request(f.socketPath, "/status", { ...bound, "x-ruukoto-profile-id": "other" })).status, 409);
  assert.equal(f.calls.filter(call => call !== "GET /desktop/identity").length, 0);
  const accepted = await request(f.socketPath, "/inputs", bound, { requestId: randomUUID(), input: "hello" });
  assert.equal(accepted.value.ok, true);
  assert.equal(f.calls.includes("POST /inputs"), true);
  assert.equal(JSON.stringify(accepted).includes(f.authorization), false);
});

test("Personal attachment routes retain paired authentication and reject a response revoked during upload", async t => {
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { received = resolve; });
  t.after(() => release());
  const upload = { v: 1, attachmentId: randomUUID(), name: "input.csv", mime: "text/csv", totalBytes: 3, sha256: "a".repeat(64), offset: 0, base64: "YWJj" };
  const f = await fixture(t, async (route, body) => { if (route === "/desktop/attachment") { assert.deepEqual(body, upload); received(); await held; } });
  const bound = await f.pair();
  assert.equal((await request(f.socketPath, "/desktop/attachment", { ...bound, "x-ruukoto-profile-id": "other" }, upload)).value.code, "remote_profile_changed");
  assert.equal((await request(f.socketPath, "/desktop/inputs", { ...bound, origin: "https://other.example" }, { requestId: randomUUID(), input: "", attachments: [] })).status, 403);
  assert.equal(f.calls.filter(call => call.startsWith("POST")).length, 0);
  assert.equal((await request(f.socketPath, "/desktop/inputs", bound, { requestId: randomUUID(), input: "", attachments: [{ id: upload.attachmentId, name: upload.name, mime: upload.mime, size: upload.totalBytes, sha256: upload.sha256 }] })).value.ok, true);
  const response = request(f.socketPath, "/desktop/attachment", bound, upload);
  const lost = assert.rejects(response);
  await started;
  await request(f.adminPath, "/credentials/revoke", {}, { id: f.authorization.slice(7).split(".")[0] });
  release();
  await lost;
  assert.equal(f.calls.filter(call => call === "POST /desktop/attachment").length, 1);
  assert.equal((await request(f.socketPath, "/desktop/attachment", bound, upload)).value.code, "remote_credential_revoked");
});

test("remote撤销：旧WSS关闭、未来HTTP拒绝，已接纳业务不变", async t => {
  const f = await fixture(t), bound = await f.pair();
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(path.join(f.directory, "control.token"), token, { mode: 0o600 });
  const server = http.createServer(), backend = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    backend.handleUpgrade(req, socket, head, ws => ws.send(JSON.stringify({ v: 1, type: "snapshot" })));
  });
  const socket = path.join(f.directory, "control.sock");
  server.listen(socket); await once(server, "listening");
  t.after(async () => { for (const client of backend.clients) client.terminate(); backend.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const ws = new WebSocket(`ws+unix:${f.socketPath}:/events`, { headers: bound });
  const first = once(ws, "message", { signal: AbortSignal.timeout(5000) });
  await once(ws, "open", { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(JSON.parse((await first)[0].toString()), { v: 1, type: "snapshot" });
  const closed = once(ws, "close", { signal: AbortSignal.timeout(5000) });
  const id = f.authorization.slice(7).split(".")[0];
  const revoked = await request(f.adminPath, "/credentials/revoke", {}, { id });
  assert.equal(revoked.value.result.status, "revoked");
  await closed;
  assert.equal((await request(f.socketPath, "/status", bound)).value.code, "remote_credential_revoked");
  assert.equal(f.calls.includes("POST /stop"), false);
});

test("remote关闭：观察端与Unix socket先回收，再释放独占锁", async t => {
  const f = await fixture(t);
  await f.pair();
  const binding = { origin: f.config.origin, owner: f.config.owner, profile: f.config.profile };
  assert.throws(() => new PersonalRemoteAuth(binding, { home: () => f.home }), { code: "remote_busy" });
  await f.stop();
  assert.equal(fs.existsSync(f.socketPath), false);
  assert.equal(fs.existsSync(f.adminPath), false);
  const reopened = new PersonalRemoteAuth(binding, { home: () => f.home });
  reopened.close();
});
