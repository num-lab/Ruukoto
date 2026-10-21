import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PERSONAL_SCHEDULER, PersonalScheduleRunDoc, PersonalSchedulesDoc, personalScheduledSource } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { toolGrant, toolOperations, toolResolve, toolVerifyStop } from "../apps/ruukoto/src/personal-tools.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => Promise<boolean>) { const end = Date.now() + 15_000; while (!await check()) { assert.ok(Date.now() < end, "等待定时运行超时"); await delay(5); } }
async function fixture(t: TestContext, responder: Responder = () => ({ kind: "text", text: "整项结果" })) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-scheduled-integration-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const model = new MockModelServer(responder), config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_SCHEDULE_INTEGRATION_TEST_KEY", contextWindow: 128000, maxTokens: 4096 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "schedule-test", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
  const options = { directory, modelId: config.modelId, provider: personalProvider(config), tools };
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); await model.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, model, workspace, async open() { return p = await openPersonalHarness(options); } };
}
async function create(p: PersonalHarness, instruction = "执行独立工作") {
  const requestId = randomUUID();
  return p.harness.commit(tx => p.scheduler.create(tx, { requestId, label: "隔离计划", instruction, rule: { kind: "once", at: new Date(Date.now() - 1000).toISOString(), timeZone: "Asia/Tokyo" } }, { kind: "local", requestId }), context);
}
async function runFor(p: PersonalHarness, planId: string) {
  let selected = "";
  await until(async () => { const index = await p.harness.snapshot(PersonalSchedulesDoc, context); for (const id of index?.runs ?? []) { const run = await p.harness.snapshot(PersonalScheduleRunDoc, id, context); if (run?.run?.planId === planId) { selected = id; return true; } } return false; });
  return selected;
}

test("定时组合：文件检索沿创建工具快照和资料根执行", { timeout: 60_000 }, async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "执行资料检索" ? { kind: "tool_calls", calls: [{ id: "scheduled-file-search", name: "search_files", arguments: { query: "scheduled-marker" } }] } : { kind: "text", text: "资料检索完成" });
  fs.writeFileSync(path.join(f.workspace, "scheduled.txt"), "scheduled-marker\n");
  const p = await f.open(), plan = await create(p, "执行资料检索"), id = await runFor(p, plan.id);
  assert.ok(plan.scope.tools.includes("search_files")); assert.ok(plan.scope.extensions.includes("personal-file-search"));
  await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  const run = (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!;
  const operation = await p.harness.commit(async tx => JSON.parse(JSON.stringify((await toolOperations(tx)).find(value => value.kind === "search_files"))), context);
  assert.equal(operation.origin.conversationId, run.conversationId); assert.equal(operation.origin.source.requestId, run.requestId); assert.equal(operation.effect, "returned"); assert.equal(operation.stopped, true);
  assert.deepEqual(operation.view.entries.map((value: { path: string }) => value.path), ["scheduled.txt"]);
  const agent = await p.harness.snapshot(AgentDoc, run.conversationId, context); assert.ok(Array.isArray(agent?.extensions) && agent.extensions.includes("personal-file-search"));
});

test("定时组合：主会话实际请求在说明参数列出定时动作和自动收尾", async t => {
  const f = await fixture(t), p = await f.open();
  await p.answer("查看计划工具", "schedule-instruction-contract");
  const request = f.model.calls[0], tool = request.raw.tools.find((value: { function: { name: string } }) => value.function.name === "schedule_create");
  const description = "完整任务和明确资料，不依赖主聊天中的省略指代。独立定时会话的background_work仅支持delegate/list/result/cancel；安排完子工作后结束初轮，宿主自动封组、等待全部成员和外部核实，再请求本会话汇总并固定回报原入口。";
  assert.equal(tool.function.parameters.properties.instruction.description, description);
  const entries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const saved = entries.filter(entry => entry.kind === "ruukoto.model-request").at(-1)!.data as RequestEvidence;
  assert.ok(JSON.stringify(saved.input).includes(description)); assert.deepEqual(saved.payload, request.raw);
});

