/**
 * 控制面服务：Unix socket 上的换行分帧 JSON。
 *
 * connect 的快照读取与订阅注册在同一个同步段内完成（Node 单线程），
 * 保证快照序号 N 与实时推送之间无缺口；慢客户端断开后凭游标补发，
 * 服务端不为单个客户端在内存里积压事件。
 *
 * 拥有者认证（ADR 0003）：socket 位于受控目录，任何连接在 auth 操作成功
 * 前不返回快照、不执行请求。令牌仅存于控制面目录的 owner.token（0600，
 * 后台身份持有），多用户部署由配置步骤把令牌以 0400 放入拥有者可读位置。
 */

import * as net from "node:net";
import * as fs from "node:fs";
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  type ConnectResult,
  type ControlRequest,
  type ControlResponse,
  encodeFrame,
} from "./protocol.ts";
import { ensureOwnerToken, tokenMatches } from "./owner-token.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { AccessMode, GrantedPath, PersistentEvent } from "../core/types.ts";

const REPLAY_LIMIT = 5000;

export class ControlServer {
  private server: net.Server;
  private subscribers = new Set<net.Socket>();
  private authed = new WeakSet<net.Socket>();
  private runtime: Runtime;
  private readonly ownerToken: string;
  private stopped = false;

  private constructor(runtime: Runtime, ownerToken: string) {
    this.runtime = runtime;
    this.ownerToken = ownerToken;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  static async start(runtime: Runtime): Promise<ControlServer> {
    // 拥有者令牌：缺失则生成（0600），已存在则复用；不进入命令行与日志
    const ownerToken = ensureOwnerToken(runtime.controlDir());
    const server = new ControlServer(runtime, ownerToken);
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
    // socket 位于受控目录（后台 0770，部署时向拥有者开放连接权限）；
    // 再显式收紧 socket 本身
    try {
      fs.chmodSync(socketPath, 0o660);
    } catch {
      // 个别平台不支持 socket chmod；目录权限仍然生效
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
        void this.handleLine(socket, line);
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
      this.reply(socket, { v: CONTROL_PROTOCOL_VERSION, id: "", ok: false, error: { code: "bad_frame", message: "非法 JSON 帧" } });
      return;
    }
    if (
      request.v !== CONTROL_PROTOCOL_VERSION ||
      typeof request.id !== "string" ||
      typeof request.op !== "string"
    ) {
      this.reply(socket, {
        v: CONTROL_PROTOCOL_VERSION,
        id: String((request as any)?.id ?? ""),
        ok: false,
        error: { code: "bad_request", message: `请求必须包含 v=${CONTROL_PROTOCOL_VERSION}、id、op` },
      });
      return;
    }

    if (request.op === "auth") {
      const token = (request.params as Record<string, unknown> | undefined)?.["token"];
      if (typeof token === "string" && tokenMatches(token, this.ownerToken)) {
        this.authed.add(socket);
        this.reply(socket, { v: CONTROL_PROTOCOL_VERSION, id: request.id, ok: true, result: { authenticated: true } });
      } else {
        this.reply(socket, {
          v: CONTROL_PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: { code: "unauthorized", message: "拥有者令牌无效" },
        });
      }
      return;
    }
    if (!this.authed.has(socket)) {
      this.reply(socket, {
        v: CONTROL_PROTOCOL_VERSION,
        id: request.id,
        ok: false,
        error: { code: "unauthorized", message: "未认证：请先以拥有者令牌执行 auth" },
      });
      return;
    }

    try {
      const result = await this.dispatch(socket, request);
      this.reply(socket, { v: CONTROL_PROTOCOL_VERSION, id: request.id, ok: true, result });
    } catch (err: any) {
      const code = err?.code ?? "internal_error";
      this.reply(socket, {
        v: CONTROL_PROTOCOL_VERSION,
        id: request.id,
        ok: false,
        error: { code, message: String(err?.message ?? err) },
      });
    }
  }

  private parseAccessMode(params: Record<string, unknown>): AccessMode | undefined {
    const mode = params["access_mode"];
    if (mode === undefined) return undefined;
    if (mode === "confirm" || mode === "full_access") return mode;
    throw Object.assign(new Error(`访问模式无效：${String(mode)}（confirm | full_access）`), { code: "invalid_params" });
  }

  private parseGrantedPaths(params: Record<string, unknown>): GrantedPath[] | undefined {
    const raw = params["granted_paths"];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      throw Object.assign(new Error("granted_paths 必须是数组"), { code: "invalid_params" });
    }
    return raw.map((entry) => {
      const e = entry as Record<string, unknown>;
      if (typeof e?.["path"] !== "string" || (e["access"] !== "read" && e["access"] !== "read_write")) {
        throw Object.assign(new Error("granted_paths 项必须含 path 与 access（read|read_write）"), { code: "invalid_params" });
      }
      return { path: e["path"], access: e["access"], purpose: typeof e["purpose"] === "string" ? e["purpose"] : "" };
    });
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
            artifacts: snapshot.artifacts,
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
          accessMode: this.parseAccessMode(params),
          grantedPaths: this.parseGrantedPaths(params),
        });
      case "continue":
        return runtime.continueTask({
          taskId: requireString("task_id"),
          requestId: requireString("request_id"),
          input: requireString("input"),
          accessMode: this.parseAccessMode(params),
          grantedPaths: this.parseGrantedPaths(params),
        });
      case "switch_mode": {
        const mode = this.parseAccessMode({ access_mode: params["mode"] });
        if (!mode) throw Object.assign(new Error("mode 必须给出（confirm | full_access）"), { code: "invalid_params" });
        return runtime.switchTaskMode({
          taskId: requireString("task_id"),
          mode,
          grantedPaths: this.parseGrantedPaths(params),
        });
      }
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
        const detail = runtime.getTaskDetail(requireString("task_id"));
        if (!detail) throw Object.assign(new Error("任务不存在"), { code: "not_found" });
        return detail;
      }
      case "read_artifact": {
        const offset = params["offset"] === undefined ? undefined : Number(params["offset"]);
        const length = params["length"] === undefined ? undefined : Number(params["length"]);
        if ((offset !== undefined && !Number.isFinite(offset)) || (length !== undefined && !Number.isFinite(length))) {
          throw Object.assign(new Error("offset/length 必须是数字"), { code: "invalid_params" });
        }
        return runtime.queryArtifact({
          taskId: requireString("task_id"),
          artifactId: requireString("artifact_id"),
          offset,
          length,
        });
      }
      case "list_credentials":
        return runtime.listCredentialBindings();
      case "add_credential":
        return runtime.addCredentialBinding({
          name: requireString("name"),
          host: requireString("host"),
          header: requireString("header"),
          purpose: requireString("purpose"),
          secret: requireString("secret"),
        });
      case "remove_credential":
        return { removed: runtime.removeCredentialBinding(requireString("name")) };
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
        socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, push: "event", event }));
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
