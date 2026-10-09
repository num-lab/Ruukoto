/**
 * QQ 适配器：owner 私聊入口（NapCat OneBot v11），发送走公共 outbox。
 *
 * 核心群聊已退役（agent-direction issue 20，ADR 0017 修订 ADR 0014）：群消息
 * 直接忽略——不登记收件、不建任务、不回复、不保存正文，也不逐条记日志；撤回
 * 通知继续处理，但只给已登记的旧收件打标记（已接收群结果的撤回复核仍然有效），
 * 不再取消任务或补发回复。旧群资料保留为只读归档（qq_inbox/qq_outbox/
 * qq_sessions/inbound_events）。正式 QQ 群聊外挂在后续阶段交付。
 *
 * 边界与纪律：
 * - 窄入口：只经 QqRuntimeBridge 调用 Runtime 的少量方法；不持有拥有者
 *   token，不能审批、改权限、开完全访问或读取其他项目资料；
 * - 私聊只接绑定拥有者的好友文本与图片；发送目标由宿主固定，断线不重投；
 *   超时/断线/崩溃 = unknown（effect_unknown，不自动重发）。
 */

import type { Store } from "../core/store.ts";
import type { InboundEvent, NotifyTarget } from "../core/types.ts";
import { sameTarget } from "../core/notify-target.ts";
import type { CredentialStore } from "../agent/execution/credentials.ts";
import { OneBotClient, OneBotError, oneBotAccountId, oneBotMessageId } from "./onebot.ts";
import { QqVersionConflictError, type QqConfig, type QqStore } from "./store.ts";
import type { SchedulerStore } from "../scheduler/store.ts";
import { NotSentError } from "../scheduler/runtime.ts";
import { RuntimeApiError } from "../core/api-error.ts";
import type { ImEntry } from "../runtime/im-entries.ts";
import { MediaError, type InboundMediaStore, type InboundMediaDownload } from "../runtime/inbound-media.ts";

/** QQ 入口凭据用途（CredentialStore 绑定 purpose 与 scope.operations）。 */
export const QQ_CREDENTIAL_PURPOSE = "qq_onebot";
export const QQ_PRIVATE_SOURCE = "qq_private";

export function qqPrivateExternalId(account: string, owner: string, messageId: string | number): string {
  return `${account}:${owner}:${messageId}`;
}

/** 适配器需要的 Runtime 窄接口（宿主注入；除此之外的能力适配器不可见）。 */
export interface QqRuntimeBridge {
  registerPrivate(input: { externalId: string; actor: string; body: string; replyTarget: NotifyTarget; commandText?: string; media?: boolean }): Promise<unknown>;
  dispatchInbound(): Promise<unknown>;
  kickSession(sessionId: string): void;
}

export interface QqAdapterTimeouts {
  actionTimeoutMs?: number;
  probeIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** 启停状态巡检间隔（默认 15s；测试可压短）。 */
  sweepIntervalMs?: number;
}

export interface QqAdapterDeps {
  store: Store;
  qqStore: QqStore;
  sched: SchedulerStore;
  credentials: CredentialStore;
  media: InboundMediaStore;
  bridge: QqRuntimeBridge;
  timeouts?: QqAdapterTimeouts;
  /**
   * 启动配置停用（架构工单 10；dev 开发实例经 RUUKOTO_DISABLE_QQ=1 注入，ruukoto-code
   * 按产品边界强制）：入口照常存在，但不连接、target() 为 null、入站作废；
   * qq 控制面操作仍作用于配置存储。
   */
  startupDisabled?: "product" | "dev";
}

/** 入站消息正文字符上限（事件大小校验；超出登记 skipped，不入队）。 */
const MAX_INBOUND_TEXT_CHARS = 8192;

export class QqAdapter implements ImEntry {
  readonly source = QQ_PRIVATE_SOURCE;
  readonly replySkippedEvent = "qq_private.reply_skipped";
  private client: OneBotClient | null = null;
  /** 已建连接的参数指纹（端点/凭据/账号不变则不重建）。 */
  private clientKey: string | null = null;
  /** 入站事件串行处理链。 */
  private inbound: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lifecycle: Promise<void> = Promise.resolve();
  /** 最近一次连接中断时间（重连成功时标记接收缺口）。 */
  private disconnectedAt: number | null = null;

  constructor(private readonly deps: QqAdapterDeps) {}

  private get qqStore(): QqStore {
    return this.deps.qqStore;
  }

