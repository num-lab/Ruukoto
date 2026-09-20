/**
 * 控制面客户端（CLI 与集成测试共用）。
 *
 * - 换行分帧 JSON；request(op, params) 带超时与错误传递；
 * - connect 握手返回 {seq, replay, snapshot}，之后事件经 onEvent 回调；
 * - 客户端按 seq 去重（乱序/重复帧丢弃），由调用方维护游标。
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

export class ControlClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class ControlClient {
  private socket: net.Socket;
  private buffer = "";
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventListeners = new Set<(event: ControlPush["event"]) => void>();
  private requestCounter = 0;
  private lastSeq = 0;
  private closed = false;

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
        if (line.length > MAX_FRAME_BYTES) {
          this.close();
          return;
        }
        if (line.trim().length === 0) continue;
        this.handleFrame(line);
      }
    });
    socket.on("error", (err) => this.failAll(new ControlClientError("connection_error", String(err))));
    socket.on("close", () => this.failAll(new ControlClientError("connection_closed", "连接已关闭")));
  }

  static connect(socketPath: string, timeoutMs = 5000): Promise<ControlClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ControlClientError("connect_timeout", `连接超时：${socketPath}`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new ControlClient(socket));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(new ControlClientError("connection_error", String(err)));
      });
    });
  }

  private handleFrame(line: string): void {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // 非法帧丢弃
    }
    if (frame?.push === "event" && frame.event) {
      const event = frame.event as ControlPush["event"];
      if (typeof event.seq !== "number") return;
      // 按 seq 去重（允许实现上出现重复推送；缺口由游标补发机制兜底）
      if (event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
      for (const listener of this.eventListeners) listener(event);
      return;
    }
    const response = frame as ControlResponse;
    const waiter = this.pending.get(response.id);
    if (!waiter) return;
    this.pending.delete(response.id);
    clearTimeout(waiter.timer);
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new ControlClientError(response.error?.code ?? "error", response.error?.message ?? "未知错误"));
  }

  private failAll(err: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  request<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new ControlClientError("closed", "客户端已关闭"));
    const id = `req-${++this.requestCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ControlClientError("request_timeout", `请求超时：${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id, op, params: params ?? {} }));
    });
  }

  /** 拥有者认证：连接后必须先成功认证才能执行其他操作。 */
  async authenticate(token: string, timeoutMs = 10_000): Promise<void> {
    await this.request("auth", { token }, timeoutMs);
  }

  /** connect 握手：since 传游标可补发；返回快照与序号。 */
  async handshake(since?: number, timeoutMs = 15_000): Promise<ConnectResult> {
    const result = await this.request<ConnectResult>("connect", since === undefined ? {} : { since }, timeoutMs);
    // 补发事件在应答内送达（不经过 push 帧），按 seq 喂给监听者并推进游标
    for (const event of result.replay) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      for (const listener of this.eventListeners) listener(event);
    }
    this.lastSeq = Math.max(this.lastSeq, result.seq);
    return result;
  }

  onEvent(listener: (event: ControlPush["event"]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getSeq(): number {
    return this.lastSeq;
  }

  close(): void {
    this.closed = true;
    this.failAll(new ControlClientError("closed", "客户端已关闭"));
    this.socket.destroy();
  }
}
