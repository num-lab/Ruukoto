import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalTelegramApiError, telegramOffset, telegramMessage, type PersonalTelegramApi, type TelegramAck, type TelegramUpdate, type TelegramText } from "./personal-telegram-api.ts";
import { personalEntryConfig, PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramReceipt as Receipt, type TelegramResult as Result, type TelegramControlInput } from "./personal-telegram-records.ts";
import { telegramPermissionControl, personalPermissionFor, PersonalPermissionsDoc, TELEGRAM_SERVICE_ACTIONS } from "./personal-permissions.ts";
import { telegramWorkControl, telegramDelegationControl } from "./personal-work-controls.ts";
export { PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { personalMediaRejection, type PersonalMedia, type PersonalMediaDownload } from "./personal-media.ts";
import type { PersonalTelegramConfig } from "./personal-telegram-config.ts";

import { qqMessage, qqPhoto, type PersonalQqApi } from "./personal-qq-api.ts";
import { parsePersonalQq, type PersonalQqConfig } from "./personal-qq-config.ts";
import { PersonalImApiError } from "./personal-im-api.ts";

type Input = Omit<TelegramText, "media"> & { media?: PersonalMediaDownload[] };
const context = BACKGROUND_CONTEXT;
const TASK = "ruukoto.telegram-input";

async function receipt(tx: Tx, requestId: string, taskId: TaskId) {
  const value = (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt;
  if (!value || value.taskId !== taskId || value.requestId !== requestId) throw new PersonalError("telegram_receipt_missing", "IM 收件与执行记录不符，已停止；请保留档案并检查。");
  return value;
}

function active(config: PersonalTelegramConfig | PersonalQqConfig | undefined, value: Receipt) { return config?.enabled === true && config.generation === value.generation && config.botId === value.botId && config.ownerId === value.ownerId; }

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md
export function personalTelegram(config?: PersonalTelegramConfig, api?: PersonalTelegramApi, control?: (tx: Tx, value: TelegramControlInput) => Promise<boolean>, media?: PersonalMedia, qqConfig?: PersonalQqConfig, qqApi?: PersonalQqApi) {
  const telegramConfig = config;
  const task = defineTask<{ requestId: string }, { phase: "run" } | { phase: "send"; retryAt?: number } | { phase: "verify" }, Result>({
    name: TASK, version: 1, initial: () => ({ phase: "run" }),
    phases: {
      async run(current, runtime, context) {
        const value = await runtime.snapshot(PersonalTelegramReceiptDoc, current.input.requestId, context);
        if (!value?.receipt || value.receipt.taskId !== current.id) throw new PersonalError("telegram_receipt_missing", "IM 收件来源缺失，已停止；请检查档案。");
        let allowed = false;
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          allowed = active(personalEntryConfig(await tx.doc(PersonalTelegramDoc), value), value);
          if (!allowed) { value.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; }
          return undefined;
        }, context);
        if (!allowed) return;
        if (value.receipt.media && !media) throw new PersonalError("media_config_missing", "原图片处理模块不可用，未发送缺图请求；请恢复对应程序。");
        const currentMedia = value.receipt.media ? await media!.message(value.receipt.media.key) : undefined;
        if (value.receipt.media && !currentMedia) throw new PersonalError("image_reference_invalid", "原图片接收记录缺失，已停止；请保留档案。");
        if (value.receipt.mediaRejected || currentMedia && ["rejected", "expired"].includes(currentMedia.state) || value.receipt.media && !media!.supportsImages()) {
          const reason = currentMedia?.reason ?? "image_input_unsupported";
          if (value.receipt.media && currentMedia?.state === "ready") await media!.reject(value.receipt.media.key, reason);
          await runtime.commit(async tx => { const value = await receipt(tx, current.input.requestId, current.id); value.reply = personalMediaRejection(reason); value.mediaRejected = true; delete value.permission; value.delivery = "pending"; return { status: "running", checkpoint: { phase: "send" } }; }, context); return;
        }
        if (value.receipt.control) {
          await runtime.commit(async tx => { (await receipt(tx, current.input.requestId, current.id)).delivery = "pending"; return { status: "running", checkpoint: { phase: "send" } }; }, context);
          return;
        }
        const main = await runtime.conversation(ROOT_CONVERSATION_ID, context);
        if (!main) throw new PersonalError("telegram_main_missing", "IM 主会话缺失，已停止；请保留档案。");
        // 配置只在停机持锁时改变；跨 admission 的窗口始终重接同一平台消息键。
        const submission = await main.submit({ type: "input", content: value.receipt.media ? await media!.input(value.receipt.media.key) : value.receipt.content, requestId: current.input.requestId, whenBusy: "followUp" }, context);
        await runtime.commit(async tx => { const receipt = (await tx.doc(PersonalTelegramReceiptDoc, current.input.requestId, null)).receipt; if (!receipt || receipt.taskId !== current.id) throw new PersonalError("telegram_receipt_missing", "原收件记录缺失，请保留档案。"); receipt.submissionId = submission.id; if (receipt.media) await media!.bind(tx, receipt.media.key, submission.id); return undefined; }, context);
        const settled = await submission.wait(context);
        const entry = settled.status === "done" && settled.type === "input" ? await runtime.entry(AssistantEntry, settled.answer, context) : undefined;
        const message = entry?.model?.[0];
        if (settled.status === "done" && message?.role !== "assistant") throw new PersonalError("telegram_answer_missing", "IM 原输入的完整回答缺失，未发送；请保留档案。");
        const answer = message?.role === "assistant" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : undefined;
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          if (!active(personalEntryConfig(await tx.doc(PersonalTelegramDoc), value), value) || answer === undefined) {
            value.delivery = answer === undefined ? "unanswered" : "canceled";
            return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } };
          }
          const characters = Array.from(answer);
          value.reply = characters.length > 3900 ? characters.slice(0, 3900).join("") + "…（显示已截断，完整回答保留在个人会话中）" : answer || "本次回答没有文本内容，请从本机向导查看会话状态。";
          value.delivery = "pending";
          return { status: "running", checkpoint: { phase: "send" } };
        }, context);
      },
      async send(current, runtime, context) {
        if (current.state.checkpoint.retryAt) await runtime.sleep(current.state.checkpoint.retryAt, context);
        let target: Receipt | undefined;
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          if (!active(personalEntryConfig(await tx.doc(PersonalTelegramDoc), value), value)) { value.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; }
          if (value.delivery !== "pending" || !value.reply || !active(value.platform === "qq" ? qqConfig : config, value) || !(value.platform === "qq" ? qqApi : api)) throw new PersonalError("telegram_send_invalid", "IM 固定发送记录或入口无法核实，已停止；请保留档案。");
          value.delivery = "sending";
          target = { ...value };
          return { status: "running", checkpoint: { phase: "verify" } };
        }, context);
        if (!target) return;
        let platformMessageId: string | undefined;
        let failure: PersonalImApiError | undefined;
        try { platformMessageId = await (target.platform === "qq" ? qqApi! : api!).send(target.ownerId, target.messageId, target.reply!, runtime.signal); } catch (error) {
          if (!(error instanceof PersonalImApiError)) throw error;
          failure = error;
        }
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          if (failure?.retryAfterMs) {
            value.delivery = "pending";
            return { status: "running", checkpoint: { phase: "send", retryAt: runtime.now() + failure.retryAfterMs } };
          }
          value.delivery = platformMessageId ? "sent" : failure?.effect === "not_sent" ? "failed" : "effect_unknown";
          if (platformMessageId) value.platformMessageId = platformMessageId;
          return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } };
        }, context);
      },
      async verify(current, runtime, context) {
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          value.delivery = "effect_unknown";
          return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } };
        }, context);
      },
    },
    async abort(current, runtime, context) {
      await runtime.commit(async tx => {
        const value = await receipt(tx, current.input.requestId, current.id);
        value.delivery = value.delivery === "sending" ? "effect_unknown" : "canceled";
        return { status: "terminal", outcome: { status: "aborted", result: { delivery: value.delivery } } };
      }, context);
    },
  });
  const extension = defineExtension({ name: "personal-telegram", tasks: [task] });
  return { extension,
    api(harness: Harness) {
      let receiving = false;
      let online = false;
      const accept = async (message: Input | undefined, updateId: number, platform?: "qq", signal?: AbortSignal) => {
        const currentConfig = platform === "qq" ? qqConfig : telegramConfig;
        const key = message && currentConfig ? `${platform ?? "telegram"}:${currentConfig.botId}:${message.ownerId}:${message.id}` : undefined;
        const config = currentConfig;
        let staged: Awaited<ReturnType<PersonalMedia["stage"]>> | undefined;
        if (message?.media && message.ownerId === config?.ownerId && key) {
          if (!media) throw new PersonalError("media_config_missing", "图片处理模块不可用，收件未确认；请检查程序配置。");
          await harness.commit(async tx => {
            if (!config.enabled || !isDeepStrictEqual(personalEntryConfig(await tx.doc(PersonalTelegramDoc), { platform }), config)) throw new PersonalError("telegram_target_changed", "拥有者入口已变化，未接纳图片。");
          }, context);
          const prior = (await harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt;
          const priorMedia = await media.message(key);
          if (prior && prior.generation !== config.generation || priorMedia && priorMedia.source.generation !== config.generation) {
            await harness.commit(async tx => { const state = await tx.doc(PersonalTelegramDoc); state.rejected++; if (!platform) state.lastUpdateId = updateId; }, context); return;
          }
          staged = await media.stage({ key, source: { platform: platform ?? "telegram", accountId: config.botId, ownerId: config.ownerId, generation: config.generation }, body: message.text, media: message.media }, signal);
        }
        await harness.commit(async tx => {
          const state = await tx.doc(PersonalTelegramDoc);
          if (!config?.enabled || !isDeepStrictEqual(personalEntryConfig(state, { platform }), config)) throw new PersonalError("telegram_target_changed", "拥有者入口配置已失效，已停止收件；请检查当前配置。");
          if (!platform) state.lastUpdateId = updateId;
          if (!message || message.ownerId !== config.ownerId || !key) { state.rejected++; return; }
          const record = await tx.doc(PersonalTelegramReceiptDoc, key, null);
          if (record.receipt) {
            if (record.receipt.content !== message.text || !isDeepStrictEqual(record.receipt.media?.identities, message.media?.map(value => value.identity)) || (record.receipt.direct !== undefined && (record.receipt.direct !== message.direct || record.receipt.replyTo !== message.replyTo || record.receipt.replyBotId !== message.replyBotId))) throw new PersonalError("telegram_input_conflict", "同一平台消息的正文不符，已停止接收；请保留档案并检查。");
            return;
          }
          await personalPermissionFor(tx, { platform });
          const value: TelegramControlInput = { ...(platform ? { platform } : {}), requestId: key, generation: config.generation, botId: config.botId, ownerId: config.ownerId, messageId: message.id, updateId, content: message.text, direct: message.direct, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }), ...(message.replyBotId === undefined ? {} : { replyBotId: message.replyBotId }), delivery: "waiting" };
          if (staged) {
            value.media = { key, identities: staged.identities };
            if (staged.state === "rejected" || staged.state === "expired") { value.mediaRejected = true; value.reply = personalMediaRejection(staged.reason!); }
            else if (message.direct) { const permission = await personalPermissionFor(tx, { platform }); value.permission = { mode: permission.mode, version: permission.version }; }
          }
          else if (await telegramPermissionControl(tx, value) || await telegramWorkControl(tx, value) || await telegramDelegationControl(tx, value) || await control?.(tx, value)) value.control = true;
          else if (TELEGRAM_SERVICE_ACTIONS.includes(value.content)) { value.control = true; value.reply = "当前宿主未启用服务操作；请由拥有者核实服务配置，聊天仍可继续。"; }
          else if (message.direct) { const permission = await personalPermissionFor(tx, { platform }); value.permission = { mode: permission.mode, version: permission.version }; }
          value.accepted = staged?.accepted ?? (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: platform === "qq" ? "ruukoto.qq-received" : "ruukoto.telegram-received", data: { requestId: key, generation: config.generation } })).id;
          const taskId = await tx.createTask(task, { requestId: key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
          record.receipt = { ...value, taskId };
        }, context);
        harness.resume();
      };
      const receive = async (update: TelegramUpdate, signal?: AbortSignal) => {
        const message = telegramMessage(update);
        await accept(message && { ...message, media: message.media?.map(value => api!.photo(value)) }, update.update_id, undefined, signal);
      };
      let qqReceiving = false;
      const qq = {
        async receive(event: Record<string, unknown>, signal?: AbortSignal) {
          const parsed = qqConfig && Number(event.time) > qqConfig.boundary && String(event.message_id) !== qqConfig.boundaryMessageId ? qqMessage(event, qqConfig.botId) : undefined;
          await accept(parsed && { ...parsed, name: "QQ 拥有者", ...(parsed.replyTo === undefined ? {} : { replyBotId: qqConfig!.botId }), media: parsed.media?.map(value => qqApi ? qqApi.photo(value) : qqPhoto(value)) }, 0, "qq", signal);
        },
        async poll(signal: AbortSignal) {
          if (!qqApi || !qqConfig?.enabled) return;
          if (qqReceiving) throw new PersonalError("qq_poll_busy", "QQ 收件循环已启动，请使用当前后台连接。");
          qqReceiving = true;
          try { await qqApi.poll(event => qq.receive(event, signal), signal, async online => {
            await harness.commit(async tx => {
              const state = await tx.doc(PersonalTelegramDoc);
              if (!isDeepStrictEqual(state.qqConfig, qqConfig)) throw new PersonalError("qq_target_changed", "QQ 原绑定已变化，接收连接已停止；请核实配置。");
              if (state.qqConnection?.online === online) return;
              const at = Date.now();
              state.qqConnection = { online, at };
              if (!online) state.qqGap = { since: at };
              else if (state.qqGap && state.qqGap.until === undefined) state.qqGap.until = at;
              await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.qq-connection", data: { generation: qqConfig.generation, online, at } });
            }, context);
          }); } finally { qqReceiving = false; }
        },
        status: () => status("qq"),
      };
      const status = async (platform?: "qq") => harness.commit(async tx => {
        const state = await tx.doc(PersonalTelegramDoc);
        const page = await tx.scanTasks({ kind: TASK, order: "descending" }, 16);
        const recent = [];
        for (const current of page.items) {
          const key = current.input && typeof current.input === "object" && !Array.isArray(current.input) && current.input.requestId;
          if (typeof key !== "string") throw new PersonalError("telegram_receipt_missing", "IM 执行缺少收件引用，请保留档案。");
          const value = await receipt(tx, key, current.id);
          if (value.platform === platform) recent.push({ input: value.content.slice(0, 160), delivery: value.delivery });
        }
        return { enabled: personalEntryConfig(state, { platform })?.enabled ?? false, receiving: platform ? qqReceiving : receiving, online: platform ? qqApi?.online ?? false : online, rejected: state.rejected, ...(platform && state.qqGap ? { gap: { ...state.qqGap } } : {}), recent };
      }, context);
      return {
        receive, qq,
        async poll(signal: AbortSignal) {
          if (!api || !config?.enabled) return;
          if (receiving) throw new PersonalError("telegram_poll_busy", "Telegram 收件循环已启动，请使用当前后台连接。");
          receiving = true;
          let ack: TelegramAck | undefined;
          let backoff = 1000;
          try { while (!signal.aborted) {
            const offset = telegramOffset(ack);
            ack = undefined;
            try {
              const updates = await api.updates(signal, offset);
              online = true;
              const receivedAt = performance.now();
              for (const update of updates) { if (signal.aborted) return; await receive(update, signal); }
              if (updates.length) ack = { offset: updates[updates.length - 1].update_id + 1, receivedAt };
              backoff = 1000;
            } catch (error) {
              if (signal.aborted) return;
              online = false;
              if (!(error instanceof PersonalTelegramApiError)) throw error;
              process.stderr.write("[ruukoto:personal] Telegram 接收暂不可用，收件未确认，正在等待恢复；请检查入口状态。\n");
              await new Promise<void>(resolve => {
                const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
                const timer = setTimeout(done, error.retryAfterMs ?? backoff);
                signal.addEventListener("abort", done, { once: true });
              });
              backoff = Math.min(backoff * 2, 30_000);
            }
          } } finally { receiving = false; online = false; }
        },
        status: () => status(),
      };
    },
  };
}

