/**
 * OneBot v11 正向 WebSocket 薄客户端（issue 07；NapCat 服务端，ruukoto 主动连接）。
 *
 * - 使用 Node 内置 WebSocket（undici），token 经 Authorization: Bearer 头注入；
 * - 动作请求/响应按 echo 关联（echo 只用于匹配请求与应答，不作幂等键）；
 * - get_login_info 核实账号，get_status 与 heartbeat.status 核实 QQ 在线；
 *   周期探测失败即断开重连（指数退避，有上限）；
 * - 连接中断时在途动作一律按"结果不明"拒绝（definite=false），由调用方
 *   按 effect_unknown 处理，不自动重发。
 */

import { setTimeout as delay } from "node:timers/promises";

/** OneBot 消息 ID 是有符号整数；不接受对象、空串或有损数字转换。 */
export function oneBotMessageId(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && String(id) === String(value) ? String(id) : null;
}

export function oneBotAccountId(value: unknown): string | null {
  const id = oneBotMessageId(value);
  return id !== null && Number(id) > 0 ? id : null;
}

export class OneBotError extends Error {
  readonly code = "onebot_error";
  /** 动作响应的 retcode（平台明确失败时有值）。 */
  readonly retcode: number | null;
  /** true = 平台明确拒绝（确定失败）；false = 超时/断线等结果不明。 */
  readonly definite: boolean;
  constructor(message: string, opts: { retcode?: number | null; definite: boolean }) {
    super(message);
    this.retcode = opts.retcode ?? null;
    this.definite = opts.definite;
  }
}

export interface OneBotClientOptions {
  /** ws://host:port（生产默认回环或受控私网；跨主机须另有受保护传输）。 */
  endpoint: string;
  /** OneBot 访问令牌（null = 不鉴权）；只经握手头发送，不写日志。 */
  token: string | null;
  /** 非动作响应的入站事件（message/notice/meta_event 等，已解析 JSON）。 */
  onEvent: (event: Record<string, unknown>) => void;
  /** 连接状态变化（online=true 时 detail 为登录账号 id）。 */
  onStateChange?: (online: boolean, detail: string) => void;
  /** 动作响应超时（默认 15s）。 */
  actionTimeoutMs?: number;
  /** 活性探测间隔（默认 30s；探测失败即断开重连）。 */
  probeIntervalMs?: number;
  /** 重连退避下限/上限（默认 1s/30s）。 */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

interface PendingAction {
  resolve: (data: unknown) => void;
  reject: (err: OneBotError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OneBotClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private aborter: AbortController | null = null;
  private pending = new Map<string, PendingAction>();
  private echoCounter = 0;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前连接核实的登录账号（get_login_info；未连接为 null）。 */
  selfId: string | null = null;
  online = false;
  /** 最近一次状态说明（错误/断开原因；状态查看用，不含秘密）。 */
  stateDetail = "未连接";

  constructor(private readonly opts: OneBotClientOptions) {}

  start(): void {
    if (this.loopPromise) return;
    this.stopped = false;
    this.aborter = new AbortController();
    this.loopPromise = this.runLoop(this.aborter.signal);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.aborter?.abort();
    this.selfId = null;
    this.setOnline(false, "已停止");
    this.clearProbe();
    this.failAllPending(new OneBotError("连接已停止", { definite: false }));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // 关闭失败不影响停止
      }
    }
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
    this.setOnline(false, "已停止");
  }

