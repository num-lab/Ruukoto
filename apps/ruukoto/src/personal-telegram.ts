import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, defineDoc, defineDocFamily, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalTelegramApiError, telegramOffset, telegramText, type PersonalTelegramApi, type TelegramAck, type TelegramUpdate } from "./personal-telegram-api.ts";
import type { PersonalTelegramConfig } from "./personal-telegram-config.ts";

type Delivery = "waiting" | "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled" | "unanswered";
type Result = { delivery: Delivery };
type Receipt = { taskId: TaskId<Result>; requestId: string; generation: string; botId: string; ownerId: string; messageId: number; updateId: number; content: string; submissionId?: SubmissionId; delivery: Delivery; reply?: string; platformMessageId?: string };
export const PersonalTelegramDoc = defineDoc<{ config?: PersonalTelegramConfig; lastUpdateId?: number; rejected: number }>({ kind: "ruukoto.telegram", scope: "session", version: 1, initial: () => ({ rejected: 0 }) });
export const PersonalTelegramReceiptDoc = defineDocFamily<{ receipt?: Receipt }, null>({ kind: "ruukoto.telegram-receipt", scope: "session", version: 1, family: true, initial: () => ({}) });
const context = BACKGROUND_CONTEXT;
const TASK = "ruukoto.telegram-input";

