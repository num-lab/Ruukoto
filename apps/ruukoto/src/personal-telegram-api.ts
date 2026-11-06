import { PersonalMediaError, type PersonalMediaDownload } from "./personal-media.ts";
import { PersonalError } from "./personal-error.ts";
import { PersonalImApiError } from "./personal-im-api.ts";

export type TelegramUpdate = { update_id: number; message?: unknown; callback_query?: unknown };
export type TelegramText = { id: number; ownerId: string; text: string; name: string; direct: boolean; media?: { identity: string; fileId: string; sizeBytes?: number }[]; replyTo?: number; replyBotId?: string };
export type TelegramCallback = { queryId: string; data: string; ownerId: string; botId: string; chatId: string; messageId: number; date: number };
export type TelegramKeyboard = { text: string; callback_data: string }[][];
export type TelegramAck = { offset: number; receivedAt: number };

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
const indirect = (value: Record<string, unknown>) => ["forward_origin", "forward_from", "forward_from_chat", "forward_sender_name", "is_automatic_forward", "via_bot", "sender_chat", "external_reply", "quote"].some(key => key in value);
const callbackId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const validText = (value: string) => value.length > 0 && Array.from(value).length <= 4096;
const invalidInput = () => new PersonalImApiError("telegram_input_invalid", "Telegram 发送内容或目标无效，未发送；请核实原记录。", "not_sent");

export function telegramCallbackQueryId(update: TelegramUpdate): string | undefined { const query = update.callback_query; return object(query) && callbackId(query.id) ? query.id : undefined; }

export function telegramCallbackIdentity(update: TelegramUpdate) {
  const query = update.callback_query;
  if (!object(query)) return {};
  const message = object(query.message) ? query.message : undefined, from = object(query.from) ? query.from : undefined;
  const chat = message && object(message.chat) ? message.chat : undefined, bot = message && object(message.from) ? message.from : undefined;
  return { queryId: telegramCallbackQueryId(update) ?? null, sender: from?.id ?? null, senderBot: from?.is_bot ?? null, token: query.data ?? null, message: message?.message_id ?? null, chat: chat?.id ?? null, chatType: chat?.type ?? null, bot: bot?.id ?? null, botFlag: bot?.is_bot ?? null, accessible: !!message && id(message.date), inline: "inline_message_id" in query, game: "game_short_name" in query, indirect: indirect(query) || !!message && indirect(message) };
}

function checkTarget(ownerId: string, messageId?: number) {
  if (!/^[1-9][0-9]{0,15}$/.test(ownerId) || messageId !== undefined && !id(messageId)) throw invalidInput();
}

function messageResult(result: unknown, ownerId: string): Record<string, unknown> {
  if (!object(result) || !id(result.message_id) || !object(result.chat) || !id(result.chat.id) || String(result.chat.id) !== ownerId || result.chat.type !== "private") throw new PersonalTelegramApiError("effect_unknown");
  return result;
}

async function readReply(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new PersonalTelegramApiError("effect_unknown");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 1024 * 1024) throw new PersonalTelegramApiError("effect_unknown");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function telegramText(update: TelegramUpdate): TelegramText | undefined { return telegramMessage(update, false); }

export function telegramMessage(update: TelegramUpdate, allowImages = true): TelegramText | undefined {
  const m = update.message;
  if (!object(m) || !id(m.message_id) || !object(m.chat) || m.chat.type !== "private" || !id(m.chat.id) || !object(m.from) || !id(m.from.id) || m.from.is_bot !== false || m.chat.id !== m.from.id) return;
  const hasImages = allowImages && Array.isArray(m.photo) && m.photo.length > 0;
  const text = hasImages ? typeof m.caption === "string" ? m.caption : "" : m.text;
  if (typeof text !== "string" || !hasImages && !text.trim() || Buffer.byteLength(text) > 16384) return;
  let media: TelegramText["media"];
  if (hasImages) {
    const photos = (m.photo as unknown[]).filter(object);
    const photo = photos.reduce<Record<string, unknown> | undefined>((largest, candidate) => !largest || Number(candidate.width) * Number(candidate.height) > Number(largest.width) * Number(largest.height) ? candidate : largest, undefined);
    media = [{ identity: typeof photo?.file_unique_id === "string" ? photo.file_unique_id : typeof photo?.file_id === "string" ? photo.file_id : "invalid-photo", fileId: typeof photo?.file_id === "string" ? photo.file_id : "", ...(typeof photo?.file_size === "number" ? { sizeBytes: photo.file_size } : {}) }];
  }
  const reply = object(m.reply_to_message) ? m.reply_to_message : undefined;
  return { id: m.message_id, ownerId: String(m.from.id), text, ...(media ? { media } : {}), name: typeof m.from.first_name === "string" ? m.from.first_name.slice(0, 128) : "Telegram 用户", direct: !indirect(m), ...(reply && id(reply.message_id) ? { replyTo: reply.message_id } : {}), ...(reply && object(reply.from) && reply.from.is_bot === true && id(reply.from.id) ? { replyBotId: String(reply.from.id) } : {}) };
}

