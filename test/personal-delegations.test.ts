import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalAgentsDoc, PersonalWorkDoc, requestPersonalWorkCancel } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, cancelPersonalDelegation, delegatePersonalAnalysis, listPersonalDelegations, personalDelegationProgress, type PersonalDelegationRef } from "../apps/ruukoto/src/personal-delegation.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { startPersonalServer, personalControl, readPersonalToken } from "../apps/ruukoto/src/personal-control.ts";
import { managePersonalDelegations } from "../apps/ruukoto/src/personal-cli.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent");
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < end, "等待分析委托超时"); await delay(5); }
}
const args = (action: string, values: Record<string, unknown> = {}) => JSON.stringify({ action, ...values });
async function fixture(t: TestContext, analyze: Responder = () => ({ kind: "text", text: "分析结果" })) {
  const directory = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "rk-delegation-"));
  const model = new MockModelServer(async (request, index) => {
    if (child(request)) return analyze(request, index);
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { kind: "text", text: String(last.content) };
    const content = String(last?.content);
    if (content === "multi") return { kind: "tool_calls", calls: ["A", "B"].map(id => ({ id, name: "background_work", arguments: { action: "delegate", content: id } })) };
    if (content.startsWith("{")) return { kind: "tool_calls", calls: [{ id: "call", name: "background_work", arguments: JSON.parse(content) as Record<string, unknown> }] };
    return { kind: "text", text: "继续聊天" };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_DELEGATION_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = [process.env[config.apiKeyEnv], process.env.RUUKOTO_DELEGATION_BOT_KEY];
  process.env[config.apiKeyEnv] = "test-only"; process.env.RUUKOTO_DELEGATION_BOT_KEY = "123:test-token";
  await savePersonalConfig(directory, config);
  let p: PersonalHarness;
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  let bot: http.Server | undefined;
  let id = 0;
  const options = { directory, provider: personalProvider(config), modelId: config.modelId };
  t.after(async () => {
    await server?.stop(); await p?.close(); if (bot) { bot.closeAllConnections(); await new Promise<void>(resolve => bot!.close(() => resolve())); } await model.close();
    for (const [i, key] of [config.apiKeyEnv, "RUUKOTO_DELEGATION_BOT_KEY"].entries()) { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, config, model, options,
    open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ ...options, ...overrides }),
    start: async () => server = await startPersonalServer(directory),
    async telegram(): Promise<PersonalTelegramConfig> {
      let sent = 1000;
      bot = http.createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { chat_id: string };
        res.end(JSON.stringify({ ok: true, result: { message_id: ++sent, chat: { id: Number(body.chat_id), type: "private" } } }));
      });
      bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
      return { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "RUUKOTO_DELEGATION_BOT_KEY", tokenDigest: createHash("sha256").update("123:test-token").digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
    },
    async receive(text: string, replyTo?: number, extra: Record<string, unknown> = {}) {
      const messageId = ++id;
      const update: TelegramUpdate = { update_id: id, message: { message_id: messageId, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } };
      await p.telegram.receive(update); const key = `telegram:123:456:${messageId}`;
      const receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
      await p.harness.waitForTask(receipt.taskId, context);
      const value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
      return { key, update, value, messageId: Number(value.platformMessageId) };
    },
  };
}
const progress = (p: PersonalHarness, ref: PersonalDelegationRef, offset = 0) => p.harness.commit(tx => personalDelegationProgress(tx, ref, offset), context);
async function first(p: PersonalHarness) { return (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref; }
async function finish(p: PersonalHarness, ref: PersonalDelegationRef) { for (const member of (await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.members) await p.harness.waitForTask(member.taskId, context); }

test("分析委托：同轮多成员、跨轮继续及原权限固定，历史宿主工作不自动归组", async t => {
  const f = await fixture(t); let p = await f.open();
  await p.answer("multi", "owner"); const ref = await first(p); await finish(p, ref);
  assert.equal((await progress(p, ref)).total, 2); assert.equal((await progress(p, ref)).state, "idle");
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
  const result = JSON.parse(await p.answer(args("delegate", { content: "后续检查", delegation: ref.entryId }), "follow-up")) as { work: number; delegation: number };
  assert.equal(result.delegation, ref.entryId); await finish(p, ref);
  const saved = (await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!;
  const member = saved.members.at(-1)!; const work = (await p.harness.snapshot(PersonalWorkDoc, member.requestId, context))!;
  assert.equal(work.source!.requestId, "owner"); assert.equal(work.instructionSource!.requestId, "follow-up"); assert.deepEqual(work.permission, { mode: "auto-review", version: 1 });
  await p.answer("旧宿主来源", "host"); const host = await p.work.delegate({ requestId: "host-work", sourceRequestId: "host", content: "旧单项" }); await p.harness.waitForTask(host.taskId, context);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, host.requestId, context))!.delegation, undefined);
  assert.match(await p.answer(args("progress", { delegation: ref.entryId }), "query"), /后续检查/);
  const report = await p.main.submit({ type: "input", content: args("cancel_delegation", { delegation: ref.entryId }), requestId: "report", entry: { kind: "ruukoto.work-report" } }, context); await report.wait(context);
  assert.equal((await progress(p, ref)).cancelRequested, false);
  await p.close(); p = await f.open(); assert.equal((await progress(p, ref)).total, 3);
});