  /**
   * 调用 OneBot 动作（echo 关联应答）。平台明确失败抛 OneBotError(definite=true,
   * 含 retcode)；超时/断线抛 OneBotError(definite=false) = 结果不明。
   */
  call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new OneBotError("OneBot 动作已取消", { definite: false }));
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new OneBotError("OneBot 连接不可用", { definite: false }));
    }
    const echo = `rkk_${Date.now().toString(36)}_${(this.echoCounter++).toString(36)}`;
    const timeoutMs = this.opts.actionTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        cleanup();
        this.pending.delete(echo);
        reject(new OneBotError("OneBot 动作已取消", { definite: false }));
      };
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(echo);
        reject(new OneBotError(`动作 ${action} 响应超时（${timeoutMs}ms）`, { definite: false }));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (data) => { cleanup(); resolve(data); },
        reject: (err) => { cleanup(); reject(err); }, timer,
      });
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        cleanup();
        this.pending.delete(echo);
        reject(new OneBotError(this.redact(`动作 ${action} 发送失败：${(err as Error).message}`), { definite: false }));
      }
    });
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    const minMs = this.opts.reconnectMinMs ?? 1_000;
    const maxMs = this.opts.reconnectMaxMs ?? 30_000;
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        attempt = 0;
      } catch (err) {
        this.setOnline(false, (err as Error).message);
      }
      if (this.stopped) break;
      await delay(Math.min(maxMs, minMs * 2 ** attempt++), undefined, { signal }).catch(() => {});
    }
  }

  /** 单次连接：打开 → 核实登录身份 → 收发直到关闭；未达在线即抛（退避递增）。 */
  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let reachedOnline = false;
      let probing = false;
      let statusVersion = 0;
      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimeout);
        this.clearProbe();
        this.failAllPending(new OneBotError("OneBot 连接中断", { definite: false }));
        this.ws = null;
        this.selfId = null;
        this.setOnline(false, err?.message ?? "连接已关闭");
        try {
          ws.close();
        } catch {
          // 关闭失败不影响重连。
        }
        if (err) reject(err);
        else resolve();
      };

      const headers: Record<string, string> = {};
      if (this.opts.token) headers["Authorization"] = `Bearer ${this.opts.token}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.opts.endpoint, { headers } as any);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;

      const openTimeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // 忽略
        }
        finish(new Error("OneBot 连接打开超时"));
      }, this.opts.actionTimeoutMs ?? 15_000);

      ws.addEventListener("message", (ev) => {
        if (settled || this.stopped || typeof ev.data !== "string") return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return; // 非 JSON 帧：忽略
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
        // 动作响应：有 echo 且能匹配待决请求
        const echo = typeof msg["echo"] === "string" ? msg["echo"] : null;
        if (echo !== null) {
          const pending = this.pending.get(echo);
          if (pending) {
            this.pending.delete(echo);
            clearTimeout(pending.timer);
            const retcode = typeof msg["retcode"] === "number" ? msg["retcode"] : null;
            if (msg["status"] === "ok" && retcode === 0) {
              pending.resolve(msg["data"]);
            } else {
              const detail = [msg["msg"], msg["wording"]].filter((s) => typeof s === "string" && s).join(" ");
              pending.reject(
                new OneBotError(this.redact(`动作未确认成功（retcode=${retcode ?? "?"}）${detail ? `：${detail}` : ""}`), {
                  retcode,
                  // async / 不完整响应不能证明未发送。
                  definite: msg["status"] === "failed" && retcode !== null && retcode !== 0,
                }),
              );
            }
            return;
          }
          // 未匹配的 echo（迟到/重复应答）：忽略
          return;
        }
        if (msg["post_type"] === "meta_event" && msg["meta_event_type"] === "heartbeat") {
          statusVersion++;
          const account = oneBotAccountId(msg["self_id"]);
          if (account !== this.selfId) this.selfId = null;
          const online = this.selfId !== null && isOnlineStatus(msg["status"]);
          if (online) reachedOnline = true;
          this.setOnline(online, online ? this.selfId! : "QQ 心跳未确认账号在线");
        }
        if (typeof msg["post_type"] === "string") {
          try {
            this.opts.onEvent(msg);
          } catch {
            // 事件处理异常不断开连接（调用方自身保证健壮；此处兜底）
          }
        }
      });

      ws.addEventListener("close", (ev) => {
        clearTimeout(openTimeout);
        // 曾在线的连接关闭视为正常断开（退避重置）；未达在线 = 连接失败
        finish(reachedOnline ? null : new Error(`OneBot 连接关闭（code=${ev.code}${ev.reason ? ` ${ev.reason}` : ""}）`));
      });
      ws.addEventListener("error", () => {
        // error 后必跟 close；这里只兜底打开阶段的失败
        clearTimeout(openTimeout);
        if (!this.online) finish(new Error("OneBot 连接失败"));
      });

      ws.addEventListener("open", () => {
        clearTimeout(openTimeout);
        if (settled || this.stopped) return;
        // 探测不重入；离线时仍探测，QQ 恢复后无需重新建立 WebSocket。
        const probe = async (): Promise<void> => {
          if (settled || this.stopped || probing) return;
          probing = true;
          const version = statusVersion;
          try {
            const [login, status] = await Promise.all([this.call("get_login_info", {}), this.call("get_status", {})]);
            if (settled || this.stopped || version !== statusVersion) return;
            const account = oneBotAccountId((login as any)?.user_id);
            if (!account) throw new Error("OneBot 未返回有效登录账号");
            this.selfId = account;
            const online = isOnlineStatus(status);
            if (online) reachedOnline = true;
            this.setOnline(online, online ? account : "QQ 登录账号离线或状态未知");
          } catch (err) {
            finish(err as Error);
          } finally {
            probing = false;
          }
        };
        this.probeTimer = setInterval(() => void probe(), this.opts.probeIntervalMs ?? 30_000);
        void probe();
      });
    });
  }

  private clearProbe(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private failAllPending(err: OneBotError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private setOnline(online: boolean, detail: string): void {
    detail = this.redact(detail);
    const changed = this.online !== online || (online && this.stateDetail !== detail);
    this.online = online;
    this.stateDetail = detail;
    if (changed) this.opts.onStateChange?.(online, detail);
  }

  private redact(message: string): string {
    return this.opts.token ? message.split(this.opts.token).join("<token>") : message;
  }
}

function isOnlineStatus(value: unknown): boolean {
  const status = value as { online?: unknown; good?: unknown } | null;
  return status?.online === true && status.good === true;
}
