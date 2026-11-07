import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { DesktopError } from "../apps/desktop/src/main/environment.ts";
import { PersonalController } from "../apps/desktop/src/main/personal-controller.ts";
import { loadPersonalConfig, savePersonalConfig, personalPendingFile, legacyPersonalMaintenance, acknowledgeLegacyPersonalMaintenance } from "../apps/desktop/src/main/personal-config.ts";
import { DesktopHost } from "../apps/desktop/src/main/host.ts";
import { DesktopNotifications, type DesktopNotice } from "../apps/desktop/src/main/notifications.ts";
import { desktopRemoteFixture, waitFor } from "./helpers/personal-remote-desktop.ts";

const code = (expected: string) => (error: unknown) => (error instanceof ControlClientError || error instanceof DesktopError) && error.code === expected;
const pairCode = "ABCDEFGHIJKL";

test("个人连接：HTTPS配对先安全保存并读回，单地址握手与真实WSS均带原归属", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create();
  await controller.reconnect(); assert.equal(controller.status.state, "failed");
  assert.equal(controller.status.error?.code, "personal_pairing_required");
  const identity = await controller.pair(pairCode, "Electron");
  assert.equal(identity.remoteId, f.remoteId); assert.equal(controller.status.state, "online");
  await waitFor(() => f.updates.some(update => update.type === "personal_frame"));
  const result = await controller.business("GET", "/permissions");
  assert.deepEqual(result, { default: { mode: "confirm" }, qq: { mode: "auto-review" } });
  const active = JSON.parse(f.state.raw!).active;
  assert.equal(active.origin, f.origin); assert.equal(active.remoteId, f.remoteId); assert.deepEqual(active.profile, f.profile);
  assert.ok(!JSON.stringify(f.updates).includes(active.secret));
  assert.ok(!fs.readFileSync(path.join(f.directory, "personal-remote.json"), "utf8").includes(active.secret));
  await assert.rejects(controller.business("POST", "/stop"), code("op_not_allowed"));
  await assert.rejects(controller.business("GET", "https://another.invalid/permissions"), code("op_not_allowed"));
});

test("WSS原生接纳事件：submission合法帧不能终止观察或丢掉后续消息", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create();
  await controller.pair(pairCode, "fixture");
  await waitFor(() => f.updates.some(update => update.type === "personal_frame"));
  const snapshot = f.updates.find(update => update.type === "personal_frame");
  assert(snapshot?.type === "personal_frame");
  const frame = { v: 1, runId: f.runId, subscription: snapshot.frame.subscription, seq: snapshot.frame.seq + 1, type: "events", events: [
    { type: "submission", record: { id: 2, status: "done", entry: 1, answer: 3 } },
    { type: "entry_appended", entry: { entry: 3, conversation: 1, kind: "pi.assistant", role: "assistant", text: "原输入完成", partial: false, truncated: false, timestamp: Date.now() } },
  ] };
  for (const ws of f.wss.clients) ws.send(JSON.stringify(frame));
  await waitFor(() => controller.status.state === "failed" || f.updates.some(update => update.type === "personal_frame" && update.frame.seq === frame.seq));
  assert.equal(controller.status.state, "online");
  assert(f.updates.some(update => update.type === "personal_frame" && update.frame.seq === frame.seq));
});

test("配对：安全保存失败或读回不一致时不兑换，锁定不当成缺失", async t => {
  for (const mode of ["failWrite", "failRead", "mismatch"] as const) {
    const f = await desktopRemoteFixture(t), controller = f.create(); f.state[mode] = true;
    await assert.rejects(controller.pair(pairCode, "MyGo"), code(mode === "mismatch" ? "personal_credentials_invalid" : "personal_credentials_unavailable"));
    assert.equal(f.state.pairCalls, 0);
  }
});

test("配对丢答：保留原候选，重开先查原凭据，不登记第二份", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); f.state.dropPair = true;
  await assert.rejects(controller.pair(pairCode, "MyGo"), code("personal_connection_lost"));
  const candidate = JSON.parse(f.state.raw!).candidate;
  assert.ok(candidate); assert.equal(f.state.pairCalls, 1); await controller.close();
  const reopened = f.create(); await reopened.reconnect();
  assert.equal(reopened.status.state, "online");
  assert.equal(reopened.instanceId(), f.remoteId); assert.equal(f.state.pairCalls, 1);
  const saved = JSON.parse(f.state.raw!); assert.equal(saved.candidate, undefined); assert.equal(saved.active.id, candidate.id);
});

