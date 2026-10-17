import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, LiveDoc, ROOT_CONVERSATION_ID, SessionFailed, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalServiceDoc, ServiceInspectionEntry } from "../apps/ruukoto/src/personal-services.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc, ServiceInspectionAdmission, ServiceInspectionStopEntry, recheckServiceInspection } from "../apps/ruukoto/src/personal-service-inspection.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import type { ServiceManagerConfig } from "../apps/ruukoto/src/service-helper.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { PersonalAgentsDoc, PersonalWorkDoc, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { listPersonalInspections, personalInspectionControls, type PersonalInspectionRef } from "../apps/ruukoto/src/personal-inspection-controls.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { listPersonalDelegations, personalDelegationProgress, PersonalDelegationDoc } from "../apps/ruukoto/src/personal-delegation.ts";

const context = BACKGROUND_CONTEXT;
const UNIT = "ruukoto-service-test.service";
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const inspect: Responder = (_req, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "inspect-1", name: "service_inspect", arguments: { unit: UNIT } }] } : { kind: "text", text: "检查结束" };
const tools = (entries: readonly EntryRecord[]) => entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
const output = (entries: readonly EntryRecord[]) => tools(entries).map(message => message.content.filter(part => part.type === "text").map(part => part.text).join(""));

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!(await check())) { assert.ok(Date.now() < end, "等待服务检查超时"); await delay(10); }
}

async function fixture(t: TestContext, respond: Responder = inspect) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "rk-services-"));
  const helper = path.join(root, "helper");
  fs.mkdirSync(helper);
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), path.join(helper, "helper.mjs"));
  fs.mkdirSync(path.join(helper, "units"));
  fs.writeFileSync(path.join(helper, "services.json"), JSON.stringify({ machineId: "fake-machine", inspectUid: 1, inspectGid: 1, services: { [UNIT]: { actions: ["restart"] } } }));
  fs.writeFileSync(path.join(helper, "units", UNIT), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify({ [UNIT]: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 1234, invocationId: "test-start", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z" } }));
  const service: ServiceManagerConfig = { helperPath: path.join(helper, "helper.mjs"), policyPath: path.join(helper, "services.json"), useSudo: false, sudoPath: "/usr/bin/sudo", timeouts: { inspectMs: 2000 } };
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_DURABLE_SERVICE_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[config.apiKeyEnv];
  process.env[config.apiKeyEnv] = "test-only";
  const options = { directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, service };
  let personal: PersonalHarness | undefined;
  t.after(async () => {
    await personal?.close();
    await server.close();
    const pidFile = path.join(helper, "pid");
    if (fs.existsSync(pidFile)) {
      try { process.kill(-Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, helper, config, service, options, server,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => personal = await openPersonalHarness({ ...options, ...overrides }),
    entries: async () => (await personal!.main.entries({ order: "ascending" }, 256, undefined, context)).items,
    calls: () => fs.existsSync(path.join(helper, "calls.log")) ? fs.readFileSync(path.join(helper, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [],
    script: (body: string) => fs.writeFileSync(service.helperPath, body),
  };
}

test("durable 服务：模型真实调用 inspect，原始字节和两工具定义可重建，证据读取不再访问服务", async t => {
  const f = await fixture(t, (request, index) => {
    if (index === 1) return { kind: "tool_calls", calls: [{ id: "read-1", name: "read_service_inspection", arguments: { evidence: Number(/原始结果证据：(\d+)/.exec(JSON.stringify(request.messages))?.[1]) } }] };
    return index === 0 ? inspect(request, index) : { kind: "text", text: "检查结束" };
  });
  const personal = await f.open();
  // 配置是宿主快照，调用者后续修改对象不能改变已启用工具的执行入口。
  f.service.helperPath += ".changed";
  assert.equal(await personal.answer("检查指定测试服务", "inspect-input"), "检查结束");
  assert.equal(f.calls()[0][0], "inspect-op");
  assert.match(f.calls()[0][1], /^inspect_[0-9a-f]{24}$/);
  assert.deepEqual(f.calls()[0].slice(2), ["fake-machine", UNIT]);
  assert.deepEqual(f.calls().slice(1), [["stop-inspect", f.calls()[0][1], "fake-machine"]]);
  const entries = await f.entries();
  const evidence = entries.filter(ServiceInspectionEntry.is);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].data.code, "ok");
  assert.equal(evidence[0].data.truncated, false);
  assert.match(Buffer.from(evidence[0].data.stdout, "base64").toString(), /ActiveState=active/);
  assert.match(Buffer.from(evidence[0].data.stderr, "base64").toString(), /RUUKOTO_SERVICE_REPLY /);
  assert.match(output(entries)[1], /stdout/);
  assert.match(output(entries)[1], /ActiveState=active/);
  const requests = entries.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
  assert.equal(requests.length, 6);
  assert.deepEqual(requests[1].payload, f.server.calls[0].raw);
  const names = f.server.calls[0].tools?.map(tool => (tool.function as { name: string }).name);
  assert.deepEqual(names, ["service_inspect", "read_service_inspection", "background_work"]);
  assert.match(JSON.stringify(requests[0].input), /4096/);
  assert.ok((await personal.main.agent(context)).extensions.some(extension => extension.name === "personal-service-inspect"));
});

test("durable 服务：空闲空工具会话可显式启用，重开缺配置/变更/文档版本拒绝且零请求", async t => {
  const f = await fixture(t);
  const empty = await f.open({ service: undefined });
  assert.deepEqual((await empty.main.agent(context)).tools.map(tool => tool.name), ["background_work"]);
  await empty.close();
  const enabled = await f.open();
  assert.deepEqual((await enabled.main.agent(context)).tools.map(tool => tool.name), ["service_inspect", "read_service_inspection", "background_work"]);
  await enabled.close();
  await assert.rejects(f.open({ service: undefined }), code("service_config_changed"));
  await assert.rejects(f.open({ service: { ...f.service, policyPath: f.service.policyPath + ".other" } }), code("service_config_changed"));
  assert.equal(f.server.calls.length, 0);
  assert.deepEqual(f.calls(), []);
  const storage = await openNodeSqliteStorage(path.join(f.options.directory, "personal.sqlite"));
  const record = await storage.findDocument({ kind: PersonalServiceDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const value = (await storage.document(record!.id, "current", context))!.value;
  await storage.commit([{ type: "document.change", id: record!.id, content: { kind: "base", version: PersonalServiceDoc.definition.version + 1, value } }], context);
  await storage.close(context);
  await assert.rejects(f.open(), code("service_config_changed"));
  lockPersonalProfile(f.options.directory).release();
});

test("durable 服务：未完成输入不能中途增加工具", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "等待".repeat(80), chunkDelayMs: 30 }));
  const empty = await f.open({ service: undefined });
  await empty.submit("未完成", "pending-input");
  await until(() => f.server.calls.length === 1);
  await empty.close();
  await assert.rejects(f.open(), code("service_config_pending"));
  assert.equal(f.server.calls.length, 1);
  assert.deepEqual(f.calls(), []);
});

test("durable 服务：已启用扩展缺配置记录时拒绝补造", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await personal.harness.commit(tx => tx.retireDoc(PersonalServiceDoc), context);
  await personal.close();
  await assert.rejects(f.open(), code("service_config_missing"));
  assert.equal(f.server.calls.length, 0);
  assert.deepEqual(f.calls(), []);
});

test("durable 服务：目标拒绝、畸形应答、重复前缀和缺 helper 都保存失败证据，不假报状态", async t => {
  const good = { v: 1, verb: "inspect", ok: true, machineId: "fake-machine", policyRevision: "1".repeat(64), unitRevision: "2".repeat(64), unit: UNIT, state: { id: UNIT, loadState: "loaded", activeState: "active", subState: "running", mainPid: 42, invocationId: "inv", result: "success", activeEnterTimestamp: "now" }, observedAt: "2026-10-17T00:00:00Z" };
  for (const [name, value, expected] of [
    ["wrong-unit", { ...good, unit: "other.service" }, "protocol_error"],
    ["missing-state", { ...good, state: null }, "protocol_error"],
    ["invalid-state", { ...good, state: { ...good.state, mainPid: "42" } }, "protocol_error"],
    ["invalid-revision", { ...good, policyRevision: [good.policyRevision] }, "protocol_error"],
    ["invalid-error", { v: 1, verb: "inspect", ok: false, reasonCode: { invalid: true } }, "protocol_error"],
    ["null", null, "protocol_error"],
    ["duplicate", good, "protocol_error"],
    ["garbage", "garbage", "protocol_error"],
    ["missing", good, "protocol_error"],
    ["not-whitelisted", good, "not_whitelisted"],
  ] as const) await t.test(name, async t => {
    const f = await fixture(t);
    if (name === "missing") fs.rmSync(f.service.helperPath);
    else if (name === "not-whitelisted") fs.writeFileSync(f.service.policyPath, JSON.stringify({ machineId: "fake", inspectUid: 1, inspectGid: 1, services: {} }));
    else f.script(`process.stdout.write(Buffer.from([0,255,10])); process.stderr.write(${JSON.stringify("RUUKOTO_SERVICE_REPLY " + (name === "garbage" ? "{invalid" : JSON.stringify(value)) + "\n")} ${name === "duplicate" ? ".repeat(2)" : ""});`);
    const personal = await f.open();
    await personal.answer("检查", name);
    const entries = await f.entries();
    assert.equal(tools(entries)[0].isError, true);
    const evidence = entries.filter(ServiceInspectionEntry.is)[0];
    assert.equal(evidence.data.code, expected);
    assert.doesNotMatch(output(entries)[0], /ActiveState=active/);
    if (!["missing", "not-whitelisted"].includes(name)) assert.deepEqual(Buffer.from(evidence.data.stdout, "base64"), Buffer.from([0, 255, 10]));
  });
});

test("durable 服务：输出硬上限保留有界部分并报错", async t => {
  const f = await fixture(t);
  f.script('process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 97));');
  const personal = await f.open();
  await personal.answer("输出超限", "large");
  const entries = await f.entries();
  const evidence = entries.filter(ServiceInspectionEntry.is)[0];
  assert.equal(evidence.data.code, "output_limit");
  assert.equal(evidence.data.truncated, true);
  assert.equal(Buffer.from(evidence.data.stdout, "base64").length + Buffer.from(evidence.data.stderr, "base64").length, 1024 * 1024);
  assert.equal(tools(entries)[0].isError, true);
});

test("durable 服务：证据保存失败关闭 Harness，不生成成功结果或发出后续模型请求", async t => {
  const f = await fixture(t);
  const cause = new Error("inspection-storage-failed");
  const personal = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename);
    const commit = storage.commit.bind(storage);
    storage.commit = (writes, context) => writes.some(write => write.type === "entry" && write.value.kind === ServiceInspectionEntry.kind) ? Promise.reject(cause) : commit(writes, context);
    return storage;
  } });
  await assert.rejects(personal.answer("检查", "storage-failed"), error => error === cause || error instanceof SessionFailed);
  assert.equal((await personal.harness.closed).reason, "failed");
  assert.equal(f.server.calls.length, 1);
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0][0], "inspect-op");
});

