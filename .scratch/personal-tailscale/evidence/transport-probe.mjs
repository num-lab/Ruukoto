import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

// 仅验证阶段0传输前提，临时凭据与业务认证状态无关。
const [mode, directory, owner] = process.argv.slice(2);

function authorizationStatus(headers, login, secret) {
  if (headers.origin || headers["access-control-request-method"]) return 403;
  if (headers["tailscale-user-login"] !== login) return 403;
  return headers.authorization === `Bearer ${secret}` ? 200 : 401;
}

async function serve() {
  assert(directory && owner);
  assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700);
  const secret = crypto.randomBytes(32).toString("base64url");
  const socketPath = path.join(directory, "http.sock");
  assert(Buffer.byteLength(socketPath) <= 100);
  assert(!fs.existsSync(socketPath));
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify({ secret, owner }), { mode: 0o600, flag: "wx" });
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const status = authorizationStatus(req.headers, owner, secret);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(status === 200 ? { login: req.headers["tailscale-user-login"], protocol: req.httpVersion } : { code: status === 401 ? "credential_required" : "source_rejected" }));
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on("upgrade", (req, socket, head) => {
    const status = authorizationStatus(req.headers, owner, secret);
    if (status !== 200) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const expiry = setTimeout(() => ws.close(1000, "probe_expired"), 15_000);
      ws.once("close", () => clearTimeout(expiry));
      ws.send(JSON.stringify({ login: req.headers["tailscale-user-login"], protocol: req.httpVersion }));
      ws.on("message", data => ws.send(data));
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  fs.chmodSync(socketPath, 0o600);
  fs.writeFileSync(path.join(directory, "ready"), "ready\n", { mode: 0o600, flag: "wx" });
  process.stdout.write("probe_ready\n");
  const stop = () => {
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    wss.close();
    server.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function request(target, headers, socketPath, lookup) {
  return new Promise((resolve, reject) => {
    const transport = socketPath ? http : https;
    const options = socketPath ? { socketPath, path: "/", headers } : { headers, lookup };
    const req = socketPath ? transport.get(options) : transport.get(target, options);
    req.on("response", res => {
      const chunks = [];
      const certificateAuthorized = !socketPath && res.socket.authorized;
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), certificateAuthorized }));
      res.on("error", reject);
    });
    req.once("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("probe_timeout")));
  });
}

async function client(local) {
  const deadline = setTimeout(() => { throw new Error("probe_timeout"); }, 65_000);
  deadline.unref();
  const input = local ? JSON.parse(fs.readFileSync(path.join(directory, "fixture.json"), "utf8")) : JSON.parse(fs.readFileSync(0, "utf8"));
  const { secret, owner: login } = input;
  const origin = local ? undefined : directory;
  if (!local) assert.equal(new URL(origin).protocol, "https:");
  // 仅供对照系统DNS与已核实tailnet路由，仍按原域名校验证书与SNI。
  const lookup = input.address ? (_hostname, options, callback) => callback(null, options.all ? [{ address: input.address, family: 4 }] : input.address, 4) : undefined;
  const socketPath = local ? path.join(directory, "http.sock") : undefined;
  const auth = { authorization: `Bearer ${secret}` };
  const headers = local ? { ...auth, "tailscale-user-login": login } : auth;
  const checks = [];
  for (const [name, extra, expected] of [
    ["authenticated_http", {}, 200],
    ["missing_credential", { authorization: "" }, 401],
    ["wrong_credential", { authorization: "Bearer invalid" }, 401],
    ["browser_origin", { origin: "https://untrusted.example" }, 403],
    ["browser_preflight", { "access-control-request-method": "POST" }, 403],
  ]) {
    const response = await request(origin, { ...headers, ...extra }, socketPath, lookup);
    assert.equal(response.status, expected, name);
    if (expected === 200) {
      assert.equal(response.body.login, login);
      assert.equal(response.body.protocol, "1.1");
      if (!local) assert.equal(response.certificateAuthorized, true);
    }
    checks.push(name);
  }
  const forged = await request(origin, { ...headers, "tailscale-user-login": "forged@example.invalid" }, socketPath, lookup);
  assert.equal(forged.status, local ? 403 : 200);
  if (!local) assert.equal(forged.body.login, login);
  checks.push(local ? "nonowner_rejected" : "serve_overwrites_forged_identity");
  if (local) {
    assert.equal((await request(origin, auth, socketPath)).status, 403);
    checks.push("missing_identity_rejected");
  } else {
    const ws = new WebSocket(origin.replace(/^https:/, "wss:"), { headers: { ...auth, "tailscale-user-login": "forged@example.invalid" }, handshakeTimeout: 10_000, lookup });
    const first = once(ws, "message");
    await once(ws, "open");
    const [data] = await first;
    assert.deepEqual(JSON.parse(data.toString()), { login, protocol: "1.1" });
    let pongTimeout;
    const heartbeat = setInterval(() => {
      pongTimeout = setTimeout(() => ws.terminate(), 10_000);
      ws.ping("heartbeat");
    }, 30_000);
    ws.on("pong", () => clearTimeout(pongTimeout));
    ws.once("close", () => { clearInterval(heartbeat); clearTimeout(pongTimeout); });
    const pong = once(ws, "pong");
    ws.ping("probe");
    await pong;
    const echo = once(ws, "message");
    ws.send("probe_echo");
    assert.equal((await echo)[0].toString(), "probe_echo");
    const closed = once(ws, "close");
    if (input.hold) {
      const started = Date.now();
      process.stdout.write(`${JSON.stringify({ event: "wss_observing" })}\n`);
      const [code] = await closed;
      process.stdout.write(`${JSON.stringify({ event: "wss_closed", code, elapsedMs: Date.now() - started })}\n`);
    } else {
      ws.close(1000, "probe_complete");
      assert.equal((await closed)[0], 1000);
    }
    checks.push("wss_upgrade_identity", "wss_ping_pong", "wss_echo", "wss_close");
  }
  process.stdout.write(`${JSON.stringify({ mode: local ? "local_socket" : "real_serve", pinnedAddress: Boolean(input.address), checks })}\n`);
  clearTimeout(deadline);
}

if (mode === "server") await serve();
else if (mode === "local") await client(true);
else if (mode === "client") await client(false);
else throw new Error("Usage: transport-probe.mjs server|local <private-directory> [owner], or client <https-origin> < fixture.json");
