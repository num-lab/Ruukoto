import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, CompactionTask, configure, ProviderDoc, ROOT_CONVERSATION_ID, SessionFailed, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalAgentsDoc, PersonalWorkDoc, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, "等待后台工作超时"); await delay(5); }
}
async function fixture(t: TestContext, respond: Responder = () => ({ kind: "text", text: "完成" })) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "rk-work-"));
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_DURABLE_WORK_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const previous = process.env[config.apiKeyEnv];
  process.env[config.apiKeyEnv] = "test-only";
  const options = { directory, provider: personalProvider(config), modelId: config.modelId };
  let personal: PersonalHarness | undefined;
  t.after(async () => {
    await personal?.close();
    await server.close();
    if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, server, config, options,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => personal = await openPersonalHarness({ ...options, ...overrides }),
  };
}
async function source(personal: PersonalHarness) { await personal.answer("拥有者委派来源", "owner-source"); }
const draft = (requestId: string, agentId?: PersonalWorkRef["agentId"]) => ({ content: "后台分析", requestId, sourceRequestId: "owner-source", ...(agentId ? { agentId } : {}) });

test("后台工作：同键去重异参拒绝，完成后保留身份/上下文，显式关闭保留历史", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await source(personal);
  const ref = await personal.work.delegate({ ...draft("first"), label: "资料整理" });
  assert.deepEqual(await personal.work.delegate({ ...draft("first"), label: "资料整理" }), ref);
  await assert.rejects(personal.work.delegate({ ...draft("first"), content: "另一工作" }), code("work_request_conflict"));
  const first = await personal.harness.waitForTask(ref.taskId, context);
  assert.equal(first.state.outcome.status, "completed");
  assert.equal((await personal.work.list())[0].work, undefined);
  const next = await personal.work.delegate(draft("second", ref.agentId));
  await personal.harness.waitForTask(next.taskId, context);
  assert.equal(next.agentId, ref.agentId);
  const child = (await personal.harness.conversation(ref.agentId, context))!;
  const history = (await child.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.equal(history.filter(entry => entry.kind === "pi.user").length, 2);
  const lastRequest = f.server.calls.at(-1)!;
  assert.equal(lastRequest.messages.filter(message => message.role === "user").length, 2);
  assert.deepEqual((await child.agent(context)).tools.map(tool => tool.name), ["memory", "history_search", "history_read", "skill"]);
  assert.match(lastRequest.system!, /子 Agent/);
  assert.deepEqual(lastRequest.tools?.map(tool => (tool.function as { name: string }).name), ["memory", "history_search", "history_read", "skill"]);
  const evidence = history.filter(entry => entry.kind === "ruukoto.model-request").map(entry => entry.data as RequestEvidence);
  assert.equal(evidence.length, 4);
  assert.deepEqual(evidence.at(-1)!.payload, lastRequest.raw);
  const mainEntries = (await personal.main.entries({}, 256, undefined, context)).items;
  assert.equal(mainEntries.filter(entry => entry.kind === "ruukoto.model-request").length, 2);
  await personal.work.closeAgent(ref.agentId);
  await personal.work.closeAgent(ref.agentId);
  await assert.rejects(personal.work.delegate(draft("closed", ref.agentId)), code("subagent_closed"));
  assert.equal((await child.entries({}, 256, undefined, context)).items.length, history.length);
  await personal.close();
  const reopened = await f.open();
  assert.equal((await reopened.work.list())[0].closed, true);
  assert.equal((await reopened.work.status(next)).submission?.status, "done");
});

