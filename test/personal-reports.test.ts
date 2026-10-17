import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { appendPersonalWork, personalWorkNoteSource } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, cancelPersonalDelegation, delegatePersonalAnalysis, listPersonalDelegations, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { PersonalReportTask, personalReportResult, requestPersonalReport } from "../apps/ruukoto/src/personal-report.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { managePersonalDelegations } from "../apps/ruukoto/src/personal-cli.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const TOKEN = "123:report-test-only";
const REPORT = "本报告的固定回答";
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent");
const summary = (request: RecordedRequest) => String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考");
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const args = (action: string, values: Record<string, unknown> = {}) => JSON.stringify({ action, ...values });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, "等待委托报告超时"); await delay(5); }
}
function gate(t: TestContext) {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  return { wait, release };
}

async function fixture(t: TestContext, respond: { analyze?: Responder; summarize?: Responder } = {}) {
  const directory = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-report-"));
  const model = new MockModelServer((request, index) => {
    if (child(request)) return respond.analyze?.(request, index) ?? { kind: "text", text: `结果：${request.messages.at(-1)?.content}` };
    if (summary(request)) return respond.summarize?.(request, index) ?? { kind: "text", text: REPORT };
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { kind: "text", text: String(last.content) };
    const content = String(last?.content);
    if (content === "multi") return { kind: "tool_calls", calls: ["A", "B"].map(id => ({ id, name: "background_work", arguments: { action: "delegate", content: id } })) };
    if (content.startsWith("{")) return { kind: "tool_calls", calls: [{ id: "action", name: "background_work", arguments: JSON.parse(content) as Record<string, unknown> }] };
    return { kind: "text", text: `聊天：${content}` };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_REPORT_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = [process.env[config.apiKeyEnv], process.env.RUUKOTO_REPORT_BOT_KEY];
  process.env[config.apiKeyEnv] = "test-only"; process.env.RUUKOTO_REPORT_BOT_KEY = TOKEN;
  const options = { directory, provider: personalProvider(config), modelId: config.modelId };
  const sends: Record<string, unknown>[] = [];
  let p: PersonalHarness | undefined;
  let bot: http.Server | undefined;
  let messageId = 10;
  t.after(async () => {
    await p?.close();
    if (bot) { bot.closeAllConnections(); await new Promise<void>(resolve => bot!.close(() => resolve())); }
    await model.close(); fs.rmSync(directory, { recursive: true, force: true });
    for (const [i, key] of [config.apiKeyEnv, "RUUKOTO_REPORT_BOT_KEY"].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
  });
  return { directory, config, model, options, sends,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ ...options, ...overrides }),
    async telegram(): Promise<PersonalTelegramConfig> {
      bot = http.createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; sends.push(body);
        response.end(JSON.stringify({ ok: true, result: { message_id: 1000 + sends.length, chat: { id: Number(body.chat_id), type: "private" } } }));
      });
      bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
      return { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "RUUKOTO_REPORT_BOT_KEY", tokenDigest: createHash("sha256").update(TOKEN).digest("hex"), botId: "123", ownerId: "456", boundary: 10 };
    },
    update(text: string, replyTo?: number): TelegramUpdate { const id = ++messageId; return { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }) } }; },
    async receive(update: TelegramUpdate) {
      assert.ok(p); await p.telegram.receive(update);
      const key = `telegram:123:456:${(update.message as { message_id: number }).message_id}`;
      const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
      await p.harness.waitForTask(receipt.taskId, context);
      return (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    },
  };
}
const delegation = async (p: PersonalHarness, ref: PersonalDelegationRef) => (await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!;
const report = async (p: PersonalHarness, ref: PersonalDelegationRef, offset = 0, size = 4096): Promise<{ delivery: string; state?: string; text?: string; nextOffset?: number }> => p.harness.commit(tx => personalReportResult(tx, ref, offset, size), context);
async function first(p: PersonalHarness) { return (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref; }
async function finishMembers(p: PersonalHarness, ref: PersonalDelegationRef) { for (const member of (await delegation(p, ref)).members) await p.harness.waitForTask(member.taskId, context); }
async function finishReport(p: PersonalHarness, ref: PersonalDelegationRef) { return p.harness.waitForTask((await delegation(p, ref)).report!.taskId, context); }

test("委托报告：多成员等待不占主聊天，封组在共用追加与续派入口生效，重复登记保持原任务", async t => {
  const analyzing = gate(t);
  const f = await fixture(t, { analyze: async request => { await analyzing.wait; return { kind: "text", text: `完整分析：${request.messages.at(-1)?.content}` }; } });
  const p = await f.open(); await p.answer("multi", "owner"); const ref = await first(p);
  await until(() => f.model.calls.filter(child).length === 2);
  assert.equal((await report(p, ref)).delivery, "not_requested");
  assert.match(await p.answer(args("report", { delegation: ref.entryId }), "seal"), /report_registered/);
  const saved = (await delegation(p, ref)).report!;
  assert.equal(saved.delivery, "waiting"); assert.equal(f.model.calls.filter(summary).length, 0);
  assert.equal(await p.answer("独立聊天", "chat"), "聊天：独立聊天");
  assert.match(await p.answer(args("delegate", { content: "迟到成员", delegation: ref.entryId }), "late-member"), /delegation_sealed/);
  const member = (await delegation(p, ref)).members[0];
  assert.match(await p.answer(args("append", { work: member.taskId, content: "迟到说明" }), "late-note"), /delegation_sealed/);
  await assert.rejects(p.work.append(member, { requestId: "host-note", content: "宿主说明", sourceRequestId: "owner" }), code("delegation_sealed"));
  for (const kind of ["local", "telegram"] as const) await assert.rejects(p.harness.commit(tx => appendPersonalWork(tx, member, { requestId: `${kind}-note`, content: "追加说明", source: { kind } }), context), code("delegation_sealed"));
  await assert.rejects(p.harness.commit(async tx => delegatePersonalAnalysis(tx, (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).model!, { requestId: "host-member", content: "宿主续派", sourceRequestId: "owner" }, ref), context), code("delegation_sealed"));
  assert.match(await p.answer(args("report", { delegation: ref.entryId }), "seal-again"), /report_registered/);
  assert.equal((await delegation(p, ref)).report!.taskId, saved.taskId);
  assert.equal(await p.harness.commit(tx => requestPersonalReport(tx, ref, saved.source.requestId, saved.modelCall), context), saved.taskId);
  analyzing.release(); await finishReport(p, ref);
  assert.equal((await delegation(p, ref)).members.length, 2);
  assert.equal((await report(p, ref)).text, REPORT); assert.equal(f.model.calls.filter(summary).length, 1);
  const tasks = await p.harness.commit(tx => tx.scanTasks({ kind: PersonalReportTask.definition.name }, 64), context);
  assert.equal(tasks.items.length, 1); assert.equal(tasks.items[0].state.status, "terminal");
});

test("委托报告：汇总参考只能查询，不能据此新派分析或取消原委托", async t => {
  let ref!: PersonalDelegationRef;
  let work!: TaskId;
  const f = await fixture(t, { summarize: request => request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [
    { id: "unauthorized-delegate", name: "background_work", arguments: { action: "delegate", content: "参考冒充拥有者" } },
    { id: "unauthorized-cancel", name: "background_work", arguments: { action: "cancel_delegation", delegation: ref.entryId } },
    { id: "unauthorized-cancel-work", name: "background_work", arguments: { action: "cancel", work } },
    { id: "allowed-progress", name: "background_work", arguments: { action: "progress", delegation: ref.entryId } },
  ] } : { kind: "text", text: request.messages.filter(message => message.role === "tool").map(message => String(message.content)).join("\n") } });
  const p = await f.open(); await p.answer("multi", "owner"); ref = await first(p); work = (await delegation(p, ref)).members[0].taskId; await finishMembers(p, ref);
  await p.answer(args("report", { delegation: ref.entryId }), "seal"); await finishReport(p, ref);
  const result = await report(p, ref);
  assert.equal(result.delivery, "local"); assert.equal(result.text!.match(/work_source_invalid/g)?.length, 3); assert.match(result.text!, /"total":2/);
  assert.equal((await delegation(p, ref)).cancelRequested, false); assert.equal((await p.work.list()).length, 2);
});

test("委托报告：HTTP 前取消零汇总请求，在途取消保留迟到回答但不外发，其他聊天继续", async t => {
  for (const window of ["before-http", "in-flight"] as const) await t.test(window, async t => {
    const generating = gate(t); let started = false;
    const f = await fixture(t, { summarize: async () => { started = true; await generating.wait; return { kind: "text", text: REPORT }; } });
    let p!: PersonalHarness; let ref!: PersonalDelegationRef; let armed = window === "before-http";
    const provider = f.options.provider;
    p = await f.open({ provider: { ...provider, streamSimple: (model, input, options) => provider.streamSimple(model, input, { ...options, onPayload: async payload => {
      if (armed && JSON.stringify(input.messages.at(-1)).includes("宿主委托汇总参考")) { armed = false; await p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context); }
      return await options?.onPayload?.(payload, model) ?? payload;
    } }) } });
    await p.answer("multi", "owner"); ref = await first(p); await finishMembers(p, ref);
    await p.answer(args("report", { delegation: ref.entryId }), "seal");
    if (window === "in-flight") { await until(() => started); await p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context); }
    await finishReport(p, ref); assert.equal((await report(p, ref)).delivery, "canceled");
    generating.release(); assert.equal(await p.answer("其他聊天", "independent"), "聊天：其他聊天");
    assert.equal(f.model.calls.filter(summary).length, window === "before-http" ? 0 : 1);
    assert.equal((await report(p, ref)).delivery, "canceled");
  });
});

