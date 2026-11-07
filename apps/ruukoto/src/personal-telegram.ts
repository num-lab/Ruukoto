import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type EntryRecord, type Harness, type TaskId, type Tx, type UserInput } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { personalTelegramApi, PersonalTelegramApiError, telegramOffset, telegramMessage, telegramCallback, telegramCallbackQueryId, telegramCallbackIdentity, type PersonalTelegramApi, type TelegramAck, type TelegramUpdate, type TelegramText } from "./personal-telegram-api.ts";
import { personalEntryConfig, samePersonalEntry, PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramReceipt as Receipt, type TelegramResult as Result, type TelegramControlInput } from "./personal-telegram-records.ts";
import { telegramPermissionControl, personalPermissionFor, PersonalPermissionsDoc, TELEGRAM_SERVICE_ACTIONS } from "./personal-permissions.ts";
import { telegramWorkControl, telegramDelegationControl } from "./personal-work-controls.ts";
import { PERSONAL_MAIN_TOOL_ROUNDS, PersonalCoordinationDoc, personalCoordinationCutoffText, personalCoordinationRounds, type PersonalCoordinationCutoff, type PersonalMainAdmission } from "./personal-coordination.ts";
import { personalWorkHandoff } from "./personal-work-tools.ts";
export { PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "./personal-telegram-records.ts";
import { personalMediaRejection, PersonalMediaMessageDoc, verifyPersonalMediaAdmission, type PersonalMedia, type PersonalMediaDownload } from "./personal-media.ts";
import { parsePersonalTelegram, telegramToken, type PersonalTelegramConfig } from "./personal-telegram-config.ts";

import { personalQqApi, qqMessage, qqPhoto, type PersonalQqApi } from "./personal-qq-api.ts";
import { parsePersonalQq, qqToken, type PersonalQqConfig } from "./personal-qq-config.ts";
import { PersonalImApiError, type PersonalImSender } from "./personal-im-api.ts";
import type { PersonalEntryIdentity } from "./personal-telegram-records.ts";
import { personalImDeliveryRecord, personalImDeliveryTextReceipt, settlePersonalImDelivery, requestPersonalImDelivery, type personalImDelivery } from "./personal-im-delivery.ts";
import { PersonalTelegramTokenDoc, PersonalTelegramDisplayDoc } from "./personal-telegram-display-records.ts";
import { personalTelegramReceiptDisplay, preparePersonalTelegramReceiptDisplay, validatePersonalTelegramDisplayAction } from "./personal-telegram-displays.ts";
import { telegramSelection, telegramSourceActive } from "./personal-permissions.ts";
import type { TelegramSelection } from "./personal-telegram-records.ts";
import { personalTelegramResultControl, verifyPersonalTelegramResultControl } from "./personal-telegram-results.ts";
import { personalTelegramCallbacks, PersonalTelegramCallbackDoc } from "./personal-telegram-callbacks.ts";
import { personalImControlAccepted } from "./personal-recovery-claims.ts";
import { personalTelegramCuaImageControl, verifyPersonalTelegramCuaImages } from "./personal-telegram-cua-images.ts";
import { personalTelegramAttachments, personalTelegramAttachmentBody, verifyPersonalTelegramAttachments, verifyPersonalTelegramAttachmentReceipt, type PersonalTelegramAttachmentGroup } from "./personal-telegram-attachments.ts";

type Input = Omit<TelegramText, "media"> & { media?: PersonalMediaDownload[] };
const context = BACKGROUND_CONTEXT;
const TASK = "ruukoto.telegram-input";

async function receipt(tx: Tx, requestId: string, taskId: TaskId) {
  const value = (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt;
  if (!value || value.taskId !== taskId || value.requestId !== requestId) throw new PersonalError("telegram_receipt_missing", "IM 收件与执行记录不符，已停止；请保留档案并检查。");
  return value;
}

function active(config: PersonalTelegramConfig | PersonalQqConfig | undefined, value: Receipt) { return config?.enabled === true && config.generation === value.generation && config.botId === value.botId && config.ownerId === value.ownerId; }

const approveWords = new Set(["好", "好的", "可以", "行", "同意", "确认", "ok", "OK"]), rejectWords = new Set(["不", "不要", "不行", "先别", "拒绝", "算了", "取消"]);
export function personalTelegramApprovalAction(selection: TelegramSelection | undefined, text: string): string | undefined {
  const words = text.trim(), approve = approveWords.has(words) || words === "1", reject = rejectWords.has(words) || words === "2";
  if (!approve && !reject) return;
  if (selection?.kind === "tool") return approve ? "工具批准本次" : "工具拒绝";
  if (selection?.kind === "mcp") return approve ? "MCP批准本次" : "MCP拒绝";
  if (selection?.kind === "app-data") return approve ? "数据批准本次" : "数据拒绝";
  if (selection?.kind === "approval") return approve ? "批准本次" : "拒绝";
}

async function approvalReplyAction(tx: Tx, selected: Awaited<ReturnType<typeof telegramSelection>>, text: string) {
  const action = personalTelegramApprovalAction(selected?.selection, text);
  if (!action || !selected) return;
  const display = (await tx.doc(PersonalTelegramDisplayDoc, selected.requestId, null)).display, words = text.trim();
  if (display?.buttons.some(button => button.action === action) && (approveWords.has(words) || rejectWords.has(words) || display.text.includes(`\n${words}.`))) return action;
}

// Note: See .agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md
// Note: See .agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md
// Note: See .agents/notes/implemented/architecture/2026-11-07-personal-inbound-attachments.md
export function personalTelegram(config?: PersonalTelegramConfig, api?: PersonalTelegramApi, control?: (tx: Tx, value: TelegramControlInput) => Promise<boolean>, media?: PersonalMedia, qqConfig?: PersonalQqConfig, qqApi?: PersonalQqApi, scheduledControl?: (tx: Tx, value: TelegramControlInput) => Promise<boolean>, isSuspended: (platform: "telegram" | "qq") => boolean = () => false, admitInput?: PersonalMainAdmission, cuaControl?: (tx: Tx, value: TelegramControlInput, selected: Awaited<ReturnType<typeof telegramSelection>>) => Promise<boolean>) {
  const locks = new Map<string, Promise<void>>(), switching = new Set<string>(), sends = new Map<PersonalQqApi, number>(), retired = new Set<PersonalQqApi>();
  const sending = new Set<Promise<unknown>>(), versions = new Map<string, string>();
  let delivery: ReturnType<typeof personalImDelivery> | undefined;
  const configurationVersion = (source: { platform?: "qq" }) => versions.get(source.platform ?? "telegram");
  async function closeRetired(connection: PersonalQqApi) {
    try { await connection.close(); retired.delete(connection); }
    catch { process.stderr.write("[ruukoto:personal] QQ 旧连接未能关闭，原发送结果保留；请查询入口，后台关闭时再次清理。\n"); }
  }
  async function withEntry<T>(source: { platform?: "qq" }, action: () => Promise<T>): Promise<T> {
    const platform = source.platform ?? "telegram", previous = locks.get(platform) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), next = previous.then(() => held);
    locks.set(platform, next); await previous;
    try { return await action(); } finally { release(); if (locks.get(platform) === next) locks.delete(platform); }
  }
  function isActive(source: PersonalEntryIdentity): boolean {
    const platform = source.platform ?? "telegram", selected = source.platform === "qq" ? qqConfig : config;
    return !switching.has(platform) && !isSuspended(platform) && selected?.enabled === true && selected.generation === source.generation && selected.botId === source.botId && selected.ownerId === source.ownerId;
  }
  function sender(source: PersonalEntryIdentity): PersonalImSender | undefined {
    const selectedApi = source.platform === "qq" ? qqApi : api;
    if (!isActive(source) || !selectedApi) return;
    const connection = source.platform === "qq" ? qqApi : undefined;
    const owner = source.ownerId;
    if (connection) sends.set(connection, (sends.get(connection) ?? 0) + 1);
    async function tracked(pending: Promise<string>) {
      sending.add(pending);
      try { return await pending; } finally {
        sending.delete(pending);
        if (connection) { const count = sends.get(connection)! - 1; if (count) sends.set(connection, count); else { sends.delete(connection); if (retired.has(connection)) await closeRetired(connection); } }
      }
    }
    return { send: (ownerId, messageId, text, signal, keyboard) => tracked(ownerId === owner ? source.platform === "qq" ? selectedApi.send(ownerId, messageId, text, signal) : (selectedApi as PersonalTelegramApi).send(ownerId, messageId, text, signal, keyboard) : Promise.reject(new PersonalImApiError("im_target_changed", "发送目标与原入口不符，未发送；请查询原发送记录。", "not_sent"))), ...(source.platform === undefined ? { document: (ownerId: string, messageId: number, file: import("./personal-im-api.ts").PersonalImDocument, signal: AbortSignal) => tracked(ownerId === owner ? (selectedApi as PersonalTelegramApi).document(ownerId, messageId, file, signal) : Promise.reject(new PersonalImApiError("im_target_changed", "发送目标与原入口不符，未发送。", "not_sent"))) } : {}) };
  }
  let admitAttachmentGroup: ((group: PersonalTelegramAttachmentGroup, signal: AbortSignal) => Promise<void>) | undefined;
  const attachments = personalTelegramAttachments({ withEntry, sender, configurationVersion, isActive }, (group, signal) => {
    if (!admitAttachmentGroup) throw new PersonalError("telegram_attachment_unavailable", "附件接收入口正在恢复，请保留原消息并查询附件。");
    return admitAttachmentGroup(group, signal);
  });
  const task = defineTask<{ requestId: string }, { phase: "run" } | { phase: "send"; retryAt?: number } | { phase: "verify" } | { phase: "deliver" }, Result>({
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
        if (value.receipt.mediaRejected || currentMedia && ["rejected", "expired"].includes(currentMedia.state) || currentMedia && !media!.canProcess(currentMedia)) {
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
        let content: UserInput;
        try { content = value.receipt.media ? await media!.input(value.receipt.media.key) : value.receipt.content; }
        catch (error) {
          if (!(error instanceof PersonalError) || error.code !== "artifact_unavailable" || !value.receipt.media) throw error;
          await runtime.commit(async tx => {
            const value = await receipt(tx, current.input.requestId, current.id), message = (await tx.doc(PersonalMediaMessageDoc, current.input.requestId, null)).message;
            // A lost original is a whole-input rejection only before any native admission; existing
            // submissions retain their original association and failure rather than being replayed.
            if (!message || message.key !== current.input.requestId || message.state !== "ready" || value.submissionId !== undefined || await tx.submissionByRequest(ROOT_CONVERSATION_ID, current.input.requestId)) throw error;
            await verifyPersonalMediaAdmission(tx, message);
            message.state = "rejected"; message.reason = "download_failed";
            value.reply = personalMediaRejection(message.reason); value.mediaRejected = true; delete value.permission; value.delivery = "pending";
            return { status: "running", checkpoint: { phase: "send" } };
          }, context);
          return;
        }
        const submission = await withEntry(value.receipt, async () => {
          let permitted = false;
          await runtime.commit(async tx => { const value = await receipt(tx, current.input.requestId, current.id); permitted = !!await tx.submissionByRequest(ROOT_CONVERSATION_ID, current.input.requestId) || isActive(value) && active(personalEntryConfig(await tx.doc(PersonalTelegramDoc), value), value); if (!permitted) { value.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; } return undefined; }, context);
          if (!permitted) return;
          // Admission itself carries the registration barrier in-commit — nothing waits here, so
          // the entry mutex stays available to same-channel controls while a cutoff is unfinished.
          const submission = await (admitInput ?? main.submit.bind(main))({ type: "input", content, requestId: current.input.requestId, whenBusy: "followUp" }, context);
          await runtime.commit(async tx => { const receipt = (await tx.doc(PersonalTelegramReceiptDoc, current.input.requestId, null)).receipt; if (!receipt || receipt.taskId !== current.id) throw new PersonalError("telegram_receipt_missing", "原收件记录缺失，请保留档案。"); receipt.submissionId = submission.id; if (receipt.media) await media!.bind(tx, receipt.media.key, submission.id); return undefined; }, context);
          return submission;
        });
        if (!submission) return;
        const settled = await submission.wait(context);
        const entry = settled.status === "done" && settled.type === "input" ? await runtime.entry(AssistantEntry, settled.answer, context) : undefined;
        const message = entry?.model?.[0];
        if (settled.status === "done" && message?.role !== "assistant") throw new PersonalError("telegram_answer_missing", "IM 原输入的完整回答缺失，未发送；请保留档案。");
        const answer = message?.role === "assistant" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : undefined;
        // A coordination-cutoff intent commits independently of the settle: a run fence-faulted at
        // request prepare can go unanswered before the evaluator writes intent. An input whose
        // persisted batch count is over budget always has that intent pending — the coordinator owns
        // landing it through retries, dirty re-evaluations and the reopen sweep — so the receipt
        // waits on the durable fact, never a wall-clock window. Inputs unanswered for any other
        // reason still end unanswered.
        let cutoff: PersonalCoordinationCutoff | undefined;
        if (answer === undefined) for (;;) {
          const doc = await runtime.snapshot(PersonalCoordinationDoc, current.input.requestId, context);
          if (doc?.cutoff) { cutoff = doc.cutoff; break; }
          const source = (await runtime.snapshot(PersonalTelegramReceiptDoc, current.input.requestId, context))?.receipt;
          if (source?.submissionId !== undefined) {
            const fallback = await runtime.snapshot(PersonalCoordinationDoc, `submission:${source.submissionId}`, context);
            if (fallback?.cutoff) { cutoff = fallback.cutoff; break; }
          }
          let pending = false;
          await runtime.commit(async tx => {
            const record = await tx.submissionByRequest(ROOT_CONVERSATION_ID, current.input.requestId);
            pending = record?.entry !== undefined && await personalCoordinationRounds(tx, ROOT_CONVERSATION_ID, record.entry) > PERSONAL_MAIN_TOOL_ROUNDS;
            return undefined;
          }, context);
          if (!pending) break;
          await runtime.sleep(runtime.now() + 50, context);
        }
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          if (!active(personalEntryConfig(await tx.doc(PersonalTelegramDoc), value), value) || answer === undefined && cutoff === undefined) {
            value.delivery = answer === undefined ? "unanswered" : "canceled";
            return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } };
          }
          // A call-bearing answer may be a host yield even when the model wrote text first; the
          // persisted handoff reports committed facts rather than trusting the pre-call prose.
          const handoff = message?.role === "assistant" && Array.isArray(message.content) && message.content.some(part => part.type === "toolCall") && settled.answer !== undefined ? await personalWorkHandoff(tx, settled.answer, value.platform === "qq" ? 3900 : undefined, value.platform === undefined) : undefined;
          const final = handoff ?? (answer || (cutoff ? personalCoordinationCutoffText(cutoff) : undefined) || "本次回答没有文本内容，请从本机向导查看会话状态。");
          const characters = Array.from(final);
          value.reply = value.platform === "qq" && characters.length > 3900 ? characters.slice(0, 3900).join("") + "…（显示已截断，完整回答保留在个人会话中）" : final;
          if (value.platform === undefined) value.replyFormat = "complete";
          value.delivery = "pending";
          return { status: "running", checkpoint: { phase: "send" } };
        }, context);
      },
      async send(current, runtime, context) {
        if (current.state.checkpoint.retryAt) await runtime.sleep(current.state.checkpoint.retryAt, context);
        let target: Receipt | undefined;
        let fixed: PersonalImSender | undefined;
        const source = (await runtime.snapshot(PersonalTelegramReceiptDoc, current.input.requestId, context))?.receipt;
        if (!source) throw new PersonalError("telegram_receipt_missing", "IM 原发送来源缺失，请保留档案。");
        if (source.platform === undefined && delivery) {
          await withEntry(source, async () => runtime.commit(async tx => {
            const value = await receipt(tx, current.input.requestId, current.id);
            if (!value.multipart) {
              if (!isActive(value) || !await telegramSourceActive(tx, value)) { value.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; }
              if (value.delivery !== "pending" || !value.reply) throw new PersonalError("telegram_send_invalid", "原回复无法核实，请查询原会话。");
              const version = configurationVersion(value); if (version) value.configurationVersion = version;
              let text = value.reply;
              if (!value.replyFormat && value.submissionId !== undefined) {
                const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, value.requestId), answer = submission?.answer && await tx.entry(AssistantEntry, submission.answer), message = answer?.model?.[0];
                if (message?.role !== "assistant") throw new PersonalError("telegram_answer_missing", "原回答缺失，请保留档案。");
                text = await personalWorkHandoff(tx, submission!.answer!, undefined, true) ?? message.content.filter(part => part.type === "text").map(part => part.text).join("");
              }
              value.multipart = value.display ? (await tx.doc(PersonalTelegramDisplayDoc, value.display, null)).display!.delivery : await requestPersonalImDelivery(tx, { key: `telegram-reply:${value.requestId}`, source: { botId: value.botId, ownerId: value.ownerId, generation: value.generation }, messageId: value.messageId, text }, current.id);
            }
            value.delivery = "sending";
            return { status: "running", checkpoint: { phase: "deliver" } };
          }, context));
          return;
        }
        await withEntry(source, async () => {
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          if (!isActive(value) || !active(personalEntryConfig(await tx.doc(PersonalTelegramDoc), value), value)) { value.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; }
          if (value.delivery !== "pending" || !value.reply || !active(value.platform === "qq" ? qqConfig : config, value)) throw new PersonalError("telegram_send_invalid", "IM 固定发送记录或入口无法核实，已停止；请保留档案。");
          if (!(value.platform === "qq" ? qqApi : api)) { value.delivery = "failed"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; }
          value.delivery = "sending";
          const version = configurationVersion(value); if (version) value.configurationVersion = version;
          target = { ...value };
          return { status: "running", checkpoint: { phase: "verify" } };
        }, context);
        if (target) fixed = sender(target);
        });
        if (!target) return;
        let platformMessageId: string | undefined;
        let failure: PersonalImApiError | undefined;
        try { if (!fixed) throw new PersonalImApiError("im_target_inactive", "原入口已暂停或失效，未发送；请查询原发送记录。", "not_sent"); platformMessageId = await fixed.send(target.ownerId, target.messageId, target.reply!, runtime.signal); } catch (error) {
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
      async deliver(current, runtime, context) {
        const saved = (await runtime.snapshot(PersonalTelegramReceiptDoc, current.input.requestId, context))!.receipt!;
        if (!saved.multipart || !delivery) throw new PersonalError("telegram_send_invalid", "原分段发送模块缺失，请恢复原程序。");
        await runtime.waitForTask(saved.multipart.taskId, context);
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id), result = await personalImDeliveryTextReceipt(tx, value.multipart!);
          if (result.state === "pending" || result.state === "sending" || result.state === "none") throw new PersonalError("telegram_send_invalid", "原发送尚未完成，请查询原记录。");
          value.delivery = result.state;
          if (result.platformMessageId) value.platformMessageId = result.platformMessageId;
          return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } };
        }, context);
      },
    },
    async abort(current, runtime, context) {
      const saved = (await runtime.snapshot(PersonalTelegramReceiptDoc, current.input.requestId, context))?.receipt;
      if (saved?.multipart && delivery) await delivery.abort(saved.multipart);
      await runtime.commit(async tx => {
        const value = await receipt(tx, current.input.requestId, current.id);
        if (value.multipart) {
          const result = await personalImDeliveryTextReceipt(tx, value.multipart);
          value.delivery = result.state === "pending" || result.state === "none" ? "canceled" : result.state === "sending" ? "effect_unknown" : result.state;
          if (result.platformMessageId) value.platformMessageId = result.platformMessageId;
        } else value.delivery = value.delivery === "sending" ? "effect_unknown" : "canceled";
        return { status: "terminal", outcome: { status: "aborted", result: { delivery: value.delivery } } };
      }, context);
    },
  });
  const callbacks = personalTelegramCallbacks({ withEntry, sender, configurationVersion, isActive }, source => source.platform === undefined && isActive(source) ? api : undefined);
  const extension = defineExtension({ name: "personal-telegram", tasks: [task, ...attachments.tasks] });
  return { extension, callbacks, withEntry, sender, configurationVersion, isActive, get delivery() { return delivery; }, setDelivery(value: ReturnType<typeof personalImDelivery>) { delivery = value; }, transport(source: PersonalEntryIdentity) { return source.platform === undefined && isActive(source) ? api : undefined; }, setVersion: (platform: "telegram" | "qq", version: string) => { versions.set(platform, version); },
    api(harness: Harness) {
      let receiving = false;
      let online = false;
      const parents = new Map<string, AbortSignal>(), pollStops = new Map<string, AbortController>(), loops = new Map<string, Promise<void>>(), receivePaused = new Set<string>();
      let closed = false;
      const presenceStop = new AbortController();
      let presenceTimer: NodeJS.Timeout | undefined, presencePending: Promise<void> | undefined;
      async function pulse() {
        if (closed || presencePending || !config?.enabled || !api || !isActive(config)) return;
        const source: PersonalEntryIdentity = { botId: config.botId, ownerId: config.ownerId, generation: config.generation }, transport = api;
        presencePending = (async () => {
          const pending = await harness.commit(async tx => {
            let cursor: Cursor | undefined;
            do { const page = await tx.scanTasks({ kind: TASK }, 64, cursor); for (const task of page.items) { if (task.state.status === "terminal" || task.abortRequested || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || typeof task.input.requestId !== "string") continue; const receipt = (await tx.doc(PersonalTelegramReceiptDoc, task.input.requestId, null)).receipt; if (receipt && !receipt.control && active(config, receipt) && !["sent", "failed", "effect_unknown", "canceled", "unanswered"].includes(receipt.delivery)) return true; } cursor = page.next; } while (cursor);
            return false;
          }, context);
          if (!pending) return;
          let permitted = false;
          await withEntry(source, async () => { permitted = isActive(source); });
          if (permitted) await transport.typing(source.ownerId, presenceStop.signal);
        })().catch(() => { /* Presence is advisory; its failure cannot change accepted work or delivery. */ }).finally(() => { presencePending = undefined; });
        await presencePending;
      }
      presenceTimer = setInterval(() => { void pulse(); }, 4000); presenceTimer.unref();
      async function handleControl(tx: Tx, value: TelegramControlInput, prior: Awaited<ReturnType<typeof telegramSelection>>) {
        if (await attachments.control(tx, value, prior)) return true;
        const normalized = value.platform === undefined && value.direct ? await approvalReplyAction(tx, prior, value.content) : undefined;
        if (normalized) { value.rawContent = value.content; value.content = normalized; }
        if (value.platform === undefined && !value.rawContent && (approveWords.has(value.content.trim()) || rejectWords.has(value.content.trim())) && !prior?.selection?.kind.startsWith("question-")) return false;
        if (await personalTelegramResultControl(tx, value, prior)) return true;
        if (value.callback) {
          if (!await validatePersonalTelegramDisplayAction(tx, value)) {
            value.reply = "这张卡片已处理或失效，请查询原操作或重新显示。";
            return true;
          }
        }
        if (await personalTelegramCuaImageControl(tx, value, prior)) return true;
        if (await cuaControl?.(tx, value, prior)) return true;
        return !!(await scheduledControl?.(tx, value) || await telegramPermissionControl(tx, value) || await telegramWorkControl(tx, value) || await telegramDelegationControl(tx, value) || await control?.(tx, value));
      }
      const accept = async (message: Input | undefined, updateId: number, platform?: "qq", signal?: AbortSignal, expected?: PersonalTelegramConfig | PersonalQqConfig, attachmentGroup?: NonNullable<Receipt["attachmentGroup"]>) => {
        const currentConfig = expected ?? (platform === "qq" ? qqConfig : config);
        const key = message && currentConfig ? `${platform ?? "telegram"}:${currentConfig.botId}:${message.ownerId}:${message.id}` : undefined;
        const acceptedConfig = currentConfig;
        let staged: Awaited<ReturnType<PersonalMedia["stage"]>> | undefined;
        if (!platform && message && acceptedConfig && key) {
          const allowed = await harness.commit(tx => attachments.accepts(tx, { botId: acceptedConfig.botId, ownerId: acceptedConfig.ownerId, generation: acceptedConfig.generation }, message.id, attachmentGroup), context);
          if (!allowed) { await harness.commit(async tx => { const state = await tx.doc(PersonalTelegramDoc); state.rejected++; state.lastUpdateId = updateId; }, context); return; }
        }
        if (message?.media && message.ownerId === acceptedConfig?.ownerId && key) {
          if (!media) throw new PersonalError("media_config_missing", "图片处理模块不可用，收件未确认；请检查程序配置。");
          await harness.commit(async tx => {
            if (!acceptedConfig.enabled || !isDeepStrictEqual(personalEntryConfig(await tx.doc(PersonalTelegramDoc), { platform }), acceptedConfig)) throw new PersonalError("telegram_target_changed", "拥有者入口已变化，未接纳图片。");
          }, context);
          const prior = (await harness.snapshot(PersonalTelegramReceiptDoc, key, context))?.receipt;
          const priorMedia = await media.message(key);
          if (prior && prior.generation !== acceptedConfig.generation || priorMedia && priorMedia.source.generation !== acceptedConfig.generation) {
            await harness.commit(async tx => { const state = await tx.doc(PersonalTelegramDoc); state.rejected++; if (!platform) state.lastUpdateId = updateId; }, context); return;
          }
          staged = await media.stage({ key, source: { platform: platform ?? "telegram", accountId: acceptedConfig.botId, ownerId: acceptedConfig.ownerId, generation: acceptedConfig.generation }, body: message.text, media: message.media }, signal);
        }
        await withEntry({ platform }, async () => {
        await harness.commit(async tx => {
          const state = await tx.doc(PersonalTelegramDoc);
          if (switching.has(platform ?? "telegram") || receivePaused.has(platform ?? "telegram") || isSuspended(platform ?? "telegram") || !acceptedConfig?.enabled || !isDeepStrictEqual(personalEntryConfig(state, { platform }), acceptedConfig)) throw new PersonalError("telegram_target_changed", "拥有者入口配置已失效，已停止收件；请检查当前配置。");
          if (!platform) state.lastUpdateId = updateId;
          if (!message || message.ownerId !== acceptedConfig.ownerId || !key) { state.rejected++; return; }
          if (!platform && !await attachments.accepts(tx, { botId: acceptedConfig.botId, ownerId: acceptedConfig.ownerId, generation: acceptedConfig.generation }, message.id, attachmentGroup)) { state.rejected++; return; }
          const record = await tx.doc(PersonalTelegramReceiptDoc, key, null);
          if (record.receipt) {
            if (record.receipt.generation !== acceptedConfig.generation) { state.rejected++; return; }
            if ((record.receipt.rawContent ?? record.receipt.content) !== message.text || !isDeepStrictEqual(record.receipt.media?.identities, message.media?.map(value => value.identity)) || !isDeepStrictEqual(record.receipt.attachmentGroup, attachmentGroup) || (record.receipt.direct !== undefined && (record.receipt.direct !== message.direct || record.receipt.replyTo !== message.replyTo || record.receipt.replyBotId !== message.replyBotId))) throw new PersonalError("telegram_input_conflict", "同一平台消息的正文不符，已停止接收；请保留档案并检查。");
            return;
          }
          await personalPermissionFor(tx, { platform });
          const value: TelegramControlInput = { ...(platform ? { platform } : {}), requestId: key, generation: acceptedConfig.generation, botId: acceptedConfig.botId, ownerId: acceptedConfig.ownerId, messageId: message.id, updateId, content: message.text, direct: message.direct, ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }), ...(message.replyBotId === undefined ? {} : { replyBotId: message.replyBotId }), delivery: "waiting" };
          if (attachmentGroup) value.attachmentGroup = { ...attachmentGroup };
          const prior = !staged ? await telegramSelection(tx, value) : undefined, prepared = !platform && !staged ? await preparePersonalTelegramReceiptDisplay(tx, value, prior) : undefined;
          if (staged) {
            value.media = { key, identities: staged.identities };
            if (staged.state === "rejected" || staged.state === "expired") { value.mediaRejected = true; value.reply = personalMediaRejection(staged.reason!); }
            else if (message.direct) { const permission = await personalPermissionFor(tx, { platform }); value.permission = { mode: permission.mode, version: permission.version }; }
          }
          else if (await handleControl(tx, value, prior)) value.control = true;
          else if (TELEGRAM_SERVICE_ACTIONS.includes(value.content) && (platform === "qq" || !approveWords.has(value.content.trim()) && !rejectWords.has(value.content.trim()))) { value.control = true; value.reply = "当前宿主未启用服务操作；请由拥有者核实服务配置，聊天仍可继续。"; }
          else if (message.direct) { const permission = await personalPermissionFor(tx, { platform }); value.permission = { mode: permission.mode, version: permission.version }; }
          value.accepted = staged?.accepted ?? (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: platform === "qq" ? "ruukoto.qq-received" : "ruukoto.telegram-received", data: { requestId: key, generation: acceptedConfig.generation } })).id;
          if (!platform && value.control && !value.multipart) { const display = await personalTelegramReceiptDisplay(tx, value, prepared!); if (display) value.multipart = display; }
          const taskId = await tx.createTask(task, { requestId: key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
          record.receipt = { ...value, taskId };
        }, context);
        });
        harness.resume();
        void pulse();
      };
      admitAttachmentGroup = async (group, signal) => {
        if (!isActive(group.source) || !config || !api || !group.choice) throw new PersonalError("telegram_target_changed", "原附件入口已变化，本条消息未接纳。请从当前入口重新发送。");
        const selectedConfig = config, transport = api, first = group.members[0];
        const message: Input = { ...first.message, text: personalTelegramAttachmentBody(group), direct: group.members.every(member => member.message.direct), media: group.members.flatMap(member => member.message.media!.map(file => transport.photo(file))) };
        await accept(message, first.updateId, undefined, signal, selectedConfig, { key: group.key, revision: group.revision, choice: group.choice.entry });
      };
      const receiveTelegram = async (update: TelegramUpdate, selected: PersonalTelegramConfig | undefined, selectedApi: PersonalTelegramApi | undefined, signal?: AbortSignal) => {
        if (update.callback_query !== undefined) {
          const callback = telegramCallback(update), queryId = telegramCallbackQueryId(update);
          if (queryId && selected?.enabled && selectedApi) {
            const key = `telegram-callback:${selected.botId}:${queryId}`, fingerprint = createHash("sha256").update(JSON.stringify(telegramCallbackIdentity(update))).digest("hex");
            await withEntry({}, () => harness.commit(async tx => {
              const state = await tx.doc(PersonalTelegramDoc);
              if (!isActive(selected) || !isDeepStrictEqual(state.config, selected)) throw new PersonalError("telegram_target_changed", "原 Telegram 入口已变化，未处理按钮。");
              state.lastUpdateId = update.update_id;
              if (await callbacks.lookup(tx, key, fingerprint)) return;
              const reject = async (reason: string) => {
                state.rejected++;
                const origin = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.telegram-callback-rejected", data: { requestId: key, generation: selected.generation, queryId, fingerprint, reason } })).id;
                await callbacks.request(tx, { key, source: { botId: selected.botId, ownerId: selected.ownerId, generation: selected.generation }, queryId, fingerprint, origin });
              };
              if (!callback || callback.ownerId !== selected.ownerId || callback.chatId !== selected.ownerId || callback.botId !== selected.botId) { await reject("telegram_callback_context_invalid"); return; }
              const token = await tx.doc(PersonalTelegramTokenDoc, callback.data, null);
              if (!token.display || !token.action) { await reject("telegram_callback_token_invalid"); return; }
              const value: TelegramControlInput = { requestId: key, generation: selected.generation, botId: selected.botId, ownerId: selected.ownerId, messageId: callback.messageId, updateId: update.update_id, content: token.action, direct: true, replyTo: callback.messageId, replyBotId: selected.botId, callback: { queryId: callback.queryId, token: callback.data, display: token.display }, delivery: "waiting", control: true };
              const prior = await telegramSelection(tx, value);
              if (!prior) { await reject("telegram_callback_display_invalid"); return; }
              const record = await tx.doc(PersonalTelegramReceiptDoc, key, null);
              if (record.receipt) throw new PersonalError("telegram_receipt_invalid", "原按钮收件缺少应答记录，请保留档案。");
              const prepared = await preparePersonalTelegramReceiptDisplay(tx, value, prior);
              if (!await validatePersonalTelegramDisplayAction(tx, value)) value.reply = "这张卡片已处理或失效，请查询原操作或重新显示。";
              else if (!await handleControl(tx, value, prior)) value.reply = "这项选择已失效，请重新显示原卡片。";
              value.accepted = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.telegram-callback", data: { requestId: key, generation: value.generation, ...value.callback } })).id;
              if (!value.multipart) { const display = await personalTelegramReceiptDisplay(tx, value, prepared); if (display) value.multipart = display; }
              record.receipt = { ...value, taskId: await tx.createTask(task, { requestId: key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) };
              await callbacks.request(tx, { key, source: { botId: selected.botId, ownerId: selected.ownerId, generation: selected.generation }, queryId, fingerprint, origin: value.accepted });
            }, context));
            harness.resume();
          } else await withEntry({}, () => harness.commit(async tx => { const state = await tx.doc(PersonalTelegramDoc); state.rejected++; state.lastUpdateId = update.update_id; }, context));
          return;
        }
        const message = telegramMessage(update);
        if (message?.mediaGroupId && message.media && message.ownerId === selected?.ownerId) {
          await withEntry({}, () => harness.commit(async tx => {
            const state = await tx.doc(PersonalTelegramDoc);
            if (!selected.enabled || !isActive(selected) || !isDeepStrictEqual(state.config, selected)) throw new PersonalError("telegram_target_changed", "原附件入口已变化，本条消息未接纳。");
            state.lastUpdateId = update.update_id;
            if (!await attachments.collect(tx, { botId: selected.botId, ownerId: selected.ownerId, generation: selected.generation }, message, update.update_id)) state.rejected++;
          }, context));
          harness.resume();
          return;
        }
        await accept(message && { ...message, media: message.media?.map(value => selectedApi!.photo(value)) }, update.update_id, undefined, signal, selected);
      };
      const receive = (update: TelegramUpdate, signal?: AbortSignal) => receiveTelegram(update, config, api, signal);
      let qqReceiving = false;
      const receiveQq = async (event: Record<string, unknown>, selected: PersonalQqConfig | undefined, selectedApi: PersonalQqApi | undefined, signal?: AbortSignal) => {
        const parsed = selected && Number(event.time) > selected.boundary && String(event.message_id) !== selected.boundaryMessageId ? qqMessage(event, selected.botId) : undefined;
        await accept(parsed && { ...parsed, name: "QQ 拥有者", ...(parsed.replyTo === undefined ? {} : { replyBotId: selected!.botId }), media: parsed.media?.map(value => selectedApi ? selectedApi.photo(value) : qqPhoto(value)) }, 0, "qq", signal, selected);
      };
      const runQq = async (selected: PersonalQqConfig, selectedApi: PersonalQqApi, signal: AbortSignal) => {
        qqReceiving = true;
        try { await selectedApi.poll(event => receiveQq(event, selected, selectedApi, signal), signal, async online => {
          await harness.commit(async tx => {
            const state = await tx.doc(PersonalTelegramDoc);
            if (!isDeepStrictEqual(state.qqConfig, selected)) return;
            if (state.qqConnection?.online === online) return;
            const at = Date.now(); state.qqConnection = { online, at };
            if (!online) state.qqGap = { since: at };
            else if (state.qqGap && state.qqGap.until === undefined) state.qqGap.until = at;
            await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.qq-connection", data: { generation: selected.generation, online, at } });
          }, context);
        }, true); } finally { qqReceiving = false; }
      };
      const qq = { receive: (event: Record<string, unknown>, signal?: AbortSignal) => receiveQq(event, qqConfig, qqApi, signal), poll: async (signal: AbortSignal) => poll("qq", signal), status: () => status("qq") };
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
        return { enabled: personalEntryConfig(state, { platform })?.enabled ?? false, receiving: platform ? qqReceiving : receiving, online: platform ? qqApi?.online ?? false : online, rejected: state.rejected, ...(platform && state.qqGap ? { gap: { ...state.qqGap } } : {}), recent, ...(personalEntryConfig(state, { platform })?.enabled && !(platform ? qqApi : api) ? { code: "im_credentials_unavailable" } : {}) };
      }, context);
      const runTelegram = async (selected: PersonalTelegramConfig, selectedApi: PersonalTelegramApi, signal: AbortSignal) => {
          receiving = true;
          let ack: TelegramAck | undefined;
          let backoff = 1000;
          try { while (!signal.aborted) {
            const offset = telegramOffset(ack);
            ack = undefined;
            try {
              const updates = await selectedApi.updates(signal, offset);
              online = true;
              const receivedAt = performance.now();
              for (const update of updates) { if (signal.aborted) return; await receiveTelegram(update, selected, selectedApi, signal); }
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
      };
      function poll(platform: "telegram" | "qq", signal: AbortSignal): Promise<void> {
        if (loops.has(platform)) throw new PersonalError(`${platform}_poll_busy`, "该平台收件循环已启动，请使用当前后台连接。");
        parents.set(platform, signal);
        return start(platform);
      }
      function start(platform: "telegram" | "qq"): Promise<void> {
        const parent = parents.get(platform), selected = platform === "qq" ? qqConfig : config;
        if (!parent || parent.aborted || !selected?.enabled || receivePaused.has(platform) || !(platform === "qq" ? qqApi : api)) return Promise.resolve();
        const stop = new AbortController(), signal = AbortSignal.any([parent, stop.signal]); pollStops.set(platform, stop);
        const connection = platform === "qq" ? qqApi : undefined;
        const loop = platform === "qq" ? runQq(selected as PersonalQqConfig, connection!, signal) : runTelegram(selected as PersonalTelegramConfig, api!, signal);
        const tracked = loop.finally(async () => { if (loops.get(platform) === tracked) { loops.delete(platform); pollStops.delete(platform); } if (connection && parent.aborted) { retired.add(connection); if (!sends.has(connection)) await closeRetired(connection); } });
        loops.set(platform, tracked); return tracked;
      }
      async function stopReceive(platform: "telegram" | "qq"): Promise<void> {
        pollStops.get(platform)?.abort();
        try { await loops.get(platform); } catch { process.stderr.write("[ruukoto:personal] 原 IM 收件循环已停止，受理记录保留；请查询原入口状态。\n"); }
      }
      const restart = (platform: "telegram" | "qq") => { void start(platform).catch(() => process.stderr.write("[ruukoto:personal] IM 新入口未连通，配置选择保留；请检查原入口状态。\n")); };
      return {
        receive, qq, withEntry, sender, configurationVersion, isActive, get delivery() { return delivery; },
        poll: async (signal: AbortSignal) => poll("telegram", signal),
        async pauseReceive(platform: "telegram" | "qq") { receivePaused.add(platform); await stopReceive(platform); },
        resumeReceive(platform: "telegram" | "qq") { receivePaused.delete(platform); restart(platform); },
        async update(platform: "telegram" | "qq", value: unknown, version: string, revision: string) {
          const selected = platform === "qq" ? parsePersonalQq(value) : parsePersonalTelegram(value), previous = platform === "qq" ? qqConfig : config;
          if (isDeepStrictEqual(selected, previous)) { versions.set(platform, version); return { effectiveRevision: revision, code: "settings_active", relatedOperations: [] }; }
          if (previous?.generation === selected.generation) throw new PersonalError("im_generation_conflict", "入口内容改变必须使用新配对代次，原入口保留；请重新配对。");
          let nextTelegram: PersonalTelegramApi | undefined, nextQq: PersonalQqApi | undefined;
          let previousQq: PersonalQqApi | undefined;
          if (selected.enabled) {
            if (platform === "qq") { nextQq = personalQqApi(selected as PersonalQqConfig, qqToken(selected as PersonalQqConfig)); try { await nextQq.verify(AbortSignal.timeout(15000)); } catch (error) { await nextQq.close(); if (error instanceof PersonalError) throw error; throw new PersonalError("qq_candidate_unavailable", "QQ 候选入口无法连接，原入口保留；请核实后台凭据与服务。", { cause: error }); } }
            else { nextTelegram = personalTelegramApi((selected as PersonalTelegramConfig).apiBase, telegramToken(selected as PersonalTelegramConfig)); const identity = await nextTelegram.me(AbortSignal.timeout(10000)); if (identity.id !== selected.botId) throw new PersonalError("telegram_identity_invalid", "Telegram 候选账号无法核实，原入口保留；请重新配对。"); }
          }
          await withEntry({ ...(platform === "qq" ? { platform: "qq" as const } : {}) }, async () => { switching.add(platform); });
          await stopReceive(platform);
          try {
            await withEntry({ ...(platform === "qq" ? { platform: "qq" as const } : {}) }, async () => {
              await harness.commit(async tx => {
                const state = await tx.doc(PersonalTelegramDoc), permission = await tx.doc(PersonalPermissionsDoc);
                if (platform === "qq") { state.qqConfig = selected as PersonalQqConfig; if (permission.qq) { permission.qq.mode = "auto-review"; permission.qq.version++; } }
                else state.config = selected as PersonalTelegramConfig;
                await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.im-config", data: { platform, version, revision, generation: selected.generation, enabled: selected.enabled } });
              }, context);
              if (platform === "qq") { previousQq = qqApi; qqConfig = selected as PersonalQqConfig; qqApi = nextQq; if (previousQq) retired.add(previousQq); }
              else { config = selected as PersonalTelegramConfig; api = nextTelegram; }
              versions.set(platform, version); receivePaused.delete(platform); switching.delete(platform);
            });
          } catch (error) { await nextQq?.close(); switching.delete(platform); restart(platform); throw error; }
          restart(platform);
          if (previousQq && !sends.has(previousQq)) await closeRetired(previousQq);
          return { effectiveRevision: revision, code: selected.enabled ? "settings_active_entry_unverified" : "settings_active", relatedOperations: [] };
        },
        close() {
          closed = true; if (presenceTimer) clearInterval(presenceTimer); presenceTimer = undefined; presenceStop.abort();
          if (!loops.size && !sending.size && !retired.size && !qqApi && !presencePending) return;
          return (async () => {
          for (const stop of pollStops.values()) stop.abort();
          const results = await Promise.allSettled([...loops.values()]);
          if (results.some(result => result.status === "rejected")) process.stderr.write("[ruukoto:personal] IM 收件停止时保留了失败记录，请查询原入口状态。\n");
          await Promise.allSettled([...sending]);
          await presencePending;
          await Promise.all([...retired, ...(qqApi ? [qqApi] : [])].map(connection => connection.close()));
          })();
        },
        status: () => status(),
      };
    },
  };
}

