/**
 * 控制面服务：Unix socket 上的换行分帧 JSON。
 *
 * connect 的快照读取与订阅注册在同一个同步段内完成（Node 单线程），
 * 保证快照序号 N 与实时推送之间无缺口；慢客户端断开后凭游标补发，
 * 服务端不为单个客户端在内存里积压事件。
 */

import * as net from "node:net";
import * as fs from "node:fs";
import {
  MAX_FRAME_BYTES,
  type ConnectResult,
  type ControlRequest,
  type ControlResponse,
  encodeFrame,
} from "./protocol.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { PersistentEvent } from "../core/types.ts";

const REPLAY_LIMIT = 5000;

export class ControlServer {
  private server: net.Server;
  private subscribers = new Set<net.Socket>();
  private runtime: Runtime;
  private stopped = false;

  private constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  static async start(runtime: Runtime): Promise<ControlServer> {
    const server = new ControlServer(runtime);
    const socketPath = runtime.socketPath();
    // 实例锁保证本进程是数据目录的唯一后台；遗留的 socket 文件属于已死
    // 实例（SIGKILL 不会清理），安全移除后重新绑定
    try {
      fs.unlinkSync(socketPath);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    await new Promise<void>((resolve, reject) => {
      server.server.once("error", reject);
      server.server.listen(socketPath, () => resolve());
    });
    // socket 与数据目录同受 0700 数据目录保护；再显式收紧 socket 本身
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // 个别平台不支持 socket chmod；数据目录权限仍然生效
    }
    runtime.onEventBroadcast = (events) => server.broadcast(events);
    runtime.onCloseServer = async () => {
      await server.stop();
    };
    return server;
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        if (line.trim().length === 0) continue;
        this.handleLine(socket, line);
      }
      if (buffer.length > MAX_FRAME_BYTES) socket.destroy();
    });
    socket.on("error", () => {
      /* 客户端断开等 IO 错误：仅移除订阅 */
    });
    socket.on("close", () => {
      this.subscribers.delete(socket);
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = JSON.parse(line) as ControlRequest;
    } catch {
      this.reply(socket, { v: 1, id: "", ok: false, error: { code: "bad_frame", message: "非法 JSON 帧" } });
      return;
    }
    if (request.v !== 1 || typeof request.id !== "string" || typeof request.op !== "string") {
      this.reply(socket, {
        v: 1,
        id: String((request as any)?.id ?? ""),
        ok: false,
        error: { code: "bad_request", message: "请求必须包含 v=1、id、op" },
      });
      return;
    }

    try {
      const result = await this.dispatch(socket, request);
      this.reply(socket, { v: 1, id: request.id, ok: true, result });
    } catch (err: any) {
      const code = err?.code ?? "internal_error";
      this.reply(socket, {
        v: 1,
        id: request.id,
        ok: false,
        error: { code, message: String(err?.message ?? err) },
      });
    }
  }

  private async dispatch(socket: net.Socket, request: ControlRequest): Promise<unknown> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const runtime = this.runtime;
    const requireString = (key: string): string => {
      const value = params[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw Object.assign(new Error(`参数 ${key} 必须是非空字符串`), { code: "invalid_params" });
      }
      return value;
    };
    switch (request.op) {
      case "ping":
        return { pong: true, stopping: runtime.stopping };
      case "connect": {
        // 快照读取与订阅注册在同一同步段：seq N 之后的事件只会经实时推送送达
        const sinceRaw = params["since"];
        if (sinceRaw !== undefined && (typeof sinceRaw !== "number" || !Number.isInteger(sinceRaw) || sinceRaw < 0)) {
          throw Object.assign(new Error(`非法游标 since=${String(sinceRaw)}，请重新取快照`), { code: "invalid_cursor" });
        }
        const since = sinceRaw === undefined ? 0 : sinceRaw;
        const maxSeq = runtime.store.getMaxSeq();
        if (since > maxSeq) {
          throw Object.assign(new Error(`非法游标 since=${since}（当前 maxSeq=${maxSeq}），请重新取快照`), {
            code: "invalid_cursor",
          });
        }
        const snapshot = runtime.snapshot();
        const replay: PersistentEvent[] = since > 0 ? runtime.getEventLog(since, REPLAY_LIMIT + 1) : [];
        if (replay.length > REPLAY_LIMIT) {
          throw Object.assign(new Error("补发区间过大，请重新取快照"), { code: "cursor_too_old" });
        }
        const result: ConnectResult = {
          seq: snapshot.seq,
          replay,
          snapshot: {
            projects: snapshot.projects,
            sessions: snapshot.sessions,
            tasks: snapshot.tasks,
            confirmations: snapshot.confirmations,
          },
        };
        this.subscribers.add(socket);
        return result;
      }
      case "create_project":
        return runtime.createProject(requireString("name"));
      case "create_session":
        return runtime.createSession({
          projectId: requireString("project_id"),
          cwd: requireString("cwd"),
          confirmTools: Array.isArray(params["confirm_tools"])
            ? (params["confirm_tools"] as unknown[]).map(String)
            : undefined,
        });
      case "submit":
        return runtime.submit({
          sessionId: requireString("session_id"),
          requestId: requireString("request_id"),
          input: requireString("input"),
        });
      case "continue":
        return runtime.continueTask({
          taskId: requireString("task_id"),
          requestId: requireString("request_id"),
          input: requireString("input"),
        });
      case "interrupt":
        await runtime.interruptTask(requireString("task_id"));
        return { accepted: true };
      case "cancel":
        await runtime.cancelTask(requireString("task_id"));
        return { accepted: true };
      case "resume_queue":
        return runtime.resumeQueue(requireString("session_id"));
      case "respond_confirmation": {
        const decision = params["decision"];
        if (decision !== "approve" && decision !== "reject") {
          throw Object.assign(new Error('decision 必须是 "approve" 或 "reject"'), { code: "invalid_params" });
        }
        return runtime.respondConfirmation(requireString("confirmation_id"), decision === "approve" ? "approved" : "rejected");
      }
      case "get_task": {
        const task = runtime.store.getTask(requireString("task_id"));
        if (!task) throw Object.assign(new Error("任务不存在"), { code: "not_found" });
        return {
          task,
          toolOps: runtime.store.listToolOpsByTask(task.id),
          confirmations: runtime.store.listConfirmationsByTask(task.id),
        };
      }
      case "stop": {
        void runtime.stop("control_plane").catch(() => {});
        return { accepted: true };
      }
      default:
        throw Object.assign(new Error(`未知操作：${request.op}`), { code: "unknown_op" });
    }
  }

  private reply(socket: net.Socket, response: ControlResponse): void {
    if (socket.destroyed) return;
    socket.write(encodeFrame(response));
  }

  /** 事务提交后的事件广播（持久事件先落库，提交成功才到达这里）。 */
  broadcast(events: PersistentEvent[]): void {
    if (events.length === 0) return;
    for (const socket of this.subscribers) {
      for (const event of events) {
        if (socket.destroyed) break;
        socket.write(encodeFrame({ v: 1, push: "event", event }));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.subscribers.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      fs.rmSync(this.runtime.socketPath(), { force: true });
    } catch {
      // 忽略
    }
  }
}