test("后台工作：忙碌占用拒绝另一工作/关闭，取消 A 不影响主聊天和 B，迟到结果不覆盖复用", async t => {
  let finishA!: () => void;
  const aResponse = new Promise<void>(resolve => { finishA = resolve; });
  const f = await fixture(t, async request => {
    if (request.messages.at(-1)?.content === "等待 A") { await aResponse; return { kind: "text", text: "迟到 A" }; }
    return { kind: "text", text: "完成" };
  });
  t.after(finishA);
  const personal = await f.open();
  await source(personal);
  const a = await personal.work.delegate({ ...draft("a"), content: "等待 A" });
  await until(() => f.server.calls.length === 2);
  await assert.rejects(personal.work.delegate(draft("occupied", a.agentId)), code("subagent_busy"));
  await assert.rejects(personal.work.closeAgent(a.agentId), code("subagent_busy"));
  const b = await personal.work.delegate(draft("b"));
  assert.equal(await personal.answer("继续聊天", "chat"), "完成");
  await personal.main.abort(context);
  assert.equal((await personal.work.status(a)).task.state.status, "running");
  const cancelled = await personal.work.cancel(a);
  assert.equal(cancelled.state.outcome.status, "aborted");
  assert.equal((await personal.work.status(a)).cancelRequested, true);
  assert.equal((await personal.harness.waitForTask(b.taskId, context)).state.outcome.status, "completed");
  const reused = await personal.work.delegate(draft("reused", a.agentId));
  finishA();
  await personal.harness.waitForTask(reused.taskId, context);
  const child = (await personal.harness.conversation(a.agentId, context))!;
  assert.doesNotMatch(JSON.stringify((await child.context(context)).messages), /迟到 A/);
  assert.equal((await personal.work.list()).find(agent => agent.id === a.agentId)!.work, undefined);
  assert.equal((await personal.work.status(reused)).submission?.status, "done");
});

test("后台工作：拒绝无来源/回报来源且不造记录", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await assert.rejects(personal.work.delegate(draft("no-source")), code("work_source_invalid"));
  const passive = await personal.main.submit({ type: "write", requestId: "report", entry: { kind: "ruukoto.work-report", data: {} } }, context);
  await passive.wait(context);
  await assert.rejects(personal.work.delegate({ ...draft("report"), sourceRequestId: "report" }), code("work_source_invalid"));
  assert.equal((await personal.work.list()).length, 0);
  assert.equal(f.server.calls.length, 0);
  assert.equal(await personal.harness.snapshot(PersonalWorkDoc, "no-source", context), undefined);
});

test("后台工作：工作登记写失败，身份/Task/占用全不提交，重开不执行", async t => {
  const f = await fixture(t);
  const first = await f.open(); await source(first); await first.close();
  const cause = new Error("work-storage-failed");
  const personal = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename);
    const commit = storage.commit.bind(storage);
    storage.commit = (writes, context) => writes.some(write => write.type === "task" && write.value.kind === "ruukoto.background-work") ? Promise.reject(cause) : commit(writes, context);
    return storage;
  } });
  await assert.rejects(personal.work.delegate(draft("failed-commit")), error => error === cause || error instanceof SessionFailed);
  await personal.harness.closed;
  const reopened = await f.open();
  assert.equal((await reopened.work.list()).length, 0);
  assert.equal((await reopened.harness.inspect(context)).tasks.length, 0);
  assert.equal(f.server.calls.length, 1);
});

test("后台工作：只落盘取消事实、尚未 abortTask 的窗口正常收尾为取消并可复用", async t => {
  const f = await fixture(t, request => ({ kind: "text", text: "逐帧完成".repeat(request.messages.at(-1)?.content === "后台分析" ? 30 : 1), chunkDelayMs: 10 }));
  const personal = await f.open(); await source(personal);
  const ref = await personal.work.delegate(draft("cancel-gap"));
  await until(() => f.server.calls.length === 2);
  await personal.harness.commit(async tx => { (await tx.doc(PersonalWorkDoc, ref.requestId, null)).cancelRequested = true; }, context);
  const result = await personal.harness.waitForTask(ref.taskId, context);
  assert.equal(result.state.outcome.status, "aborted");
  assert.equal((await personal.work.list())[0].work, undefined);
  const next = await personal.work.delegate(draft("after-gap", ref.agentId));
  assert.equal((await personal.harness.waitForTask(next.taskId, context)).state.outcome.status, "completed");
});

