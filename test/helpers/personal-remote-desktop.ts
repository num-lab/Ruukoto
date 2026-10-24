import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import type http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { personalTestKey, personalTestCertificate } from "./personal-https.ts";
import { PersonalController } from "../../apps/desktop/src/main/personal-controller.ts";
import { loadPersonalConfig, personalPendingFile, savePersonalConfig } from "../../apps/desktop/src/main/personal-config.ts";
import type { PersonalCredentialStorage } from "../../apps/desktop/src/main/personal-credentials.ts";
import type { DesktopUpdate } from "../../apps/desktop/src/shared/bridge.ts";

export async function desktopRemoteFixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/rk-dh-")); fs.chmodSync(directory, 0o700);
  const state = { raw: null as string | null, failWrite: false, failRead: false, mismatch: false, pairCalls: 0, pairCodes: [] as string[], rejectPair: false, dropPairBeforeAdmission: false, inputCalls: [] as { requestId: string; input: string }[], requestPaths: [] as string[], dropPair: false, dropInput: false, dropBeforeAdmission: false, backendOnline: true, revoked: false, handshakeProduct: "ruukoto", handshakeProfile: `sha256:${"a".repeat(64)}` };
  const storage: PersonalCredentialStorage = { read: async () => { if (state.failRead) throw new Error("fixture locked"); return state.mismatch && state.raw ? "bad readback" : state.raw; }, write: async raw => { if (state.failWrite) throw new Error("fixture denied"); state.raw = raw; }, remove: async () => { state.raw = null; } };
  const remoteId = randomUUID(), runId = randomUUID(), profile = { id: state.handshakeProfile, directory: "/var/lib/ruukoto/personal-durable" }, tokens = new Set<string>(), inputs = new Map<string, { status: string; input: string }>();
  let origin = "";
  const respond = (res: http.ServerResponse, result: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ v: 1, product: "ruukoto", ok: true, result }));
  const reject = (res: http.ServerResponse, code: string, status = 401) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ v: 1, product: "ruukoto", ok: false, code, message: "测试入口拒绝请求" }));
  const overrides = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse, value: unknown) => void | Promise<void>>();
  const server = https.createServer({ key: personalTestKey, cert: personalTestCertificate }, (req, res) => { void handle(req, res).catch(() => { if (!res.destroyed) reject(res, "fixture_internal", 500); }); });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString(), value = body ? JSON.parse(body) : undefined, route = new URL(req.url!, origin);
    state.requestPaths.push(req.url!);
    const token = req.headers.authorization ?? "";
    if (route.pathname === "/pair") {
      state.pairCalls++;
      const candidate = JSON.parse(state.raw!).candidate;
      assert.equal(token, `Bearer ${candidate.id}.${candidate.secret}`); assert.deepEqual(value, candidate.request);
      state.pairCodes.push(candidate.request.code);
      if (state.rejectPair) { reject(res, "remote_pairing_rejected", 409); return; }
      if (state.dropPairBeforeAdmission) { req.socket.destroy(); return; }
      tokens.add(token);
      if (state.dropPair) { req.socket.destroy(); return; }
      respond(res, { id: candidate.id, status: "active" }); return;
    }
    if (!tokens.has(token)) { reject(res, "remote_credential_invalid"); return; }
    if (state.revoked) { reject(res, "remote_credential_revoked"); return; }
    if (route.pathname === "/handshake") { respond(res, { v: 1, product: state.handshakeProduct, origin, remoteId, profile: { ...profile, id: state.handshakeProfile }, online: state.backendOnline, ...(state.backendOnline ? { runId } : {}) }); return; }
    assert.equal(req.headers["x-ruukoto-remote-id"], remoteId); assert.equal(req.headers["x-ruukoto-profile-id"], state.handshakeProfile);
    const custom = overrides.get(route.pathname); if (custom) { await custom(req, res, value); return; }
    if (route.pathname === "/inputs") {
      const input = value as { requestId: string; input: string }; state.inputCalls.push(input);
      const pending = JSON.parse(fs.readFileSync(personalPendingFile(directory, loadPersonalConfig(directory)!), "utf8"));
      assert.equal(pending.input.requestId, input.requestId); assert.equal(pending.input.input, input.input);
      if (state.dropBeforeAdmission) { state.dropBeforeAdmission = false; req.socket.destroy(); return; }
      const previous = inputs.get(input.requestId); if (previous) assert.equal(previous.input, input.input);
      inputs.set(input.requestId, { status: "queued", input: input.input });
      if (state.dropInput) { req.socket.destroy(); return; }
      respond(res, { status: "queued" }); return;
    }
    if (route.pathname === "/input") { const input = inputs.get(route.searchParams.get("requestId")!); respond(res, { status: input?.status ?? "missing" }); return; }
    if (route.pathname === "/permissions") { respond(res, { default: { mode: "confirm" }, qq: { mode: "auto-review" } }); return; }
    if (["/questions", "/works", "/tools/operations", "/mcp/operations", "/app-data/operations", "/services"].includes(route.pathname)) { respond(res, { items: [] }); return; }
    reject(res, "route_missing", 404);
  }
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!tokens.has(req.headers.authorization ?? "") || state.revoked) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    assert.equal(req.headers["x-ruukoto-remote-id"], remoteId); assert.equal(req.headers["x-ruukoto-profile-id"], state.handshakeProfile);
    wss.handleUpgrade(req, socket, head, ws => ws.send(JSON.stringify({ v: 1, type: "snapshot", runId, subscription: randomUUID(), seq: 0, timeline: { through: 0, items: [] }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0 } })));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  const agent = new https.Agent({ ca: personalTestCertificate, keepAlive: false }), updates: DesktopUpdate[] = [], controllers: PersonalController[] = [];
  const create = (useAgent = true) => { const controller = new PersonalController(loadPersonalConfig(directory) ?? { v: 1, origin }, directory, update => updates.push(update), storage, useAgent ? { agent } : {}); controllers.push(controller); return controller; };
  savePersonalConfig(directory, { origin });
  t.after(async () => { for (const controller of controllers) await controller.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); agent.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, state, storage, origin, remoteId, runId, profile, agent, updates, create, overrides, respond, reject, wss, inputs };
}
export async function waitFor(check: () => boolean) {
  const until = Date.now() + 5000;
  while (!check()) { if (Date.now() >= until) throw new Error("fixture wait timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
