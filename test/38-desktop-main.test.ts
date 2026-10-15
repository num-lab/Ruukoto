import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { adoptEnvironment, codeTargetConfig, DesktopError, selectEnvironment } from "../apps/desktop/src/main/environment.ts";
import { CodeController, serializeFailure } from "../apps/desktop/src/main/controller.ts";
import { DESKTOP_OPS, handleRequest, ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { cspFor, externalUrl, isRendererReload } from "../apps/desktop/src/main/security.ts";
import { socketLookupCommand, versionRecovery } from "../apps/desktop/src/main/recovery.ts";
import type { DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";

const root = path.resolve(import.meta.dirname, "..");
const unavailable = async (): Promise<never> => { throw new ControlClientError("connection_unavailable", "连接不可用", "not_sent"); };
const token = "desktop-owner-secret-".repeat(3);
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-desktop-"));
  const previous = { ...process.env };
  const env = { PATH: process.env.PATH, RUUKOTO_CODE_DATA_DIR: path.join(dir, "data"), RUUKOTO_CODE_CONTROL_DIR: path.join(dir, "explicit-control"), RUUKOTO_CODE_AGENT_DIR: path.join(dir, "agent"), RUUKOTO_OWNER_TOKEN: token };
  fs.mkdirSync(env.RUUKOTO_CODE_CONTROL_DIR);
  fs.writeFileSync(path.join(env.RUUKOTO_CODE_CONTROL_DIR, "owner.token"), token);
  return { dir, env, restore() { adoptEnvironment(previous); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("桌面日常路径、令牌与后台参数均采用登录 shell 环境", async () => {
  const f = fixture();
  try {
    let shells = 0;
    const source = await selectEnvironment({ ...process.env, RUUKOTO_CODE_DATA_DIR: "/wrong", RUUKOTO_OWNER_TOKEN: "wrong" }, async () => { shells++; return { env: f.env, node: process.execPath }; });
    adoptEnvironment(source.env);
    const config = codeTargetConfig(root, source);
    assert.equal(shells, 1);
    assert.equal(config.product, "ruukoto-code");
    assert.equal(config.dataDir, f.env.RUUKOTO_CODE_DATA_DIR);
    assert.equal(config.controlDir, f.env.RUUKOTO_CODE_CONTROL_DIR);
    assert.equal(config.spawnExecPath, process.execPath);
    assert.deepEqual(config.spawnArgv, [path.join(root, "apps/ruukoto-code/bin/ruukoto-code.mjs"), "server", "--data-dir", config.dataDir, "--agent-dir", f.env.RUUKOTO_CODE_AGENT_DIR]);
    assert.equal(config.env, source.env);
    let ensures = 0, starts = 0;
    const updates: DesktopUpdate[] = [];
    const controller = new CodeController(config, update => updates.push(update), { ensure: async options => { ensures++; assert.equal(options, config); return { ok: true, spawned: false }; }, connection: (connection, callbacks) => {
      assert.equal(connection.token, token);
      assert.equal(connection.socketPath, path.join(config.controlDir, "control.sock"));
      return { start: async () => { starts++; const error = new ControlClientError("protocol_version", "旧后台", "rejected", { client: 26, server: 25 }); callbacks.onState("failed", error.message, error); throw error; }, close() {}, request: unavailable };
    } });
    await controller.reconnect();
    assert.equal(starts, 1);
    assert.equal(ensures, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(starts, 1, "failed 不自动重试");
    const status = controller.status;
    assert.equal(status.state, "failed");
    assert.deepEqual(status.error?.versions, { client: 26, server: 25 });
    assert.ok(!JSON.stringify(updates).includes(token));
    await handleRequest("code", "reconnect", {}, () => controller.reconnect(), unavailable);
    assert.equal(ensures, 2);
    assert.equal(starts, 2);
    controller.close();
  } finally { f.restore(); }
});

test("受管桌面只用开发档案，不执行登录 shell 或 ensureBackend", async () => {
  const f = fixture();
  try {
    const inherited = { ...f.env, RUUKOTO_DESKTOP_MANAGED: "1" };
    delete (inherited as NodeJS.ProcessEnv).RUUKOTO_OWNER_TOKEN;
    let shells = 0, ensures = 0, starts = 0;
    const source = await selectEnvironment(inherited, async () => { shells++; return { env: { ...f.env, RUUKOTO_CODE_DATA_DIR: "/daily", RUUKOTO_OWNER_TOKEN: "daily" }, node: "/daily/node" }; });
    assert.deepEqual(source.env, inherited);
    adoptEnvironment(source.env);
    const config = codeTargetConfig(root, source);
    assert.equal(config.dataDir, f.env.RUUKOTO_CODE_DATA_DIR);
    const controller = new CodeController(config, () => {}, { ensure: async () => { ensures++; return { ok: true, spawned: false }; }, connection: (connection, callbacks) => {
      assert.equal(connection.token, token);
      return { start: async () => { starts++; callbacks.onState("failed", "不兼容", new ControlClientError("protocol_version", "不兼容", "rejected", { client: 26, server: 25 })); }, close() {}, request: unavailable };
    } });
    await controller.reconnect();
    assert.deepEqual(controller.status.recovery, ["开发后台版本较旧；请重启开发启动器。"]);
    await handleRequest("code", "reconnect", {}, () => controller.reconnect(), unavailable);
    assert.equal(starts, 2);
    assert.equal(shells, 0);
    assert.equal(ensures, 0);
    controller.close();
  } finally { f.restore(); }
});

test("主进程请求名单拒绝越界操作，IPC 错误保留分类与版本且隐藏令牌", async () => {
  let calls = 0;
  const reconnect = async () => { calls++; };
  for (const [target, op, params] of [["code", "stop", {}], ["code", "auth", { token }], ["unknown", "reconnect", {}], ["code", "reconnect", { token }], ["code", "reconnect", []]]) {
    const result = await handleRequest(target, op, params, reconnect, unavailable);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(token));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await handleRequest("code", "reconnect", {}, reconnect, unavailable), { ok: true, value: undefined });
  assert.equal(calls, 1);
  const forwarded: string[] = [];
  for (const op of DESKTOP_OPS) {
    assert.deepEqual(await handleRequest("code", op, { session_id: "session" }, reconnect, async (name, params) => {
      forwarded.push(name);
      assert.deepEqual(params, { session_id: "session" });
      return { source: name };
    }), { ok: true, value: { source: op } });
    assert.equal((await handleRequest("code", op, null, reconnect, unavailable)).ok, false);
  }
  assert.deepEqual(forwarded, [...DESKTOP_OPS]);
  for (const op of ["work_list", "work_get", "read_tool_result"] as const) assert.ok(forwarded.includes(op));
  const error = new ControlClientError("protocol_version", `拒绝 ${token}`, "rejected", { client: 25, server: 26 });
  assert.deepEqual(serializeFailure(error, token), { code: "protocol_version", outcome: "rejected", message: "拒绝 [令牌已隐藏]", versions: { client: 25, server: 26 } });
  const lost = await ipcResult(() => { throw new ControlClientError("request_timeout", "应答丢失", "unknown"); });
  assert.deepEqual(lost, { ok: false, error: { code: "request_timeout", outcome: "unknown", message: "应答丢失" } });
});

test("桌面开发 CSP 限定来源与 nonce，系统链接仅开放 HTTP(S)", () => {
  const policy = cspFor("http://localhost:5173/path", "nonce_1234567890abcd");
  assert.ok(policy.includes("http://localhost:5173"));
  assert.ok(policy.includes("ws://localhost:5173"));
  assert.ok(policy.includes("'nonce-nonce_1234567890abcd'"));
  assert.ok(!policy.includes("unsafe-inline"));
  assert.throws(() => cspFor("https://example.com", "nonce_1234567890abcd"));
  assert.throws(() => cspFor("http://localhost:5173", "bad'nonce"));
  assert.equal(externalUrl("javascript:alert(1)"), null);
  assert.equal(externalUrl("file:///tmp/file"), null);
  assert.equal(externalUrl("https://example.com"), "https://example.com/");
  assert.equal(isRendererReload("http://localhost:5173/", "http://localhost:5173"), true);
  for (const value of ["http://localhost:5173/other", "http://localhost:5173/?page=other", "http://localhost:5173.evil/", "https://example.com/", "javascript:alert(1)"]) assert.equal(isRendererReload(value, "http://localhost:5173/"), false);
  assert.equal(isRendererReload("file:///renderer/index.html", undefined), false);
  assert.equal(isRendererReload("file:///renderer/index.html", ""), false);
});

test("版本恢复方向使用结构化值，Code 指引按当前 socket 且正确转义路径", () => {
  const controlDir = "/tmp/控制目录 with 'quote'";
  for (const target of ["code", "personal"] as const) assert.match(versionRecovery(target, { client: 24, server: 25 }, false, controlDir).join("\n"), /重建应用/);
  assert.match(versionRecovery("personal", { client: 26, server: 25 }, false, controlDir).join("\n"), /服务器部署同一 commit/);
  const guide = versionRecovery("code", { client: 26, server: 25 }, false, controlDir).join("\n");
  assert.match(guide, /恰好只有一个 PID/);
  assert.match(guide, /ps -o user=,command=/);
  assert.match(guide, /kill -TERM <PID>/);
  assert.match(guide, /未查到监听进程/);
  assert.match(guide, /多个不同 PID/);
  assert.ok(!guide.includes("|"));
  const socket = path.join(controlDir, "control.sock");
  const command = socketLookupCommand(socket);
  const escaped = command.slice("lsof -nP -a -U -- ".length);
  assert.equal(execFileSync("/bin/sh", ["-c", `printf '%s' ${escaped}`], { encoding: "utf8" }), socket);
});

test("仓库缺失与 node 不可用显示可操作错误，关闭期间不再新建连接", async () => {
  assert.throws(() => codeTargetConfig("/missing-repository", { env: {}, node: process.execPath }), (error: unknown) => error instanceof DesktopError && error.code === "repository_missing" && error.message.includes("desktop:build"));
  await assert.rejects(selectEnvironment({ PATH: "/missing-node", RUUKOTO_DESKTOP_MANAGED: "1" }), (error: unknown) => error instanceof DesktopError && error.code === "node_unavailable" && error.message.includes("启动器"));
  const f = fixture();
  try {
    const oldNode = path.join(f.dir, "node");
    fs.writeFileSync(oldNode, `#!/bin/sh
printf '\\000RUUKOTO_DESKTOP\\000%s\\000END\\000' '{"env":{},"node":"/old/node","version":"20.0.0"}'
`, { mode: 0o755 });
    await assert.rejects(selectEnvironment({ PATH: f.dir, RUUKOTO_DESKTOP_MANAGED: "1" }), (error: unknown) => error instanceof DesktopError && error.code === "node_unavailable" && error.message.includes("版本过旧"));
    adoptEnvironment(f.env);
    let release!: (result: { ok: true; spawned: boolean }) => void;
    let starts = 0;
    const controller = new CodeController(codeTargetConfig(root, { env: f.env, node: process.execPath }), () => {}, { ensure: () => new Promise(resolve => { release = resolve; }), connection: () => { starts++; return { start: async () => {}, close() {}, request: unavailable }; } });
    const pending = controller.reconnect();
    controller.close();
    release({ ok: true, spawned: false });
    await pending;
    assert.equal(starts, 0);
  } finally { f.restore(); }
});

import { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { ModelSelection, Session } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import type { DesktopSubmitResult } from "../apps/desktop/src/shared/bridge.ts";
import { CodeWrites, queueDecision } from "../apps/desktop/src/renderer/code-writes.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { fakeControl, fakeSnapshot, type FakeScript } from "./helpers/fake-control.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";

const selection: ModelSelection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
function desktopSession(overrides: Partial<Session> = {}): Session {
  return { id: "session", projectId: "project", workspaceProjectId: null, name: null, branchSource: null, kind: "dev", cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: selection, modelSelectionVersion: 1, defaultAccessMode: "confirm", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, createdAt: new Date().toISOString(), ...overrides };
}
function desktopTask(overrides: Partial<TaskView> = {}): TaskView {
  return { id: "task", sessionId: "session", requestId: "original", input: "输入", inputPurpose: "user", modelSelection: selection, submissionDigest: null, status: "queued", accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, ...overrides };
}
function pendingRecord(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return { requestId: "original", op: "submit", params: { session_id: "session", input: "原输入", request_id: "original" }, instanceId: "inst-1", createdAt: new Date().toISOString(), ...overrides };
}
function desktopHarness(script: FakeScript, seed: PendingRequest[] = [], existingDir?: string) {
  const f = fixture();
  const store = new PendingRequestStore(existingDir ?? path.join(f.dir, "pending"));
  seed.forEach(record => store.save(record));
  const updates: DesktopUpdate[] = [];
  const fake = fakeControl(script);
  const view = new ViewState();
  let online = false;
  const source = { env: { ...f.env, RUUKOTO_DESKTOP_MANAGED: "1" }, node: process.execPath };
  const config = { ...codeTargetConfig(root, source), controlDir: f.env.RUUKOTO_CODE_CONTROL_DIR, socketPath: path.join(f.env.RUUKOTO_CODE_CONTROL_DIR, "control.sock") };
  const controller = new CodeController(config, update => {
    updates.push(update);
    if (update.type === "snapshot") view.applySnapshot(update.result, update.instanceChanged);
    if (update.type === "state") online = update.state === "online";
    writes.update(update);
  }, { ensure: async () => { throw new Error("受管目标不能拉起后台"); }, connection: (config, callbacks) => new ControlConnection({ ...config, reconnectInitialMs: 5, reconnectMaxMs: 10, clientFactory: fake.factory }, callbacks) }, store);
  const request = (target: unknown, op: unknown, params: unknown) => handleRequest(target, op, params, () => controller.reconnect(), (op, params) => controller.dispatch(op, params), (op, params) => controller.submissions!.local(op, params));
  const writes = new CodeWrites({ request }, view, () => online, () => {}, "code");
  return { store, controller, updates, fake, view, writes, request, dir: f.dir, async start() { await controller.reconnect(); await controller.submissions!.reconcile(); }, close() { controller.close(); f.restore(); } };
}

test("严格待核实存储区分不存在、损坏和 IO 失败，宽容入口语义不变", () => {
  const f = fixture();
  const dir = path.join(f.dir, "strict");
  const store = new PendingRequestStore(dir);
  try {
    assert.deepEqual(store.read("absent"), { kind: "absent" });
    assert.equal(store.remove("absent"), "absent");
    assert.throws(() => store.read("../escape"));
    const record = pendingRecord();
    store.save(record);
    assert.deepEqual(store.read(record.requestId), { kind: "record", record });
    fs.writeFileSync(path.join(dir, "broken.json"), "{");
    fs.writeFileSync(path.join(dir, "mismatch.json"), JSON.stringify(record));
    assert.deepEqual(store.read("broken"), { kind: "corrupt" });
    assert.deepEqual(store.read("mismatch"), { kind: "corrupt" });
    fs.chmodSync(dir, 0o500);
    assert.throws(() => store.remove(record.requestId), { code: "EACCES" });
    store.clear(record.requestId);
    fs.chmodSync(dir, 0);
    assert.throws(() => store.read(record.requestId), { code: "EACCES" });
    assert.deepEqual(store.list(), { records: [], corrupt: [] });
    fs.chmodSync(dir, 0o700);
    assert.equal(store.read(record.requestId).kind, "record");
    assert.equal(store.remove(record.requestId), "removed");
    assert.equal(store.remove(record.requestId), "absent");
  } finally { fs.chmodSync(dir, 0o700); f.restore(); }
});

test("桌面同连接缺口重同步会重新核实 kept，合并触发不并发且成功只通知一次", async () => {
  let found = false, queries = 0, active = 0, maxActive = 0, handshakes = 0;
  const h = desktopHarness({ handshake: () => ({ seq: ++handshakes * 10, replay: [], snapshot: fakeSnapshot() }), handlers: { find_task: async () => {
    queries++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (!found) throw new ControlClientError("request_timeout", "查询失败", "unknown");
    return { task: desktopTask() };
  } } }, [pendingRecord()]);
  try {
    await h.start();
    assert.equal(h.store.list().records.length, 1);
    found = true;
    const beforeQueries = queries;
    h.fake.transports[0].emit({ seq: 50, taskId: null, sessionId: null, createdAt: new Date().toISOString(), body: { type: "backend.stopping", reason: "gap" } });
    await waitFor("快照自身触发核实", () => queries > beforeQueries);
    const rounds = [h.controller.submissions!.reconcile(), h.controller.submissions!.reconcile(), h.controller.submissions!.reconcile()];
    await Promise.all(rounds);
    await waitFor("核实清除", () => h.store.list().records.length === 0);
    assert.equal(maxActive, 1);
    assert.ok(queries >= 2);
    assert.equal(h.updates.filter(update => update.type === "state" && update.state === "online").length, 1);
    assert.equal(h.updates.filter(update => update.type === "snapshot").length, 2);
    assert.equal(h.updates.filter(update => update.type === "submission" && update.result.kind === "linked").length, 1);
    assert.equal(h.fake.transports[0].requests.filter(request => request.op === "submit" || request.op === "continue").length, 0);
    assert.ok(h.fake.transports[0].requests.filter(request => request.op === "find_task").every(request => JSON.stringify(request.params).includes("original")));
  } finally { h.close(); }
});

for (const op of ["submit", "continue"] as const) {
  test(`桌面 ${op} 在线丢答当场核实，在途重复点击和应用重启不新建任务`, async () => {
    let received: TaskView | null = null;
    let sends = 0;
    let release!: () => void;
    const blocked = new Promise<void>(done => { release = done; });
    const script: FakeScript = { handlers: { [op]: async (params: import("@ruukoto/control/ops.ts").OpParams<"continue">) => {
      sends++;
      received = desktopTask({ requestId: params.request_id, resumesTaskId: op === "continue" ? params.task_id : null });
      await blocked;
      throw new ControlClientError("request_timeout", "应答丢失", "unknown");
    }, find_task: () => ({ task: received }) } };
    const h = desktopHarness(script);
    try {
      await h.start();
      const params = { session_id: "session", input: "新输入", model_selection: selection, ...(op === "continue" ? { task_id: "source" } : {}) };
      const sending = h.request("code", op, params);
      await waitFor("发送已开始", () => sends === 1);
      const stored = h.store.list().records[0];
      assert.equal(stored.params.session_id, "session");
      assert.equal(stored.params.request_id, stored.requestId);
      const duplicate = await h.request("code", op, params);
      assert.equal(duplicate.ok && (duplicate.value as DesktopSubmitResult).kind, "pending_existing");
      assert.equal(h.store.list().records[0].requestId, stored.requestId);
      release();
      await sending;
      await h.controller.submissions!.reconcile();
      assert.equal(sends, 1);
      assert.equal(h.store.list().records.length, 0);
      h.controller.close();
      h.store.save(stored);
      const restarted = desktopHarness(script, [], h.store.dir);
      try { await restarted.start(); assert.equal(sends, 1); assert.equal(restarted.store.list().records.length, 0); assert.equal(restarted.updates.filter(update => update.type === "submission" && update.result.kind === "linked").length, 1); }
      finally { restarted.close(); }
    } finally { release(); h.close(); }
  });
}

test("桌面提交断线重连核实原任务；异实例保留且不重发", async () => {
  let accepted: TaskView | null = null;
  let instanceId = "inst-1";
  const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ instanceId }) }), handlers: {
    submit: (params, transport) => { accepted = desktopTask({ requestId: params.request_id }); transport.drop(); return accepted; }, find_task: () => ({ task: accepted }),
  } });
  try {
    await h.start();
    const result = await h.request("code", "submit", { session_id: "session", input: "断线", model_selection: selection });
    assert.equal(result.ok && (result.value as DesktopSubmitResult).kind, "pending_verification");
    await waitFor("断线核实完成", () => h.fake.transports.length > 1 && h.store.list().records.length === 0);
    assert.equal(h.fake.transports.flatMap(transport => transport.requests).filter(request => request.op === "submit").length, 1);
    h.store.save(pendingRecord()); instanceId = "other";
    await h.controller.reconnect(); await h.controller.submissions!.reconcile();
    assert.equal(h.store.list().records.length, 1);
    assert.equal(h.writes.entries.get("original")?.result?.kind, "foreign_instance");
    assert.equal(h.fake.transports.at(-1)!.requests.length, 0);
    assert.equal((await h.request("code", "find_task", {})).ok, false);
  } finally { h.close(); }
});

