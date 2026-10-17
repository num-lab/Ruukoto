import { PersonalError } from "./personal-error.ts";

export type TelegramUpdate = { update_id: number; message?: unknown };
export type TelegramText = { id: number; ownerId: string; text: string; name: string; direct: boolean; replyTo?: number; replyBotId?: string };
export type TelegramAck = { offset: number; receivedAt: number };

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

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

export function telegramText(update: TelegramUpdate): TelegramText | undefined {
  const m = update.message;
  if (!object(m) || !id(m.message_id) || !object(m.chat) || m.chat.type !== "private" || !id(m.chat.id) || !object(m.from) || !id(m.from.id) || m.from.is_bot !== false || m.chat.id !== m.from.id || typeof m.text !== "string" || !m.text.trim() || Buffer.byteLength(m.text) > 16384) return;
  const reply = object(m.reply_to_message) ? m.reply_to_message : undefined;
  return { id: m.message_id, ownerId: String(m.from.id), text: m.text, name: typeof m.from.first_name === "string" ? m.from.first_name.slice(0, 128) : "Telegram 用户", direct: !["forward_origin", "forward_from", "forward_from_chat", "forward_sender_name", "via_bot", "sender_chat", "external_reply", "quote"].some(key => key in m), ...(reply && id(reply.message_id) ? { replyTo: reply.message_id } : {}), ...(reply && object(reply.from) && reply.from.is_bot === true && id(reply.from.id) ? { replyBotId: String(reply.from.id) } : {}) };
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md
export function telegramOffset(ack?: TelegramAck, now = performance.now()): number | undefined {
  return ack && now >= ack.receivedAt && now - ack.receivedAt < 60_000 ? ack.offset : undefined;
}

export class PersonalTelegramApiError extends PersonalError {
  constructor(readonly effect: "not_sent" | "effect_unknown", readonly retryAfterMs?: number) {
    super(retryAfterMs ? "telegram_rate_limited" : effect === "not_sent" ? "telegram_refused" : "telegram_unverified", retryAfterMs ? "Telegram 明确限流，原发送将延后处理。" : effect === "not_sent" ? "Telegram 明确拒绝请求，请检查入口配置与权限。" : "Telegram 请求结果未能核实，请查看收发状态；未知发送不会自动重发。");
  }
}

export function personalTelegramApi(apiBase: string, token: string) {
  async function call(method: string, body: object, signal: AbortSignal, timeoutMs = 35_000): Promise<unknown> {
    let response: Response;
    try { response = await fetch(`${apiBase}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: "error" }); } catch {
      // fetch 错误可能含凭据 URL；对外只保留不可核实的效果分类。
      throw new PersonalTelegramApiError("effect_unknown");
    }
    let value: unknown;
    try { value = await readReply(response); } catch {
      // 超限、截断或非 JSON 回执都不能证明发送未发生。
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
      // 单批为文本原文和平台引用留出 1 MiB 回执预算，避免大批合法消息反复超限。
      const result = await call("getUpdates", { ...(offset === undefined ? {} : { offset }), timeout, limit: 16, allowed_updates: ["message"] }, signal, (timeout + 10) * 1000);
      if (!Array.isArray(result) || result.length > 16 || result.some((item, i) => !object(item) || typeof item.update_id !== "number" || !Number.isSafeInteger(item.update_id) || item.update_id < 0 || (i > 0 && item.update_id <= result[i - 1].update_id))) throw new PersonalTelegramApiError("effect_unknown");
      return result as TelegramUpdate[];
    },
    async send(ownerId: string, messageId: number, text: string, signal: AbortSignal) {
      const result = await call("sendMessage", { chat_id: ownerId, text, reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }, signal, 10_000);
      if (!object(result) || !id(result.message_id) || !object(result.chat) || String(result.chat.id) !== ownerId || result.chat.type !== "private") throw new PersonalTelegramApiError("effect_unknown");
      return String(result.message_id);
    },
  };
}

export type PersonalTelegramApi = ReturnType<typeof personalTelegramApi>;
