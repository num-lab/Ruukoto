/** 仍在使用的服务 helper 协议；用受控替身验证，不触达 systemd 或提权。 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { callHelper, expectRevisions, opUnitFor, requireOk, ServiceHelperError, type ServiceManagerConfig } from "../apps/ruukoto/src/service-helper.ts";

const UNIT = "ruukoto-service-test.service";
const ALIAS_UNIT = "alias-test.service";
const opId = () => `op_${randomBytes(12).toString("hex")}`;

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-service-helper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const helperPath = path.join(directory, "helper.mjs"), policyPath = path.join(directory, "services.json");
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), helperPath);
  fs.mkdirSync(path.join(directory, "units"));
  fs.mkdirSync(path.join(directory, "ops"));
  fs.writeFileSync(policyPath, JSON.stringify({ machineId: "fake-machine-0001", inspectUid: 1, inspectGid: 1, services: { [UNIT]: { actions: ["restart"] }, [ALIAS_UNIT]: { actions: ["restart"] } } }));
  for (const unit of [UNIT, ALIAS_UNIT]) fs.writeFileSync(path.join(directory, "units", unit), "[Service]\nExecStart=/usr/bin/true\n");
  const state = { loadState: "loaded", activeState: "active", subState: "running", mainPid: 1234, result: "success", activeEnterTimestamp: "2026-10-03T00:00:00Z", starts: 1, invocationId: "inv-initial-1" };
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ [UNIT]: state, [ALIAS_UNIT]: { ...state, aliasOf: UNIT } }));
  const config: ServiceManagerConfig = { helperPath, policyPath, useSudo: false, sudoPath: "/usr/bin/sudo" };
  const invoke = (args: string[]) => callHelper(config, args, { timeoutMs: 5000 });
  return {
    directory, config, invoke,
    touch: (name: string, value = "") => fs.writeFileSync(path.join(directory, name), value),
    starts: () => (JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")) as Record<string, { starts: number }>)[UNIT].starts,
    revisions: async () => expectRevisions(requireOk((await invoke(["inspect", UNIT])).reply, "inspect")),
  };
}

function refused(reply: Awaited<ReturnType<typeof callHelper>>["reply"], code: string) {
  assert.ok(!reply.ok, "helper 拒绝操作");
  assert.equal(reply.launched, false);
  assert.equal(reply.reasonCode, code);
  assert.throws(() => requireOk(reply, "restart"), (error: unknown) => error instanceof ServiceHelperError && error.code === code);
}

test("helper：精确服务名、固定拒绝清单、白名单、别名与动作限制都在执行前拒绝", async t => {
  const f = fixture(t);
  for (const unit of ["*.service", "template@name.service", "/tmp/target.service", "-bad.service", "with space.service", "ruukoto-backend.service", "systemd-test.service", "ruukoto-service-op-test.service", "missing.service", ALIAS_UNIT]) {
    const reply = (await f.invoke(["inspect", unit])).reply;
    assert.equal(reply.ok, false, unit);
    if (!reply.ok) assert.equal(reply.launched, false, unit);
  }
  const rev = await f.revisions();
  fs.writeFileSync(f.config.policyPath, JSON.stringify({ machineId: rev.machineId, inspectUid: 1, inspectGid: 1, services: { [UNIT]: { actions: [] } } }));
  refused((await f.invoke(["restart", opId(), rev.policyRevision, rev.unitRevision, UNIT])).reply, "action_denied");
  assert.equal(f.starts(), 1);
});

test("helper：策略或单元修订变化拒绝旧快照，原操作编号已认领且不启动服务", async t => {
  for (const changed of ["policy", "unit"] as const) {
    const f = fixture(t), rev = await f.revisions(), id = opId();
    fs.appendFileSync(changed === "policy" ? f.config.policyPath : path.join(f.directory, "units", UNIT), "\n");
    refused((await f.invoke(["restart", id, rev.policyRevision, rev.unitRevision, UNIT])).reply, "revision_mismatch");
    assert.equal(f.starts(), 1);
    refused((await f.invoke(["restart", id, rev.policyRevision, rev.unitRevision, UNIT])).reply, "already_claimed");
  }
});

test("helper：需重新加载的定义拒绝启动；同 hostOpId 不重复执行", async t => {
  const f = fixture(t), rev = await f.revisions();
  f.touch("reload-required");
  refused((await f.invoke(["restart", opId(), rev.policyRevision, rev.unitRevision, UNIT])).reply, "reload_required");
  assert.equal(f.starts(), 1);
  fs.rmSync(path.join(f.directory, "reload-required"));
  const id = opId(), reply = requireOk((await f.invoke(["restart", id, rev.policyRevision, rev.unitRevision, UNIT])).reply, "restart");
  assert.ok(reply.verb === "restart");
  assert.equal(reply.hostOpId, id);
  assert.equal(reply.opUnit, opUnitFor(id));
  assert.equal(reply.exitCode, 0);
  assert.equal(reply.launched, true);
  assert.equal(f.starts(), 2);
  refused((await f.invoke(["restart", id, rev.policyRevision, rev.unitRevision, UNIT])).reply, "already_claimed");
  assert.equal(f.starts(), 2);
});

test("helper：stop-op 先手认领阻止迟到启动；查询失败保留 exited:false", async t => {
  const f = fixture(t), rev = await f.revisions(), id = opId();
  const reply = requireOk((await f.invoke(["stop-op", id])).reply, "stop-op");
  assert.ok(reply.verb === "stop-op");
  assert.equal(reply.exited, true);
  assert.equal(reply.opUnit, opUnitFor(id));
  const claim = JSON.parse(fs.readFileSync(path.join(f.directory, "ops", id, "claim.json"), "utf8"));
  assert.equal(claim.claimedBy, "stop-op");
  assert.ok(fs.existsSync(path.join(f.directory, "ops", id, "stop-requested")));
  refused((await f.invoke(["restart", id, rev.policyRevision, rev.unitRevision, UNIT])).reply, "already_claimed");
  f.touch("stop-query-fails");
  const failed = requireOk((await f.invoke(["stop-op", id])).reply, "stop-op");
  assert.ok(failed.verb === "stop-op");
  assert.equal(failed.exited, false);
  assert.equal(failed.detail, "query_failed");
  assert.equal(f.starts(), 1);
});

test("helper：在途 restart 收到停止标记返回 143，服务启动次数不增加", async t => {
  const f = fixture(t), rev = await f.revisions(), id = opId();
  f.touch("restart-delay-ms", "1500");
  const pending = f.invoke(["restart", id, rev.policyRevision, rev.unitRevision, UNIT]);
  try {
    const claim = path.join(f.directory, "ops", id, "claim.json"), deadline = Date.now() + 5000;
    while (!fs.existsSync(claim) && Date.now() < deadline) await delay(10);
    assert.ok(fs.existsSync(claim), "原 restart 已认领");
    fs.writeFileSync(path.join(f.directory, "ops", id, "stop-requested"), "stop\n");
    const reply = requireOk((await pending).reply, "restart");
    assert.ok(reply.verb === "restart");
    assert.equal(reply.launched, true);
    assert.equal(reply.exitCode, 143);
    assert.equal(f.starts(), 1);
  } finally { await pending; }
});

test("helper：噪声与原始 stdout 保留，唯一前缀应答可解析；坏协议与缺 helper 明确失败", async t => {
  const f = fixture(t);
  f.touch("fd2-noise");
  const inspection = await f.invoke(["inspect", UNIT]), rev = expectRevisions(requireOk(inspection.reply, "inspect"));
  assert.match(inspection.stdout.toString(), /ActiveState=active/);
  assert.match(inspection.stderr.toString(), /sim op-unit stderr noise/);
  assert.match(inspection.stderr.toString(), /RUUKOTO_SERVICE_REPLY /);
  const restart = await f.invoke(["restart", opId(), rev.policyRevision, rev.unitRevision, UNIT]);
  requireOk(restart.reply, "restart");
  assert.match(restart.stderr.toString(), /sim op-unit stderr noise/);
  assert.equal(f.starts(), 2);
  f.touch("garbage-protocol");
  await assert.rejects(f.invoke(["inspect", UNIT]), (error: unknown) => error instanceof ServiceHelperError && error.code === "protocol_error");
  await assert.rejects(callHelper({ ...f.config, helperPath: path.join(f.directory, "missing.mjs") }, ["inspect", UNIT], { timeoutMs: 1000 }), (error: unknown) => error instanceof ServiceHelperError && error.code === "protocol_error");
});
