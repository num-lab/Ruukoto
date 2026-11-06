import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, configure, ROOT_CONVERSATION_ID, type Registry, type TaskRuntime } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalImApiError, type PersonalImAccess } from "../apps/ruukoto/src/personal-im-api.ts";
import { personalImDelivery, personalImDeliveryRecord, personalImTextSegments, type PersonalImDeliveryRef } from "../apps/ruukoto/src/personal-im-delivery.ts";
import { PersonalDelegationDoc, listPersonalDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalReports, PersonalReportTask, personalReportResult, personalPublishedOutput, verifyPersonalReports, authorizePersonalReportDelivery } from "../apps/ruukoto/src/personal-report.ts";
import { legacyPlatformText } from "../apps/ruukoto/src/personal-report-legacy.ts";
import { personalQuestions, PersonalQuestionTask, PersonalQuestionDoc, personalQuestionList, personalQuestionDetail, authorizePersonalQuestionDelivery } from "../apps/ruukoto/src/personal-questions.ts";
import { personalScheduler } from "../apps/ruukoto/src/personal-scheduler.ts";
import { personalSchedule, personalScheduleRun, verifySchedules, PersonalScheduleRunDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { personalSource } from "../apps/ruukoto/src/personal-source.ts";
import { personalOutputChunk } from "../apps/ruukoto/src/personal-outputs.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, samePersonalEntry, type PersonalEntryIdentity } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { personalTelegram } from "../apps/ruukoto/src/personal-telegram.ts";
import { personalTelegramApi, type TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalMockModelServer, type RecordedRequest } from "./helpers/mock-provider.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";

const context = BACKGROUND_CONTEXT;
const source: PersonalEntryIdentity = { botId: "123", ownerId: "456", generation: "ea6b1940-c86f-43f5-9553-89a88966f47a" };
const token = "123:consumer-test-only";
const long = (label: string) => ` \n${label} ` + "🦉𠮷e\u0301".repeat(2100) + "\r\nEnd\n ";
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < deadline, "Caller delivery did not reach the expected state"); await delay(5); } }
function update(id: number, text: string, replyTo?: number): TelegramUpdate { return { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }) } }; }
async function fixture(t: TestContext, options: { unknown?: boolean; oldFormatter?: boolean; question?: boolean; holdFirst?: boolean; holdLast?: boolean; amendment?: boolean; parentFault?: "confirmed" | "started"; parentHold?: boolean; output?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-im-consumers-"))), directory = path.join(root, "profile"), sent: string[] = [], text = long(options.question ? "Question continuation" : "Published report");
  const workspace = path.join(root, "workspace"), outputBytes = Buffer.from("Original final bytes 🦉\n");
  if (options.output) { fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "original.bin"), outputBytes); }
  const bot = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { chat_id: string; message_id?: number };
    if (request.url?.endsWith("/sendChatAction") || request.url?.endsWith("/answerCallbackQuery")) { response.end(JSON.stringify({ ok: true, result: true })); return; }
    if (request.url?.endsWith("/editMessageText")) { response.end(JSON.stringify({ ok: true, result: { message_id: body.message_id, chat: { id: Number(body.chat_id), type: "private" } } })); return; }
    response.end(JSON.stringify({ ok: true, result: { message_id: 10000 + ++count, chat: { id: Number(body.chat_id), type: "private" } } }));
  }); let count = 0, ownerId = 100;
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const telegram = { version: 1 as const, enabled: true, ...source, apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "IM_CONSUMER_BOT_KEY", tokenDigest: createHash("sha256").update(token).digest("hex"), boundary: 0 };
  let amendedWork: number | undefined, childRequests = 0, releaseChild!: () => void;
  const childHeld = new Promise<void>(resolve => { releaseChild = resolve; }); t.after(() => releaseChild());
  const model = new PersonalMockModelServer(async request => {
    const user = String(request.messages.findLast(message => message.role === "user")?.content);
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (options.output) {
        if (request.messages.at(-1)?.role === "user") return { kind: "tool_calls", calls: [{ id: "read-original-output", name: "read_file", arguments: { path: path.join(workspace, "original.bin") } }] };
        const latest = JSON.parse(String(request.messages.at(-1)?.content)) as { artifact?: string; output?: number };
        if (latest.artifact) return { kind: "tool_calls", calls: [{ id: "publish-original-output", name: "publish_output", arguments: { artifact: latest.artifact, name: "original.bin" } }] };
      }
      if (options.amendment && ++childRequests > 1) await childHeld;
      return { kind: "text", text: "Child work finished." };
    }
    if (user.startsWith("宿主委托汇总参考") || user.includes("拥有者对原问题的回答")) return { kind: "text", text };
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: "Question registered." };
    if (user.includes("Amend the original work") && amendedWork !== undefined) return { kind: "tool_calls", calls: [{ id: "valid-amendment", name: "background_work", arguments: { action: "append", work: amendedWork, content: "Add the newly requested conclusion." } }] };
    if (options.question) return { kind: "tool_calls", calls: [{ id: "original-question", name: "ask_user", arguments: { questions: [{ question: "Choose one", options: ["First", "Second"] }] } }] };
    return { kind: "tool_calls", calls: [{ id: "original-work", name: "background_work", arguments: { action: "delegate", content: "Complete the original analysis." } }] };
  });
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "IM_CONSUMER_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 }, prior = [process.env[config.apiKeyEnv], process.env[telegram.tokenEnv]];
  process.env[config.apiKeyEnv] = "test-only"; process.env[telegram.tokenEnv] = token;
  isolateSkillHome(t);
  let personal: PersonalHarness | undefined, harness!: Harness, oldConverted = false, ledger: ReturnType<typeof personalImDelivery>, release!: () => void, first = false, last = false, injected = false, parentHeld = false, outputLoading = false;
  const documents: Uint8Array[] = [];
  const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const parts = personalImTextSegments(text); let otherSends = 0;
  const open = Harness.open;
  t.mock.method(Harness, "open", async (...args: Parameters<typeof Harness.open>) => {
    const im: PersonalImAccess = { async withEntry(_source, action) {
      if (options.oldFormatter && harness && !oldConverted) await harness.commit(async tx => {
        for (const item of (await listPersonalDelegations(tx)).items) { const report = (await tx.doc(PersonalDelegationDoc, String(item.ref.entryId), null)).delegation?.report; if (report?.delivery === "pending" && !report.multipart) { delete report.replyFormat; report.reply = legacyPlatformText(text); oldConverted = true; } }
      }, context);
      return action();
    }, isActive: value => samePersonalEntry(value, source), configurationVersion: () => "consumer-configuration", sender: () => ({ async send(owner, _message, part) { assert.equal(owner, source.ownerId); if (!parts.includes(part)) return String(100000 + ++otherSends); assert.equal(part, parts[sent.length]); sent.push(part); if (sent.length === 1) { first = true; if (options.holdFirst) await held; } if (sent.length === parts.length) { last = true; if (options.holdLast) await held; } if (options.unknown && sent.length === 2) throw new PersonalImApiError("telegram_unverified", "Lost middle response", "effect_unknown"); return String(200000 + sent.length); }, async document(_owner, _message, document) { documents.push(document.bytes); throw new PersonalImApiError("telegram_refused", "Original document refused", "not_sent"); } }), get delivery() { return ledger; } };
    ledger = personalImDelivery(() => harness, im, options.output ? async (ref, entry) => {
      assert.ok("publication" in ref);
      assert.ok(samePersonalEntry(entry, source)); outputLoading = true; await held;
      const intent = await harness.commit(tx => personalPublishedOutput(tx, ref.publication, ref.output), context), chunk = personalOutputChunk(directory, ref.publication, intent, 0);
      assert.equal(chunk.nextOffset, undefined);
      return { bytes: Buffer.from(chunk.base64, "base64"), name: chunk.name, mime: chunk.mime, sha256: chunk.sha256, partial: chunk.partial };
    } : undefined, async (tx, input, parent) => {
      const task = parent && await tx.task(parent);
      if (task?.kind === "ruukoto.delegation-report") return authorizePersonalReportDelivery(tx, input, parent!);
      if (task?.kind === "ruukoto.question-continuation") return authorizePersonalQuestionDelivery(tx, input, parent!);
      return true;
    });
    const reports = personalReports(im, undefined, () => harness), questions = personalQuestions(() => harness, im);
    const interruptParent = async (ref: PersonalImDeliveryRef | undefined, runtime: Pick<TaskRuntime<object, { phase: "deliver" }, object, object>, "signal" | "waitForTask">) => {
      assert.ok(ref);
      if (options.parentFault === "started") await until(() => last);
      else await runtime.waitForTask(ref.taskId, context);
      if (options.parentFault) throw new Error("Injected caller failure before delivery reconciliation");
      parentHeld = true;
      await new Promise<void>((_resolve, reject) => { const abort = () => reject(runtime.signal.reason); runtime.signal.addEventListener("abort", abort, { once: true }); if (runtime.signal.aborted) abort(); });
    };
    if (options.parentFault || options.parentHold) {
      if (options.question) {
        const definition = (questions.tasks![0] as typeof PersonalQuestionTask).definition, original = definition.phases.deliver;
        t.mock.method(definition.phases, "deliver", async (...[current, runtime, callContext]: Parameters<typeof original>) => { if (injected) return original(current, runtime, callContext); injected = true; const ref = (await runtime.snapshot(PersonalQuestionDoc, current.input.question, callContext))?.question?.answer?.multipart; await interruptParent(ref, runtime); });
      } else {
        const definition = (reports.tasks![0] as typeof PersonalReportTask).definition, original = definition.phases.deliver;
        t.mock.method(definition.phases, "deliver", async (...[current, runtime, callContext]: Parameters<typeof original>) => { if (injected) return original(current, runtime, callContext); injected = true; const ref = (await runtime.snapshot(PersonalDelegationDoc, String(current.input.delegation.entryId), callContext))?.delegation?.report?.multipart; await interruptParent(ref, runtime); });
      }
    }
    const registry = args[1].registry as Registry;
    registry.install(ledger.extension); registry.install(reports); registry.install(questions);
    harness = await open(...args); return harness;
  });
  const tools = options.output ? (() => { const identity = fs.statSync(workspace); return parsePersonalTools({ version: 1, generation: "consumer-output-tools", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] }); })() : undefined;
  const start = async () => personal = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, telegram, tools });
  const receive = async (text: string, replyTo?: number) => { assert.ok(personal); const id = ++ownerId; await personal.telegram.receive(update(id, text, replyTo)); const record = (await personal.harness.snapshot(PersonalTelegramReceiptDoc, `telegram:123:456:${id}`, context))!.receipt!; await personal.harness.waitForTask(record.taskId, context); return (await personal.harness.snapshot(PersonalTelegramReceiptDoc, record.requestId, context))!.receipt!; };
  t.after(async () => { await personal?.close(); bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); await model.close(); fs.rmSync(root, { recursive: true, force: true }); for (const [index, key] of [config.apiKeyEnv, telegram.tokenEnv].entries()) { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; } });
  await start();
  return { get personal() { return personal!; }, get ledger() { return ledger; }, text, sent, documents, outputBytes, model, receive, start, release, amend: (work: number) => { amendedWork = work; return receive("Amend the original work."); }, get first() { return first; }, get last() { return last; }, get parentHeld() { return parentHeld; }, get outputLoading() { return outputLoading; }, get oldConverted() { return oldConverted; } };
}