test("安全载荷绑定：外层地址或档案被改时不会把旧凭据发给新目标", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "Electron"); await controller.close();
  const before = f.state.requestPaths.length;
  savePersonalConfig(f.directory, { origin: "https://another.invalid" });
  const changed = f.create(); await changed.reconnect();
  assert.equal(changed.status.error?.code, "personal_pairing_required"); assert.equal(f.state.requestPaths.length, before);
  savePersonalConfig(f.directory, { origin: f.origin, binding: { remoteId: f.remoteId, profile: { ...f.profile, id: `sha256:${"b".repeat(64)}` } } });
  const differentProfile = f.create(); await differentProfile.reconnect();
  assert.equal(differentProfile.status.error?.code, "personal_identity_changed");
  assert.ok(!f.state.requestPaths.slice(before).includes("/permissions"));
});

test("输入丢答：发送前保存原键与正文，断开重开只查询原键", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "Electron"); f.state.dropInput = true;
  const result = await controller.submitInput("原消息"); assert.equal(result.kind, "pending"); assert.equal(f.state.inputCalls.length, 1);
  const pending = JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")).input;
  assert.equal(pending.requestId, result.requestId); assert.equal(pending.input, "原消息");
  await controller.close(); const reopened = f.create(); await reopened.reconnect();
  assert.equal(f.state.inputCalls.length, 1); assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, reopened.config), "utf8")).input, null);
  assert.ok(f.state.requestPaths.includes(`/input?requestId=${result.requestId}`));
});

test("输入接纳前断流：自动恢复不重发，显式恢复沿原键原正文且只接纳一次", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "Electron"); f.state.dropBeforeAdmission = true;
  const result = await controller.submitInput("同一正文"); assert.equal(result.kind, "pending");
  const missing = await controller.reconcileInput(); assert.equal(missing?.kind, "missing"); assert.equal(f.state.inputCalls.length, 1);
  const second = await controller.restoreInput(); assert.equal(second.kind, "accepted"); assert.equal(second.requestId, result.requestId);
  assert.deepEqual(f.state.inputCalls.map(input => input.requestId), [result.requestId, result.requestId]); assert.equal(f.inputs.size, 1);
  await assert.rejects(controller.restoreInput(), code("personal_input_not_restorable"));
});

test("Lost native decisions persist before dispatch, survive application restart and never post twice", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "fixture");
  const operation = 12, admission = 112; let posts = 0, approved = false;
  const summary = () => ({ operation, admission, occurrence: admission, kind: "write_file", target: "/outside/result.txt", targetTruncated: false, observed: false, approval: approved ? "approved" : "pending", started: false, stopped: true, effect: "not_executed", code: approved ? "ready" : "awaiting_approval", canDecide: !approved });
  f.overrides.set("/tools/decide", (request, _response, value) => {
    posts++;
    assert.deepEqual(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")).decisions, [{ kind: "tools", operation, decision: "approved" }]);
    assert.deepEqual(value, { operation, decision: "approved" }); request.socket.destroy();
  });
  f.overrides.set("/desktop/operation", (_request, response) => { f.respond(response, { v: 1, operation, admission, revision: approved ? 2 : 1, summary: summary(), offset: 0, text: JSON.stringify({ target: "/outside/result.txt", params: { path: "/outside/result.txt", content: "Once" } }) }); });
  await assert.rejects(controller.business("POST", "/tools/decide", { operation, decision: "approved" }), error => code("personal_connection_lost")(error) && error instanceof ControlClientError && error.outcome === "unknown");
  await controller.close(); const reopened = f.create(); await reopened.reconnect();
  assert.ok(f.updates.some(update => update.type === "personal_decisions" && update.items.some(item => item.operation === operation)));
  await reopened.business("GET", `/desktop/operation?operation=${operation}&offset=0`);
  await assert.rejects(reopened.business("POST", "/tools/decide", { operation, decision: "approved" }), code("personal_decision_pending"));
  f.overrides.set("/tools/operation", (_request, response) => { f.respond(response, { summary: { operation, canDecide: false }, text: "Invalid incomplete state" }); });
  await assert.rejects(reopened.business("GET", `/tools/operation?operation=${operation}`), code("personal_protocol"));
  assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, reopened.config), "utf8")).decisions.length, 1);
  await assert.rejects(reopened.assertSwitchable(), code("personal_pending")); assert.equal(posts, 1);
  approved = true; await reopened.business("GET", `/desktop/operation?operation=${operation}&offset=0`);
  assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, reopened.config), "utf8")).decisions, undefined);
  assert.equal(posts, 1);
  const releaseSwitch = await reopened.assertSwitchable();
  await assert.rejects(reopened.business("POST", "/tools/decide", { operation: 13, decision: "approved" }), code("personal_pending"));
  assert.equal(posts, 1); releaseSwitch();
});