test("分析委托：整项取消覆盖全部成员，拒绝续派追加，其他委托与身份复用继续", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { await wait; return { kind: "text", text: "迟到结果" }; }); const p = await f.open();
  await p.answer("multi", "owner"); const ref = await first(p); await until(() => f.model.calls.filter(child).length === 2);
  await p.answer(args("delegate", { content: "其他独立工作" }), "other"); const other = await first(p);
  await p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context); await finish(p, ref);
  assert.equal((await progress(p, ref)).state, "canceled"); assert.equal((await progress(p, other)).cancelRequested, false); assert.ok((await progress(p, other)).active);
  assert.match(await p.answer(args("delegate", { content: "不复活", delegation: ref.entryId }), "late"), /delegation_canceled/);
  const member = (await progress(p, ref)).members[0].ref;
  await assert.rejects(p.work.append(member, { content: "旧说明", requestId: "late-note", sourceRequestId: "owner" }), code("work_inactive"));
  await p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context);
  assert.match(await p.answer(args("delegate", { content: "复用身份新委托", agent: member.agentId }), "reuse"), /registered/);
  const reused = await first(p); assert.notEqual(reused.entryId, ref.entryId);
  assert.equal(await p.answer("继续独立聊天", "chat"), "继续聊天");
  release(); await finish(p, other); await finish(p, reused);
  assert.equal((await p.harness.snapshot(PersonalAgentsDoc, context))!.agents.find(agent => agent.id === member.agentId)!.closed, false);
});

test("分析委托：faulted 成员保留占用，整项取消不把异常终态当停止证明", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { await wait; return { kind: "text", text: "迟到" }; }); const p = await f.open();
  await p.answer(args("delegate", { content: "分析" }), "owner"); const ref = await first(p); const member = (await progress(p, ref)).members[0].ref;
  await until(() => f.model.calls.some(child));
  await p.harness.commit(async tx => { (await tx.doc(PersonalAgentsDoc)).agents[0].work!.taskId = 999999 as typeof member.taskId; await requestPersonalWorkCancel(tx, member); }, context);
  await finish(p, ref); await p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context);
  assert.equal((await progress(p, ref)).state, "stop_unverified"); assert.equal((await progress(p, ref)).unverified, 1);
  assert.ok((await p.work.list())[0].work);
});

test("分析委托：取消与新成员登记按事务顺序仲裁，重放仍返回原成员", async t => {
  for (const order of ["register-first", "cancel-first"] as const) await t.test(order, async t => {
    const f = await fixture(t); const p = await f.open(); await p.answer(args("delegate", { content: "起点" }), "owner"); const ref = await first(p); await finish(p, ref);
    await p.answer("后续说明", "actor");
    const register = () => p.harness.commit(async tx => {
      const model = (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).model!;
      return delegatePersonalAnalysis(tx, model, { content: "新增分析", requestId: "race-member", sourceRequestId: "actor" }, ref);
    }, context);
    const cancel = () => p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context);
    const outcomes = await Promise.allSettled(order === "register-first" ? [register(), cancel()] : [cancel(), register()]);
    assert.equal(outcomes[0].status, "fulfilled");
    if (order === "cancel-first") { const rejected = outcomes[1]; assert.equal(rejected.status, "rejected"); if (rejected.status === "rejected") assert.ok(code("delegation_canceled")(rejected.reason)); }
    else { assert.equal(outcomes[1].status, "fulfilled"); await finish(p, ref); const replay = await register(); assert.equal(replay.ref.requestId, "race-member"); }
    assert.equal((await progress(p, ref)).total, order === "register-first" ? 2 : 1);
    assert.equal((await progress(p, ref)).state, "canceled");
  });
});