test("委托报告：原生中止尚未 admission 的报告不新造输入，也不取消成员和主聊天", async t => {
  const analyzing = gate(t); const f = await fixture(t, { analyze: async () => { await analyzing.wait; return { kind: "text", text: "成员完成" }; } });
  const p = await f.open(); await p.answer("multi", "owner"); const ref = await first(p);
  await p.answer(args("report", { delegation: ref.entryId }), "seal");
  const saved = (await delegation(p, ref)).report!; await p.harness.abortTask(saved.taskId, context); await finishReport(p, ref);
  assert.equal((await report(p, ref)).delivery, "canceled");
  assert.equal(await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, `personal-report:${saved.taskId}:0`), context), undefined);
  assert.equal((await delegation(p, ref)).cancelRequested, false); assert.equal(await p.answer("正常聊天", "other"), "聊天：正常聊天");
  analyzing.release(); await finishMembers(p, ref);
});

test("委托报告：本机菜单经后台查询完整报告，Telegram 原菜单分页零模型", async t => {
  for (const entry of ["local", "telegram"] as const) await t.test(entry, async t => {
    const f = await fixture(t, { summarize: () => ({ kind: "text", text: REPORT.repeat(600) }) });
    const telegram = entry === "telegram" ? await f.telegram() : undefined; const p = await f.open({ telegram });
    if (telegram) await f.receive(f.update("multi")); else await p.answer("multi", "owner");
    const ref = await first(p); await finishMembers(p, ref);
    if (telegram) await f.receive(f.update(args("report", { delegation: ref.entryId }))); else await p.answer(args("report", { delegation: ref.entryId }), "seal");
    await finishReport(p, ref); const before = f.model.calls.length;
    if (telegram) {
      const list = await f.receive(f.update("/委托")); const detail = await f.receive(f.update("委托1", Number(list.platformMessageId)));
      const firstPage = await f.receive(f.update("查看报告", Number(detail.platformMessageId)));
      assert.equal(firstPage.control, true); assert.match(firstPage.reply!, /下一页报告/);
      const next = await f.receive(f.update("下一页报告", Number(firstPage.platformMessageId)));
      assert.match(next.reply!, /固定回答/); assert.equal(f.model.calls.length, before);
    } else {
      await p.close(); savePersonalConfig(f.directory, f.config); const backend = await startPersonalServer(f.directory); t.after(() => backend.stop());
      const choices = ["1", "4", "1", "3", "2"]; let output = "";
      await managePersonalDelegations({ question: async () => choices.shift()!, write: text => { output += text; } }, f.directory);
      assert.match(output, /完整报告已保存本机/); assert.match(output, /固定回答/); assert.equal(f.model.calls.length, before);
    }
  });
});

