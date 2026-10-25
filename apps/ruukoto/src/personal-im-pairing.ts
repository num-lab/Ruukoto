import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type Harness, type Tx } from "@earendil-works/pi-durable";
import { OneBotClient } from "@ruukoto/channels/qq/onebot.ts";
import { PersonalError } from "./personal-error.ts";
import { parsePersonalTelegram, type PersonalTelegramConfig } from "./personal-telegram-config.ts";
import { parsePersonalQq, type PersonalQqConfig } from "./personal-qq-config.ts";
import { personalTelegramApi, telegramOffset, telegramText, type PersonalTelegramApi, type TelegramAck } from "./personal-telegram-api.ts";
import { qqMessage } from "./personal-qq-api.ts";
import { personalSettingsIdentity } from "./personal-settings.ts";
import type { PersonalProfileLock } from "./personal-profile.ts";
import type { PersonalHarness } from "./personal-harness.ts";
import type { PersonalImRuntime } from "./personal-telegram.ts";

type Platform = "telegram" | "qq";
type Candidate = { ownerId: string; messageId: number; name: string; time: number };
type Pairing = { id: string; request: { platform: Platform; endpoint: string; tokenEnv: string }; platform: Platform; phrase: string; createdAt: number; phase: "starting" | "waiting" | "confirming" | "confirmed" | "failed"; draft: PersonalTelegramConfig | PersonalQqConfig; candidates: Candidate[]; facts: { phase: string; at: number; offset?: number; code?: string }[]; config?: PersonalTelegramConfig | PersonalQqConfig; usedBy?: string };
export const PersonalImPairingDoc = defineDocFamily<{ value?: Pairing }, null>({ kind: "ruukoto.im-pairing", scope: "session", version: 1, family: true, initial: () => ({}) });
export type PersonalImPairingRequest = { v: 1; op: "im.pair-start"; id: string; platform: Platform; endpoint: string; tokenEnv: string } | { v: 1; op: "im.pair-read" | "im.pair-cancel"; id: string } | { v: 1; op: "im.pair-confirm"; id: string; ownerId: string };
const context = BACKGROUND_CONTEXT, uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = () => new PersonalError("im_pairing_invalid", "配对记录无法核实，请通过当前后台重新配对。");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parsePersonalImPairingRequest(value: unknown): PersonalImPairingRequest {
  if (!object(value) || value.v !== 1) throw invalid();
  const keys = Object.keys(value).sort().join(",");
  if (value.op === "im.pair-start" && keys === "endpoint,id,op,platform,tokenEnv,v" && typeof value.id === "string" && uuid.test(value.id) && ["telegram", "qq"].includes(String(value.platform)) && typeof value.endpoint === "string" && typeof value.tokenEnv === "string") return value as PersonalImPairingRequest;
  if (typeof value.id !== "string" || !uuid.test(value.id)) throw invalid();
  if (["im.pair-read", "im.pair-cancel"].includes(String(value.op)) && keys === "id,op,v" || value.op === "im.pair-confirm" && keys === "id,op,ownerId,v" && typeof value.ownerId === "string" && /^[1-9][0-9]{0,15}$/.test(value.ownerId)) return value as PersonalImPairingRequest;
  throw invalid();
}
export async function dispatchPersonalImPairing(instance: PersonalHarness, request: PersonalImPairingRequest) {
  if (request.op === "im.pair-start") return instance.imPairing.start(request);
  if (request.op === "im.pair-confirm") return instance.imPairing.confirm(request.id, request.ownerId);
  return request.op === "im.pair-cancel" ? instance.imPairing.cancel(request.id) : instance.imPairing.read(request.id);
}