test("Published report sends every exact Unicode segment and reopens the same send identity", async t => {
  const f = await fixture(t); await f.receive("Complete the original analysis.");
  const ref = (await f.personal.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const report = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
  await f.personal.harness.waitForTask(report.taskId, context);
  const saved = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
  assert.equal(saved.replyFormat, "complete"); assert.equal(saved.reply, f.text); assert.equal(saved.delivery, "sent"); assert.ok(saved.multipart); assert.equal(f.sent.join(""), f.text);
  const delivery = await f.ledger.get(saved.multipart); assert.ok(delivery.parts.length > 2); assert.ok(delivery.parts.every(part => part.state === "sent")); assert.equal(delivery.parent, saved.taskId);
  const calls = f.model.calls.length, sends = f.sent.length; await f.personal.close(); await f.start();
  const reopened = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
  assert.deepEqual(reopened.multipart, saved.multipart); assert.equal(reopened.delivery, "sent"); assert.equal(f.model.calls.length, calls); assert.equal(f.sent.length, sends);
  await f.personal.harness.commit(tx => f.ledger.verify(tx), context);
});

test("A report with a historical pending formatter sends stored complete text while retaining its old reply", async t => {
  const f = await fixture(t, { oldFormatter: true }); await f.receive("Complete the original analysis.");
  const ref = (await f.personal.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const task = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!.taskId; await f.personal.harness.waitForTask(task, context);
  const report = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
  assert.equal(f.oldConverted, true); assert.equal(report.replyFormat, undefined); assert.equal(report.reply, legacyPlatformText(f.text)); assert.equal(report.delivery, "sent"); assert.equal(f.sent.join(""), f.text);
  await f.personal.close(); await f.start(); assert.equal(f.sent.join(""), f.text);
});

test("An unknown report segment stops later parts and parent recovery retains the canonical unknown delivery", async t => {
  const f = await fixture(t, { unknown: true }); await f.receive("Complete the original analysis.");
  const ref = (await f.personal.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const task = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!.taskId; await f.personal.harness.waitForTask(task, context);
  const report = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!; assert.equal(report.delivery, "effect_unknown"); assert.ok(report.multipart);
  const original = await f.ledger.get(report.multipart), calls = f.model.calls.length; assert.deepEqual(original.parts.map(part => part.state), ["sent", "effect_unknown", "canceled", "canceled"]); assert.equal(f.sent.length, 2);
  await f.personal.close(); await f.start();
  assert.deepEqual(await f.ledger.get(report.multipart), original); assert.equal(f.sent.length, 2); assert.equal(f.model.calls.length, calls);
});

test("Report parent fault or abort preserves a confirmed multipart receipt and final platform message identity", async t => {
  for (const fault of [true, false]) await t.test(fault ? "fault" : "abort", async t => {
    const f = await fixture(t, fault ? { parentFault: "confirmed" } : { parentHold: true }); await f.receive("Complete the original analysis.");
    const ref = (await f.personal.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
    const report = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
    if (!fault) { await until(() => f.parentHeld); await f.personal.harness.abortTask(report.taskId, context); }
    assert.equal((await f.personal.harness.waitForTask(report.taskId, context)).state.outcome.status, fault ? "faulted" : "aborted");
    await f.personal.harness.commit(tx => verifyPersonalReports(tx, [String(ref.entryId)], true), context);
    const saved = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
    assert.equal(saved.delivery, "sent"); assert.equal(saved.platformMessageId, String(200000 + f.sent.length)); assert.equal(f.sent.join(""), f.text);
    const calls = f.model.calls.length, sends = f.sent.length; await f.personal.close(); await f.start();
    const reopened = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
    assert.equal(reopened.delivery, "sent"); assert.equal(reopened.platformMessageId, saved.platformMessageId); assert.deepEqual(reopened.multipart, saved.multipart); assert.equal(f.model.calls.length, calls); assert.equal(f.sent.length, sends);
  });
});

test("Report queries show confirmed complete text independently while its original output is pending or fails", async t => {
  const f = await fixture(t, { output: true }); await f.receive("Complete the original analysis and publish its output.");
  await until(() => f.outputLoading);
  const ref = (await f.personal.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const report = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!; assert.ok(report.multipart);
  const pending = await f.personal.harness.commit(tx => personalReportResult(tx, ref), context);
  assert.equal(pending.delivery, "sent"); assert.equal(pending.outputDelivery, "pending"); assert.deepEqual(pending.multipart, report.multipart); assert.equal(f.sent.join(""), f.text); assert.equal(f.documents.length, 0);
  f.release(); await f.personal.harness.waitForTask(report.taskId, context);
  const complete = await f.personal.harness.commit(tx => personalReportResult(tx, ref), context);
  assert.equal(complete.delivery, "sent"); assert.equal(complete.outputDelivery, "failed"); assert.deepEqual(f.documents, [f.outputBytes]);
  const calls = f.model.calls.length; await f.personal.close(); await f.start();
  const reopened = await f.personal.harness.commit(tx => personalReportResult(tx, ref), context); assert.equal(reopened.delivery, "sent"); assert.equal(reopened.outputDelivery, "failed"); assert.equal(f.documents.length, 1); assert.equal(f.model.calls.length, calls);
});

test("A sealed report failure retains its historical sending snapshot when the original last part later confirms", async t => {
  const f = await fixture(t, { parentFault: "started", holdLast: true, amendment: true }); await f.receive("Complete the original analysis.");
  const ref = (await f.personal.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const initial = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.report!;
  assert.equal((await f.personal.harness.waitForTask(initial.taskId, context)).state.outcome.status, "faulted");
  const group = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!, report = group.report!; assert.ok(report.multipart);
  await f.amend(group.members[0].taskId);
  const archived = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.reports!.find(value => value.taskId === report.taskId)!;
  assert.equal(archived.version, 2); assert.ok(archived.version === 2 && archived.failure);
  const failure = await f.personal.harness.commit(tx => tx.entry(archived.version === 2 ? archived.failure! : report.admission), context);
  assert.ok(failure?.data && typeof failure.data === "object" && !Array.isArray(failure.data)); assert.equal(failure.data.delivery, "sending");
  f.release(); await f.ledger.wait(report.multipart);
  await f.personal.harness.commit(tx => verifyPersonalReports(tx, [String(ref.entryId)], true), context);
  await f.personal.harness.commit(tx => verifyPersonalReports(tx, [String(ref.entryId)], true), context);
  const reconciled = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.reports!.find(value => value.taskId === report.taskId)!;
  assert.equal(reconciled.delivery, "sent"); assert.equal(reconciled.platformMessageId, String(200000 + f.sent.length)); assert.deepEqual(await f.personal.harness.commit(tx => tx.entry(failure.id), context), failure);
});

test("A contributing-work amendment between report parts stops the rest and keeps the old publication", async t => {
  const f = await fixture(t, { holdFirst: true, amendment: true }); await f.receive("Complete the original analysis.");
  const ref = (await f.personal.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  const deadline = Date.now() + 10000;
  while (!f.first) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  const group = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!, original = group.report!;
  assert.ok(original.multipart); assert.equal(original.version, 2); assert.ok(original.version === 2 && original.publication);
  await f.amend(group.members[0].taskId);
  f.release(); await f.personal.harness.waitForTask(original.taskId, context);
  const saved = (await f.personal.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!.reports!.find(report => report.taskId === original.taskId)!;
  assert.equal(saved.delivery, "canceled"); assert.equal(saved.version === 2 && saved.publication, original.version === 2 && original.publication);
  const record = await f.ledger.get(original.multipart); assert.deepEqual(record.parts.map(part => part.state), ["sent", "canceled", "canceled", "canceled"]); assert.equal(f.sent.length, 1);
});

test("A Telegram question continuation sends its full answer once under the original answer receipt", async t => {
  const f = await fixture(t, { question: true }); await f.receive("Ask me one question.");
  let menu = await f.receive("/问题"); menu = await f.receive("问题1", Number(menu.platformMessageId)); await f.receive("1", Number(menu.platformMessageId));
  const id = (await f.personal.harness.commit(tx => personalQuestionList(tx), context)).items[0].id;
  const question = await f.personal.harness.commit(tx => personalQuestionDetail(tx, id), context); assert.ok(question.answer);
  await f.personal.harness.waitForTask(question.answer.taskId, context);
  const saved = await f.personal.harness.commit(tx => personalQuestionDetail(tx, id), context); assert.equal(saved.answer?.replyFormat, "complete"); assert.equal(saved.answer?.reply, f.text); assert.equal(saved.answer?.delivery, "sent"); assert.ok(saved.answer?.multipart); assert.equal(f.sent.join(""), f.text);
  const calls = f.model.calls.length; await f.personal.close(); await f.start(); const reopened = await f.personal.harness.commit(tx => personalQuestionDetail(tx, id), context);
  assert.deepEqual(reopened.answer?.multipart, saved.answer.multipart); assert.equal(f.model.calls.length, calls); assert.equal(f.sent.join(""), f.text);
});

test("Question parent fault or abort preserves the confirmed multipart receipt and final message identity", async t => {
  for (const fault of [true, false]) await t.test(fault ? "fault" : "abort", async t => {
    const f = await fixture(t, fault ? { question: true, parentFault: "confirmed" } : { question: true, parentHold: true }); await f.receive("Ask me one question.");
    let menu = await f.receive("/问题"); menu = await f.receive("问题1", Number(menu.platformMessageId)); await f.receive("1", Number(menu.platformMessageId));
    const id = (await f.personal.harness.commit(tx => personalQuestionList(tx), context)).items[0].id, answer = (await f.personal.harness.snapshot(PersonalQuestionDoc, id, context))!.question!.answer!;
    if (!fault) { await until(() => f.parentHeld); await f.personal.harness.abortTask(answer.taskId, context); }
    assert.equal((await f.personal.harness.waitForTask(answer.taskId, context)).state.outcome.status, fault ? "faulted" : "aborted");
    const saved = await f.personal.harness.commit(tx => personalQuestionDetail(tx, id), context); assert.equal(saved.answer?.delivery, "sent"); assert.equal(saved.answer?.platformMessageId, String(200000 + f.sent.length));
    const calls = f.model.calls.length, sends = f.sent.length; await f.personal.close(); await f.start();
    const reopened = await f.personal.harness.commit(tx => personalQuestionDetail(tx, id), context); assert.equal(reopened.answer?.delivery, "sent"); assert.deepEqual(reopened.answer?.multipart, saved.answer!.multipart); assert.equal(reopened.answer?.platformMessageId, saved.answer!.platformMessageId); assert.equal(f.model.calls.length, calls); assert.equal(f.sent.length, sends);
  });
});

async function scheduleDeliveryCase(t: TestContext, parentFault = false) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "rk-schedule-parts-")), text = long("Schedule result"), sends: string[] = [];
  const model = new PersonalMockModelServer(() => ({ kind: "text", text })), config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "IM_SCHEDULE_CONSUMER_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 }, prior = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const telegramConfig = { version: 1 as const, enabled: true, ...source, apiBase: "http://127.0.0.1:1", tokenEnv: "IM_UNUSED_BOT", tokenDigest: "0".repeat(64), boundary: 0 };
  const api = { ...personalTelegramApi(telegramConfig.apiBase, token), async send() { return "owner-response"; } };
  let harness!: Harness, ledger!: ReturnType<typeof personalImDelivery>, clock = Date.parse("2026-11-06T00:00:00Z");
  const tg = personalTelegram(telegramConfig, api), im: PersonalImAccess = { withEntry: tg.withEntry, sender: () => ({ async send(_owner, _message, part) { sends.push(part); return `schedule-${sends.length}`; } }), isActive: tg.isActive, configurationVersion: () => "schedule-original", get delivery() { return ledger; } };
  const provider = personalProvider(config), scope = { tools: [], extensions: [], snapshot: {} };
  const scheduler = personalScheduler(() => harness, { im, now: () => clock, validateActor: async tx => { const original = await personalSource(tx, "telegram:123:456:1"); return { permission: original.permission, telegram: original.telegram, source: original.source }; }, authorize: async tx => { const original = await personalSource(tx, "telegram:123:456:1"); return { permission: original.permission, telegram: original.telegram, source: original.source, proof: {} }; }, verifyCreator: async () => undefined, captureScope: async () => scope, verifyScope: async (_tx, saved) => assert.deepEqual(saved, scope), configure: async (tx, conversationId) => configure(tx, conversationId, { model: { provider: provider.id, modelId: config.modelId }, thinkingLevel: "off", extensions: [], tools: [] }), settle: async () => ({ failed: false, facts: "Original work returned" }), send: async () => assert.fail("The multipart path must own every schedule send") });
  if (parentFault) { const deliver = scheduler.sendTask.definition.phases.deliver; t.mock.method(scheduler.sendTask.definition.phases, "deliver", async (...[current, runtime, callContext]: Parameters<typeof deliver>) => { const ref = (await runtime.snapshot(PersonalScheduleRunDoc, current.input.runId, callContext))?.run?.delivery?.multipart; assert.ok(ref); await runtime.waitForTask(ref.taskId, callContext); throw new Error("Injected schedule send parent fault before reconciliation"); }); }
  ledger = personalImDelivery(() => harness, im, undefined, (tx, input, parent) => scheduler.authorizeDelivery(tx, input, parent!));
  const registry = createRegistry(); registry.install(tg.extension); registry.install(scheduler.extension); registry.install(ledger.extension);
  const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(path.join(root, "personal.sqlite")), { registry, models: recordedModels(provider, async () => undefined), now: () => clock }, context); await harness.root(context, { agent: { model: { provider: provider.id, modelId: config.modelId }, thinkingLevel: "off", extensions: [tg.extension, scheduler.extension, ledger.extension], tools: [] } }); return harness; };
  await open(); await harness.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = telegramConfig; }, context);
  t.after(async () => { await harness.close(context); await model.close(); fs.rmSync(root, { recursive: true, force: true }); if (prior === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = prior; });
  await tg.api(harness).receive(update(1, "Create the original report source")); const receipt = (await harness.snapshot(PersonalTelegramReceiptDoc, "telegram:123:456:1", context))!.receipt!; await harness.waitForTask(receipt.taskId, context);
  const plan = await harness.commit(tx => scheduler.create(tx, { requestId: "schedule-original", label: "Original plan", instruction: "Return the exact complete original text", rule: { kind: "once", at: "2026-11-06T00:00:01Z", time_zone: "UTC" } }, { kind: "local", requestId: "schedule-original" }), context);
  clock += 2000; await harness.commit(tx => scheduler.scan(tx, clock), context); const runId = await harness.commit(async tx => (await personalSchedule(tx, plan.id)).activeRun!, context);
  const run = await harness.commit(async tx => JSON.parse(JSON.stringify(await personalScheduleRun(tx, runId))) as ReturnType<typeof personalScheduleRun> extends Promise<infer T> ? T : never, context); await harness.waitForTask(run.taskId, context);
  const delivery = (await harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!.delivery!; await harness.waitForTask(delivery.taskId, context);
  if (parentFault) { assert.equal((await harness.getTask(delivery.taskId, context))!.state.outcome?.status, "faulted"); assert.equal((await harness.commit(tx => scheduler.result(tx, runId), context)).delivery, "sent"); }
  const complete = (await harness.snapshot(PersonalScheduleRunDoc, runId, context))!.run!; assert.equal(complete.delivery?.replyFormat, "complete"); assert.equal(complete.delivery?.text, text); assert.equal(complete.delivery?.state, "sent"); assert.ok(complete.delivery?.multipart); assert.equal(sends.join(""), text);
  const original = await ledger.get(complete.delivery.multipart), calls = model.calls.length;
  await harness.commit(tx => verifySchedules(tx, [plan.id], [runId], true, scheduler.verifyCreator), context); await harness.close(context); await open();
  assert.deepEqual(await ledger.get(complete.delivery.multipart), original); assert.equal(sends.join(""), text); assert.equal(model.calls.length, calls); assert.equal((await harness.commit(tx => scheduler.result(tx, runId), context)).delivery, "sent");
  await harness.commit(tx => ledger.verify(tx), context);
}
test("Schedule result delivery splits exact stored text and validates the original plan/result after reopen", async t => scheduleDeliveryCase(t));
test("Schedule parent fault reconciles its confirmed child text receipt without replay", async t => scheduleDeliveryCase(t, true));