for (const op of ["submit", "continue"] as const) {
  test(`桌面 ${op} 缺模型恢复先交付后清理，丢答／重载／重复确认不丢原文`, async () => {
    const record = pendingRecord({ op, params: { session_id: "session", input: "原输入", request_id: "original", ...(op === "continue" ? { task_id: "source" } : {}) } });
    const script: FakeScript = { handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession()] }) }), handlers: { find_task: () => ({ task: null }) } };
    const h = desktopHarness(script, [record]);
    try {
      await h.start();
      assert.equal(h.writes.entries.get("original")?.result?.kind, "needs_resubmit");
      const before = h.fake.transports[0].requests.length;
      assert.equal(h.writes.blocked("session"), true);
      assert.equal(h.writes.draft("session").text, "");
      h.writes.defer();
      assert.equal(h.fake.transports[0].requests.length, before, "暂不处理不发请求");
      const read = await h.request("code", "desktop_pending_read", { request_id: "original" });
      assert.equal(read.ok, true);
      assert.equal(h.store.list().records.length, 1, "读取应答没有交付时，持久副本仍在");
      h.controller.close();
      const restarted = desktopHarness(script, [], h.store.dir);
      try {
        await restarted.start();
        restarted.writes.edit("session", "已有草稿");
        const bridge = { request: async (target: string, name: string, params: Record<string, unknown>) => {
          const result = await restarted.request(target, name, params);
          if (name === "desktop_pending_clear" && lost) { lost = false; return { ok: false as const, error: { code: "ipc_lost", outcome: "unknown" as const, message: "确认应答丢失" } }; }
          return result;
        } };
        let lost = true;
        const writes = new CodeWrites(bridge, restarted.view, () => true, () => {}, "code");
        writes.update({ type: "pending", entries: [{ record, result: { kind: "needs_resubmit", requestId: record.requestId, params: record.params } }], corrupt: [], dir: restarted.store.dir });
        writes.edit("session", "已有草稿");
        await writes.restore("original");
        assert.equal(writes.draft("session").text, "原输入\n\n已有草稿");
        assert.equal(writes.draft("session").taskId, op === "continue" ? "source" : undefined);
        assert.equal(writes.blocked("session"), true);
        assert.equal(restarted.store.read("original").kind, "absent");
        await writes.restore("original");
        assert.equal(writes.draft("session").text, "原输入\n\n已有草稿");
        assert.equal(writes.blocked("session"), false);
        await restarted.controller.submissions!.reconcile();
        assert.equal(restarted.store.list().records.length, 0);
      } finally { restarted.close(); }
    } finally { h.close(); }
  });
}