export function telegramCallback(update: TelegramUpdate): TelegramCallback | undefined {
  const q = update.callback_query;
  if (!object(q) || !callbackId(q.id) || typeof q.data !== "string" || !q.data || Buffer.byteLength(q.data) > 64 || "inline_message_id" in q || "game_short_name" in q || indirect(q) || !object(q.from) || !id(q.from.id) || q.from.is_bot !== false) return;
  const m = q.message;
  if (!object(m) || !id(m.message_id) || !id(m.date) || indirect(m) || !object(m.chat) || m.chat.type !== "private" || !id(m.chat.id) || m.chat.id !== q.from.id || !object(m.from) || !id(m.from.id) || m.from.is_bot !== true) return;
  return { queryId: q.id, data: q.data, ownerId: String(q.from.id), botId: String(m.from.id), chatId: String(m.chat.id), messageId: m.message_id, date: m.date };
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md
export function telegramOffset(ack?: TelegramAck, now = performance.now()): number | undefined {
  return ack && now >= ack.receivedAt && now - ack.receivedAt < 60_000 ? ack.offset : undefined;
}

export class PersonalTelegramApiError extends PersonalImApiError {
  constructor(effect: "not_sent" | "effect_unknown", retryAfterMs?: number) {
    super(retryAfterMs ? "telegram_rate_limited" : effect === "not_sent" ? "telegram_refused" : "telegram_unverified", retryAfterMs ? "Telegram 明确限流，原发送将延后处理。" : effect === "not_sent" ? "Telegram 明确拒绝请求，请检查入口配置与权限。" : "Telegram 请求结果未能核实，请查看收发状态；未知发送不会自动重发。", effect, retryAfterMs);
  }
}

export function personalTelegramApi(apiBase: string, token: string) {
  async function call(method: string, body: object | FormData, signal: AbortSignal, timeoutMs = 35_000): Promise<unknown> {
    let response: Response;
    try { response = await fetch(`${apiBase}/bot${token}/${method}`, { method: "POST", ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: "error" }); } catch {
      // Fetch failures may contain credential URLs; expose only the effect classification.
      throw new PersonalTelegramApiError("effect_unknown");
    }
    let value: unknown;
    try { value = await readReply(response); } catch {
      // Oversized, truncated or non-JSON receipts do not prove the request was not sent.
      throw new PersonalTelegramApiError("effect_unknown");
    }
    if (response.ok && object(value) && value.ok === true && "result" in value) return value.result;
    if (object(value) && value.ok === false && value.error_code === response.status && response.status >= 400 && response.status < 500) {
      if (response.status === 429) {
        const seconds = object(value.parameters) && value.parameters.retry_after;
        if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400) throw new PersonalTelegramApiError("not_sent", seconds * 1000);
        throw new PersonalTelegramApiError("effect_unknown");
      }
      throw new PersonalTelegramApiError("not_sent");
    }
    throw new PersonalTelegramApiError("effect_unknown");
  }
  return {
    async me(signal: AbortSignal) {
      const result = await call("getMe", {}, signal, 10_000);
      if (!object(result) || !id(result.id) || result.is_bot !== true || typeof result.username !== "string") throw new PersonalTelegramApiError("effect_unknown");
      return { id: String(result.id), username: result.username };
    },
    async updates(signal: AbortSignal, offset?: number, timeout = 25): Promise<TelegramUpdate[]> {
      // Keep each batch within the 1 MiB receipt budget, including original text and references.
      const result = await call("getUpdates", { ...(offset === undefined ? {} : { offset }), timeout, limit: 16, allowed_updates: ["message", "callback_query"] }, signal, (timeout + 10) * 1000);
      if (!Array.isArray(result) || result.length > 16 || result.some((item, i) => !object(item) || typeof item.update_id !== "number" || !Number.isSafeInteger(item.update_id) || item.update_id < 0 || (i > 0 && item.update_id <= result[i - 1].update_id))) throw new PersonalTelegramApiError("effect_unknown");
      return result as TelegramUpdate[];
    },
    photo(input: { identity: string; fileId: string; sizeBytes?: number }): PersonalMediaDownload {
      return { identity: input.identity, ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }), async download(signal) {
        if (!input.fileId || input.fileId.length > 4096) throw new PersonalMediaError("download_unavailable");
        let result: unknown;
        try { result = await call("getFile", { file_id: input.fileId }, signal, 15_000); } catch (error) {
          if (error instanceof PersonalTelegramApiError && error.effect === "not_sent" && !error.retryAfterMs) throw new PersonalMediaError("download_unavailable");
          throw new PersonalError("media_retry", "图片下载暂时不可用。");
        }
        const filename = object(result) ? result.file_path : undefined;
        if (typeof filename !== "string" || !/^[A-Za-z0-9_./-]+$/.test(filename) || filename.startsWith("/") || filename.split("/").some(part => !part || part === "." || part === "..")) throw new PersonalMediaError("download_unavailable");
        let response: Response;
        try { response = await fetch(`${apiBase}/file/bot${token}/${filename}`, { signal, redirect: "error" }); } catch { throw new PersonalError("media_retry", "图片下载暂时不可用。"); }
        const headers = new Headers(response.headers), returned = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (!returned || returned === "application/octet-stream") headers.set("content-type", ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as Record<string, string>)[filename.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream");
        return new Response(response.body, { status: response.status, headers });
      } };
    },
    async send(ownerId: string, messageId: number, text: string, signal: AbortSignal, keyboard?: TelegramKeyboard) {
      checkTarget(ownerId, messageId);
      if (!validText(text) || keyboard !== undefined && (!Array.isArray(keyboard) || !keyboard.length || keyboard.some(row => !Array.isArray(row) || !row.length || row.some(button => !object(button) || typeof button.text !== "string" || !button.text || typeof button.callback_data !== "string" || !button.callback_data || Buffer.byteLength(button.callback_data) > 64)))) throw invalidInput();
      const result = messageResult(await call("sendMessage", { chat_id: ownerId, text, reply_parameters: { message_id: messageId, allow_sending_without_reply: true }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) }, signal, 10_000), ownerId);
      return String(result.message_id);
    },
    async answerCallback(queryId: string, signal: AbortSignal): Promise<void> {
      if (!callbackId(queryId)) throw invalidInput();
      if (await call("answerCallbackQuery", { callback_query_id: queryId }, signal, 5_000) !== true) throw new PersonalTelegramApiError("effect_unknown");
    },
    async edit(ownerId: string, messageId: number, text: string, signal: AbortSignal): Promise<void> {
      checkTarget(ownerId, messageId);
      if (!validText(text)) throw invalidInput();
      const result = messageResult(await call("editMessageText", { chat_id: ownerId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }, signal, 10_000), ownerId);
      if (result.message_id !== messageId) throw new PersonalTelegramApiError("effect_unknown");
    },
    async typing(ownerId: string, signal: AbortSignal): Promise<void> {
      checkTarget(ownerId);
      if (await call("sendChatAction", { chat_id: ownerId, action: "typing" }, signal, 5_000) !== true) throw new PersonalTelegramApiError("effect_unknown");
    },
    async document(ownerId: string, messageId: number, input: { name: string; mime: string; bytes: Uint8Array }, signal: AbortSignal): Promise<string> {
      checkTarget(ownerId, messageId);
      if (!input.name || input.name.length > 128 || !input.name.trim() || input.name === "." || input.name === ".." || /[\x00-\x1f\x7f\\/]/.test(input.name) || !input.mime || input.mime.length > 256 || !/^[a-z0-9.+_-]+\/[a-z0-9.+_-]+(?:;[\x20-\x7e]+)?$/i.test(input.mime) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 8 * 1024 * 1024) throw invalidInput();
      const body = new FormData();
      body.set("chat_id", ownerId);
      body.set("reply_parameters", JSON.stringify({ message_id: messageId, allow_sending_without_reply: true }));
      body.set("disable_content_type_detection", "true");
      body.set("document", new Blob([Uint8Array.from(input.bytes)], { type: input.mime }), input.name);
      const result = messageResult(await call("sendDocument", body, signal), ownerId), file = result.document;
      if (!object(file) || typeof file.file_id !== "string" || !file.file_id || file.file_id.length > 4096 || file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || file.file_size !== input.bytes.byteLength) || file.file_name !== undefined && file.file_name !== input.name) throw new PersonalTelegramApiError("effect_unknown");
      return String(result.message_id);
    },
  };
}

export type PersonalTelegramApi = ReturnType<typeof personalTelegramApi>;
