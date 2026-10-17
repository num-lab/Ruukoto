import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AgentDoc, LiveDoc, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalAgentsDoc, PersonalWorkDoc, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { personalToolSource } from "../apps/ruukoto/src/personal-work-tools.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const call = (args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ id: "work-call", name: "background_work", arguments: args }] });
const childRequest = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent");
const resultText = (request: RecordedRequest) => String(request.messages.at(-1)?.content);
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, "等待模型工作超时"); await delay(5); }
}
async function fixture(t: TestContext, respond: Responder) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "rk-model-work-"));
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_MODEL_WORK_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const options = { directory, provider: personalProvider(config), modelId: config.modelId };
  let p: PersonalHarness;
  t.after(async () => { await p?.close(); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, server, config, options, open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ ...options, ...overrides }) };
}
async function ref(p: PersonalHarness) {
  const tasks = await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 1), context);
  const task = tasks.items[0]; assert.ok(task);
  assert.ok(task.input && typeof task.input === "object" && !Array.isArray(task.input) && typeof task.input.requestId === "string");
  return (await p.harness.snapshot(PersonalWorkDoc, task.input.requestId, context))!.ref!;
}

test("模型工作：实际委派不阻塞主聊天，分页读原结果，复用/关闭保留历史与证据", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const answer = "后台结果".repeat(1400);
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await gate; return { kind: "text", text: answer }; }
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: resultText(request) };
    const input = String(request.messages.at(-1)?.content);
    if (input === "委派") return call({ action: "delegate", content: "独立分析", label: "分析员" });
    if (input.startsWith("查询:")) return call({ action: "result", work: Number(input.split(":")[1]), offset: Number(input.split(":")[2]) });
    if (input.startsWith("复用:")) return call({ action: "delegate", content: "再分析", agent: Number(input.split(":")[1]) });
    if (input.startsWith("关闭:")) return call({ action: "close", agent: Number(input.split(":")[1]) });
    if (input === "列表") return call({ action: "list" });
    return { kind: "text", text: "继续聊天" };
  });
  const p = await f.open();
  const registered = JSON.parse(await p.answer("委派", "owner-a")) as { work: number; agent: number; state: string };
  assert.equal(registered.state, "registered");
  const work = await ref(p); assert.equal(registered.work, work.taskId);
  assert.equal(await p.answer("继续", "chat"), "继续聊天");
  assert.match(await p.answer(`查询:${work.taskId}:0`, "running"), /running|waiting/);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.source!.requestId, "owner-a");
  release(); await p.harness.waitForTask(work.taskId, context);
  const first = JSON.parse(await p.answer(`查询:${work.taskId}:0`, "page1")) as { text: string; nextOffset: number };
  const second = JSON.parse(await p.answer(`查询:${work.taskId}:${first.nextOffset}`, "page2")) as { text: string; nextOffset?: number };
  assert.equal(first.text + second.text, answer); assert.equal(second.nextOffset, undefined);
  const next = JSON.parse(await p.answer(`复用:${work.agentId}`, "reuse")) as { work: number; agent: number };
  assert.equal(next.agent, work.agentId); await p.harness.waitForTask(next.work as TaskId, context);
  assert.match(await p.answer("列表", "list"), /分析员/);
  assert.match(await p.answer(`关闭:${work.agentId}`, "close"), /closed/);
  assert.match(await p.answer(`复用:${work.agentId}`, "closed-reuse"), /subagent_closed/);
  const child = (await p.harness.conversation(work.agentId, context))!;
  assert.equal((await child.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "pi.user").length, 2);
  for (const request of f.server.calls.filter(childRequest)) assert.deepEqual(request.tools ?? [], []);
  const entries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const evidence = entries.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
  assert.match(JSON.stringify(evidence[0].input), /background_work/); assert.deepEqual(evidence[1].payload, f.server.calls[0].raw);
  await p.close(); const restored = await f.open(); assert.equal((await restored.work.list())[0].closed, true);
});