test("durable 服务：分页只读取本会话的检查证据，拒绝其他会话或类型", async t => {
  const requested: number[] = [];
  let wanted = 0;
  const f = await fixture(t, (_request, index) => index % 2 === 0 ? { kind: "tool_calls", calls: [{ id: `read-${index}`, name: "read_service_inspection", arguments: { evidence: requested[wanted++], offset: 4096 } }] } : { kind: "text", text: "读取完成" });
  const personal = await f.open();
  const other = await personal.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  const data = { unit: UNIT, stdout: Buffer.from("a".repeat(9000)).toString("base64"), stderr: "", truncated: false, code: "ok" };
  requested.push((await personal.main.commit(tx => tx.appendEntry(ServiceInspectionEntry, personal.main.id, { data }), context)).id);
  requested.push((await other.commit(tx => tx.appendEntry(ServiceInspectionEntry, other.id, { data }), context)).id);
  requested.push((await personal.main.commit(tx => tx.appendEntry(personal.main.id, { kind: "unrelated", data: {} }), context)).id);
  for (let i = 0; i < requested.length; i++) await personal.answer("读取证据", `read-${i}`);
  const entries = await f.entries();
  const page = JSON.parse(output(entries)[0]) as { text: string; nextOffset: number };
  assert.equal(page.text.length, 4096);
  assert.equal(page.nextOffset, 8192);
  assert.deepEqual(tools(entries).map(result => result.isError), [false, true, true]);
  assert.deepEqual(f.calls(), []);
  // 配置了服务扩展的档案仍拒绝未知扩展，不能以空工具恢复。
  await personal.harness.commit(async tx => { (await tx.doc(AgentDoc, personal.main.id)).extensions = ["personal", "future-service-extension"]; }, context);
  await personal.close();
  await assert.rejects(f.open(), code("extension_missing"));
});

test("durable 服务：后台 SIGKILL 后原检查未停不能重观察，退出后才允许新身份", { timeout: 25000 }, async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "inspect", name: "service_inspect", arguments: { unit: UNIT } }] } : { kind: "text", text: "检查结束" });
  fs.writeFileSync(path.join(f.helper, "inspect-delay-ms"), "60000");
  const service = { ...f.service, timeouts: { inspectMs: 90000, stopMs: 1000 } };
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; const {directory,config,service}=JSON.parse(process.env.RUUKOTO_SERVICE_TEST); const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,service}); await p.submit("检查","crash"); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_SERVICE_TEST: JSON.stringify({ directory: f.options.directory, config: f.config, service }) }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.pipe(process.stderr);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await until(() => f.calls().some(call => call[0] === "inspect-op"));
  const original = f.calls()[0];
  const claim = path.join(f.helper, "inspections", original[1], "claim.json");
  await until(() => fs.existsSync(claim));
  const pid = (JSON.parse(fs.readFileSync(claim, "utf8")) as { pid: number }).pid;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  let restored = await f.open();
  await restored.answer("检查", "crash");
  assert.equal((await restored.inspections!.list()).length, 1);
  await restored.answer("换键检查", "bypass");
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  assert.ok(f.calls().filter(call => call[0] === "stop-inspect").every(call => call[1] === original[1] && call[2] === original[2]));
  assert.match(output(await f.entries()).join("\n"), /停止尚未核实/);
  await restored.close();
  process.kill(pid, "SIGKILL");
  await delay(30);
  fs.rmSync(path.join(f.helper, "inspect-delay-ms"));
  restored = await f.open();
  await restored.answer("停止后重新检查", "after-stop");
  assert.equal((await restored.inspections!.list()).length, 0);
  const inspections = f.calls().filter(call => call[0] === "inspect-op");
  assert.equal(inspections.length, 2); assert.notEqual(inspections[1][1], original[1]);
  assert.equal((await f.entries()).filter(ServiceInspectionEntry.is).length, 1);
});

