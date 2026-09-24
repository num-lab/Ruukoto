/**
 * QQ 适配器：群聊与 owner 私聊共用 NapCat 连接与编排器，发送账本分别保存。
 *
 * 边界与纪律：
 * - 窄入口：只经 QqRuntimeBridge 调用 Runtime 的少量方法；不持有拥有者
 *   token，不能审批、改权限、开完全访问或读取其他项目资料；
 * - 触发：群消息含结构化 @机器人 段（不按显示名/正文 @ 字符匹配）；纯文本，
 *   图片/语音/附件/转发等非文本段整条忽略；自身消息与 message_sent 回声不触发；
 * - 收件先登记（dedup_key = account:group:message_id）再入队；登记与任务创建
 *   之间的崩溃由恢复路径按原请求键核实重提，不换新键；
 * - 回复目标由宿主固定（原群 + 可选引用段），模型只产生候选正文；每次任务
 *   一条最终文本回复，超长缩短，不自动拆分、不转发中间过程/错误栈；
 * - 发送先落 qq_outbox（pending）再调用动作；平台明确失败 = failed，超时/
 *   断线/崩溃 = unknown（effect_unknown，不自动重发）；撤回取消未发送回复，
 *   已发送不自动撤回；
 * - 账号离线/身份不匹配时停止接收新任务与发送（排队任务等待，超过
 *   queue_ttl_ms 由启动门过期跳过）；断线重连不自动发送失效回复。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "../core/store.ts";
import type { InboundEvent, NotifyTarget, PersistentEvent, Project, Session, Task } from "../core/types.ts";
import { ACTIVE_TASK_STATUSES } from "../core/types.ts";
import type { CredentialStore } from "../agent/execution/credentials.ts";
import { OneBotClient, OneBotError, oneBotAccountId, oneBotMessageId } from "./onebot.ts";
import { QQ_GROUP_SOURCE, qqDedupKey, qqMessageTag, type QqConfig, type QqInboxRow, type QqStore } from "./store.ts";
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
  registerPrivate(input: { externalId: string; actor: string; body: string; replyTarget: NotifyTarget }): Promise<unknown>;
  dispatchInbound(): Promise<unknown>;
  registerGroup(dedupKey: string): Promise<void>;
  cancelTask(taskId: string): Promise<Task>;
  findProjectByName(name: string): Project | null;
  createProject(name: string): Project;
  createSession(input: { projectId: string; cwd: string; kind: "qq_group" }): Promise<Session>;
  /** 按原任务读取最终回答；恢复不能误取同会话后续任务的回答。 */
  readTaskReplyText(taskId: string): string | null;
  resumeQueue(sessionId: string): Promise<Session>;
  kickSession(sessionId: string): void;
}

export interface QqAdapterTimeouts {
  actionTimeoutMs?: number;
  probeIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** 排队过期/启停状态巡检间隔（默认 15s；测试可压短）。 */
  sweepIntervalMs?: number;
  /** 排队过期毫秒数（仅测试注入；生产固定取配置默认 300000，不可经配置修改）。 */
  queueTtlMs?: number;
}

export interface QqAdapterDeps {
  store: Store;
  qqStore: QqStore;
  sched: SchedulerStore;
  credentials: CredentialStore;
  /** 后台数据目录（群工作目录在其兄弟目录 qq-work/ 下，避开保护根）。 */
  dataDir: string;
  bridge: QqRuntimeBridge;
  timeouts?: QqAdapterTimeouts;
}

/** 任务启动门结论（runQueueLoop 在占用目录前调用）。 */
export type QqStartGateResult = "run" | "wait" | { drop: string };

/** 引用原文进入上下文的长度上限（仅本群已接纳交互可被引用）。 */
const QUOTE_TEXT_CAP = 200;

/** 入站消息正文字符上限（事件大小校验；超出登记 skipped，不入队）。 */
const MAX_INBOUND_TEXT_CHARS = 8192;

