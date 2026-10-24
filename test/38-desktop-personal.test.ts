import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
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

test("Host目标隔离：PA旧control操作与附件被拒绝，Code无安全存储仍可处理本机入口", async t => {
  const f = await desktopRemoteFixture(t), host = new DesktopHost(process.cwd(), f.directory, { publish: () => {}, focused: () => true, notice: () => {}, badge: () => {} }, async () => ({ node: process.execPath, env: {} }));
  t.after(() => host.close());
  for (const op of ["submit", "continue", "set_session_model", "get_task", "respond_confirmation"]) {
    const result = await host.request("personal", op, {}); assert.equal(result.ok, false);
  }
  assert.throws(() => host.attachmentInstance("personal"), code("op_not_allowed"));
  const config = await host.request("personal", "desktop_personal_config_read", {}); assert.equal(config.ok, true);
  const controller = new PersonalController({ v: 1, origin: f.origin }, f.directory, () => {}, undefined); await controller.reconnect();
  assert.equal(controller.status.error?.code, "personal_credentials_unavailable"); await controller.close();
});


test("PA原生通知：历史静默、完成去重、业务补查刷新审批角标，档案切换清空", () => {
  const notices: DesktopNotice[] = []; let badge = 0;
  const notifications = new DesktopNotifications(() => false, value => notices.push(value), count => { badge = count; }, async () => { throw new Error("PA不查询旧任务"); });
  const remoteId = randomUUID(), profile = { id: `sha256:${"a".repeat(64)}`, directory: "/profile" }, runId = randomUUID(), subscription = randomUUID();
  notifications.update("personal", { type: "personal_identity", identity: { v: 1, product: "ruukoto", remoteId, origin: "https://pa.example", profile, online: true, runId } });
  const entry = { entry: 1, conversation: 0, kind: "pi.assistant", role: "assistant" as const, text: "历史回答", partial: false, truncated: false, timestamp: 1 };
  notifications.update("personal", { type: "personal_frame", frame: { v: 1, type: "snapshot", runId, subscription, seq: 0, timeline: { through: 1, items: [entry] }, live: { tools: [], toolCount: 0, inbox: [], inboxCount: 0 } } });
  notifications.update("personal", { type: "personal_frame", frame: { v: 1, type: "events", runId, subscription, seq: 1, events: [{ type: "message_end", entry }, { type: "message_end", entry: { ...entry, entry: 2 } }, { type: "entry_appended", entry: { ...entry, entry: 2 } }] } });
  assert.equal(notices.length, 1); assert.equal(notices[0].instanceId, remoteId);
  notifications.personalPending(remoteId, "/questions", { items: [{ id: "1", status: "pending" }] }); assert.equal(badge, 1); assert.equal(notices.length, 1);
  notifications.personalPending(remoteId, "/questions", { items: [{ id: "1", status: "pending" }, { id: "2", status: "pending" }] }); assert.equal(badge, 2); assert.equal(notices.length, 2);
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