test("durable 检查：接纳落盘失败零启动，停止证明提交失败恢复原结果而不重观察", async t => {
  for (const stage of ["admission", "stop"] as const) await t.test(stage, async t => {
    const f = await fixture(t);
    const kind = stage === "admission" ? ServiceInspectionAdmission.kind : ServiceInspectionStopEntry.kind;
    const personal = await f.open({ openStorage: async filename => {
      const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
      storage.commit = (writes, context) => writes.some(write => write.type === "entry" && write.value.kind === kind) ? Promise.reject(new Error("injected-storage-failure")) : commit(writes, context);
      return storage;
    } });
    await assert.rejects(personal.answer("检查", stage));
    await personal.harness.closed;
    assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, stage === "admission" ? 0 : 1);
    if (stage === "stop") {
      const restored = await f.open(); await restored.answer("检查", stage);
      assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
      assert.equal((await restored.inspections!.list()).length, 0);
      assert.match(output(await f.entries())[0], /ActiveState=active/);
    }
  });
});

test("durable 检查：终态保留占用，同目标/来源不能换键，其他工作继续且宿主可重核", async t => {
  const other = "independent.service";
  const f = await fixture(t, request => request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "inspect", name: "service_inspect", arguments: { unit: request.messages.at(-1)?.content === "其他目标" ? other : UNIT } }] } : { kind: "text", text: "检查结束" });
  const policy = JSON.parse(fs.readFileSync(f.service.policyPath, "utf8")); policy.services[other] = { actions: ["restart"] }; fs.writeFileSync(f.service.policyPath, JSON.stringify(policy));
  fs.copyFileSync(path.join(f.helper, "units", UNIT), path.join(f.helper, "units", other));
  const state = JSON.parse(fs.readFileSync(path.join(f.helper, "state.json"), "utf8")); state[other] = state[UNIT]; fs.writeFileSync(path.join(f.helper, "state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  const p = await f.open(); await p.answer("检查", "owner");
  const pending = (await p.inspections!.list())[0];
  assert.equal((await p.harness.commit(tx => tx.task(pending.taskId), context))!.state.status, "terminal");
  await p.answer("换键检查", "other-owner");
  await assert.rejects(p.work.delegate({ content: "同来源", sourceRequestId: "owner", requestId: "bypass" }), code("work_source_paused"));
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails"));
  await p.answer("其他目标", "independent");
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 2);
  assert.equal((await p.inspections!.list()).length, 1);
  await p.inspections!.recheckStop(pending.taskId);
  assert.equal((await p.inspections!.list()).length, 0);
});

test("durable 检查：错机器/ID/单元与旧 helper 应答不回退，错误停止证明不释放", async t => {
  for (const fault of ["machine", "inspection", "unit", "legacy", "stop-machine", "stop-inspection"] as const) await t.test(fault, async t => {
    const f = await fixture(t);
    const original = fs.readFileSync(f.service.helperPath, "utf8");
    const inject = `if (obj.verb === ${JSON.stringify(fault.startsWith("stop-") ? "stop-inspect" : "inspect-op")}) { ${fault.includes("machine") ? 'obj.machineId = "other";' : fault.includes("inspection") ? 'obj.inspectionId = "inspect_" + "f".repeat(24);' : fault === "unit" ? 'obj.unit = "other.service";' : 'obj.verb = "inspect";'} }`;
    f.script(original.replace('function reply(obj) {', 'function reply(obj) {\n' + inject));
    const p = await f.open(); await p.answer("检查", fault);
    assert.equal(tools(await f.entries())[0].isError, true);
    assert.equal(f.calls().filter(call => call[0] === "inspect").length, 0);
    assert.equal((await p.inspections!.list()).length, fault.startsWith("stop-") ? 1 : 0);
  });
});

test("durable 检查：恢复拒绝丢失 family、跨尝试证据与假停止证明", async t => {
  for (const fault of ["missing", "evidence", "stop", "source"] as const) await t.test(fault, async t => {
    const f = await fixture(t); const p = await f.open(); await p.answer("检查", fault);
    const entries = await f.entries(); const admission = entries.filter(ServiceInspectionAdmission.is)[0];
    await p.harness.commit(async tx => {
      const record = await tx.doc(PersonalInspectionDoc, String(admission.data.taskId), null);
      if (fault === "missing") { await tx.retireDoc(PersonalInspectionDoc, String(admission.data.taskId)); (await tx.doc(PersonalPendingInspectionsDoc)).tasks = []; }
      else if (fault === "evidence") record.inspection!.result!.evidence = (await tx.appendEntry(ServiceInspectionEntry, p.main.id, { data: { unit: UNIT, code: "ok", stdout: "", stderr: "", truncated: false } })).id;
      else if (fault === "source") record.inspection!.sources = [];
      else record.inspection!.stopEvidence = admission.id;
    }, context);
    await p.close(); await assert.rejects(f.open(), code("service_inspection_invalid"));
    assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  });
});

test("durable 检查：迟到 I1 停止应答只留证据，不能清除 I2 占用", async t => {
  const f = await fixture(t); const p = await f.open(); await p.answer("检查", "cas");
  const admission = (await f.entries()).filter(ServiceInspectionAdmission.is)[0];
  const key = String(admission.data.taskId);
  await p.harness.commit(async tx => {
    (await tx.doc(PersonalInspectionDoc, key, null)).inspection!.stopped = false;
    (await tx.doc(PersonalPendingInspectionsDoc)).tasks = [admission.data.taskId];
  }, context);
  const release = path.join(f.helper, "release-stop"); const entered = path.join(f.helper, "entered-stop");
  const original = fs.readFileSync(f.service.helperPath, "utf8");
  f.script(original.replace('function cmdStopInspect(inspectionId, expectedMachineId) {', `function cmdStopInspect(inspectionId, expectedMachineId) { fs.writeFileSync(${JSON.stringify(entered)}, ""); while (!fs.existsSync(${JSON.stringify(release)})) sleepMs(10);`));
  const checking = recheckServiceInspection(p.harness, f.service, admission.data.taskId);
  try {
    await until(() => fs.existsSync(entered));
    await p.harness.commit(async tx => {
      const identity = { ...admission.data, inspectionId: `inspect_${"e".repeat(24)}` as const };
      const next = await tx.appendEntry(ServiceInspectionAdmission, p.main.id, { data: identity });
      (await tx.doc(PersonalInspectionDoc, key, null)).inspection = { ...identity, admission: next.id, stopped: false };
    }, context);
  } finally { fs.writeFileSync(release, ""); }
  await checking;
  const current = (await p.harness.snapshot(PersonalInspectionDoc, key, context))!.inspection!;
  assert.equal(current.inspectionId, `inspect_${"e".repeat(24)}`); assert.equal(current.stopped, false);
  assert.deepEqual((await p.harness.snapshot(PersonalPendingInspectionsDoc, context))!.tasks, [admission.data.taskId]);
});