test("Desktop projection HTTP rejects wrong request bindings and malformed operation/state records", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "fixture");
  f.overrides.set("/desktop/input", (_request, response) => { f.respond(response, { v: 1, revision: 1, entry: { entry: 10, conversation: 0, kind: "ruukoto.owner-input-display", role: "user", text: "Other input", partial: false, truncated: false, timestamp: 1, input: { requestId: "another", submission: 11, status: "queued" } } }); });
  await assert.rejects(controller.business("GET", "/desktop/input?requestId=original"), code("personal_protocol"));
  f.overrides.set("/desktop/state", (_request, response) => { f.respond(response, { v: 1, revision: 1, approvals: { items: [], total: 0 }, works: { items: [{}], total: 1 }, delegations: { items: [], total: 0 } }); });
  await assert.rejects(controller.business("GET", "/desktop/state"), code("personal_protocol"));
  f.overrides.set("/desktop/operation", (_request, response) => { f.respond(response, { v: 1, revision: 1, operation: 12, admission: 112, summary: { operation: 13 }, offset: 0, text: "{}" }); });
  await assert.rejects(controller.business("GET", "/desktop/operation?operation=12&offset=0"), code("personal_protocol"));
});

test("A late rejected decision cannot clear another profile's same-number decision or stop its connection", async t => {
  for (const staleCode of ["remote_request_invalid", "remote_credential_revoked"]) {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "original");
  const responses: ServerResponse[] = [];
  f.overrides.set("/tools/decide", (_request, response) => { responses.push(response); });
  f.overrides.set("/tools/operation", (_request, response) => { f.respond(response, { summary: { operation: 12, kind: "write_file", target: "/outside/old.txt", approval: "approved", effect: "not_executed", code: "ready", stopped: true, canDecide: false }, text: "Original" }); });
  const original = controller.business("POST", "/tools/decide", { operation: 12, decision: "approved" });
  const originalRejected = assert.rejects(original, error => error instanceof ControlClientError && error.code === "personal_identity_changed" && error.outcome === "unknown");
  await waitFor(() => responses.length === 1); await controller.business("GET", "/tools/operation?operation=12");
  f.state.handshakeProfile = `sha256:${"b".repeat(64)}`; await controller.pair(pairCode, "new-profile");
  const current = controller.business("POST", "/tools/decide", { operation: 12, decision: "rejected" });
  const currentRejected = assert.rejects(current, error => error instanceof ControlClientError && error.code === "remote_request_invalid" && error.outcome === "rejected");
  await waitFor(() => responses.length === 2); f.reject(responses[0], staleCode, staleCode === "remote_request_invalid" ? 400 : 401); await originalRejected;
  assert.equal(controller.status.state, "online");
  assert.deepEqual(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")).decisions, [{ kind: "tools", operation: 12, decision: "rejected" }]);
  f.reject(responses[1], "remote_request_invalid", 400); await currentRejected;
  assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")).decisions, undefined);
  }
});

test("A TLS failure before dispatch does not strand an unsent decision marker", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "fixture");
  const before = f.state.requestPaths.length; f.agent.options.ca = [];
  await assert.rejects(controller.business("POST", "/tools/decide", { operation: 12, decision: "approved" }), error => error instanceof ControlClientError && error.code === "personal_tls" && error.outcome === "not_sent");
  assert.equal(f.state.requestPaths.length, before);
  assert.equal(JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")).decisions, undefined);
});

test("协议与TLS：错产品、改档案、重定向和不受信证书均停止连接", async t => {
  for (const mode of ["product", "profile", "tls", "redirect"] as const) {
    const f = await desktopRemoteFixture(t), original = f.create(); await original.pair(pairCode, "Electron"); await original.close();
    if (mode === "product") f.state.handshakeProduct = "ruukoto-code";
    if (mode === "profile") f.state.handshakeProfile = `sha256:${"b".repeat(64)}`;
    if (mode === "redirect") f.overrides.set("/permissions", (_req, res) => { res.writeHead(302, { location: "/forbidden-redirect" }).end(); });
    const controller = f.create(mode !== "tls"); await controller.reconnect();
    if (mode === "redirect") await assert.rejects(controller.business("GET", "/permissions"), code("personal_redirect"));
    assert.equal(controller.status.state, "failed");
    assert.equal(controller.status.error?.code, mode === "product" ? "personal_protocol" : mode === "profile" ? "personal_identity_changed" : mode === "tls" ? "personal_tls" : "personal_redirect");
    assert.ok(!f.state.requestPaths.includes("/forbidden-redirect"));
  }
});