test("桌面恢复严格清理失败仍禁用，权限修复后再清；不存在幂等、未核实／异实例／损坏拒绝", async () => {
  let failQuery = false;
  const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession()] }) }), handlers: { find_task: () => { if (failQuery) throw new ControlClientError("request_timeout", "未知", "unknown"); return { task: null }; } } }, [pendingRecord()]);
  try {
    await h.start();
    assert.deepEqual(await h.request("code", "desktop_pending_clear", { request_id: "never" }), { ok: true, value: undefined });
    const absent = await h.request("code", "desktop_pending_read", { request_id: "never" });
    assert.equal(!absent.ok && absent.error.code, "not_restorable");
    fs.chmodSync(h.store.dir, 0);
    const failed = await h.request("code", "desktop_pending_clear", { request_id: "original" });
    assert.equal(!failed.ok && failed.error.code, "pending_clear_failed");
    assert.equal(h.writes.blocked("session"), true);
    const unreadable = await h.request("code", "desktop_pending_read", { request_id: "original" });
    assert.equal(!unreadable.ok && unreadable.error.code, "pending_read_failed");
    fs.chmodSync(h.store.dir, 0o700);
    assert.equal(h.store.read("original").kind, "record");
    fs.chmodSync(h.store.dir, 0o500);
    const undeletable = await h.request("code", "desktop_pending_clear", { request_id: "original" });
    assert.equal(!undeletable.ok && undeletable.error.code, "pending_clear_failed");
    fs.chmodSync(h.store.dir, 0o700);
    await h.writes.restore("original");
    assert.equal(h.writes.blocked("session"), false);
    assert.equal(h.writes.draft("session").text, "原输入");
    failQuery = true;
    h.store.save(pendingRecord()); await h.controller.submissions!.reconcile();
    for (const name of ["desktop_pending_read", "desktop_pending_clear"]) {
      const result = await h.request("code", name, { request_id: "original" });
      assert.equal(!result.ok && result.error.code, "not_restorable");
    }
    h.store.save(pendingRecord({ requestId: "foreign", instanceId: "foreign" }));
    await h.controller.submissions!.reconcile();
    fs.writeFileSync(path.join(h.store.dir, "broken.json"), "{}");
    for (const request_id of ["foreign", "broken", "../escape"]) for (const name of ["desktop_pending_read", "desktop_pending_clear"]) {
      const result = await h.request("code", name, { request_id });
      assert.equal(!result.ok && result.error.code, "not_restorable");
    }
    assert.equal(h.store.read("original").kind, "record");
    assert.equal(h.store.read("foreign").kind, "record");
    assert.equal(h.store.read("broken").kind, "corrupt");
    h.controller.submissions!.refresh();
    assert.ok(h.writes.corrupt.includes("broken.json"));
  } finally { fs.chmodSync(h.store.dir, 0o700); h.close(); }
});

