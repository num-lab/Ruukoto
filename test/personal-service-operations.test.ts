import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, SessionFailed, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalServiceOperationDoc, PersonalServiceOperationsDoc, ServiceOperationEvidence, type PersonalServiceMode, type PersonalServiceOperationRef } from "../apps/ruukoto/src/personal-service-operations.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { listPersonalDelegations, personalDelegationProgress, cancelPersonalDelegation, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import type { ServiceManagerConfig } from "../apps/ruukoto/src/service-helper.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const UNIT = "personal-test.service";
const OTHER = "personal-other.service";
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待服务操作超时"); await delay(10); }
}

async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "收到" })) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "rk-service-op-"));
  const helper = path.join(root, "helper");
  fs.mkdirSync(path.join(helper, "units"), { recursive: true });
  fs.mkdirSync(path.join(helper, "ops"));
  const helperPath = path.join(helper, "helper.mjs");
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), helperPath);
  const policyPath = path.join(helper, "services.json");
  fs.writeFileSync(policyPath, JSON.stringify({ machineId: "test-machine", inspectUid: 1, inspectGid: 1, services: { [UNIT]: { actions: ["restart"] }, [OTHER]: { actions: ["restart"] } } }));
  for (const unit of [UNIT, OTHER]) fs.writeFileSync(path.join(helper, "units", unit), "[Service]\nExecStart=/usr/bin/true\n");
  fs.writeFileSync(path.join(helper, "state.json"), JSON.stringify(Object.fromEntries([UNIT, OTHER].map(unit => [unit, { loadState: "loaded", activeState: "active", subState: "running", mainPid: 123, invocationId: "before", result: "success", activeEnterTimestamp: "2026-10-17T00:00:00Z", starts: 0 }]))));
  const service: ServiceManagerConfig = { helperPath, policyPath, useSudo: false, sudoPath: "/usr/bin/sudo", timeouts: { inspectMs: 1000, restartMs: 2000, stopMs: 1000 } };
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_SERVICE_OP_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[config.apiKeyEnv];
  process.env[config.apiKeyEnv] = "test-only";
  const options = { directory: path.join(root, "profile"), provider: personalProvider(config), modelId: config.modelId, service, serviceOperations: true };
  let personal: PersonalHarness | undefined;
  t.after(async () => {
    await personal?.close(); await server.close();
    if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, helper, config, options, server, service,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => personal = await openPersonalHarness({ ...options, ...overrides }),
    starts: (unit = UNIT) => (JSON.parse(fs.readFileSync(path.join(helper, "state.json"), "utf8")) as Record<string, { starts: number }>)[unit].starts,
    calls: () => fs.existsSync(path.join(helper, "calls.log")) ? fs.readFileSync(path.join(helper, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [],
    touch: (file: string, content = "") => fs.writeFileSync(path.join(helper, file), content),
  };
}
const input = (requestId: string, mode?: PersonalServiceMode, unit = UNIT, sourceRequestId = "owner") => ({ requestId, unit, sourceRequestId, ...(mode ? { mode } : {}) });
async function ready(p: PersonalHarness, ref: PersonalServiceOperationRef) { await until(async () => !!(await p.service!.status(ref)).operation.snapshot); }
async function unknown(p: PersonalHarness, ref: PersonalServiceOperationRef) { await until(async () => { const result = (await p.service!.status(ref)).operation.result; return result?.effect === "effect_unknown" && result.code !== "started"; }); }
async function finish(p: PersonalHarness, ref: PersonalServiceOperationRef) { return p.harness.waitForTask(ref.taskId, context); }

test("分析委托：终态成员说明或追加来源效果未知，整组续派/追加/子请求暂停，取消与他项继续", async t => {
  for (const origin of ["instruction", "note"] as const) await t.test(origin, async t => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    let group!: PersonalDelegationRef;
    const f = await fixture(t, async request => {
      const last = request.messages.at(-1);
      if (request.system?.includes("你是个人助手的子 Agent")) { if (last?.content === "A") await gate; return { kind: "text", text: "分析完成" }; }
      if (last?.role === "tool") return { kind: "text", text: String(last.content) };
      if (["开始", "续派", "绕过"].includes(String(last?.content))) return { kind: "tool_calls", calls: [{ id: "delegate", name: "background_work", arguments: { action: "delegate", content: last?.content === "开始" ? "A" : "B", ...(last?.content === "开始" ? {} : { delegation: group.entryId }) } }] };
      return { kind: "text", text: "独立聊天" };
    });
    f.touch("fail-after-launch"); const p = await f.open();
    await p.answer("开始", "owner"); group = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
    await p.answer("续派", "continuation");
    let members = (await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).members;
    await p.harness.waitForTask(members[1].ref.taskId, context);
    await p.answer("追加说明来源", "extra-source");
    await p.work.append(members[0].ref, { requestId: "accepted", sourceRequestId: origin === "note" ? "extra-source" : "owner", content: "后续说明" });
    const operation = await p.service!.request({ requestId: "unknown-member", unit: UNIT, mode: "full_access", sourceRequestId: origin === "note" ? "extra-source" : "continuation" }); await unknown(p, operation);
    assert.match(await p.answer("绕过", "bypass"), /work_source_paused/);
    await assert.rejects(p.work.append(members[0].ref, { requestId: "bypass-note", sourceRequestId: "owner", content: "换方式" }), code("work_source_paused"));
    assert.equal((await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).paused, true);
    release(); await p.harness.waitForTask(members[0].ref.taskId, context);
    assert.equal(f.server.calls.filter(request => request.system?.includes("你是个人助手的子 Agent") && request.messages.at(-1)?.content === "后续说明").length, 0);
    await p.harness.commit(tx => cancelPersonalDelegation(tx, group), context);
    assert.equal(await p.answer("其他来源继续", "independent"), "独立聊天");
    const other = await p.work.delegate({ content: "独立分析", sourceRequestId: "independent", requestId: "independent-analysis" });
    await p.harness.waitForTask(other.taskId, context); members = (await p.harness.commit(tx => personalDelegationProgress(tx, group), context)).members;
    assert.equal(members.length, 2); assert.equal(f.starts(), 1);
  });
});

test("服务工作：默认自动审查和 confirm 等单次人工批准，full_access 免审批；同键去重异参拒绝", async t => {
  for (const mode of [undefined, "confirm", "full_access"] as const) await t.test(mode ?? "default", async t => {
    const f = await fixture(t); const p = await f.open();
    await p.answer("重启测试服务", "owner");
    const ref = await p.service!.request(input("operation", mode));
    assert.deepEqual(await p.service!.request(input("operation", mode)), ref);
    await assert.rejects(p.service!.request({ ...input("operation", mode), unit: OTHER }), code("service_request_conflict"));
    if (mode !== "full_access") {
      await ready(p, ref);
      assert.equal(f.starts(), 0);
      await p.service!.decide(ref, "approved");
    }
    const settled = await finish(p, ref);
    assert.equal(settled.state.outcome.status, "completed");
    const status = await p.service!.status(ref);
    assert.equal(status.operation.mode, mode ?? "auto-review");
    assert.equal(status.operation.consumed, true);
    assert.deepEqual(status.operation.result, { effect: "executed", code: "command_completed", exitCode: 0 });
    assert.equal(f.starts(), 1);
    if (mode !== "full_access") await p.service!.decide(ref, "approved");
    assert.equal(f.calls().filter(call => call[0] === "restart").length, 1);
    const evidence = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(ServiceOperationEvidence.is);
    assert.equal(evidence.length, 2);
    assert.match(Buffer.from(evidence[1].data.stderr, "base64").toString(), /RUUKOTO_SERVICE_REPLY/);
    assert.deepEqual((await p.service!.list()).items.map(item => item.operation.ref), [ref]);
    assert.deepEqual((await p.main.agent(context)).tools.map(tool => tool.name), ["service_inspect", "read_service_inspection", "background_work"]);
  });
});

test("服务工作：原来源未知不能换后台工作，已登记子工作在 HTTP 前暂停，独立聊天继续", async t => {
  const f = await fixture(t); f.touch("fail-after-launch");
  let p!: PersonalHarness; let armed = false;
  const base = f.options.provider;
  p = await f.open({ provider: { ...base, streamSimple: (model, input, options) => base.streamSimple(model, input, { ...options, onPayload: async payload => {
    if (armed) {
      armed = false;
      const operation = await p.service!.request({ requestId: "unknown-source", unit: UNIT, mode: "full_access", sourceRequestId: "owner" });
      await unknown(p, operation);
    }
    return await options?.onPayload?.(payload, model) ?? payload;
  } }) } });
  await p.answer("原工作", "owner"); armed = true;
  const ref = await p.work.delegate({ requestId: "existing", sourceRequestId: "owner", content: "后台分析" });
  const outcome = await p.harness.waitForTask(ref.taskId, context);
  assert.equal(outcome.state.outcome.status, "failed"); assert.equal(f.server.calls.length, 1);
  await assert.rejects(p.work.delegate({ requestId: "bypass", sourceRequestId: "owner", content: "换身份重试" }), code("work_source_paused"));
  assert.equal((await p.work.list()).length, 1); assert.equal(f.starts(), 1);
  assert.equal(await p.answer("其他独立聊天", "independent"), "收到");
});

test("服务工作：追加来源后来效果未知，不能借其他安全工作继续子请求", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => { if (request.system?.includes("你是个人助手的子 Agent")) await gate; return { kind: "text", text: "收到" }; });
  f.touch("fail-after-launch"); const p = await f.open();
  await p.answer("安全工作", "owner"); await p.answer("追加来源", "note-owner");
  const ref = await p.work.delegate({ requestId: "safe", sourceRequestId: "owner", content: "后台分析" });
  await until(() => f.server.calls.length === 3);
  await p.work.append(ref, { requestId: "accepted", content: "追加要求", sourceRequestId: "note-owner" });
  const operation = await p.service!.request({ requestId: "unknown-note-source", unit: UNIT, mode: "full_access", sourceRequestId: "note-owner" }); await unknown(p, operation);
  await assert.rejects(p.work.append(ref, { requestId: "bypass", content: "换方式重试", sourceRequestId: "note-owner" }), code("work_source_paused"));
  release(); assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "failed");
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!.notes?.length, 1);
  assert.equal(f.server.calls.length, 3); assert.equal(f.starts(), 1);
  assert.equal(await p.answer("其他独立聊天", "independent"), "收到");
});

