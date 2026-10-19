import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AgentDoc, ROOT_CONVERSATION_ID, type SubmissionId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { checkPersonalInput, managePersonalWorks, pendingPersonalInputs, preparePersonalInput } from "../apps/ruukoto/src/personal-cli.ts";
import { PersonalWorkDoc, PersonalWorkTask, personalWorkResult, verifyPersonalWorkNotes, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer as MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent");
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待追加说明超时"); await delay(5); }
}
function gate(t: TestContext) {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  return { wait, release };
}
async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "完成" })) {
  const directory = fs.mkdtempSync("/tmp/rk-work-notes-");
  const model = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_WORK_NOTE_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  await savePersonalConfig(directory, config);
  let p: PersonalHarness;
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { await server?.stop(); await p?.close(); await model.close(); fs.rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; });
  return { directory, config, model,
    open: async () => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId }),
    start: async () => { await savePersonalConfig(directory, config); server = await startPersonalServer(directory); return server; },
  };
}
async function delegate(p: PersonalHarness, requestId = "work") {
  await p.answer("拥有者来源", "owner");
  return p.work.delegate({ content: "初始分析", requestId, sourceRequestId: "owner" });
}
const note = (requestId: string, content = requestId) => ({ requestId, content, sourceRequestId: "owner" });

