import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PersonalSettingsController } from "../apps/desktop/src/main/personal-settings-controller.ts";
import { personalPendingFile } from "../apps/desktop/src/main/personal-config.ts";
import { desktopRemoteFixture } from "./helpers/personal-remote-desktop.ts";

const code = (expected: string) => (error: unknown) => error instanceof ControlClientError && error.code === expected;
async function fixture(t: Parameters<typeof desktopRemoteFixture>[0]) {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("ABCDEFGHIJKL", "Electron");
  const state = { calls: 0, restores: 0, dropAfterAdmission: false, rejectBeforeAdmission: false, uncertainCode: "", pending: null as string | null, online: true, protocol: 2, receipts: new Map<string, Record<string, unknown>>() };
  const revisions = { model: "sha256:" + "1".repeat(64), skills: "missing", mcp: "missing" };
  const request = { v: 1, op: "config.save", target: "model", profile: f.profile, expectedRevision: revisions.model, value: { modelId: "new-model" } };
  const view = () => ({ settings: { product: "ruukoto", settingsProtocol: state.protocol, profile: f.profile, online: state.online, revisions, operations: [...state.receipts.values()].filter(item => item.v === 2), blockers: [], model: { config: {}, credential: { state: "missing", reference: "TEST_API_KEY" } }, skills: null, mcp: null, lifecycle: { managedDevelopment: true } }, maintenance: { profile: f.profile, online: state.online, writable: false, code: "settings_ready", reason: "配置可保存", lifecycle: { kind: "cli", state: state.online ? "running" : "stopped", managedDevelopment: true, originalEnvironment: "unverified" } }, pending: state.pending ? state.receipts.get(state.pending) : null });
  f.overrides.set("/management", (_req, res) => { f.respond(res, view()); });
  f.overrides.set("/settings", (_req, res, value) => { f.respond(res, (value as { op: string }).op === "settings.read" ? view().settings : { profile: f.profile, tested: true }); });
  f.overrides.set("/maintenance", (req, res, value) => {
    if (req.method === "GET") { f.respond(res, state.receipts.get(new URL(req.url!, f.origin).searchParams.get("id")!) ?? null); return; }
    state.calls++;
    const input = value as { v: number; id: string; request: { id: string; v: number; op: { kind: string; target: string } } };
    assert.equal(input.v, 2); assert.equal(input.request.v, 2); assert.equal(input.id, input.request.id);
    const local = JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8"));
    const association = local.settings.find((item: { id: string }) => item.id === input.id); assert.ok(association);
    if (state.rejectBeforeAdmission) { f.reject(res, "settings_revision_changed", 400); return; }
    if ([...state.receipts.values()].some(item => item.v === 2 && item.target === input.request.op.target && item.status === "waiting")) { f.reject(res, "settings_target_pending", 409); return; }
    const receipt = { v: 2, id: input.id, profile: f.profile, target: input.request.op.target, scope: "*", requestDigest: association.requestDigest, status: "waiting", savedRevision: revisions.model, effectiveRevision: null, code: "settings_waiting", relatedOperations: [] };
    state.receipts.set(input.id, receipt);
    if (state.dropAfterAdmission) { req.socket.destroy(); return; }
    if (state.uncertainCode) { f.reject(res, state.uncertainCode, 409); return; }
    f.respond(res, receipt, 202);
  });
  f.overrides.set("/maintenance/restore", (_req, res, value) => {
    state.restores++; const id = (value as { id: string }).id, receipt = state.receipts.get(id)!;
    Object.assign(receipt, { stage: "complete", saved: true, saveAttempted: true, savedRevision: revisions.model, started: true }); state.pending = null; f.respond(res, receipt);
  });
  return { ...f, controller, settings: new PersonalSettingsController(controller, f.directory), state, request, view, complete: () => { for (const receipt of state.receipts.values()) if (receipt.v === 2) Object.assign(receipt, { status: "active", effectiveRevision: receipt.savedRevision }); } };
}

test("PA设置：认证读取与测试保留档案身份，写入只经v2保存入口", async t => {
  const f = await fixture(t), view = await f.settings.read(); assert.equal(view.settings.profile.id, f.profile.id);
  assert.equal((await f.settings.request({ v: 1, op: "model.test", profile: f.profile, expectedRevision: f.request.expectedRevision, value: {} })).tested, true);
  await assert.rejects(f.settings.request({ v: 1, op: "model.test", profile: { ...f.profile, id: "sha256:" + "b".repeat(64) } }), code("settings_profile_changed"));
  await assert.rejects(f.settings.request({ v: 1, op: "config.save" }), code("op_not_allowed"));
  assert.equal(f.state.calls, 0);
});