test("服务工作：拒绝、未消费取消、策略与单元修订变化均零执行", async t => {
  for (const kind of ["reject", "cancel", "policy", "unit"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); await p.answer("服务工作", "owner");
    const ref = await p.service!.request(input(kind)); await ready(p, ref);
    if (kind === "reject") await p.service!.decide(ref, "rejected");
    else if (kind === "cancel") await p.service!.cancel(ref);
    else {
      fs.appendFileSync(kind === "policy" ? f.service.policyPath : path.join(f.helper, "units", UNIT), "\n");
      await p.service!.decide(ref, "approved");
    }
    await finish(p, ref);
    assert.equal(f.starts(), 0);
    assert.equal((await p.service!.status(ref)).operation.result?.effect, "not_executed");
    if (kind === "reject" || kind === "cancel") await assert.rejects(p.service!.decide(ref, "approved"), code("service_approval_invalid"));
    else { await p.service!.decide(ref, "approved"); assert.equal(f.starts(), 0); }
  });
});

test("服务工作：来源/目标拒绝，等待审批重开仍等待且只消费一次", async t => {
  const f = await fixture(t); let p = await f.open();
  await assert.rejects(p.service!.request(input("missing")), code("service_source_invalid"));
  await p.answer("拥有者服务工作", "owner");
  await assert.rejects(p.service!.request({ ...input("invalid"), unit: "../outside.service" }), code("service_input_invalid"));
  const denied = await p.service!.request({ ...input("denied", "full_access"), unit: "outside.service" });
  await finish(p, denied); assert.equal((await p.service!.status(denied)).operation.result?.effect, "not_executed");
  const ref = await p.service!.request(input("waiting")); await ready(p, ref); await p.close();
  p = await f.open();
  assert.equal((await p.service!.status(ref)).operation.decision, "pending");
  assert.equal(f.starts(), 0); await p.service!.decide(ref, "approved"); await finish(p, ref);
  assert.equal(f.starts(), 1);
});