test("委托报告：取消与发送领取按事务顺序仲裁，已开始发送保留真实效果", async t => {
  for (const stage of ["before-claim", "after-claim"] as const) await t.test(stage, async t => {
    const held = gate(t); let entered = false;
    const phases = PersonalReportTask.definition.phases;
    const original = phases.send;
    const intercept: typeof original = async (current, runtime, c) => {
      if (stage === "before-claim") { entered = true; await held.wait; return original(current, runtime, c); }
      let intercepted = false;
      const proxy = new Proxy(runtime, { get(target, key) {
        if (key === "commit") return async (...params: Parameters<typeof runtime.commit>) => {
          const result = await target.commit(...params);
          if (!intercepted) { intercepted = true; entered = true; await held.wait; }
          return result;
        };
        return Reflect.get(target, key);
      } });
      return original(current, proxy, c);
    };
    Object.assign(phases, { send: intercept }); t.after(() => { Object.assign(phases, { send: original }); });
    const f = await fixture(t); const telegram = await f.telegram(); const p = await f.open({ telegram });
    await f.receive(f.update("multi")); const ref = await first(p); await finishMembers(p, ref);
    await f.receive(f.update(args("report", { delegation: ref.entryId }))); await until(() => entered);
    await p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context);
    const independent = p.answer("取消不影响其他聊天", "independent");
    held.release(); await finishReport(p, ref); assert.equal(await independent, "聊天：取消不影响其他聊天");
    assert.equal((await report(p, ref)).delivery, stage === "after-claim" ? "sent" : "canceled");
    assert.equal(f.sends.filter(send => send.text === REPORT).length, stage === "after-claim" ? 1 : 0);
  });
});