export type PersonalImRuntime = ReturnType<ReturnType<typeof personalTelegram>["api"]>;

async function acceptedOrigins(tx: Tx, keys: string[]) {
  const indexed = new Set(keys), origins = new Map<EntryId, EntryRecord>();
  if (indexed.size !== keys.length) throw new PersonalError("telegram_receipt_invalid", "IM 收件索引重复，请保留档案。");
  let cursor: Cursor | undefined;
  do {
    const conversations = await tx.scanConversations({}, 256, cursor);
    for (const conversation of conversations.items) {
      let next: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: conversation.id }, 256, next);
        for (const entry of page.items) {
          if (!["ruukoto.telegram-received", "ruukoto.qq-received", "ruukoto.telegram-callback"].includes(entry.kind)) continue;
          const data = entry.data, key = data && typeof data === "object" && !Array.isArray(data) && data.requestId;
          const value = typeof key === "string" && indexed.has(key) ? (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt : undefined;
          const kind = value?.callback ? "ruukoto.telegram-callback" : value?.platform === "qq" ? "ruukoto.qq-received" : "ruukoto.telegram-received";
          if (!value || value.media || value.requestId !== key || value.accepted !== entry.id || entry.conversationId !== ROOT_CONVERSATION_ID || entry.model !== undefined || entry.byTaskId !== undefined || entry.id >= value.taskId || entry.kind !== kind || !isDeepStrictEqual(data, { requestId: key, generation: value.generation, ...(value.callback ?? {}) })) throw new PersonalError("telegram_receipt_invalid", "IM 受理事实缺少对应的原收件关系，请保留档案。");
          origins.set(entry.id, entry);
        }
        next = page.next;
      } while (next);
    }
    cursor = conversations.next;
  } while (cursor);
  return origins;
}