test("HTTP预算与秘密：超请求本地拒绝，超响应待核实，服务端错误不向renderer泄漏凭据", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "Electron");
  const before = f.state.requestPaths.length;
  await assert.rejects(controller.request("POST", "/settings", { text: "x".repeat(128 * 1024) }), code("personal_request_large")); assert.equal(f.state.requestPaths.length, before);
  f.overrides.set("/permissions", (_req, res) => { res.end("x".repeat(256 * 1024 + 1)); });
  await assert.rejects(controller.business("GET", "/permissions"), (error: unknown) => error instanceof ControlClientError && ["personal_response_large", "personal_connection_lost"].includes(error.code));
  const secret = JSON.parse(f.state.raw!).active.secret;
  f.overrides.set("/permissions", (_req, res) => { res.writeHead(400).end(JSON.stringify({ v: 1, product: "ruukoto", ok: false, code: "fixture_rejected", message: secret })); });
  await assert.rejects(controller.business("GET", "/permissions"), (error: unknown) => error instanceof ControlClientError && !error.message.includes(secret));
});

test("WSS：缺口重新快照，非法协议停止重试，旧连接关闭不取消后台输入", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "Electron");
  await waitFor(() => f.updates.some(update => update.type === "personal_frame"));
  const first = f.updates.find(update => update.type === "personal_frame")!; assert.equal(first.type, "personal_frame");
  for (const ws of f.wss.clients) ws.send(JSON.stringify({ v: 1, type: "events", runId: f.runId, subscription: first.frame.subscription, seq: 9, events: [] }));
  await waitFor(() => f.updates.filter(update => update.type === "personal_frame").length >= 2);
  for (const ws of f.wss.clients) ws.send("invalid JSON");
  await waitFor(() => controller.status.state === "failed"); assert.equal(controller.status.error?.code, "personal_protocol");
  assert.ok(!f.state.requestPaths.includes("/stop"));
});

test("新连接配置与旧维护：旧文件字节保留，损坏journal阻止维护，显式核实只写新记录", async t => {
  const f = await desktopRemoteFixture(t), oldChat = path.join(f.directory, "personal.json"), oldSettings = path.join(f.directory, "personal-settings.json"), oldPending = path.join(f.directory, "pending", "personal-settings", `${randomUUID()}.json`);
  fs.writeFileSync(oldChat, "旧聊天配置"); fs.writeFileSync(oldSettings, "旧设置配置"); fs.mkdirSync(path.dirname(oldPending), { recursive: true, mode: 0o700 }); fs.writeFileSync(oldPending, "损坏的原维护", { mode: 0o600 });
  for (const origin of ["http://pa.example", "https://user:secret@pa.example", "https://pa.example/path", "https://pa.example/a/..", "https://pa.example/?q=1", "https://pa.example/#fragment"]) assert.throws(() => savePersonalConfig(f.directory, { origin }), code("invalid_personal_origin"));
  savePersonalConfig(f.directory, { origin: f.origin }); assert.equal(loadPersonalConfig(f.directory)?.origin, f.origin);
  assert.deepEqual(legacyPersonalMaintenance(f.directory, f.origin), [oldPending]);
  acknowledgeLegacyPersonalMaintenance(f.directory, f.origin); assert.deepEqual(legacyPersonalMaintenance(f.directory, f.origin), []);
  assert.equal(fs.readFileSync(oldChat, "utf8"), "旧聊天配置"); assert.equal(fs.readFileSync(oldSettings, "utf8"), "旧设置配置"); assert.equal(fs.readFileSync(oldPending, "utf8"), "损坏的原维护");
  fs.appendFileSync(oldPending, "新增事实"); assert.deepEqual(legacyPersonalMaintenance(f.directory, f.origin), [oldPending]);
});

