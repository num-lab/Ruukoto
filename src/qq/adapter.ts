/**
 * QQ 群聊适配器（issue 07）：NapCat OneBot v11 正向 WebSocket → Runtime 任务。
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
import type { AccessMode, ModelSelection, PersistentEvent, Project, Session, Task } from "../core/types.ts";
import { ACTIVE_TASK_STATUSES } from "../core/types.ts";
import type { CredentialStore } from "../agent/execution/credentials.ts";
import { OneBotClient, OneBotError } from "./onebot.ts";
import { qqDedupKey, qqMessageTag, type QqConfig, type QqInboxRow, type QqStore } from "./store.ts";

/** QQ 入口凭据用途（CredentialStore 绑定 purpose 与 scope.operations）。 */
export const QQ_CREDENTIAL_PURPOSE = "qq_onebot";

/** 适配器需要的 Runtime 窄接口（宿主注入；除此之外的能力适配器不可见）。 */
export interface QqRuntimeBridge {
  submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode: AccessMode;
    modelSelection: ModelSelection;
  }): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
  findProjectByName(name: string): Project | null;
  createProject(name: string): Project;
  createSession(input: { projectId: string; cwd: string; kind: "qq_group" }): Promise<Session>;
  /** 会话最新一条 assistant 文本（回复候选；有界读取，无则 null）。 */
  readLastAssistantText(sessionId: string): string | null;
  resumeQueue(sessionId: string): Promise<Session>;
  kickSession(sessionId: string): void;
  defaultModelSelection(): ModelSelection;
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

export class QqAdapter {
  private client: OneBotClient | null = null;
  /** 已建连接的参数指纹（端点/凭据/账号不变则不重建）。 */
  private clientKey: string | null = null;
  /** 入站事件串行处理链（同群会话创建与入队不乱序）。 */
  private inbound: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** 最近一次连接中断时间（重连成功时标记接收缺口）。 */
  private disconnectedAt: number | null = null;

  constructor(private readonly deps: QqAdapterDeps) {}

  private get qqStore(): QqStore {
    return this.deps.qqStore;
  }

  private log(message: string): void {
    // 后台诊断输出（不含消息正文与秘密）
    process.stderr.write(`[ruukoto:qq] ${message}\n`);
  }

  async start(): Promise<void> {
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
    const sweepMs = this.deps.timeouts?.sweepIntervalMs ?? 15_000;
    this.sweepTimer = setInterval(() => this.kickAllQqSessions(), sweepMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.disconnectClient();
  }

  /** 配置事务提交后由 Runtime 调用（含启停、群列表、连接参数变化）。 */
  async onConfigChanged(): Promise<void> {
    if (!this.started) return;
    await this.applyConfig();
    this.kickAllQqSessions();
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
    const config = this.qqStore.getConfig();
    if (!config || !config.enabled) {
      const wasEnabled = this.client !== null;
      await this.disconnectClient();
      // 一键停用：阻止新的接收（连接已断）与后续发送，运行中任务按取消机制收尾
      if (config && !config.enabled && wasEnabled) await this.cancelQqWork(null);
      return;
    }
    const token = this.resolveToken(config);
    if (config.credentialName && token === null) {
      this.log(`凭据 ${config.credentialName} 不可用（不存在或范围不含 ${QQ_CREDENTIAL_PURPOSE}），保持未连接`);
      await this.disconnectClient();
      return;
    }
    const key = JSON.stringify([config.endpoint, config.credentialName, token, config.selfId]);
    if (this.client && this.clientKey === key) return;
    await this.disconnectClient();
    const t = this.deps.timeouts;
    this.client = new OneBotClient({
      endpoint: config.endpoint,
      token,
      onEvent: (event) => this.onOneBotEvent(event),
      onStateChange: (online) => {
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
        } else {
          this.disconnectedAt ??= Date.now();
        }
      },
      actionTimeoutMs: t?.actionTimeoutMs,
      probeIntervalMs: t?.probeIntervalMs,
      reconnectMinMs: t?.reconnectMinMs,
      reconnectMaxMs: t?.reconnectMaxMs,
    });
    this.clientKey = key;
    this.client.start();
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
    const ttlMs = this.deps.timeouts?.queueTtlMs ?? config.queueTtlMs;
    const ageMs = Date.now() - Date.parse(task.createdAt);
    if (Number.isFinite(ageMs) && ageMs > ttlMs) {
      return { drop: `qq_queue_expired:排队超过 ${ttlMs}ms 未开始执行` };
    }
    if (!this.client || !this.client.online || this.client.selfId !== config.selfId) return "wait";
    return "run";
  }

  // ---------- OneBot 事件 ----------

  private onOneBotEvent(event: Record<string, unknown>): void {
    // 串行处理：同群会话创建/入队不并发，撤回与触发按到达顺序生效
    this.inbound = this.inbound.then(() => this.handleEvent(event)).catch((err) => this.log(`事件处理失败：${(err as Error).message}`));
  }