test("定时组合：实际汇总请求只交付业务正文，发送状态由宿主查询", async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.content === "委派计算后汇总" ? { kind: "tool_calls", calls: [{ id: "summary-business-child", name: "background_work", arguments: { action: "delegate", content: "计算187乘239" } }] } : { kind: "text", text: "计算结果44693" });
  const p = await f.open(), plan = await create(p, "委派计算后汇总"), id = await runFor(p, plan.id);
  await until(async () => (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.delivery?.state === "local");
  const run = (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!;
  const request = f.model.calls.find(call => call.messages.some(message => message.role === "user" && String(message.content).startsWith("宿主定时整项汇总参考")))!;
  const summary = String(request.messages.at(-1)?.content);
  assert.ok(summary.endsWith("\n本轮已封组。只查询本轮结果，汇总业务结果、失败和未完成之处；不能发起新的操作或委派。本回答只交付最终报告正文，生成后的回报状态由宿主记录并供查询，正文不评价本次运行的发送状态。"));
  assert.equal(summary, run.summary!.content); assert.match(summary, /计算结果44693/);
  assert.equal(run.members.length, 1); assert.equal(run.result?.text, "计算结果44693"); assert.equal(f.model.calls.length, 4);
  const background = request.raw.tools.find((value: { function: { name: string } }) => value.function.name === "background_work");
  assert.deepEqual(background.function.parameters.properties.action.anyOf.map((value: { const: string }) => value.const), ["delegate", "list", "result", "cancel"]);
  const conversation = (await p.harness.conversation(run.conversationId, context))!;
  const entries = (await conversation.entries({ order: "ascending" }, 256, undefined, context)).items;
  const saved = entries.filter(entry => entry.kind === "ruukoto.model-request").at(-1)!.data as RequestEvidence;
  assert.ok(JSON.stringify(saved.input).includes(JSON.stringify(summary))); assert.deepEqual(saved.payload, request.raw);
});

test("定时组合：独立输入与主聊天隔离，结果只留本机，重启不重放", async t => {
  const f = await fixture(t); let p = await f.open();
  await p.answer("私人聊天标记不进入定时上下文", "private-owner");
  const plan = await create(p), id = await runFor(p, plan.id);
  await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  const run = (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!;
  assert.equal(run.result?.status, "completed"); assert.notEqual(run.conversationId, ROOT_CONVERSATION_ID);
  const origin = await p.harness.commit(async tx => { const source = await personalScheduledSource(tx, run.requestId); return source && { kind: source.entry.kind, conversationId: source.entry.conversationId }; }, context);
  assert.equal(origin?.kind, "ruukoto.schedule-input"); assert.equal(origin?.conversationId, run.conversationId);
  const scheduled = f.model.calls.filter(call => call.messages.some(message => message.role === "user" && message.content === plan.instruction));
  assert.ok(scheduled.length >= 2); assert.ok(scheduled.every(call => !JSON.stringify(call).includes("私人聊天标记")));
  await until(async () => (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.delivery?.state === "local");
  const calls = f.model.calls.length; await p.close(); p = await f.open(); await delay(60);
  assert.equal(f.model.calls.length, calls); assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result?.status, "completed");
});

test("定时组合：等待子工作时主聊天继续，创建模式不随新默认扩大", async t => {
  let release!: () => void; const child = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "请委派独立工作") return { kind: "tool_calls", calls: [{ id: "scheduled-child", name: "background_work", arguments: { action: "delegate", content: "子工作等待" } }] };
    if (last?.role === "user" && last.content === "子工作等待") await child;
    return { kind: "text", text: "工作回答" };
  });
  const p = await f.open(); await p.harness.commit(async tx => { const mode = await tx.doc(PersonalPermissionsDoc); mode.mode = "confirm"; mode.version++; }, context);
  const plan = await create(p, "请委派独立工作");
  await p.harness.commit(async tx => { const mode = await tx.doc(PersonalPermissionsDoc); mode.mode = "full_access"; mode.version++; }, context);
  const id = await runFor(p, plan.id);
  await until(async () => (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.members.length === 1);
  assert.equal(await p.answer("主聊天继续", "other-owner-work"), "工作回答");
  const pending = (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!;
  assert.equal(pending.result, undefined);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, pending.members[0].requestId, context))?.permission?.mode, "confirm");
  release(); await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result?.status, "completed");
});