test("后台工作：HTTP 发出前再次检查取消事实及 provider 来源，零子请求", async t => {
  for (const mutation of ["cancel", "missing-provider"] as const) await t.test(mutation, async t => {
    const f = await fixture(t);
    let personal!: PersonalHarness;
    let ref: PersonalWorkRef | undefined;
    const base = f.options.provider;
    personal = await f.open({ provider: { ...base, streamSimple: (model, input, options) => base.streamSimple(model, input, { ...options, onPayload: async payload => {
      if (ref) await personal.harness.commit(async tx => {
        if (mutation === "cancel") (await tx.doc(PersonalWorkDoc, ref!.requestId, null)).cancelRequested = true;
        else await tx.retireDoc(ProviderDoc, ref!.agentId);
      }, context);
      return await options?.onPayload?.(payload, model) ?? payload;
    } }) } });
    await source(personal);
    ref = await personal.work.delegate(draft("payload-gap"));
    const result = await personal.harness.waitForTask(ref.taskId, context);
    assert.equal(result.state.outcome.status, mutation === "cancel" ? "aborted" : "failed");
    assert.equal(f.server.calls.length, 1);
  });
});

test("后台工作：子会话 provider 失败如实收尾，释放已闲置身份", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await source(personal);
  delete process.env[f.config.apiKeyEnv];
  const ref = await personal.work.delegate(draft("provider-error"));
  const result = await personal.harness.waitForTask(ref.taskId, context);
  assert.equal(result.state.outcome.status, "failed");
  assert.equal((await personal.work.status(ref)).submission?.status, "unanswered");
  assert.equal((await personal.work.list())[0].work, undefined);
  assert.equal(f.server.calls.length, 1);
});

test("后台工作：空闲/取消后的子会话不能绕过宿主直接发模型请求，证据缺失或歧义也拦截", async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await source(personal);
  const ref = await personal.work.delegate(draft("done"));
  await personal.harness.waitForTask(ref.taskId, context);
  const child = (await personal.harness.conversation(ref.agentId, context))!;
  const extra = await child.submit({ type: "input", content: "越过工作", requestId: "bypass" }, context);
  assert.equal((await extra.wait(context)).status, "unanswered");
  assert.equal(f.server.calls.length, 2);
  await personal.harness.commit(async tx => { (await tx.doc(ProviderDoc, child.id)).sessionId = (await tx.doc(ProviderDoc, personal.main.id)).sessionId; }, context);
  await assert.rejects(personal.answer("重复来源", "ambiguous"), code("input_unanswered"));
  assert.equal(f.server.calls.length, 2);
});