for (const code of ["request_timeout", "model_selection_conflict", "default_mode_conflict"] as const) {
  test(`桌面设置 ${code} 回读实际模型与模式，不重放设置`, async () => {
    const actual = desktopSession({ modelSelection: { ...selection, thinkingLevel: "low" }, modelSelectionVersion: 3, defaultAccessMode: "plan", defaultAccessModeVersion: 4 });
    const fail = () => { throw new ControlClientError(code, "设置应答", code === "request_timeout" ? "unknown" : "rejected"); };
    const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession()] }) }), handlers: { set_session_model: fail, set_session_mode: fail, get_session: () => actual } });
    try {
      await h.start();
      await h.writes.setModel(h.view.sessions[0], selection);
      await h.writes.setMode(h.view.sessions[0], "full_access");
      assert.deepEqual(h.view.sessions[0].modelSelection, actual.modelSelection);
      assert.equal(h.view.sessions[0].defaultAccessMode, "plan");
      const requests = h.fake.transports[0].requests;
      assert.equal(requests.filter(request => request.op === "get_session").length, 2);
      assert.equal(requests.filter(request => request.op === "set_session_model").length, 1);
      assert.equal(requests.filter(request => request.op === "set_session_mode").length, 1);
      assert.deepEqual(requests.find(request => request.op === "set_session_mode")?.params, { session_id: "session", expected_version: 4, mode: "full_access" });
    } finally { h.close(); }
  });
}

test("桌面任务控制与恢复队列在线丢答回读，断线等待同实例快照，查询失败保留未知", async () => {
  let disconnect = false, failRead = false;
  const session = desktopSession({ queueState: "paused", queuePauseReason: "backend_restart" });
  const actualTask = desktopTask({ status: "interrupted" });
  const fail = () => { throw new ControlClientError("lost", "丢答", disconnect ? "disconnected" : "unknown"); };
  const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [session], tasks: [actualTask] }) }), handlers: { interrupt: fail, cancel: fail, resume_queue: fail, get_task: () => { if (failRead) throw new ControlClientError("timeout", "读失败", "unknown"); return { task: actualTask, seq: 0, outputPreview: null, toolOps: [], confirmations: [], artifacts: [] }; }, get_session: () => ({ ...session, queueState: "active" }) } });
  try {
    await h.start();
    await h.writes.control("interrupt", "session", "task");
    assert.equal(h.view.getTask("task")?.status, "interrupted");
    await h.writes.resume(session);
    assert.equal(h.view.sessions[0].queueState, "active");
    failRead = true;
    await h.writes.control("cancel", "session", "task");
    assert.match(h.writes.message!, /结果未知/);
    assert.equal(h.writes.unknown.size, 1);
    disconnect = true;
    const reads = h.fake.transports[0].requests.filter(request => request.op === "get_task").length;
    await h.writes.control("interrupt", "session", "task");
    assert.equal(h.fake.transports[0].requests.filter(request => request.op === "get_task").length, reads);
    const foreign = { seq: 0, replay: [], snapshot: fakeSnapshot({ instanceId: "foreign", sessions: [session], tasks: [actualTask] }) };
    h.view.applySnapshot(foreign, true);
    h.writes.update({ type: "snapshot", result: foreign, instanceChanged: true });
    assert.equal(h.writes.unknown.size, 1, "异实例快照不能核实原任务");
    await h.controller.reconnect();
    assert.equal(h.writes.unknown.size, 0);
    assert.equal(h.fake.transports.flatMap(transport => transport.requests).filter(request => request.op === "interrupt").length, 2);
  } finally { h.close(); }
});

