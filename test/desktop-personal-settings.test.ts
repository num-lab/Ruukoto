import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PersonalSettingsController } from "../apps/desktop/src/main/personal-settings-controller.ts";
import { personalPendingFile } from "../apps/desktop/src/main/personal-config.ts";
import { desktopRemoteFixture } from "./helpers/personal-remote-desktop.ts";

const code = (expected: string) => (error: unknown) => error instanceof ControlClientError && error.code === expected;

async function fixture(t: Parameters<typeof desktopRemoteFixture>[0]) {
  const f = await desktopRemoteFixture(t), controller = f.create(); await controller.pair("ABCDEFGHIJKL", "Electron");
  const state = { calls: 0, restores: 0, finishes: 0, dropAfterAdmission: false, rejectBeforeAdmission: false, uncertainCode: "", pending: null as string | null, online: true, receipts: new Map<string, Record<string, unknown>>(), requests: [] as unknown[] };
  const revisions = { model: `sha256:${"1".repeat(64)}`, skills: "missing", mcp: "missing" };
  const request = { v: 1, op: "config.save", target: "model", profile: f.profile, expectedRevision: revisions.model, value: { modelId: "new-model" } };
  const view = () => ({ settings: { product: "ruukoto", profile: f.profile, online: state.online, revisions, blockers: [], model: { config: {}, credential: { state: "available", reference: "TEST_API_KEY" } }, skills: null, mcp: null, lifecycle: { managedDevelopment: false } }, maintenance: { profile: f.profile, online: state.online, writable: true, code: "maintenance_ready", reason: "已核实原服务", lifecycle: { kind: "systemd", state: state.online ? "running" : "stopped", managedDevelopment: false, originalEnvironment: "unverified" } }, pending: state.pending ? state.receipts.get(state.pending) : null });
  f.overrides.set("/management", (_req, res) => { f.respond(res, view()); });
  f.overrides.set("/settings", (_req, res, value) => { state.requests.push(value); f.respond(res, (value as { op: string }).op === "settings.read" ? view().settings : { profile: f.profile, tested: true }); });
  f.overrides.set("/maintenance", (req, res, value) => {
    if (req.method === "GET") { f.respond(res, state.receipts.get(new URL(req.url!, f.origin).searchParams.get("id")!) ?? null); return; }
    state.calls++;
    const input = value as { id: string; request: typeof request };
    const local = JSON.parse(fs.readFileSync(personalPendingFile(f.directory, controller.config), "utf8")); assert.equal(local.maintenance.id, input.id);
    if (state.rejectBeforeAdmission) { f.reject(res, "settings_revision_changed", 400); return; }
    state.receipts.set(input.id, { v: 1, id: input.id, profile: f.profile, op: input.request.op, target: "model", expectedRevision: revisions.model, requestDigest: local.maintenance.requestDigest, stage: "stopping", saveAttempted: false, saved: false, started: false }); state.pending = input.id;
    if (state.dropAfterAdmission) { req.socket.destroy(); return; }
    if (state.uncertainCode) { f.reject(res, state.uncertainCode, 409); return; }
    f.respond(res, state.receipts.get(input.id), 202);
  });
  for (const action of ["restore", "finish"] as const) f.overrides.set(`/maintenance/${action}`, (_req, res, value) => {
    const { id } = value as { id: string }; if (action === "restore") state.restores++; else state.finishes++;
    const receipt = state.receipts.get(id)!; Object.assign(receipt, { stage: "complete", saved: action === "restore" ? true : receipt.saved, started: true }); state.pending = null; state.online = true; f.respond(res, receipt);
  });
  return { ...f, controller, settings: new PersonalSettingsController(controller, f.directory), state, request, view, complete: () => { const receipt = state.receipts.get(state.pending!)!; Object.assign(receipt, { stage: "complete", saveAttempted: true, saved: true, savedRevision: revisions.model, started: true }); state.pending = null; } };
}

test("PA设置：三类设置沿已核实的同一HTTPS连接读取与测试，档案变化拒绝", async t => {
  const f = await fixture(t), view = await f.settings.read();
  assert.equal(view.settings.profile.id, f.profile.id); assert.equal(view.maintenance.writable, true);
  const tested = await f.settings.request({ v: 1, op: "model.test", profile: f.profile, expectedRevision: f.request.expectedRevision, value: {} }); assert.equal(tested.tested, true);
  await assert.rejects(f.settings.request({ v: 1, op: "model.test", profile: { ...f.profile, id: `sha256:${"b".repeat(64)}` } }), code("settings_profile_changed"));
  await assert.rejects(f.settings.request({ v: 1, op: "config.save" }), code("op_not_allowed"));
  assert.equal(f.state.calls, 0);
});