export class QqAdapter implements NotifyChannel {
  private client: OneBotClient | null = null;
  /** 已建连接的参数指纹（端点/凭据/账号不变则不重建）。 */
  private clientKey: string | null = null;
  /** 入站事件串行处理链（同群会话创建与入队不乱序）。 */
  private inbound: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private recoverReplies = true;
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
    // 崩溃窗口核对：遗留 pending 发送一律定 unknown（effect_unknown，不重发）
    const reconciled = this.qqStore.reconcilePendingOutboxOnBoot();
    if (reconciled > 0) this.log(`启动核对：${reconciled} 条发送结果不明（unknown）`);
    // 恢复：已登记未入队的消息按原请求键核实重提（幂等，不换新键）
    await this.recoverInbox();
    // QQ 会话无工具执行与外部副作用（发送走 outbox 纪律），后台重启后的
    // 队列暂停由适配器自动恢复，不要求拥有者逐群 resume_queue
    for (const gs of this.qqStore.listGroupSessions()) {
      const session = this.deps.store.getSession(gs.sessionId);
      if (session && session.queueState === "paused") {
        await this.deps.bridge.resumeQueue(session.id).catch((err) => this.log(`恢复群 ${gs.groupId} 队列失败：${(err as Error).message}`));
      }
    }
    await this.applyConfig();
    if (!this.started) return;
    const sweepMs = this.deps.timeouts?.sweepIntervalMs ?? 15_000;
    this.sweepTimer = setInterval(() => this.kickAllQqSessions(), sweepMs);
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