test("桌面队列决策区分补模型、取消确认和普通恢复；真实控制面只补旧任务", async () => {
  const t = await startTestRuntime("d-queue", async () => ({ kind: "text", text: "ok" }), { config: { product: product.runtime } });
  try {
    const opened = await t.client.request<{ session: Session }>("open_workspace", { cwd: t.work[0], request_id: "queue_fixture" });
    const session = opened.session;
    t.runtime.store.setSessionQueueState(session.id, "paused", "backend_restart");
    const first = await t.client.request<TaskView>("submit", { session_id: session.id, request_id: "old", input: "old", model_selection: selection });
    const second = await t.client.request<TaskView>("submit", { session_id: session.id, request_id: "new", input: "new", model_selection: selection });
    t.runtime.store.db.prepare("UPDATE tasks SET model_selection = NULL WHERE id = ?").run(first.id);
    const preserved = { provider: "existing", modelId: "kept", thinkingLevel: "off" };
    t.runtime.store.db.prepare("UPDATE tasks SET model_selection = ? WHERE id = ?").run(JSON.stringify(preserved), second.id);
    const view = new ViewState();
    view.applySnapshot(await t.client.handshake(), false);
    const current = view.sessions.find(item => item.id === session.id)!;
    current.modelSelection = null;
    assert.deepEqual(queueDecision(view, current), { kind: "select_model" });
    current.modelSelection = selection;
    assert.deepEqual(queueDecision(view, current), { kind: "confirm", count: 1, selection });
    assert.equal(t.runtime.store.getSession(session.id)!.queueState, "paused", "取消只关闭确认，不发请求");
    await assert.rejects(t.client.request("resume_queue", { session_id: session.id }), { code: "model_selection_required" });
    assert.equal(t.runtime.store.getSession(session.id)!.queueState, "paused");
    const decision = queueDecision(view, current, true);
    assert.equal(decision.kind, "send");
    if (decision.kind !== "send") throw new Error("预期可恢复");
    await t.client.request("resume_queue", decision.params);
    assert.deepEqual(t.runtime.store.getTask(first.id)!.modelSelection, selection);
    assert.deepEqual(t.runtime.store.getTask(second.id)!.modelSelection, preserved);
    view.upsertTask({ ...first, modelSelection: selection });
    assert.deepEqual(queueDecision(view, current), { kind: "send", params: { session_id: session.id } });
  } finally { await t.shutdown(); }
});

test("桌面守护的丢答、核实错误和 IPC 返回同样隐藏拥有者令牌", async () => {
  const h = desktopHarness({ handlers: { submit: () => { throw new ControlClientError("timeout", `超时 ${token}`, "unknown"); }, find_task: () => { throw new ControlClientError("timeout", `查询失败 ${token}`, "unknown"); } } });
  try {
    await h.start();
    const result = await h.request("code", "submit", { session_id: "session", input: "安全输入", model_selection: selection });
    await h.controller.submissions!.reconcile();
    assert.equal(result.ok && (result.value as DesktopSubmitResult).kind, "pending_verification");
    assert.ok(!JSON.stringify(result).includes(token));
    assert.ok(!JSON.stringify(h.updates).includes(token));
    assert.ok(!fs.readFileSync(path.join(h.store.dir, `${h.store.list().records[0].requestId}.json`), "utf8").includes(token));
  } finally { h.close(); }
});

for (const outcome of ["not_sent", "rejected"] as const) {
  test(`桌面迟到 ${outcome} 把输入恢复到原实例所属会话，保留新草稿`, async () => {
    let release!: () => void;
    const delayed = new Promise<void>(done => { release = done; });
    let began = false;
    const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession()] }) }), handlers: { submit: async () => { began = true; await delayed; throw new ControlClientError("denied", "未执行", outcome); } } });
    try {
      await h.start();
      h.writes.edit("session", "原输入");
      const send = h.writes.send("session");
      await waitFor("提交等待", () => began);
      h.writes.edit("session", "发送期间新草稿");
      const foreign = { seq: 0, replay: [], snapshot: fakeSnapshot({ instanceId: "other", sessions: [desktopSession()] }) };
      h.view.applySnapshot(foreign, true);
      h.writes.update({ type: "snapshot", result: foreign, instanceChanged: true });
      release(); await send;
      assert.equal(h.writes.draft("session").text, "");
      const original = { seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession()] }) };
      h.view.applySnapshot(original, true);
      h.writes.update({ type: "snapshot", result: original, instanceChanged: true });
      assert.equal(h.writes.draft("session").text, "原输入\n\n发送期间新草稿");
      assert.equal(h.store.list().records.length, 0);
    } finally { release(); h.close(); }
  });
}

test("桌面设置迟到应答不覆盖新队列事件，模型目录按 nextOffset 保留可用性与档位", async () => {
  let release!: () => void;
  const delayed = new Promise<void>(done => { release = done; });
  let began = false;
  const model = { provider: "mock", modelId: "mock-model", name: "Mock", contextWindow: 200000, maxTokens: 1024, thinkingLevels: ["off" as const, "low" as const], available: true, errorCode: null };
  const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession()] }) }), handlers: { set_session_model: async () => { began = true; await delayed; return desktopSession({ modelSelectionVersion: 2 }); }, list_models: params => ({ models: params.offset === 0 ? [model] : [{ ...model, provider: "unavailable", available: false, errorCode: "model_auth_missing" }], total: 2, nextOffset: params.offset === 0 ? 1 : null }) } });
  try {
    await h.start();
    await h.writes.loadModels();
    assert.deepEqual(h.writes.models.map(model => [model.provider, model.available, model.thinkingLevels]), [["mock", true, ["off", "low"]], ["unavailable", false, ["off", "low"]]]);
    const write = h.writes.setModel(h.view.sessions[0], selection);
    await waitFor("设置等待", () => began);
    const event = { seq: 1, sessionId: "session", taskId: null, createdAt: new Date().toISOString(), body: { type: "session.queue_paused" as const, sessionId: "session", reason: "backend_restart" } };
    h.view.applyEvent(event, "live");
    h.writes.update({ type: "event", event, kind: "live" });
    release(); await write;
    assert.equal(h.view.sessions[0].queueState, "paused");
    assert.equal(h.view.sessions[0].queuePauseReason, "backend_restart");
    assert.equal(h.view.sessions[0].modelSelectionVersion, 2);
  } finally { release(); h.close(); }
});

test("桌面核实查询期间换实例不把旧输入重发到新实例", async () => {
  let release!: () => void;
  const delayed = new Promise<void>(done => { release = done; });
  let queries = 0, sends = 0, instanceId = "inst-1";
  const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ instanceId }) }), handlers: { find_task: async () => { queries++; await delayed; return { task: null }; }, submit: () => { sends++; return desktopTask(); } } }, [pendingRecord({ params: { session_id: "session", input: "旧实例输入", request_id: "original", model_selection: selection } })]);
  try {
    const start = h.start();
    await waitFor("核实等待", () => queries > 0);
    instanceId = "other";
    await h.controller.reconnect();
    release(); await start; await h.controller.submissions!.reconcile();
    assert.equal(sends, 0);
    assert.equal(h.store.read("original").kind, "record");
    assert.equal(h.writes.entries.get("original")?.result?.kind, "foreign_instance");
  } finally { release(); h.close(); }
});

test("桌面队列丢答回读的迟到旧值不能覆盖新暂停或谎报可运行", async () => {
  let release!: () => void;
  const delayed = new Promise<void>(done => { release = done; });
  let began = false;
  const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession({ queueState: "paused" })] }) }), handlers: { resume_queue: () => { throw new ControlClientError("timeout", "丢答", "unknown"); }, get_session: async () => { began = true; await delayed; return desktopSession(); } } });
  try {
    await h.start();
    const operation = h.writes.resume(h.view.sessions[0]);
    await waitFor("队列回读等待", () => began);
    const event = { seq: 1, sessionId: "session", taskId: null, createdAt: new Date().toISOString(), body: { type: "session.queue_paused" as const, sessionId: "session", reason: "backend_restart" } };
    h.view.applyEvent(event, "live"); h.writes.update({ type: "event", event, kind: "live" });
    release(); await operation;
    assert.equal(h.view.sessions[0].queueState, "paused");
    assert.match(h.writes.message!, /仍暂停/);
  } finally { release(); h.close(); }
});

