import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { answerPersonalQuestion, cancelPersonalQuestion, cancelPersonalWorkQuestions, personalQuestionList, personalQuestionDetail, PersonalQuestionDoc, PersonalQuestionsDoc, type PersonalQuestion } from "../apps/ruukoto/src/personal-questions.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalWorkDoc, personalWorkResult, type PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { requestPersonalWorkCancel } from "../apps/ruukoto/src/personal-work.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { requirePersonalQuestionBoundary } from "../apps/ruukoto/src/personal-questions.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalScheduleDoc, PersonalScheduleRunDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";

const context = BACKGROUND_CONTEXT;
const child = (request: RecordedRequest) => request.system?.includes("你是个人助手的子 Agent");
const questions = [{ question: "选择目标", options: ["甲", "乙"] }];
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, "Work question did not settle"); await delay(5); } }
async function fixture(t: TestContext, respond: Responder) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-work-question-")), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const model = new PersonalMockModelServer(respond), config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_WORK_QUESTION_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const prior = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "work-question", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
  let p: PersonalHarness | undefined;
  const open = async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, ...overrides });
  t.after(async () => { await p?.close(); await model.close(); if (prior === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = prior; fs.rmSync(root, { recursive: true, force: true }); });
  isolateSkillHome(t);
  return { root, directory, workspace, model, config, tools, open };
}
async function work(p: PersonalHarness, id: string) {
  await p.answer("拥有者来源", `owner-${id}`);
  return p.work.delegate({ content: id, requestId: id, sourceRequestId: `owner-${id}` });
}
async function pending(p: PersonalHarness, ref: PersonalWorkRef) {
  let value: PersonalQuestion | undefined;
  await until(async () => { const list = await p.harness.commit(tx => personalQuestionList(tx), context); for (const item of list.items) { const q = await p.harness.commit(tx => personalQuestionDetail(tx, item.id), context); if (q.work?.ref.taskId === ref.taskId && q.status === "pending") value = q; } return value !== undefined; });
  return value!;
}
const input = (q: PersonalQuestion, text = "甲") => ({ question: q.id, version: q.version, requestId: randomUUID(), answers: [{ text }] });

test("work questions: concurrent answers stay with their original work and do not complete registration", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => {
    if (!child(request)) return { kind: "text", text: "主会话可用" };
    const asked = request.messages.some(message => message.role === "tool" && String(message.content).includes('"status":"answered"'));
    return asked ? { kind: "text", text: `完成:${request.messages.filter(message => message.role === "tool").map(message => message.content).join("")}` } : { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] };
  });
  let p = await f.open(); const a = await work(p, "A"), b = await work(p, "B"), qa = await pending(p, a), qb = await pending(p, b);
  assert.equal((await p.harness.getTask(a.taskId, context))!.state.status, "running");
  assert.equal((await p.harness.getTask(b.taskId, context))!.state.status, "running");
  assert.equal((await p.harness.commit(tx => personalWorkResult(tx, a), context)).questions![0].id, qa.id);
  assert.equal(await p.answer("继续聊天", "chat"), "主会话可用");
  const before = (await p.harness.snapshot(PersonalWorkDoc, a.requestId, context))!.permission;
  await p.harness.commit(async tx => { const permissions = await tx.doc(PersonalPermissionsDoc); permissions.mode = "full_access"; permissions.version++; }, context);
  const answerB = input(qb, "答案B"), receiptB = await p.harness.commit(tx => answerPersonalQuestion(tx, answerB, { kind: "local" }), context); p.harness.resume();
  await p.harness.waitForTask(b.taskId, context);
  assert.equal((await p.harness.getTask(a.taskId, context))!.state.status, "running");
  assert.equal(receiptB.taskId, qb.operation);
  const answerA = input(qa, "答案A"), receiptA = await p.harness.commit(tx => answerPersonalQuestion(tx, answerA, { kind: "local" }), context); p.harness.resume();
  assert.deepEqual(await p.harness.commit(tx => answerPersonalQuestion(tx, answerA, { kind: "local" }), context), receiptA);
  await assert.rejects(p.harness.commit(tx => answerPersonalQuestion(tx, { ...answerA, requestId: randomUUID() }, { kind: "local" }), context), code("question_not_pending"));
  await p.harness.waitForTask(a.taskId, context);
  assert.match((await p.harness.commit(tx => personalWorkResult(tx, a), context)).text!, /答案A/);
  assert.doesNotMatch((await p.harness.commit(tx => personalWorkResult(tx, a), context)).text!, /答案B/);
  assert.match((await p.harness.commit(tx => personalWorkResult(tx, b), context)).text!, /答案B/);
  assert.deepEqual((await p.harness.snapshot(PersonalWorkDoc, a.requestId, context))!.permission, before);
  assert.deepEqual((await p.harness.commit(tx => personalQuestionDetail(tx, qa.id), context)).answer!.permission, before);
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.question-continuation" }, 256), context)).items.length, 0);
  await p.close(); p = await f.open();
  assert.deepEqual(await p.harness.commit(tx => answerPersonalQuestion(tx, answerA, { kind: "local" }), context), receiptA);
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, qa.id), context)).answer!.delivery, "returned");
});

