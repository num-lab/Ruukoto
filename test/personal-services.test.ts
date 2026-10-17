import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, SessionFailed, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { PersonalServiceDoc, ServiceInspectionEntry } from "../apps/ruukoto/src/personal-services.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import type { ServiceManagerConfig } from "../apps/ruukoto/src/service-helper.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

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
  assert.deepEqual(f.calls(), [["inspect", UNIT]]);
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
  assert.deepEqual(names, ["service_inspect", "read_service_inspection"]);
  assert.match(JSON.stringify(requests[0].input), /4096/);
  assert.ok((await personal.main.agent(context)).extensions.some(extension => extension.name === "personal-service-inspect"));
});

test("durable 服务：空闲空工具会话可显式启用，重开缺配置/变更/文档版本拒绝且零请求", async t => {
  const f = await fixture(t);
  const empty = await f.open({ service: undefined });
  assert.deepEqual((await empty.main.agent(context)).tools, []);
  await empty.close();
  const enabled = await f.open();
  assert.equal((await enabled.main.agent(context)).tools.length, 2);
  await enabled.close();
  await assert.rejects(f.open({ service: undefined }), code("service_config_changed"));
  await assert.rejects(f.open({ service: { ...f.service, policyPath: f.service.policyPath + ".other" } }), code("service_config_changed"));
  assert.equal(f.server.calls.length, 0);
  assert.deepEqual(f.calls(), []);
  const storage = await openNodeSqliteStorage(path.join(f.options.directory, "personal.sqlite"));
  const record = await storage.findDocument({ kind: PersonalServiceDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const value = (await storage.document(record!.id, "current", context))!.value;
  await storage.commit([{ type: "document.change", id: record!.id, content: { kind: "base", version: 2, value } }], context);
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
  assert.deepEqual(f.calls(), [["inspect", UNIT]]);
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

test("durable 服务：真实进程崩溃后只读调用重跑，未完成记录保留而不引入 restart", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.script('import * as fs from "node:fs"; import * as path from "node:path"; const dir = path.dirname(process.argv[1]); fs.writeFileSync(path.join(dir,"pid"),String(process.pid)); fs.appendFileSync(path.join(dir,"calls.log"),JSON.stringify(process.argv.slice(2))+"\\n"); process.stdout.write("未完成检查"); setInterval(()=>{},1000);');
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; const {directory,config,service}=JSON.parse(process.env.RUUKOTO_SERVICE_TEST); const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,service}); await p.submit("检查","crash"); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_SERVICE_TEST: JSON.stringify({ directory: f.options.directory, config: f.config, service: f.service }) }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.pipe(process.stderr);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await until(() => f.calls().length === 1);
  // 后台被强杀不证明 detached helper 已停，替身 PID 只用于本用例最后回收。
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), f.service.helperPath);
  const restored = await f.open();
  await restored.answer("检查", "crash");
  assert.deepEqual(f.calls(), [["inspect", UNIT], ["inspect", UNIT]]);
  assert.equal((await f.entries()).filter(ServiceInspectionEntry.is).length, 1);
});