test("服务工作：同一来源的待批准操作也串行，不能预排另一目标绕过未知暂停", async t => {
  const f = await fixture(t); const p = await f.open(); await p.answer("两个服务工作", "owner");
  const ref = await p.service!.request(input("first")); await ready(p, ref);
  await assert.rejects(p.service!.request(input("queued-bypass", "full_access", OTHER)), code("service_operation_busy"));
  f.touch("fail-after-launch"); await p.service!.decide(ref, "approved"); await unknown(p, ref);
  await assert.rejects(p.service!.request(input("unknown-bypass", "full_access", OTHER)), code("service_operation_busy"));
  assert.equal(f.starts(OTHER), 0);
});

test("服务工作：已受理来源后来 unanswered 不阻止整个档案恢复，未消费批准仍拒绝", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "进行中".repeat(80), chunkDelayMs: 30 }));
  let p = await f.open(); await p.submit("拥有者原输入", "owner");
  await until(() => f.server.calls.length === 1);
  const ref = await p.service!.request(input("source-unanswered")); await ready(p, ref);
  await p.main.abort(context); await p.close();
  p = await f.open();
  await assert.rejects(p.service!.decide(ref, "approved"), code("service_approval_invalid"));
  await p.service!.cancel(ref); await finish(p, ref);
  assert.equal(f.starts(), 0);
});

