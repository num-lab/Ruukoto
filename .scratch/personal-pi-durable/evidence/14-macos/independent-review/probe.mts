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
import { openPersonalHarness, type PersonalHarness } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-model.ts";
import { appendPersonalWork, personalWorkNoteSource } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, cancelPersonalDelegation, delegatePersonalAnalysis, listPersonalDelegations, type PersonalDelegationRef } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-delegation.ts";
import { PersonalReportTask, personalReportResult, requestPersonalReport } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-report.ts";
import { PersonalError } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-error.ts";
import { PersonalTelegramReceiptDoc } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramConfig } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/apps/ruukoto/src/personal-telegram-api.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable/test/helpers/mock-provider.ts";

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

let reviewBusy: Promise<void> | undefined;
async function fixture(t: TestContext, respond: { analyze?: Responder; summarize?: Responder } = {}) {
  const directory = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-report-"));
  const model = new MockModelServer((request, index) => {
    if (child(request)) return respond.analyze?.(request, index) ?? { kind: "text", text: `结果：${request.messages.at(-1)?.content}` };
    if (summary(request)) return respond.summarize?.(request, index) ?? { kind: "text", text: REPORT };
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { kind: "text", text: String(last.content) };
    const content = String(last?.content);
    if (content === "review-busy") return reviewBusy!.then(()=>({kind:"text" as const,text:"聊天：review-busy"}));
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
    update(text: string): TelegramUpdate { const id = ++messageId; return { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text } }; },
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
  for (const mutation of ["extension", "report", "task", "admission", "input", "answer", "pause", "model-call"] as const) await t.test(mutation, async t => {
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


test("独立探针：停用Telegram并移除token后恢复pending报告应取消", {timeout:20000}, async t => {
  const f=await fixture(t); const telegram=await f.telegram(); let p=await f.open({telegram});
  await f.receive(f.update("multi")); const ref=await first(p); await finishMembers(p,ref); await p.close();
  const update=f.update(args("report",{delegation:ref.entryId}));
  const script=`import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts"; import {personalProvider} from "./apps/ruukoto/src/personal-model.ts"; import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node"; const {directory,config,telegram,update}=JSON.parse(process.env.RUUKOTO_DISABLED_REPORT); setInterval(()=>{},1000); const p=await openPersonalHarness({directory,telegram,provider:personalProvider(config),modelId:config.modelId,openStorage:async filename=>{const s=await openNodeSqliteStorage(filename);const commit=s.commit.bind(s);s.commit=async(writes,c)=>{await commit(writes,c);if(writes.some(w=>w.type==="task"&&w.value.kind==="ruukoto.delegation-report"&&w.value.state.checkpoint?.phase==="send")){process.stdout.write("pending-gap");await new Promise(()=>{});}};return s;}});await p.telegram.receive(update);`;
  const processChild=spawn(process.execPath,["--import","tsx","--input-type=module","--eval",script],{cwd:'/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable',env:{...process.env,RUUKOTO_DISABLED_REPORT:JSON.stringify({directory:f.directory,config:f.config,telegram,update})},stdio:["ignore","pipe","pipe"]});
  let output=""; processChild.stdout.on("data",data=>{output+=data});processChild.stderr.pipe(process.stderr);
  t.after(()=>{if(processChild.exitCode===null&&processChild.signalCode===null)processChild.kill("SIGKILL")});
  await until(()=>output.includes("pending-gap")); const exited=once(processChild,"exit");processChild.kill("SIGKILL");await exited;
  delete process.env.RUUKOTO_REPORT_BOT_KEY;
  p=await f.open({telegram:{...telegram,enabled:false,generation:randomUUID()}});const done=await finishReport(p,ref);
  const result=await report(p,ref);console.log(JSON.stringify({done:done.state,result}));
  assert.equal(result.delivery,"canceled");
});


test("独立探针：取消与报告精确窗口",{timeout:30000},async t=>{
  for (const stage of ["before-admission","after-admission","before-send-claim","after-send-claim"] as const) await t.test(stage,async t=>{
    const held=gate(t);let entered=false;
    const original=stage.includes("admission")?PersonalReportTask.definition.phases.summarize:PersonalReportTask.definition.phases.send;
    const phase=stage.includes("admission")?"summarize":"send";
    const phases=PersonalReportTask.definition.phases as Record<string,typeof original>;
    phases[phase]=async(current,runtime,c)=>{
      if(stage==="before-send-claim"){entered=true;await held.wait;return original(current as never,runtime as never,c);}
      let intercepted=false;
      const proxy=new Proxy(runtime,{get(target,key){
        if(key==="conversation"&&stage.includes("admission"))return async(...params:unknown[])=>{
          const main=await (target.conversation as Function)(...params);
          return new Proxy(main,{get(handle,member){if(member!=="submit")return Reflect.get(handle,member);return async(...draft:unknown[])=>{
            if(stage==="before-admission"){entered=true;await held.wait;return handle.submit(...draft);}
            const submission=await handle.submit(...draft);entered=true;await held.wait;return submission;
          };}});
        };
        if(key==="commit"&&stage==="after-send-claim")return async(...params:unknown[])=>{
          const result=await (target.commit as Function)(...params);
          if(!intercepted){intercepted=true;entered=true;await held.wait;}
          return result;
        };
        return Reflect.get(target,key);
      }});
      return original(current as never,proxy as never,c);
    };
    t.after(()=>{phases[phase]=original;});
    const f=await fixture(t);const telegram=await f.telegram();const p=await f.open({telegram});
    await f.receive(f.update("multi"));const ref=await first(p);await finishMembers(p,ref);
    await f.receive(f.update(args("report",{delegation:ref.entryId})));
    await until(()=>entered);
    await p.harness.commit(tx=>cancelPersonalDelegation(tx,ref),context);
    const independent=p.answer("取消不影响独立聊天","independent");
    held.release();await finishReport(p,ref);assert.equal(await independent,"聊天：取消不影响独立聊天");
    const result=await report(p,ref);const sent=f.sends.filter(send=>send.text===REPORT);
    console.log(JSON.stringify({stage,result,sent:sent.length,summaryRequests:f.model.calls.filter(summary).length}));
    if(stage==="after-send-claim"){assert.equal(result.delivery,"sent");assert.equal(sent.length,1);}else{assert.equal(result.delivery,"canceled");assert.equal(sent.length,0);}
    if(stage==="before-admission")assert.equal(f.model.calls.filter(summary).length,0);
  });
});


test("独立探针：真实HTTP输入与持久payload完整相等",async t=>{
  let ref!:PersonalDelegationRef;
  const f=await fixture(t,{summarize:request=>request.messages.at(-1)?.role==="user"?{kind:"tool_calls",calls:[{id:"query-progress",name:"background_work",arguments:{action:"progress",delegation:ref.entryId}}]}:{kind:"text",text:REPORT}});
  const p=await f.open();await p.answer("multi","owner");ref=await first(p);await finishMembers(p,ref);await p.answer(args("report",{delegation:ref.entryId}),"seal");await finishReport(p,ref);
  const all=[];
  for(const conv of [p.main,...await Promise.all((await p.work.list()).map(async agent=>(await p.harness.conversation(agent.id,context))!))]){
    const entries=(await conv.entries({},256,undefined,context)).items;
    all.push(...entries.filter(entry=>entry.kind==="ruukoto.model-request").map(entry=>entry.data as Record<string,unknown>));
  }
  const payloads=all.filter(value=>value.payload!==undefined);
  assert.equal(payloads.length,f.model.calls.length);
  for(const call of f.model.calls)assert.ok(payloads.some(value=>JSON.stringify(value.payload)===JSON.stringify(call.raw)),"实际HTTP payload缺持久原文");
  const main=f.model.calls.find(call=>!child(call))!;const sub=f.model.calls.find(child)!;const reporting=f.model.calls.find(summary)!;
  assert.deepEqual(reporting.tools,main.tools);assert.deepEqual(sub.tools??[],[]);
  const snapshot={main:{systemPrompt:main.system,tools:main.tools},sub:{systemPrompt:sub.system,tools:sub.tools},report:{systemPrompt:reporting.system,tools:reporting.tools,payload:reporting.raw},counts:{http:f.model.calls.length,payloads:payloads.length},estimates:{main:{systemPrompt:Math.ceil(Buffer.byteLength(main.system??"","utf8")/4),toolSchemas:Math.ceil(Buffer.byteLength(JSON.stringify(main.tools),"utf8")/4)},sub:{systemPrompt:Math.ceil(Buffer.byteLength(sub.system??"","utf8")/4),toolSchemas:0}}};
  fs.writeFileSync("/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/rk-report-review-1lv79j3y/model-input.json",JSON.stringify(snapshot,null,2)+"\n");console.log(JSON.stringify({counts:snapshot.counts,estimates:snapshot.estimates}));
});


test("独立探针：整项取消和native abort只撤回该报告队列输入",{timeout:20000},async t=>{
 for(const kind of ["group-cancel","native-abort"] as const)await t.test(kind,async t=>{
  const analyzing=gate(t),busy=gate(t);reviewBusy=busy.wait;t.after(()=>{reviewBusy=undefined;});
  const f=await fixture(t,{analyze:async()=>{await analyzing.wait;return {kind:"text",text:"分析完成"};}});
  const telegram=await f.telegram();const p=await f.open({telegram});await f.receive(f.update("multi"));const ref=await first(p);
  await f.receive(f.update(args("report",{delegation:ref.entryId})));
  const busyAnswer=p.answer("review-busy","busy");await until(()=>f.model.calls.some(call=>call.messages.at(-1)?.content==="review-busy"));
  analyzing.release();let reportSubmission:Record<string,unknown>|undefined;
  await until(async()=>{const saved=(await delegation(p,ref)).report!;reportSubmission=await p.harness.commit(tx=>tx.submissionByRequest(ROOT_CONVERSATION_ID,`personal-report:${saved.taskId}:0`),context) as unknown as Record<string,unknown>;return reportSubmission?.status==="queued";});
  const other=await p.submit("排队独立聊天","surviving");assert.equal((await other.status(context)).status,"queued");
  const taskId=(await delegation(p,ref)).report!.taskId;
  if(kind==="group-cancel")await p.harness.commit(tx=>cancelPersonalDelegation(tx,ref),context);else await p.harness.abortTask(taskId,context);
  await finishReport(p,ref);
  const withdrawn=await p.harness.commit(tx=>tx.submissionByRequest(ROOT_CONVERSATION_ID,`personal-report:${taskId}:0`),context);
  assert.equal(withdrawn?.status,"unanswered");assert.equal(withdrawn?.reason,"aborted");assert.equal((await other.status(context)).status,"queued");
  busy.release();assert.equal(await busyAnswer,"聊天：review-busy");assert.equal(await p.answer("排队独立聊天","surviving"),"聊天：排队独立聊天");
  assert.equal(f.model.calls.filter(summary).length,0);assert.equal(f.sends.filter(send=>send.text===REPORT).length,0);
  console.log(JSON.stringify({kind,delivery:(await report(p,ref)).delivery,reportSubmission:withdrawn?.status,other:(await other.status(context)).status}));
 });
});
