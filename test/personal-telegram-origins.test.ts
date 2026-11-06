import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, ROOT_CONVERSATION_ID, type Task } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { personalTelegram, verifyPersonalTelegram } from "../apps/ruukoto/src/personal-telegram.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramReceipt, type TelegramResult } from "../apps/ruukoto/src/personal-telegram-records.ts";

const context = BACKGROUND_CONTEXT;
async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync("/tmp/rk-im-origins-"), registry = createRegistry(), keys: string[] = [], generation = randomUUID();
  const telegram = { version: 1 as const, enabled: true, generation, apiBase: "http://127.0.0.1:1", tokenEnv: "ORIGIN_UNUSED_TOKEN", tokenDigest: "0".repeat(64), botId: "123", ownerId: "456", boundary: 0 };
  const qq = { version: 1 as const, enabled: true, generation, endpoint: "ws://127.0.0.1:1", tokenEnv: "ORIGIN_UNUSED_TOKEN", tokenDigest: "0".repeat(64), botId: "123", ownerId: "456", boundary: 0, boundaryMessageId: "0" };
  const transport = personalTelegram(telegram); registry.install(transport.extension);
  const input = transport.extension.tasks![0] as Task<{ requestId: string }, { phase: string }, TelegramResult, object>;
  const provider = personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "ORIGIN_UNUSED_MODEL", contextWindow: 4096, maxTokens: 1024 });
  let harness!: Harness;
  const open = async () => { harness = await Harness.open(await openNodeSqliteStorage(path.join(directory, "personal.sqlite")), { registry, models: recordedModels(provider, async () => assert.fail("Origin verification must not call a model")) }, context); await harness.root(context); return harness; };
  await open(); await harness.commit(async tx => { const state = await tx.doc(PersonalTelegramDoc); state.config = telegram; state.qqConfig = qq; }, context);
  t.after(async () => { await harness.close(context); fs.rmSync(directory, { recursive: true, force: true }); });
  const receive = async (platform: "telegram" | "qq", messageId: number, historic = false) => {
    const key = `${platform}:123:456:${messageId}`; keys.push(key);
    return harness.commit(async tx => {
      const accepted = historic ? undefined : (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: `ruukoto.${platform}-received`, data: { requestId: key, generation } })).id;
      const taskId = await tx.createTask(input, { requestId: key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
      const value: TelegramReceipt = { ...(platform === "qq" ? { platform } : {}), requestId: key, botId: "123", ownerId: "456", generation, messageId, updateId: 1, content: "Original receipt", delivery: "waiting", taskId, ...(accepted === undefined ? {} : { accepted }) };
      (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt = value; return value;
    }, context);
  };
  return { get harness() { return harness; }, keys, generation, open, receive, verify: () => harness.commit(tx => verifyPersonalTelegram(tx, keys, telegram, qq), context) };
}

test("Ordinary Telegram and signed QQ receipts retain exact accepted origins", async t => {
  const f = await fixture(t); await f.receive("telegram", 1); await f.receive("qq", -7); await f.verify();
  await f.harness.close(context); await f.open(); await f.verify();
});

test("Historical receipts without accepted fields or immutable received origins remain readable", async t => {
  const f = await fixture(t); await f.receive("telegram", 1, true); await f.receive("qq", -7, true); await f.verify();
  await f.harness.close(context); await f.open(); await f.verify();
});

test("Accepted received origins reject missing backlinks, mismatched generation and foreign keys", async t => {
  for (const platform of ["telegram", "qq"] as const) for (const change of ["delete", "generation", "foreign"] as const) await t.test(`${platform} ${change}`, async t => {
    const f = await fixture(t), original = await f.receive(platform, 1), other = await f.receive(platform, 2);
    await f.harness.commit(async tx => { const value = (await tx.doc(PersonalTelegramReceiptDoc, original.requestId, null)).receipt!; if (change === "delete") delete value.accepted; else if (change === "generation") value.generation = randomUUID(); else value.accepted = other.accepted; }, context);
    await assert.rejects(f.verify(), { code: "telegram_receipt_invalid" });
  });
});

test("Immutable received and accepted callback entries cannot outlive their indexed receipts", async t => {
  for (const kind of ["ruukoto.telegram-received", "ruukoto.qq-received", "ruukoto.telegram-callback"]) await t.test(kind, async t => {
    const f = await fixture(t); await f.receive("telegram", 1);
    await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data: kind === "ruukoto.telegram-callback" ? { requestId: "telegram-callback:123:orphan-query", generation: f.generation, queryId: "orphan-query", token: "orphan-token", display: "orphan-display" } : { requestId: `${kind === "ruukoto.qq-received" ? "qq" : "telegram"}:123:456:99`, generation: f.generation } }), context);
    await assert.rejects(f.verify(), { code: "telegram_receipt_invalid" });
  });
});

test("An accepted field cannot cite a non-received entry", async t => {
  const f = await fixture(t), original = await f.receive("telegram", 1, true);
  await f.harness.commit(async tx => { const accepted = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.unrelated", data: { requestId: original.requestId, generation: f.generation } })).id; (await tx.doc(PersonalTelegramReceiptDoc, original.requestId, null)).receipt!.accepted = accepted; }, context);
  await assert.rejects(f.verify(), { code: "telegram_receipt_invalid" });
});