test("追加说明：顺序接纳、去重与最后回答，同工作占用/权限保持且不阻塞主聊天", async t => {
  const initial = gate(t), last = gate(t);
  const f = await fixture(t, async request => {
    if (child(request) && request.messages.at(-1)?.content === "初始分析") await initial.wait;
    if (child(request) && request.messages.at(-1)?.content === "第二条") await last.wait;
    return { kind: "text", text: `回答:${request.messages.at(-1)?.content}` };
  });
  let p = await f.open(); const ref = await delegate(p);
  await until(() => f.model.calls.some(child));
  const permission = (await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!.permission;
  await p.work.append(ref, note("第一条")); await p.work.append(ref, note("第二条")); await p.work.append(ref, note("第一条"));
  await assert.rejects(p.work.append(ref, note("第一条", "异参")), code("work_request_conflict"));
  assert.match(await p.answer("继续聊天", "chat"), /继续聊天/);
  initial.release(); await until(() => f.model.calls.filter(child).length === 3);
  await assert.rejects(p.work.delegate({ content: "另一工作", requestId: "other", sourceRequestId: "owner", agentId: ref.agentId }), code("subagent_busy"));
  last.release(); assert.equal((await p.harness.waitForTask(ref.taskId, context)).state.outcome.status, "completed");
  assert.equal((await p.harness.commit(tx => personalWorkResult(tx, ref), context)).text, "回答:第二条");
  assert.deepEqual(f.model.calls.filter(child).map(request => request.messages.at(-1)?.content), ["初始分析", "第一条", "第二条"]);
  assert.deepEqual((await p.harness.snapshot(PersonalWorkDoc, ref.requestId, context))!.permission, permission);
  await p.work.append(ref, note("第一条"));
  await assert.rejects(p.work.append(ref, note("太迟")), code("work_inactive"));
  const reused = await p.work.delegate({ content: "新工作", requestId: "reuse", sourceRequestId: "owner", agentId: ref.agentId });
  await assert.rejects(p.work.append(ref, note("旧菜单")), code("work_inactive"));
  await p.harness.waitForTask(reused.taskId, context); await p.close(); p = await f.open();
  assert.equal((await p.harness.commit(tx => personalWorkResult(tx, ref), context)).text, "回答:第二条");
});

test("追加说明：前轮失败停止后续说明，取消拦住新说明且收齐原占用", async t => {
  for (const ending of ["failed", "cancel"] as const) await t.test(ending, async t => {
    const initial = gate(t);
    const f = await fixture(t, async request => { if (child(request)) await initial.wait; return { kind: "text", text: "完成" }; });
    const p = await f.open(); const ref = await delegate(p); await until(() => f.model.calls.some(child));
    await p.work.append(ref, note("未执行的说明"));
    if (ending === "failed") { delete process.env[f.config.apiKeyEnv]; initial.release(); }
    else await p.work.cancel(ref);
    const done = await p.harness.waitForTask(ref.taskId, context);
    assert.equal(done.state.outcome.status, ending === "failed" ? "failed" : "aborted");
    assert.equal((await p.harness.commit(tx => personalWorkResult(tx, ref), context)).text, undefined);
    await assert.rejects(p.work.append(ref, note("取消后")), code("work_inactive"));
    assert.equal(f.model.calls.filter(child).length, 1); assert.equal((await p.work.list())[0].work, undefined);
  });
});

test("追加说明：原回答 done 至 abort、abort 至最终事务两个窗口仍完整处理", async t => {
  for (const window of ["before-stop", "after-stop"] as const) await t.test(window, async t => {
    const f = await fixture(t); const p = await f.open(); let target: PersonalWorkRef | undefined; let inserted = false;
    const original = PersonalWorkTask.definition.phases.run;
    t.mock.method(PersonalWorkTask.definition.phases, "run", async (...[task, runtime, context]: Parameters<typeof original>) => original(task, { ...runtime, conversation: async (id, context) => {
      const conversation = await runtime.conversation(id, context); if (!conversation) return conversation;
      return { ...conversation, abort: async (...args: Parameters<typeof conversation.abort>) => {
        const append = async () => { if (!inserted) { inserted = true; await p.work.append(target!, note(window)); } };
        if (window === "before-stop") await append();
        await conversation.abort(...args);
        if (window === "after-stop") await append();
      } };
    } }, context));
    target = await delegate(p); await p.harness.waitForTask(target.taskId, context);
    assert.ok(inserted); assert.equal(f.model.calls.filter(child).length, 2);
    assert.equal((await p.harness.commit(tx => personalWorkResult(tx, target!), context)).state, "completed");
  });
});

test("追加说明：CLI 原键/目标保留，重复受理不重做，旧待核实文件规则不扫描追加", async t => {
  const initial = gate(t);
  const f = await fixture(t, async request => { if (child(request) && request.messages.at(-1)?.content === "初始分析") await initial.wait; return { kind: "text", text: "完成" }; });
  const p = await f.open(); const ref = await delegate(p); await until(() => f.model.calls.some(child)); await p.close();
  await f.start(); await until(() => f.model.calls.filter(child).length === 2);
  const input = preparePersonalInput(f.directory, "本机追加", ref.taskId);
  assert.deepEqual(pendingPersonalInputs(f.directory), [input]);
  assert.equal(fs.readdirSync(f.directory).filter(name => /^pending-[0-9a-f-]+\.json$/.test(name)).length, 0);
  assert.equal((await checkPersonalInput(f.directory, input)).status, "missing");
  await personalControl(f.directory, "POST", "/work/notes", input);
  await personalControl(f.directory, "POST", "/work/notes", input);
  await assert.rejects(personalControl(f.directory, "POST", "/work/notes", { ...input, work: undefined }), code("input_invalid"));
  await assert.rejects(personalControl(f.directory, "POST", "/work/notes", { requestId: input.requestId, input: input.input }), code("input_invalid"));
  const result = await checkPersonalInput(f.directory, input); assert.equal(result.status, "done"); assert.match(result.answer!, /已接纳/);
  assert.deepEqual(pendingPersonalInputs(f.directory), []);
  const lost = preparePersonalInput(f.directory, "应答丢失的追加", ref.taskId);
  const proxyDirectory = fs.mkdtempSync("/tmp/rk-note-proxy-"); fs.writeFileSync(path.join(proxyDirectory, "control.token"), "a".repeat(64));
  const proxy = http.createServer(async (request, response) => { for await (const chunk of request) void chunk; await personalControl(f.directory, "POST", "/work/notes", lost); response.destroy(); });
  proxy.listen(path.join(proxyDirectory, "control.sock")); await once(proxy, "listening");
  try {
    await assert.rejects(personalControl(proxyDirectory, "POST", "/work/notes", lost), code("control_response_lost"));
    assert.deepEqual(pendingPersonalInputs(f.directory), [lost]);
    assert.equal((await checkPersonalInput(f.directory, lost)).status, "done");
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); fs.rmSync(proxyDirectory, { recursive: true, force: true }); }
  const choices = ["1", "6", "向导追加", "5", "2"]; let output = "";
  await managePersonalWorks({ question: async () => choices.shift()!, write: text => { output += text; } }, f.directory);
  assert.match(output, /原分析已接纳说明/); assert.equal(choices.length, 0);
  initial.release();
  await until(async () => (await personalControl<{ summary: { state: string; notes: number } }>(f.directory, "GET", `/work?work=${ref.taskId}`)).summary.state === "completed");
  assert.equal(f.model.calls.filter(child).length, 5);
  assert.equal(f.model.calls.filter(request => !child(request)).length, 1);
});

test("追加说明：模型 append 使用当前拥有者输入和工具原键，回报不能变更", async t => {
  const initial = gate(t); let target: PersonalWorkRef;
  const f = await fixture(t, async request => {
    if (child(request)) { if (request.messages.at(-1)?.content === "初始分析") await initial.wait; return { kind: "text", text: "追加结果" }; }
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: String(request.messages.at(-1)?.content) };
    if (request.messages.at(-1)?.content === "追加") return { kind: "tool_calls", calls: [{ id: "append", name: "background_work", arguments: { action: "append", work: target.taskId, content: "模型追加" } }] };
    return { kind: "text", text: "收到" };
  });
  const p = await f.open(); target = await delegate(p); await until(() => f.model.calls.some(child));
  assert.match(await p.answer("追加", "note-owner"), /note_accepted/);
  const report = await p.main.submit({ type: "input", content: "追加", requestId: "report", entry: { kind: "ruukoto.work-report", data: {} } }, context); await report.wait(context);
  const work = (await p.harness.snapshot(PersonalWorkDoc, target.requestId, context))!;
  assert.equal(work.notes?.length, 1); assert.match(work.notes[0].requestId, /^personal-note-tool:/);
  initial.release(); await p.harness.waitForTask(target.taskId, context); await p.close(); await f.open();
});