test("桌面明确拒绝后宽容清理失败，之后核实拒绝不会再次合并原输入", async () => {
  let failedOnce = false;
  const h = desktopHarness({ handshake: () => ({ seq: 0, replay: [], snapshot: fakeSnapshot({ sessions: [desktopSession()] }) }), handlers: { submit: () => { if (!failedOnce) { failedOnce = true; fs.chmodSync(h.store.dir, 0o500); } throw new ControlClientError("denied", "拒绝", "rejected"); }, find_task: () => ({ task: null }) } });
  try {
    await h.start();
    h.writes.edit("session", "原输入");
    await h.writes.send("session");
    assert.equal(h.writes.draft("session").text, "原输入");
    assert.equal(h.store.list().records.length, 1);
    fs.chmodSync(h.store.dir, 0o700);
    await h.controller.submissions!.reconcile();
    assert.equal(h.writes.draft("session").text, "原输入");
    assert.equal(h.store.list().records.length, 0);
  } finally { fs.chmodSync(h.store.dir, 0o700); h.close(); }
});

import type { ConfirmationRequestView } from "@ruukoto/core/views.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import { DesktopNotifications, type DesktopNotice } from "../apps/desktop/src/main/notifications.ts";
import { DesktopApprovals } from "../apps/desktop/src/renderer/approvals.ts";
import { FakeTransport } from "./helpers/fake-control.ts";

function approval(overrides: Partial<ConfirmationRequestView> = {}): ConfirmationRequestView {
  return { id: "approval", taskId: "task", sessionId: "session", toolOpId: "op", toolName: "http_request", params: { url: "https://example.com" }, paramsBytes: 29, paramsTruncated: false, scope: { kind: "tool", workspaceOnly: false }, cwdDev: 1, cwdIno: 1, permissionVersion: 1, status: "pending", createdAt: "2026-10-15T00:00:00Z", respondedAt: null, consumedAt: null, reviewStatus: null, reviewDecision: null, reviewReason: null, reviewModel: null, reviewPolicyVersion: null, decisionSource: null, standingPermissionId: null, standingPermissionVersion: null, ...overrides };
}
function noticeEvent(seq: number, body: PersistentEvent["body"], taskId = "task"): PersistentEvent { return { seq, body, taskId, sessionId: "session", createdAt: new Date().toISOString() }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function noticeHarness(query: (target: "code" | "personal", taskId: string) => Promise<import("@ruukoto/control/ops.ts").OpResult<"get_task">> = async () => { throw new Error("查询不可用"); }) {
  const notices: DesktopNotice[] = [];
  let count = 0, focused = false;
  const model = new DesktopNotifications(() => focused, notice => notices.push(notice), value => { count = value; }, query);
  const snapshot = (target: "code" | "personal", tasks: TaskView[], confirmations: ConfirmationRequestView[] = [], instanceId = "inst-1", seq = 100) => model.update(target, { type: "snapshot", result: { seq, replay: [], snapshot: fakeSnapshot({ instanceId, sessions: [desktopSession()], tasks: structuredClone(tasks), confirmations: structuredClone(confirmations) }) }, instanceChanged: false });
  const event = (target: "code" | "personal", event: PersistentEvent, kind: "live" | "replay" = "live") => model.update(target, { type: "event", event, kind });
  return { model, notices, snapshot, event, get count() { return count; }, focus(value: boolean) { focused = value; } };
}
const taskDetail = (task = desktopTask(), confirmations: ConfirmationRequestView[] = [], seq = 100) => ({ task, confirmations, seq, toolOps: [], outputPreview: null, artifacts: [] });

test("桌面通知首照与整个历史补发静默，握手缓冲 live 通知一次，双目标按实例隔离", () => {
  const h = noticeHarness();
  const history = Array.from({ length: 21 }, (_, index) => desktopTask({ id: `old-${index}`, status: "completed" }));
  for (const target of ["code", "personal"] as const) {
    h.snapshot(target, history.slice(0, 20));
    for (let i = 0; i < 21; i++) h.event(target, noticeEvent(i + 1, { type: "task.completed", taskId: `old-${i}`, sessionId: "session" }, `old-${i}`), "replay");
    assert.equal(h.notices.length, target === "code" ? 0 : 1);
    const end = noticeEvent(101, { type: "task.interrupted", taskId: "new", sessionId: "session", reason: "owner_interrupt", cancelRequested: false, effectUnknown: false }, "new");
    h.event(target, end); h.event(target, end);
  }
  assert.deepEqual(h.notices.map(notice => [notice.target, notice.sessionId, notice.taskId]), [["code", "session", "new"], ["personal", "session", "new"]]);
  h.snapshot("code", history, [], "new-instance");
  h.event("code", noticeEvent(90, { type: "task.completed", taskId: "hidden-old", sessionId: "session" }, "hidden-old"), "replay");
  assert.equal(h.notices.length, 2);
});

test("桌面审批按当前集合补通知，快照与补发去重，已处理不通知，角标按两目标汇总", () => {
  const h = noticeHarness();
  for (const target of ["code", "personal"] as const) h.snapshot(target, [desktopTask({ status: "awaiting_confirmation" })], [approval()]);
  assert.equal(h.count, 2); assert.equal(h.notices.length, 0);
  for (const target of ["code", "personal"] as const) {
    const next = approval({ id: "new" });
    h.snapshot(target, [desktopTask({ status: "awaiting_confirmation" })], [next]);
    h.event(target, noticeEvent(90, { type: "task.awaiting_confirmation", taskId: "task", confirmationId: "new", toolOpId: "op", toolName: "http_request", params: {}, scope: next.scope, permissionVersion: 1 }), "replay");
  }
  assert.equal(h.notices.length, 2); assert.equal(h.count, 2);
  h.snapshot("code", [desktopTask({ status: "running" })]);
  h.event("code", noticeEvent(95, { type: "task.awaiting_confirmation", taskId: "task", confirmationId: "already-handled", toolOpId: "op", toolName: "http_request", params: {}, scope: approval().scope }), "replay");
  assert.equal(h.notices.length, 2); assert.equal(h.count, 1);
  h.event("personal", noticeEvent(101, { type: "task.mode_switched", taskId: "task", sessionId: "session", from: "confirm", to: "full_access", permissionVersion: 2 }));
  assert.equal(h.count, 0);
});

test("桌面离线结束补通知，前台更新基线不补发，取消不通知且不再查询", async () => {
  let queries = 0;
  const h = noticeHarness(async () => { queries++; return taskDetail(); });
  h.snapshot("code", [desktopTask()]);
  h.snapshot("code", [desktopTask({ status: "completed" })]);
  h.event("code", noticeEvent(90, { type: "task.completed", taskId: "task", sessionId: "session" }), "replay");
  assert.equal(h.notices.length, 1);
  h.focus(true);
  h.snapshot("personal", [desktopTask()]);
  h.event("personal", noticeEvent(101, { type: "task.mode_switch_failed", taskId: "task", sessionId: "session", to: "full_access", reason: "worker_stop_unverified" }));
  h.focus(false);
  h.snapshot("personal", [desktopTask({ status: "interrupted" })]);
  assert.equal(h.notices.length, 1);
  h.snapshot("code", [desktopTask({ id: "cancel" })]);
  h.event("code", noticeEvent(102, { type: "task.canceled", taskId: "cancel", sessionId: "session" }, "cancel"));
  h.snapshot("code", []); await tick();
  assert.equal(queries, 0); assert.equal(h.notices.length, 1);
});

test("桌面缺补发时查询观察中的任务，失败下次重查，旧代次查询不通知", async () => {
  let reads = 0, fail = true;
  let release!: (value: ReturnType<typeof taskDetail>) => void;
  const h = noticeHarness(async () => { reads++; if (fail) throw new Error("离线"); return new Promise(resolve => { release = resolve; }); });
  h.snapshot("code", [desktopTask()]);
  h.snapshot("code", []); await tick();
  assert.equal(reads, 1); assert.equal(h.notices.length, 0);
  fail = false;
  h.snapshot("code", []); await tick();
  release(taskDetail(desktopTask({ status: "failed" }))); await tick();
  assert.equal(reads, 2); assert.equal(h.notices.length, 1);
  h.snapshot("personal", [desktopTask()]); h.snapshot("personal", []); await tick();
  const oldRelease = release;
  h.snapshot("personal", [], [], "replacement");
  oldRelease(taskDetail(desktopTask({ status: "completed" }))); await tick();
  assert.equal(h.notices.length, 1);
});

function approvalHarness(handlers: import("./helpers/fake-control.ts").FakeHandlers = {}, target: "code" | "personal" = "code") {
  const view = new ViewState();
  const c = approval();
  const transport = new FakeTransport({ handlers: { get_confirmation_params: () => ({ confirmation: c, params: { text: "{}", offset: 0, totalBytes: 2, truncated: false } }), ...handlers } });
  const model = new DesktopApprovals({ request: (actual, op, params) => { assert.equal(actual, target); return ipcResult(() => transport.request(op as DesktopOp, params as import("@ruukoto/control/ops.ts").OpParams<DesktopOp>)); } }, view, () => {}, target);
  const snapshot = (confirmations = [approval()], instanceId = "inst-1") => {
    const update: Extract<DesktopUpdate, { type: "snapshot" }> = { type: "snapshot", result: { seq: 100, replay: [], snapshot: fakeSnapshot({ instanceId, tasks: [desktopTask({ status: "awaiting_confirmation", permissionVersion: confirmations[0]?.permissionVersion ?? 1 })], confirmations }) }, instanceChanged: view.instanceId !== instanceId };
    view.applySnapshot(update.result, update.instanceChanged); model.update(update);
  };
  snapshot();
  return { model, view, transport, snapshot, c };
}

for (const decision of ["approve", "reject"] as const) for (const outcome of ["unknown", "disconnected", "not_sent", "rejected", "query_failed"] as const) {
  test(`桌面${decision} ${outcome} 分类、核实且不自动重发`, async () => {
    const h = approvalHarness({ respond_confirmation: () => { throw new ControlClientError("response_lost", "测试拒绝", outcome === "query_failed" ? "unknown" : outcome); }, get_task: () => { if (outcome === "query_failed") throw new Error("查询失败"); return taskDetail(desktopTask(), [approval({ status: decision === "approve" ? "approved" : "rejected" })]); } });
    await h.model.load(h.c.id); await h.model.respond(h.c, decision);
    assert.equal(h.transport.requests.filter(request => request.op === "respond_confirmation").length, 1);
    assert.deepEqual(h.transport.requests.find(request => request.op === "respond_confirmation")?.params, { confirmation_id: "approval", permission_version: 1, decision });
    assert.match(h.model.message!, outcome === "unknown" ? /已核实/ : outcome === "not_sent" ? /没有发出/ : outcome === "rejected" ? /被拒绝/ : /结果未知/);
    assert.equal(h.view.pendingApprovals().length, outcome === "unknown" ? 0 : 1);
    if (outcome === "disconnected") {
      assert.equal(h.transport.requests.filter(request => request.op === "get_task").length, 0);
      h.snapshot([]); assert.match(h.model.message!, /新快照已核实/);
    }
    if (outcome === "query_failed") { h.snapshot([], "different"); assert.match(h.model.message!, /目标已经变化/); }
  });
}

test("桌面权限冲突刷新展示版本等待重新决定，TUI 抢先处理移除卡片", async () => {
  let version = 1, stale = false;
  const h = approvalHarness({ respond_confirmation: () => { version = 2; throw new ControlClientError(stale ? "stale_confirmation" : "permission_version_mismatch", "版本", "rejected"); }, get_task: () => taskDetail(desktopTask({ status: "awaiting_confirmation", permissionVersion: version }), [approval({ permissionVersion: version })]), get_confirmation_params: () => ({ confirmation: approval({ permissionVersion: version }), params: { text: "{}", offset: 0, totalBytes: 2, truncated: false } }) });
  await h.model.load("approval"); await h.model.respond(h.c, "approve");
  assert.equal(h.view.pendingApprovals()[0].permissionVersion, 2);
  assert.equal(h.model.details.get("approval")?.complete, true);
  assert.equal(h.transport.requests.filter(request => request.op === "respond_confirmation").length, 1);
  stale = true; await h.model.respond(h.view.pendingApprovals()[0], "reject");
  assert.equal(h.view.pendingApprovals().length, 0); assert.match(h.model.message!, /已经失效/);
});

test("桌面审批参数用 UTF-8 返回偏移续读，截断与读取失败可见", async () => {
  const parts = ["中文👩‍💻", "第二页"];
  const size = Buffer.byteLength(parts.join(""));
  let fail = false;
  const h = approvalHarness({ get_confirmation_params: params => { const index = params.offset ? 1 : 0; if (fail && index) throw new Error("断线"); assert.equal(params.offset, index ? Buffer.byteLength(parts[0]) : 0); return { confirmation: approval(), params: { text: parts[index], offset: params.offset!, totalBytes: size, truncated: !index } }; } });
  await h.model.load("approval");
  assert.equal(h.model.details.get("approval")?.text, parts.join("")); assert.equal(h.model.details.get("approval")?.complete, true);
  fail = true; await h.model.load("approval");
  assert.equal(h.model.details.get("approval")?.complete, false); assert.match(h.model.details.get("approval")!.error!, /读取失败/);
});

for (const operation of ["get_task", "get_confirmation_params"] as const) test(`桌面审批快照换代丢弃迟到 ${operation}，相同 ID 不复活`, async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const h = approvalHarness({ respond_confirmation: () => { throw new ControlClientError("timeout", "未知", "unknown"); }, get_task: async () => { started = true; await gate; return taskDetail(desktopTask({ status: "awaiting_confirmation" }), [approval()]); }, get_confirmation_params: async () => { if (operation === "get_confirmation_params") { started = true; await gate; } return { confirmation: approval(), params: { text: "{}", offset: 0, totalBytes: 2, truncated: false } }; } }, "personal");
  const pending = operation === "get_task" ? h.model.load("approval").then(() => h.model.respond(h.c, "approve")) : h.model.load("approval");
  await waitFor("旧查询已发出", () => started);
  h.snapshot([], "other"); release(); await pending;
  assert.equal(h.view.pendingApprovals().length, 0); assert.equal(h.model.details.size, 0);
  assert.equal(h.transport.requests.filter(request => request.op === "respond_confirmation").length, operation === "get_task" ? 1 : 0);
});