test("durable 检查：工具取消仍保存停止证据，未核实的终态不能释放占用", async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.helper, "inspect-delay-ms"), "60000"); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  const p = await f.open({ service: { ...f.service, timeouts: { inspectMs: 90000, stopMs: 1000 } } });
  await p.submit("检查", "cancel-tool"); await until(() => f.calls().some(call => call[0] === "inspect-op"));
  await p.main.abort(context);
  const pending = (await p.inspections!.list())[0]; assert.ok(pending);
  assert.equal((await p.harness.commit(tx => tx.task(pending.taskId), context))!.state.status, "terminal");
  assert.ok((await f.entries()).filter(ServiceInspectionStopEntry.is).length > 0);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails")); await p.inspections!.recheckStop(pending.taskId);
  assert.equal((await p.inspections!.list()).length, 0);
});

test("durable 检查：无身份旧服务配置拒绝恢复且不触发 helper", async t => {
  const f = await fixture(t); const p = await f.open(); await p.close();
  const storage = await openNodeSqliteStorage(path.join(f.options.directory, "personal.sqlite"));
  const record = await storage.findDocument({ kind: PersonalServiceDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const value = (await storage.document(record!.id, "current", context))!.value;
  await storage.commit([{ type: "document.change", id: record!.id, content: { kind: "base", version: 1, value } }], context); await storage.close(context);
  await assert.rejects(f.open(), code("service_config_changed")); assert.deepEqual(f.calls(), []);
});

const childRequest = (request: Parameters<Responder>[0]) => request.system?.includes("你是个人助手的子 Agent");
const childInspect: Responder = request => childRequest(request) && request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "child-inspect", name: "service_inspect", arguments: { unit: UNIT } }] } : { kind: "text", text: "完成" };

test("子检查：三模式逐次固定原工作来源与权限，复用身份不串线，实际输入可重建", async t => {
  const f = await fixture(t, childInspect); const p = await f.open();
  let previous: PersonalWorkRef | undefined;
  for (const [index, mode] of (["auto-review", "confirm", "full_access"] as const).entries()) {
    await p.harness.commit(async tx => { const value = await tx.doc(PersonalPermissionsDoc); value.mode = mode; value.version++; }, context);
    await p.answer("拥有者来源", `source-${index}`);
    const ref = await p.work.delegate({ requestId: `child-${index}`, sourceRequestId: `source-${index}`, content: "检查服务", ...(previous ? { agentId: previous.agentId } : {}) });
    assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "completed");
    if (previous) assert.equal(ref.agentId, previous.agentId);
    const child = (await p.harness.conversation(ref.agentId, context))!;
    assert.deepEqual((await child.agent(context)).tools.map(tool => tool.name), ["service_inspect", "read_service_inspection"]);
    const entries = (await child.entries({ order: "ascending" }, 256, undefined, context)).items;
    const admission = entries.filter(ServiceInspectionAdmission.is).at(-1)!;
    const work = (await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!;
    assert.deepEqual(admission.data.work?.ref, ref);
    assert.deepEqual(admission.data.work?.permission, work.permission);
    assert.equal(admission.data.work?.permission.mode, mode);
    assert.deepEqual(admission.data.sources, [work.source!.submissionId]);
    assert.deepEqual(admission.data.work?.inputs, [work.submissionId]);
    const request = f.server.calls.filter(childRequest).at(-1)!;
    assert.deepEqual(request.tools?.map(tool => (tool.function as { name: string }).name), ["service_inspect", "read_service_inspection"]);
    assert.deepEqual((entries.filter(entry => entry.kind === "ruukoto.model-request").at(-1)!.data as RequestEvidence).payload, request.raw);
    if (index === 0) t.diagnostic(JSON.stringify({ childSnapshot: request.raw, toolSchemas: Math.ceil(JSON.stringify(request.tools).length / 4), systemPrompt: Math.ceil((request.system?.length ?? 0) / 4) }));
    previous = ref;
  }
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 3);
  assert.deepEqual(await p.inspections!.list(), []);
  await p.close(); await f.open();
});

test("子检查：正常收尾及取消等待停止证明，重开重接原任务且重核后不重查", async t => {
  for (const cancel of [false, true]) await t.test(cancel ? "取消" : "正常", async t => {
    const f = await fixture(t, childInspect); let p = await f.open(); await p.answer("来源", "owner");
    fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
    const ref = await p.work.delegate({ requestId: "pending-child", sourceRequestId: "owner", content: "检查服务" });
    await until(async () => (await p.inspections!.list()).length === 1 && f.calls().some(call => call[0] === "stop-inspect"));
    const pending = (await p.inspections!.list())[0];
    await until(async () => (await p.harness.commit(tx => tx.task(pending.taskId), context))?.state.status === "terminal");
    let canceled: Promise<unknown> | undefined;
    if (cancel) { canceled = p.work.cancel(ref); void canceled.catch(() => undefined); await until(async () => (await p.work.status(ref)).cancelRequested); }
    assert.notEqual((await p.work.status(ref)).task.state.status, "terminal");
    assert.equal((await p.work.status(ref)).stopVerified, false);
    await assert.rejects(p.work.delegate({ requestId: "busy", sourceRequestId: "owner", content: "绕过", agentId: ref.agentId }), error => error instanceof PersonalError && ["work_source_paused", "subagent_busy"].includes(error.code));
    assert.equal(await p.answer("独立聊天", "independent"), "完成");
    await p.close(); await canceled?.catch(() => undefined); p = await f.open();
    assert.notEqual((await p.work.status(ref)).task.state.status, "terminal");
    assert.equal((await p.work.list())[0].work?.taskId, ref.taskId);
    assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
    fs.rmSync(path.join(f.helper, "inspection-stop-fails")); await p.inspections!.recheckStop(pending.taskId);
    const settled = await p.harness.waitForTask(ref.taskId, context);
    assert.equal(settled.state.outcome.status, cancel ? "aborted" : "failed");
    assert.equal((await p.work.status(ref)).stopVerified, true);
    assert.equal((await p.work.list())[0].work, undefined);
    assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
    const next = await p.work.delegate({ requestId: "reuse", sourceRequestId: "independent", content: "检查服务", agentId: ref.agentId });
    assert.equal((await p.harness.waitForTask(next.taskId, context)).state.outcome.status, "completed");
  });
});

test("子检查：错误活动输入与准入前取消均不派发 helper", async t => {
  for (const mutation of ["input", "cancel"] as const) await t.test(mutation, async t => {
    let p!: PersonalHarness;
    const f = await fixture(t, async request => {
      if (!childRequest(request)) return { kind: "text", text: "完成" };
      if (request.messages.at(-1)?.role === "user") await p.harness.commit(async tx => {
        const ref = (await tx.doc(PersonalAgentsDoc)).agents[0].work!;
        if (mutation === "cancel") (await tx.doc(PersonalWorkDoc, ref.requestId, null)).cancelRequested = true;
        else (await tx.doc(LiveDoc, ref.agentId)).run!.inputs.push((await tx.doc(PersonalWorkDoc, ref.requestId, null)).source!.submissionId);
      }, context);
      return childInspect(request, 0);
    });
    p = await f.open(); await p.answer("来源", "owner");
    const ref = await p.work.delegate({ requestId: "invalid-child", sourceRequestId: "owner", content: "检查服务" });
    await p.harness.waitForTask(ref.taskId, context);
    assert.deepEqual(f.calls(), []);
  });
});