test("work questions: ordinary amendments do not answer; saved update and real answer reach the next request", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => {
    if (!child(request)) return { kind: "text", text: "收到" };
    if (!request.messages.some(message => message.role === "tool")) return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] };
    return { kind: "text", text: "按新要求和答案完成" };
  });
  const p = await f.open(), ref = await work(p, "original"), q = await pending(p, ref);
  await p.work.append(ref, { requestId: "update", content: "新要求", sourceRequestId: "owner-original" });
  await delay(30);
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, q.id), context)).status, "pending");
  assert.equal(f.model.calls.filter(child).length, 1);
  await p.harness.commit(tx => answerPersonalQuestion(tx, input(q, "实际答案"), { kind: "local" }), context); p.harness.resume();
  await p.harness.waitForTask(ref.taskId, context);
  const resumed = f.model.calls.filter(child)[1];
  assert.ok(resumed.messages.some(message => message.role === "user" && message.content === "新要求"));
  assert.ok(resumed.messages.some(message => message.role === "tool" && String(message.content).includes("实际答案")));
  assert.match(resumed.system!, /新要求/);
});

test("work questions: cancel one work rejects its late answer while unrelated questions remain pending", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => !child(request) || request.messages.some(message => message.role === "tool") ? { kind: "text", text: "结束" } : { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] });
  const p = await f.open(), a = await work(p, "A"), b = await work(p, "B"), qa = await pending(p, a), qb = await pending(p, b);
  await p.work.cancel(a);
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, qa.id), context)).status, "stale");
  await assert.rejects(p.harness.commit(tx => answerPersonalQuestion(tx, input(qa), { kind: "local" }), context), code("question_not_pending"));
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, qb.id), context)).status, "pending");
  await p.harness.commit(tx => cancelPersonalQuestion(tx, { question: qb.id, version: qb.version, requestId: randomUUID() }, { kind: "local" }), context); p.harness.resume();
  await p.harness.waitForTask(b.taskId, context);
  assert.equal(f.model.calls.filter(child).filter(request => request.messages.some(message => message.role === "tool")).length, 1);
});

test("work questions: original child and question bindings cannot disappear on reopen", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => !child(request) ? { kind: "text", text: "收到" } : request.messages.some(message => message.role === "tool") ? { kind: "text", text: "完成" } : { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] });
  const p = await f.open(), ref = await work(p, "A"), q = await pending(p, ref);
  await p.harness.commit(tx => answerPersonalQuestion(tx, input(q), { kind: "local" }), context); p.harness.resume(); await p.harness.waitForTask(ref.taskId, context);
  await p.harness.commit(async tx => { (await tx.doc(PersonalQuestionsDoc)).ids = []; delete (await tx.doc(PersonalQuestionDoc, q.id, null)).question; }, context);
  await p.close();
  await assert.rejects(f.open(), code("question_record_invalid"));
});