test("分析委托：子请求在 HTTP 前遇整项取消，尚未请求的成员不发模型请求", async t => {
  const f = await fixture(t); let p!: PersonalHarness; let canceled = false;
  const base = f.options.provider;
  p = await f.open({ provider: { ...base, streamSimple: (model, input, options) => base.streamSimple(model, input, { ...options, onPayload: async payload => {
    if (!canceled && JSON.stringify(input.messages.filter(message => message.role === "system")).includes("你是个人助手的子 Agent")) {
      canceled = true; const ref = await first(p); await p.harness.commit(tx => cancelPersonalDelegation(tx, ref), context);
    }
    return await options?.onPayload?.(payload, model) ?? payload;
  } }) } });
  await p.answer("multi", "owner"); const ref = await first(p); await finish(p, ref);
  assert.equal((await progress(p, ref)).state, "canceled"); assert.equal(f.model.calls.filter(child).length, 0);
});

test("分析委托：缺扩展、来源、成员、权限或工具说明在恢复请求前拒绝", async t => {
  for (const mutation of ["extension", "source", "member", "backlink", "permission", "instruction", "fingerprint", "admission"] as const) await t.test(mutation, async t => {
    const f = await fixture(t); const p = await f.open(); await p.answer(args("delegate", { content: "分析" }), "owner"); const ref = await first(p); await finish(p, ref);
    await p.harness.commit(async tx => {
      const value = (await tx.doc(PersonalDelegationDoc, String(ref.entryId), null)).delegation!;
      const work = await tx.doc(PersonalWorkDoc, value.members[0].requestId, null);
      if (mutation === "extension") { const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== "personal-analysis-delegations"); }
      if (mutation === "source") value.source.requestId = "missing";
      if (mutation === "member") value.members = [];
      if (mutation === "backlink") delete work.delegation;
      if (mutation === "permission") value.permission.mode = "full_access";
      if (mutation === "instruction") work.instructionSource!.requestId = "missing";
      if (mutation === "fingerprint") work.fingerprint = "wrong";
      if (mutation === "admission") delete work.delegationAdmission;
    }, context); await p.close(); const before = f.model.calls.length;
    await assert.rejects(f.open(), error => error instanceof PersonalError && error.code.startsWith("delegation_")); assert.equal(f.model.calls.length, before);
  });
});

test("分析委托：不能把续派或追加来源换成存在的旧输入，文档新版本拒绝恢复", async t => {
  for (const mutation of ["continuation", "note", "version"] as const) await t.test(mutation, async t => {
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
    const f = await fixture(t, async () => { await wait; return { kind: "text", text: "完成" }; }); const p = await f.open();
    await p.answer(args("delegate", { content: "原分析" }), "owner"); const ref = await first(p);
    await p.answer("不属于该说明的旧输入", "unrelated"); await p.answer("真正的追加来源", "real-note");
    const initial = (await progress(p, ref)).members[0].ref;
    await p.work.append(initial, { requestId: "note", content: "追加要求", sourceRequestId: "real-note" });
    await p.answer(args("delegate", { content: "后续分析", delegation: ref.entryId }), "real-continuation"); release(); await finish(p, ref);
    if (mutation !== "version") await p.harness.commit(async tx => {
      const value = (await tx.doc(PersonalDelegationDoc, String(ref.entryId), null)).delegation!;
      const old = (await tx.submissionByRequest(ROOT_CONVERSATION_ID, "unrelated"))!;
      const replacement = { requestId: "unrelated", submissionId: old.id, entryId: old.entry! };
      if (mutation === "continuation") (await tx.doc(PersonalWorkDoc, value.members[1].requestId, null)).instructionSource = replacement;
      else (await tx.doc(PersonalWorkDoc, value.members[0].requestId, null)).notes![0].source = { kind: "input", ...replacement };
    }, context);
    await p.close();
    if (mutation === "version") {
      const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
      const record = await storage.findDocument({ kind: PersonalDelegationDoc.definition.kind, scope: { kind: "session" }, key: String(ref.entryId) }, "current", context); assert.ok(record);
      const saved = await storage.document(record.id, "current", context); assert.ok(saved);
      await storage.commit([{ type: "document.change", id: record.id, content: { kind: "base", version: 2, value: saved.value } }], context); await storage.close(context);
    }
    const count = f.model.calls.length;
    await assert.rejects(f.open(), code(mutation === "note" ? "work_note_invalid" : mutation === "version" ? "delegation_record_invalid" : "delegation_member_invalid")); assert.equal(f.model.calls.length, count);
  });
});