test("子检查：接纳提交失败零启动，恢复同工作仍只执行一次", async t => {
  const f = await fixture(t, childInspect); let p = await f.open(); await p.answer("来源", "owner"); await p.close();
  p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = (writes, context) => writes.some(write => write.type === "entry" && write.value.kind === ServiceInspectionAdmission.kind) ? Promise.reject(new Error("child-admission-failed")) : commit(writes, context);
    return storage;
  } });
  const ref = await p.work.delegate({ requestId: "failed-admission", sourceRequestId: "owner", content: "检查服务" });
  await p.harness.closed; assert.deepEqual(f.calls(), []);
  p = await f.open(); await p.harness.waitForTask(ref.taskId, context);
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
});

test("子检查：同会话证据可分页，主子互读与其他类型拒绝", async t => {
  let evidence = 1;
  const f = await fixture(t, request => {
    if (request.messages.at(-1)?.role === "tool") {
      if (JSON.stringify(request.messages.at(-1)?.content).includes("原始结果证据")) {
        evidence = Number(/原始结果证据：(\d+)/.exec(JSON.stringify(request.messages))![1]);
        return { kind: "tool_calls", calls: [{ id: "read", name: "read_service_inspection", arguments: { evidence } }] };
      }
      return { kind: "text", text: String(request.messages.at(-1)?.content) };
    }
    if (childRequest(request)) return childInspect(request, 0);
    if (request.messages.at(-1)?.content === "跨会话读") return { kind: "tool_calls", calls: [{ id: "cross-read", name: "read_service_inspection", arguments: { evidence } }] };
    return { kind: "text", text: "完成" };
  });
  const p = await f.open(); await p.answer("来源", "owner");
  const ref = await p.work.delegate({ requestId: "evidence", sourceRequestId: "owner", content: "检查服务" });
  await p.harness.waitForTask(ref.taskId, context);
  const child = (await p.harness.conversation(ref.agentId, context))!;
  assert.equal(tools((await child.entries({}, 256, undefined, context)).items).at(-1)?.isError, false);
  assert.match(await p.answer("跨会话读", "cross-read"), /本会话中找不到/);
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
});

test("子检查：单项追加的后续检查可恢复，后来接纳说明不改写旧检查快照", async t => {
  let first!: () => void, second!: () => void;
  const initial = new Promise<void>(resolve => { first = resolve; });
  const next = new Promise<void>(resolve => { second = resolve; });
  t.after(() => { first(); second(); });
  const f = await fixture(t, async request => {
    const content = request.messages.findLast(message => message.role === "user")?.content;
    if (childRequest(request) && request.messages.at(-1)?.role === "tool") {
      await (content === "首轮" ? initial : next);
      return { kind: "text", text: "检查结束" };
    }
    if (childRequest(request) && content === "纯分析") return { kind: "text", text: "完成" };
    return childInspect(request, 0);
  });
  const p = await f.open(); await p.answer("来源", "owner");
  const ref = await p.work.delegate({ requestId: "notes", sourceRequestId: "owner", content: "首轮" });
  await until(() => f.server.calls.filter(childRequest).length === 2);
  await p.answer("新说明来源", "note-source");
  await p.work.append(ref, { requestId: "note-1", sourceRequestId: "note-source", content: "检查服务" }); first();
  await until(() => f.server.calls.filter(childRequest).length === 4);
  await p.answer("再一条来源", "later-source");
  await p.work.append(ref, { requestId: "note-2", sourceRequestId: "later-source", content: "纯分析" }); second();
  await p.harness.waitForTask(ref.taskId, context);
  const child = (await p.harness.conversation(ref.agentId, context))!;
  const admissions = (await child.entries({}, 256, undefined, context)).items.filter(ServiceInspectionAdmission.is).sort((a, b) => a.id - b.id);
  const work = (await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!;
  const note = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "note-source"), context);
  assert.deepEqual(admissions.map(entry => entry.data.sources), [[work.source!.submissionId], [work.source!.submissionId, note!.id]]);
  assert.ok(work.notes?.every(note => note.admission));
  await p.close(); await f.open();
});

test("子检查：模型取消及时返回，停止未核实期间主聊天继续", async t => {
  let ref!: PersonalWorkRef;
  const f = await fixture(t, request => {
    if (!childRequest(request) && request.messages.at(-1)?.content === "模型取消") return { kind: "tool_calls", calls: [{ id: "cancel", name: "background_work", arguments: { action: "cancel", work: ref.taskId } }] };
    if (!childRequest(request) && request.messages.at(-1)?.role === "tool") return { kind: "text", text: String(request.messages.at(-1)?.content) };
    return childInspect(request, 0);
  });
  const p = await f.open(); await p.answer("来源", "owner"); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  ref = await p.work.delegate({ requestId: "cancel-tool-child", sourceRequestId: "owner", content: "检查服务" });
  await until(async () => (await p.inspections!.list()).length === 1 && f.calls().some(call => call[0] === "stop-inspect"));
  const answer = await Promise.race([p.answer("模型取消", "cancel"), delay(2000).then(() => { throw new Error("模型取消占住主聊天"); })]);
  assert.match(answer, /cancel_requested/);
  assert.notEqual((await p.work.status(ref)).task.state.status, "terminal");
  assert.equal(await p.answer("继续聊天", "chat"), "完成");
  const pending = (await p.inspections!.list())[0];
  await until(async () => (await p.harness.commit(tx => tx.task(pending.taskId), context))?.state.status === "terminal");
  fs.rmSync(path.join(f.helper, "inspection-stop-fails")); await p.inspections!.recheckStop(pending.taskId);
  assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "aborted");
});

test("子检查：恢复拒绝错工作/权限/来源与丢失接纳，不启动新检查", async t => {
  for (const mutation of ["work", "permission", "sources", "missing"] as const) await t.test(mutation, async t => {
    const f = await fixture(t, childInspect); const p = await f.open(); await p.answer("来源", "owner");
    const ref = await p.work.delegate({ requestId: "tamper", sourceRequestId: "owner", content: "检查服务" });
    await p.harness.waitForTask(ref.taskId, context);
    const child = (await p.harness.conversation(ref.agentId, context))!;
    const entry = (await child.entries({}, 256, undefined, context)).items.filter(ServiceInspectionAdmission.is)[0];
    await p.harness.commit(async tx => {
      if (mutation === "missing") await tx.retireDoc(PersonalInspectionDoc, String(entry.data.taskId));
      else {
        const value = (await tx.doc(PersonalInspectionDoc, String(entry.data.taskId), null)).inspection!;
        if (mutation === "work") value.work!.ref.requestId = "other-work";
        if (mutation === "permission") value.work!.permission.mode = "full_access";
        if (mutation === "sources") value.sources = [];
      }
    }, context);
    await p.close(); await assert.rejects(f.open(), code("service_inspection_invalid"));
    assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  });
});