test("PA MCP 调用管理按原身份读取与收尾，不进入配置保存账本，旧恢复动作零请求", async t => {
  const f = await fixture(t), operation = { operation: 12, service: "服务", tool: "write", effect: "effect_unknown", code: "timeout", canEnd: true, ended: false };
  let requests = 0;
  f.overrides.set("/settings", (_req, res, value) => {
    requests++;
    const request = value as { op: string; operation?: number };
    f.respond(res, { profile: f.profile, ...(request.op === "mcp.operations" ? { operations: [operation] } : request.op === "mcp.operation" ? { summary: operation, text: "original" } : { operation: request.operation, ended: true }) });
  });
  const envelope = { v: 1, profile: f.profile, expectedRevision: "missing" };
  assert.deepEqual((await f.settings.request({ ...envelope, op: "mcp.operations" })).operations, [operation]);
  assert.equal((await f.settings.request({ ...envelope, op: "mcp.operation", operation: 12 })).text, "original");
  assert.equal((await f.settings.request({ ...envelope, op: "mcp.end", operation: 12 })).ended, true);
  assert.equal(f.state.calls, 0); assert.deepEqual(f.controller.settingsOperations(), []);
  const before = requests;
  await assert.rejects(f.settings.request({ ...envelope, op: "mcp.cua-control", action: "begin", operation: 12 }), code("op_not_allowed"));
  await assert.rejects(f.settings.request({ ...envelope, op: "mcp.recheck", operation: 12 }), code("op_not_allowed"));
  assert.equal(requests, before);
  f.overrides.set("/settings", (_req, res) => { f.respond(res, { profile: f.profile, operation: 13, ended: true }); });
  await assert.rejects(f.settings.request({ ...envelope, op: "mcp.end", operation: 12 }), code("personal_protocol"));
  f.overrides.set("/settings", (_req, res) => { f.reject(res, "mcp_end_invalid", 400); });
  await assert.rejects(f.settings.request({ ...envelope, op: "mcp.end", operation: 12 }), error => error instanceof ControlClientError && error.code === "mcp_end_invalid" && error.outcome === "rejected");
});

test("PA设置：收齐回执和scope生效分页，后页未结操作保持可查询", async t => {
  const f = await fixture(t);
  const receipts = Array.from({ length: 34 }, (_, index) => ({ v: 2, id: randomUUID(), profile: f.profile, target: "mcp", scope: `service-${index}`, requestDigest: "a".repeat(64), status: index === 33 ? "waiting" : "active", savedRevision: f.request.expectedRevision, effectiveRevision: null, code: "settings_waiting", relatedOperations: [] }));
  const effective = receipts.map(item => ({ target: "mcp", scope: item.scope, version: item.id, revision: f.request.expectedRevision }));
  f.overrides.set("/management", (_req, res) => { const view = f.view(); Object.assign(view.settings, { operations: receipts.slice(0, 32), operationsNextOffset: 32, effective: effective.slice(0, 32), effectiveNextOffset: 32 }); f.respond(res, view); });
  f.overrides.set("/settings", (_req, res, value) => { const request = value as { operationsOffset?: number; effectiveOffset?: number }; f.respond(res, { profile: f.profile, operations: request.operationsOffset === 32 ? receipts.slice(32) : receipts.slice(0, 32), effective: request.effectiveOffset === 32 ? effective.slice(32) : effective.slice(0, 32) }); });
  const view = await f.settings.read();
  assert.deepEqual(view.operations?.map(item => item.id), receipts.map(item => item.id));
  assert.deepEqual(view.settings.effective, effective); assert.equal(view.operations?.at(-1)?.status, "waiting");
  assert.equal(view.settings.operationsNextOffset, undefined); assert.equal(view.settings.effectiveNextOffset, undefined);
});

test("PA保存：无systemd、开发后台和缺模型凭据可保存，等待仅阻止同对象", async t => {
  const f = await fixture(t), view = await f.settings.apply(f.request);
  assert.equal(view.operation?.status, "waiting"); assert.equal(view.saved, true); assert.equal(view.pending, null); assert.equal(f.controller.maintenance(), undefined);
  await assert.rejects(f.settings.apply(f.request), code("settings_target_pending"));
  const other = await f.settings.apply({ ...f.request, target: "skills" }); assert.equal(other.operation?.target, "skills");
  f.complete(); await f.settings.apply(f.request); assert.equal(f.state.calls, 4);
});

