/**
 * Telegram owner 入口（daily-agent issue 04）：Bot API long polling + owner 回复渠道。
 *
 * - 只接纳私聊、固定 owner user_id + chat_id 的文本与图片消息；其余不登记、不建任务，
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
import { NotSentError, RetryLaterError } from "../scheduler/runtime.ts";
import { RuntimeApiError } from "../core/api-error.ts";
import type { ImEntry } from "../runtime/im-entries.ts";
import { MediaError, type InboundMediaStore, type InboundMediaDownload } from "../runtime/inbound-media.ts";

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
  media: InboundMediaStore;
  /** 编排器登记入口（固定 source=telegram、目标 main；目标为收件时按捕获配置钉版）。 */
  register(input: { externalId: string; actor: string; body: string; replyTarget: NotifyTarget | null; commandText?: string; media?: boolean }): Promise<unknown>;
  /** 轮询恢复在线时唤起已持久化、等待连接恢复的入站与 main 队列。 */
  onOnline?(): void;
  log(message: string): void;
  /** getUpdates 长轮询秒数（默认 25；测试压短）。 */
  pollTimeoutSec?: number;
  /** 断线初始退避（默认 1s，指数增长到 30s）。 */
  backoffMs?: number;
  /**
   * 启动配置停用（架构工单 10；dev 开发实例经 RUUKOTO_DISABLE_TELEGRAM=1 注入，
   * ruukoto-dev 按产品边界强制）：入口照常存在，但不轮询、target() 为 null、
   * 入站作废；telegram 控制面操作仍作用于配置存储。
   */
  startupDisabled?: "product" | "dev";
}

export class TelegramAdapter implements ImEntry {
  readonly source = TELEGRAM_SOURCE;
  readonly replySkippedEvent = "telegram.reply_skipped";
  private loop: Promise<void> | null = null;
  private aborter: AbortController | null = null;
  private online = false;
  private lastError: string | null = null;
  private stopped = false;

  constructor(private readonly deps: TelegramDeps) {}

  get startupDisabled(): boolean {
    return this.deps.startupDisabled !== undefined;
  }

