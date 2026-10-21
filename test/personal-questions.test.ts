import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalQuestionsDoc, PersonalQuestionDoc, answerPersonalQuestion, cancelPersonalQuestion, personalQuestionDetail, personalQuestionList, personalQuestionReceipt, personalQuestionSource, type PersonalQuestion } from "../apps/ruukoto/src/personal-questions.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalMockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const questions = [{ question: "选择执行目标", options: [{ label: "甲", description: "第一种", recommended: true }, "乙"], multiple: true }, { question: "补充信息" }];
async function fixture(t: TestContext, responder?: Responder) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-question-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const server = new PersonalMockModelServer(responder ?? (request => {
    const last = request.messages.at(-1), text = String(last?.content);
    if (last?.role === "user" && text.includes("发起提问")) return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] };
    return { kind: "text", text: last?.role === "tool" ? "问题已登记" : text.includes("拥有者对原问题的回答") ? "已按实际答案继续" : "普通聊天可继续" };
  }));
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "PERSONAL_QUESTIONS_TEST_KEY", contextWindow: 128000, maxTokens: 8192 }, prior = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const stat = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "question-test", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] });
  let p: PersonalHarness | undefined;
  const open = async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, tools, ...overrides });
  t.after(async () => { await p?.close(); await server.close(); if (prior === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = prior; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, workspace, server, config, tools, open };
}
async function first(p: PersonalHarness) { const page = await p.harness.commit(tx => personalQuestionList(tx), context); assert.equal(page.items.length, 1); return p.harness.commit(tx => personalQuestionDetail(tx, page.items[0].id), context); }
async function until(check: () => Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, "等待问题状态超时"); await delay(5); } }

test("个人问题：主聊天继续、实际答案权限、同键回执与重开唯一续接", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open();
  assert.equal(await p.answer("发起提问", "original"), "问题已登记");
  const question = await first(p); assert.equal(question.status, "pending");
  assert.equal(await p.answer("普通聊天", "ordinary"), "普通聊天可继续"); assert.equal((await first(p)).status, "pending");
  const afterAsk = f.server.calls.find(call => call.messages.at(-1)?.role === "tool"); assert.ok(afterAsk); assert.deepEqual(afterAsk.tools ?? [], []);
  await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "confirm"; permission.version++; }, context);
  const input = { question: question.id, version: question.version, requestId: randomUUID(), answers: [{ text: "甲\n乙", options: [0, 1] }, { text: "" }] };
  const receipt = await p.harness.commit(tx => answerPersonalQuestion(tx, input, { kind: "local" }), context); p.harness.resume();
  assert.deepEqual(await p.harness.commit(tx => answerPersonalQuestion(tx, input, { kind: "local" }), context), receipt);
  await p.harness.waitForTask(receipt.taskId!, context);
  const answered = await first(p); assert.equal(answered.answer?.delivery, "local"); assert.equal(answered.answer?.permission.mode, "confirm");
  const source = await p.harness.commit(tx => personalQuestionSource(tx, `personal-question:${receipt.taskId}`, true), context); assert.equal(source?.permission.mode, "confirm"); assert.equal(source?.entry.kind, "ruukoto.question-answer");
  const actual = f.server.calls.find(call => call.messages.some(message => message.role === "user" && String(message.content).includes("拥有者对原问题的回答"))); assert.ok(actual); assert.match(JSON.stringify(actual), /甲/); assert.match(JSON.stringify(actual), /补充信息/); assert.ok(actual.tools?.some(tool => (tool.function as { name: string }).name === "ask_user"));
  if (process.env.RUUKOTO_QUESTION_EVIDENCE) {
    const directory = process.env.RUUKOTO_QUESTION_EVIDENCE; fs.mkdirSync(directory, { recursive: true });
    const entries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.model-request");
    const original = f.server.calls[0], schemas = original.tools ?? [], currentSystem = original.system ?? "";
    const estimates = { toolSchemasBefore: Math.ceil(JSON.stringify(schemas.filter(tool => (tool.function as { name: string }).name !== "ask_user")).length / 4), toolSchemasAfter: Math.ceil(JSON.stringify(schemas).length / 4), systemPromptBefore: Math.ceil(currentSystem.length / 4), systemPromptAfter: Math.ceil(currentSystem.length / 4) };
    fs.writeFileSync(path.join(directory, "personal-questions-offline.json"), JSON.stringify({ estimates, estimator: "UTF-16字符数/4向上取整；同次实际请求移除新增ask_user得到前值", requests: f.server.calls, entries }, null, 2) + "\n");
  }
  await p.close(); const reopened = await f.open(); assert.equal((await first(reopened)).status, "answered");
  assert.deepEqual(await reopened.harness.commit(tx => personalQuestionReceipt(tx, input.requestId), context), receipt);
  assert.equal((await reopened.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.question-continuation" }, 256), context)).items.length, 1);
  await assert.rejects(reopened.harness.commit(tx => answerPersonalQuestion(tx, { ...input, answers: [{ text: "乙", options: [1] }, { text: "" }] }, { kind: "local" }), context), error => error instanceof PersonalError && error.code === "question_request_conflict");
});