test("模型工作：取消停止原工作且身份可复用，回报输入只可读不能变更", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  let target: PersonalWorkRef | undefined;
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await gate; return { kind: "text", text: "迟到结果" }; }
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: resultText(request) };
    const content = request.messages.at(-1)?.content;
    if (content === "取消") return call({ action: "cancel", work: target!.taskId });
    if (content === "关闭") return call({ action: "close", agent: target!.agentId });
    if (content === "列表") return call({ action: "list" });
    return call({ action: "delegate", content: "等待分析" });
  });
  const p = await f.open(); await p.answer("委派", "owner"); target = await ref(p);
  for (const text of ["委派", "取消", "关闭"]) {
    const input = await p.main.submit({ type: "input", content: text, requestId: `report-${text}`, entry: { kind: "ruukoto.work-report", data: {} }, whenBusy: "followUp" }, context);
    await input.wait(context);
    const tools = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
    assert.match(JSON.stringify(tools.at(-1)), /work_source_invalid/);
  }
  const read = await p.main.submit({ type: "input", content: "列表", requestId: "report-list", entry: { kind: "ruukoto.work-report", data: {} } }, context); await read.wait(context);
  const last = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult").at(-1)!;
  assert.equal(last.isError, false);
  assert.match(await p.answer("取消", "cancel"), /stopped/);
  assert.equal((await p.work.status(target)).task.state.status, "terminal"); assert.equal((await p.work.list())[0].work, undefined);
  release(); assert.match(await p.answer("关闭", "close"), /closed/);
});

test("模型工作：取消处理 faulted 不声称已停止，保留原占用并报告未核实", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  let target: PersonalWorkRef;
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await gate; return { kind: "text", text: "迟到" }; }
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: resultText(request) };
    return request.messages.at(-1)?.content === "取消" ? call({ action: "cancel", work: target.taskId }) : call({ action: "delegate", content: "分析" });
  });
  const p = await f.open(); await p.answer("委派", "owner"); target = await ref(p);
  await until(() => f.server.calls.some(childRequest));
  await p.harness.commit(async tx => { (await tx.doc(PersonalAgentsDoc)).agents[0].work!.taskId = 999999 as PersonalWorkRef["taskId"]; }, context);
  assert.match(await p.answer("取消", "cancel"), /stop_unverified/);
  assert.equal((await p.work.status(target)).task.state.status, "terminal");
  assert.equal((await p.harness.waitForTask(target.taskId, context)).state.outcome.status, "faulted");
  assert.ok((await p.harness.snapshot(LiveDoc, target.agentId, context))?.run);
  assert.ok((await p.work.list())[0].work);
});

test("模型工作：伪造/失活工具拒绝，非法参数不建立工作", async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.role === "tool" ? { kind: "text", text: resultText(request) } : call({ action: "delegate", content: "分析", sourceRequestId: "fake" }));
  const p = await f.open();
  assert.match(await p.answer("委派", "invalid"), /sourceRequestId|invalid|Invalid|additional/i);
  assert.equal((await p.work.list()).length, 0);
  await assert.rejects(p.harness.commit(tx => personalToolSource(tx, { taskId: 999999 as TaskId, conversationId: ROOT_CONVERSATION_ID }, true), context), code("work_tool_inactive"));
});

test("模型工作：多来源不能猜最新输入，拒绝委派且不创建身份", async t => {
  let p!: PersonalHarness;
  const f = await fixture(t, async request => {
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: resultText(request) };
    await p.harness.commit(async tx => { const run = (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).run!; run.inputs.push(run.inputs[0]); }, context);
    return call({ action: "delegate", content: "分析" });
  });
  p = await f.open();
  assert.match(await p.answer("委派", "owner"), /work_source_ambiguous/);
  assert.equal((await p.work.list()).length, 0);
});

test("模型工作：原工具重放只登记一项，同键异参不另建身份", async t => {
  const f = await fixture(t, request => childRequest(request) ? { kind: "text", text: "分析完成" } : request.messages.at(-1)?.role === "tool" ? { kind: "text", text: resultText(request) } : call({ action: "delegate", content: "分析" }));
  const p = await f.open(); await p.answer("委派", "owner"); const work = await ref(p); await p.harness.waitForTask(work.taskId, context);
  assert.deepEqual(await p.work.delegate({ requestId: work.requestId, sourceRequestId: "owner", content: "分析" }), work);
  await assert.rejects(p.work.delegate({ requestId: work.requestId, sourceRequestId: "owner", content: "另一项" }), code("work_request_conflict"));
  assert.equal((await p.work.list()).length, 1);
});