test("服务工作：未知效果硬拦同来源换键与同目标，其他服务/主聊天继续，核实停止后才能释放", async t => {
  const f = await fixture(t); const p = await f.open(); await p.answer("服务工作", "owner");
  f.touch("fail-after-launch"); f.touch("stop-query-fails");
  const ref = await p.service!.request(input("unknown", "full_access")); await unknown(p, ref);
  await assert.rejects(p.service!.request(input("another-key", "full_access", OTHER)), code("service_operation_busy"));
  await p.answer("独立工作继续", "independent");
  await assert.rejects(p.service!.request(input("same-target", "full_access", UNIT, "independent")), code("service_operation_busy"));
  fs.rmSync(path.join(f.helper, "fail-after-launch"));
  const other = await p.service!.request(input("other", "full_access", OTHER, "independent")); await finish(p, other);
  assert.equal(f.starts(OTHER), 1);
  await p.service!.resolve(ref, "applied", "隔离服务计数恰增加一次");
  await p.service!.recheckStop(ref);
  assert.notEqual((await p.service!.status(ref)).task?.state.status, "terminal");
  await assert.rejects(p.service!.request(input("still-busy", "full_access")), code("service_operation_busy"));
  fs.rmSync(path.join(f.helper, "stop-query-fails"));
  await p.service!.recheckStop(ref); await finish(p, ref);
  assert.equal((await p.service!.status(ref)).operation.launcherStopped, true);
  assert.equal(f.starts(), 1);
});

test("服务工作：旧 stop 应答缺启动器证明，人工效果核实也不能释放", async t => {
  const f = await fixture(t); const p = await f.open(); await p.answer("服务工作", "owner");
  f.touch("fail-after-launch");
  const script = fs.readFileSync(f.service.helperPath, "utf8").replace(/launcherExited: launchEnded/g, "launcherExited: undefined");
  fs.writeFileSync(f.service.helperPath, script);
  const ref = await p.service!.request(input("old", "full_access")); await unknown(p, ref);
  await p.service!.resolve(ref, "applied", "服务已生效，但启动器退出无法核实");
  await p.service!.recheckStop(ref);
  assert.equal((await p.service!.status(ref)).operation.launcherStopped, false);
  await assert.rejects(p.service!.request(input("retry", "full_access")), code("service_operation_busy"));
});

test("服务工作：在途取消和超时保持未知，停止与效果核实独立", { timeout: 15000 }, async t => {
  for (const action of ["cancel", "native-abort", "timeout"] as const) await t.test(action, async t => {
    const f = await fixture(t); f.touch("restart-delay-ms", "5000");
    const p = await f.open({ service: { ...f.service, timeouts: { ...f.service.timeouts, restartMs: action === "timeout" ? 100 : 3000 } } });
    await p.answer("服务工作", "owner"); const ref = await p.service!.request(input(action, "full_access"));
    await until(() => f.calls().some(call => call[0] === "restart"));
    if (action !== "timeout") {
      const op = (await p.service!.status(ref)).operation;
      await until(() => fs.existsSync(path.join(f.helper, "ops", op.hostOpId, "claim.json")));
      if (action === "cancel") await p.service!.cancel(ref); else await p.harness.abortTask(ref.taskId, context);
    }
    await unknown(p, ref);
    await p.service!.resolve(ref, "not_applied", "隔离服务启动计数保持零");
    await p.service!.recheckStop(ref);
    const settled = await finish(p, ref);
    assert.equal(settled.state.outcome.status, action === "timeout" ? "completed" : "aborted");
    assert.equal(f.starts(), 0);
    assert.equal(f.calls().filter(call => call[0] === "restart").length, 1);
    assert.equal((await p.service!.status(ref)).operation.result?.effect, "effect_unknown");
  });
});