test("委托报告：原 Submission 完成后真实强杀，恢复重接原回答且不串入其他主聊天", { timeout: 20000 }, async t => {
  const f = await fixture(t, { summarize: () => ({ kind: "text", text: REPORT + "😀".repeat(50) }) });
  let p = await f.open(); await p.answer("multi", "owner"); const ref = await first(p); await finishMembers(p, ref); await p.close();
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,config,ref}=JSON.parse(process.env.RUUKOTO_REPORT_CRASH); setInterval(()=>{},1000); const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename);const commit=s.commit.bind(s);s.commit=async(writes,c)=>{await commit(writes,c);if(writes.some(w=>w.type==="submission"&&w.value.requestId?.startsWith("personal-report:")&&w.value.status==="done")){process.stdout.write("report-answer-gap\\n");await new Promise(()=>{});}};return s;}});await p.answer(JSON.stringify({action:"report",delegation:ref.entryId}),"seal");`;
  const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_REPORT_CRASH: JSON.stringify({ directory: f.directory, config: f.config, ref }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; processChild.stdout.on("data", data => { output += data; }); processChild.stderr.pipe(process.stderr);
  t.after(() => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); });
  await until(() => output.includes("report-answer-gap")); const exited = once(processChild, "exit"); processChild.kill("SIGKILL"); await exited;
  const calls = f.model.calls.filter(summary).length;
  p = await f.open(); assert.equal(await p.answer("另一件事", "other-chat"), "聊天：另一件事"); await finishReport(p, ref);
  const saved = (await delegation(p, ref)).report!;
  const submission = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, `personal-report:${saved.taskId}:0`), context);
  assert.equal(submission?.status, "done"); assert.ok(submission?.type === "input" && submission.status === "done"); assert.equal(saved.answer, submission.answer);
  assert.equal((await report(p, ref)).text, REPORT + "😀".repeat(50)); assert.equal(f.model.calls.filter(summary).length, calls);
  const page = await report(p, ref, 0, REPORT.length + 1); assert.equal(page.text, REPORT); assert.equal(page.nextOffset, REPORT.length);
  assert.equal((await report(p, ref, page.nextOffset!)).text, "😀".repeat(50));
});

test("委托报告：Telegram 已外发但结果未提交时强杀，重开未知不重发且固定原消息", { timeout: 20000 }, async t => {
  const f = await fixture(t); const telegram = await f.telegram(); let p = await f.open({ telegram });
  const original = f.update("multi"); await f.receive(original); const ref = await first(p); await finishMembers(p, ref); await p.close();
  const update = f.update(args("report", { delegation: ref.entryId }));
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts";import {personalProvider} from "./apps/ruukoto/src/personal-model.ts";import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";const {directory,config,telegram,update}=JSON.parse(process.env.RUUKOTO_REPORT_SEND_CRASH);setInterval(()=>{},1000);const p=await openPersonalHarness({directory,telegram,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename);const commit=s.commit.bind(s);s.commit=async(writes,c)=>{if(writes.some(w=>w.type==="task"&&w.value.kind==="ruukoto.delegation-report"&&w.value.state.status==="terminal"&&w.value.state.outcome.result?.delivery==="sent")){process.stdout.write("report-send-gap\\n");await new Promise(()=>{});}return commit(writes,c);};return s;}});await p.telegram.receive(update);`;
  const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_REPORT_SEND_CRASH: JSON.stringify({ directory: f.directory, config: f.config, telegram, update }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; processChild.stdout.on("data", data => { output += data; }); processChild.stderr.pipe(process.stderr);
  t.after(() => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); });
  await until(() => output.includes("report-send-gap")); const exited = once(processChild, "exit"); processChild.kill("SIGKILL"); await exited;
  const sends = f.sends.filter(send => send.text === REPORT); assert.equal(sends.length, 1); assert.equal(sends[0].chat_id, "456"); assert.deepEqual(sends[0].reply_parameters, { message_id: 11, allow_sending_without_reply: true });
  p = await f.open({ telegram }); await finishReport(p, ref); await f.receive(update);
  assert.equal((await report(p, ref)).delivery, "effect_unknown"); assert.equal((await report(p, ref)).text, REPORT); assert.equal(f.sends.filter(send => send.text === REPORT).length, 1);
  await p.close(); p = await f.open({ telegram }); await finishReport(p, ref); assert.equal(f.sends.filter(send => send.text === REPORT).length, 1);
});