test("子检查：整项暂停/取消包含成员检查，封组报告等原停止后继续", async t => {
  for (const action of ["cancel_delegation", "report"] as const) await t.test(action, async t => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    let summaries = 0;
    const f = await fixture(t, async request => {
      const last = request.messages.at(-1);
      if (childRequest(request)) { await gate; return childInspect(request, 0); }
      if (String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考")) { summaries++; return { kind: "text", text: "完整检查报告" }; }
      if (last?.role === "tool") return { kind: "text", text: String(last.content) };
      if (String(last?.content).startsWith("{")) return { kind: "tool_calls", calls: [{ id: "work-action", name: "background_work", arguments: JSON.parse(String(last!.content)) as Record<string, unknown> }] };
      return { kind: "text", text: "聊天继续" };
    });
    let p = await f.open(); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
    await p.answer(JSON.stringify({ action: "delegate", content: "检查服务" }), "owner");
    const ref = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
    if (action === "report") await p.answer(JSON.stringify({ action, delegation: ref.entryId }), "seal");
    release();
    await until(async () => (await p.inspections!.list()).length === 1 && f.calls().some(call => call[0] === "stop-inspect"));
    const pending = (await p.inspections!.list())[0];
    if (action === "cancel_delegation") {
      assert.match(await p.answer(JSON.stringify({ action: "delegate", content: "绕过", delegation: ref.entryId }), "bypass"), /work_source_paused/);
      assert.match(await p.answer(JSON.stringify({ action, delegation: ref.entryId }), "cancel"), /cancel_requested/);
    }
    assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, ref), context)).paused, true);
    assert.equal(await p.answer("继续聊天", "chat"), "聊天继续"); assert.equal(summaries, 0);
    await p.close(); p = await f.open();
    await until(async () => (await p.harness.commit(tx => tx.task(pending.taskId), context))?.state.status === "terminal");
    fs.rmSync(path.join(f.helper, "inspection-stop-fails")); await p.inspections!.recheckStop(pending.taskId);
    const saved = (await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!;
    for (const member of saved.members) await p.harness.waitForTask(member.taskId, context);
    if (saved.report) {
      await p.harness.waitForTask(saved.report.taskId, context);
      assert.equal((await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!.reply, "完整检查报告");
      assert.equal(summaries, 1);
    } else assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, ref), context)).state, "canceled");
    assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  });
});

test("子检查：旧空闲子配置同事务升级，未决旧工作拒绝且不半启用", async t => {
  for (const active of [false, true]) await t.test(active ? "未决" : "空闲", async t => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    const f = await fixture(t, async request => { if (childRequest(request) && active) await gate; return { kind: "text", text: "完成" }; });
    let p = await f.open(); await p.answer("来源", "owner");
    const ref = await p.work.delegate({ requestId: "old-child", sourceRequestId: "owner", content: "分析" });
    if (active) await until(() => f.server.calls.some(childRequest)); else await p.harness.waitForTask(ref.taskId, context);
    await p.harness.commit(async tx => {
      const main = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(main.extensions));
      main.extensions = main.extensions.filter(name => name !== "personal-subagent-service-inspect");
      const child = await tx.doc(AgentDoc, ref.agentId); child.extensions = ["personal-subagent", "personal-background-work"]; child.tools = [];
    }, context);
    await p.close();
    if (active) {
      await assert.rejects(f.open(), code("work_services_pending"));
      const storage = await openNodeSqliteStorage(path.join(f.options.directory, "personal.sqlite"));
      const doc = await storage.findDocument({ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } }, "current", context);
      assert.doesNotMatch(JSON.stringify((await storage.document(doc!.id, "current", context))!.value), /personal-subagent-service-inspect/);
      await storage.close(context);
    } else {
      p = await f.open(); const child = (await p.harness.conversation(ref.agentId, context))!;
      assert.deepEqual((await child.agent(context)).tools.map(tool => tool.name), ["service_inspect", "read_service_inspection"]);
      assert.ok((await p.main.agent(context)).extensions.some(extension => extension.name === "personal-subagent-service-inspect"));
      await p.close(); await f.open();
    }
    assert.deepEqual(f.calls(), []);
  });
});