test("work questions: prior write stays committed and the asking batch cannot write after an answer", { timeout: 30000 }, async t => {
  let target = "";
  const f = await fixture(t, request => {
    if (!child(request)) return { kind: "text", text: "收到" };
    const results = request.messages.filter(message => message.role === "tool");
    if (!results.length) return { kind: "tool_calls", calls: [{ id: "prior", name: "write_file", arguments: { path: target, content: "one prior effect" } }] };
    if (!results.some(message => String(message.content).includes('"status":"answered"'))) return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }, { id: "old-write", name: "write_file", arguments: { path: target, content: "stale sibling effect" } }] };
    return { kind: "text", text: "按实际答案完成" };
  });
  target = path.join(f.workspace, "result.txt"); fs.writeFileSync(target, "initial");
  let p = await f.open(); await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context);
  const ref = await work(p, "write-and-ask"), q = await pending(p, ref);
  assert.equal(fs.readFileSync(target, "utf8"), "one prior effect");
  await assert.rejects(p.harness.commit(tx => requirePersonalQuestionBoundary(tx, ref.agentId, q.generation), context), code("question_boundary_wait"));
  await p.harness.commit(tx => answerPersonalQuestion(tx, input(q), { kind: "local" }), context); p.harness.resume();
  await p.harness.waitForTask(ref.taskId, context);
  assert.equal(fs.readFileSync(target, "utf8"), "one prior effect");
  assert.equal(await p.harness.commit(async tx => (await toolOperations(tx)).filter(op => op.kind === "write_file").length, context), 1);
  await p.close(); p = await f.open();
  assert.equal(fs.readFileSync(target, "utf8"), "one prior effect");
  assert.equal(await p.harness.commit(async tx => (await toolOperations(tx)).filter(op => op.kind === "write_file").length, context), 1);
});

test("work questions: whole-assignment cancellation registers every concurrent question", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => !child(request) ? { kind: "text", text: "收到" } : { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] });
  const p = await f.open(), a = await work(p, "A"), b = await work(p, "B"), qa = await pending(p, a), qb = await pending(p, b);
  await p.harness.commit(async tx => { await requestPersonalWorkCancel(tx, a); await requestPersonalWorkCancel(tx, b); }, context);
  await p.work.cancel(a); await p.work.cancel(b);
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, qa.id), context)).status, "stale");
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, qb.id), context)).status, "stale");
});

test("work questions: cancellation after answer commit keeps the claim but prevents answer return", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => !child(request) ? { kind: "text", text: "收到" } : { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] });
  const p = await f.open(), ref = await work(p, "A"), q = await pending(p, ref);
  const receipt = await p.harness.commit(async tx => { const receipt = await answerPersonalQuestion(tx, input(q), { kind: "local" }); (await tx.doc(PersonalWorkDoc, ref.requestId, null)).cancelRequested = true; return receipt; }, context); p.harness.resume();
  await p.work.cancel(ref);
  const saved = await p.harness.commit(tx => personalQuestionDetail(tx, q.id), context);
  assert.equal(saved.status, "answered"); assert.equal(saved.answer!.delivery, "canceled");
  assert.equal(saved.answer!.returned, undefined); assert.equal(saved.answer!.admission, receipt.entry);
  assert.equal(f.model.calls.filter(child).length, 1);
});

