import type { WorkspaceHistoryCursor } from "@ruukoto/core/history-search.ts";
import { parseModelSelection } from "@ruukoto/core/model-selection.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
/**
 * 控制面服务：Unix socket 上的换行分帧 JSON。
 *
 * connect 的快照读取与订阅注册在同一个同步段内完成（Node 单线程），
 * 保证快照序号 N 与实时推送之间无缺口；慢客户端断开后凭游标补发，
 * 服务端不为单个客户端在内存里积压事件。
 *
 * 拥有者认证：socket 位于受控目录，任何连接在 auth 操作成功
 * 前不返回快照、不执行请求。令牌仅存于控制面目录的 owner.token（0600，
 * 后台身份持有），多用户部署由配置步骤把令牌以 0400 放入拥有者可读位置。
 * Note: 见 .agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md
 */

import type { DataCategory,GrantedPath,Memory,MemorySourceRef,ModelSelection,PersistentEvent,SessionDefaultMode } from "@ruukoto/core/types.ts";
import { SESSION_DEFAULT_MODES,isAccessMode,isSessionDefaultMode } from "@ruukoto/core/types.ts";
import { capEventForWire,frameBytes } from "@ruukoto/core/views.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import * as fs from "node:fs";
import * as net from "node:net";
import { parseWorkflowControl } from "@ruukoto/core/workflow.ts";
import { ensureOwnerToken,tokenMatches } from "./owner-token.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  encodeFrame,
  type ConnectResult,
  type ControlRequest,
  type ControlResponse,
} from "./protocol.ts";

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
          message: `协议版本不兼容：服务端 v${CONTROL_PROTOCOL_VERSION}，请求 v${String((request as any)?.v)}；${request.v > CONTROL_PROTOCOL_VERSION ? "后台版本较旧，请结束旧后台进程后重开入口" : "请升级客户端"}`,
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
      this.reply(socket, { v: CONTROL_PROTOCOL_VERSION, id: request.id, ok: false, error: errorReply(err) });
    }
  }

  private parseAccessMode(params: Record<string, unknown>): SessionDefaultMode | undefined {
    const mode = params["access_mode"];
    if (mode === undefined) return undefined;
    if (isSessionDefaultMode(mode)) return mode;
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
    const workflowParams = (...allowed: string[]): void => {
      if (Object.keys(params).some(key => !allowed.includes(key))) throw new RuntimeApiError("invalid_params", "工作流参数含未开放字段；请按接口提交，身份和授权由宿主核实");
    };
    const workflowInt = (key: string, fallback: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
      const value = params[key] ?? fallback;
      if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new RuntimeApiError("invalid_params", `${key} 超出允许整数范围`);
      return value as number;
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
            product: runtime.productType,
            projects: snapshot.projects,
            sessions: snapshot.sessions,
            tasks: snapshot.tasks,
            confirmations: snapshot.confirmations,
            artifacts: snapshot.artifacts,
            previews: snapshot.previews,
            instanceId: snapshot.instanceId,
            execution: snapshot.execution,
            defaultModel: snapshot.defaultModel,
            mainSessionId: snapshot.mainSessionId,
            roleSessionIds: snapshot.roleSessionIds,
            subAgentSessionIds: snapshot.subAgentSessionIds,
            workDelegations: snapshot.workDelegations,
            subAgents: snapshot.subAgents,
          },
        };
        this.subscribers.add(socket);
        return result;
      }
      case "create_project":
        return runtime.createProject(requireString("name"), optionalRequestId());
      case "branch_session": {
        if (params["name"] !== undefined && typeof params["name"] !== "string") throw new RuntimeApiError("invalid_params", "name 必须是字符串");
        const requestId = optionalRequestId();
        if (!requestId) throw new RuntimeApiError("invalid_params", "会话分支必须提供 request_id");
        return runtime.branchSession({ sessionId: requireString("session_id"), requestId, name: params["name"] as string | undefined });
      }
      case "find_branch_session":
        return runtime.findBranchSession(requireString("request_id"));
      case "compact_session": {
        if (params["prompt"] !== undefined && typeof params["prompt"] !== "string") throw new RuntimeApiError("invalid_params", "prompt 必须是字符串");
        const requestId = optionalRequestId();
        if (!requestId) throw new RuntimeApiError("invalid_params", "手动压缩必须提供 request_id");
        return runtime.compactSession({ sessionId: requireString("session_id"), requestId, prompt: params["prompt"] as string | undefined });
      }
      case "get_session_compaction":
        return runtime.getSessionCompaction({ sessionId: requireString("session_id"), requestId: optionalRequestId() });
      case "interrupt_session_compaction":
        return runtime.interruptSessionCompaction({ sessionId: requireString("session_id"), requestId: requireString("request_id") });
      case "get_session_todos":
        return runtime.getSessionTodos(requireString("session_id"));
      case "create_session":
        return runtime.createSession({
          projectId: typeof params["project_id"] === "string" && params["project_id"] ? params["project_id"] : undefined,
          projectName: typeof params["project_name"] === "string" ? params["project_name"] : undefined,
          cwd: requireString("cwd"),
          confirmTools: Array.isArray(params["confirm_tools"])
            ? (params["confirm_tools"] as unknown[]).map(String)
            : undefined,
          createRequestId: optionalRequestId(),
          mode: params["mode"] as SessionDefaultMode | undefined,
          modelSelection: params["model_selection"] as ModelSelection | undefined,
        });
      case "open_workspace":
        return runtime.openWorkspace({
          cwd: requireString("cwd"),
          projectId: typeof params["project_id"] === "string" && params["project_id"] ? params["project_id"] : undefined,
          createRequestId: optionalRequestId(),
          mode: params["mode"] as SessionDefaultMode | undefined,
          modelSelection: params["model_selection"] as ModelSelection | undefined,
        });
      case "read_workspace_git": {
        if (Object.keys(params).some(key => key !== "workspace_id" && key !== "cursor") || params["cursor"] !== undefined && typeof params["cursor"] !== "string") throw new RuntimeApiError("invalid_params", "Git 历史接口只接受登记的工作区与分页游标。");
        return runtime.readWorkspaceGit({ workspaceId: requireString("workspace_id"), cursor: params["cursor"] as string | undefined });
      }
      case "list_workspace_files":
      case "read_workspace_file": {
        const allowed = request.op === "list_workspace_files" ? ["workspace_id", "path"] : ["workspace_id", "path", "offset", "length", "version"];
        if (Object.keys(params).some(key => !allowed.includes(key)) || params["path"] !== undefined && typeof params["path"] !== "string") throw new RuntimeApiError("invalid_params", "文件接口只接受工作区、相对路径与分页参数。");
        const workspaceId = requireString("workspace_id");
        if (request.op === "list_workspace_files") return runtime.listWorkspaceFiles({ workspaceId, path: params["path"] as string | undefined });
        return runtime.readWorkspaceFile({ workspaceId, path: requireString("path"), offset: params["offset"] as number | undefined, length: params["length"] as number | undefined, version: params["version"] as string | undefined });
      }
      // ---------- agent-direction issue 07：旧数据 → 工作区组织迁移 ----------
      case "preview_workspace_migration": {
        const plan = params["plan"];
        if (plan !== undefined && (plan === null || typeof plan !== "object" || Array.isArray(plan))) {
          throw Object.assign(new Error("plan 必须是对象"), { code: "invalid_params" });
        }
        const limit = params["limit"];
        if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        return runtime.previewWorkspaceMigration({
          projectId: requireString("project_id"),
          plan,
          limit: limit as number | undefined,
        });
      }
      case "apply_workspace_migration": {
        const plan = params["plan"];
        if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
          throw Object.assign(new Error("plan 必须是非空对象"), { code: "invalid_params" });
        }
        const revision = params["expected_revision"];
        if (revision !== undefined && (typeof revision !== "string" || !revision)) {
          throw Object.assign(new Error("expected_revision 必须是字符串"), { code: "invalid_params" });
        }
        return runtime.applyWorkspaceMigration({
          projectId: requireString("project_id"),
          instanceId: requireString("instance_id"),
          requestId: requireString("request_id"),
          plan,
          expectedRevision: revision as string | undefined,
        });
      }
      case "get_session_usage":
        return runtime.getSessionUsage(requireString("session_id"));
      case "get_session":
        return runtime.getSession(requireString("session_id"));
      case "list_session_summaries": {
        const scope = params["scope"];
        if (scope !== undefined && scope !== "workspace_chats") throw new RuntimeApiError("invalid_params", "scope 必须为 workspace_chats");
        if (scope === "workspace_chats") {
          if (params["project_id"] !== undefined || params["workspace_id"] !== undefined) throw new RuntimeApiError("invalid_params", "workspace_chats 不接受项目限制");
          return runtime.listSessionSummaries({ scope });
        }
        // issue 07 步骤 4：project_id（原身份）与 workspace_id（组织归属）互斥
        const projectId = params["project_id"];
        const workspaceId = params["workspace_id"];
        const id = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v : undefined);
        if (id(projectId) && id(workspaceId)) {
          throw Object.assign(new Error("project_id 与 workspace_id 互斥，只能传其一"), { code: "invalid_params" });
        }
        if (id(workspaceId)) return runtime.listSessionSummaries({ workspaceId: workspaceId as string });
        if (id(projectId)) return runtime.listSessionSummaries({ projectId: projectId as string });
        throw Object.assign(new Error("project_id 或 workspace_id 必填其一"), { code: "invalid_params" });
      }
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
      // issue 30 §8：摘要模型（provider 与 model_id 同为 null 即清除）
      case "set_summary_model":
        return runtime.setSummaryModel({
          provider: params["provider"] ?? null,
          modelId: params["model_id"] ?? null,
          expectedRevision: params["expected_revision"],
        });
      case "test_model_connection":
        return runtime.testModelConnection({ provider: params["provider"], modelId: params["model_id"] });
      case "set_session_mode": {
        const mode = params["mode"];
        if (!isSessionDefaultMode(mode)) {
          throw Object.assign(new Error(`mode 必须是 ${SESSION_DEFAULT_MODES.join(" 或 ")}`), { code: "invalid_params" });
        }
        return runtime.setSessionDefaultMode({ sessionId: requireString("session_id"), mode, expectedVersion: params["expected_version"] as number });
      }
      case "set_session_archived": {
        if (typeof params["archived"] !== "boolean") throw new RuntimeApiError("invalid_params", "archived 必须是布尔值");
        return runtime.setSessionArchived({ sessionId: requireString("session_id"), archived: params["archived"] });
      }
      case "put_attachment":
        return runtime.putAttachment(params as unknown as import("@ruukoto/core/attachments.ts").AttachmentUpload);
      case "submit":
        return runtime.submit({
          sessionId: requireString("session_id"),
          requestId: requireString("request_id"),
          modelSelection: parseModelSelection(params["model_selection"]),
          input: typeof params["input"] === "string" ? params["input"] : requireString("input"),
          attachments: params["attachments"] as import("@ruukoto/core/attachments.ts").AttachmentMetadata[] | undefined,
          accessMode: this.parseAccessMode(params),
          grantedPaths: this.parseGrantedPaths(params),
        });
      case "continue":
        return runtime.continueTask({
          sessionId: requireString("session_id"),
          taskId: requireString("task_id"),
          requestId: requireString("request_id"),
          modelSelection: parseModelSelection(params["model_selection"]),
          input: typeof params["input"] === "string" ? params["input"] : requireString("input"),
          attachments: params["attachments"] as import("@ruukoto/core/attachments.ts").AttachmentMetadata[] | undefined,
          accessMode: this.parseAccessMode(params),
          grantedPaths: this.parseGrantedPaths(params),
        });
      case "switch_mode": {
        const mode = this.parseAccessMode({ access_mode: params["mode"] });
        if (!mode) throw Object.assign(new Error(`mode 必须给出（${SESSION_DEFAULT_MODES.join(" | ")}）`), { code: "invalid_params" });
        if (!isAccessMode(mode)) throw Object.assign(new Error("任务级模式切换不能进入或退出 Plan；请先中断，再按当前会话模式继续"), { code: "invalid_params" });
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
      case "workflow_definitions":
        workflowParams("offset", "limit");
        return runtime.workflowLibrary.list(workflowInt("offset", 0), workflowInt("limit", 50, 1, 100));
      case "workflow_definition":
        workflowParams("name", "definition_id", "offset", "length", "version_offset");
        return runtime.getWorkflowDefinition({ name: params.name === undefined ? undefined : requireString("name"),
          definitionId: params.definition_id === undefined ? undefined : requireString("definition_id"), offset: workflowInt("offset", 0), length: workflowInt("length", 16384, 1, 65536), versionOffset: workflowInt("version_offset", 0) });
      case "workflow_save": {
        workflowParams("name", "script", "expected_digest", "request_id");
        const expected = params.expected_digest;
        if (expected !== null && typeof expected !== "string") throw new RuntimeApiError("invalid_params", "保存必须提供 expected_digest；新建为 null，更新使用当前摘要");
        return runtime.saveWorkflowDefinition({ name: requireString("name"), script: requireString("script"), expectedDigest: expected, requestKey: `owner:${requireString("request_id")}` });
      }
      case "workflow_saved":
        workflowParams("request_id");
        return runtime.findWorkflowSave(`owner:${requireString("request_id")}`);
      case "workflow_start":
        workflowParams("session_id", "request_id", "name", "script", "title", "description", "input", "max_attempts", "duration_ms");
        if (!("input" in params)) throw new RuntimeApiError("invalid_params", "启动必须提供 JSON input");
        return runtime.startWorkflowOwner({ sessionId: requireString("session_id"), requestKey: requireString("request_id"),
          name: params.name === undefined ? undefined : requireString("name"), script: params.script === undefined ? undefined : requireString("script"),
          title: params.title === undefined ? undefined : requireString("title"), description: params.description === undefined ? undefined : requireString("description"), input: params.input,
          maxAttempts: params.max_attempts === undefined ? undefined : workflowInt("max_attempts", 100, 1, 100),
          durationMs: params.duration_ms === undefined ? undefined : workflowInt("duration_ms", 3600000, 1, 3600000) });
      case "workflow_find":
        workflowParams("session_id", "request_id");
        return runtime.findWorkflow(requireString("session_id"), requireString("request_id"));
      case "workflow_list":
        workflowParams("session_id", "offset", "limit", "scope");
        if (params.scope !== undefined && params.scope !== "current" && params.scope !== "history") throw new RuntimeApiError("invalid_params", "工作流列表范围无效");
        return runtime.listWorkflows(params.session_id === undefined ? undefined : requireString("session_id"), workflowInt("offset", 0), workflowInt("limit", 50, 1, 100), params.scope);
      case "workflow_get":
        workflowParams("run_id", "step_offset");
        return runtime.getWorkflowDetail(requireString("run_id"), workflowInt("step_offset", 0));
      case "workflow_step":
        workflowParams("run_id", "step_key", "offset", "length");
        return runtime.getWorkflowStep(requireString("run_id"), requireString("step_key"), workflowInt("offset", 0), workflowInt("length", 16384, 1, 65536));
      case "workflow_logs":
        workflowParams("run_id", "offset", "length");
        return runtime.getWorkflowLogs(requireString("run_id"), workflowInt("offset", 0), workflowInt("length", 16384, 1, 65536));
      case "workflow_control":
        workflowParams("run_id", "request_id", "expected_version", "control");
        return runtime.controlWorkflow({ runId: requireString("run_id"), requestKey: `owner:${requireString("request_id")}`,
          version: workflowInt("expected_version", 0, 1), control: parseWorkflowControl(params.control) });
      case "workflow_receipt": {
        workflowParams("run_id", "request_id", "operation");
        if (params.operation !== "workflow_answer" && params.operation !== "workflow_control") throw new RuntimeApiError("invalid_params", "请选择需要核实的回答或控制请求");
        return runtime.findWorkflowReceipt(requireString("run_id"), requireString("request_id"), params.operation);
      }
      case "workflow_question": {
        workflowParams("run_id", "step_key", "offset", "length");
        const offset = params["offset"] ?? 0, length = params["length"] ?? 16 * 1024;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(length) || (length as number) <= 0) {
          throw new RuntimeApiError("invalid_params", "offset/length 必须是非负/正整数字节数");
        }
        return runtime.getWorkflowQuestion(requireString("run_id"), requireString("step_key"), offset as number, length as number);
      }
      case "workflow_answer": {
        workflowParams("run_id", "step_key", "question_version", "run_version", "request_id", "answer");
        const version = params["question_version"], runVersion = params["run_version"];
        if (!Number.isSafeInteger(version) || (version as number) < 1 || !Number.isSafeInteger(runVersion) || (runVersion as number) < 1 || !("answer" in params)) {
          throw new RuntimeApiError("invalid_params", "回答必须含正整数问题版本、问题运行代次与 JSON answer");
        }
        const question = runtime.answerWorkflowQuestion({ runId: requireString("run_id"), stepKey: requireString("step_key"),
          requestKey: requireString("request_id"), version: version as number, runVersion: runVersion as number, answer: params["answer"] });
        return { runId: question.runId, stepKey: question.stepKey, status: question.status, version: question.version, runVersion: question.runVersion };
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
          if (!Number.isSafeInteger(n) || n < 0) {
            throw Object.assign(new Error(`${key} 必须是非负安全整数`), { code: "invalid_params" });
          }
          return n;
        };
        for (const key of ["before", "after", "around", "source"]) {
          if (params[key] !== undefined && (typeof params[key] !== "string" || !(params[key] as string).length)) throw new RuntimeApiError("invalid_params", `${key} 必须为非空字符串`);
        }
        if (["before", "after", "around"].filter(key => params[key] !== undefined).length > 1) throw new RuntimeApiError("invalid_params", "before、after 与 around 互斥");
        const input = {
          sessionId: requireString("session_id"),
          before: params["before"] as string | undefined,
          after: params["after"] as string | undefined,
          around: params["around"] as string | undefined,
          source: params["source"] as string | undefined,
          limit: num("limit"),
          entryTextCap: num("entry_text_cap"),
          pageTextBudget: num("page_text_budget"),
        };
        return input.around || input.after || input.source ? runtime.readHistoryWindow(input) : runtime.readHistory(input);
      }
      case "read_tool_result": {
        const length = params["length"];
        const field = params["field"];
        const offset = params["offset"];
        if (length !== undefined && (!Number.isSafeInteger(length) || (length as number) < 1)) {
          throw new RuntimeApiError("invalid_params", "length 必须是正安全整数");
        }
        if (field !== undefined && field !== "text" && field !== "patch" && field !== "writeContent") {
          throw new RuntimeApiError("invalid_params", "field 必须是 text、patch 或 writeContent");
        }
        if (offset !== undefined && (field === undefined || !Number.isSafeInteger(offset) || (offset as number) < 0)) {
          throw new RuntimeApiError("invalid_params", "offset 必须配合 field 使用，且是非负安全整数");
        }
        if (field !== undefined && length !== undefined && ((length as number) < 4 || (length as number) > 64 * 1024)) {
          throw new RuntimeApiError("invalid_params", "分页 length 必须是 4–65536 的整数字节数");
        }
        return runtime.readToolResult({
          sessionId: requireString("session_id"), entryId: requireString("entry_id"), length: length as number | undefined,
          field, offset: offset as number | undefined,
        });
      }
      case "read_history_entry":
        for (const key of ["offset", "length"]) {
          if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || Number(params[key]) < (key === "length" ? 1 : 0))) throw new RuntimeApiError("invalid_params", `${key} 必须为有效字节整数`);
        }
        if (params["source"] !== undefined && (typeof params["source"] !== "string" || !params["source"])) throw new RuntimeApiError("invalid_params", "source 必须为非空字符串");
        return runtime.readHistoryEntry({
          sessionId: requireString("session_id"),
          entryId: requireString("entry_id"),
          source: params["source"] as string | undefined,
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
          sessionId: typeof params["session_id"] === "string" ? params["session_id"] : undefined,
          offset,
          length,
        });
      }
      case "list_credentials":
        return runtime.listCredentialBindings({ projectId: params["project_id"] === undefined ? undefined : requireString("project_id"), endpoint: params["endpoint"] === undefined ? undefined : requireString("endpoint") });
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
        const scope = params["scope"];
        if (scope !== undefined && scope !== "workspace_chats") throw new RuntimeApiError("invalid_params", "scope 必须为 workspace_chats");
        const num = (key: string): number | undefined => {
          const v = params[key];
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isSafeInteger(n) || n < 0) {
            throw new RuntimeApiError("invalid_params", `${key} 必须是非负安全整数`);
          }
          return n;
        };
        const rawCursor = params["cursor"];
        let cursor: { sessionId: string; byteOffset: number } | WorkspaceHistoryCursor | null | undefined;
        if (rawCursor === undefined) {
          cursor = undefined;
        } else if (rawCursor === null) {
          cursor = null;
        } else {
          if (typeof rawCursor !== "object" || Array.isArray(rawCursor)) throw new RuntimeApiError("invalid_params", "cursor 必须为对象");
          const c = rawCursor as Record<string, unknown>;
          if (typeof c["session_id"] !== "string" || !c["session_id"] || !Number.isSafeInteger(c["byte_offset"]) || Number(c["byte_offset"]) < -1) throw new RuntimeApiError("invalid_params", "cursor 必须含有效 session_id 与 byte_offset");
          const base = { sessionId: c["session_id"], byteOffset: c["byte_offset"] as number };
          if (c["phase"] === undefined) cursor = base;
          else {
            if (scope !== "workspace_chats" || (c["phase"] !== "index" && c["phase"] !== "scan") || !Number.isSafeInteger(c["read_offset"]) || Number(c["read_offset"]) < 0 || typeof c["query_key"] !== "string") throw new RuntimeApiError("invalid_params", "搜索进度游标无效，请重新搜索");
            const source = c["source"] as Record<string, unknown> | undefined;
            if (!source || ["file_dev", "file_ino", "min_size"].some(key => !Number.isSafeInteger(source[key]) || Number(source[key]) < 0)) throw new RuntimeApiError("invalid_params", "搜索来源游标无效，请重新搜索");
            cursor = { ...base, phase: c["phase"], readOffset: c["read_offset"] as number, queryKey: c["query_key"], source: { fileDev: source["file_dev"] as number, fileIno: source["file_ino"] as number, minSize: source["min_size"] as number } };
          }
        }
        return runtime.searchHistory({
          query: requireString("query"),
          scope,
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
          expectedVersion: optionalExpectedVersion(),
        });
      }
      case "set_project_web_search": {
        const enabled = params["enabled"];
        if (typeof enabled !== "boolean") {
          throw Object.assign(new Error("enabled 必须是布尔值"), { code: "invalid_params" });
        }
        return runtime.setProjectWebSearch({
          projectId: requireString("project_id"),
          enabled,
          expectedVersion: optionalExpectedVersion(),
        });
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
      case "list_subagent_roles":
        return runtime.listSubAgentRoles();
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
        return { removed: await runtime.removeCredentialBinding(requireString("name")) };
      // ---------- issue 16：MCP 服务配置 ----------
      case "mcp_sources":
        return runtime.mcpSources({ workspaceId: requireString("workspace_id"), offset: workflowInt("offset", 0), limit: workflowInt("limit", 50, 1, 100), selectedProjectId: params["selected_project_id"] === undefined ? undefined : requireString("selected_project_id") });
      case "mcp_save_credential":
        return runtime.mcpSaveCredential({ projectId: requireString("project_id"), name: requireString("name"), endpoint: requireString("endpoint"), secret: requireString("secret") });
      case "mcp_remove_credential":
        return runtime.mcpRemoveCredential(requireString("project_id"), requireString("name"));
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
        if (params["credential"] !== undefined && params["credential"] !== null && (typeof params["credential"] !== "string" || !params["credential"].trim())) throw new RuntimeApiError("invalid_params", "credential 须为非空绑定名或 null；不提供表示保留。");
        if (params["enabled"] !== undefined && typeof params["enabled"] !== "boolean") throw new RuntimeApiError("invalid_params", "enabled 必须是布尔值。");
        return runtime.mcpConfigure({
          serviceId: params["service_id"] === undefined ? undefined : requireString("service_id"),
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
        return { services: runtime.mcpListServices(params["project_id"] === undefined ? undefined : requireString("project_id")) };
      case "mcp_set_enabled": {
        if (typeof params["enabled"] !== "boolean") {
          throw Object.assign(new Error("enabled 必须是布尔值"), { code: "invalid_params" });
        }
        return runtime.mcpSetEnabled(requireString("service_id"), params["enabled"] as boolean, optionalExpectedVersion());
      }
      case "mcp_remove":
        return { removed: runtime.mcpRemoveService(requireString("service_id"), optionalExpectedVersion()) };
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
      // qq_group_update 已删除（核心群聊退役，agent-direction issue 20，协议 v14）；
      // 旧客户端经版本不匹配被拒，旧 CLI 命令只打印退役提示
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
      // ---------- issue 10：长期操作授权目录（只查询/带版本撤销，不获得创建或扩大能力） ----------
      case "service_grant_list": {
        const limit = params["limit"] === undefined ? undefined : Number(params["limit"]);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw Object.assign(new Error("limit 必须是正整数"), { code: "invalid_params" });
        }
        return runtime.serviceGrantList({
          cursor: typeof params["cursor"] === "string" ? params["cursor"] : undefined,
          limit,
        });
      }
      case "service_grant_get":
        return runtime.serviceGrantGet(requireString("permission_id"));
      // ---------- issue 11：工作委托与 SubAgent（只读查询；委派经模型委派工具） ----------
      case "work_list": {
        const sessionId = params["session_id"];
        if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) {
          throw Object.assign(new Error("session_id 必须是非空字符串"), { code: "invalid_params" });
        }
        return runtime.workList(sessionId as string | undefined);
      }
      case "work_get":
        return runtime.workGet(requireString("work_id"));
      // issue 12：拥有者显式关闭（有活动任务拒绝；历史与产物保留；已关闭幂等）
      case "subagent_close":
        return runtime.closeSubAgent(requireString("sub_agent_id"));
      // issue 14：拥有者整项取消（活动/排队任务停止；已取消幂等；其他工作不受影响）
      case "work_cancel": {
        const reason = params["reason"];
        if (reason !== undefined && typeof reason !== "string") {
          throw Object.assign(new Error("reason 必须是字符串"), { code: "invalid_params" });
        }
        return runtime.cancelWork(requireString("work_id"), { reason: reason as string | undefined });
      }
      case "service_grant_revoke": {
        const expected = params["expected_version"];
        if (!Number.isInteger(expected) || (expected as number) < 1) throw Object.assign(new Error("expected_version 必须是正整数"), { code: "invalid_params" });
        return runtime.serviceGrantRevoke(requireString("permission_id"), expected as number);
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

/**
 * 错误应答的码：业务码（小写蛇形）原样；系统码（ENOENT、ERR_SQLITE_* 等）与没带码的
 * 异常不进协议，统一为 internal_error（客户端按应答丢失处理），原码留在 message。
 */
export function errorReply(err: any): { code: string; message: string } {
  const raw = err?.code;
  const message = String(err?.message ?? err);
  if (typeof raw === "string" && /^[a-z][a-z0-9_]*$/.test(raw)) return { code: raw, message };
  return { code: "internal_error", message: raw === undefined ? message : `${String(raw)}：${message}` };
}