test("追加说明：其他模型工具不能冒充 append 的恢复来源", async t => {
  const initial = gate(t);
  const f = await fixture(t, async request => {
    if (child(request)) await initial.wait;
    if (request.messages.at(-1)?.content === "列表") return { kind: "tool_calls", calls: [{ id: "list", name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: "完成" };
  });
  const p = await f.open(); const ref = await delegate(p); await until(() => f.model.calls.some(child));
  await p.answer("列表", "list-source");
  const call = (await p.harness.commit(tx => tx.scanTasks({ kind: "pi.tool" }, 1), context)).items[0]!;
  await p.work.append(ref, note("note"));
  await p.harness.commit(async tx => {
    const saved = (await tx.doc(PersonalWorkDoc, ref.requestId, null)).notes![0];
    assert.equal(saved.source.kind, "input"); if (saved.source.kind !== "input") return;
    saved.requestId = `personal-note-tool:${call.id}`; saved.source.modelCall = call.id;
  }, context);
  await assert.rejects(p.harness.commit(tx => verifyPersonalWorkNotes(tx, ref, true), context), code("work_note_invalid"));
  await p.work.cancel(ref);
});

test("追加说明：接纳、admission、模型在途及回答完成四个强杀窗口按原键恢复", { timeout: 20000 }, async t => {
  for (const gap of ["accepted", "admission", "running", "done"] as const) await t.test(gap, async t => {
    const f = await fixture(t, request => ({ kind: "text", text: child(request) ? "分析内容".repeat(100) : "收到", chunkDelayMs: child(request) ? 10 : 0 }));
    const p = await f.open(); await p.answer("拥有者来源", "owner"); await p.close();
    const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,config,gap}=JSON.parse(process.env.RUUKOTO_NOTE_TEST); setInterval(()=>{},1000); const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename); const commit=s.commit.bind(s);s.commit=async(writes,c)=>{await commit(writes,c);if(writes.some(w=>w.type==="submission"&&w.value.requestId?.includes(":note:")&&(gap==="admission"||gap==="done"&&w.value.status==="done"))){process.stdout.write("note-gap\\n");await new Promise(()=>{});}};return s;}}); const ref=await p.work.delegate({content:"初始分析",requestId:"crash",sourceRequestId:"owner"});await p.work.append(ref,{requestId:"note",content:"崩溃追加",sourceRequestId:"owner"});if(gap==="accepted")process.stdout.write("note-gap\\n");`;
    const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_NOTE_TEST: JSON.stringify({ directory: f.directory, config: f.config, gap }) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; processChild.stdout.on("data", data => { stdout += data; }); processChild.stderr.pipe(process.stderr);
    t.after(() => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); });
    await until(() => gap === "running" ? f.model.calls.some(request => request.messages.at(-1)?.content === "崩溃追加") : stdout.includes("note-gap"));
    const exited = once(processChild, "exit"); processChild.kill("SIGKILL"); await exited;
    const restored = await f.open(); const work = (await restored.harness.snapshot(PersonalWorkDoc, "crash", context))!;
    assert.equal((await restored.harness.waitForTask(work.ref!.taskId, context)).state.outcome.status, "completed");
    const conversation = (await restored.harness.conversation(work.ref!.agentId, context))!;
    assert.equal((await conversation.entries({}, 256, undefined, context)).items.filter(entry => entry.kind === "pi.user").length, 2);
    assert.equal((await restored.harness.commit(tx => personalWorkResult(tx, work.ref!), context)).text, "分析内容".repeat(100));
  });
});

test("追加说明：缺扩展、原来源或原生输入引用在恢复前拒绝", async t => {
  for (const mutation of ["extension", "source", "submission", "missing-model-call"] as const) await t.test(mutation, async t => {
    const initial = gate(t);
    const f = await fixture(t, async request => { if (child(request) && request.messages.at(-1)?.content === "初始分析") await initial.wait; return { kind: "text", text: "完成" }; });
    const p = await f.open(); const ref = await delegate(p); await p.work.append(ref, note("note")); initial.release(); await p.harness.waitForTask(ref.taskId, context);
    await p.harness.commit(async tx => {
      if (mutation === "extension") { const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== "personal-work-notes"); }
      else { const saved = (await tx.doc(PersonalWorkDoc, ref.requestId, null)).notes![0]; if (mutation === "source") { assert.equal(saved.source.kind, "input"); if (saved.source.kind === "input") saved.source.requestId = "missing"; } else if (mutation === "submission") saved.submissionId = 999999 as SubmissionId; else saved.requestId = "personal-note-tool:999"; }
    }, context); await p.close(); const count = f.model.calls.length;
    await assert.rejects(f.open(), code("work_note_invalid")); assert.equal(f.model.calls.length, count);
  });
});