test("work questions: cancellation after return selection preserves the actual answer without resuming", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => !child(request) || request.messages.some(message => message.role === "tool") ? { kind: "text", text: "完成" } : { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] });
  let p = await f.open(); const ref = await work(p, "A"), q = await pending(p, ref), commit = p.harness.commit.bind(p.harness);
  let canceled = false;
  p.harness.commit = async (change, callContext) => {
    const result = await commit(change, callContext);
    if (!canceled && result && typeof result === "object" && "answer" in result && result.answer && typeof result.answer === "object" && "delivery" in result.answer && result.answer.delivery === "returned") { canceled = true; await commit(async tx => { await requestPersonalWorkCancel(tx, ref); await cancelPersonalWorkQuestions(tx, ref); }, context); }
    return result;
  };
  await commit(tx => answerPersonalQuestion(tx, input(q, "实际答案"), { kind: "local" }), context); p.harness.resume();
  await p.harness.waitForTask(ref.taskId, context); p.harness.commit = commit;
  const saved = await p.harness.commit(tx => personalQuestionDetail(tx, q.id), context);
  assert.equal(canceled, true); assert.equal(saved.answer!.delivery, "canceled"); assert.ok(saved.answer!.returned); assert.ok(saved.answer!.canceled);
  const entries = (await (await p.harness.conversation(ref.agentId, context))!.entries({}, 256, undefined, context)).items;
  const result = entries.find(entry => entry.byTaskId === q.operation)?.model?.[0]; assert.ok(result?.role === "toolResult"); assert.match(JSON.stringify(result), /实际答案/);
  assert.equal(f.model.calls.filter(child).length, 1);
  await p.close(); p = await f.open(); assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, q.id), context)).answer!.delivery, "canceled");
});

test("work questions: maximum answers return intact and the same work can ask again", { timeout: 30000 }, async t => {
  const batch = Array.from({ length: 3 }, (_, index) => ({ question: `Q${index}` + "\0".repeat(1998), options: Array.from({ length: 5 }, (_, choice) => ({ label: `${choice}` + "\0".repeat(199), description: "\0".repeat(500), recommended: choice === 0 })) }));
  const f = await fixture(t, request => {
    if (!child(request)) return { kind: "text", text: "收到" };
    const answered = request.messages.filter(message => message.role === "tool" && String(message.content).includes('"status":"answered"'));
    if (answered.length === 2) return { kind: "text", text: "两个问题批次已完成" };
    return { kind: "tool_calls", calls: [{ id: `ask-${answered.length}`, name: "ask_user", arguments: { questions: answered.length === 0 ? batch : questions } }] };
  });
  let p = await f.open(), ref = await work(p, "maximum"), q = await pending(p, ref);
  const answers = batch.map(() => ({ text: "答" + "\0".repeat(4095) }));
  await p.harness.commit(tx => answerPersonalQuestion(tx, { ...input(q), answers }, { kind: "local" }), context); p.harness.resume();
  const original = q;
  await until(async () => (await p.harness.snapshot(PersonalQuestionsDoc, context))!.ids.length === 2);
  q = await pending(p, ref);
  const actual = f.model.calls.filter(child)[1].messages.find(message => message.role === "tool" && String(message.content).includes('"status":"answered"'))!;
  const result = JSON.parse(String(actual.content)) as { questions: PersonalQuestion["questions"]; answers: { text: string }[] };
  assert.deepEqual(result.answers, answers); assert.equal(result.answers[2].text.length, 4096); assert.deepEqual(result.questions, batch);
  assert.ok(Buffer.byteLength(String(actual.content)) < 256 * 1024);
  assert.equal((await p.harness.getTask(ref.taskId, context))!.state.status, "running");
  await p.harness.commit(tx => answerPersonalQuestion(tx, input(q, "第二批"), { kind: "local" }), context); p.harness.resume(); await p.harness.waitForTask(ref.taskId, context);
  await p.close(); p = await f.open(); assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, original.id), context)).answer!.delivery, "returned");
});

