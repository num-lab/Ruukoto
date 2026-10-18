import { OneBotClient, OneBotError, oneBotAccountId, oneBotMessageId } from "@ruukoto/channels/qq/onebot.ts";
import { PersonalError } from "./personal-error.ts";
import { PersonalImApiError } from "./personal-im-api.ts";
import { PersonalMediaError, type PersonalMediaDownload } from "./personal-media.ts";
import type { PersonalQqConfig } from "./personal-qq-config.ts";

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export type QqMessage = { id: number; ownerId: string; text: string; direct: boolean; replyTo?: number; media?: { identity: string; url?: string }[] };

export function qqMessage(event: Record<string, unknown>, account: string): QqMessage | undefined {
  const id = oneBotMessageId(event.message_id), ownerId = oneBotAccountId(event.user_id);
  if (event.post_type !== "message" || event.message_type !== "private" || event.sub_type !== "friend" || "group_id" in event || oneBotAccountId(event.self_id) !== account || !ownerId || ownerId === account || id === null || !Number.isSafeInteger(event.time) || Number(event.time) < 0 || object(event.sender) && event.sender.user_id !== undefined && oneBotAccountId(event.sender.user_id) !== ownerId || !Array.isArray(event.message) || event.message.length > 128) return;
  let text = "", replyTo: number | undefined, direct = true;
  const media: NonNullable<QqMessage["media"]> = [];
  for (const part of event.message) {
    if (!object(part) || !object(part.data)) return;
    if (part.type === "text" && typeof part.data.text === "string") text += part.data.text;
    else if (part.type === "reply" && replyTo === undefined && oneBotMessageId(part.data.id) !== null) replyTo = Number(part.data.id);
    else if (part.type === "image") media.push({ identity: typeof part.data.file === "string" && part.data.file ? part.data.file : "invalid-image", ...(typeof part.data.file === "string" && part.data.file && part.data.file.length <= 4096 && typeof part.data.url === "string" ? { url: part.data.url } : {}) });
    else direct = false;
  }
  if (!text.trim() && !media.length || Buffer.byteLength(text) > 16384) return;
  return { id: Number(id), ownerId, text, direct, ...(replyTo === undefined ? {} : { replyTo }), ...(media.length ? { media } : {}) };
}

export function qqPhoto(input: { identity: string; url?: string }, resolve?: (file: string, signal: AbortSignal) => Promise<string | undefined>): PersonalMediaDownload {
  return { identity: input.identity, async download(signal) {
    const address = input.identity !== "invalid-image" && input.identity.length <= 4096 ? input.url ?? await resolve?.(input.identity, signal) : undefined;
    let url: URL;
    try { url = new URL(address ?? ""); } catch { throw new PersonalMediaError("download_unavailable"); }
    // OneBot 图片 URL 是独立下载凭据；不带连接 token，也不跟随重定向到本机服务。
    if (url.protocol !== "https:" || url.username || url.password || !["multimedia.nt.qq.com", "gchat.qpic.cn", "c2cpicdw.qpic.cn"].includes(url.hostname)) throw new PersonalMediaError("download_unavailable");
    try { return await fetch(url, { signal, redirect: "error" }); } catch { throw new PersonalError("media_retry", "QQ 图片下载暂时不可用，收件尚未完成；请检查网络。"); }
  } };
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md
export function personalQqApi(config: PersonalQqConfig, token: string) {
  let receive: ((event: Record<string, unknown>) => Promise<void>) | undefined;
  let connection: ((online: boolean) => Promise<void>) | undefined;
  let pending = Promise.resolve();
  let failure: unknown;
  let queued = 0;
  let listening = false;
  const enqueue = (action: () => Promise<void>) => {
    if (queued >= 256) { failure = new PersonalError("qq_receive_overflow", "QQ 收件积压超限，已停止；请查询原受理记录，核实未受理消息后重新提交。"); return; }
    queued++;
    pending = pending.then(async () => { if (!failure) await action(); }).catch(error => { failure = error; }).finally(() => { queued--; });
  };
  const client = new OneBotClient({ endpoint: config.endpoint, token, onEvent(event) {
    if (!receive || !client.online || client.selfId !== config.botId || oneBotAccountId(event.self_id) !== config.botId) return;
    enqueue(async () => { await receive?.(event); });
  }, onStateChange(online) { if (connection) enqueue(async () => { await connection?.(online && client.selfId === config.botId); }); } });
  return {
    get online() { return client.online && client.selfId === config.botId; },
    async poll(handler: (event: Record<string, unknown>) => Promise<void>, signal: AbortSignal, onConnection?: (online: boolean) => Promise<void>) {
      if (listening) throw new PersonalError("qq_poll_busy", "QQ 收件循环已启动，请使用当前后台连接。");
      listening = true; receive = handler; failure = undefined;
      connection = onConnection;
      try {
        await connection?.(false);
        if (signal.aborted) return;
        client.start();
        while (!signal.aborted && !failure) {
          if (client.online && client.selfId !== config.botId) throw new PersonalError("qq_identity_changed", "QQ 实际登录账号与绑定不符，已停止收件；请检查服务或重新配对。");
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 100); signal.addEventListener("abort", done, { once: true });
          });
        }
        await pending;
        if (failure) throw failure;
      } finally {
        receive = undefined; connection = undefined;
        try { await client.stop(); await pending; await onConnection?.(false); } finally { listening = false; }
      }
    },
    photo(input: { identity: string; url?: string }) { return qqPhoto(input, async (file, signal) => {
      let result: unknown;
      try { result = await client.call("get_image", { file }, signal); } catch (error) {
        if (!(error instanceof OneBotError)) throw error;
        if (error.definite) throw new PersonalMediaError("download_unavailable");
        throw new PersonalError("media_retry", "QQ 图片信息暂时不可用，收件尚未完成。");
      }
      return object(result) && typeof result.url === "string" ? result.url : undefined;
    }); },
    async send(ownerId: string, messageId: number, text: string, signal: AbortSignal) {
      if (ownerId !== config.ownerId || !client.online || client.selfId !== config.botId) throw new PersonalImApiError("qq_unavailable", "QQ 原账号尚未在线核实，未发送；请查询入口状态。", "not_sent", 1000);
      let result: unknown;
      try { result = await client.call("send_private_msg", { user_id: Number(ownerId), message: [{ type: "reply", data: { id: String(messageId) } }, { type: "text", data: { text } }] }, signal); } catch (error) {
        if (!(error instanceof OneBotError)) throw error;
        const rejected = error.definite && [100, 1400, 1404].includes(error.retcode!);
        throw new PersonalImApiError(rejected ? "qq_refused" : "qq_unverified", rejected ? "QQ 明确拒绝发送，请检查原入口。" : "QQ 发送结果未知，不会自动重发；请查询原私聊。", rejected ? "not_sent" : "effect_unknown");
      }
      const id = object(result) && oneBotMessageId(result.message_id);
      if (id === null || id === false) throw new PersonalImApiError("qq_unverified", "QQ 发送回执无效，不会自动重发；请查询原私聊。", "effect_unknown");
      return id;
    },
  };
}
export type PersonalQqApi = ReturnType<typeof personalQqApi>;