test("服务工作：效果完成而结果未提交时真实强杀，重开只核实不重发", { timeout: 20000 }, async t => {
  const f = await fixture(t); let p = await f.open(); await p.answer("服务工作", "owner"); await p.close();
  const marker = path.join(f.root, "result-blocked");
  const script = `import * as fs from "node:fs"; import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,service,config,marker}=JSON.parse(process.env.RUUKOTO_OP_CRASH); const p=await openPersonalHarness({directory,service,serviceOperations:true,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename);const commit=s.commit.bind(s);s.commit=(writes,c)=>{if(writes.some(w=>w.type==="entry"&&w.value.kind==="ruukoto.service-operation-evidence"&&w.value.data.verb==="restart")){fs.writeFileSync(marker,"blocked");return new Promise(()=>{});}return commit(writes,c);};return s;}});await p.service.request({requestId:"crash",sourceRequestId:"owner",unit:${JSON.stringify(UNIT)},mode:"full_access"});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_OP_CRASH: JSON.stringify({ directory: f.options.directory, service: f.service, config: f.config, marker }) }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.pipe(process.stderr);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await until(() => fs.existsSync(marker)); assert.equal(f.starts(), 1);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  p = await f.open(); const ref = await p.service!.request(input("crash", "full_access")); await unknown(p, ref);
  await p.service!.resolve(ref, "applied", "强杀前已从独立服务计数核实"); await p.service!.recheckStop(ref); await finish(p, ref);
  assert.equal(f.starts(), 1);
  assert.equal(f.calls().filter(call => call[0] === "restart").length, 1);
});

test("服务工作：结果存储失败关闭 Harness，恢复保留已开始事实并转未知", async t => {
  const f = await fixture(t);
  const cause = new Error("service-result-storage-failed");
  const p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
    storage.commit = (writes, c) => writes.some(write => write.type === "entry" && write.value.kind === ServiceOperationEvidence.kind && write.value.data && typeof write.value.data === "object" && !Array.isArray(write.value.data) && write.value.data.verb === "restart") ? Promise.reject(cause) : commit(writes, c);
    return storage;
  } });
  await p.answer("服务工作", "owner"); const ref = await p.service!.request(input("storage", "full_access"));
  await assert.rejects(finish(p, ref), error => error === cause || error instanceof SessionFailed);
  assert.equal((await p.harness.closed).reason, "failed"); await p.close();
  const restored = await f.open(); await unknown(restored, ref);
  assert.equal(f.starts(), 1); assert.equal(f.calls().filter(call => call[0] === "restart").length, 1);
});

test("服务工作：命令非零、可信未启动、错操作与畸形应答按证据分类", async t => {
  for (const kind of ["nonzero", "refused", "wrong-operation", "garbage"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); await p.answer("服务工作", "owner");
    const original = 'reply({ verb: "restart", ok: true, machineId, hostOpId, opUnit, launched: true, execIdentity: "root", exitCode, observedAt: new Date().toISOString() });';
    if (kind !== "refused") {
      const script = fs.readFileSync(f.service.helperPath, "utf8"); assert.ok(script.includes(original));
      const replacement = kind === "garbage" ? 'fs.writeSync(2, "garbage\\n");' : kind === "nonzero" ? original.replace("exitCode,", "exitCode: 7,") : original.replace("hostOpId, opUnit,", 'hostOpId: "wrong-operation", opUnit,');
      fs.writeFileSync(f.service.helperPath, script.replace(original, replacement));
    }
    const ref = await p.service!.request(input(kind)); await ready(p, ref);
    if (kind === "refused") f.touch("reload-required");
    await p.service!.decide(ref, "approved");
    if (kind === "wrong-operation" || kind === "garbage") {
      await unknown(p, ref);
      assert.equal(f.starts(), 1);
      await assert.rejects(p.service!.request(input("retry", "full_access")), code("service_operation_busy"));
    } else {
      await finish(p, ref);
      const result = (await p.service!.status(ref)).operation.result!;
      assert.equal(result.effect, kind === "refused" ? "not_executed" : "executed");
      if (kind === "nonzero") assert.equal(result.exitCode, 7);
      assert.equal(f.starts(), kind === "refused" ? 0 : 1);
    }
  });
});

test("服务工作：意外 faulted 终态与缺结果不释放未知目标，核实证据后可继续", async t => {
  const f = await fixture(t); let p = await f.open(); await p.answer("服务工作", "owner"); f.touch("fail-after-launch");
  const ref = await p.service!.request(input("faulted", "full_access")); await unknown(p, ref);
  const task = (await p.service!.status(ref)).task!;
  await p.harness.commit(async tx => { delete (await tx.doc(PersonalServiceOperationDoc, ref.requestId, null)).operation!.result; }, context);
  await p.close();
  const storage = await openNodeSqliteStorage(path.join(f.options.directory, "personal.sqlite"));
  await storage.commit([{ type: "task", value: { ...task, memos: undefined, state: { status: "terminal", outcome: { status: "faulted", error: { message: "injected fault" } } } } }], context); await storage.close(context);
  p = await f.open();
  await assert.rejects(p.service!.request(input("retry", "full_access")), code("service_operation_busy"));
  assert.equal((await p.service!.status(ref)).operation.result?.effect, "effect_unknown");
  await p.service!.resolve(ref, "applied", "独立计数核实已生效"); await p.service!.recheckStop(ref);
  fs.rmSync(path.join(f.helper, "fail-after-launch"));
  const next = await p.service!.request(input("after-resolution", "full_access")); await finish(p, next);
  assert.equal(f.starts(), 2);
  assert.equal((await p.service!.status(ref)).task?.state.outcome?.status, "faulted");
});

test("服务工作：缺配置、版本与双向关系损坏拒绝恢复，零额外 restart", async t => {
  for (const kind of ["disabled", "config", "version", "record", "task", "extension"] as const) await t.test(kind, async t => {
    const f = await fixture(t); const p = await f.open(); await p.answer("服务工作", "owner");
    const ref = await p.service!.request(input(kind)); await ready(p, ref);
    if (kind === "config") await p.harness.commit(tx => tx.retireDoc(PersonalServiceOperationsDoc), context);
    if (kind === "record") await p.harness.commit(tx => tx.retireDoc(PersonalServiceOperationDoc, ref.requestId), context);
    if (kind === "task") await p.harness.commit(async tx => { (await tx.doc(PersonalServiceOperationDoc, ref.requestId, null)).operation!.ref.requestId = "wrong-key"; }, context);
    if (kind === "extension") await p.harness.commit(async tx => { const agent = await tx.doc(AgentDoc, p.main.id); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== "personal-service-operations"); }, context);
    await p.close();
    if (kind === "version") {
      const storage: Storage = await openNodeSqliteStorage(path.join(f.options.directory, "personal.sqlite"));
      const record = await storage.findDocument({ kind: PersonalServiceOperationDoc.definition.kind, scope: { kind: "session" }, key: ref.requestId }, "current", context);
      const saved = await storage.document(record!.id, "current", context);
      await storage.commit([{ type: "document.change", id: record!.id, content: { kind: "base", version: 2, value: saved!.value } }], context); await storage.close(context);
    }
    await assert.rejects(f.open({ serviceOperations: kind !== "disabled" }), code(["record", "task"].includes(kind) ? "service_operation_invalid" : "service_operations_config"));
    assert.equal(f.calls().filter(call => call[0] === "restart").length, 0);
  });
});

test("服务工作：首次启用标记提交后应答丢失，新建/已有主会话都能一致重开", async t => {
  for (const existing of [false, true]) await t.test(existing ? "existing" : "fresh", async t => {
    const f = await fixture(t);
    if (existing) { const p = await f.open({ serviceOperations: false }); await p.close(); }
    const cause = new Error("config-commit-answer-lost");
    await assert.rejects(f.open({ openStorage: async filename => {
      const storage = await openNodeSqliteStorage(filename); const commit = storage.commit.bind(storage);
      storage.commit = async (writes, context) => {
        const seq = await commit(writes, context);
        if (writes.some(write => write.type === "document.create" && write.record.kind === PersonalServiceOperationsDoc.definition.kind)) throw cause;
        return seq;
      };
      return storage;
    } }), error => error === cause || error instanceof SessionFailed);
    const restored = await f.open();
    assert.ok((await restored.main.agent(context)).extensions.some(extension => extension.name === "personal-service-operations"));
    assert.deepEqual(f.calls(), []);
  });
});