test("定时组合：子回答因长度截断的事实进入最终汇总输入", async t => {
  const f = await fixture(t, request => {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "委派长度用例") return { kind: "tool_calls", calls: [{ id: "partial-child", name: "background_work", arguments: { action: "delegate", content: "长度片段" } }] };
    return { kind: "text", text: last?.content === "长度片段" ? "只有前半部分" : "完成", finishReason: last?.content === "长度片段" ? "length" : "stop" };
  });
  const p = await f.open(), plan = await create(p, "委派长度用例"), id = await runFor(p, plan.id);
  await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  const summary = f.model.calls.flatMap(call => call.messages).find(message => message.role === "user" && String(message.content).startsWith("宿主定时整项汇总参考"));
  assert.ok(summary); assert.match(String(summary.content), /模型输出因长度限制截断，仅为已保存片段，汇总须标记遗漏/);
  assert.match(String(summary.content), /只有前半部分/);
});

test("定时组合：创建后新增资料授权不会扩大旧计划，配置失效时零模型", async t => {
  const f = await fixture(t), p = await f.open(); const requestId = randomUUID();
  const plan = await p.harness.commit(tx => p.scheduler.create(tx, { requestId, label: "固定范围", instruction: "检查资料", rule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString(), timeZone: "UTC" } }, { kind: "local", requestId }), context);
  await p.harness.commit(tx => toolGrant(tx, path.join(f.root, "profile"), f.workspace), context);
  const calls = f.model.calls.length;
  await p.harness.commit(tx => p.scheduler.scan(tx, Date.now() + 120_000), context); p.harness.resume();
  const id = await runFor(p, plan.id); await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  assert.equal(f.model.calls.length, calls); assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result?.status, "failed");
});