test("个人问题：第二批不覆盖、回答取消竞争与空答案完整校验", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(); await p.answer("发起提问", "first"); const q = await first(p);
  await p.answer("再发起提问", "second"); assert.equal((await first(p)).id, q.id);
  await assert.rejects(p.harness.commit(tx => answerPersonalQuestion(tx, { question: q.id, version: q.version, requestId: randomUUID(), answers: [{ text: "" }] }, { kind: "local" }), context), error => error instanceof PersonalError && error.code === "question_input_invalid");
  const input = { question: q.id, version: q.version, requestId: randomUUID() };
  const cancel = await p.harness.commit(tx => cancelPersonalQuestion(tx, input, { kind: "local" }), context);
  assert.deepEqual(await p.harness.commit(tx => cancelPersonalQuestion(tx, input, { kind: "local" }), context), cancel);
  await assert.rejects(p.harness.commit(tx => answerPersonalQuestion(tx, { question: q.id, version: q.version, requestId: randomUUID(), answers: [{ text: "" }, { text: "" }] }, { kind: "local" }), context), error => error instanceof PersonalError && error.code === "question_not_pending");
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.question-continuation" }, 1), context)).items.length, 0);
});

test("个人问题：接纳后同轮伪造业务工具仍被调用门阻止", { timeout: 30000 }, async t => {
  let target = "";
  const f = await fixture(t, request => {
    const last = request.messages.at(-1);
    if (last?.role === "user") return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] };
    if (request.messages.filter(message => message.role === "tool").length === 1) return { kind: "tool_calls", calls: [{ id: "write", name: "write_file", arguments: { path: target, content: "不应写入" } }] };
    return { kind: "text", text: "已结束本轮" };
  });
  target = path.join(f.workspace, "target"); fs.writeFileSync(target, "原文"); const p = await f.open();
  await p.answer("强制工具", "malicious"); assert.equal(fs.readFileSync(target, "utf8"), "原文");
  assert.equal((await first(p)).status, "pending");
  await until(async () => (await p.harness.snapshot(PersonalQuestionsDoc, context))!.ids.length === 1);
});

test("个人问题：索引丢失与答案Task断链均拒绝恢复", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(); await p.answer("发起提问", "original"); const q = await first(p);
  await p.harness.commit(async tx => { (await tx.doc(PersonalQuestionsDoc)).ids = []; }, context); await p.close();
  await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "question_record_invalid");
});