export async function verifyPersonalTelegram(tx: Tx, keys: string[], config?: PersonalTelegramConfig, qqConfig?: PersonalQqConfig) {
  const state = await tx.doc(PersonalTelegramDoc);
  if (keys.some(key => key.startsWith("telegram:")) && !state.config) throw new PersonalError("telegram_receipt_invalid", "Telegram 收件缺少原绑定记录，已停止恢复；请保留档案。");
  if (state.config && !config) throw new PersonalError("telegram_config_missing", "档案的 Telegram 配置缺失，已停止恢复；请恢复配置或通过向导停用入口。");
  if (state.config && config?.generation === state.config.generation && !isDeepStrictEqual(config, state.config)) throw new PersonalError("telegram_config_changed", "Telegram 配置代次与内容不符，已停止恢复；请重新配对。");
  if (state.qqConfig) {
    parsePersonalQq(state.qqConfig);
    if (!qqConfig) throw new PersonalError("qq_config_missing", "原 QQ 配置缺失，已停止恢复；请恢复配置或通过向导停用入口。");
    if (state.qqConfig.generation === qqConfig.generation && !isDeepStrictEqual(state.qqConfig, qqConfig)) throw new PersonalError("qq_config_changed", "QQ 原代次与配置不符，请停止后台后重新配对。");
  }
  if (keys.some(key => key.startsWith("qq:")) && !state.qqConfig) throw new PersonalError("qq_receipt_invalid", "QQ 收件缺少原绑定，请保留档案。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
    const task = value && await tx.task(value.taskId);
    if (!value || value.platform !== undefined && value.platform !== "qq" || value.requestId !== key || key !== `${value.platform ?? "telegram"}:${value.botId}:${value.ownerId}:${value.messageId}` || !task || task.kind !== TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.requestId !== key) throw new PersonalError("telegram_receipt_invalid", "IM 来源与执行关系无法核实，已停止恢复；请保留档案。");
    if ((value.permission && (!value.direct || value.control || !["auto-review", "confirm", "full_access"].includes(value.permission.mode) || !Number.isSafeInteger(value.permission.version) || value.permission.version < 1)) || (value.control && (!value.reply || value.permission || value.submissionId !== undefined)) || (value.selection && !value.control)) throw new PersonalError("telegram_receipt_invalid", "IM 输入权限或宿主控制归属不符，已停止恢复；请保留档案。");
    const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, key);
    if (value.submissionId !== undefined && (submission?.id !== value.submissionId || submission.type !== "input")) throw new PersonalError("telegram_receipt_invalid", "IM 原提交记录缺失，已停止恢复；请保留档案。");
    if (value.delivery === "sending" && task.state.status === "terminal") value.delivery = "effect_unknown";
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: TASK }, 256, cursor);
    for (const task of page.items) {
      const key = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
      if (typeof key !== "string" || !keys.includes(key) || (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt?.taskId !== task.id) throw new PersonalError("telegram_receipt_invalid", "IM 执行缺少原收件事实，已停止恢复；请保留档案。");
    }
    cursor = page.next;
  } while (cursor);
  if (config) state.config = { ...config };
  if (qqConfig) {
    if (state.qqConfig && state.qqConfig.generation !== qqConfig.generation) {
      const permission = await tx.doc(PersonalPermissionsDoc);
      if (permission.qq) { permission.qq.mode = "auto-review"; permission.qq.version++; }
    }
    state.qqConfig = { ...qqConfig };
  }
}