test("work questions: only the original IM question menu can answer and reply-time defaults do not widen work", { timeout: 30000 }, async t => {
  const token = "123:work-question-fixture", tokenEnv = "RUUKOTO_WORK_QUESTION_IM_KEY", prior = process.env[tokenEnv]; process.env[tokenEnv] = token;
  let sent = 1000;
  const bot = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { chat_id: string; message_id?: number };
    if (req.url?.endsWith("/sendChatAction") || req.url?.endsWith("/answerCallbackQuery")) { res.end(JSON.stringify({ ok: true, result: true })); return; }
    if (req.url?.endsWith("/editMessageText")) { res.end(JSON.stringify({ ok: true, result: { message_id: body.message_id, chat: { id: Number(body.chat_id), type: "private" } } })); return; }
    assert.equal(req.url, `/bot${token}/sendMessage`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: { message_id: ++sent, chat: { id: Number(body.chat_id), type: "private" } } }));
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); if (prior === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = prior; });
  const f = await fixture(t, request => !child(request) ? { kind: "text", text: "收到" } : request.messages.some(message => message.role === "tool") ? { kind: "text", text: "按原答案完成" } : { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] });
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: createHash("sha256").update(token).digest("hex"), botId: "123", ownerId: "456", boundary: 10 };
  let p = await f.open({ telegram }), messageId = 100;
  const receive = async (text: string, reply?: number) => {
    const id = ++messageId;
    await p.telegram.receive({ update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(reply === undefined ? {} : { reply_to_message: { message_id: reply, from: { id: 123, is_bot: true } } }) } });
    const value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, `telegram:123:456:${id}`, context))!.receipt!;
    await p.harness.waitForTask(value.taskId, context);
    return (await p.harness.snapshot(PersonalTelegramReceiptDoc, value.requestId, context))!.receipt!;
  };
  const original = await receive("拥有者来源"), ref = await p.work.delegate({ content: "IM work", requestId: "im-work", sourceRequestId: original.requestId }), q = await pending(p, ref);
  await assert.rejects(p.harness.commit(tx => answerPersonalQuestion(tx, input(q), { kind: "local" }), context), code("question_original_entry_required"));
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.version++; }, context);
  let menu = await receive("/问题"); menu = await receive("问题1", Number(menu.platformMessageId));
  const receipt = await receive("1", Number(menu.platformMessageId)); assert.ok(receipt.questionAnswer);
  await p.harness.waitForTask(ref.taskId, context);
  const answered = await p.harness.commit(tx => personalQuestionDetail(tx, q.id), context);
  assert.equal(answered.answer!.delivery, "returned"); assert.equal(answered.answer!.permission.mode, q.origin.permission.mode); assert.equal(answered.answer!.actor.kind, "im");
  await p.close(); p = await f.open({ telegram }); assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, q.id), context)).answer!.delivery, "returned");
});

test("work questions: cancel a scheduled occurrence with concurrent questions and retain future triggers", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => {
    if (child(request)) return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] };
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "scheduled-members") return { kind: "tool_calls", calls: [{ id: "a", name: "background_work", arguments: { action: "delegate", content: "scheduled-A" } }, { id: "b", name: "background_work", arguments: { action: "delegate", content: "scheduled-B" } }] };
    return { kind: "text", text: "安排完成" };
  });
  let clock = Date.parse("2026-11-05T00:00:00Z"), p = await f.open({ now: () => clock });
  const plan = await p.harness.commit(tx => p.scheduler.create(tx, { requestId: "question-schedule", label: "Scheduled questions", instruction: "scheduled-members", rule: { kind: "daily", time: "00:01", time_zone: "UTC" } }, { kind: "local", requestId: "question-schedule" }), context);
  clock = Date.parse("2026-11-05T00:01:02Z"); await p.harness.commit(tx => p.scheduler.scan(tx, clock), context);
  const runId = (await p.harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!.activeRun!;
  await until(async () => (await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!.members.length === 2);
  const run = (await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!, a = run.members[0], b = run.members[1], qa = await pending(p, a), qb = await pending(p, b);
  await p.harness.commit(tx => p.scheduler.cancelRun(tx, runId, { kind: "local", requestId: "cancel-occurrence" }), context);
  await assert.rejects(p.harness.commit(tx => answerPersonalQuestion(tx, input(qa), { kind: "local" }), context), error => error instanceof PersonalError && ["question_not_pending", "schedule_run_inactive"].includes(error.code));
  await p.harness.waitForTask(run.taskId, context);
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, qa.id), context)).status, "stale");
  assert.equal((await p.harness.commit(tx => personalQuestionDetail(tx, qb.id), context)).status, "stale");
  const future = (await p.harness.snapshot(PersonalScheduleDoc, plan.id, context))!.plan!; assert.equal(future.canceled, false); assert.equal(future.nextDueAt, "2026-11-06T00:01:00.000Z");
  await p.close(); p = await f.open({ now: () => clock }); assert.equal((await p.harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!.result!.status, "canceled");
});