async function receipt(tx: Tx, requestId: string, taskId: TaskId) {
  const value = (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt;
  if (!value || value.taskId !== taskId || value.requestId !== requestId) throw new PersonalError("telegram_receipt_missing", "Telegram 收件与执行记录不符，已停止；请保留档案并检查。");
  return value;
}

function active(config: PersonalTelegramConfig | undefined, value: Receipt) { return config?.enabled === true && config.generation === value.generation && config.botId === value.botId && config.ownerId === value.ownerId; }

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md
export function personalTelegram(config?: PersonalTelegramConfig, api?: PersonalTelegramApi) {
  const task = defineTask<{ requestId: string }, { phase: "run" } | { phase: "send"; retryAt?: number } | { phase: "verify" }, Result>({
    name: TASK, version: 1, initial: () => ({ phase: "run" }),
    phases: {
      async run(current, runtime, context) {
        const value = await runtime.snapshot(PersonalTelegramReceiptDoc, current.input.requestId, context);
        if (!value?.receipt || value.receipt.taskId !== current.id) throw new PersonalError("telegram_receipt_missing", "Telegram 收件来源缺失，已停止；请检查档案。");
        let allowed = false;
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          allowed = active((await tx.doc(PersonalTelegramDoc)).config, value);
          if (!allowed) { value.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; }
          return undefined;
        }, context);
        if (!allowed) return;
        const main = await runtime.conversation(ROOT_CONVERSATION_ID, context);
        if (!main) throw new PersonalError("telegram_main_missing", "Telegram 主会话缺失，已停止；请保留档案。");
        // 配置只在停机持锁时改变；跨 admission 的窗口始终重接同一平台消息键。
        const submission = await main.submit({ type: "input", content: value.receipt.content, requestId: current.input.requestId, whenBusy: "followUp" }, context);
        await runtime.commit(async tx => { (await receipt(tx, current.input.requestId, current.id)).submissionId = submission.id; return undefined; }, context);
        const settled = await submission.wait(context);
        const entry = settled.status === "done" && settled.type === "input" ? await runtime.entry(AssistantEntry, settled.answer, context) : undefined;
        const message = entry?.model?.[0];
        if (settled.status === "done" && message?.role !== "assistant") throw new PersonalError("telegram_answer_missing", "Telegram 原输入的完整回答缺失，未发送；请保留档案。");
        const answer = message?.role === "assistant" ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : undefined;
        await runtime.commit(async tx => {
          const value = await receipt(tx, current.input.requestId, current.id);
          if (!active((await tx.doc(PersonalTelegramDoc)).config, value) || answer === undefined) {
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
          if (!active((await tx.doc(PersonalTelegramDoc)).config, value)) { value.delivery = "canceled"; return { status: "terminal", outcome: { status: "completed", result: { delivery: value.delivery } } }; }
          if (value.delivery !== "pending" || !value.reply || !active(config, value) || !api) throw new PersonalError("telegram_send_invalid", "Telegram 固定发送记录或入口无法核实，已停止；请保留档案。");
          value.delivery = "sending";
          target = { ...value };
          return { status: "running", checkpoint: { phase: "verify" } };
        }, context);
        if (!target) return;
        let platformMessageId: string | undefined;
        let failure: PersonalTelegramApiError | undefined;
        try { platformMessageId = await api!.send(target.ownerId, target.messageId, target.reply!, runtime.signal); } catch (error) {
          if (!(error instanceof PersonalTelegramApiError)) throw error;
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
      const receive = async (update: TelegramUpdate) => {
        const message = telegramText(update);
        const key = message && config ? `telegram:${config.botId}:${message.ownerId}:${message.id}` : undefined;
        await harness.commit(async tx => {
          const state = await tx.doc(PersonalTelegramDoc);
          if (!config?.enabled || !isDeepStrictEqual(state.config, config)) throw new PersonalError("telegram_target_changed", "Telegram 入口配置已失效，已停止收件；请检查当前配置。");
          state.lastUpdateId = update.update_id;
          if (!message || message.ownerId !== config.ownerId || !key) { state.rejected++; return; }
          const record = await tx.doc(PersonalTelegramReceiptDoc, key, null);
          if (record.receipt) {
            if (record.receipt.content !== message.text) throw new PersonalError("telegram_input_conflict", "Telegram 同一消息的正文不符，已停止接收；请保留档案并检查。");
            return;
          }
          const taskId = await tx.createTask(task, { requestId: key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true });
          record.receipt = { taskId, requestId: key, generation: config.generation, botId: config.botId, ownerId: config.ownerId, messageId: message.id, updateId: update.update_id, content: message.text, delivery: "waiting" };
        }, context);
        harness.resume();
      };
      return {
        receive,
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
              for (const update of updates) { if (signal.aborted) return; await receive(update); }
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
        async status() {
          return harness.commit(async tx => {
            const state = await tx.doc(PersonalTelegramDoc);
            const page = await tx.scanTasks({ kind: TASK, order: "descending" }, 16);
            const recent = [];
            for (const current of page.items) {
              const key = current.input && typeof current.input === "object" && !Array.isArray(current.input) && current.input.requestId;
              if (typeof key !== "string") throw new PersonalError("telegram_receipt_missing", "Telegram 执行缺少收件引用，请保留档案。");
              const value = await receipt(tx, key, current.id);
              recent.push({ input: value.content.slice(0, 160), delivery: value.delivery });
            }
            return { enabled: state.config?.enabled ?? false, receiving, online, rejected: state.rejected, recent };
          }, context);
        },
      };
    },
  };
}

export async function verifyPersonalTelegram(tx: Tx, keys: string[], config?: PersonalTelegramConfig) {
  const state = await tx.doc(PersonalTelegramDoc);
  if (keys.length && !state.config) throw new PersonalError("telegram_receipt_invalid", "Telegram 收件缺少原绑定记录，已停止恢复；请保留档案。");
  if (state.config && !config) throw new PersonalError("telegram_config_missing", "档案的 Telegram 配置缺失，已停止恢复；请恢复配置或通过向导停用入口。");
  if (state.config && config?.generation === state.config.generation && !isDeepStrictEqual(config, state.config)) throw new PersonalError("telegram_config_changed", "Telegram 配置代次与内容不符，已停止恢复；请重新配对。");
  for (const key of keys) {
    const value = (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt;
    const task = value && await tx.task(value.taskId);
    if (!value || value.requestId !== key || key !== `telegram:${value.botId}:${value.ownerId}:${value.messageId}` || !task || task.kind !== TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.owner !== undefined || !task.input || typeof task.input !== "object" || Array.isArray(task.input) || task.input.requestId !== key) throw new PersonalError("telegram_receipt_invalid", "Telegram 来源与执行关系无法核实，已停止恢复；请保留档案。");
    const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, key);
    if (value.submissionId !== undefined && (submission?.id !== value.submissionId || submission.type !== "input")) throw new PersonalError("telegram_receipt_invalid", "Telegram 原提交记录缺失，已停止恢复；请保留档案。");
    if (value.delivery === "sending" && task.state.status === "terminal") value.delivery = "effect_unknown";
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({ kind: TASK }, 256, cursor);
    for (const task of page.items) {
      const key = task.input && typeof task.input === "object" && !Array.isArray(task.input) && task.input.requestId;
      if (typeof key !== "string" || !keys.includes(key) || (await tx.doc(PersonalTelegramReceiptDoc, key, null)).receipt?.taskId !== task.id) throw new PersonalError("telegram_receipt_invalid", "Telegram 执行缺少原收件事实，已停止恢复；请保留档案。");
    }
    cursor = page.next;
  } while (cursor);
  if (config) state.config = { ...config };
}