/** 后台生成的代次与配对证明只能用于原设置操作，旧证明不能复活旧入口授权。 */
export async function claimPersonalImPairing(tx: Tx, platform: Platform, config: PersonalTelegramConfig | PersonalQqConfig, version: string) {
  if (!config.enabled) return;
  if (!config.pairingId) throw new PersonalError("im_pairing_required", "启用或更换入口须先在当前后台配对，原入口保留；请运行配对向导。");
  const pairing = (await tx.doc(PersonalImPairingDoc, config.pairingId, null)).value;
  if (!pairing || pairing.platform !== platform || pairing.phase !== "confirmed" || !isDeepStrictEqual(pairing.config, config) || pairing.usedBy !== undefined && pairing.usedBy !== version) throw new PersonalError("im_pairing_required", "原配对证明与本次配置不符或已使用，请通过后台重新配对。");
  pairing.usedBy = version;
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-25-personal-im-updates.md
export function personalImPairing(harness: Harness, profile: PersonalProfileLock, im: PersonalImRuntime) {
  type Live = { platform: Platform; api?: PersonalTelegramApi; client?: OneBotClient; draft: PersonalTelegramConfig | PersonalQqConfig; ack?: TelegramAck; pending: Promise<void>; timer?: ReturnType<typeof setTimeout> };
  const live = new Map<string, Live>(), active = new Map<Platform, string>(), queues = new Map<string, Promise<void>>();
  async function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), next = previous.then(() => held);
    queues.set(id, next); await previous;
    try { return await action(); } finally { release(); if (queues.get(id) === next) queues.delete(id); }
  }
  async function change(id: string, phase: Pairing["phase"], code?: string, offset?: number) {
    await harness.commit(async tx => { const value = (await tx.doc(PersonalImPairingDoc, id, null)).value; if (!value) throw invalid(); value.phase = phase; value.facts.push({ phase, at: Date.now(), ...(code ? { code } : {}), ...(offset === undefined ? {} : { offset }) }); }, context);
  }
  async function release(id: string, resume = true) {
    const value = live.get(id); if (!value) return;
    clearTimeout(value.timer); live.delete(id); if (active.get(value.platform) === id) active.delete(value.platform);
    await value.client?.stop();
    if (resume) await value.pending;
    // 候选证据提交失败已单独上报；关闭只等待其结束，原连接停止失败仍向外传递。
    else await Promise.allSettled([value.pending]);
    if (resume) im.resumeReceive(value.platform);
  }
  async function failed(id: string, error: unknown): Promise<never> {
    await change(id, "failed", error instanceof PersonalError ? error.code : "im_pairing_failed");
    await release(id);
    if (error instanceof PersonalError) throw error;
    throw new PersonalError("im_pairing_failed", "后台配对未完成，原绑定保留；平台接管边界可能已改变，请查询原配对记录。", { cause: error });
  }
  function revision(platform: Platform) {
    const filename = path.join(profile.directory, platform === "qq" ? "qq.json" : "telegram.json");
    return fs.existsSync(filename) ? `sha256:${createHash("sha256").update(fs.readFileSync(filename)).digest("hex")}` : "missing";
  }
  function result(value: Pairing) {
    return { id: value.id, platform: value.platform, phase: value.phase, phrase: value.phrase, accountId: value.draft.botId, candidates: value.candidates.map(candidate => ({ ownerId: candidate.ownerId, name: candidate.name })), profile: personalSettingsIdentity(profile), revision: revision(value.platform), facts: value.facts.slice(-16).map(fact => ({ ...fact })), ...(value.config ? { config: structuredClone(value.config) } : {}) };
  }
  async function saved(id: string) { const value = (await harness.snapshot(PersonalImPairingDoc, id, context))?.value; if (!value) throw invalid(); return value; }
  return {
    async start(input: Extract<PersonalImPairingRequest, { op: "im.pair-start" }>) {
      const original = (await harness.snapshot(PersonalImPairingDoc, input.id, context))?.value;
      const request = { platform: input.platform, endpoint: input.endpoint, tokenEnv: input.tokenEnv };
      if (original) { if (!isDeepStrictEqual(original.request, request)) throw new PersonalError("im_pairing_conflict", "原配对参数不同，请查询原配对，不要重复接管。"); return result(original); }
      if (active.has(input.platform)) throw new PersonalError("im_pairing_busy", "该平台已有配对会话，请完成或等待原配对过期。");
      const id = input.id, generation = randomUUID(), phrase = `配对 ${randomBytes(12).toString("hex")}`;
      const draft = input.platform === "telegram" ? parsePersonalTelegram({ version: 1, enabled: true, generation, apiBase: input.endpoint, tokenEnv: input.tokenEnv, tokenDigest: "0".repeat(64), botId: "1", ownerId: "1", boundary: 0 }) : parsePersonalQq({ version: 1, enabled: true, generation, endpoint: input.endpoint, tokenEnv: input.tokenEnv, tokenDigest: "0".repeat(64), botId: "1", ownerId: "2", boundary: 0, boundaryMessageId: "0" });
      const token = process.env[draft.tokenEnv];
      if (!token || /[\r\n]/.test(token) || input.platform === "telegram" && !/^[1-9][0-9]*:[\w-]+$/.test(token)) throw new PersonalError("im_credentials_missing", "后台没有有效的入口凭据，未开始配对；请配置后台环境后重试。");
      draft.tokenDigest = createHash("sha256").update(token).digest("hex");
      if (input.platform === "telegram") draft.botId = token.split(":")[0];
      const value: Live = { platform: input.platform, draft, pending: Promise.resolve() }; live.set(id, value); active.set(input.platform, id);
      await harness.commit(async tx => { (await tx.doc(PersonalImPairingDoc, id, null)).value = { id, request, platform: input.platform, phrase, createdAt: Date.now(), phase: "starting", draft: structuredClone(draft), candidates: [], facts: [{ phase: "starting", at: Date.now() }] }; }, context);
      try {
        if (input.platform === "telegram") {
          value.api = personalTelegramApi((draft as PersonalTelegramConfig).apiBase, token);
          const bot = await value.api.me(AbortSignal.timeout(10000));
          if (bot.id !== token.split(":")[0]) throw new PersonalError("telegram_identity_invalid", "后台核实的 bot 与凭据不符，请检查服务地址后重新配对。");
          draft.botId = bot.id;
          await harness.commit(async tx => { (await tx.doc(PersonalImPairingDoc, id, null)).value!.draft = structuredClone(draft); }, context);
          await im.pauseReceive("telegram");
          await change(id, "starting", "telegram_takeover_started", -1);
          const updates = await value.api.updates(AbortSignal.timeout(10000), -1, 0);
          value.ack = updates.length ? { offset: updates.at(-1)!.update_id + 1, receivedAt: performance.now() } : undefined;
          await change(id, "waiting", "telegram_takeover_observed", value.ack?.offset);
        } else {
          value.client = new OneBotClient({ endpoint: (draft as PersonalQqConfig).endpoint, token, onEvent(event) {
            if (!value.client?.online || value.client.selfId !== draft.botId) return;
            const message = qqMessage(event, draft.botId);
            if (!message?.direct || message.media || message.replyTo !== undefined || message.text !== phrase) return;
            value.pending = value.pending.then(() => harness.commit(async tx => { const record = (await tx.doc(PersonalImPairingDoc, id, null)).value; if (!record || record.phase !== "waiting" || Date.now() - record.createdAt >= 180000 || record.candidates.some(candidate => candidate.ownerId === message.ownerId) || record.candidates.length >= 16) return; record.candidates.push({ ownerId: message.ownerId, messageId: message.id, name: `QQ 好友 ${message.ownerId}`, time: Number(event.time) }); }, context));
            void value.pending.catch(() => process.stderr.write("[ruukoto:personal] QQ 配对证据保存失败，候选不可使用；请保留档案并查询原配对。\n"));
          } });
          value.client.start(); const signal = AbortSignal.timeout(15000);
          while (!value.client.online && !signal.aborted) await delay(25, undefined, { signal });
          if (!value.client.online || !value.client.selfId) throw new PersonalError("qq_pairing_unavailable", "后台无法核实 QQ 登录账号，请检查 OneBot 服务和后台凭据。");
          draft.botId = value.client.selfId;
          await harness.commit(async tx => { (await tx.doc(PersonalImPairingDoc, id, null)).value!.draft = structuredClone(draft); }, context);
          await im.pauseReceive("qq"); await change(id, "waiting");
        }
        value.timer = setTimeout(() => { void (async () => { const value = await saved(id); if (value.phase !== "confirmed") await change(id, "failed", "im_pairing_expired"); await release(id); })().catch(() => process.stderr.write("[ruukoto:personal] IM 配对过期处理未完成，请查询原配对记录。\n")); }, 180000); value.timer.unref();
        return result(await saved(id));
      } catch (error) { return failed(id, error); }
    },
    async read(id: string) { return exclusive(id, async () => {
      const record = await saved(id), value = live.get(id);
      if (["confirmed", "failed"].includes(record.phase)) return result(record);
      if (!value) { await change(id, "failed", "im_pairing_interrupted"); return result(await saved(id)); }
      if (record.phase !== "waiting") return result(record);
      try {
        await value.pending;
        if (value.api && !record.candidates.length) {
          const offset = telegramOffset(value.ack); value.ack = undefined;
          await change(id, "waiting", "telegram_ack_started", offset);
          const updates = await value.api.updates(AbortSignal.timeout(10000), offset, 0), receivedAt = performance.now();
          value.ack = updates.length ? { offset: updates.at(-1)!.update_id + 1, receivedAt } : undefined;
          const candidates = updates.map(update => ({ update, message: telegramText(update) })).filter(item => item.message?.direct && item.message.replyTo === undefined && item.message.text === record.phrase).slice(0, 16);
          await harness.commit(async tx => { const record = (await tx.doc(PersonalImPairingDoc, id, null)).value!; record.candidates = candidates.map(({ message }) => ({ ownerId: message!.ownerId, messageId: message!.id, name: message!.name, time: 0 })); record.facts.push({ phase: "telegram_observed", at: Date.now(), ...(value.ack ? { offset: value.ack.offset } : {}) }); }, context);
        }
        return result(await saved(id));
      } catch (error) { return failed(id, error); }
    }); },
    async confirm(id: string, ownerId: string) { return exclusive(id, async () => {
      const record = await saved(id), value = live.get(id);
      if (record.phase === "confirmed") { if (record.config?.ownerId !== ownerId) throw invalid(); return result(record); }
      if (!value || record.phase !== "waiting" || Date.now() - record.createdAt >= 180000) throw new PersonalError("im_pairing_expired", "原配对已过期或中断，请在当前后台重新配对。");
      await value.pending;
      const selected = (await saved(id)).candidates.find(candidate => candidate.ownerId === ownerId);
      if (!selected) throw new PersonalError("im_pairing_missing", "未找到该拥有者本轮直接发送的配对消息，请重新查询候选。");
      try {
        let config: PersonalTelegramConfig | PersonalQqConfig;
        if (value.api) {
          const offset = telegramOffset(value.ack); if (offset === undefined) throw new PersonalError("im_pairing_expired", "身份选择已过期，请重新配对；未复用旧确认水位。");
          await change(id, "confirming", "telegram_confirmation_started", offset);
          await value.api.updates(AbortSignal.timeout(10000), offset, 0);
          config = parsePersonalTelegram({ ...value.draft, ownerId, boundary: offset - 1, pairingId: id });
        } else {
          if (!value.client?.online || value.client.selfId !== value.draft.botId) throw new PersonalError("qq_pairing_unavailable", "QQ 候选账号已变化或离线，请重新配对。");
          config = parsePersonalQq({ ...value.draft, ownerId, boundary: selected.time, boundaryMessageId: String(selected.messageId), pairingId: id });
        }
        await harness.commit(async tx => { const record = (await tx.doc(PersonalImPairingDoc, id, null)).value!; if (record.phase === "confirmed") throw invalid(); record.config = config; record.phase = "confirmed"; record.facts.push({ phase: "confirmed", at: Date.now() }); }, context);
        await value.client?.stop(); value.client = undefined;
        return result(await saved(id));
      } catch (error) { return failed(id, error); }
    }); },
    async cancel(id: string) { return exclusive(id, async () => { const record = await saved(id); if (record.phase !== "confirmed" && record.phase !== "failed") await change(id, "failed", "im_pairing_canceled"); await release(id); return result(await saved(id)); }); },
    complete: (id: string, resume = false) => release(id, resume),
    close() { if (live.size) return (async () => { for (const id of [...live.keys()]) await release(id, false); })(); },
  };
}