  private async handleEvent(event: Record<string, unknown>): Promise<void> {
    const config = this.qqStore.getConfig();
    if (!config || !config.enabled) return;
    // 身份核对：连接核实账号与事件 self_id 都必须等于预期登录账号
    if (!this.client || !this.client.online || this.client.selfId !== config.selfId) return;
    if (String(event["self_id"] ?? "") !== config.selfId) return;

    if (event["post_type"] === "message" && event["message_type"] === "group") {
      await this.handleGroupMessage(config, event);
    } else if (event["post_type"] === "notice" && event["notice_type"] === "group_recall") {
      await this.handleRecall(config, event);
    }
    // message_sent（自身回声）/请求/元事件：不产生任务
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
      const session = this.deps.store.getSession(gs.sessionId);
      const task = await this.deps.bridge.submit({
        sessionId: gs.sessionId,
        requestId: row.requestId,
        input: row.input,
        // QQ 入口固定请求确认模式：不能开启完全访问，不授予工作区外路径
        accessMode: "confirm",
        modelSelection: session?.modelSelection ?? this.deps.bridge.defaultModelSelection(),
      });
      this.qqStore.linkInboxTask(row.dedupKey, gs.sessionId, task.id);
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
    if (row.taskId) {
      const task = this.deps.store.getTask(row.taskId);
      if (task && (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) {
        await this.deps.bridge.cancelTask(task.id).catch((err) => this.log(`撤回取消任务失败：${(err as Error).message}`));
      }
      for (const ob of this.qqStore.listPendingOutbox()) {
        if (ob.taskId === row.taskId) this.qqStore.settleOutbox(ob.opId, "canceled");
      }
    }
  }

  // ---------- 运行时事件（任务终态 → 发送回复） ----------

  /** Runtime 事件监听（持久事件提交后调用）。 */
  onRuntimeEvents(events: PersistentEvent[]): void {
    for (const ev of events) {
      const body = ev.body;
      if (body.type === "task.completed") {
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
    const config = this.qqStore.getConfig();
    if (!config || !config.enabled || !config.groups.includes(inbox.groupId) || config.selfId !== inbox.account) {
      this.qqStore.setInboxStatus(inbox.dedupKey, "skipped");
      return;
    }
    // 发送前再次核对原消息是否撤回
    const fresh = this.qqStore.getInbox(inbox.dedupKey);
    if (!fresh || fresh.recalled) {
      this.qqStore.setInboxStatus(inbox.dedupKey, "skipped");
      return;
    }
    const client = this.client;
    if (!client || !client.online || client.selfId !== config.selfId) {
      // 明确未发送（不是 unknown）：重连不自动补发失效回复
      this.qqStore.setInboxStatus(inbox.dedupKey, "reply_failed");
      return;
    }
    const rawText = this.deps.bridge.readLastAssistantText(inbox.sessionId);
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
      if (!this.qqStore.settleOutbox(outbox.opId, "sent", { sentMessageId: sentId === undefined || sentId === null ? null : String(sentId) })) {
        this.qqStore.noteLateOutcome(outbox.opId, `取消后平台返回成功（message_id=${String(sentId)}）`);
      }
      this.qqStore.setInboxStatus(inbox.dedupKey, "done");
    } catch (err) {
      const definite = err instanceof OneBotError && err.definite;
      const status = definite ? "failed" : "unknown";
      if (!this.qqStore.settleOutbox(outbox.opId, status, { error: (err as Error).message })) {
        this.qqStore.noteLateOutcome(outbox.opId, `取消后平台返回：${(err as Error).message}`);
      }
      this.qqStore.setInboxStatus(inbox.dedupKey, definite ? "reply_failed" : "reply_unknown");
    }
  }

  // ---------- 恢复 / 停用 / 状态 ----------

  /** 已登记未入队的记录按原请求键核实重提（submit 幂等：已存在则关联原任务）。 */
  private async recoverInbox(): Promise<void> {
    const config = this.qqStore.getConfig();
    for (const row of this.qqStore.listUnlinkedInbox()) {
      if (!config || !config.enabled || !config.groups.includes(row.groupId) || config.selfId !== row.account) {
        this.qqStore.setInboxStatus(row.dedupKey, "skipped");
        continue;
      }
      await this.enqueueInbox(config, row);
    }
  }

  /** 停用/撤群收尾：取消该范围排队与运行中任务，未发送回复标记取消。 */
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
      if (groupId === null || ob.groupId === groupId) this.qqStore.settleOutbox(ob.opId, "canceled");
    }
  }

  private kickAllQqSessions(): void {
    for (const gs of this.qqStore.listGroupSessions()) {
      this.deps.bridge.kickSession(gs.sessionId);
    }
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
