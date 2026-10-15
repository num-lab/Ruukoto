/**
 * 控制面连接管理（TUI 与需要长连接的客户端共用）。
 *
 * 职责（issue 04 §3）：
 * - 连接顺序：建立 socket → 拥有者认证 → 同步快照 → 在线；
 * - 握手期间缓冲实时事件：先安装序号 N 的快照，补发事件只用于补齐显示
 *   记录（replay，不回滚状态），再按序应用 seq > N 的实时事件；
 * - 游标只在事件应用后前进；按全局序号去重并检查缺口，发现缺口、
 *   invalid_cursor 或 cursor_too_old 时重新同步快照（不重新执行任务）；
 * - 断线、首次建连失败、认证或同步超时都按有上限的退避重连；只有后台明确拒绝
 *   （令牌无效、协议不兼容等）停止重试；
 * - 重连只恢复观察：不发送 resume_queue、批准、继续任务或启动后台；
 * - 数据实例标识变化（新数据库）明确通知：调用方据此处理待确认请求。
 */

import { ControlClient, ControlClientError, type ClientCloseInfo, type ControlTransport } from "./client.ts";
import type { OpParams, OpResult, TuiOp } from "./ops.ts";
import type { ConnectResult } from "./protocol.ts";
import type { PersistentEvent } from "@ruukoto/core/types.ts";
import type { ProductType } from "@ruukoto/core/product.ts";

export type ConnectionState = "connecting" | "online" | "reconnecting" | "failed" | "closed";

export interface ConnectionCallbacks {
  /** 状态迁移（reconnecting 的 detail 为原因；failed 的 detail 为修复指引）。 */
  onState(state: ConnectionState, detail?: string, error?: ControlClientError): void;
  /** 安装快照（首次与每次重同步）；instanceChanged=true 表示数据实例已更换。 */
  onSnapshot(result: ConnectResult, ctx: { resync: boolean; instanceChanged: boolean }): void;
  /**
   * 事件应用：live = 实时（可改变状态）；replay = 补发（只补齐显示记录，
   * 不得把最新状态回滚到旧状态）。
   */
  onEvent(event: PersistentEvent, kind: "live" | "replay"): void;
}

export interface ConnectionConfig {
  socketPath: string;
  /** 每次建连重新获取；提供函数的取消与资源回收由调用方持有。 */
  token: string | (() => Promise<string>);
  expectedProduct?: ProductType;
  /** 退避重连：初始间隔与上限（默认 500ms → 8000ms）。 */
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  connectTimeoutMs?: number;
  /** 测试注入点：替换底层客户端工厂（默认 ControlClient.connect）。 */
  clientFactory?: (socketPath: string, timeoutMs: number) => Promise<ControlTransport>;
}

export class ControlConnection {
  private readonly config: ConnectionConfig;
  private readonly callbacks: ConnectionCallbacks;
  private client: ControlTransport | null = null;
  private appliedSeq = 0;
  private buffer: PersistentEvent[] | null = null;
  private closedByUser = false;
  private generation = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number;
  private syncing: Promise<void> | null = null;

  state: ConnectionState = "connecting";
  lastSyncAt: Date | null = null;
  instanceId: string | null = null;

  constructor(config: ConnectionConfig, callbacks: ConnectionCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.reconnectDelay = config.reconnectInitialMs ?? 500;
  }

  /** 当前已应用的事件序号（游标）。 */
  getSeq(): number {
    return this.appliedSeq;
  }

  private setState(state: ConnectionState, detail?: string, error?: ControlClientError): void {
    if (this.state === state && detail === undefined) return;
    this.state = state;
    this.callbacks.onState(state, detail, error);
  }

  /** 首次连接并同步；失败抛错。明确拒绝进入 failed 不再重试，其余（后台未起、超时、断线）退避重连。 */
  async start(): Promise<void> {
    if (this.closedByUser) return;
    this.setState("connecting");
    try {
      await this.connectAndSync(undefined);
    } catch (err) {
      this.handleClose({ code: err instanceof ControlClientError ? err.code : "connect_failed", message: (err as Error).message });
      throw err;
    }
  }

  private current(generation: number): boolean {
    return !this.closedByUser && this.state !== "failed" && generation === this.generation;
  }

  // Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
  private async connectAndSync(since: number | undefined): Promise<void> {
    const generation = ++this.generation;
    const factory = this.config.clientFactory ?? ((p: string, t: number): Promise<ControlTransport> => ControlClient.connect(p, t));
    let client: ControlTransport | null = null;
    try {
      const token = typeof this.config.token === "string" ? this.config.token : await this.config.token();
      if (!this.current(generation)) return;
      client = await factory(this.config.socketPath, this.config.connectTimeoutMs ?? 5000);
      if (!this.current(generation)) { client.close(); return; }
      this.client = client;
      client.onClose((info) => { if (this.current(generation)) this.handleClose(info); });
      client.onEvent((event) => { if (this.current(generation)) this.routeEvent(event); });
      await client.authenticate(token);
      if (!this.current(generation)) { client.close(); return; }
      await this.sync(client, since, generation);
      if (!this.current(generation)) { client.close(); return; }
    } catch (err) {
      if (!this.current(generation)) { client?.close(); return; }
      // 明确拒绝先置 failed；其余失败交外层重试，关闭 transport 不重复安排计时器。
      if (err instanceof ControlClientError && err.outcome === "rejected") this.setState("failed", err.message, err);
      ++this.generation;
      this.client = null;
      client?.close();
      throw err;
    }
    this.lastSyncAt = new Date();
    this.reconnectDelay = this.config.reconnectInitialMs ?? 500;
    this.setState("online");
  }