test("PA保存丢答：原关联先落盘，重开只查询原键，不重复保存", async t => {
  const f = await fixture(t); f.state.dropAfterAdmission = true;
  await assert.rejects(f.settings.apply(f.request), code("personal_connection_lost"));
  const pending = f.controller.settingsOperations()[0]; assert.ok(pending); assert.equal(f.state.calls, 1);
  const reopened = new PersonalSettingsController(f.controller, f.directory), view = await reopened.read();
  assert.equal(view.operations?.find(item => item.id === pending.id)?.status, "waiting");
  assert.equal(f.controller.settingsOperations().length, 0); assert.equal(f.state.calls, 1);
  const result = await reopened.operation(pending.id); assert.equal(result.saved, true); assert.equal(f.state.calls, 1);
});

test("PA保存：明确拒绝清除本机接纳关联，未知409保留原键直到查询", async t => {
  const f = await fixture(t); f.state.rejectBeforeAdmission = true;
  await assert.rejects(f.settings.apply(f.request), code("settings_revision_changed")); assert.equal(f.controller.settingsOperations().length, 0);
  f.state.rejectBeforeAdmission = false; f.state.uncertainCode = "remote_response_large";
  await assert.rejects(f.settings.apply(f.request), (error: unknown) => error instanceof ControlClientError && error.outcome === "unknown");
  const original = f.controller.settingsOperations()[0]; assert.ok(original);
  const calls = f.state.calls; await f.settings.read(); assert.equal(f.state.calls, calls); assert.equal(f.controller.settingsOperations().length, 0);
});

test("旧停存启回执：读取与显式恢复保留原解释，不执行新保存", async t => {
  const f = await fixture(t), id = randomUUID();
  f.state.receipts.set(id, { v: 1, id, profile: f.profile, op: "config.save", target: "model", expectedRevision: f.request.expectedRevision, requestDigest: "1".repeat(64), stage: "saved", saveAttempted: true, saved: true, savedRevision: f.request.expectedRevision, started: false });
  f.state.pending = id; f.controller.recordMaintenance({ id, requestDigest: "1".repeat(64) });
  const view = await f.settings.read(); assert.equal(view.pending?.stage, "saved"); assert.equal(view.saved, true);
  await assert.rejects(f.settings.apply(f.request), code("legacy_maintenance_pending"));
  assert.equal((await f.settings.restore()).pending, null); assert.equal(f.state.restores, 1); assert.equal(f.state.calls, 0);
});

test("旧后台与旧桌面损坏维护：新写入明确拒绝，原记录保留", async t => {
  const f = await fixture(t); f.state.protocol = 1;
  await assert.rejects(f.settings.apply(f.request), code("settings_upgrade_required")); assert.equal(f.state.calls, 0);
  const directory = path.join(f.directory, "pending", "personal-settings"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const old = path.join(directory, "original.json"); fs.writeFileSync(old, "broken old journal", { mode: 0o600 });
  await assert.rejects(f.settings.apply(f.request), code("legacy_maintenance_pending")); assert.equal(fs.readFileSync(old, "utf8"), "broken old journal");
});

test("PA切页读取：旧页尚未卸载时共享原档案读取，完成与失败后均可重新读取", async t => {
  const f = await fixture(t);
  let reads = 0, fail = false;
  let release!: () => void, entered!: () => void;
  let gate = Promise.resolve();
  f.overrides.set("/management", async (_req, res) => {
    reads++; entered?.(); await gate;
    if (fail) f.reject(res, "remote_unavailable", 409);
    else f.respond(res, f.view());
  });
  for (const rejected of [false, true]) {
    fail = rejected;
    gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = f.settings.read(); await started;
    const second = f.settings.read();
    const results = Promise.allSettled([first, second]);
    const independent = await f.settings.request({ v: 1, op: "settings.read" });
    assert.deepEqual(independent.profile, f.profile);
    release();
    const settled = await results;
    assert.equal(settled[0].status, rejected ? "rejected" : "fulfilled");
    assert.equal(settled[1].status, settled[0].status, "切页不能把相同读取误判为另一项在途操作");
    if (rejected) for (const result of settled) assert.ok(result.status === "rejected" && code("remote_unavailable")(result.reason));
    assert.equal(reads, rejected ? 2 : 1, "同一轮只发送一次档案读取");
  }
  fail = false; await f.settings.read(); assert.equal(reads, 3);
  await f.settings.close();
  await assert.rejects(f.settings.read(), code("management_closed"));
  assert.equal(reads, 3);
});

test("PA读取关闭：在途读取不使关闭后的新读取绕过生命周期检查", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.overrides.set("/management", async (_req, res) => { entered(); await gate; f.respond(res, f.view()); });
  const original = f.settings.read(); await started;
  await f.settings.close(); await assert.rejects(f.settings.read(), code("management_closed"));
  release(); await original;
});
