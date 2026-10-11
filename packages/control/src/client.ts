/**
 * 控制面客户端（CLI、TUI 与集成测试共用）。
 *
 * - 换行分帧 JSON；request(op, params) 带超时与错误传递；
 * - connect 握手返回 {seq, replay, snapshot}；replay 由调用方自行应用，
 *   本类不在返回前推给监听者（避免快照与实时推送互相覆盖）；
 * - 实时事件按 seq 去重（乱序/重复帧丢弃）；缺口检测与游标管理由调用方
 *   （ControlConnection）负责；
 * - 断线即通知 onClose：socket 关闭、协议违规（非法帧、超长帧、未换行
 *   残留帧）都会关闭客户端并给出原因，不留假在线状态；关闭后请求立即
 *   被拒绝，不再发送。
 */

import * as net from "node:net";
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  type ConnectResult,
  type ControlPush,
  type ControlResponse,
  encodeFrame,
} from "./protocol.ts";
import type { OpParams, OpResult, TuiOp } from "./ops.ts";

/**
 * 请求结果的分类（架构工单 07）：由产生错误的地方写定，调用方按它处理而不列错误码。
 * - not_sent：未发送（已知未执行）；
 * - rejected：后台明确拒绝；
 * - unknown：应答丢失，连接仍在（超时，或应答不能说明结果），可以立即查询核实；
 * - disconnected：应答丢失，已断线，只能等重连后核实。
 * unknown 与 disconnected 都是 CONTEXT.md 的「应答丢失」。
 */
export type RequestOutcome = "not_sent" | "rejected" | "unknown" | "disconnected";

/** 服务端回了错误应答、却不能说明请求没有执行的码。 */
const UNKNOWN_REPLY_CODES = new Set([
  "internal_error", // 异常没带码，可能执行了一半
  "response_too_large", // 已执行完，只是应答超过帧上限
  "mode_switch_unverified", // 任务已被中断，切换结果未核实
]);

export class ControlClientError extends Error {
  readonly code: string;
  readonly outcome: RequestOutcome;
  constructor(code: string, message: string, outcome: RequestOutcome) {
    super(message);
    this.code = code;
    this.outcome = outcome;
  }
}

/** 请求失败的分类；不是 ControlClientError 的异常（实现 bug）保守按 unknown。 */
export function requestOutcome(err: unknown): RequestOutcome {
  return err instanceof ControlClientError ? err.outcome : "unknown";
}

export interface ClientCloseInfo {
  code: string;
  message: string;
}

/**
 * ControlConnection 对底层客户端的全部要求（架构工单 07 的接缝）：真实 socket
 * 客户端、demo 合成会话与测试替身都实现它；request 按 op 表定类型。
 */
export interface ControlTransport {
  readonly isClosed: boolean;
  authenticate(token: string): Promise<void>;
  handshake(since?: number): Promise<ConnectResult>;
  onEvent(listener: (event: ControlPush["event"]) => void): () => void;
  onClose(listener: (info: ClientCloseInfo) => void): () => void;
  close(): void;
  request<K extends TuiOp>(op: K, params: OpParams<K>, timeoutMs?: number): Promise<OpResult<K>>;
}

