import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalRemoteMaintenance } from "../apps/ruukoto/src/personal-remote-maintenance.ts";

const profile = { directory: "/tmp/remote-test-profile", id: `sha256:${"1".repeat(64)}` };
const revision = (number: number) => `sha256:${String(number).repeat(64)}`;
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remote-maintenance-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  let online = true, current = revision(1), saved = 1, rejectStart = false;
  const dependencies = {
    async settings(value: { op: string }) {
      calls.push(value.op);
      if (value.op === "config.preflight") return { blockers: [], credential: { state: "available" } };
      if (value.op === "config.save") { current = revision(++saved); return { saved: true, revision: current }; }
      return { product: "ruukoto", profile, online, revisions: { model: current, skills: "missing", mcp: "missing" }, blockers: [], lifecycle: { managedDevelopment: false }, model: { credential: { state: online ? "available" : "unverified" } } };
    },
    async maintenance(op: "inspect" | "stop" | "start") {
      calls.push(op);
      if (op === "stop") online = false;
      if (op === "start") {
        if (rejectStart) throw new PersonalError("maintenance_start_unverified", "测试启动失败。");
        online = true;
      }
      return { profile, online, writable: true, code: "maintenance_ready", reason: "测试服务", lifecycle: { kind: "systemd" as const, state: online ? "running" as const : "stopped" as const, managedDevelopment: false, originalEnvironment: "unverified" as const } };
    },
  };
  return { directory, calls, dependencies, failStart: () => { rejectStart = true; }, allowStart: () => { rejectStart = false; }, request: () => ({ v: 1, op: "config.save", profile, target: "model", expectedRevision: current, value: { modelId: "fixture" } }) };
}
async function settle(maintenance: PersonalRemoteMaintenance, id: string) {
  for (let i = 0; i < 100; i++) {
    const receipt = maintenance.query(id)!;
    if (receipt.stage === "complete" || receipt.code) return receipt;
    await delay(5);
  }
  assert.fail("维护没有在测试预算内完成");
}

test("remote维护：A完成、B完成后迟到A只返回原回执，同键异参拒绝", async t => {
  const f = fixture(t), maintenance = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies });
  const first = randomUUID(), firstRequest = f.request();
  await maintenance.admit(first, firstRequest, () => {});
  const firstReceipt = await settle(maintenance, first);
  assert.equal(firstReceipt.saved, true);
  assert.equal(firstReceipt.stage, "complete");
  const second = randomUUID();
  await maintenance.admit(second, f.request(), () => {});
  await settle(maintenance, second);
  assert.deepEqual(await maintenance.admit(first, firstRequest, () => {}), firstReceipt);
  await assert.rejects(maintenance.admit(first, { ...firstRequest, value: { modelId: "different" } }, () => {}), { code: "remote_request_conflict" });
  assert.equal(f.calls.filter(call => call === "config.save").length, 2);
  await maintenance.close();
});

test("remote维护：保存后启动失败保留原记录，重开只核实并显式恢复，不重存", async t => {
  const f = fixture(t), original = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), id = randomUUID();
  f.failStart();
  await original.admit(id, f.request(), () => {});
  const saved = await settle(original, id);
  assert.equal(saved.saved, true);
  assert.equal(saved.code, "maintenance_start_unverified");
  await original.close();
  const restarted = new PersonalRemoteMaintenance(f.directory, profile, { dependencies: f.dependencies });
  assert.deepEqual(restarted.query(id), saved);
  await assert.rejects(restarted.admit(randomUUID(), f.request(), () => {}), { code: "remote_maintenance_pending" });
  f.allowStart();
  const restored = await restarted.restore(id, () => {});
  assert.equal(restored.stage, "complete");
  assert.equal(restored.started, true);
  assert.equal(f.calls.filter(call => call === "config.save").length, 1);
  await restarted.close();
});

test("remote维护：准入前凭据撤销不落操作意图且不停原服务", async t => {
  const f = fixture(t), maintenance = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), id = randomUUID();
  await assert.rejects(maintenance.admit(id, f.request(), () => { throw new PersonalError("remote_credential_revoked", "测试撤销。"); }), { code: "remote_credential_revoked" });
  assert.equal(maintenance.query(id), null);
  assert.equal(f.calls.includes("stop"), false);
  assert.equal(f.calls.includes("config.save"), false);
  await maintenance.close();
});

test("remote维护：运行时缺失或损坏的账本拒绝启动", t => {
  const f = fixture(t);
  assert.throws(() => new PersonalRemoteMaintenance(f.directory, profile, { dependencies: f.dependencies }), { code: "remote_maintenance_invalid" });
  fs.writeFileSync(path.join(f.directory, "maintenance.json"), "{", { mode: 0o600 });
  assert.throws(() => new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), { code: "remote_maintenance_invalid" });
  assert.equal(fs.readFileSync(path.join(f.directory, "maintenance.json"), "utf8"), "{");
});

test("remote维护：未完成回执缺少唯一未决关联时拒绝新写入", async t => {
  const f = fixture(t), maintenance = new PersonalRemoteMaintenance(f.directory, profile, { initialize: true, dependencies: f.dependencies }), id = randomUUID();
  f.failStart();
  await maintenance.admit(id, f.request(), () => {});
  await settle(maintenance, id);
  await maintenance.close();
  const filename = path.join(f.directory, "maintenance.json");
  const ledger = JSON.parse(fs.readFileSync(filename, "utf8"));
  ledger.pending = null;
  fs.writeFileSync(filename, JSON.stringify(ledger), { mode: 0o600 });
  const writes = f.calls.filter(call => call === "config.save").length;
  assert.throws(() => new PersonalRemoteMaintenance(f.directory, profile, { dependencies: f.dependencies }), { code: "remote_maintenance_invalid" });
  assert.equal(f.calls.filter(call => call === "config.save").length, writes);
  ledger.pending = id;
  ledger.receipts[id] = { ...ledger.receipts[id], stage: "saved", saveAttempted: false, saved: true, savedRevision: undefined };
  fs.writeFileSync(filename, JSON.stringify(ledger), { mode: 0o600 });
  assert.throws(() => new PersonalRemoteMaintenance(f.directory, profile, { dependencies: f.dependencies }), { code: "remote_maintenance_invalid" });
});
