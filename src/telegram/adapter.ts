/**
 * Telegram owner 入口（daily-agent issue 04）：Bot API long polling + owner 回复渠道。
 *
 * - 只接纳私聊、固定 owner user_id + chat_id 的文本消息；其余不登记、不建任务，
 *   只记受限事件（id 与原因，不含正文）；
 * - 入站先经编排器持久化（(source, external_id) 去重），之后才推进轮询偏移：
 *   崩溃/断线后平台重投的 update 命中原外部 id，不重复建任务；
 * - 出站实现调度器的 NotifyChannel：目标由本配置固定（模型不能传 chat/user/凭据），
 *   发送经公共 outbox；429 限流退回 pending 按 retry_after 再试，可证明未发送的
 *   拒绝记 failed，其余（超时/5xx/中途断开）记 effect_unknown，不自动重发；
 * - bot token 只在 CredentialStore（purpose=telegram_bot），不进入模型上下文、
 *   事件与日志（错误信息先脱敏）。
 */

import type { CredentialStore } from "../agent/execution/credentials.ts";
import type { Store } from "../core/store.ts";
import type { InboundEvent, NotifyTarget } from "../core/types.ts";
import { sameTarget } from "../core/notify-target.ts";
import type { SchedulerStore } from "../scheduler/store.ts";
import { NotSentError, RetryLaterError, type NotifyChannel } from "../scheduler/runtime.ts";

export const TELEGRAM_CREDENTIAL_PURPOSE = "telegram_bot";
export const TELEGRAM_SOURCE = "telegram";
export const TELEGRAM_DEFAULT_API = "https://api.telegram.org";
/** 单条消息上限 4096 字符；超出截短并注明（不拆成多条发送）。 */
const REPLY_CAP = 4000;
/** 被回复消息的摘录上限（回复关联信息）。 */
const QUOTE_CAP = 500;
/** 可证明连接尚未建立（请求未发出）的底层错误码。 */
const PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export interface TelegramConfig {
  apiBase: string;
  credentialName: string;
  ownerUserId: string;
  ownerChatId: string;
  enabled: boolean;
  configVersion: number;
  lastUpdateId: number;
  createdAt: string;
  updatedAt: string;
}

export class TelegramVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(expected: number, current: number) {
    super(`Telegram 配置版本冲突：期望 v${expected}，当前 v${current}（请刷新后重试）`);
  }
}

export function capReply(text: string): string {
  return text.length > REPLY_CAP ? `${text.slice(0, REPLY_CAP)}…（截断，原 ${text.length} 字符，完整内容见 TUI）` : text;
}

/** 外部 id = bot:chat:message（message_id 只在 bot+chat 内唯一；换 bot 不会撞键）。 */
export function telegramExternalId(botId: string, chatId: string, messageId: number | string): string {
  return `${botId}:${chatId}:${messageId}`;
}

/** token 形如 <botId>:<secret>；botId 公开，可作目标账号与外部 id 前缀。 */
export function telegramBotId(token: string): string {
  return token.split(":")[0]!;
}

export class TelegramStore {
  constructor(private readonly store: Store) {}