test("子检查：后台 SIGKILL 遗留真实检查进程，恢复不换身份且原工作取消等退出", { timeout: 25000 }, async t => {
  const f = await fixture(t, childInspect);
  const initial = await f.open(); await initial.answer("来源", "owner"); await initial.close();
  fs.writeFileSync(path.join(f.helper, "inspect-delay-ms"), "60000");
  const service = { ...f.service, timeouts: { inspectMs: 90000, stopMs: 1000 } };
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; const {directory,config,service}=JSON.parse(process.env.RUUKOTO_SERVICE_TEST); const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,service}); await p.work.delegate({requestId:"crashed-child",sourceRequestId:"owner",content:"检查服务"}); setInterval(()=>{},1000);`;
  const backend = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_SERVICE_TEST: JSON.stringify({ directory: f.options.directory, config: f.config, service }) }, stdio: ["ignore", "ignore", "pipe"] });
  backend.stderr.pipe(process.stderr); t.after(() => { if (backend.exitCode === null && backend.signalCode === null) backend.kill("SIGKILL"); });
  await until(() => f.calls().some(call => call[0] === "inspect-op"));
  const original = f.calls()[0]; const claim = path.join(f.helper, "inspections", original[1], "claim.json");
  await until(() => fs.existsSync(claim)); const pid = (JSON.parse(fs.readFileSync(claim, "utf8")) as { pid: number }).pid;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } });
  const exited = once(backend, "exit"); backend.kill("SIGKILL"); await exited;
  const p = await f.open(); const work = (await p.harness.snapshot(PersonalWorkDoc, "crashed-child", context))!.ref!;
  // Note: 见 .agents/notes/implemented/testing/2026-10-17-inspection-stop-test-reference.md
  const inspection = (await p.inspections!.list())[0]; assert.ok(inspection);
  assert.equal((await p.work.status(work)).stopVerified, false);
  const canceled = p.work.cancel(work); void canceled.catch(() => undefined);
  await until(async () => (await p.work.status(work)).cancelRequested);
  assert.equal((await p.work.list())[0].work?.taskId, work.taskId);
  assert.equal(await p.answer("独立聊天", "chat"), "完成");
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  process.kill(pid, "SIGKILL"); await delay(30); fs.rmSync(path.join(f.helper, "inspect-delay-ms"));
  await p.inspections!.recheckStop(inspection.taskId);
  assert.equal((await canceled).state.outcome.status, "aborted");
  assert.equal((await p.work.list())[0].work, undefined);
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
});

async function inspectionTelegram(t: TestContext) {
  const token = "123:inspection-test";
  const key = "RUUKOTO_INSPECTION_MENU_BOT_KEY";
  const previous = process.env[key]; process.env[key] = token;
  const bot = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { chat_id: string };
    res.end(JSON.stringify({ ok: true, result: { message_id: ++sent, chat: { id: Number(body.chat_id), type: "private" } } }));
  });
  let sent = 1000;
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: key, tokenDigest: createHash("sha256").update(token).digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  t.after(async () => { bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let id = 0;
  return { telegram, async receive(p: PersonalHarness, text: string, replyTo?: number, extra: Record<string, unknown> = {}) {
    const messageId = ++id;
    const update: TelegramUpdate = { update_id: id, message: { message_id: messageId, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } };
    await p.telegram.receive(update);
    const key = `telegram:123:456:${messageId}`;
    const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p.harness.waitForTask(receipt.taskId, context);
    const value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    return { key, update, value, messageId: Number(value.platformMessageId) };
  } };
}

async function stopResult(p: PersonalHarness, ref: PersonalInspectionRef) {
  const task = await p.harness.waitForTask(await p.requestInspectionStop(ref), context);
  assert.equal(task.state.outcome.status, "completed");
  return task.state.outcome.result;
}

test("检查重核控制：原接纳、单次停止观察、错误证明保留占用及可信证明解除", async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  const p = await f.open(); await p.answer("检查", "owner");
  const page = await p.harness.commit(tx => listPersonalInspections(tx), context);
  assert.equal(page.items.length, 1); assert.equal(page.items[0].canRecheck, true);
  const ref = page.items[0].ref;
  await assert.rejects(p.requestInspectionStop({ ...ref, admission: ref.admission + 1000 as typeof ref.admission }), code("inspection_menu_stale"));
  assert.deepEqual(await stopResult(p, ref), { stopped: false, code: "stop_unverified" });
  assert.equal((await p.inspections!.list()).length, 1);
  assert.equal(f.calls().filter(call => call[0] === "stop-inspect").length, 2);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails"));
  assert.deepEqual(await stopResult(p, ref), { stopped: true, code: "stopped" });
  const calls = f.calls().length;
  assert.deepEqual(await stopResult(p, ref), { stopped: true, code: "stopped" });
  assert.equal(f.calls().length, calls); assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  assert.deepEqual((await p.harness.commit(tx => listPersonalInspections(tx), context)).items, []);
  await p.close(); const reopened = await f.open(); assert.deepEqual(await reopened.inspections!.list(), []);
});

test("检查重核控制：活动检查拒绝，取消后原检查可重核并收尾子工作", async t => {
  const f = await fixture(t, childInspect); fs.writeFileSync(path.join(f.helper, "inspect-delay-ms"), "60000"); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  const p = await f.open({ service: { ...f.service, timeouts: { inspectMs: 90000, stopMs: 1000 } } }); await p.answer("来源", "owner");
  const work = await p.work.delegate({ requestId: "controlled-stop", sourceRequestId: "owner", content: "检查" });
  await until(() => f.calls().some(call => call[0] === "inspect-op"));
  const ref = (await p.harness.commit(tx => listPersonalInspections(tx), context)).items[0].ref;
  await assert.rejects(p.requestInspectionStop(ref), code("service_inspection_active"));
  const cancel = p.work.cancel(work); await until(() => f.calls().some(call => call[0] === "stop-inspect"));
  await until(async () => (await p.harness.commit(tx => tx.task(ref.taskId), context))?.state.status === "terminal");
  assert.equal((await p.work.status(work)).stopVerified, false);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails"));
  assert.deepEqual(await stopResult(p, ref), { stopped: true, code: "stopped" }); await cancel;
  assert.equal((await p.work.status(work)).stopVerified, true);
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
});

test("检查重核控制：Telegram 原菜单、去重、零模型、来源与代次过滤", async t => {
  const f = await fixture(t); const tg = await inspectionTelegram(t); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  let p = await f.open({ telegram: tg.telegram }); await tg.receive(p, "检查");
  const before = f.server.calls.length;
  const list = await tg.receive(p, "/检查"); const detail = await tg.receive(p, "检查1", list.messageId);
  assert.match(detail.value.reply!, /停止尚未核实/);
  for (const extra of [{ forward_origin: { type: "user" } }, { quote: { text: "核实检查停止" } }, { reply_to_message: { message_id: detail.messageId, from: { id: 789, is_bot: true } } }]) {
    const rejected = await tg.receive(p, "核实检查停止", detail.messageId, extra); assert.equal(rejected.value.inspectionStop, undefined);
  }
  assert.equal((await tg.receive(p, "核实检查停止")).value.inspectionStop, undefined);
  const registered = await tg.receive(p, "核实检查停止", detail.messageId);
  assert.match(registered.value.reply!, /已登记/); assert.ok(registered.value.inspectionStop);
  await p.harness.waitForTask(registered.value.inspectionStop.taskId, context);
  const calls = f.calls().length; await p.telegram.receive(registered.update); assert.equal(f.calls().length, calls);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails"));
  const success = await tg.receive(p, "核实检查停止", detail.messageId); await p.harness.waitForTask(success.value.inspectionStop!.taskId, context);
  assert.match((await tg.receive(p, "刷新检查", success.messageId)).value.reply!, /停止已核实/);
  assert.equal(f.server.calls.length, before); assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  await p.close(); p = await f.open({ telegram: { ...tg.telegram, generation: randomUUID() } });
  assert.match((await tg.receive(p, "/检查")).value.reply!, /暂无/);
  assert.equal((await tg.receive(p, "核实检查停止", detail.messageId)).value.inspectionStop, undefined);
});

test("检查重核控制：本机与混合来源不进入 Telegram 菜单，原来源全部匹配才显示", async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "inspect", name: "service_inspect", arguments: { unit: UNIT } }] } : { kind: "text", text: "完成" }); const tg = await inspectionTelegram(t); const p = await f.open({ telegram: tg.telegram });
  fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), ""); await p.answer("本机检查", "local");
  assert.equal((await p.harness.commit(tx => listPersonalInspections(tx, 0, tg.telegram), context)).items.length, 0);
  const ref = (await p.harness.commit(tx => listPersonalInspections(tx), context)).items[0].ref;
  assert.equal((await p.harness.commit(tx => listPersonalInspections(tx, 0, { ...tg.telegram, ownerId: "789" }), context)).items.length, 0);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails")); await stopResult(p, ref);
  // 新主会话输入只包含当前已接纳输入，混合来源另在接纳记录中构造。
  fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), ""); const received = await tg.receive(p, "Telegram 检查");
  const pending = (await p.inspections!.list())[0]; assert.ok(pending);
  assert.equal((await p.harness.commit(tx => listPersonalInspections(tx, 0, tg.telegram), context)).items.length, 1);
  await p.harness.commit(async tx => { const value = (await tx.doc(PersonalInspectionDoc, String(pending.taskId), null)).inspection!; value.sources.push((await tx.submissionByRequest(ROOT_CONVERSATION_ID, "local"))!.id); }, context);
  assert.equal((await p.harness.commit(tx => listPersonalInspections(tx, 0, tg.telegram), context)).items.length, 0);
  assert.ok(received.value.submissionId);
});

test("检查重核控制：原请求跨重启保留，缺收件或扩展拒绝", async t => {
  for (const mutation of ["none", "receipt", "marker"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); const tg = await inspectionTelegram(t); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
    let p = await f.open({ telegram: tg.telegram }); await tg.receive(p, "检查");
    const detail = await tg.receive(p, "检查1", (await tg.receive(p, "/检查")).messageId);
    const registered = await tg.receive(p, "核实检查停止", detail.messageId); await p.harness.waitForTask(registered.value.inspectionStop!.taskId, context);
    if (mutation === "receipt") await p.harness.commit(async tx => { delete (await tx.doc(PersonalTelegramReceiptDoc, registered.key, null)).receipt!.inspectionStop; }, context);
    if (mutation === "marker") await p.harness.commit(async tx => { const doc = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(doc.extensions)); doc.extensions = doc.extensions.filter(name => name !== "personal-inspection-controls"); }, context);
    await p.close();
    if (mutation !== "none") { await assert.rejects(f.open({ telegram: tg.telegram }), code("inspection_control_invalid")); return; }
    p = await f.open({ telegram: tg.telegram }); const before = f.calls().length;
    const ref = registered.value.inspectionStop!.ref;
    // 关闭前后均只能重核同一原身份，不重新观察服务。
    await p.harness.commit(tx => personalInspectionControls(f.service, () => p.harness).request(tx, ref), context);
    await p.close(); fs.rmSync(path.join(f.helper, "inspection-stop-fails")); p = await f.open({ telegram: tg.telegram });
    await until(async () => (await p.inspections!.list()).length === 0);
    assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
    assert.ok(f.calls().length > before);
  });
});

test("检查重核控制：接纳后换尝试零外调，旧菜单不能改指新接纳", async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), ""); const p = await f.open(); await p.answer("检查", "owner");
  const ref = (await p.harness.commit(tx => listPersonalInspections(tx), context)).items[0].ref;
  const calls = f.calls().length;
  const id = await p.harness.commit(async tx => {
    const original = (await tx.entry(ServiceInspectionAdmission, ref.admission))!;
    const record = await tx.doc(PersonalInspectionDoc, String(ref.taskId), null);
    const id = await personalInspectionControls(f.service, () => p.harness).request(tx, ref);
    const identity = { ...original.data, inspectionId: `inspect_${"e".repeat(24)}` as const };
    const entry = await tx.appendEntry(ServiceInspectionAdmission, original.conversationId, { data: identity });
    record.inspection = { ...identity, admission: entry.id, stopped: false };
    return id;
  }, context);
  const task = await p.harness.waitForTask(id, context);
  assert.equal(task.state.outcome.status, "completed"); assert.deepEqual(task.state.outcome.result, { stopped: false, code: "inspection_menu_stale" });
  assert.equal(f.calls().length, calls); assert.equal((await p.inspections!.list()).length, 1);
});

test("检查重核控制：Telegram 接纳写失败零外调，重投只登记一次", async t => {
  const f = await fixture(t); const tg = await inspectionTelegram(t); let armed = false;
  fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  let p = await f.open({ telegram: tg.telegram, openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = (writes, ctx) => armed && JSON.stringify(writes).includes('"ruukoto.inspection-stop"') ? Promise.reject(new Error("stop-admission-failed")) : commit(writes, ctx);
    return storage;
  } });
  await tg.receive(p, "检查"); const detail = await tg.receive(p, "检查1", (await tg.receive(p, "/检查")).messageId);
  const update: TelegramUpdate = { update_id: 50, message: { message_id: 50, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text: "核实检查停止", reply_to_message: { message_id: detail.messageId, from: { id: 123, is_bot: true } } } };
  armed = true; const calls = f.calls().length;
  await assert.rejects(p.telegram.receive(update)); await p.harness.closed; await p.close(); assert.equal(f.calls().length, calls);
  p = await f.open({ telegram: tg.telegram });
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.inspection-stop" }, 8), context)).items.length, 0);
  assert.equal((await p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:50", context))?.receipt, undefined);
  await p.telegram.receive(update); await p.telegram.receive(update);
  const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:50", context))!.receipt!;
  await p.harness.waitForTask(receipt.inspectionStop!.taskId, context);
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.inspection-stop" }, 8), context)).items.length, 1);
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
});

test("检查重核控制：helper 等待不阻塞登记、独立聊天或 Telegram 宿主回执", async t => {
  let stopRelease: string | undefined; t.after(() => { if (stopRelease) fs.writeFileSync(stopRelease, ""); });
  const f = await fixture(t); const tg = await inspectionTelegram(t); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  const p = await f.open({ telegram: tg.telegram }); await tg.receive(p, "检查");
  const detail = await tg.receive(p, "检查1", (await tg.receive(p, "/检查")).messageId);
  const entered = path.join(f.helper, "entered-stop"); const release = path.join(f.helper, "release-stop");
  f.script(fs.readFileSync(f.service.helperPath, "utf8").replace('function cmdStopInspect(inspectionId, expectedMachineId) {', `function cmdStopInspect(inspectionId, expectedMachineId) { fs.writeFileSync(${JSON.stringify(entered)}, ""); while (!fs.existsSync(${JSON.stringify(release)})) sleepMs(10);`));
  stopRelease = release;
  const registered = await tg.receive(p, "核实检查停止", detail.messageId); await until(() => fs.existsSync(entered));
  assert.match(registered.value.reply!, /已登记/); assert.equal(fs.existsSync(release), false);
  assert.equal(await p.answer("独立聊天", "independent-chat"), "检查结束");
  assert.match((await tg.receive(p, "刷新检查", registered.messageId)).value.reply!, /尚未核实/);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails")); fs.writeFileSync(release, "");
  const task = await p.harness.waitForTask(registered.value.inspectionStop!.taskId, context);
  assert.deepEqual(task.state.outcome.result, { stopped: true, code: "stopped" });
});

test("检查重核控制：收件提交后 SIGKILL，恢复原重核与回执且不重复登记", { timeout: 20000 }, async t => {
  const f = await fixture(t); const tg = await inspectionTelegram(t); fs.writeFileSync(path.join(f.helper, "inspection-stop-fails"), "");
  let p = await f.open({ telegram: tg.telegram }); await tg.receive(p, "检查");
  const detail = await tg.receive(p, "检查1", (await tg.receive(p, "/检查")).messageId); await p.close();
  const update: TelegramUpdate = { update_id: 50, message: { message_id: 50, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text: "核实检查停止", reply_to_message: { message_id: detail.messageId, from: { id: 123, is_bot: true } } } };
  const marker = path.join(f.root, "stop-committed");
  const script = `import * as fs from "node:fs"; import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,config,service,telegram,update,marker}=JSON.parse(process.env.RUUKOTO_INSPECTION_CRASH); setInterval(()=>{},1000); const p=await openPersonalHarness({directory,service,telegram,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename);const commit=s.commit.bind(s);s.commit=async(writes,c)=>{const seq=await commit(writes,c);if(JSON.stringify(writes).includes('"ruukoto.inspection-stop"')){fs.writeFileSync(marker,"committed");return new Promise(()=>{});}return seq;};return s;}});await p.telegram.receive(update);`;
  const backend = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_INSPECTION_CRASH: JSON.stringify({ directory: f.options.directory, config: f.config, service: f.service, telegram: tg.telegram, update, marker }) }, stdio: ["ignore", "ignore", "pipe"] });
  backend.stderr.pipe(process.stderr); t.after(() => { if (backend.exitCode === null && backend.signalCode === null) backend.kill("SIGKILL"); });
  await until(() => fs.existsSync(marker)); const exited = once(backend, "exit"); backend.kill("SIGKILL"); const exit = await exited; assert.equal(exit[1], "SIGKILL");
  p = await f.open({ telegram: tg.telegram });
  const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:50", context))!.receipt!;
  assert.ok(receipt.inspectionStop); await p.harness.waitForTask(receipt.inspectionStop.taskId, context); await p.harness.waitForTask(receipt.taskId, context);
  await p.telegram.receive(update);
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.inspection-stop" }, 8), context)).items.length, 1);
  assert.equal((await p.inspections!.list()).length, 1);
  fs.rmSync(path.join(f.helper, "inspection-stop-fails")); assert.deepEqual(await stopResult(p, receipt.inspectionStop.ref), { stopped: true, code: "stopped" });
  assert.equal(f.calls().filter(call => call[0] === "inspect-op").length, 1);
  assert.equal(f.server.calls.length, 2);
});