test("委托报告：Telegram 原入口换代取消待汇总，不能改发新绑定", async t => {
  const analyzing = gate(t);
  const f = await fixture(t, { analyze: async () => { await analyzing.wait; return { kind: "text", text: "迟到分析" }; } });
  const telegram = await f.telegram(); let p = await f.open({ telegram });
  await f.receive(f.update("multi")); const ref = await first(p); await f.receive(f.update(args("report", { delegation: ref.entryId })));
  await p.close(); p = await f.open({ telegram: { ...telegram, generation: randomUUID() } }); analyzing.release(); await finishReport(p, ref);
  assert.equal((await report(p, ref)).delivery, "canceled"); assert.equal(f.model.calls.filter(summary).length, 0); assert.equal(f.sends.filter(send => send.text === REPORT).length, 0);
});

test("委托报告：损坏报告、接纳、输入、回答或暂停关系在恢复请求前拒绝", async t => {
  for (const mutation of ["extension", "report", "task", "admission", "input", "answer", "reply", "pause", "model-call"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); const p = await f.open(); await p.answer("multi", "owner"); const ref = await first(p); await finishMembers(p, ref);
    await p.answer(args("report", { delegation: ref.entryId }), "seal"); await finishReport(p, ref);
    await p.harness.commit(async tx => {
      const value = (await tx.doc(PersonalDelegationDoc, String(ref.entryId), null)).delegation!; const saved = value.report!;
      if (mutation === "extension") { const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== "personal-delegation-reports"); }
      if (mutation === "report") delete value.report;
      if (mutation === "task") saved.taskId = value.members[0].taskId;
      if (mutation === "admission") saved.admission = saved.answer!;
      if (mutation === "input") saved.content += "被改写的固定输入";
      if (mutation === "answer") saved.answer = ref.entryId;
      if (mutation === "reply") saved.reply += "被改写的固定发送正文";
      if (mutation === "pause") saved.pauses = [saved.answer!];
      if (mutation === "model-call") saved.modelCall = value.members[0].taskId;
    }, context); await p.close(); const before = f.model.calls.length;
    await assert.rejects(f.open(), error => error instanceof PersonalError && error.code.startsWith("report_")); assert.equal(f.model.calls.length, before);
  });
});

test("委托报告：追加与封组按事务顺序仲裁，封组后重放既有追加不另造输入", async t => {
  for (const order of ["append-first", "seal-first"] as const) await t.test(order, async t => {
    const analyzing = gate(t); const f = await fixture(t, { analyze: async () => { await analyzing.wait; return { kind: "text", text: "结果" }; } });
    const p = await f.open(); await p.answer("multi", "owner"); const ref = await first(p); const member = (await delegation(p, ref)).members[0];
    const append = () => p.harness.commit(async tx => appendPersonalWork(tx, member, { requestId: "race-note", content: "竞态追加", source: await personalWorkNoteSource(tx, "owner") }), context);
    if (order === "append-first") await append();
    await p.answer(args("report", { delegation: ref.entryId }), "seal");
    if (order === "seal-first") await assert.rejects(append(), code("delegation_sealed")); else await append();
    analyzing.release(); await finishReport(p, ref);
    const conversation = (await p.harness.conversation(member.agentId, context))!;
    const entries = (await conversation.entries({}, 256, undefined, context)).items.filter(entry => entry.kind === "pi.user");
    assert.equal(entries.length, order === "append-first" ? 2 : 1); assert.equal((await report(p, ref)).delivery, "local");
  });
});
