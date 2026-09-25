import { parseModelSelection } from "../runtime/runtime.ts";
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
import { capEventForWire, frameBytes } from "../core/views.ts";
import { ensureOwnerToken, tokenMatches } from "./owner-token.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { AccessMode, DataCategory, GrantedPath, Memory, MemorySourceRef, PersistentEvent } from "../core/types.ts";
import { SESSION_DEFAULT_MODES, isAccessMode } from "../core/types.ts";

const REPLAY_LIMIT = 5000;

export class ControlServer {
  private server: net.Server;
  private subscribers = new Set<net.Socket>();
  /** 全部连接（含未订阅/未认证的）；停止时强制关闭，避免 close 等待悬挂。 */
  private connections = new Set<net.Socket>();
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
    this.connections.add(socket);
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
      this.connections.delete(socket);
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
    if (request.v !== CONTROL_PROTOCOL_VERSION) {
      this.reply(socket, {
        v: CONTROL_PROTOCOL_VERSION,
        id: String((request as any)?.id ?? ""),
        ok: false,
        error: {
          code: "protocol_version",
          message: `协议版本不兼容：服务端 v${CONTROL_PROTOCOL_VERSION}，请求 v${String((request as any)?.v)}；请升级客户端`,
        },
      });
      return;
    }
    if (typeof request.id !== "string" || typeof request.op !== "string") {
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
    if (isAccessMode(mode)) return mode;
    throw Object.assign(new Error(`访问模式无效：${String(mode)}（${SESSION_DEFAULT_MODES.join(" | ")}）`), { code: "invalid_params" });
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
    /** 可选期望版本（乐观并发）：非负整数，缺省 undefined。 */
    const optionalExpectedVersion = (): number | undefined => {
      const value = params["expected_version"];
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || (value as number) < 0) {
        throw Object.assign(new Error("expected_version 必须是非负整数"), { code: "invalid_params" });
      }
      return value as number;
    };
    /** 可选创建幂等键（issue 21，create_project/create_session）：1-128 位字母/数字/_/-。 */
    const optionalRequestId = (): string | undefined => {
      const value = params["request_id"];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
        throw Object.assign(new Error("request_id 必须是 1-128 位字母、数字、下划线或连字符"), { code: "invalid_params" });
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
          // 补发事件同样经有界视图转换（线上载荷不携带完整大参数）
          replay: replay.map(capEventForWire),
          snapshot: {
            projects: snapshot.projects,
            sessions: snapshot.sessions,
            tasks: snapshot.tasks,
            confirmations: snapshot.confirmations,
            artifacts: snapshot.artifacts,
            previews: snapshot.previews,
            instanceId: snapshot.instanceId,
            execution: snapshot.execution,
            defaultModel: snapshot.defaultModel,
            roleSessionIds: snapshot.roleSessionIds,
          },
        };
        this.subscribers.add(socket);
        return result;
      }
      case "create_project":
        return runtime.createProject(requireString("name"), optionalRequestId());
      case "create_session":
        return runtime.createSession({
          projectId: typeof params["project_id"] === "string" && params["project_id"] ? params["project_id"] : undefined,
          projectName: typeof params["project_name"] === "string" ? params["project_name"] : undefined,
          cwd: requireString("cwd"),
          confirmTools: Array.isArray(params["confirm_tools"])
            ? (params["confirm_tools"] as unknown[]).map(String)
            : undefined,
          createRequestId: optionalRequestId(),
        });
      case "get_session":
        return runtime.getSession(requireString("session_id"));
      case "list_models": {
        for (const key of ["offset", "limit"]) {
          if (params[key] !== undefined && (!Number.isInteger(params[key]) || Number(params[key]) < (key === "limit" ? 1 : 0))) {
            throw Object.assign(new Error(`${key} 必须是有效整数`), { code: "invalid_params" });
          }
        }
        return runtime.listModels({ provider: params["provider"] === undefined ? undefined : requireString("provider"), offset: params["offset"] as number | undefined, limit: params["limit"] as number | undefined });
      }
      case "set_session_model":
        return runtime.setSessionModel({ sessionId: requireString("session_id"), modelSelection: parseModelSelection(params["model_selection"]), expectedVersion: params["expected_version"] as number });
      // ---------- issue 21 §3/§4：模型配置管理（修订核对在 Runtime 内） ----------
      case "get_model_config":
        return runtime.getModelConfig();
      case "save_model_catalog": {
        if (typeof params["providers"] !== "object" || params["providers"] === null || Array.isArray(params["providers"])) {
          throw Object.assign(new Error("providers 必须是对象"), { code: "invalid_params" });
        }
        return runtime.saveModelCatalog({ providers: params["providers"], expectedRevision: params["expected_revision"] });
      }
      case "set_model_api_key":
        return runtime.setModelApiKey({ provider: params["provider"], apiKey: params["api_key"], expectedRevision: params["expected_revision"] });
      case "remove_model_api_key":
        return runtime.removeModelApiKey({ provider: params["provider"], expectedRevision: params["expected_revision"] });
      case "remove_model_provider":
        return runtime.removeModelProvider({ provider: params["provider"], expectedRevision: params["expected_revision"] });
      case "set_default_model":
        return runtime.setDefaultModel({
          provider: params["provider"],
          modelId: params["model_id"],
          thinkingLevel: params["thinking_level"],
          expectedRevision: params["expected_revision"],
        });
      case "test_model_connection":
        return runtime.testModelConnection({ provider: params["provider"], modelId: params["model_id"] });
      case "set_session_mode": {
        const mode = params["mode"];
        if (!isAccessMode(mode)) {
          throw Object.assign(new Error(`mode 必须是 ${SESSION_DEFAULT_MODES.join(" 或 ")}`), { code: "invalid_params" });
        }
        return runtime.setSessionDefaultMode({ sessionId: requireString("session_id"), mode, expectedVersion: params["expected_version"] as number });
      }
      case "submit":
        return runtime.submit({
          sessionId: requireString("session_id"),
          requestId: requireString("request_id"),
          modelSelection: parseModelSelection(params["model_selection"]),
          input: requireString("input"),
          accessMode: this.parseAccessMode(params),
          grantedPaths: this.parseGrantedPaths(params),
        });
      case "continue":
        return runtime.continueTask({
          sessionId: requireString("session_id"),
          taskId: requireString("task_id"),
          requestId: requireString("request_id"),
          modelSelection: parseModelSelection(params["model_selection"]),
          input: requireString("input"),
          accessMode: this.parseAccessMode(params),
          grantedPaths: this.parseGrantedPaths(params),
        });
      case "switch_mode": {
        const mode = this.parseAccessMode({ access_mode: params["mode"] });
        if (!mode) throw Object.assign(new Error(`mode 必须给出（${SESSION_DEFAULT_MODES.join(" | ")}）`), { code: "invalid_params" });
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
        return runtime.resumeQueue(requireString("session_id"), params["model_selection"] === undefined ? undefined : parseModelSelection(params["model_selection"]));
      case "respond_confirmation": {
        const decision = params["decision"];
        if (decision !== "approve" && decision !== "reject") {
          throw Object.assign(new Error('decision 必须是 "approve" 或 "reject"'), { code: "invalid_params" });
        }
        const version = params["permission_version"];
        if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1)) {
          throw Object.assign(new Error("permission_version 必须是正整数"), { code: "invalid_params" });
        }
        return runtime.respondConfirmation(
          requireString("confirmation_id"),
          decision === "approve" ? "approved" : "rejected",
          version as number | undefined,
        );
      }
      case "get_task": {
        const detail = runtime.getTaskDetail(requireString("task_id"));
        if (!detail) throw Object.assign(new Error("任务不存在"), { code: "not_found" });
        return detail;
      }
      case "find_task":
        return runtime.findTaskByRequest({
          sessionId: requireString("session_id"),
          requestId: requireString("request_id"),
        });
      case "list_tasks": {
        const limit = params["limit"] === undefined ? undefined : Number(params["limit"]);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        return runtime.listTasks({
          sessionId: requireString("session_id"),
          before: typeof params["before"] === "string" ? params["before"] : undefined,
          limit,
        });
      }
      case "read_task_events":
        return runtime.readTaskEvents({
          taskId: requireString("task_id"),
          afterSeq: params["after_seq"] as number | undefined,
          limit: params["limit"] as number | undefined,
        });
      case "read_history": {
        const num = (key: string): number | undefined => {
          const v = params[key];
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) {
            throw Object.assign(new Error(`${key} 必须是非负数字`), { code: "invalid_params" });
          }
          return n;
        };
        return runtime.readHistory({
          sessionId: requireString("session_id"),
          before: typeof params["before"] === "string" ? params["before"] : undefined,
          limit: num("limit"),
          entryTextCap: num("entry_text_cap"),
          pageTextBudget: num("page_text_budget"),
        });
      }
      case "read_history_entry":
        return runtime.readHistoryEntry({
          sessionId: requireString("session_id"),
          entryId: requireString("entry_id"),
          offset: params["offset"] === undefined ? undefined : Number(params["offset"]),
          length: params["length"] === undefined ? undefined : Number(params["length"]),
        });
      case "get_confirmation_params":
        return runtime.getConfirmationParams({
          confirmationId: requireString("confirmation_id"),
          offset: params["offset"] === undefined ? undefined : Number(params["offset"]),
          length: params["length"] === undefined ? undefined : Number(params["length"]),
        });
      case "get_tool_op_params":
        return runtime.getToolOpParams({
          toolOpId: requireString("tool_op_id"),
          offset: params["offset"] === undefined ? undefined : Number(params["offset"]),
          length: params["length"] === undefined ? undefined : Number(params["length"]),
        });
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
      // ---------- issue 05：资料授权 / 历史检索 / 记忆 / 选择记录 ----------
      case "create_data_grant":
        return runtime.createDataGrant({
          fromProjectId: requireString("from_project_id"),
          toProjectId: requireString("to_project_id"),
          category: requireString("category") as DataCategory,
          purpose: typeof params["purpose"] === "string" ? params["purpose"] : undefined,
        });
      case "revoke_data_grant":
        return runtime.revokeDataGrant(requireString("grant_id"));
      case "list_data_grants":
        return { grants: runtime.listDataGrants({ includeRevoked: params["include_revoked"] === true }) };
      case "search_history": {
        const num = (key: string): number | undefined => {
          const v = params[key];
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) {
            throw Object.assign(new Error(`${key} 必须是非负数字`), { code: "invalid_params" });
          }
          return n;
        };
        const rawCursor = params["cursor"];
        let cursor: { sessionId: string; byteOffset: number } | null | undefined;
        if (rawCursor === undefined) {
          cursor = undefined;
        } else if (rawCursor === null) {
          cursor = null;
        } else {
          const c = rawCursor as Record<string, unknown>;
          if (typeof c?.["session_id"] !== "string" || typeof c?.["byte_offset"] !== "number") {
            throw Object.assign(new Error("cursor 必须含 session_id 与 byte_offset"), { code: "invalid_params" });
          }
          cursor = { sessionId: c["session_id"], byteOffset: c["byte_offset"] };
        }
        return runtime.searchHistory({
          query: requireString("query"),
          projectId: typeof params["project_id"] === "string" ? params["project_id"] : undefined,
          sessionId: typeof params["session_id"] === "string" ? params["session_id"] : undefined,
          taskId: typeof params["task_id"] === "string" ? params["task_id"] : undefined,
          role: typeof params["role"] === "string" ? params["role"] : undefined,
          since: typeof params["since"] === "string" ? params["since"] : undefined,
          until: typeof params["until"] === "string" ? params["until"] : undefined,
          limit: num("limit"),
          scanLimit: num("scan_limit"),
          cursor,
          contextChars: num("context_chars"),
        });
      }
      case "set_project_instructions": {
        const files = params["files"];
        if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) {
          throw Object.assign(new Error("files 必须是字符串数组"), { code: "invalid_params" });
        }
        return runtime.setProjectInstructions({
          projectId: requireString("project_id"),
          files: files as string[],
        });
      }
      case "set_project_web_search": {
        const enabled = params["enabled"];
        if (typeof enabled !== "boolean") {
          throw Object.assign(new Error("enabled 必须是布尔值"), { code: "invalid_params" });
        }
        return runtime.setProjectWebSearch({ projectId: requireString("project_id"), enabled });
      }
      case "get_project_jev":
        return runtime.getProjectJev(requireString("project_id"));
      case "set_project_jev": {
        if (typeof params["enabled"] !== "boolean" || !(params["credential"] === null || typeof params["credential"] === "string")) {
          throw Object.assign(new Error("enabled 必须是布尔值，credential 必须是凭据名称或 null"), { code: "invalid_params" });
        }
        return runtime.setProjectJev({
          projectId: requireString("project_id"),
          enabled: params["enabled"],
          credential: params["credential"] as string | null,
          expectedVersion: params["expected_version"] as number,
        });
      }
      case "list_memories":
        return {
          memories: runtime.listMemories({
            projectId: typeof params["project_id"] === "string" ? params["project_id"] : undefined,
            personal: params["personal"] === true,
          }),
        };
      case "get_memory":
        return runtime.getMemoryDetail(requireString("memory_id"));
      case "save_memory": {
        const refs = params["source_refs"];
        if (!Array.isArray(refs)) {
          throw Object.assign(new Error("source_refs 必须是数组"), { code: "invalid_params" });
        }
        const expected = params["expected_version"];
        if (expected !== undefined && (!Number.isInteger(expected) || (expected as number) < 1)) {
          throw Object.assign(new Error("expected_version 必须是正整数"), { code: "invalid_params" });
        }
        const projectId = params["project_id"];
        if (projectId !== null && typeof projectId !== "string") {
          throw Object.assign(new Error("project_id 必须是字符串或 null（个人共享）"), { code: "invalid_params" });
        }
        return runtime.ownerSaveMemory({
          memoryId: typeof params["memory_id"] === "string" ? params["memory_id"] : undefined,
          expectedVersion: expected as number | undefined,
          projectId: projectId === undefined ? null : (projectId as string | null),
          category: requireString("category") as Memory["category"],
          content: requireString("content"),
          sourceRefs: refs as MemorySourceRef[],
          reason: typeof params["reason"] === "string" ? params["reason"] : undefined,
        });
      }
      case "revoke_memory": {
        const expected = params["expected_version"];
        if (!Number.isInteger(expected) || (expected as number) < 1) {
          throw Object.assign(new Error("expected_version 必须是正整数"), { code: "invalid_params" });
        }
        return runtime.ownerRevokeMemory({
          memoryId: requireString("memory_id"),
          expectedVersion: expected as number,
          reason: typeof params["reason"] === "string" ? params["reason"] : undefined,
        });
      }
      case "restore_memory": {
        const from = params["from_version"];
        if (!Number.isInteger(from) || (from as number) < 1) {
          throw Object.assign(new Error("from_version 必须是正整数"), { code: "invalid_params" });
        }
        return runtime.ownerRestoreMemory({
          memoryId: requireString("memory_id"),
          fromVersion: from as number,
          reason: typeof params["reason"] === "string" ? params["reason"] : undefined,
        });
      }
      case "list_selection_records": {
        const limit = params["limit"] === undefined ? undefined : Number(params["limit"]);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        return {
          records: runtime.listSelectionRecords({
            taskId: typeof params["task_id"] === "string" ? params["task_id"] : undefined,
            sessionId: typeof params["session_id"] === "string" ? params["session_id"] : undefined,
            limit,
          }),
        };
      }
      case "get_selection_record":
        return runtime.getSelectionRecord(requireString("record_id"));
      case "list_skills":
        return runtime.listSkills();
      case "get_context_breakdown":
        return runtime.getContextBreakdown({ sessionId: requireString("session_id"), recordId: requireString("record_id") });
      // ---------- issue 13：模型请求 prompt 快照（拥有者审计；分页 + 有界读取） ----------
      case "list_prompt_requests": {
        const limit = params["limit"] === undefined ? undefined : Number(params["limit"]);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        const cursorRaw = params["cursor"];
        let cursor: { createdAt: string; id: string } | undefined;
        if (cursorRaw !== undefined) {
          const c = cursorRaw as Record<string, unknown>;
          if (typeof c?.["createdAt"] !== "string" || typeof c?.["id"] !== "string") {
            throw Object.assign(new Error("cursor 必须含 createdAt 与 id"), { code: "invalid_params" });
          }
          cursor = { createdAt: c["createdAt"], id: c["id"] };
        }
        return runtime.listPromptRequests({ sessionId: requireString("session_id"), limit, cursor });
      }
      case "read_prompt_snapshot": {
        const offset = params["offset"] === undefined ? undefined : Number(params["offset"]);
        const length = params["length"] === undefined ? undefined : Number(params["length"]);
        if ((offset !== undefined && !Number.isFinite(offset)) || (length !== undefined && !Number.isFinite(length))) {
          throw Object.assign(new Error("offset/length 必须是数字"), { code: "invalid_params" });
        }
        return runtime.readPromptSnapshot({
          recordId: requireString("record_id"),
          sessionId: requireString("session_id"),
          offset,
          length,
        });
      }
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
      // ---------- issue 16：MCP 服务配置 ----------
      case "mcp_configure": {
        const allowlist = params["tool_allowlist"];
        // 条目形态：工具名字符串，或 { name, effect } 对象（effect 取值由运行层校验）
        const isEntryShape = (s: unknown): boolean =>
          typeof s === "string" ||
          (typeof s === "object" && s !== null && !Array.isArray(s) &&
            typeof (s as Record<string, unknown>)["name"] === "string" &&
            typeof (s as Record<string, unknown>)["effect"] === "string");
        if (!Array.isArray(allowlist) || allowlist.some((s) => !isEntryShape(s))) {
          throw Object.assign(new Error("tool_allowlist 必须是数组（工具名字符串或 { name, effect } 对象）"), { code: "invalid_params" });
        }
        return runtime.mcpConfigure({
          projectId: requireString("project_id"),
          name: requireString("name"),
          endpoint: requireString("endpoint"),
          // 未提供 = 更新时保留现有凭据引用；显式 null = 清除
          credential: typeof params["credential"] === "string" ? params["credential"] : params["credential"] === null ? null : undefined,
          toolAllowlist: allowlist as unknown[],
          enabled: typeof params["enabled"] === "boolean" ? params["enabled"] : undefined,
          expectedVersion: optionalExpectedVersion(),
        });
      }
      case "mcp_list":
        return { services: runtime.mcpListServices(typeof params["project_id"] === "string" ? params["project_id"] : undefined) };
      case "mcp_set_enabled": {
        if (typeof params["enabled"] !== "boolean") {
          throw Object.assign(new Error("enabled 必须是布尔值"), { code: "invalid_params" });
        }
        return runtime.mcpSetEnabled(requireString("service_id"), params["enabled"] as boolean, optionalExpectedVersion());
      }
      case "mcp_remove":
        return { removed: runtime.mcpRemoveService(requireString("service_id")) };
      case "mcp_check":
        return runtime.mcpCheckService(requireString("service_id"));
      // ---------- issue 07：QQ 群聊入口（NapCat OneBot） ----------
      case "qq_configure": {
        if (params["owner_user_id"] !== undefined && params["owner_user_id"] !== null && typeof params["owner_user_id"] !== "string") {
          throw Object.assign(new Error("owner_user_id 必须是 QQ 号字符串或 null"), { code: "invalid_params" });
        }
        if (params["max_reply_chars"] !== undefined && !Number.isInteger(params["max_reply_chars"])) {
          throw Object.assign(new Error("max_reply_chars 必须是整数"), { code: "invalid_params" });
        }
        return runtime.qqConfigure({
          endpoint: requireString("endpoint"),
          credential: typeof params["credential"] === "string" ? params["credential"] : params["credential"] === null ? null : undefined,
          selfId: requireString("self_id"),
          ownerUserId: params["owner_user_id"] as string | null | undefined,
          maxReplyChars: params["max_reply_chars"] as number | undefined,
          expectedVersion: optionalExpectedVersion(),
        });
      }
      case "qq_status":
        return runtime.qqStatus();
      case "qq_set_enabled": {
        if (typeof params["enabled"] !== "boolean") {
          throw Object.assign(new Error("enabled 必须是布尔值"), { code: "invalid_params" });
        }
        return runtime.qqSetEnabled(params["enabled"], optionalExpectedVersion());
      }
      case "qq_group_update": {
        if (typeof params["allow"] !== "boolean") {
          throw Object.assign(new Error("allow 必须是布尔值"), { code: "invalid_params" });
        }
        return runtime.qqGroupUpdate({ groupId: requireString("group_id"), allow: params["allow"], expectedVersion: optionalExpectedVersion() });
      }
      case "qq_inbox_list": {
        const limit = params["limit"] === undefined ? undefined : Number(params["limit"]);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        return { entries: runtime.qqListInbox({ groupId: typeof params["group_id"] === "string" ? params["group_id"] : undefined, limit }) };
      }
      case "qq_outbox_list": {
        const limit = params["limit"] === undefined ? undefined : Number(params["limit"]);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        return { entries: runtime.qqListOutbox({ groupId: typeof params["group_id"] === "string" ? params["group_id"] : undefined, limit }) };
      }
      // ---------- issue 04：Telegram owner 入口 ----------
      case "telegram_configure":
        return runtime.telegramConfigure({
          apiBase: typeof params["api_base"] === "string" ? params["api_base"] : undefined,
          credential: requireString("credential"),
          ownerUserId: requireString("user_id"),
          ownerChatId: typeof params["chat_id"] === "string" ? params["chat_id"] : undefined,
          expectedVersion: optionalExpectedVersion(),
        });
      case "telegram_status":
        return runtime.telegramStatus();
      case "telegram_set_enabled": {
        if (typeof params["enabled"] !== "boolean") {
          throw Object.assign(new Error("enabled 必须是布尔值"), { code: "invalid_params" });
        }
        return runtime.telegramSetEnabled(params["enabled"], optionalExpectedVersion());
      }
      // ---------- issue 03：调度计划与通知发送账本（只查询/取消，不获得发送或改目标能力） ----------
      case "schedule_list":
      case "notification_list": {
        const limit = params["limit"] === undefined ? undefined : Number(params["limit"]);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        const input = {
          status: typeof params["status"] === "string" ? params["status"] : undefined,
          cursor: typeof params["cursor"] === "string" ? params["cursor"] : undefined,
          limit,
        };
        return request.op === "schedule_list" ? runtime.scheduleList(input) : runtime.notificationList(input);
      }
      case "schedule_get":
        return runtime.scheduleGet(requireString("schedule_id"));
      case "schedule_cancel": {
        const expected = params["expected_version"];
        if (!Number.isInteger(expected)) throw Object.assign(new Error("expected_version 必须是整数"), { code: "invalid_params" });
        return runtime.scheduleCancel({ scheduleId: requireString("schedule_id"), expectedVersion: expected as number, reason: requireString("reason") });
      }
      case "notification_get":
        return runtime.notificationGet(requireString("op_id"));
      case "notification_cancel":
        return runtime.notificationCancel({ opId: requireString("op_id"), reason: requireString("reason") });
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
    // 序列化字节数兜底：分页接口按构造应远小于帧上限；超限说明实现回归，
    // 明确报错而不是发送半截帧或静默断开
    if (frameBytes(response) > MAX_FRAME_BYTES) {
      socket.write(
        encodeFrame({
          v: CONTROL_PROTOCOL_VERSION,
          id: response.id,
          ok: false,
          error: { code: "response_too_large", message: "应答超过帧上限：请缩小分页范围重试" },
        } satisfies ControlResponse),
      );
      return;
    }
    socket.write(encodeFrame(response));
  }

  /** 事务提交后的事件广播（持久事件先落库，提交成功才到达这里）。 */
  broadcast(events: PersistentEvent[]): void {
    if (events.length === 0) return;
    // 线上载荷有界化：大参数替换为预览 + 可查询引用
    const frames = events.map((event) => encodeFrame({ v: CONTROL_PROTOCOL_VERSION, push: "event", event: capEventForWire(event) }));
    for (const socket of this.subscribers) {
      for (const frame of frames) {
        if (socket.destroyed) break;
        socket.write(frame);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // 强制关闭全部连接：server.close() 会等待已建立的连接，不主动销毁
    // 则任何仍在线的客户端都会让停止悬挂
    for (const socket of this.connections) socket.destroy();
    this.subscribers.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      fs.rmSync(this.runtime.socketPath(), { force: true });
    } catch {
      // 忽略
    }
  }
}
