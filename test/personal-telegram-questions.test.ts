import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import { PersonalTelegramReceiptDoc, type TelegramReceipt } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { personalQuestionDetail, personalQuestionList, type PersonalQuestionItem } from "../apps/ruukoto/src/personal-questions.ts";
import { personalQuestionSubmittedDraft } from "../apps/ruukoto/src/personal-question-controls.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, "Question did not settle"); await delay(5); } }
async function fixture(t: TestContext, questions: PersonalQuestionItem[]) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-telegram-question-")), directory = path.join(root, "profile"), token = "123:telegram-question-test", tokenEnv = "RUUKOTO_TELEGRAM_QUESTION_KEY", modelEnv = "RUUKOTO_TELEGRAM_QUESTION_MODEL_KEY";
  const previousToken = process.env[tokenEnv], previousModel = process.env[modelEnv]; process.env[tokenEnv] = token; process.env[modelEnv] = "test-only";
  let sent = 1000;
  const bot = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { chat_id: string };
    const result = req.url?.endsWith("/sendMessage") ? { message_id: ++sent, chat: { id: Number(body.chat_id), type: "private" } } : true;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const model = new PersonalMockModelServer(request => {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "ask") return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions } }] };
    return { kind: "text", text: last?.role === "tool" ? "问题已登记" : "按答案完成" };
  });
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: modelEnv, contextWindow: 128000, maxTokens: 8192 };
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: createHash("sha256").update(token).digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  let p: PersonalHarness | undefined, nextMessage = 10;
  const open = async () => p = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, telegram });
  const receive = async (text: string, replyTo?: number, extra: Record<string, unknown> = {}): Promise<TelegramReceipt> => {
    const messageId = ++nextMessage;
    await p!.telegram.receive({ update_id: messageId, message: { message_id: messageId, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }), ...extra } });
    const key = `telegram:123:456:${messageId}`, value = (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    await p!.harness.waitForTask(value.taskId, context); return (await p!.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
  };
  const question = async () => { const first = (await p!.harness.commit(tx => personalQuestionList(tx), context)).items[0]; return p!.harness.commit(tx => personalQuestionDetail(tx, first.id), context); };
  t.after(async () => { await p?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); for (const [key, prior] of [[tokenEnv, previousToken], [modelEnv, previousModel]]) if (prior === undefined) delete process.env[key!]; else process.env[key!] = prior; fs.rmSync(root, { recursive: true, force: true }); });
  return { open, receive, question, model };
}

test("Telegram single-choice answers submit once from the original question card", { timeout: 30000 }, async t => {
  const f = await fixture(t, [{ question: "Choose", options: ["A", "B"] }]), p = await f.open(); await f.receive("ask");
  let menu = await f.receive("/问题"); menu = await f.receive("问题1", Number(menu.platformMessageId));
  const answered = await f.receive("2", Number(menu.platformMessageId)); assert.ok(answered.questionAnswer);
  await until(async () => (await f.question()).answer?.delivery === "sent");
  const q = await f.question(); assert.deepEqual(q.answer!.answers, [{ option: 1, text: "B" }]);
  const stale = await f.receive("1", Number(menu.platformMessageId)); assert.equal(stale.questionAnswer, undefined);
  assert.equal((await p.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.question-continuation" }, 256), context)).items.length, 1);
  await p.close(); const reopened = await f.open(); assert.equal((await f.question()).answer!.requestId, answered.requestId);
  assert.equal((await reopened.harness.commit(tx => tx.scanTasks({ kind: "ruukoto.question-continuation" }, 256), context)).items.length, 1);
});

test("Typed question answers reject a deleted or foreign accepted origin on reopen", { timeout: 30000 }, async t => {
  for (const change of ["delete", "foreign"] as const) await t.test(change, async t => {
    const f = await fixture(t, [{ question: "Choose", options: ["A", "B"] }]), p = await f.open(), original = await f.receive("ask");
    let menu = await f.receive("/问题"); menu = await f.receive("问题1", Number(menu.platformMessageId));
    const answered = await f.receive("2", Number(menu.platformMessageId)); assert.ok(answered.questionAnswer); assert.ok(answered.accepted); assert.equal(answered.display, undefined);
    await until(async () => (await f.question()).answer?.delivery === "sent");
    const calls = f.model.calls.length;
    await p.harness.commit(async tx => {
      const value = (await tx.doc(PersonalTelegramReceiptDoc, answered.requestId, null)).receipt!;
      if (change === "delete") delete value.accepted; else value.accepted = original.accepted;
    }, context);
    await p.close(); await assert.rejects(f.open(), error => error instanceof PersonalError && error.code === "telegram_receipt_invalid");
    assert.equal(f.model.calls.length, calls);
  });
});

test("Telegram multi-select requires Done and rejects forwarded answers", { timeout: 30000 }, async t => {
  const f = await fixture(t, [{ question: "Choose several", options: ["A", "B", "C"], multiple: true }]); await f.open(); await f.receive("ask");
  let menu = await f.receive("/问题"); menu = await f.receive("问题1", Number(menu.platformMessageId));
  const forwarded = await f.receive("1", Number(menu.platformMessageId), { forward_origin: { type: "user" } }); assert.equal(forwarded.questionAnswer, undefined);
  menu = await f.receive("1", Number(menu.platformMessageId)); assert.equal(menu.questionAnswer, undefined);
  menu = await f.receive("3", Number(menu.platformMessageId)); assert.equal(menu.questionAnswer, undefined);
  assert.equal((await f.question()).status, "pending");
  const answered = await f.receive("完成选择", Number(menu.platformMessageId)); assert.ok(answered.questionAnswer);
  assert.deepEqual((await f.question()).answer!.answers, [{ options: [0, 2], text: "A\nC" }]);
});

test("Telegram multiple questions retain review and QQ retains its existing confirmation step", { timeout: 30000 }, async t => {
  const f = await fixture(t, [{ question: "Choose", options: ["A", "B"] }, { question: "Explain" }]); await f.open(); await f.receive("ask");
  let menu = await f.receive("/问题"); menu = await f.receive("问题1", Number(menu.platformMessageId));
  menu = await f.receive("1", Number(menu.platformMessageId)); assert.equal(menu.questionAnswer, undefined);
  menu = await f.receive("details", Number(menu.platformMessageId)); assert.equal(menu.questionAnswer, undefined); assert.match(menu.reply!, /核对/);
  const q = await f.question(); assert.equal(q.status, "pending");
  const answered = await f.receive("确认回答", Number(menu.platformMessageId)); assert.ok(answered.questionAnswer);
  assert.deepEqual((await f.question()).answer!.answers, [{ option: 0, text: "A" }, { text: "details" }]);
  const one = { ...q, questions: [q.questions[0]] }, draft = { kind: "question-draft" as const, id: q.id, version: 1, step: 0, answers: [] };
  assert.equal(personalQuestionSubmittedDraft(one, draft, "1", "qq"), undefined);
  assert.deepEqual(personalQuestionSubmittedDraft(one, draft, "1")?.answers, [{ option: 0, text: "A" }]);
});