export async function verifyPersonalTelegram(tx: Tx, keys: string[], config?: PersonalTelegramConfig, qqConfig?: PersonalQqConfig) {
  const state = await tx.doc(PersonalTelegramDoc);
  await verifyPersonalTelegramAttachments(tx);
  if (keys.some(key => key.startsWith("telegram:")) && !state.config) throw new PersonalError("telegram_receipt_invalid", "Telegram 收件缺少原绑定记录，已停止恢复；请保留档案。");
  if (state.config && !config) throw new PersonalError("telegram_config_missing", "档案的 Telegram 配置缺失，已停止恢复；请恢复配置或通过向导停用入口。");
  if (state.config && config?.generation === state.config.generation && !isDeepStrictEqual(config, state.config)) throw new PersonalError("telegram_config_changed", "Telegram 配置代次与内容不符，已停止恢复；请重新配对。");
  if (state.qqConfig) {
    parsePersonalQq(state.qqConfig);
    if (!qqConfig) throw new PersonalError("qq_config_missing", "原 QQ 配置缺失，已停止恢复；请恢复配置或通过向导停用入口。");
    if (state.qqConfig.generation === qqConfig.generation && !isDeepStrictEqual(state.qqConfig, qqConfig)) throw new PersonalError("qq_config_changed", "QQ 原代次与配置不符，请停止后台后重新配对。");
  }
  if (keys.some(key => key.startsWith("qq:")) && !state.qqConfig) throw new PersonalError("qq_receipt_invalid", "QQ 收件缺少原绑定，请保留档案。");
  // Complete origin scans before delivery recovery can append observations. An absent backlink is
  // historical only when no immutable received entry claims that receipt.
  const origins = await acceptedOrigins(tx, keys);
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
    const task = value && await tx.task(value.taskId);
    if (!value || value.platform !== undefined && value.platform !== "qq" || value.requestId !== key || key !== (value.callback ? `telegram-callback:${value.botId}:${value.callback.queryId}` : `${value.platform ?? "telegram"}:${value.botId}:${value.ownerId}:${value.messageId}`) || !task || task.kind !== TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.requestId !== key) throw new PersonalError("telegram_receipt_invalid", "IM 来源与执行关系无法核实，已停止恢复；请保留档案。");
    if ((value.permission && (!value.direct || value.control || !["auto-review", "confirm", "full_access"].includes(value.permission.mode) || !Number.isSafeInteger(value.permission.version) || value.permission.version < 1)) || (value.control && (!value.reply || value.permission || value.submissionId !== undefined)) || (value.selection && !value.control)) throw new PersonalError("telegram_receipt_invalid", "IM 输入权限或宿主控制归属不符，已停止恢复；请保留档案。");
    const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, key);
    if (value.submissionId !== undefined && (submission?.id !== value.submissionId || submission.type !== "input")) throw new PersonalError("telegram_receipt_invalid", "IM 原提交记录缺失，已停止恢复；请保留档案。");
    const accepted = value.accepted === undefined ? undefined : origins.get(value.accepted);
    if (!value.media && value.accepted !== undefined && !accepted) throw new PersonalError("telegram_receipt_invalid", "IM 原受理记录与收件不符，请保留档案。");
    if (value.callback) {
      const ack = (await tx.doc(PersonalTelegramCallbackDoc, key, null)).ack;
      if (value.platform || !value.control || !value.direct || value.permission || value.submissionId !== undefined || value.replyTo !== value.messageId || value.replyBotId !== value.botId || accepted?.kind !== "ruukoto.telegram-callback" || !isDeepStrictEqual(accepted.data, { requestId: key, generation: value.generation, ...value.callback }) || !ack || ack.input.origin !== value.accepted || !samePersonalEntry(ack.input.source, value) || !(await telegramSelection(tx, value))) throw new PersonalError("telegram_receipt_invalid", "原按钮来源或卡片关系无法核实。");
    }
    if (value.cuaAction && !await personalImControlAccepted(tx, value)) throw new PersonalError("telegram_receipt_invalid", "原电脑选择缺少私聊受理事实。");
    await verifyPersonalTelegramAttachmentReceipt(tx, value);
    if (value.rawContent !== undefined) {
      const prior = await telegramSelection(tx, value);
      if (!value.control || value.platform || await approvalReplyAction(tx, prior, value.rawContent) !== value.content) throw new PersonalError("telegram_receipt_invalid", "原审批用词与决定不符。");
    }
    if (value.display) {
      const display = (await tx.doc(PersonalTelegramDisplayDoc, value.display, null)).display;
      const original = value.redisplay && (await tx.doc(PersonalTelegramDisplayDoc, value.redisplay.display, null)).display;
      if (!display || display.origin !== value.accepted || !isDeepStrictEqual(display.selection, original ? original.selection : value.selection) || display.text !== value.reply || !isDeepStrictEqual(display.delivery, value.multipart)) throw new PersonalError("telegram_receipt_invalid", "原宿主回复与卡片不符。");
    }
    if (value.multipart && !value.display) {
      const delivery = await personalImDeliveryRecord(tx, value.multipart);
      if (!samePersonalEntry(delivery.input.source, value) || delivery.input.messageId !== value.messageId || value.replyFormat === "complete" && delivery.input.text !== value.reply || delivery.parent !== value.taskId && !delivery.input.retrieval && !value.cuaImages) throw new PersonalError("telegram_receipt_invalid", "原回复与分段发送来源不符。");
    }
    await verifyPersonalTelegramCuaImages(tx, value);
    await verifyPersonalTelegramResultControl(tx, value);
    if (value.delivery === "sending" && task.state.status === "terminal") {
      if (value.multipart) { const result = await personalImDeliveryTextReceipt(tx, value.multipart); if (["sent", "failed", "effect_unknown", "canceled"].includes(result.state)) value.delivery = result.state as Receipt["delivery"]; if (result.platformMessageId) value.platformMessageId = result.platformMessageId; }
      else value.delivery = "effect_unknown";
    }
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