test("模型工作：登记成功但工具应答前真实强杀，恢复原工具只保留一项工作", async t => {
  const f = await fixture(t, request => childRequest(request) ? { kind: "text", text: "分析完成" } : request.messages.at(-1)?.role === "tool" ? { kind: "text", text: "已登记" } : call({ action: "delegate", content: "分析" }));
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,config}=JSON.parse(process.env.RUUKOTO_MODEL_WORK_CRASH); const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,openStorage:async file=>{const s=await openNodeSqliteStorage(file);const commit=s.commit.bind(s);s.commit=async(writes,c)=>{await commit(writes,c);if(writes.some(w=>w.type==="task"&&w.value.kind==="ruukoto.background-work")){process.stdout.write("registered-gap\\n");await new Promise(()=>{});}};return s;}});await p.answer("委派","owner");`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, RUUKOTO_MODEL_WORK_CRASH: JSON.stringify({ directory: f.directory, config: f.config }) }, stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; } });
  let output = ""; let stderr = ""; child.stdout.on("data", value => { output += String(value); }); child.stderr.on("data", value => { stderr += String(value); });
  await until(() => { assert.equal(child.exitCode, null, stderr); return output.includes("registered-gap"); });
  child.kill("SIGKILL"); await exit;
  const p = await f.open(); const work = await ref(p); await p.harness.waitForTask(work.taskId, context);
  const owner = await p.harness.submission((await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner"), context))!.id, context); await owner!.wait(context);
  assert.equal((await p.work.list()).length, 1);
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.background-work" }, 16), context)).items.length, 1);
  const conversation = (await p.harness.conversation(work.agentId, context))!;
  assert.equal((await conversation.entries({}, 256, undefined, context)).items.filter(entry => entry.kind === "pi.user").length, 1);
});

test("模型工作：工具关系、权限或标记缺失在恢复前拒绝，零新模型请求", async t => {
  for (const mutation of ["call", "permission", "marker"] as const) await t.test(mutation, async t => {
    const f = await fixture(t, request => childRequest(request) ? { kind: "text", text: "分析完成" } : request.messages.at(-1)?.role === "tool" ? { kind: "text", text: resultText(request) } : call({ action: "delegate", content: "分析" }));
    const p = await f.open(); await p.answer("委派", "owner"); const work = await ref(p); await p.harness.waitForTask(work.taskId, context);
    await p.harness.commit(async tx => {
      const facts = await tx.doc(PersonalWorkDoc, work.requestId, null);
      if (mutation === "call") delete facts.modelCall;
      else if (mutation === "permission") delete facts.permission;
      else { const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== "personal-model-work"); }
    }, context);
    await p.close(); const before = f.server.calls.length;
    await assert.rejects(f.open(), code("work_record_missing")); assert.equal(f.server.calls.length, before);
  });
});

test("模型工作：首次启用有未决输入先拒绝，不固化扩展，旧程序可恢复", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "完成" }));
  const p = await f.open(); await p.answer("旧输入", "old");
  await p.harness.commit(async tx => { const config = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(config.extensions)); config.extensions = config.extensions.filter(name => name !== "personal-model-work"); config.tools = []; }, context);
  await p.close();
  const restored = await f.open();
  assert.ok((await restored.main.agent(context)).extensions.some(extension => extension.name === "personal-model-work"));
  await restored.harness.commit(async tx => {
    const config = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(config.extensions)); config.extensions = config.extensions.filter(name => name !== "personal-model-work"); config.tools = [];
    const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "未完成", timestamp: Date.now() }] });
    await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, type: "input", requestId: "pending", status: "placed", entry: entry.id });
  }, context);
  await restored.close(); const before = f.server.calls.length;
  await assert.rejects(f.open(), code("work_tools_pending")); assert.equal(f.server.calls.length, before);
});