test("Host target isolation rejects legacy PA operations and waits for authenticated attachment connection", async t => {
  const f = await desktopRemoteFixture(t), host = new DesktopHost(process.cwd(), f.directory, { publish: () => {}, focused: () => true, notice: () => {}, badge: () => {} }, async () => ({ node: process.execPath, env: {} }));
  t.after(() => host.close());
  for (const op of ["submit", "continue", "set_session_model", "get_task", "respond_confirmation"]) {
    const result = await host.request("personal", op, {}); assert.equal(result.ok, false);
  }
  assert.throws(() => host.attachmentInstance("personal"), code("connection_unavailable"));
  const config = await host.request("personal", "desktop_personal_config_read", {}); assert.equal(config.ok, true);
  const controller = new PersonalController({ v: 1, origin: f.origin }, f.directory, () => {}, undefined); await controller.reconnect();
  assert.equal(controller.status.error?.code, "personal_credentials_unavailable"); await controller.close();
});


test("PA conversation and decisions stay in the desktop without OS notifications", () => {
  const notices: DesktopNotice[] = []; let badge = 0;
  const notifications = new DesktopNotifications(() => false, value => notices.push(value), count => { badge = count; }, async () => { throw new Error("PA不查询旧任务"); });
  const remoteId = randomUUID(), profile = { id: `sha256:${"a".repeat(64)}`, directory: "/profile" }, runId = randomUUID(), subscription = randomUUID();
  notifications.update("personal", { type: "personal_identity", identity: { v: 1, product: "ruukoto", remoteId, origin: "https://pa.example", profile, online: true, runId } });
  const entry = { entry: 1, conversation: 0, kind: "pi.assistant", role: "assistant" as const, text: "历史回答", partial: false, truncated: false, timestamp: 1 };
  notifications.update("personal", { type: "personal_frame", frame: { v: 1, type: "snapshot", runId, subscription, seq: 0, timeline: { through: 1, items: [entry] }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0 } } });
  notifications.update("personal", { type: "personal_frame", frame: { v: 1, type: "events", runId, subscription, seq: 1, events: [{ type: "message_end", entry }, { type: "message_end", entry: { ...entry, entry: 2 } }, { type: "entry_appended", entry: { ...entry, entry: 2 } }] } });
  assert.equal(notices.length, 0); assert.equal(badge, 0);
  notifications.update("personal", { type: "personal_identity", identity: { v: 1, product: "ruukoto", remoteId, origin: "https://pa.example", profile: { ...profile, id: `sha256:${"b".repeat(64)}` }, online: true, runId } });
  assert.equal(badge, 0);
});

test("WSS结构损坏：嵌套消息、增量与快照无效时关闭观察，不交给renderer", async t => {
  for (const bad of [{ type: "events", events: [{ type: "message_update", changes: null }] }, { type: "events", events: [{ type: "message_end", entry: null }] }, { type: "snapshot", timeline: { through: 1, items: [null] }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0 } },
    { type: "events", events: [{ type: "auto_retry_start", attempt: 1, at: "invalid", errorMessage: "fixture" }] },
    { type: "events", events: [{ type: "compaction_start", taskId: 1, reason: "fixture", blocking: "invalid" }] },
    { type: "events", events: [{ type: "tool_execution_start", toolCallId: "call", toolName: "read", arguments: 1, truncated: false }] },
    { type: "events", events: [{ type: "tool_execution_end", toolCallId: "call", toolName: "read", result: { text: 1, truncated: false, isError: false } }] },
    { type: "snapshot", timeline: { through: 0, items: [] }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0, generation: { attempt: 1, retry: { at: 1, error: 1 } } } },
  ]) {
    const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "Electron");
    await waitFor(() => f.updates.some(update => update.type === "personal_frame"));
    const frame = f.updates.find(update => update.type === "personal_frame")!; assert.equal(frame.type, "personal_frame");
    const before = f.updates.filter(update => update.type === "personal_frame").length;
    for (const ws of f.wss.clients) ws.send(JSON.stringify({ v: 1, runId: f.runId, subscription: frame.frame.subscription, seq: 1, ...bad }));
    await waitFor(() => controller.status.state === "failed");
    assert.equal(controller.status.error?.code, "personal_protocol"); assert.equal(f.updates.filter(update => update.type === "personal_frame").length, before);
  }
});

test("观察断开立即淘汰在途旧代次HTTP结果，不等待下一次握手", async t => {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair(pairCode, "Electron");
  await waitFor(() => f.updates.some(update => update.type === "personal_frame"));
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.overrides.set("/permissions", async (_req, res) => { started = true; await gate; f.respond(res, { old: true }); });
  const pending = controller.business("GET", "/permissions");
  const checked = assert.rejects(pending, code("personal_identity_changed"));
  await waitFor(() => started);
  for (const ws of f.wss.clients) ws.close();
  await waitFor(() => controller.status.state === "reconnecting"); release(); await checked;
});