/** request 保持宽松签名：CLI 与配置中心按字符串调用任意 op。 */
export class ControlClient implements ControlTransport {
  private socket: net.Socket;
  private buffer = "";
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventListeners = new Set<(event: ControlPush["event"]) => void>();
  private closeListeners = new Set<(info: ClientCloseInfo) => void>();
  private requestCounter = 0;
  private lastSeq = 0;
  private closed = false;
  private closeInfo: ClientCloseInfo | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const idx = this.buffer.indexOf("\n");
        if (idx === -1) break;
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
          this.terminate("frame_too_large", "收到超过上限的帧");
          return;
        }
        if (line.trim().length === 0) continue;
        this.handleFrame(line);
        if (this.closed) return;
      }
      if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) {
        this.terminate("frame_too_large", "未换行数据超过帧上限");
      }
    });
    socket.on("error", (err) => this.terminate("connection_error", String(err)));
    socket.on("close", () => {
      // 关闭时仍有未换行残留：对端违反了分帧约定（或中途死亡）
      if (!this.closed && this.buffer.length > 0) {
        this.terminate("unterminated_frame", "连接关闭时存在未换行的残留帧");
        return;
      }
      this.terminate("connection_closed", "连接已关闭");
    });
  }

  static connect(socketPath: string, timeoutMs = 5000): Promise<ControlClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ControlClientError("connect_timeout", `连接超时：${socketPath}`, "not_sent"));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new ControlClient(socket));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(new ControlClientError("connection_error", String(err), "not_sent"));
      });
    });
  }

  private handleFrame(line: string): void {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      this.terminate("bad_frame", "收到非法 JSON 帧");
      return;
    }
    if (frame?.push === "event" && frame.event) {
      const event = frame.event as ControlPush["event"];
      if (typeof event.seq !== "number") {
        this.terminate("bad_frame", "事件帧缺少序号");
        return;
      }
      // 按 seq 去重（允许实现上出现重复推送；缺口由调用方游标机制兜底）
      if (event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
      for (const listener of this.eventListeners) listener(event);
      return;
    }
    const response = frame as ControlResponse;
    if (typeof response?.id !== "string" || typeof response?.ok !== "boolean") {
      this.terminate("bad_frame", "应答帧缺少 id/ok 字段");
      return;
    }
    const waiter = this.pending.get(response.id);
    if (!waiter) return; // 超时后的迟到应答：忽略
    this.pending.delete(response.id);
    clearTimeout(waiter.timer);
    if (response.ok) waiter.resolve(response.result);
    else {
      const code = response.error?.code ?? "error";
      waiter.reject(new ControlClientError(code, response.error?.message ?? "未知错误", UNKNOWN_REPLY_CODES.has(code) ? "unknown" : "rejected"));
    }
  }

  /** 关闭并通知：任何路径导致的不可用都经此收口，保证只通知一次；在途请求应答丢失。 */
  private terminate(code: string, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = { code, message };
    this.failAll(new ControlClientError(code, message, "disconnected"));
    this.socket.destroy();
    for (const listener of this.closeListeners) listener(this.closeInfo);
  }

  private failAll(err: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  request<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new ControlClientError("closed", `客户端已关闭（${this.closeInfo?.message ?? ""}）`, "not_sent"));
    const id = `req-${++this.requestCounter}`;
    let frame: string;
    try {
      frame = encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id, op, params: params ?? {} });
    } catch (err) {
      return Promise.reject(new ControlClientError("invalid_params", `参数无法序列化（${op}）：${(err as Error).message}`, "not_sent"));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ControlClientError("request_timeout", `请求超时：${op}`, "unknown"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame);
    });
  }

  /** 拥有者认证：连接后必须先成功认证才能执行其他操作。 */
  async authenticate(token: string, timeoutMs = 10_000): Promise<void> {
    await this.request("auth", { token }, timeoutMs);
  }

  /**
   * connect 握手：since 传游标可补发；返回快照与序号。
   * replay 不推给监听者——调用方先安装快照，再按需应用补发事件；
   * 握手期间到达的实时事件照常经 onEvent 派发（调用方负责缓冲与排序）。
   */
  async handshake(since?: number, timeoutMs = 15_000): Promise<ConnectResult> {
    const result = await this.request<ConnectResult>("connect", since === undefined ? {} : { since }, timeoutMs);
    // 游标以快照序号为准（新数据实例序号可能重新计数，由调用方比对 instanceId）
    this.lastSeq = result.seq;
    return result;
  }

  onEvent(listener: (event: ControlPush["event"]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 断线通知：只触发一次；已关闭时立即回调。 */
  onClose(listener: (info: ClientCloseInfo) => void): () => void {
    if (this.closed && this.closeInfo) {
      listener(this.closeInfo);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getSeq(): number {
    return this.lastSeq;
  }

  close(): void {
    this.terminate("closed", "客户端主动关闭");
  }
}