test("work questions: strong-kill reopen resumes the original question and prior effect once", { timeout: 60000 }, async t => {
  for (const phase of ["question", "answer", "return", "result"] as const) await t.test(phase, async t => {
    let target = "";
    const f = await fixture(t, request => {
      if (!child(request)) return { kind: "text", text: "收到" };
      const results = request.messages.filter(message => message.role === "tool");
      if (!results.length) return { kind: "tool_calls", calls: [{ id: "prior", name: "write_file", arguments: { path: target, content: "one prior effect" } }] };
      if (!results.some(message => String(message.content).includes('"status":"answered"'))) return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] };
      return { kind: "text", text: "原工作完成" };
    });
    target = path.join(f.workspace, "result.txt"); fs.writeFileSync(target, "initial");
    const filename = path.join(f.root, "crash.json"), requestId = randomUUID();
    fs.writeFileSync(filename, JSON.stringify({ directory: f.directory, config: f.config, tools: f.tools, phase, requestId }), { mode: 0o600 });
    const processChild = spawn(process.execPath, ["--import", "tsx", new URL("./helpers/personal-work-questions-crash.mts", import.meta.url).pathname, filename], { stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = ""; processChild.stderr.on("data", chunk => { diagnostics += String(chunk); });
    t.after(() => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); });
    const [exit, signal] = await once(processChild, "exit"); assert.equal(exit, null, diagnostics); assert.equal(signal, "SIGKILL", diagnostics);
    assert.equal(fs.readFileSync(target, "utf8"), "one prior effect");
    const p = await f.open();
    const agents = await p.work.list(), ref = agents[0].work!; assert.ok(ref);
    let q = await p.harness.commit(async tx => personalQuestionDetail(tx, (await tx.doc(PersonalQuestionsDoc)).ids[0]), context);
    if (phase === "question") await p.harness.commit(tx => answerPersonalQuestion(tx, { ...input(q), requestId }, { kind: "local" }), context);
    p.harness.resume(); await p.harness.waitForTask(ref.taskId, context);
    q = await p.harness.commit(tx => personalQuestionDetail(tx, q.id), context);
    assert.equal(q.answer!.delivery, "returned"); assert.equal(q.answer!.taskId, q.operation);
    assert.equal(fs.readFileSync(target, "utf8"), "one prior effect");
    assert.equal(await p.harness.commit(async tx => (await toolOperations(tx)).filter(op => op.kind === "write_file").length, context), 1);
    const entries = (await (await p.harness.conversation(ref.agentId, context))!.entries({}, 256, undefined, context)).items;
    assert.equal(entries.filter(entry => entry.kind === "ruukoto.work-question-return").length, 1);
    assert.equal(entries.filter(entry => entry.byTaskId === q.operation && entry.model?.some(message => message.role === "toolResult" && message.toolName === "ask_user")).length, 1);
    assert.equal(f.model.calls.filter(child).filter(request => request.messages.some(message => message.role === "tool" && String(message.content).includes('"status":"answered"'))).length, 1);
  });
});