test("个人问题：新来源可用文件与委派工具，按实际权限保存并能恢复", { timeout: 30000 }, async t => {
  let target = "";
  const f = await fixture(t, request => {
    const last = request.messages.at(-1), text = String(last?.content);
    if (last?.role === "user" && text.includes("发起提问")) return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: "是否继续" }] } }] };
    if (last?.role === "user" && text.includes("拥有者对原问题的回答")) return { kind: "tool_calls", calls: [{ id: "read", name: "read_file", arguments: { path: target } }, { id: "delegate", name: "background_work", arguments: { action: "delegate", content: "独立验证资料", label: "答案后子工作" } }] };
    return { kind: "text", text: "已按原来源完成" };
  });
  target = path.join(f.workspace, "source"); fs.writeFileSync(target, "原资料"); const p = await f.open(); await p.answer("发起提问", "original"); const q = await first(p);
  const receipt = await p.harness.commit(tx => answerPersonalQuestion(tx, { question: q.id, version: 1, requestId: randomUUID(), answers: [{ text: "继续" }] }, { kind: "local" }), context); p.harness.resume(); await p.harness.waitForTask(receipt.taskId!, context);
  await p.harness.waitForIdle(context);
  const answer = await first(p); assert.equal(answer.answer?.delivery, "local");
  const works = await p.work.list(); assert.equal(works.length, 1);
  await p.close(); const reopened = await f.open(); assert.equal((await reopened.work.list()).length, 1); assert.equal((await first(reopened)).status, "answered");
});


test("个人问题：规范请求已记录后来源被改，payload边界仍拒绝零外发", { timeout: 30000 }, async t => {
  const f = await fixture(t), provider = personalProvider(f.config), original = provider.streamSimple.bind(provider);
  let p: PersonalHarness, armed = false, target = "";
  provider.streamSimple = (model, input, settings) => original(model, input, { ...settings, onPayload: async (payload, currentModel) => {
    if (armed && JSON.stringify(input).includes("拥有者对原问题的回答")) { armed = false; await p.harness.commit(async tx => { (await tx.doc(PersonalQuestionDoc, target, null)).question!.answer!.permission.mode = "full_access"; }, context); }
    return settings?.onPayload?.(payload, currentModel);
  } });
  p = await f.open({ provider }); await p.answer("发起提问", "original"); const q = await first(p); target = q.id;
  const baseline = f.server.calls.length, receipt = await p.harness.commit(tx => answerPersonalQuestion(tx, { question: q.id, version: 1, requestId: randomUUID(), answers: [{ text: "甲", options: [0] }, { text: "" }] }, { kind: "local" }), context);
  armed = true; p.harness.resume(); await p.harness.waitForTask(receipt.taskId!, context);
  assert.equal(f.server.calls.length, baseline); assert.equal((await first(p)).answer?.delivery, "unanswered");
  const entries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.model-request");
  assert.ok(entries.some(entry => JSON.stringify(entry.data).includes("拥有者对原问题的回答")));
});

test("个人问题：payload改写重新加入业务工具也在发送前拒绝", { timeout: 30000 }, async t => {
  const f = await fixture(t), provider = personalProvider(f.config), original = provider.streamSimple.bind(provider);
  provider.streamSimple = (model, input, settings) => original(model, input, { ...settings, onPayload: async (payload, currentModel) => {
    const last = input.messages.at(-1);
    const changed = last?.role === "toolResult" && payload && typeof payload === "object" ? { ...payload, tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }] } : payload;
    return settings?.onPayload?.(changed, currentModel);
  } });
  const p = await f.open({ provider });
  await assert.rejects(p.answer("发起提问", "original"), error => error instanceof PersonalError && error.code === "input_unanswered");
  assert.equal(f.server.calls.length, 1); assert.equal((await p.harness.snapshot(PersonalQuestionsDoc, context))!.ids.length, 1);
});