  /** 配置事务提交后由 Runtime 调用（含启停、群列表、连接参数变化）。 */
  onConfigChanged(): Promise<void> {
    return this.serial(async () => {
      if (!this.started) return;
      await this.applyConfig();
      await this.cancelInvalidGroupWork();
      this.kickAllQqSessions();
    });
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** 群被移出允许列表：该群排队/运行中任务按既有取消机制收尾，未发送回复取消。 */
  async onGroupRemoved(groupId: string): Promise<void> {
    await this.cancelQqWork(groupId);
    this.kickAllQqSessions();
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
      const wasEnabled = this.client !== null;
      await this.disconnectClient();
      // 一键停用：阻止新的接收（连接已断）与后续发送，运行中任务按取消机制收尾
      if (config && !config.enabled && wasEnabled) await this.cancelQqWork(null);
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
          this.kickAllQqSessions();
          this.inbound = this.inbound.then(async () => {
            if (this.started && this.client === client) {
              await this.deps.bridge.dispatchInbound();
              if (this.recoverReplies) {
                this.recoverCompletedInbox();
                this.recoverReplies = false;
              }
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
    this.client.start();
  }

  private connectionKey(config: QqConfig, token: string | null): string {
    return JSON.stringify([config.endpoint, config.credentialName, token, config.selfId]);
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientKey = null;
    if (client) await client.stop().catch(() => {});
  }

  // ---------- 任务启动门（Runtime.runQueueLoop 对 qq_group 会话调用） ----------

  /**
   * 入队后、模型调用前的范围/启停/在线/过期核对。wait = 暂不启动（留在队列，
   * 上线或巡检时重新尝试）；drop = 过期或越权，跳过（取消，不回复）。
   */
  gate(session: Session, task: Task): QqStartGateResult {
    const config = this.qqStore.getConfig();
    if (!config || !config.enabled) return { drop: "qq_disabled:QQ 入口已停用" };
    const gs = this.qqStore.getGroupSessionBySessionId(session.id);
    if (!gs) return { drop: "qq_session_unmapped:群会话映射缺失" };
    if (!config.groups.includes(gs.groupId)) return { drop: "qq_group_not_allowed:群已移出允许列表" };
    if (config.selfId !== gs.account) return { drop: "qq_account_changed:登录账号已变化" };
    const row = this.qqStore.getInboxByTask(task.id);
    if (row && this.qqStore.isInboxRecalled(row)) {
      return { drop: "qq_recalled:消息或引用已撤回" };
    }
    const ttlMs = this.deps.timeouts?.queueTtlMs ?? config.queueTtlMs;
    const ageMs = Date.now() - Date.parse(task.createdAt);
    if (Number.isFinite(ageMs) && ageMs > ttlMs) {
      return { drop: `qq_queue_expired:排队超过 ${ttlMs}ms 未开始执行` };
    }
    if (!this.client || !this.client.online || this.client.selfId !== config.selfId) return "wait";
    return "run";
  }

  /** 派发与模型启动共用：只认宿主持久收件和每群绑定，正文不能选择目标。 */
  gateGroup(event: InboundEvent): QqStartGateResult {
    const row = this.qqStore.getInbox(event.externalId);
    const config = this.qqStore.getConfig();
    const mapping = row ? this.qqStore.getGroupSession(row.account, row.groupId) : null;
    const session = mapping ? this.deps.store.getSession(mapping.sessionId) : null;
    if (!row || !mapping || !session || session.kind !== "qq_group" || session.projectId !== mapping.projectId ||
        row.sessionId !== session.id || event.source !== QQ_GROUP_SOURCE || event.targetRole !== "chat" ||
        event.actor !== row.userId || event.body !== row.input) return { drop: "qq_group_binding_changed:群入站绑定无效" };
    if (!config?.enabled || config.selfId !== row.account || !config.groups.includes(row.groupId)) return { drop: "qq_group_disabled:群或账号已停用" };
    const expected = { channel: QQ_GROUP_SOURCE, account: row.account, chatId: row.groupId, configVersion: config.configVersion };
    if (!sameTarget(expected, event.replyTarget)) return { drop: "qq_group_config_changed:群入站配置版本已失效" };
    if (this.qqStore.isInboxRecalled(row)) {
      return { drop: "qq_recalled:消息或引用已撤回" };
    }
    const task = event.taskId ? this.deps.store.getTask(event.taskId) : this.deps.store.findTaskByRequest(session.id, row.requestId);
    const ttl = this.deps.timeouts?.queueTtlMs ?? config.queueTtlMs;
    if (!task?.startedAt && Date.now() - Date.parse(row.createdAt) > ttl) return { drop: "qq_queue_expired:群消息等待超过有效期" };
    return this.started && this.client?.online && this.client.selfId === config.selfId &&
      this.clientKey === this.connectionKey(config, this.resolveToken(config)) ? "run" : "wait";
  }

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
    const source = op?.sourceKind === "owner_reply" ? this.deps.store.getInboundEvent(op.sourceKey) : null;
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
    // 串行处理：同群会话创建/入队不并发，撤回与触发按到达顺序生效
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

    if (event["post_type"] === "message" && event["message_type"] === "group") {
      await this.handleGroupMessage(config, event);
    } else if (event["post_type"] === "message" && event["message_type"] === "private") {
      await this.handlePrivateMessage(config, event);
    } else if (event["post_type"] === "notice" && event["notice_type"] === "group_recall") {
      await this.handleRecall(config, event);
    }
    // message_sent（自身回声）/请求/元事件：不产生任务
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
    await this.deps.bridge.registerPrivate({ externalId: qqPrivateExternalId(config.selfId, owner, messageId), actor: `${QQ_PRIVATE_SOURCE}:${owner}`, body: body.join("\n"), replyTarget: target });
  }

  private async handleGroupMessage(config: QqConfig, event: Record<string, unknown>): Promise<void> {
    const groupId = String(event["group_id"] ?? "");
    const userId = String(event["user_id"] ?? "");
    const messageId = event["message_id"] === undefined || event["message_id"] === null ? "" : String(event["message_id"]);
    if (!groupId || !userId || !messageId) return;
    if (userId === config.selfId) return; // 机器人自身消息不重复触发
    if (!config.groups.includes(groupId)) return;

    const segments = event["message"];
    if (!Array.isArray(segments)) return; // 非结构化消息（CQ 码字符串）：首版不支持
    let atBot = false;
    let replyTo: string | null = null;
    const textParts: string[] = [];
    for (const seg of segments as Array<Record<string, any>>) {
      if (!seg || typeof seg !== "object") return;
      if (seg.type === "at") {
        if (String(seg.data?.qq ?? "") === config.selfId) atBot = true;
        continue;
      }
      if (seg.type === "text") {
        textParts.push(String(seg.data?.text ?? ""));
        continue;
      }
      if (seg.type === "reply") {
        replyTo = seg.data?.id === undefined || seg.data?.id === null ? null : String(seg.data.id);
        continue;
      }
      return; // 图片/语音/附件/转发等：首版整条忽略，不伪造原文
    }
    if (!atBot) return; // 只认结构化 @ 段，不匹配显示名或正文 @ 字符
    const text = textParts.join("").trim();
    if (!text) return;

    const sender = (event["sender"] ?? {}) as Record<string, unknown>;
    const senderName = String(sender["card"] || sender["nickname"] || userId);
    const messageTime = typeof event["time"] === "number" ? new Date(event["time"] * 1000).toISOString() : null;
    // 事件大小与过期校验（与重复接收分别校验）：超大或已超排队过期时长
    // （如断线期间的离线 backlog 被重投）的消息登记 skipped，明确处理结果
    const oversize = [...text].length > MAX_INBOUND_TEXT_CHARS;
    const ttlMs = this.deps.timeouts?.queueTtlMs ?? config.queueTtlMs;
    const stale = messageTime !== null && Date.now() - Date.parse(messageTime) > ttlMs;

    // 引用原文仅在其属于本群已接纳交互时进入上下文（不主动抓取其他历史）
    let quotePart = "";
    if (replyTo && !oversize && !stale) {
      const quoted = this.qqStore.getInbox(qqDedupKey(config.selfId, groupId, replyTo));
      if (quoted && !quoted.recalled) {
        const quotedText = [...quoted.text].slice(0, QUOTE_TEXT_CAP).join("");
        quotePart = `\n> 引用 ${quoted.userId}: ${quotedText}`;
      }
    }
    const taskInput = `${qqMessageTag(groupId, messageId)} ${senderName}(${userId}): ${text}${quotePart}`;

    // 先登记（幂等去重），再入队；重复事件直接结束
    const { created, row } = this.qqStore.registerInbox({
      account: config.selfId,
      groupId,
      userId,
      senderName,
      messageId,
      text: [...text].slice(0, MAX_INBOUND_TEXT_CHARS + 1).join(""),
      taskInput,
      messageTime,
      replyToMessageId: quotePart ? replyTo : null,
      configVersion: config.configVersion,
    });
    if (!created) return;
    if (oversize || stale) {
      this.qqStore.setInboxStatus(row.dedupKey, "skipped");
      this.log(`消息 ${row.dedupKey} ${oversize ? `超大（>${MAX_INBOUND_TEXT_CHARS} 字符）` : "已过排队有效期"}，登记跳过`);
      return;
    }
    await this.enqueueInbox(config, row);
  }

  /** 登记 → 入队（恢复路径共用；按 row.requestId/row.input 原键原文提交）。 */
  private async enqueueInbox(config: QqConfig, row: QqInboxRow): Promise<void> {
    try {
      const gs = await this.ensureGroupSession(config, row.groupId);
      this.qqStore.bindInboxSession(row.dedupKey, gs.sessionId);
      await this.deps.bridge.registerGroup(row.dedupKey);
    } catch (err) {
      // 入队失败（停止中/模型不可用等）：保持 registered，由下次启动的恢复
      // 路径按原请求键重提；不标 skipped（避免瞬时故障永久丢消息）
      this.log(`消息 ${row.dedupKey} 入队失败（保持已登记待恢复）：${(err as Error).message}`);
    }
  }

  /** 登录账号+群 → 独立项目/会话/专用空工作目录（首次触发时创建）。 */
  private async ensureGroupSession(config: QqConfig, groupId: string) {
    const existing = this.qqStore.getGroupSession(config.selfId, groupId);
    if (existing) return existing;
    const projectName = `qq-${config.selfId}-${groupId}`;
    const project = this.deps.bridge.findProjectByName(projectName) ?? this.deps.bridge.createProject(projectName);
    const sanitize = (s: string): string => s.replace(/[^0-9A-Za-z_-]/g, "_");
    const workDir = path.join(
      path.dirname(path.resolve(this.deps.dataDir)),
      "qq-work",
      `${sanitize(config.selfId)}_${sanitize(groupId)}`,
    );
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const session = await this.deps.bridge.createSession({ projectId: project.id, cwd: workDir, kind: "qq_group" });
    this.qqStore.insertGroupSession({
      account: config.selfId,
      groupId,
      sessionId: session.id,
      projectId: project.id,
      workDir,
    });
    return this.qqStore.getGroupSession(config.selfId, groupId)!;
  }

  /** 撤回：标记（后续上下文排除由 Driver 过滤执行），取消未完成任务与未发送回复。 */
  private async handleRecall(config: QqConfig, event: Record<string, unknown>): Promise<void> {
    const groupId = String(event["group_id"] ?? "");
    const messageId = event["message_id"] === undefined || event["message_id"] === null ? "" : String(event["message_id"]);
    if (!groupId || !messageId) return;
    const row = this.qqStore.markRecalled(config.selfId, groupId, messageId);
    if (!row) return; // 未登记或已标记（撤回事件丢失时不能宣称已知撤回；重复事件幂等）
    // 连同已保存的引用交互一起取消，避免撤回原文经引用继续进入模型。
    const affected = this.qqStore.listPendingInbox().filter((item) =>
      item.account === row.account && item.groupId === row.groupId && (item.messageId === row.messageId || item.replyToMessageId === row.messageId));
    for (const item of affected) if (item.taskId) {
      const task = this.deps.store.getTask(item.taskId);
      if (task && (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) {
        await this.deps.bridge.cancelTask(task.id).catch((err) => this.log(`撤回取消任务失败：${(err as Error).message}`));
      }
      for (const ob of this.qqStore.listPendingOutbox()) {
        if (ob.taskId === item.taskId) {
          this.qqStore.settleOutbox(ob.opId, "unknown", { error: "消息撤回时发送已在途，结果未知（effect_unknown）" });
          this.qqStore.setInboxStatus(item.dedupKey, "reply_unknown");
        }
      }
    }
    await this.deps.bridge.dispatchInbound();
  }

  // ---------- 运行时事件（任务终态 → 发送回复） ----------

  /** Runtime 事件监听（持久事件提交后调用）。 */
  onRuntimeEvents(events: PersistentEvent[]): void {
    if (!this.started) return;
    for (const ev of events) {
      const body = ev.body;
      if (body.type === "task.completed" || (body.type === "child_task.completed" && body.agentId === "chat")) {
        const inbox = this.qqStore.getInboxByTask(body.taskId);
        if (inbox) {
          void this.sendReply(inbox).catch((err) => this.log(`回复 ${inbox.dedupKey} 发送流程异常：${(err as Error).message}`));
        }
      } else if (body.type === "task.failed" || body.type === "task.canceled" || body.type === "task.interrupted") {
        const inbox = this.qqStore.getInboxByTask(body.taskId);
        // 任务未成功完成：不发送回复（错误栈/中间过程不进群），如实登记
        if (inbox && inbox.status === "queued") this.qqStore.setInboxStatus(inbox.dedupKey, "skipped");
      }
    }
  }

  /**
   * 发送最终回复：发送前再次核对启停/群范围/账号/在线/撤回；先落 outbox
   * （pending）再调用动作；平台明确失败 = failed，超时/断线 = unknown
   * （effect_unknown，不自动换键重发）；断线重连不补发。
   */
  private async sendReply(inbox: QqInboxRow): Promise<void> {
    if (!inbox.taskId || !inbox.sessionId) return;
    // 任务完成监听与编排器补记结果共用同一发送键；任何已登记发送都不重放。
    if (this.qqStore.getOutboxByTask(inbox.taskId)) return;
    const event = this.deps.store.findInboundEvent(QQ_GROUP_SOURCE, inbox.dedupKey);
    if (event && this.gateGroup(event) !== "run") {
      this.qqStore.setInboxStatus(inbox.dedupKey, "skipped");
      return;
    }
    const config = this.qqStore.getConfig();
    if (!config || !config.enabled || !config.groups.includes(inbox.groupId) || config.selfId !== inbox.account) {
      this.qqStore.setInboxStatus(inbox.dedupKey, "skipped");
      return;
    }
    // 发送前再次核对原消息是否撤回
    const fresh = this.qqStore.getInbox(inbox.dedupKey);
    if (!fresh || fresh.recalled || fresh.status !== "queued") {
      this.qqStore.setInboxStatus(inbox.dedupKey, "skipped");
      return;
    }
    const client = this.client;
    if (!client || !client.online || client.selfId !== config.selfId) {
      // 明确未发送（不是 unknown）：重连不自动补发失效回复
      this.qqStore.setInboxStatus(inbox.dedupKey, "reply_failed");
      return;
    }
    const rawText = this.deps.bridge.readTaskReplyText(inbox.taskId);
    const trimmed = rawText?.trim() ?? "";
    if (!trimmed) {
      this.qqStore.setInboxStatus(inbox.dedupKey, "reply_failed");
      this.log(`任务 ${inbox.taskId} 完成但无 assistant 文本，未发送`);
      return;
    }
    // 单条回复，超过长度上限即缩短（上限值未经真实平台核实，见配置说明）
    let text = trimmed;
    const chars = [...text];
    if (chars.length > config.maxReplyChars) {
      text = chars.slice(0, Math.max(1, config.maxReplyChars - 1)).join("") + "…";
    }
    const outbox = this.qqStore.createPendingOutbox({
      taskId: inbox.taskId,
      account: inbox.account,
      groupId: inbox.groupId,
      replyToMessageId: inbox.messageId,
      text,
    });
    try {
      const data = await client.call("send_group_msg", {
        group_id: Number(inbox.groupId),
        message: [
          { type: "reply", data: { id: Number(inbox.messageId) } },
          { type: "text", data: { text } },
        ],
      });
      const sentId = (data as any)?.message_id;
      if (oneBotMessageId(sentId) === null) throw new Error("QQ 发送回执缺少有效 message_id，结果未知");
      if (!this.qqStore.settleOutbox(outbox.opId, "sent", { sentMessageId: sentId === undefined || sentId === null ? null : String(sentId) })) {
        this.qqStore.noteLateOutcome(outbox.opId, `取消后平台返回成功（message_id=${String(sentId)}）`);
        this.qqStore.setInboxStatus(inbox.dedupKey, "reply_unknown");
        return;
      }
      this.qqStore.setInboxStatus(inbox.dedupKey, "done");
    } catch (err) {
      const definite = err instanceof OneBotError && err.definite;
      const status = definite ? "failed" : "unknown";
      if (!this.qqStore.settleOutbox(outbox.opId, status, { error: (err as Error).message })) {
        this.qqStore.noteLateOutcome(outbox.opId, `取消后平台返回：${(err as Error).message}`);
        this.qqStore.setInboxStatus(inbox.dedupKey, "reply_unknown");
        return;
      }
      this.qqStore.setInboxStatus(inbox.dedupKey, definite ? "reply_failed" : "reply_unknown");
    }
  }

  // ---------- 恢复 / 停用 / 状态 ----------

  /** 已登记未入队的记录按原请求键核实重提（submit 幂等：已存在则关联原任务）。 */
  private async recoverInbox(): Promise<void> {
    const config = this.qqStore.getConfig();
    for (const row of this.qqStore.listPendingInbox()) {
      if (!config || !config.enabled || !config.groups.includes(row.groupId) || config.selfId !== row.account) {
        this.qqStore.setInboxStatus(row.dedupKey, "skipped");
        continue;
      }
      await this.enqueueInbox(config, row);
    }
  }

  /** 启动时补齐完成与发送登记之间的窗口；普通断线重连不重发已判定的回复。 */
  private recoverCompletedInbox(): void {
    for (const row of this.qqStore.listPendingInbox()) {
      if (!row.taskId) continue;
      const outbox = this.qqStore.getOutboxByTask(row.taskId);
      if (outbox) {
        // 启动遗留 pending 已在 startOnce 定为 unknown；此时 pending 属于
        // 当前进程已发起的发送，保留其在途状态，等待原回执。
        if (outbox.status === "pending") continue;
        this.qqStore.setInboxStatus(row.dedupKey, outbox.status === "sent" ? "done" :
          outbox.status === "failed" ? "reply_failed" : outbox.status === "canceled" ? "skipped" : "reply_unknown");
        continue;
      }
      const task = this.deps.store.getTask(row.taskId);
      // 与普通终态监听一致：不能在收件串行链中等待网络回执，撤回须能及时处理。
      if (task?.status === "completed") void this.sendReply(row).catch((err) => this.log(`恢复群回复失败：${(err as Error).message}`));
      else if (task && !(ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) this.qqStore.setInboxStatus(row.dedupKey, "skipped");
    }
  }

  private async cancelInvalidGroupWork(): Promise<void> {
    for (const row of this.qqStore.listPendingInbox()) {
      const event = this.deps.store.findInboundEvent(QQ_GROUP_SOURCE, row.dedupKey);
      if (!event) continue;
      const gate = this.gateGroup(event);
      if (gate === "run" || gate === "wait") continue;
      this.qqStore.setInboxStatus(row.dedupKey, "skipped");
      if (row.taskId) {
        const task = this.deps.store.getTask(row.taskId);
        if (task && (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) await this.deps.bridge.cancelTask(task.id);
      }
    }
    await this.deps.bridge.dispatchInbound();
  }

  /** 停用/撤群收尾：取消任务，在途发送按结果未知保留事实。 */
  private async cancelQqWork(groupId: string | null): Promise<void> {
    for (const gs of this.qqStore.listGroupSessions()) {
      if (groupId !== null && gs.groupId !== groupId) continue;
      for (const task of this.deps.store.listQueuedTasksFifo(gs.sessionId)) {
        await this.deps.bridge.cancelTask(task.id).catch(() => {});
      }
      for (const task of this.deps.store.listTasksByStatus(["running", "awaiting_confirmation"])) {
        if (task.sessionId === gs.sessionId) await this.deps.bridge.cancelTask(task.id).catch(() => {});
      }
    }
    for (const ob of this.qqStore.listPendingOutbox()) {
      if (groupId === null || ob.groupId === groupId) {
        this.qqStore.settleOutbox(ob.opId, "unknown", { error: "群停用时发送已在途，结果未知（effect_unknown）" });
        const row = this.qqStore.getInboxByTask(ob.taskId);
        if (row) this.qqStore.setInboxStatus(row.dedupKey, "reply_unknown");
      }
    }
  }

  private kickAllQqSessions(): void {
    for (const gs of this.qqStore.listGroupSessions()) {
      this.deps.bridge.kickSession(gs.sessionId);
    }
    const main = this.deps.store.getAgentRole("main");
    if (main) this.deps.bridge.kickSession(main.sessionId);
  }

  /** 管理视图（不含 token 与消息正文以外的秘密；连接状态为运行期事实）。 */
  status(): Record<string, unknown> {
    const config = this.qqStore.getConfig();
    return {
      configured: config !== null,
      enabled: config?.enabled ?? false,
      endpoint: config?.endpoint ?? null,
      credentialName: config?.credentialName ?? null,
      selfId: config?.selfId ?? null,
      ownerUserId: config?.ownerUserId ?? null,
      groups: config?.groups ?? [],
      maxReplyChars: config?.maxReplyChars ?? null,
      queueTtlMs: config?.queueTtlMs ?? null,
      configVersion: config?.configVersion ?? 0,
      online: this.client?.online ?? false,
      actualSelfId: this.client?.selfId ?? null,
      stateDetail: this.client?.stateDetail ?? "未连接",
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

function sameTarget(a: NotifyTarget, b: NotifyTarget | null | undefined): boolean {
  return !!b && a.channel === b.channel && a.account === b.account && a.chatId === b.chatId && a.configVersion === b.configVersion;
}