test("分析委托：Telegram 原菜单与跨入口续派/追加核实，重投零模型，换代不串线", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { await wait; return { kind: "text", text: "完成" }; }); const telegram = await f.telegram(); let p = await f.open({ telegram });
  await f.receive(args("delegate", { content: "TG分析" })); const ref = await first(p);
  assert.match(await p.answer(args("delegate", { content: "跨入口", delegation: ref.entryId }), "local"), /delegation_original_entry/);
  const member = (await progress(p, ref)).members[0].ref;
  assert.match(await p.answer(args("append", { work: member.taskId, content: "跨入口说明" }), "local-note"), /delegation_original_entry/);
  const list = await f.receive("/委托"); const menu = await f.receive("委托1", list.messageId); const count = f.model.calls.length;
  for (const extra of [{ forward_origin: { type: "user" } }, { quote: { text: "取消整项分析" } }]) await f.receive("取消整项分析", menu.messageId, extra);
  await f.receive("取消整项分析", 999999); assert.equal((await progress(p, ref)).cancelRequested, false);
  const canceled = await f.receive("取消整项分析", menu.messageId); await p.telegram.receive(canceled.update); await finish(p, ref);
  assert.equal((await progress(p, ref)).state, "canceled"); assert.equal(f.model.calls.length, count); assert.match(canceled.value.reply!, /固定服务检查.*不包含独立宿主服务写操作/);
  await p.close(); p = await f.open({ telegram: { ...telegram, generation: randomUUID() } });
  assert.match((await f.receive("/委托")).value.reply!, /暂无/); assert.match((await f.receive("取消整项分析", menu.messageId)).value.reply!, /没有改变/);
});

test("分析委托：本机向导按说明查询取消，丢失应答只查询原事实", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async () => { await wait; return { kind: "text", text: "完成" }; }); const p = await f.open();
  await p.answer(args("delegate", { content: "本机分析" }), "owner"); const ref = await first(p); await p.close(); await f.start();
  let output = ""; const choices = ["1", "2", "3", "2"];
  await managePersonalDelegations({ question: async () => choices.shift()!, write: text => { output += text; } }, f.directory);
  assert.match(output, /取消请求已登记/); assert.match(output, /本机分析|delegate/);
  await new Promise<void>((resolve, reject) => { const request = http.request({ socketPath: path.join(f.directory, "control.sock"), method: "POST", path: `/delegation/cancel?delegation=${ref.entryId}`, headers: { authorization: `Bearer ${readPersonalToken(f.directory)}` } }, response => { response.destroy(); resolve(); }); request.on("error", reject); request.end(); });
  await until(async () => (await personalControl<{ state: string }>(f.directory, "GET", `/delegation?delegation=${ref.entryId}`)).state === "canceled");
});

test("分析委托：整项取消提交后真实强杀，重开不发送新子请求且保留归属", { timeout: 15000 }, async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "长回答".repeat(500), chunkDelayMs: 10 }));
  const p = await f.open(); await p.answer("multi", "owner"); const ref = await first(p); await p.close();
  const script = `import {openPersonalHarness} from "./apps/ruukoto/src/personal-harness.ts";import {personalProvider} from "./apps/ruukoto/src/personal-model.ts";import {cancelPersonalDelegation} from "./apps/ruukoto/src/personal-delegation.ts";import {BACKGROUND_CONTEXT as c} from "@earendil-works/chord/context";const {directory,config,ref}=JSON.parse(process.env.RUUKOTO_DELEGATION_CRASH);const p=await openPersonalHarness({directory,provider:personalProvider(config),modelId:config.modelId});await p.harness.commit(tx=>cancelPersonalDelegation(tx,ref),c);process.stdout.write("canceled-gap\\n");setInterval(()=>{},1000);`;
  const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_DELEGATION_CRASH: JSON.stringify({ directory: f.directory, config: f.config, ref }) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; processChild.stdout.on("data", data => { output += data; }); processChild.stderr.pipe(process.stderr);
  t.after(() => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); });
  await until(() => output.includes("canceled-gap")); const exited = once(processChild, "exit"); processChild.kill("SIGKILL"); await exited;
  const before = f.model.calls.filter(child).length; const restored = await f.open(); await finish(restored, ref);
  assert.equal((await progress(restored, ref)).state, "canceled"); assert.equal(f.model.calls.filter(child).length, before);
});