test("桌面审批在线核实仍 pending 可人工再决定，新版本必须重新读取参数", async () => {
  let version = 1;
  const h = approvalHarness({ respond_confirmation: () => { throw new ControlClientError("timeout", "未知", "unknown"); }, get_task: () => taskDetail(desktopTask({ status: "awaiting_confirmation", permissionVersion: version }), [approval({ permissionVersion: version })]) });
  await h.model.load("approval"); await h.model.respond(h.c, "approve");
  assert.match(h.model.message!, /结果未知，审批仍待处理/); assert.equal(h.model.decisions.size, 0);
  version = 2; await h.model.respond(h.c, "reject");
  assert.equal(h.view.pendingApprovals()[0].permissionVersion, 2); assert.equal(h.model.details.size, 0);
  await h.model.respond(h.view.pendingApprovals()[0], "approve");
  assert.equal(h.transport.requests.filter(request => request.op === "respond_confirmation").length, 2, "未读新详情不能沿旧参数批准");
});

test("桌面审批核实失败后在线主动刷新解锁，不重发决定", async () => {
  const h = approvalHarness({ respond_confirmation: () => { throw new ControlClientError("timeout", "未知", "unknown"); }, get_task: () => { throw new Error("读取失败"); } });
  await h.model.load("approval"); await h.model.respond(h.c, "approve");
  assert.equal(h.model.decisions.size, 1);
  const transport = h.transport;
  const refreshed = new DesktopApprovals({ request: async (_target, op) => { assert.equal(op, "reconnect"); h.snapshot(); return { ok: true, value: undefined }; } }, h.view, () => {}, "code");
  await refreshed.refresh();
  assert.equal(h.model.decisions.size, 0); assert.match(h.model.message!, /结果未知，审批仍待处理/);
  assert.equal(transport.requests.filter(request => request.op === "respond_confirmation").length, 1);
});