  /** 安装快照 → 应用补发（fill-only）→ 应用缓冲的实时事件。 */
  private async sync(client: ControlTransport, since: number | undefined, generation: number): Promise<void> {
    const buffer: PersistentEvent[] = [];
    this.buffer = buffer;
    let result: ConnectResult;
    try {
      result = await client.handshake(since);
    } catch (err) {
      if (
        this.current(generation) && since !== undefined &&
        err instanceof ControlClientError &&
        (err.code === "invalid_cursor" || err.code === "cursor_too_old")
      ) {
        // 游标失效：重新取完整快照（不重新执行任务）
        result = await client.handshake(undefined);
      } else {
        throw err;
      }
    } finally {
      // 握手结束后到达的事件直接走实时通道
      if (this.buffer === buffer) this.buffer = null;
    }
    if (!this.current(generation)) return;
    if (this.config.expectedProduct && result.snapshot.product !== this.config.expectedProduct) {
      throw new ControlClientError("product_mismatch", `连接目标产品不符：需要 ${this.config.expectedProduct}；请核对控制目录与连接配置后重新连接。`, "rejected");
    }
    const instanceChanged = this.instanceId !== null && result.snapshot.instanceId !== this.instanceId;
    this.instanceId = result.snapshot.instanceId;
    this.callbacks.onSnapshot(result, { resync: since !== undefined || this.appliedSeq > 0, instanceChanged });
    if (!this.current(generation)) return;
    this.appliedSeq = result.seq;
    for (const event of result.replay) {
      if (!this.current(generation)) return;
      this.callbacks.onEvent(event, "replay");
    }
    for (const event of buffer) {
      if (!this.current(generation)) return;
      this.applyLive(event);
    }
  }

  private routeEvent(event: PersistentEvent): void {
    if (this.buffer) {
      this.buffer.push(event);
      return;
    }
    this.applyLive(event);
  }

  private applyLive(event: PersistentEvent): void {
    if (event.seq <= this.appliedSeq) return; // 重复事件：丢弃
    if (event.seq !== this.appliedSeq + 1) {
      // 缺口：重新同步快照与历史（不重新执行任务）
      void this.resync(`事件序号缺口（期望 ${this.appliedSeq + 1}，收到 ${event.seq}）`);
      return;
    }
    this.callbacks.onEvent(event, "live");
    // 游标只在事件应用后前进
    this.appliedSeq = event.seq;
  }

  private async resync(reason: string): Promise<void> {
    if (this.closedByUser || !this.client || this.client.isClosed) return;
    if (this.syncing) return this.syncing;
    const client = this.client;
    const generation = this.generation;
    this.syncing = (async () => {
      try {
        await this.sync(client, undefined, generation);
        if (this.current(generation)) this.lastSyncAt = new Date();
      } catch (error) {
        if (!this.current(generation)) return;
        if (error instanceof ControlClientError && error.outcome === "rejected") this.setState("failed", error.message, error);
        // 同步失败：连接已不可用，走断线重连路径
        client.close();
      }
    })();
    try {
      await this.syncing;
    } finally {
      this.syncing = null;
    }
  }

  private handleClose(info: ClientCloseInfo): void {
    if (this.closedByUser) return;
    if (this.state === "failed") return;
    ++this.generation;
    this.client = null;
    this.buffer = null;
    this.setState("reconnecting", info.message);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delayMs = this.reconnectDelay;
    this.reconnectDelay = Math.min(delayMs * 2, this.config.reconnectMaxMs ?? 8000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, delayMs);
  }

  private async tryReconnect(): Promise<void> {
    if (this.closedByUser) return;
    try {
      // 重连只恢复观察：认证 + 快照/补发，不发送任何任务操作
      await this.connectAndSync(this.appliedSeq > 0 ? this.appliedSeq : undefined);
    } catch (err) {
      if (this.closedByUser || this.state === "failed") return; // 认证/协议失败：不再重试
      this.handleClose({ code: err instanceof ControlClientError ? err.code : "connect_failed", message: (err as Error).message });
    }
  }

  /**
   * 连接可用时发送；socket 已关闭（含重连窗口）立即拒绝。
   * 握手完成前的同步窗口内允许只读查询（快照安装触发的历史加载）。
   */
  request<K extends TuiOp>(op: K, params: OpParams<K>, timeoutMs?: number): Promise<OpResult<K>> {
    if (!this.client || this.client.isClosed) {
      return Promise.reject(new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent"));
    }
    return this.client.request(op, params, timeoutMs);
  }

  /** 主动关闭：停止重连，关闭 socket。 */
  close(): void {
    this.closedByUser = true;
    ++this.generation;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.client?.close();
    this.setState("closed", "已主动关闭");
  }
}
