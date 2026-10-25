import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalRemoteMaintenance } from "../apps/ruukoto/src/personal-remote-maintenance.ts";
import type { PersonalSettingsWriteRequest } from "../apps/ruukoto/src/personal-settings-operations.ts";
import type { PersonalSettingsReceipt } from "../apps/ruukoto/src/personal-settings-records.ts";

const profile = { directory: "/tmp/remote-test-profile", id: "sha256:" + "1".repeat(64) };
const revision = "sha256:" + "2".repeat(64);
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync("/tmp/remote-maintenance-"); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: string[] = [], receipts = new Map<string, PersonalSettingsReceipt>();
  let online = false;
  const dependencies = {
    async settings(value: { op: string }) { calls.push(value.op); return { product: "ruukoto", settingsProtocol: 2, profile, online, revisions: { model: revision, skills: "missing", mcp: "missing" }, blockers: [], lifecycle: { managedDevelopment: true }, model: { credential: { state: "missing" } } }; },
    async configuration(value: PersonalSettingsWriteRequest): Promise<PersonalSettingsReceipt | null> {
      if (!("op" in value)) return receipts.get(value.id) ?? null;
      const previous = receipts.get(value.id); if (previous) return previous;
      calls.push("save:" + value.id);
      const receipt: PersonalSettingsReceipt = { v: 2, id: value.id, profile, target: "model", scope: "*", requestDigest: "3".repeat(64), status: "saved", savedRevision: revision, effectiveRevision: null, code: "settings_saved_offline", relatedOperations: [] };
      receipts.set(value.id, receipt); return receipt;
    },
    async maintenance(op: "inspect" | "stop" | "start") { calls.push(op); if (op === "stop") online = false; if (op === "start") online = true; return { profile, online, writable: true, code: "maintenance_ready", reason: "原服务", lifecycle: { kind: "systemd" as const, state: online ? "running" as const : "stopped" as const, managedDevelopment: false, originalEnvironment: "unverified" as const } }; },
  };
  return { directory, calls, receipts, dependencies, request: (id = randomUUID()) => ({ v: 2 as const, id, profile, expectedRevision: revision, op: { kind: "config.save" as const, target: "model" as const, value: { modelId: "fixture" } } }) };
}

test("remote配置：离线与缺模型key保存不启停，接纳关联重开后投影原后台回执", async t => {
  const f = fixture(t), maintenance = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), request = f.request();
  const receipt = await maintenance.admitSettings(request.id, request, () => {});
  assert.equal(receipt.status, "saved"); assert.equal((await maintenance.view()).maintenance.writable, true);
  assert.deepEqual(await maintenance.admitSettings(request.id, request, () => {}), receipt);
  await assert.rejects(maintenance.admitSettings(request.id, { ...request, expectedRevision: "missing" }, () => {}), { code: "remote_request_conflict" });
  assert.equal(f.calls.filter(call => call.startsWith("save:")).length, 1); assert.equal(f.calls.some(call => ["stop", "start", "inspect"].includes(call)), false);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.directory, "maintenance.json"), "utf8"));
  assert.equal(ledger.v, 2); assert.deepEqual(Object.keys(ledger.settings[request.id]).sort(), ["profile", "requestDigest"]); assert.equal(JSON.stringify(ledger).includes("modelId"), false);
  await maintenance.close();
  const reopened = new PersonalRemoteMaintenance(f.directory, profile, { dependencies: f.dependencies });
  assert.deepEqual(await reopened.querySettings(request.id), receipt); await reopened.close();
});

test("remote配置：接纳前撤销凭据不落关联，不调用后台保存", async t => {
  const f = fixture(t), maintenance = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), request = f.request();
  await assert.rejects(maintenance.admitSettings(request.id, request, () => { throw new PersonalError("remote_credential_revoked", "已撤销"); }), { code: "remote_credential_revoked" });
  assert.equal(await maintenance.querySettings(request.id), null); assert.deepEqual(f.calls, ["settings.read"]); await maintenance.close();
});

test("remote配置：本机创建的原操作可查询，remote不另建接纳事实", async t => {
  const f = fixture(t), maintenance = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), request = f.request();
  const original = await f.dependencies.configuration(request), before = fs.readFileSync(path.join(f.directory, "maintenance.json"));
  assert.deepEqual(await maintenance.querySettings(request.id), original);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, "maintenance.json")), before);
  assert.equal(f.calls.filter(call => call.startsWith("save:")).length, 1);
  await maintenance.close();
});

test("旧维护：保存未启动回执可显式恢复，新v1写要求升级且不重存", async t => {
  const f = fixture(t), maintenance = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }); await maintenance.close();
  const id = randomUUID(), receipt = { v: 1, id, profile, op: "config.save", target: "model", expectedRevision: revision, requestDigest: "4".repeat(64), stage: "saved", saveAttempted: true, saved: true, savedRevision: revision, started: false };
  fs.writeFileSync(path.join(f.directory, "maintenance.json"), JSON.stringify({ v: 1, pending: id, receipts: { [id]: receipt } }), { mode: 0o600 });
  const reopened = new PersonalRemoteMaintenance(f.directory, profile, { dependencies: f.dependencies });
  assert.deepEqual(reopened.query(id), receipt);
  await assert.rejects(reopened.admit(randomUUID(), { v: 1, op: "config.save", profile, target: "model", expectedRevision: revision, value: {} }, () => {}), { code: "settings_upgrade_required" });
  const request = f.request(); await assert.rejects(reopened.admitSettings(request.id, request, () => {}), { code: "remote_maintenance_pending" });
  assert.equal((await reopened.restore(id, () => {})).stage, "complete"); assert.equal(f.calls.filter(call => call === "start").length, 1); assert.equal(f.calls.some(call => call.startsWith("save:")), false); await reopened.close();
});

test("remote记录：缺失、损坏、旧未决关联断链及新接纳关联非法都拒绝", t => {
  const f = fixture(t);
  assert.throws(() => new PersonalRemoteMaintenance(f.directory, profile, { dependencies: f.dependencies }), { code: "remote_maintenance_invalid" });
  for (const value of ["{", JSON.stringify({ v: 1, pending: randomUUID(), receipts: {} }), JSON.stringify({ v: 2, pending: null, receipts: {}, settings: { invalid: { profile, requestDigest: "bad" } } })]) {
    fs.writeFileSync(path.join(f.directory, "maintenance.json"), value, { mode: 0o600 });
    assert.throws(() => new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), { code: "remote_maintenance_invalid" });
    assert.equal(fs.readFileSync(path.join(f.directory, "maintenance.json"), "utf8"), value);
  }
});
