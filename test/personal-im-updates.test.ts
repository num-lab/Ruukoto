import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { claimPersonalImPairing, parsePersonalImPairingRequest, PersonalImPairingDoc } from "../apps/ruukoto/src/personal-im-pairing.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import { personalTelegram } from "../apps/ruukoto/src/personal-telegram.ts";

const context = BACKGROUND_CONTEXT;
test("IM 配对证明：只绑定原平台、完整配置和原设置操作，旧证明不能复活旧代次", async () => {
  const session = createSession(new MemoryStorage()), id = randomUUID(), version = randomUUID();
  const config: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: "https://api.telegram.org", tokenEnv: "PAIRING_TOKEN", tokenDigest: "a".repeat(64), botId: "123", ownerId: "456", boundary: 10, pairingId: id };
  try {
    await session.commit(async tx => { (await tx.doc(PersonalImPairingDoc, id, null)).value = { id, request: { platform: "telegram", endpoint: config.apiBase, tokenEnv: config.tokenEnv }, platform: "telegram", phrase: "本轮短语", createdAt: Date.now(), phase: "confirmed", draft: config, candidates: [], facts: [{ phase: "confirmed", at: Date.now() }], config }; }, context);
    await session.commit(tx => claimPersonalImPairing(tx, "telegram", config, version), context);
    await session.commit(tx => claimPersonalImPairing(tx, "telegram", config, version), context);
    for (const [platform, value, operation] of [["qq", config, version], ["telegram", { ...config, ownerId: "789" }, version], ["telegram", config, randomUUID()]] as const) await assert.rejects(session.commit(tx => claimPersonalImPairing(tx, platform, value, operation), context), { code: "im_pairing_required" });
    await assert.rejects(session.commit(tx => claimPersonalImPairing(tx, "telegram", { ...config, pairingId: undefined }, version), context), { code: "im_pairing_required" });
    await session.commit(tx => claimPersonalImPairing(tx, "telegram", { ...config, enabled: false, pairingId: undefined }, randomUUID()), context);
  } finally { await session.close(context); }
});

test("IM 配对请求：固定动作和字段，拒绝任意命令、路径与伪造会话键", () => {
  const id = randomUUID();
  for (const value of [{ v: 1, op: "im.pair-read", id }, { v: 1, op: "im.pair-cancel", id }, { v: 1, op: "im.pair-confirm", id, ownerId: "123" }, { v: 1, op: "im.pair-start", id, platform: "qq", endpoint: "ws://127.0.0.1:1", tokenEnv: "TOKEN" }]) assert.deepEqual(parsePersonalImPairingRequest(value), value);
  for (const value of [{ v: 1, op: "im.pair-read", id: "path" }, { v: 1, op: "im.pair-read", id, command: "anything" }, { v: 1, op: "im.pair-confirm", id, ownerId: 123 }, { v: 2, op: "im.pair-read", id }]) assert.throws(() => parsePersonalImPairingRequest(value), error => error instanceof PersonalError && error.code === "im_pairing_invalid");
});

test("IM 固定发送句柄：不能将已领取的原入口凭据用于另一个拥有者", async () => {
  let sent = 0;
  const config: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: "https://api.telegram.org", tokenEnv: "TOKEN", tokenDigest: "a".repeat(64), botId: "123", ownerId: "456", boundary: 0 };
  const im = personalTelegram(config, { me: async () => ({ id: config.botId, username: "bot" }), updates: async () => [], photo: () => { throw new Error("unused"); }, send: async () => { sent++; return "1"; } });
  const sender = im.sender(config)!;
  await assert.rejects(sender.send("789", 1, "正文", new AbortController().signal), { code: "im_target_changed", effect: "not_sent" });
  assert.equal(sent, 0);
});