  private log(message: string): void {
    // 后台诊断输出（不含消息正文与秘密）
    const config = this.qqStore.getConfig();
    const token = config ? this.resolveToken(config) : null;
    process.stderr.write(`[ruukoto:qq] ${token ? message.split(token).join("<token>") : message}\n`);
  }

  get startupDisabled(): boolean {
    return this.deps.startupDisabled !== undefined;
  }

  start(): Promise<void> {
    if (this.startupDisabled) return Promise.resolve();
    return this.serial(() => this.startOnce());
  }

  private async startOnce(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.applyConfig();
    if (!this.started) return;
    const sweepMs = this.deps.timeouts?.sweepIntervalMs ?? 15_000;
    this.sweepTimer = setInterval(() => this.kickMainSession(), sweepMs);
  }

  stop(): Promise<void> {
    this.started = false;
    return this.serial(async () => {
      this.started = false;
      if (this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
      await this.disconnectClient();
      await this.inbound;
    });
  }

  /** 配置事务提交后由 Runtime 调用（含启停与连接参数变化）。 */
  onConfigChanged(): Promise<void> {
    return this.serial(async () => {
      if (!this.started) return;
      await this.applyConfig();
      this.kickMainSession();
    });
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  // ---------- 连接管理 ----------

  private resolveToken(config: QqConfig): string | null {
    if (!config.credentialName) return null;
    const binding = this.deps.credentials.getForUse(config.credentialName, { operation: QQ_CREDENTIAL_PURPOSE });
    return binding?.secret ?? null;
  }

  private async applyConfig(): Promise<void> {
    if (!this.started) return;
    const config = this.qqStore.getConfig();
    if (!config || !config.enabled) {
      await this.disconnectClient();
      return;
    }
    const token = this.resolveToken(config);
    if ((config.credentialName || config.ownerUserId) && !token) {
      this.log(`凭据 ${config.credentialName} 不可用（不存在或范围不含 ${QQ_CREDENTIAL_PURPOSE}），保持未连接`);
      await this.disconnectClient();
      return;
    }
    const key = this.connectionKey(config, token);
    if (this.client && this.clientKey === key) return;
    await this.disconnectClient();
    if (!this.started) return;
    const t = this.deps.timeouts;
    const client = new OneBotClient({
      endpoint: config.endpoint,
      token,
      onEvent: (event) => this.onOneBotEvent(event, client),
      onStateChange: (online) => {
        if (!this.started || this.client !== client) return;
        if (online) {
          // 重连成功：如实标记接收缺口（断线期间的消息不假定平台重投，不补抓）
          if (this.disconnectedAt !== null) {
            const from = new Date(this.disconnectedAt).toISOString();
            this.disconnectedAt = null;
            const to = new Date().toISOString();
            this.deps.store.withTx(() => {
              this.deps.store.appendEvent({ type: "qq.receive_gap", from, to }, {});
            });
          }
          this.kickMainSession();
          this.inbound = this.inbound.then(async () => {
            if (this.started && this.client === client) {
              await this.deps.bridge.dispatchInbound();
            }
          }).catch((err) => this.log(`QQ 入站恢复失败：${(err as Error).message}`));
        } else {
          this.disconnectedAt ??= Date.now();
        }
      },
      actionTimeoutMs: t?.actionTimeoutMs,
      probeIntervalMs: t?.probeIntervalMs,
      reconnectMinMs: t?.reconnectMinMs,
      reconnectMaxMs: t?.reconnectMaxMs,
    });
    this.client = client;
    this.clientKey = key;
    client.start();
  }

  private connectionKey(config: QqConfig, token: string | null): string {
    // 配置版本纳入代次：任何配置/凭据变化都要求重建连接，旧连接上的事件不再接纳
    return JSON.stringify([config.endpoint, config.credentialName, token, config.selfId, config.configVersion]);
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientKey = null;
    if (client) await client.stop().catch(() => {});
  }

  // ---------- 私聊任务启动门（runQueueLoop 对私聊来源事件调用） ----------

  /** 私聊来源钉住接收时的 owner 与配置版本；离线待恢复，配置变化不改发。 */
  gatePrivate(event: InboundEvent): "run" | "wait" | { drop: string } {
    // 启动配置停用与入口停用同义（ADR 0012 2026-10-06 修订）：作废而不是等待
    if (this.startupDisabled) return { drop: "qq_private_unavailable:QQ 私聊入口未启动（启动配置停用）" };
    const target = this.target();
    if (!target || !sameTarget(target, event.replyTarget) || event.source !== QQ_PRIVATE_SOURCE || event.actor !== `${QQ_PRIVATE_SOURCE}:${target.chatId}`) {
      return { drop: "qq_private_target_changed:QQ 私聊入口已停用或固定身份发生变化" };
    }
    return this.available() ? "run" : "wait";
  }

  // ---------- 私聊通知渠道（公共 outbox） ----------

  target(): NotifyTarget | null {
    const config = this.qqStore.getConfig();
    if (this.startupDisabled || !config?.enabled || !config.ownerUserId || !this.resolveToken(config)) return null;
    return { channel: QQ_PRIVATE_SOURCE, account: config.selfId, chatId: config.ownerUserId, configVersion: config.configVersion };
  }

  available(): boolean {
    const config = this.qqStore.getConfig();
    return !!(
      this.started && config && this.target() && this.client?.online && this.client.selfId === config.selfId &&
      this.clientKey === this.connectionKey(config, this.resolveToken(config))
    );
  }

  async send(input: { opId: string; target: NotifyTarget; text: string; signal: AbortSignal }): Promise<{ platformMessageId: string }> {
    if (input.signal.aborted) throw new NotSentError("canceled_before_send", "发送前已取消");
    const target = this.target();
    if (!target || !sameTarget(target, input.target)) throw new NotSentError("target_changed", "QQ 私聊固定目标已变化或停用");
    const client = this.client;
    if (!client || !this.available()) throw new NotSentError("qq_offline", "QQ 登录账号未确认在线，请求未发出");
    const message: Array<{ type: string; data: Record<string, string> }> = [];
    const op = this.deps.sched.getOp(input.opId);
    // 工作最终汇报的来源键带 #work: 后缀（issue 18），原消息引用取「#」前的入站事件 id
    const source = op?.sourceKind === "owner_reply" ? this.deps.store.getInboundEvent(op.sourceKey.split("#")[0]!) : null;
    const parts = source?.externalId.split(":");
    const replyId = parts?.length === 3 ? oneBotMessageId(parts[2]) : null;
    if (source?.source === QQ_PRIVATE_SOURCE && source.actor === `${QQ_PRIVATE_SOURCE}:${target.chatId}` &&
        parts?.[0] === target.account && parts[1] === target.chatId && replyId !== null && sameTarget(target, source.replyTarget)) {
      message.push({ type: "reply", data: { id: replyId } });
    }
    message.push({ type: "text", data: { text: input.text } });
    try {
      const data = await client.call("send_private_msg", { user_id: Number(target.chatId), message });
      const id = oneBotMessageId((data as any)?.message_id);
      if (id === null) throw new Error("QQ 发送回执缺少有效 message_id，结果未知");
      return { platformMessageId: id };
    } catch (err) {
      if (err instanceof OneBotError && err.definite) throw new NotSentError(`onebot_${err.retcode}`, err.message);
      throw err;
    }
  }

  // ---------- 拥有者 IM 入口（架构工单 10） ----------

  /** 当前配置期望的 actor（owner 身份）；未绑定/停用为 null（任何命令都不接纳）。 */
  expectedActor(): string | null {
    const config = this.qqStore.getConfig();
    return config?.enabled && config.ownerUserId ? `${QQ_PRIVATE_SOURCE}:${config.ownerUserId}` : null;
  }

  replyCapChars(): number {
    return this.qqStore.getConfig()?.maxReplyChars ?? 1500;
  }

  capReply(text: string): string {
    const chars = [...text], cap = this.replyCapChars();
    return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : text;
  }

  externalIdPrefix(target: NotifyTarget): string {
    return qqPrivateExternalId(target.account, target.chatId, "");
  }

  usesCredential(name: string): boolean {
    return this.qqStore.getConfig()?.credentialName === name;
  }

  bumpGeneration(): void {
    const c = this.qqStore.bumpConfigVersion();
    if (c) this.deps.store.appendEvent({ type: "qq.config_changed", configVersion: c.configVersion, action: "credential_changed" }, {});
  }

  /**
   * 配置/更新 NapCat OneBot 连接（拥有者操作）。端点 ws/wss：ws 仅限回环或
   * 受控私网地址，跨主机须 wss 受保护传输；非回环端点必须配置 token 凭据
   * （CredentialStore 绑定，purpose=qq_onebot，host 与端点一致；配置后 scope
   * 收紧到 qq_onebot 操作）。任何变化递增 configVersion；调用方随后重建连接并 reconcile。
   */
  configure(input: {
    endpoint: string;
    credential?: string | null;
    selfId: string;
    ownerUserId?: string | null;
    maxReplyChars?: number;
    expectedVersion?: number;
  }): QqConfig {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new RuntimeApiError("invalid_params", `端点不是合法 URL：${input.endpoint}`);
    }
    if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
      throw new RuntimeApiError("invalid_params", `端点必须是 ws:// 或 wss://：${input.endpoint}`);
    }
    const host = endpoint.hostname.toLowerCase();
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    const isPrivate =
      /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".local");
    if (endpoint.protocol === "ws:" && !isLoopback && !isPrivate) {
      throw new RuntimeApiError("invalid_params", "ws:// 明文连接仅限回环或受控私网地址；跨主机请使用 wss:// 受保护传输");
    }
    if (!/^[1-9]\d{3,19}$/.test(input.selfId) || !Number.isSafeInteger(Number(input.selfId))) {
      throw new RuntimeApiError("invalid_params", `self_id 必须是 QQ 号数字串：${input.selfId}`);
    }
    const previous = this.qqStore.getConfig();
    const credentialName = input.credential !== undefined ? input.credential : previous?.credentialName ?? null;
    const ownerUserId = input.ownerUserId !== undefined ? input.ownerUserId : previous?.ownerUserId ?? null;
    if (ownerUserId !== null && (typeof ownerUserId !== "string" || !/^[1-9]\d{3,19}$/.test(ownerUserId) || !Number.isSafeInteger(Number(ownerUserId)) || ownerUserId === input.selfId)) {
      throw new RuntimeApiError("invalid_params", "owner_user_id 必须是与登录账号不同的 QQ 号数字串");
    }
    if (ownerUserId !== null && !credentialName) {
      throw new RuntimeApiError("invalid_params", "QQ 私聊入口必须配置 token 凭据");
    }
    if (input.maxReplyChars !== undefined && (!Number.isInteger(input.maxReplyChars) || input.maxReplyChars < 100 || input.maxReplyChars > 20000)) {
      throw new RuntimeApiError("invalid_params", "max_reply_chars 必须是 100–20000 的整数");
    }
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
      throw new RuntimeApiError("invalid_params", "expected_version 必须是非负整数");
    }
    const credentials = this.deps.credentials;
    if (credentialName) {
      const cred = credentials.get(credentialName);
      if (!cred) throw new RuntimeApiError("invalid_params", `凭据绑定不存在：${credentialName}`);
      if (cred.host !== endpoint.host) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 的 host（${cred.host}）与端点 host（${endpoint.host}）不一致`);
      }
      if (cred.purpose !== QQ_CREDENTIAL_PURPOSE) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 用途是 ${cred.purpose}，QQ 入口需要 purpose=${QQ_CREDENTIAL_PURPOSE} 的凭据`);
      }
      if (cred.header.toLowerCase() !== "authorization") {
        throw new RuntimeApiError("invalid_params", `QQ 凭据须使用 authorization 头（Bearer）：${credentialName}`);
      }
      if (cred.scope && cred.scope.operations !== undefined && !cred.scope.operations.includes(QQ_CREDENTIAL_PURPOSE)) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 已有使用范围（操作 ${cred.scope.operations.join(",")}），与 qq_onebot 冲突；请另建凭据`);
      }
      if (cred.scope?.projectId !== undefined) {
        throw new RuntimeApiError("invalid_params", `凭据 ${credentialName} 已绑定项目范围（QQ 入口凭据不按项目限定）；请另建凭据`);
      }
    }
    if (!isLoopback && !credentialName) {
      throw new RuntimeApiError("invalid_params", "非回环端点必须配置 token 凭据（credential）");
    }
    let config: QqConfig;
    try {
      config = this.deps.store.withTx(() => {
        const c = this.qqStore.upsertConfig({
          endpoint: endpoint.toString(),
          credentialName,
          selfId: input.selfId,
          ownerUserId,
          maxReplyChars: input.maxReplyChars,
          expectedVersion: input.expectedVersion,
        });
        this.deps.store.appendEvent({ type: "qq.config_changed", configVersion: c.configVersion, action: "upsert" }, {});
        return c;
      });
    } catch (err) {
      if (err instanceof QqVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    // 凭据 scope 收紧到 qq_onebot 操作：通用 http_request 与其他入口不得借用
    if (config.credentialName) {
      const cred = credentials.get(config.credentialName)!;
      const ops = cred.scope?.operations;
      credentials.upsert({
        ...cred,
        scope: { ...cred.scope, operations: ops ? [...new Set([...ops, QQ_CREDENTIAL_PURPOSE])] : [QQ_CREDENTIAL_PURPOSE] },
      });
    }
    return config;
  }

  /** 一键停用/启用（事务与配置事件）；调用方随后断开/重建连接并 reconcile。 */
  setEnabled(enabled: boolean, expectedVersion?: number): QqConfig {
    let config: QqConfig | null;
    try {
      config = this.deps.store.withTx(() => {
        const prev = this.qqStore.getConfig();
        const c = this.qqStore.setEnabled(enabled, expectedVersion);
        // 同值调用不递增版本（无变化），也不产生无变化的配置事件
        if (c && c.configVersion !== prev?.configVersion) {
          this.deps.store.appendEvent({ type: "qq.config_changed", configVersion: c.configVersion, action: enabled ? "enabled" : "disabled" }, {});
        }
        return c;
      });
    } catch (err) {
      if (err instanceof QqVersionConflictError) throw new RuntimeApiError(err.code, err.message);
      throw err;
    }
    if (!config) throw new RuntimeApiError("not_found", "QQ 入口未配置（先 qq_configure）");
    return config;
  }

  // ---------- OneBot 事件 ----------

  private onOneBotEvent(event: Record<string, unknown>, client: OneBotClient): void {
    // 串行处理：私聊与撤回按到达顺序生效
    this.inbound = this.inbound.then(() => this.client === client ? this.handleEvent(event) : undefined)
      .catch((err) => this.log(`事件处理失败：${(err as Error).message}`));
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    if (!this.started) return;
    const config = this.qqStore.getConfig();
    if (!config || !config.enabled) return;
    // 身份核对：连接核实账号与事件 self_id 都必须等于预期登录账号
    if (!this.client || !this.client.online || this.client.selfId !== config.selfId) return;
    if (this.clientKey !== this.connectionKey(config, this.resolveToken(config))) return;
    if (oneBotAccountId(event["self_id"]) !== config.selfId) return;

    if (event["post_type"] === "message" && event["message_type"] === "private") {
      await this.handlePrivateMessage(config, event);
    } else if (event["post_type"] === "notice" && event["notice_type"] === "group_recall") {
      await this.handleRecall(config, event);
    }
    // 群消息（issue 20 退役）与 message_sent（自身回声）/请求/元事件：不产生任务
  }

  private async handlePrivateMessage(config: QqConfig, event: Record<string, unknown>): Promise<void> {
    const owner = oneBotAccountId(event["user_id"]);
    const messageId = oneBotMessageId(event["message_id"]);
    const target = this.target();
    if (!target || !owner || !this.available() || event["sub_type"] !== "friend" || owner !== config.ownerUserId ||
        owner === config.selfId || messageId === null || event["group_id"] != null) return;
    const sender = event["sender"] as Record<string, unknown> | undefined;
    if (sender?.["user_id"] !== undefined && oneBotAccountId(sender["user_id"]) !== owner) return;
    // 只解析结构化文本、图片与 reply ID；字符串中的 CQ 码没有可靠的类型边界。
    const segments = event["message"];
    if (!Array.isArray(segments)) return;
    const texts: string[] = [];
    const media: InboundMediaDownload[] = [];
    const client = this.client!;
    let replyId: string | null = null;
    for (const seg of segments) {
      if (seg?.type === "text" && typeof seg.data?.text === "string") texts.push(seg.data.text);
      else if (seg?.type === "reply" && replyId === null && oneBotMessageId(seg.data?.id) !== null) replyId = oneBotMessageId(seg.data.id);
      else if (seg?.type === "image") media.push({
        declaredMime: typeof seg.data?.mime_type === "string" ? seg.data.mime_type : undefined,
        sizeBytes: typeof seg.data?.file_size === "number" ? seg.data.file_size : undefined,
        download: (signal) => this.downloadImage(client, seg.data, signal),
      });
      else return;
    }
    const text = texts.join("");
    if (media.length === 0 && (!text.trim() || [...text].length > MAX_INBOUND_TEXT_CHARS)) return;
    const timestamp = typeof event["time"] === "number" ? new Date(event["time"] * 1000) : null;
    const time = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "未知";
    const body = [`[QQ 私聊] account ${config.selfId} user ${owner} message ${messageId} 时间 ${time}`];
    if (replyId !== null) body.push(`回复关联：message ${replyId}（未读取引用原文）`);
    body.push("正文：", text);
    const input = {
      externalId: qqPrivateExternalId(config.selfId, owner, messageId),
      actor: `${QQ_PRIVATE_SOURCE}:${owner}`,
      body: body.join("\n"),
      replyTarget: target,
    };
    if (media.length > 0) {
      await this.deps.media.stage({ ...input, source: QQ_PRIVATE_SOURCE, media });
      if (!this.started || this.client !== client || !sameTarget(target, this.target())) return;
      await this.deps.bridge.registerPrivate({ ...input, media: true });
      return;
    }
    await this.deps.bridge.registerPrivate({
      ...input,
      // 原始发送文本（未加模板/引用摘录）：宿主据此识别审批命令；引用内容不进入此字段
      commandText: text,
    });
  }

  private async downloadImage(client: OneBotClient, data: any, signal: AbortSignal): Promise<Response> {
    let source = typeof data?.url === "string" && data.url ? data.url : data?.file;
    if (typeof source !== "string" || !source) throw new MediaError("download_unavailable");
    if (!/^https?:\/\//i.test(source)) {
      // file 是 OneBot 文件标识；远程服务的本地路径不可作为宿主文件读取。
      let result: any;
      try { result = await client.call("get_image", { file: source }, signal); }
      catch (err) {
        if (err instanceof OneBotError && err.definite) throw new MediaError("download_unavailable");
        throw err;
      }
      source = typeof result?.url === "string" && result.url ? result.url : result?.file;
    }
    let url: URL;
    try { url = new URL(source); } catch { throw new MediaError("download_unavailable"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new MediaError("download_unavailable");
    return fetch(url, { signal });
  }

  /**
   * 撤回（issue 20 收窄）：只给已登记的旧群收件打标记——已接收群结果的撤回
   * 复核仍然有效；不再取消任务、不补发回复、不再派发。未登记的消息不宣称
   * 已知撤回；重复事件幂等。
   */
  private async handleRecall(config: QqConfig, event: Record<string, unknown>): Promise<void> {
    const groupId = String(event["group_id"] ?? "");
    const messageId = event["message_id"] === undefined || event["message_id"] === null ? "" : String(event["message_id"]);
    if (!groupId || !messageId) return;
    this.qqStore.markRecalled(config.selfId, groupId, messageId);
  }

  private kickMainSession(): void {
    const main = this.deps.store.getAgentRole("main");
    if (main) this.deps.bridge.kickSession(main.sessionId);
  }

  /** 启动配置停用的状态：与连接异常区分标注（产品边界 / dev 开发实例两种来源）；无连接与账号字段。 */
  private disabledStatus(by: "product" | "dev") {
    return {
      configured: this.qqStore.getConfig() !== null,
      enabled: false as const,
      online: false as const,
      disabledByConfig: true,
      stateDetail: by === "product" ? "Coding Agent（ruukoto-code）不连接消息平台" : "已由启动配置停用（dev 开发实例不连接真实 QQ 通道）",
    };
  }

  /** 管理视图（不含 token 与消息正文以外的秘密；连接状态为运行期事实）。 */
  status() {
    const config = this.qqStore.getConfig();
    if (this.deps.startupDisabled) return this.disabledStatus(this.deps.startupDisabled);
    return {
      configured: config !== null,
      enabled: config?.enabled ?? false,
      endpoint: config?.endpoint ?? null,
      credentialName: config?.credentialName ?? null,
      selfId: config?.selfId ?? null,
      ownerUserId: config?.ownerUserId ?? null,
      /** 历史值（核心群聊已退役，issue 20）：只读展示，不再有写入口。 */
      groups: config?.groups ?? [],
      maxReplyChars: config?.maxReplyChars ?? null,
      configVersion: config?.configVersion ?? 0,
      online: this.client?.online ?? false,
      actualSelfId: this.client?.selfId ?? null,
      stateDetail: this.client?.stateDetail ?? "未连接",
      /** 旧群会话映射（只读归档视图；退役后不再有排队/执行任务）。 */
      sessions: this.qqStore.listGroupSessions().map((gs) => ({
        groupId: gs.groupId,
        sessionId: gs.sessionId,
        workDir: gs.workDir,
        queued: this.deps.store.listQueuedTasksFifo(gs.sessionId).length,
        active: this.deps.store.listTasksByStatus(["running", "awaiting_confirmation"]).some((t) => t.sessionId === gs.sessionId),
      })),
    };
  }
}