import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";

for (const ending of ["interrupt", "mode_failure"] as const) test(`桌面真实控制面 ${ending} 无解决事件仍移除审批、归零角标并通知`, async () => {
  let stopCalls = 0;
  const t = await startTestRuntime("desktop-approval-end", async () => ({ kind: "tool_calls", calls: [{ id: "gate", name: "mock_gate", arguments: { note: "等待审批" } }] }), { config: { toolFactory: ctx => {
    if (ending === "mode_failure") ctx.registry.register({ kind: "starting", id: "controlled-worker", label: "可控停止", stop: async () => { stopCalls++; return false; } });
    return createMockTools(ctx);
  } } });
  const view = new ViewState();
  const notices: DesktopNotice[] = []; let badge = 0;
  const notifications = new DesktopNotifications(() => false, notice => notices.push(notice), count => { badge = count; }, async (_target, id) => t.runtime.getTaskDetail(id)!);
  const events: PersistentEvent[] = [];
  const connection = new ControlConnection({ socketPath: t.runtime.socketPath(), token: readOwnerToken(t.runtime.controlDir())! }, {
    onState() {}, onSnapshot(result, context) { view.applySnapshot(result, context.instanceChanged); notifications.update("code", { type: "snapshot", result, instanceChanged: context.instanceChanged }); },
    onEvent(event, kind) { events.push(event); view.applyEvent(event, kind); notifications.update("code", { type: "event", event, kind }); },
  });
  try {
    await connection.start();
    const session = await t.runtime.createSession({ projectName: "审批", cwd: t.work[0], confirmTools: ["mock_gate"] });
    const task = await t.client.request<TaskView>("submit", { session_id: session.id, request_id: "approval", input: "审批测试", model_selection: selection });
    await waitFor("共享投影显示待审批", () => view.pendingApprovals().length === 1);
    assert.equal(badge, 1);
    if (ending === "interrupt") await t.client.request("interrupt", { task_id: task.id });
    else await assert.rejects(t.client.request("switch_mode", { task_id: task.id, mode: "full_access" }), { code: "mode_switch_unverified" });
    await waitFor("共享投影移除审批", () => view.getTask(task.id)?.status === "interrupted");
    assert.equal(view.pendingApprovals().length, 0); assert.equal(badge, 0);
    assert.equal(t.runtime.store.listConfirmationsByTask(task.id)[0].status, "stale");
    assert.equal(events.filter(event => event.body.type === "task.confirmation_resolved").length, 0);
    assert.equal(notices.filter(notice => notice.title.includes("中断")).length, 1);
    if (ending === "mode_failure") {
      assert.equal(stopCalls, 1); assert.equal(events.filter(event => event.body.type === "task.interrupted").length, 0);
      assert.equal(events.filter(event => event.body.type === "task.mode_switch_failed").length, 1);
      const failure = events.find(event => event.body.type === "task.mode_switch_failed")!;
      assert.ok(failure.body.type === "task.mode_switch_failed" && notices.at(-1)!.body.includes(failure.body.reason));
      assert.ok(view.getTask(task.id)?.endedAt);
    }
  } finally { connection.close(); await t.shutdown(); }
});


test("Personal IPC 仅新增审批与核实操作，仍拒绝其他业务写入", async () => {
  for (const op of ["get_task", "get_confirmation_params", "respond_confirmation"] as const) {
    const result = await handleRequest("personal", op, { confirmation_id: "approval" }, async () => {}, async name => name);
    assert.deepEqual(result, { ok: true, value: op });
  }
  for (const op of ["submit", "create_session", "set_session_mode"]) {
    const result = await handleRequest("personal", op, {}, async () => {}, unavailable);
    assert.equal(!result.ok && result.error.code, "op_not_allowed");
  }
});

test("系统通知同步异常不打断审批投影与角标，也不在下个事件重复通知", () => {
  let calls = 0, badge = 0;
  const model = new DesktopNotifications(() => false, () => { calls++; throw new Error("OS 拒绝"); }, count => { badge = count; }, async () => taskDetail());
  const snapshot: Extract<DesktopUpdate, { type: "snapshot" }> = { type: "snapshot", instanceChanged: false, result: { seq: 0, replay: [], snapshot: fakeSnapshot({ tasks: [desktopTask({ status: "running" })] }) } };
  model.update("code", snapshot);
  const event = noticeEvent(1, { type: "task.awaiting_confirmation", taskId: "task", confirmationId: "approval", toolOpId: "op", toolName: "mock_gate", params: {}, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: 1 });
  model.update("code", { type: "event", kind: "live", event });
  assert.equal(badge, 1); assert.equal(calls, 1);
  model.update("code", { type: "event", kind: "live", event });
  assert.equal(calls, 1);
});

test("真实快照仅含20个终态，新实例有效旧游标补发21个历史时静默，online前缓冲live通知", async () => {
  const t = await startTestRuntime("desktop-history", async () => ({ kind: "text", text: "ok" }));
  let connection: ControlConnection | undefined;
  try {
    const session = await t.runtime.createSession({ projectName: "历史", cwd: t.work[0] });
    t.runtime.store.withTx(() => {
      for (let i = 0; i < 21; i++) {
        const task = t.runtime.store.insertQueuedTask({ sessionId: session.id, requestId: `history-${i}`, input: "历史", modelSelection: t.runtime.defaultSelection, submissionDigest: `history-${i}` }).task;
        t.runtime.store.transitionTask(task.id, ["queued"], "running");
        t.runtime.store.endTask(task.id, ["running"], "completed");
      }
    });
    const history = await t.client.handshake(1);
    assert.equal(history.snapshot.tasks.length, 20);
    assert.equal(history.replay.filter(event => event.body.type === "task.completed").length, 21);
    const h = noticeHarness(); let handshakes = 0, beforeOnline = false;
    const fake = fakeControl({ handshake: (since, transport) => {
      if (++handshakes === 1) return { seq: 1, replay: [], snapshot: fakeSnapshot({ instanceId: "original" }) };
      assert.equal(since, 1, "旧实例游标在新实例仍可用");
      transport.emit({ ...noticeEvent(history.seq + 1, { type: "task.completed", taskId: "new-live", sessionId: session.id }, "new-live"), sessionId: session.id });
      return history;
    } });
    connection = new ControlConnection({ socketPath: "/fake", token, clientFactory: fake.factory, reconnectInitialMs: 1 }, {
      onState() {}, onSnapshot: (result, ctx) => h.model.update("code", { type: "snapshot", result, instanceChanged: ctx.instanceChanged }), onEvent(event, kind) {
        if (kind === "live") beforeOnline = connection!.state !== "online";
        h.model.update("code", { type: "event", event, kind });
      },
    });
    await connection.start(); fake.transports[0].drop();
    await waitFor("新实例同步完成", () => handshakes === 2 && connection!.state === "online");
    assert.equal(beforeOnline, true);
    assert.deepEqual(h.notices.map(notice => notice.taskId), ["new-live"]);
  } finally { connection?.close(); await t.shutdown(); }
});