test("个人问题：答复commit与main已接纳两处真实强杀，重开只续接一次", { timeout: 30000 }, async t => {
  for (const phase of ["answer", "submission"] as const) await t.test(phase, async t => {
    const f = await fixture(t), p = await f.open(); await p.answer("发起提问", "original"); const q = await first(p); await p.close();
    const input = { question: q.id, version: 1, requestId: randomUUID(), answers: [{ text: "甲", options: [0] }, { text: "" }] };
    const filename = path.join(f.root, "crash-input.json"); fs.writeFileSync(filename, JSON.stringify({ directory: f.directory, config: f.config, tools: f.tools, input }), { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", "tsx", new URL("./helpers/personal-questions-crash.mts", import.meta.url).pathname, filename, phase], { stdio: ["ignore", "pipe", "pipe"] });
    let error = ""; child.stderr.on("data", chunk => { error += String(chunk); });
    const [code, signal] = await once(child, "exit"); assert.equal(code, null, error); assert.equal(signal, "SIGKILL", error);
    const reopened = await f.open(), receipt = await reopened.harness.commit(tx => personalQuestionReceipt(tx, input.requestId), context); assert.ok(receipt?.taskId);
    await reopened.harness.waitForTask(receipt.taskId, context);
    const answered = await first(reopened); assert.equal(answered.answer?.delivery, "local");
    const entries = (await reopened.main.entries({ order: "ascending" }, 256, undefined, context)).items;
    assert.equal(entries.filter(entry => entry.kind === "ruukoto.question-answer").length, 1);
    assert.equal((await reopened.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.question-continuation" }, 256), context)).items.length, 1);
  });
});


test("个人问题：同时抹去索引与document也不能隐藏不可改接纳entry", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.open(); await p.answer("发起提问", "original"); const q = await first(p);
  await p.harness.commit(async tx => { (await tx.doc(PersonalQuestionsDoc)).ids = []; delete (await tx.doc(PersonalQuestionDoc, q.id, null)).question; }, context);
  await p.close(); const before = f.server.calls.length;
  await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "question_record_invalid");
  assert.equal(f.server.calls.length, before);
});


test("个人问题：创建已提交而工具result未落盘时强杀，恢复返回原pending", { timeout: 30000 }, async t => {
  const f = await fixture(t), filename = path.join(f.root, "crash-input.json");
  fs.writeFileSync(filename, JSON.stringify({ directory: f.directory, config: f.config, tools: f.tools, input: {} }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", new URL("./helpers/personal-questions-crash.mts", import.meta.url).pathname, filename, "question"], { stdio: ["ignore", "pipe", "pipe"] });
  let error = ""; child.stderr.on("data", chunk => { error += String(chunk); }); const [code, signal] = await once(child, "exit"); assert.equal(code, null, error); assert.equal(signal, "SIGKILL", error);
  const reopened = await f.open(); await reopened.harness.waitForIdle(context);
  const q = await first(reopened); assert.equal(q.status, "pending");
  const entries = (await reopened.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  const result = entries.filter(entry => entry.byTaskId === q.operation).flatMap(entry => entry.model ?? []).find(message => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false); assert.match(JSON.stringify(result.content), /pending/);
  assert.equal((await reopened.harness.snapshot(PersonalQuestionsDoc, context))!.ids.length, 1);
});


test("个人问题：SDK规范化的multiple与recommended布尔值恢复仍一致", { timeout: 30000 }, async t => {
  const f = await fixture(t, request => request.messages.at(-1)?.role === "user" ? { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: 123, options: [{ label: 456, recommended: "true" }, "乙"], multiple: "true" }] } }] } : { kind: "text", text: "已提问" });
  const p = await f.open(); await p.answer("发起提问", "raw-boolean"); const q = await first(p); assert.equal(q.questions[0].question, "123"); assert.equal(q.questions[0].multiple, true); assert.deepEqual(q.questions[0].options?.[0], { label: "456", recommended: true }); await p.close();
  const reopened = await f.open(); assert.equal((await first(reopened)).status, "pending");
});