test("定时组合：未知HTTP写入保留整项占用，取消与重启不重发", async t => {
  let writes = 0;
  const server = http.createServer((_request, response) => { writes++; response.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}/write`;
  const f = await fixture(t, request => request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "发一次请求" ? { kind: "tool_calls", calls: [{ id: "once-write", name: "http_request", arguments: { url, method: "POST", body: "one" } }] } : { kind: "text", text: "其他工作继续" });
  let p = await f.open(); await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  const plan = await create(p, "发一次请求"), id = await runFor(p, plan.id);
  await until(async () => p.harness.commit(async tx => (await toolOperations(tx)).some(op => op.effect === "effect_unknown" && !!op.observation && op.code !== "started"), context));
  assert.equal(writes, 1); assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result, undefined);
  assert.equal((await p.harness.commit(tx => p.scheduler.result(tx, id), context)).state, "paused");
  assert.equal(await p.answer("独立新工作", "independent-owner"), "其他工作继续");
  await p.harness.commit(tx => p.scheduler.cancel(tx, plan.id, { kind: "local", requestId: randomUUID() }), context);
  await p.close(); p = await f.open(); await delay(60); assert.equal(writes, 1);
  const operation = await p.harness.commit(async tx => (await toolOperations(tx))[0].operation, context);
  await p.harness.commit(async tx => { await toolResolve(tx, operation, "not_applied", "拥有者已核实业务未写入"); await toolVerifyStop(tx, operation, "拥有者已核实原请求结束"); }, context);
  await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result?.status, "canceled"); assert.equal(writes, 1);
});


test("定时组合：子工作SDK规范化参数可恢复，原始调用仍可追溯", async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "规范化子工作" ? { kind: "tool_calls", calls: [{ id: "coerced-child", name: "background_work", arguments: { action: "delegate", content: 42, label: 77 } }] } : { kind: "text", text: "已完成" });
  let p = await f.open(); const plan = await create(p, "规范化子工作"), id = await runFor(p, plan.id);
  await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  const run = (await p.harness.snapshot(PersonalScheduleRunDoc, id, context))!.run!; assert.equal(run.members.length, 1); assert.equal(run.result!.status, "completed");
  const calls = f.model.calls.length; await p.close(); p = await f.open(); await delay(30); assert.equal(f.model.calls.length, calls);
});


test("定时组合：已有索引缺原调度扩展拒绝恢复，零新增模型", async t => {
  const f = await fixture(t), p = await f.open();
  await p.harness.commit(async tx => { const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); const extensions = agent.extensions; assert.ok(Array.isArray(extensions)); agent.extensions = extensions.filter(name => name !== PERSONAL_SCHEDULER); }, context);
  await p.close(); const before = f.model.calls.length;
  await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "schedule_record_invalid");
  assert.equal(f.model.calls.length, before);
});

test("定时组合：终态监督器的未来计划在启动时重建，零新增模型", async t => {
  const f = await fixture(t); let p = await f.open(); const requestId = randomUUID();
  await p.harness.commit(tx => p.scheduler.create(tx, { requestId, label: "恢复监督", instruction: "保持未来计划", rule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString(), timeZone: "UTC" } }, { kind: "local", requestId }), context);
  const original = (await p.harness.snapshot(PersonalSchedulesDoc, context))!.supervisor!;
  await p.harness.abortTask(original, context); await p.harness.waitForTask(original, context); await p.close(); const before = f.model.calls.length;
  p = await f.open(); const restored = (await p.harness.snapshot(PersonalSchedulesDoc, context))!.supervisor!;
  assert.notEqual(restored, original); assert.notEqual((await p.harness.commit(tx => tx.task(restored), context))!.state.status, "terminal");
  assert.equal(f.model.calls.length, before);
});


test("记忆接线：真实子身份带通用工具完成后可重开", async t => {
  const f = await fixture(t); let p = await f.open();
  await p.answer("来源", "reference-source");
  const ref = await p.work.delegate({ content: "分析", requestId: "reference-work", sourceRequestId: "reference-source" });
  assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome?.status, "completed");
  await p.close(); p = await f.open();
  assert.equal((await p.work.list())[0].id, ref.agentId);
});

test("定时记忆：初轮可保存，封组可查询且拒绝撤销", async t => {
  let saved: { memory: number; version: number }; let queried = false, rejected = false;
  const f = await fixture(t, (request, index) => {
    const last = request.messages.at(-1);
    if (index === 0) return { kind: "tool_calls", calls: [{ id: "create-memory", name: "memory", arguments: { action: "create", category: "experience", content: "本次定时自身经验" } }] };
    if (index === 1) { saved = JSON.parse(String(last?.content)); return { kind: "text", text: "完成首次执行" }; }
    if (index === 2) return { kind: "tool_calls", calls: [{ id: "query-memory", name: "memory", arguments: { action: "search", query: "自身经验" } }] };
    if (index === 3) { assert.match(String(last?.content), /本次定时自身经验/); queried = true; return { kind: "tool_calls", calls: [{ id: "revoke-memory", name: "memory", arguments: { action: "revoke", memory: saved.memory, expectedVersion: 1 } }] }; }
    assert.match(String(last?.content), /tool_source_sealed/); rejected = true; return { kind: "text", text: "已核实只读汇总" };
  });
  const p = await f.open(), plan = await create(p, "memory-plan"), id = await runFor(p, plan.id);
  await until(async () => !!(await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result);
  assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run?.result?.status, "completed");
  assert.equal(queried, true); assert.equal(rejected, true); assert.equal(f.model.calls.length, 5);
});