test("后台工作：工作扩展缺索引、版本变化和终态遗留占用均拒绝重开", async t => {
  for (const mutation of ["missing-index", "missing-agent-row", "index-version", "work-version", "orphan-occupancy", "expanded-tools", "request-mismatch", "submission-mismatch", "live-occupancy"] as const) await t.test(mutation, async t => {
    const f = await fixture(t, (_request, index) => ({ kind: "text", text: mutation === "live-occupancy" && index > 0 ? "尚未完成".repeat(100) : "完成", chunkDelayMs: mutation === "live-occupancy" && index > 0 ? 40 : 0 }));
    const personal = await f.open();
    await source(personal);
    const ref = await personal.work.delegate(draft("work"));
    if (mutation === "live-occupancy") await until(() => f.server.calls.length === 2); else await personal.harness.waitForTask(ref.taskId, context);
    if (mutation === "missing-index") await personal.harness.commit(tx => tx.retireDoc(PersonalAgentsDoc), context);
    if (mutation === "missing-agent-row") await personal.harness.commit(async tx => { (await tx.doc(PersonalAgentsDoc)).agents = []; await tx.retireDoc(PersonalWorkDoc, ref.requestId); }, context);
    if (mutation === "orphan-occupancy") await personal.harness.commit(async tx => { (await tx.doc(PersonalAgentsDoc)).agents[0].work = ref; }, context);
    if (mutation === "expanded-tools") await personal.harness.commit(async tx => { delete (await tx.doc(AgentDoc, ref.agentId)).tools; }, context);
    if (mutation === "request-mismatch") await personal.harness.commit(async tx => { (await tx.doc(PersonalWorkDoc, ref.requestId, null)).ref!.requestId = "wrong-key"; }, context);
    if (mutation === "submission-mismatch") await personal.harness.commit(async tx => { (await tx.doc(PersonalWorkDoc, ref.requestId, null)).submissionId = (await tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-source"))!.id; }, context);
    if (mutation === "live-occupancy") await personal.harness.commit(async tx => { delete (await tx.doc(PersonalAgentsDoc)).agents[0].work; }, context);
    await personal.close();
    if (mutation.endsWith("version")) {
      const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
      const record = await storage.findDocument({ kind: mutation === "index-version" ? PersonalAgentsDoc.definition.kind : PersonalWorkDoc.definition.kind, scope: { kind: "session" }, ...(mutation === "work-version" ? { key: "work" } : {}) }, "current", context);
      const saved = (await storage.document(record!.id, "current", context))!;
      await storage.commit([{ type: "document.change", id: record!.id, content: { kind: "base", version: 2, value: saved.value } }], context);
      await storage.close(context);
    }
    const expected = { "missing-index": "work_index_missing", "missing-agent-row": "work_index_missing", "index-version": "work_version", "work-version": "work_version", "orphan-occupancy": "work_ownership", "expanded-tools": "work_config_changed", "request-mismatch": "work_ownership", "submission-mismatch": "work_record_missing", "live-occupancy": "work_ownership" };
    await assert.rejects(f.open(), code(expected[mutation]));
    assert.equal(f.server.calls.length, 2);
  });
});

test("后台工作：空闲子会话显式同步当前模型配置", async t => {
  const f = await fixture(t);
  const personal = await f.open(); await source(personal);
  const ref = await personal.work.delegate(draft("model"));
  await personal.harness.waitForTask(ref.taskId, context);
  await personal.harness.commit(tx => configure(tx, ref.agentId, { model: { provider: "unavailable", modelId: "old" } }), context);
  await personal.close();
  const reopened = await f.open();
  assert.deepEqual((await (await reopened.harness.conversation(ref.agentId, context))!.agent(context)).model, { provider: "personal", modelId: "mock-model" });
  assert.equal(f.server.calls.length, 2);
});

test("后台工作：正常/取消收尾都停止在途的真正后台压缩，再释放身份", async t => {
  for (const ending of ["complete", "cancel"] as const) await t.test(ending, async t => {
    let finish!: () => void;
    const response = new Promise<void>(resolve => { finish = resolve; });
    const f = await fixture(t, async (_request, index) => {
      if (index === 2) { await response; return { kind: "text", text: "工作完成" }; }
      return { kind: "text", text: index < 2 ? "完成" : "后台摘要".repeat(100), chunkDelayMs: index < 2 ? 0 : 100 };
    });
    t.after(finish);
    const personal = await f.open(); await source(personal);
    const first = await personal.work.delegate(draft("history"));
    await personal.harness.waitForTask(first.taskId, context);
    // 超过 keepRecentTokens 且有可切分历史，保证摘要真正发出请求。
    await personal.harness.commit(async tx => {
      await tx.appendEntry(first.agentId, { kind: "ruukoto.test-history", data: {}, model: [{ role: "user", content: "history ".repeat(16000), timestamp: 1 }] });
      await tx.appendEntry(first.agentId, { kind: "ruukoto.test-history", data: {}, model: [{ role: "user", content: "最近内容", timestamp: 2 }] });
    }, context);
    const ref = await personal.work.delegate(draft("compact", first.agentId));
    await until(() => f.server.calls.length === 3);
    const compact = await personal.harness.commit(tx => tx.createTask(CompactionTask, { reason: "threshold" }, { conversationId: ref.agentId, ownership: { kind: "conversation" }, background: true }), context);
    await until(() => f.server.calls.length === 4);
    const running = (await personal.harness.getTask(compact, context))!;
    assert.equal(running.background, true);
    assert.equal(running.state.status, "running");
    if (ending === "cancel") await personal.work.cancel(ref); else finish();
    const settled = await personal.harness.waitForTask(ref.taskId, context);
    finish();
    assert.equal(settled.state.outcome.status, ending === "cancel" ? "aborted" : "completed");
    const stopped = (await personal.harness.waitForTask(compact, context)).state;
    assert.equal(stopped.outcome.status, "aborted");
    assert.equal((await personal.harness.inspect(context)).tasks.length, 0);
    assert.equal((await personal.work.list())[0].work, undefined);
  });
});

test("后台工作：已提交输入但引用未写回时进程崩溃，重开只恢复一个 submission", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const personal = await f.open();
  await source(personal);
  await personal.close();
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,config}=JSON.parse(process.env.RUUKOTO_WORK_TEST); const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename); const commit=s.commit.bind(s); s.commit=async(writes,c)=>{await commit(writes,c); if(writes.some(w=>w.type==="submission"&&w.value.conversationId!==${ROOT_CONVERSATION_ID}&&w.value.type==="input")){process.stdout.write("admission-gap\\n"); await new Promise(()=>{});}}; return s;}}); const ref=await p.work.delegate({content:"恢复后台",requestId:"crash",sourceRequestId:"owner-source"}); process.stdout.write(JSON.stringify(ref)+"\\n"); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_WORK_TEST: JSON.stringify({ directory: f.directory, config: f.config }) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.pipe(process.stderr);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await until(() => stdout.includes("admission-gap"));
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const restored = await f.open();
  const ref = await restored.work.delegate({ content: "恢复后台", requestId: "crash", sourceRequestId: "owner-source" });
  await restored.harness.waitForTask(ref.taskId, context);
  const history = await (await restored.harness.conversation(ref.agentId, context))!.entries({}, 256, undefined, context);
  assert.equal(history.items.filter(entry => entry.kind === "pi.user").length, 1);
  assert.equal((await restored.work.status(ref)).submission?.status, "done");
  assert.equal((await restored.work.list()).length, 1);
  assert.equal(f.server.calls.length, 2);
});