  start(): void {
    const config = this.deps.tg.getConfig();
    if (this.startupDisabled || this.stopped || !config?.enabled) return;
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
    if (this.deps.startupDisabled) {
      return {
        configured: config !== null,
        enabled: false,
        online: false,
        disabledByConfig: true,
        stateDetail: this.deps.startupDisabled === "product"
          ? "Coding Agent（ruukoto-dev）不连接消息平台"
          : "已由启动配置停用（dev 开发实例不连接真实 Telegram）",
      };
    }
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
    if (this.startupDisabled || !config.enabled || !token) return null;
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
    if (this.startupDisabled) return { drop: "telegram_unavailable:Telegram 适配器未启动" };
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

  // ---------- 拥有者 IM 入口（架构工单 10） ----------

  /** 当前配置期望的 actor（owner user_id）；停用为 null（任何命令都不接纳）。 */
  expectedActor(): string | null {
    const config = this.deps.tg.getConfig();
    return config?.enabled ? `telegram:${config.ownerUserId}` : null;
  }

  replyCapChars(): number {
    return REPLY_CAP;
  }

  capReply(text: string): string {
    return capReply(text);
  }

  externalIdPrefix(target: NotifyTarget): string {
    return telegramExternalId(target.account, target.chatId, "");
  }

  usesCredential(name: string): boolean {
    return this.deps.tg.getConfig()?.credentialName === name;
  }

  bumpGeneration(): void {
    const c = this.deps.tg.bumpConfigVersion();
    if (c) this.deps.store.appendEvent({ type: "telegram.config_changed", configVersion: c.configVersion, action: "credential_changed" }, {});
  }

  /**
   * 配置/更新 Telegram bot 与固定 owner（拥有者操作）。bot token 经凭据绑定
   * 引用（purpose=telegram_bot，host 与 API 地址一致；配置后 scope 收紧到
   * telegram_bot 操作）；API 地址默认官方端点，可指向受控反代（http 仅限回环）。
   * 任何变化递增 configVersion；调用方随后重连并 reconcile，旧目标上未发送的操作不改发。
   */
  configure(input: { apiBase?: string; credential: string; ownerUserId: string; ownerChatId?: string; expectedVersion?: number }): TelegramConfig {
    let api: URL;
    try {
      api = new URL(input.apiBase ?? TELEGRAM_DEFAULT_API);
    } catch {
      throw new RuntimeApiError("invalid_params", `api_base 不是合法 URL：${input.apiBase}`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname.toLowerCase());
    if (api.protocol !== "https:" && !(api.protocol === "http:" && loopback)) {
      throw new RuntimeApiError("invalid_params", "api_base 必须是 https://（http:// 仅限回环地址）");
    }
    const ownerChatId = input.ownerChatId ?? input.ownerUserId;
    if (!/^\d{1,20}$/.test(input.ownerUserId) || !/^\d{1,20}$/.test(ownerChatId)) {
      throw new RuntimeApiError("invalid_params", "user_id / chat_id 必须是数字串（私聊的 chat_id 即 owner 的 user_id）");
    }
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
      throw new RuntimeApiError("invalid_params", "expected_version 必须是非负整数");
    }
    const cred = this.deps.credentials.get(input.credential);
    if (!cred) throw new RuntimeApiError("invalid_params", `凭据绑定不存在：${input.credential}`);
    if (cred.purpose !== TELEGRAM_CREDENTIAL_PURPOSE) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 用途是 ${cred.purpose}，Telegram 入口需要 purpose=${TELEGRAM_CREDENTIAL_PURPOSE} 的凭据`);
    }
    if (cred.host !== api.host.toLowerCase()) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 的 host（${cred.host}）与 API 地址 host（${api.host}）不一致`);
    }
    if (!/^\d+:[\w-]+$/.test(cred.secret)) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 的值不是 bot token 格式（<数字>:<密钥>）`);
    }
    if (cred.scope?.projectId !== undefined || (cred.scope?.operations !== undefined && !cred.scope.operations.includes(TELEGRAM_CREDENTIAL_PURPOSE))) {
      throw new RuntimeApiError("invalid_params", `凭据 ${input.credential} 已有其他使用范围，与 telegram_bot 冲突；请另建凭据`);
    }
    let config: TelegramConfig;
    try {
      config = this.deps.store.withTx(() => {
        const c = this.deps.tg.upsertConfig({
          apiBase: api.toString().replace(/\/+$/, ""),
          credentialName: input.credential,
          ownerUserId: input.ownerUserId,
          ownerChatId,
          expectedVersion: input.expectedVersion,
        });
        this.deps.store.appendEvent({ type: "telegram.config_changed", configVersion: c.configVersion, action: "upsert" });
        return c;
      });
    } catch (err) {
      if (err instanceof TelegramVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    // scope 收紧：通用 http_request 与其他入口不得借用 bot token
    this.deps.credentials.upsert({ ...cred, scope: { operations: [TELEGRAM_CREDENTIAL_PURPOSE] } });
    return config;
  }

  /** 一键启停（事务与配置事件）；调用方随后停止/重启轮询并 reconcile，未发送的回复因目标停用而取消（不改发）。 */
  setEnabled(enabled: boolean, expectedVersion?: number): TelegramConfig {
    let config: TelegramConfig | null;
    try {
      config = this.deps.store.withTx(() => {
        const prev = this.deps.tg.getConfig();
        const c = this.deps.tg.setEnabled(enabled, expectedVersion);
        if (c && c.configVersion !== prev?.configVersion) {
          this.deps.store.appendEvent({ type: "telegram.config_changed", configVersion: c.configVersion, action: enabled ? "enabled" : "disabled" });
        }
        return c;
      });
    } catch (err) {
      if (err instanceof TelegramVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    if (!config) throw new RuntimeApiError("not_found", "Telegram 入口未配置（先 telegram_configure）");
    return config;
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
        const becameOnline = !this.online;
        this.online = true;
        this.lastError = null;
        backoff = base;
        if (becameOnline) this.deps.onOnline?.();
        for (const update of json.result) {
          if (signal.aborted) return;
          // 先持久化（登记失败抛出 → 不推进偏移，下一轮平台重投）
          await this.handleUpdate(config, token, update, signal);
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

  private async handleUpdate(config: TelegramConfig, token: string, update: any, signal: AbortSignal): Promise<void> {
    const m = update?.message;
    const hasPhoto = Array.isArray(m?.photo) && m.photo.length > 0;
    const chatId = m?.chat?.id !== undefined ? String(m.chat.id) : null;
    const userId = m?.from?.id !== undefined ? String(m.from.id) : null;
    const reason = !m
      ? "unsupported_update"
      : m.chat?.type !== "private"
        ? "not_private"
        : userId !== config.ownerUserId || chatId !== config.ownerChatId
          ? "not_owner"
          : typeof m.text !== "string" && !hasPhoto
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
    const input = {
      externalId: telegramExternalId(telegramBotId(token), chatId!, m.message_id),
      actor: `telegram:${userId}`,
      body: inboundBody(m, chatId!, userId!),
      // 目标按该次轮询捕获的配置/凭据钉版，不用后来的配置重新包装旧消息
      replyTarget: this.targetFor(config, token),
    };
    if (hasPhoto) {
      // PhotoSize 是同一张图片的多个尺寸；只下载最大分辨率，不按 file_size 选缩略图。
      const photo = m.photo.reduce((largest: any, item: any) =>
        Number(item.width) * Number(item.height) > Number(largest.width) * Number(largest.height) ? item : largest);
      const download: InboundMediaDownload = {
        sizeBytes: typeof photo.file_size === "number" ? photo.file_size : undefined,
        download: (downloadSignal) => this.downloadPhoto(config, token, photo.file_id, downloadSignal, download),
      };
      await this.deps.media.stage({
        ...input, source: TELEGRAM_SOURCE, signal,
        media: [download],
      });
      signal.throwIfAborted();
      const current = this.deps.tg.getConfig();
      if (!current || current.configVersion !== config.configVersion || current.credentialName !== config.credentialName) return;
      await this.deps.register({ ...input, media: true });
      return;
    }
    await this.deps.register({
      ...input,
      // 原始发送文本（未加模板/引用摘录）：宿主据此识别审批命令；
      // 转发消息照常建任务，但其内容不解释为审批命令
      commandText: m.forward_origin != null || m.forward_date != null ? undefined : m.text,
    });
  }

  private async downloadPhoto(config: TelegramConfig, token: string, fileId: unknown, signal: AbortSignal, download: InboundMediaDownload): Promise<Response> {
    if (typeof fileId !== "string" || !fileId) throw new MediaError("download_unavailable");
    const response = await fetch(`${config.apiBase}/bot${token}/getFile`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_id: fileId }), signal,
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw new MediaError("download_unavailable");
      throw new Error("Telegram 图片下载暂时不可用");
    }
    const json = await response.json() as any;
    const path = json?.result?.file_path;
    if (!json?.ok || typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") ||
        path.split("/").some((part: string) => part === "..") || /[?#]/.test(path)) throw new MediaError("download_unavailable");
    const file = await fetch(`${config.apiBase}/file/bot${token}/${path}`, { signal });
    const mime = file.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    // Bot API 下载可能只声明二进制流；以平台 file_path 声明类型，再由暂存核对 magic。
    download.declaredMime = !mime || mime === "application/octet-stream"
      ? ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as Record<string, string>)[path.split(".").at(-1)!.toLowerCase()]
      : undefined;
    return file;
  }

  /** owner 回复关联原消息：op 来源键 = 入站事件 id，外部 id 末段即 message_id。 */
  private replyToMessageId(opId: string): number | null {
    const op = this.deps.sched.getOp(opId);
    if (op?.sourceKind !== "owner_reply") return null;
    // 工作最终汇报的来源键带 #work: 后缀（issue 18），原消息引用取「#」前的入站事件 id
    const event = this.deps.store.getInboundEvent(op.sourceKey.split("#")[0]!);
    const id = Number(event?.externalId.split(":").at(-1));
    return Number.isSafeInteger(id) ? id : null;
  }
}

/** 入站正文固定模板：平台/chat/user/message id/时间/回复关联 + 原文。 */
function inboundBody(m: any, chatId: string, userId: string): string {
  const lines = [`[Telegram 私聊] chat ${chatId} user ${userId} message ${m.message_id} 时间 ${new Date(Number(m.date) * 1000).toISOString()}`];
  const r = m.reply_to_message;
  if (r) {
    const quote = typeof r.text === "string" ? r.text : typeof r.caption === "string" ? r.caption : "（非文本）";
    lines.push(
      `回复关联：message ${r.message_id}（${r.from?.is_bot ? "本 bot 发送" : "owner 发送"}）：` +
        (quote.length > QUOTE_CAP ? `${quote.slice(0, QUOTE_CAP)}…` : quote),
    );
  }
  lines.push("正文：", typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "");
  return lines.join("\n");
}
