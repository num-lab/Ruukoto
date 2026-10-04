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
 * - 私聊只接绑定拥有者的好友纯文本；发送目标由宿主固定，断线不重投；
 *   超时/断线/崩溃 = unknown（effect_unknown，不自动重发）。
 */

import type { Store } from "../core/store.ts";
import type { InboundEvent, NotifyTarget } from "../core/types.ts";
import { sameTarget } from "../core/notify-target.ts";
import type { CredentialStore } from "../agent/execution/credentials.ts";
import { OneBotClient, OneBotError, oneBotAccountId, oneBotMessageId } from "./onebot.ts";
import type { QqConfig, QqStore } from "./store.ts";
import type { SchedulerStore } from "../scheduler/store.ts";
import { NotSentError, type NotifyChannel } from "../scheduler/runtime.ts";

/** QQ 入口凭据用途（CredentialStore 绑定 purpose 与 scope.operations）。 */
export const QQ_CREDENTIAL_PURPOSE = "qq_onebot";
export const QQ_PRIVATE_SOURCE = "qq_private";

export function qqPrivateExternalId(account: string, owner: string, messageId: string | number): string {
  return `${account}:${owner}:${messageId}`;
}

/** 适配器需要的 Runtime 窄接口（宿主注入；除此之外的能力适配器不可见）。 */
export interface QqRuntimeBridge {
  registerPrivate(input: { externalId: string; actor: string; body: string; replyTarget: NotifyTarget; commandText?: string }): Promise<unknown>;
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
  bridge: QqRuntimeBridge;
  timeouts?: QqAdapterTimeouts;
}

/** 任务启动门结论（runQueueLoop 在占用目录前调用）。 */
export type QqStartGateResult = "run" | "wait" | { drop: string };

/** 入站消息正文字符上限（事件大小校验；超出登记 skipped，不入队）。 */
const MAX_INBOUND_TEXT_CHARS = 8192;

export class QqAdapter implements NotifyChannel {
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

  start(): Promise<void> {
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
  gatePrivate(event: InboundEvent): QqStartGateResult {
    const target = this.target();
    if (!target || !sameTarget(target, event.replyTarget) || event.source !== QQ_PRIVATE_SOURCE || event.actor !== `${QQ_PRIVATE_SOURCE}:${target.chatId}`) {
      return { drop: "qq_private_target_changed:QQ 私聊入口已停用或固定身份发生变化" };
    }
    return this.available() ? "run" : "wait";
  }

  // ---------- 私聊通知渠道（公共 outbox） ----------

  target(): NotifyTarget | null {
    const config = this.qqStore.getConfig();
    if (!config?.enabled || !config.ownerUserId || !this.resolveToken(config)) return null;
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
    // 只解析结构化文本与 reply ID；字符串中的 CQ 码没有可靠的类型边界。
    const segments = event["message"];
    if (!Array.isArray(segments)) return;
    const texts: string[] = [];
    let replyId: string | null = null;
    for (const seg of segments) {
      if (seg?.type === "text" && typeof seg.data?.text === "string") texts.push(seg.data.text);
      else if (seg?.type === "reply" && replyId === null && oneBotMessageId(seg.data?.id) !== null) replyId = oneBotMessageId(seg.data.id);
      else return;
    }
    const text = texts.join("");
    if (!text.trim() || [...text].length > MAX_INBOUND_TEXT_CHARS) return;
    const timestamp = typeof event["time"] === "number" ? new Date(event["time"] * 1000) : null;
    const time = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "未知";
    const body = [`[QQ 私聊] account ${config.selfId} user ${owner} message ${messageId} 时间 ${time}`];
    if (replyId !== null) body.push(`回复关联：message ${replyId}（未读取引用原文）`);
    body.push("正文：", text);
    await this.deps.bridge.registerPrivate({
      externalId: qqPrivateExternalId(config.selfId, owner, messageId),
      actor: `${QQ_PRIVATE_SOURCE}:${owner}`,
      body: body.join("\n"),
      replyTarget: target,
      // 原始发送文本（未加模板/引用摘录）：宿主据此识别审批命令；引用内容不进入此字段
      commandText: text,
    });
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

  /** 管理视图（不含 token 与消息正文以外的秘密；连接状态为运行期事实）。 */
  status() {
    const config = this.qqStore.getConfig();
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
      queueTtlMs: config?.queueTtlMs ?? null,
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

/**
 * 撤回消息的上下文过滤（Driver 在每次模型调用前执行）：移出带撤回标记的
 * user 消息及其后的 assistant 回复（QQ 任务无工具调用，无配对约束问题）。
 * 只改模型视图，不改写历史原文。
 *
 * 核心群聊退役后不再有新群任务运行；本函数与 Driver 的 qq_group 分支一并
 * 留给 issue 23 清理。
 */
export function filterRecalledQqMessages(messages: any[], recalledTags: Set<string>): any[] {
  if (recalledTags.size === 0) return messages;
  const textOf = (m: any): string => {
    const content = m?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).join("");
    }
    return "";
  };
  const out: any[] = [];
  let skipping = false;
  for (const m of messages) {
    if (m?.role === "user") {
      skipping = false;
      const text = textOf(m);
      for (const tag of recalledTags) {
        if (text.startsWith(tag)) {
          skipping = true;
          break;
        }
      }
    }
    if (!skipping) out.push(m);
  }
  return out;
}