test("后台工作：取消事实落盘后、abort 调用前强杀进程，恢复不重发且释放原占用", { timeout: 20000 }, async t => {
  const f = await fixture(t, request => ({ kind: "text", text: request.messages.at(-1)?.content === "等待取消" ? "尚未完成".repeat(100) : "完成", chunkDelayMs: request.messages.at(-1)?.content === "等待取消" ? 40 : 0 }));
  const personal = await f.open(); await source(personal); await personal.close();
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; import {once} from "node:events"; const {directory,config}=JSON.parse(process.env.RUUKOTO_WORK_TEST); let armed=false; const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename);const commit=s.commit.bind(s);s.commit=async(writes,c)=>{await commit(writes,c);if(armed){const r=await s.findDocument({kind:"ruukoto.work",scope:{kind:"session"},key:"cancel-crash"},"current",c);if(r&&(await s.document(r.id,"current",c)).value.cancelRequested){process.stdout.write("cancel-gap\\n");await new Promise(()=>{});}}};return s;}});const ref=await p.work.delegate({content:"等待取消",requestId:"cancel-crash",sourceRequestId:"owner-source"});process.stdout.write("ready\\n");await once(process.stdin,"data");armed=true;await p.work.cancel(ref);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_WORK_TEST: JSON.stringify({ directory: f.directory, config: f.config }) }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", data => { stdout += data; }); child.stderr.pipe(process.stderr);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await until(() => stdout.includes("ready") && f.server.calls.length === 2);
  child.stdin.write("cancel\n");
  await until(() => stdout.includes("cancel-gap"));
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const restored = await f.open();
  const ref = await restored.work.delegate({ content: "等待取消", requestId: "cancel-crash", sourceRequestId: "owner-source" });
  assert.equal((await restored.harness.waitForTask(ref.taskId, context)).state.outcome.status, "aborted");
  assert.equal((await restored.work.list())[0].work, undefined);
  assert.equal((await restored.work.status(ref)).cancelRequested, true);
  assert.equal(f.server.calls.length, 2);
});