  getConfig(): TelegramConfig | null {
    const row = this.store.db.prepare("SELECT * FROM telegram_config WHERE id = 1").get() as any;
    if (!row) return null;
    return {
      apiBase: row.api_base,
      credentialName: row.credential_name,
      ownerUserId: row.owner_user_id,
      ownerChatId: row.owner_chat_id,
      enabled: Number(row.enabled) === 1,
      configVersion: Number(row.config_version),
      lastUpdateId: Number(row.last_update_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private checkVersion(expected: number | undefined): TelegramConfig | null {
    const existing = this.getConfig();
    if (expected !== undefined && expected !== (existing?.configVersion ?? 0)) {
      throw new TelegramVersionConflictError(expected, existing?.configVersion ?? 0);
    }
    return existing;
  }

  /** 新建或更新（调用方在事务内追加事件）；轮询偏移归零（换 bot/token 后旧偏移无意义，重投由外部 id 去重）。 */
  upsertConfig(input: { apiBase: string; credentialName: string; ownerUserId: string; ownerChatId: string; expectedVersion?: number }): TelegramConfig {
    const existing = this.checkVersion(input.expectedVersion);
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO telegram_config (id, api_base, credential_name, owner_user_id, owner_chat_id, enabled, config_version, last_update_id, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, 0, 1, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET api_base = excluded.api_base, credential_name = excluded.credential_name,
           owner_user_id = excluded.owner_user_id, owner_chat_id = excluded.owner_chat_id,
           config_version = config_version + 1, last_update_id = 0, updated_at = excluded.updated_at`,
      )
      .run(input.apiBase, input.credentialName, input.ownerUserId, input.ownerChatId, existing?.createdAt ?? now, now);
    return this.getConfig()!;
  }

  setEnabled(enabled: boolean, expectedVersion?: number): TelegramConfig | null {
    const existing = this.checkVersion(expectedVersion);
    if (!existing || existing.enabled === enabled) return existing;
    this.store.db
      .prepare("UPDATE telegram_config SET enabled = ?, config_version = config_version + 1, updated_at = ? WHERE id = 1")
      .run(enabled ? 1 : 0, new Date().toISOString());
    return this.getConfig();
  }

  setLastUpdateId(updateId: number): void {
    this.store.db.prepare("UPDATE telegram_config SET last_update_id = ? WHERE id = 1 AND last_update_id < ?").run(updateId, updateId);
  }

  /**
   * 凭据变化/删除触发的代次推进（agent-direction issue 08）：只单调递增版本
   * 并归零轮询偏移（可能已换 bot，旧偏移无意义，重投由外部 id 去重）；
   * A → B → A 轮换不会恢复旧代次。返回 null = 未配置。
   */
  bumpConfigVersion(): TelegramConfig | null {
    const existing = this.getConfig();
    if (!existing) return null;
    this.store.db
      .prepare("UPDATE telegram_config SET config_version = config_version + 1, last_update_id = 0, updated_at = ? WHERE id = 1")
      .run(new Date().toISOString());
    return this.getConfig();
  }
}

class TelegramApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs: number | null) {
    super(message);
  }
}

export interface TelegramDeps {
  store: Store;
  tg: TelegramStore;
  sched: SchedulerStore;
  credentials: CredentialStore;
  /** 编排器登记入口（固定 source=telegram、目标 main；目标为收件时按捕获配置钉版）。 */
  register(input: { externalId: string; actor: string; body: string; replyTarget: NotifyTarget | null; commandText?: string }): Promise<unknown>;
  log(message: string): void;
  /** getUpdates 长轮询秒数（默认 25；测试压短）。 */
  pollTimeoutSec?: number;
  /** 断线初始退避（默认 1s，指数增长到 30s）。 */
  backoffMs?: number;
}

export class TelegramAdapter implements NotifyChannel {
  private loop: Promise<void> | null = null;
  private aborter: AbortController | null = null;
  private online = false;
  private lastError: string | null = null;
  private stopped = false;

  constructor(private readonly deps: TelegramDeps) {}

  start(): void {
    const config = this.deps.tg.getConfig();
    if (this.stopped || !config?.enabled) return;
    const aborter = new AbortController();
    this.aborter = aborter;
    this.loop = this.poll(aborter.signal).catch((err) => this.deps.log(`轮询循环异常退出：${this.redact((err as Error).message)}`));
  }

  /** 配置/启停变化：停掉当前轮询并按新配置重连（与 stop 串行，重叠调用不会留下两个循环）。 */
  onConfigChanged(): Promise<void> {
    return this.serial(async () => {
      await this.halt();
      this.start();
    });
  }

  /** 停止：中止长轮询并等待循环退出（之后不再写库）。 */
  stop(): Promise<void> {
    this.stopped = true;
    return this.serial(() => this.halt());
  }

  private chain: Promise<void> = Promise.resolve();

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async halt(): Promise<void> {
    this.aborter?.abort();
    await this.loop;
    this.loop = null;
    this.aborter = null;
    this.online = false;
  }

  status(): Record<string, unknown> {
    const config = this.deps.tg.getConfig();
    return {
      configured: config !== null,
      enabled: config?.enabled ?? false,
      online: this.online,
      lastError: this.lastError,
      ...(config
        ? {
            apiBase: config.apiBase,
            credentialName: config.credentialName,
            ownerUserId: config.ownerUserId,
            ownerChatId: config.ownerChatId,
            configVersion: config.configVersion,
            lastUpdateId: config.lastUpdateId,
          }
        : {}),
    };
  }

  // ---------- NotifyChannel ----------

  /** 按捕获的配置与凭据钉版目标（收件/发送共用；不要求当前配置仍有效。） */
  private targetFor(config: TelegramConfig, token: string | null): NotifyTarget | null {
    if (!config.enabled || !token) return null;
    return { channel: TELEGRAM_SOURCE, account: telegramBotId(token), chatId: config.ownerChatId, configVersion: config.configVersion };
  }

  target(): NotifyTarget | null {
    const config = this.deps.tg.getConfig();
    if (!config) return null;
    return this.targetFor(config, this.token(config));
  }

  available(): boolean {
    return this.online;
  }

  /**
   * 入站派发/任务启动/回复共用（issue 08，与 QQ 私聊门对齐）：来源、actor
   * （owner user_id，不能由 chatId 推断）与收件时钉版的目标及配置版本逐项
   * 核对；版本未变的暂时离线等待恢复，配置变化/停用/旧 null 目标明确失效。
   */
  gatePrivate(event: InboundEvent): "run" | "wait" | { drop: string } {
    const config = this.deps.tg.getConfig();
    const target = this.target();
    if (!target || !config || event.source !== TELEGRAM_SOURCE || event.actor !== `telegram:${config.ownerUserId}` ||
        !sameTarget(target, event.replyTarget)) {
      return { drop: "telegram_target_changed:Telegram 入口已停用或固定身份发生变化" };
    }
    return this.available() ? "run" : "wait";
  }

  async send(input: { opId: string; target: NotifyTarget; text: string; signal: AbortSignal }): Promise<{ platformMessageId: string }> {
    const config = this.deps.tg.getConfig();
    const token = config ? this.token(config) : null;
    if (!config || !token) throw new NotSentError("credential_unavailable", "Telegram 凭据不可用");
    // 领取之后的完整复核：启停、固定目标与配置版本在实际请求前再次核对
    // （覆盖 outbox 已领取但配置刚变化的窗口）——失败即目标代次变化，可证明未发送。
    const current = this.targetFor(config, token);
    if (!current || !sameTarget(current, input.target)) {
      throw new NotSentError("target_changed", "Telegram 固定目标已变化或停用");
    }
    const replyTo = this.replyToMessageId(input.opId);
    let res: Response;
    try {
      res = await fetch(`${config.apiBase}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.target.chatId,
          text: input.text,
          ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        }),
        signal: input.signal,
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code && PRE_CONNECT_CODES.has(code)) throw new NotSentError("connect_failed", `连接未建立（${code}），请求未发出`);
      throw new Error(this.redact(`发送结果未知：${(err as Error).message}`, token));
    }
    const json = (await res.json().catch(() => null)) as any;
    if (res.ok && json?.ok) return { platformMessageId: String(json.result?.message_id ?? "") };
    if (res.status === 429) {
      const seconds = Number(json?.parameters?.retry_after);
      throw new RetryLaterError((Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000, `Telegram 限流（retry_after=${json?.parameters?.retry_after ?? "?"}）`);
    }
    if (res.status >= 400 && res.status < 500) {
      throw new NotSentError(`telegram_${res.status}`, this.redact(String(json?.description ?? `HTTP ${res.status}`), token));
    }
    // 5xx / 成功状态但回执不可解析：平台可能已接收
    throw new Error(this.redact(`发送结果未知：HTTP ${res.status}`, token));
  }

  // ---------- 接收 ----------

  private token(config: TelegramConfig): string | null {
    return this.deps.credentials.getForUse(config.credentialName, { operation: TELEGRAM_CREDENTIAL_PURPOSE })?.secret ?? null;
  }

  /** 错误信息脱敏：token 出现在请求 URL 中，任何日志/账本/状态输出前替换。传入该请求捕获的 token，覆盖轮换/删除后旧请求的迟到错误。 */
  private redact(message: string, capturedToken?: string | null): string {
    const token =
      capturedToken ??
      (() => {
        const config = this.deps.tg.getConfig();
        return config ? this.token(config) : null;
      })();
    return token ? message.split(token).join("<token>") : message;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const base = this.deps.backoffMs ?? 1_000;
    const timeoutSec = this.deps.pollTimeoutSec ?? 25;
    let backoff = base;
    while (!signal.aborted) {
      const config = this.deps.tg.getConfig();
      const token = config?.enabled ? this.token(config) : null;
      if (!config || !token) {
        this.online = false;
        this.lastError = "凭据不可用（不存在或范围不含 telegram_bot），保持未连接";
        this.deps.log(this.lastError);
        return;
      }
      try {
        const res = await fetch(`${config.apiBase}/bot${token}/getUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset: config.lastUpdateId + 1, timeout: timeoutSec, allowed_updates: ["message"] }),
          signal: AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 10) * 1000)]),
        });
        const json = (await res.json().catch(() => null)) as any;
        if (!res.ok || !json?.ok || !Array.isArray(json.result)) {
          const seconds = Number(json?.parameters?.retry_after);
          throw new TelegramApiError(res.status, String(json?.description ?? `HTTP ${res.status}`), Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null);
        }
        this.online = true;
        this.lastError = null;
        backoff = base;
        for (const update of json.result) {
          if (signal.aborted) return;
          // 先持久化（登记失败抛出 → 不推进偏移，下一轮平台重投）
          await this.handleUpdate(config, token, update);
          if (signal.aborted) return;
          // 推进偏移前核对仍是同一代次：配置/凭据在登记期间变化（版本递增、
          // 偏移已归零）时不写回旧偏移，重投由外部 id 去重
          const fresh = this.deps.tg.getConfig();
          if (fresh && fresh.configVersion === config.configVersion && fresh.credentialName === config.credentialName) {
            this.deps.store.withTx(() => this.deps.tg.setLastUpdateId(Number(update.update_id)));
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        this.online = false;
        this.lastError = this.redact((err as Error).message, token);
        const wait = err instanceof TelegramApiError && err.retryAfterMs !== null ? err.retryAfterMs : backoff;
        backoff = Math.min(backoff * 2, 30_000);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    }
  }

  private async handleUpdate(config: TelegramConfig, token: string, update: any): Promise<void> {
    const m = update?.message;
    const chatId = m?.chat?.id !== undefined ? String(m.chat.id) : null;
    const userId = m?.from?.id !== undefined ? String(m.from.id) : null;
    const reason = !m
      ? "unsupported_update"
      : m.chat?.type !== "private"
        ? "not_private"
        : userId !== config.ownerUserId || chatId !== config.ownerChatId
          ? "not_owner"
          : typeof m.text !== "string"
            ? "non_text"
            : null;
    if (reason) {
      this.deps.store.withTx(() =>
        this.deps.store.appendEvent({ type: "telegram.rejected", updateId: Number(update?.update_id), chatId, userId, reason }),
      );
      return;
    }
    // 登记前再次核对捕获的配置/凭据仍是当前代次：轮换/重绑期间的消息不登记
    // （偏移也不推进，重投由外部 id 去重）
    const fresh = this.deps.tg.getConfig();
    if (!fresh || fresh.configVersion !== config.configVersion || fresh.credentialName !== config.credentialName) return;
    await this.deps.register({
      externalId: telegramExternalId(telegramBotId(token), chatId!, m.message_id),
      actor: `telegram:${userId}`,
      body: inboundBody(m, chatId!, userId!),
      // 目标按该次轮询捕获的配置/凭据钉版，不用后来的配置重新包装旧消息
      replyTarget: this.targetFor(config, token),
      // 原始发送文本（未加模板/引用摘录）：宿主据此识别审批命令；
      // 转发消息照常建任务，但其内容不解释为审批命令
      commandText: m.forward_origin != null || m.forward_date != null ? undefined : m.text,
    });
  }

  /** owner 回复关联原消息：op 来源键 = 入站事件 id，外部 id 末段即 message_id。 */
  private replyToMessageId(opId: string): number | null {
    const op = this.deps.sched.getOp(opId);
    if (op?.sourceKind !== "owner_reply") return null;
    const event = this.deps.store.getInboundEvent(op.sourceKey);
    const id = Number(event?.externalId.split(":").at(-1));
    return Number.isSafeInteger(id) ? id : null;
  }
}

/** 入站正文固定模板：平台/chat/user/message id/时间/回复关联 + 原文。 */
function inboundBody(m: any, chatId: string, userId: string): string {
  const lines = [`[Telegram 私聊] chat ${chatId} user ${userId} message ${m.message_id} 时间 ${new Date(Number(m.date) * 1000).toISOString()}`];
  const r = m.reply_to_message;
  if (r) {
    const quote = typeof r.text === "string" ? r.text : "（非文本）";
    lines.push(
      `回复关联：message ${r.message_id}（${r.from?.is_bot ? "本 bot 发送" : "owner 发送"}）：` +
        (quote.length > QUOTE_CAP ? `${quote.slice(0, QUOTE_CAP)}…` : quote),
    );
  }
  lines.push("正文：", m.text);
  return lines.join("\n");
}