test("PA维护：接纳202后只读原回执，完整阶段归服务器；完成后允许下一项", async t => {
  const f = await fixture(t), view = await f.settings.apply(f.request);
  assert.equal(view.pending?.stage, "stopping"); assert.equal(f.state.calls, 1); assert.equal(!!f.controller.maintenance(), true);
  await assert.rejects(f.settings.apply(f.request), code("maintenance_pending")); assert.equal(f.state.calls, 1);
  f.complete(); const complete = await f.settings.read(); assert.equal(complete.pending, null); assert.equal(complete.saved, true); assert.equal(!!f.controller.maintenance(), false);
  await f.settings.apply(f.request); assert.equal(f.state.calls, 2);
  const ids = [...f.state.receipts.keys()]; assert.notEqual(ids[0], ids[1]);
});

test("PA维护丢答：原关联落盘，重开查原键且不重存，已保存启动失败可显式恢复", async t => {
  const f = await fixture(t); f.state.dropAfterAdmission = true;
  await assert.rejects(f.settings.apply(f.request), code("personal_connection_lost"));
  const pending = f.controller.maintenance()!; assert.ok(pending.id); assert.equal(f.state.calls, 1);
  const old = f.state.receipts.get(pending.id)!; Object.assign(old, { stage: "saved", saved: true, saveAttempted: true, savedRevision: f.request.expectedRevision, started: false }); f.state.online = false;
  const reopened = new PersonalSettingsController(f.controller, f.directory), view = await reopened.read(); assert.equal(view.saved, true); assert.equal(view.pending?.id, pending.id);
  const restored = await reopened.restore(); assert.equal(restored.pending, null); assert.equal(f.state.restores, 1); assert.equal(f.state.calls, 1);
});

test("PA维护：明确拒绝不留假接纳，未知结果不自动换键；人工结束需先读取", async t => {
  const f = await fixture(t); f.state.rejectBeforeAdmission = true;
  await assert.rejects(f.settings.apply(f.request), code("settings_revision_changed")); assert.equal(f.controller.maintenance(), undefined);
  f.state.rejectBeforeAdmission = false; await f.settings.apply(f.request);
  const unopened = new PersonalSettingsController(f.controller, f.directory); await assert.rejects(unopened.finish(), code("maintenance_unverified"));
  await unopened.read(); await unopened.finish(); assert.equal(f.state.finishes, 1); assert.equal(f.controller.maintenance(), undefined);
});

test("旧桌面维护：原损坏记录阻止新写维护，查询和原文件均保留", async t => {
  const f = await fixture(t), directory = path.join(f.directory, "pending", "personal-settings"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const old = path.join(directory, "original.json"); fs.writeFileSync(old, "broken old journal", { mode: 0o600 });
  await f.settings.read(); await assert.rejects(f.settings.apply(f.request), code("legacy_maintenance_pending"));
  assert.equal(f.state.calls, 0); assert.equal(fs.readFileSync(old, "utf8"), "broken old journal");
});


test("409不能证明未执行：应答超限或服务器未知失败保留原维护键，不再次保存", async t => {
  for (const failure of ["remote_response_large", "remote_unavailable"]) {
    const f = await fixture(t); f.state.uncertainCode = failure;
    await assert.rejects(f.settings.apply(f.request), (error: unknown) => error instanceof ControlClientError && error.code === failure && error.outcome === "unknown");
    const original = f.controller.maintenance()!; assert.ok(original.id); assert.equal(f.state.calls, 1);
    f.state.uncertainCode = ""; const view = await f.settings.read(); assert.equal(view.pending?.id, original.id);
    await assert.rejects(f.settings.apply(f.request), code("maintenance_pending")); assert.equal(f.state.calls, 1);
  }
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
    await assert.rejects(f.settings.request({ v: 1, op: "settings.read" }), code("management_busy"));
    await assert.rejects(f.settings.apply(f.request), code("management_busy"));
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
