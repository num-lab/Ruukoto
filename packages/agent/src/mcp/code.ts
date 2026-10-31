/** Coding's persistent computer connection; freeze and recovery facts belong to the original operation.
 * Note: See .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "@ruukoto/core/store.ts";
import type { JsonRpcMessage, JsonRpcRequest } from "@earendil-works/pi-mcp";
import { randomId, type McpCuaOperation as McpOperation, type Task, type ToolOp } from "@ruukoto/core/types.ts";
import { ownerQuestionTaskEligible } from "@ruukoto/core/owner-questions.ts";
import type { ArtifactStore } from "../artifacts.ts";
import { prepareMacosStdioExecution, stopMacosExecution } from "../execution/native-macos-identity.ts";
import { cuaActionNeed, cuaArguments, cuaBatchPlan, cuaProgram, cuaToolEffect } from "./cua.ts";
import { clearObservationGrant, cuaObservationBlocked, deliverCuaObservations, dropObservationBase, dropObservationGrant, freshCuaGrants, invalidateCuaSnapshots, requireCuaEligibility, revokeActionable, type CuaGrants, type CuaObservationProjection } from "./cua-observation.ts";
import { connectMcpStdio, createMcpStdioTransport, McpError, mcpResponseEnded, type ManagedMcpTransport, type McpCallBinding, type McpCallHooks, type McpConnection, type McpTimeouts, type CallToolResult } from "./transport.ts";
import type { McpServiceConfig, McpStore } from "./store.ts";
import { formatMcpResult, type McpToolInfo } from "./tools.ts";
import { mcpImages, McpImageError } from "./images.ts";

type Execution = McpOperation["execution"];
type CuaToolOp = ToolOp & { mcp: McpOperation };
interface Binding { service: McpServiceConfig; sessionId: string; conn?: McpConnection; transport?: ManagedMcpTransport; execution: Execution; grants: CuaGrants }
export interface CodeCuaStatus {
  state: "idle" | "connecting" | "active" | "frozen" | "recovering";
  sessionId?: string;
  stopped: boolean;
  ownerStarted: boolean;
  observation?: { id: string; artifactIds: string[] };
  original?: { opId: string; taskId: string; sessionId: string; toolName: string; effect: string; state: string };
}

export class CodeCuaManager {
  private binding: Binding | null = null;
  private busy = false;
  private connecting = false;
  private stopping: Promise<CodeCuaStatus> | null = null;
  private readonly directory: string;
  constructor(private readonly store: Store, private readonly services: McpStore, private readonly artifacts: ArtifactStore, dataDir: string, private readonly timeouts: McpTimeouts = {}) {
    const directory = path.join(dataDir, "cua-executions");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = fs.realpathSync(directory);
  }

  recover(): void {
    this.store.withTx(() => {
      for (const op of this.latestExecutions()) {
        if (["closed", "recovered"].includes(op.mcp!.state)) continue;
        const saved = this.store.getToolOp(op.id)!.mcp!;
        this.store.saveMcpOperation(op.id, { ...saved, state: "frozen" });
      }
    });
  }

  private latestExecutions(): CuaToolOp[] {
    return this.store.listOpenMcpOperations(this.binding?.execution.executionId).filter((op): op is CuaToolOp => !!op.mcp?.execution);
  }
  private pending(): CuaToolOp | undefined { return this.latestExecutions().find(op => ["starting", "frozen", "recovering", "sent"].includes(op.mcp!.state)); }
  private save(opId: string, value: McpOperation): void {
    this.store.withTx(() => { const saved = this.store.getToolOp(opId)?.mcp; this.store.saveMcpOperation(opId, { ...saved, ...value } as McpOperation); });
  }
  private original(): CuaToolOp {
    const op = this.pending();
    if (!op) throw new McpError("cua_recovery_unavailable", "没有待恢复的电脑操作；请读取当前电脑状态。");
    return this.store.getToolOp(op.id)! as CuaToolOp;
  }

  private detectClosed(): void {
    if (!this.binding?.conn?.closed && !this.binding?.transport?.closed) return;
    this.binding.grants = freshCuaGrants();
    const last = this.latestExecutions().find(op => op.mcp!.execution.executionId === this.binding!.execution.executionId);
    if (last && !["closed", "recovered", "frozen", "recovering"].includes(last.mcp!.state)) this.save(last.id, { ...last.mcp!, state: "frozen" });
  }

  status(): CodeCuaStatus {
    this.detectClosed();
    const op = this.pending(), mcp = op?.mcp;
    const observation = mcp?.observationOpId && this.store.getToolOp(mcp.observationOpId);
    const task = op && this.store.getTask(op.taskId);
    return { state: this.connecting ? "connecting" : mcp ? mcp.state === "recovering" ? "recovering" : "frozen" : this.binding ? "active" : "idle", sessionId: task?.sessionId ?? this.binding?.sessionId,
      stopped: !!mcp?.stoppedAt, ownerStarted: !!mcp?.ownerStartedAt,
      ...(op && task && mcp ? { original: { opId: op.id, taskId: task.id, sessionId: task.sessionId, toolName: mcp.rawTool.name, effect: mcp.effect, state: mcp.state } } : {}),
      ...(observation ? { observation: { id: observation.id, artifactIds: mcp?.observationArtifactIds ?? [] } } : {}) };
  }

  assertConfigurationChange(): void {
    if (this.pending() || this.binding || this.busy || this.connecting) throw new McpError("cua_binding_active", "电脑仍被会话使用或等待核实；请先暂停，存在未知结果时完成原操作的恢复，再修改电脑配置。");
  }
  private verify(service: McpServiceConfig, task: Task): void {
    const fresh = this.services.getService(service.id), current = this.store.getTask(task.id);
    if (!service.cua || service.cua.kind !== "cua-mac" || !fresh?.enabled || fresh.configVersion !== service.configVersion || !current || current.status !== "running" || current.cancelRequested || current.permissionVersion !== task.permissionVersion || !ownerQuestionTaskEligible(this.store, current)) {
      throw new McpError("cua_source_invalid", "当前电脑来源、配置或权限已失效，未发送该操作；结束本轮并报告拥有者。");
    }
  }

  createTransport(service: McpServiceConfig, task: Task, bind: (request: JsonRpcRequest, signal?: AbortSignal) => McpCallBinding): ManagedMcpTransport {
    let transport: ManagedMcpTransport | undefined;
    let closed = false;
    let initializeId: string | number | undefined;
    const messages = new Set<(message: JsonRpcMessage) => void>();
    const errors = new Set<(error: Error) => void>();
    const closers = new Set<() => void>();
    return {
      get pid() { return transport?.pid; }, get closed() { return closed || !!transport?.closed; },
      start: async () => {
        this.detectClosed();
        this.verify(service, task);
        if (this.binding || this.pending() || this.busy || this.connecting) throw new McpError("cua_binding_busy", "原电脑执行尚未停止并核实；不能建立新连接。");
        this.connecting = true;
        const ref = { executionId: `native_${randomBytes(12).toString("hex")}` };
        let execution: Execution | undefined, opId: string | undefined;
        try {
          const program = await cuaProgram(service.cua!);
          execution = { ...ref, directory: this.directory, fingerprint: createHash("sha256").update(JSON.stringify(program)).digest("hex") };
          opId = randomId("op");
          const operation: McpOperation = { serviceId: service.id, configVersion: service.configVersion, configuration: service.cua as McpOperation["configuration"], effect: "read", rawTool: { name: "initialize", inputSchema: {} }, modelTool: { name: "initialize", inputSchema: {} }, arguments: {}, execution, state: "starting" };
          this.store.withTx(() => { this.store.recordToolIntent({ id: opId!, taskId: task.id, sessionId: task.sessionId, toolName: "cua_connection", params: {} }); this.store.saveMcpOperation(opId!, operation); });
          const programInScope = await prepareMacosStdioExecution(this.directory, ref, program);
          this.verify(service, task);
          transport = createMcpStdioTransport(programInScope, bind);
          this.binding = { service, sessionId: task.sessionId, transport, execution, grants: freshCuaGrants() };
          transport.onError(error => { for (const listener of errors) listener(error); });
          transport.onClose(() => { closed = true; for (const listener of closers) listener(); });
          transport.onMessage(message => {
            void (async () => {
              if ("id" in message && message.id === initializeId && "result" in message) {
                this.store.withTx(() => {
                  this.store.saveMcpOperation(opId!, { ...operation, state: "finished" });
                  this.store.recordToolResult(opId!, "电脑连接已由官方 MCP 初始化。", false);
                  this.store.appendEvent({ type: "task.tool_result", taskId: task.id, toolOpId: opId!, summary: "电脑连接已由官方 MCP 初始化。", isError: false, artifactIds: [] }, { taskId: task.id, sessionId: task.sessionId });
                });
              }
              for (const listener of messages) listener(message);
            })().catch(async () => {
              this.save(opId!, { ...operation, state: "frozen" });
              const proof = await stopMacosExecution(execution!.directory, ref, execution!.fingerprint);
              if (proof.exited) {
                this.save(opId!, { ...operation, state: "closed", stoppedAt: new Date().toISOString() });
                this.binding = null;
                await transport?.close();
              }
              for (const listener of errors) listener(new McpError("evidence_failed", proof.exited ? "电脑初始化结果无法保存；原执行停止已核实，请拥有者检查原操作。" : "电脑初始化结果无法保存，原执行停止尚未核实；保持冻结，请拥有者检查原现场。"));
            }).catch(() => {
              closed = true;
              if (this.binding?.execution.executionId === execution!.executionId) this.binding.grants = freshCuaGrants();
              for (const listener of errors) listener(new McpError("evidence_failed", "电脑初始化结果或停止证明无法保存；保持冻结，请拥有者检查原现场与存储。"));
              for (const listener of closers) listener();
            });
          });
          await transport.start();
        } catch (error) {
          if (execution && opId) {
            const current = this.store.getToolOp(opId)?.mcp as McpOperation | undefined;
            if (current) this.save(opId, { ...current, state: "frozen" });
            const proof = await stopMacosExecution(execution.directory, ref, execution.fingerprint);
            if (proof.exited) {
              if (current) this.save(opId, { ...current, state: "closed", stoppedAt: new Date().toISOString() });
              this.binding = null;
              await transport?.close();
            }
          }
          throw error;
        } finally { this.connecting = false; }
      },
      close: async () => {
        if (closed && !this.binding) return;
        if (this.binding?.transport === transport) await this.stop(service.id);
        else await transport?.close();
        closed = true;
      },
      onMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
      onError(listener) { errors.add(listener); return () => { errors.delete(listener); }; },
      onClose(listener) { closers.add(listener); return () => { closers.delete(listener); }; },
      setProtocolVersion(version) { transport?.setProtocolVersion?.(version); },
      send: async (message, options) => {
        if ("method" in message && message.method === "initialize" && "id" in message) initializeId = message.id;
        if (!transport) throw new McpError("cua_connection_unavailable", "电脑连接未由宿主建立；该请求未发送。");
        await transport.send(message, options);
      },
    };
  }

  private async connect(service: McpServiceConfig, sessionId: string, recovering = false, taskId?: string): Promise<McpConnection> {
    this.detectClosed();
    if (this.busy && !recovering) throw new McpError("cua_binding_busy", "电脑管理动作仍在执行；请等待原操作结束。");
    if (!service.cua || service.cua.kind !== "cua-mac") throw new McpError("cua_product_invalid", "Code 仅支持本机 Mac 电脑入口；请拥有者检查配置。");
    if (!recovering && this.pending()) throw new McpError("cua_frozen", "电脑已冻结；请拥有者核实原执行停止并完成恢复，不能重发旧操作。");
    if (this.binding) {
      if (this.binding.sessionId !== sessionId || this.binding.service.id !== service.id || this.binding.service.configVersion !== service.configVersion) throw new McpError("cua_binding_busy", "电脑已由另一主会话或配置使用；请拥有者先暂停原会话的电脑连接。");
      if (!this.binding.conn) throw new McpError("cua_binding_busy", "电脑连接由原 SDK 持有；请先核实其停止。");
      return this.lease(this.binding.conn);
    }
    if (this.connecting) throw new McpError("cua_binding_busy", "电脑连接正在建立；请等待原主会话完成连接。");
    this.connecting = true;
    const ref = { executionId: `native_${randomBytes(12).toString("hex")}` };
    try {
      const program = await cuaProgram(service.cua);
      const task = taskId && this.store.getTask(taskId);
      if (!task || task.sessionId !== sessionId) throw new McpError("cua_source_invalid", "电脑启动缺少原任务归属；未创建连接，请拥有者检查来源。");
      const opId = randomId("op"), execution = { ...ref, directory: this.directory, fingerprint: createHash("sha256").update(JSON.stringify(program)).digest("hex") };
      const operation: McpOperation = { serviceId: service.id, configVersion: service.configVersion, configuration: service.cua, effect: "read", rawTool: { name: "initialize", inputSchema: {} }, modelTool: { name: "initialize", inputSchema: {} }, arguments: {}, execution, state: "starting" };
      this.store.withTx(() => { this.store.recordToolIntent({ id: opId, taskId: task.id, sessionId, toolName: "cua_connection", params: {} }); this.store.saveMcpOperation(opId, operation); });
      let prepared: Awaited<ReturnType<typeof prepareMacosStdioExecution>>;
      try { prepared = await prepareMacosStdioExecution(this.directory, ref, program); }
      catch (error) { this.save(opId, { ...operation, state: "closed" }); throw error; }
      let conn: McpConnection;
      try { conn = await connectMcpStdio({ serviceId: service.id, ...prepared }, this.timeouts); }
      catch (error) {
        this.save(opId, { ...operation, state: "frozen" });
        const proof = await stopMacosExecution(this.directory, ref, execution.fingerprint);
        if (proof.exited) this.save(opId, { ...operation, state: "closed", stoppedAt: new Date().toISOString() });
        throw error;
      }
      this.binding = { service, sessionId, conn, execution, grants: freshCuaGrants() };
      try {
        this.store.withTx(() => {
          this.store.saveMcpOperation(opId, { ...operation, state: "finished" });
          this.store.recordToolResult(opId, "电脑连接已建立，仅完成协议初始化。", false);
          this.store.appendEvent({ type: "task.tool_result", taskId: task.id, toolOpId: opId, summary: "电脑连接已建立，仅完成协议初始化。", isError: false, artifactIds: [] }, { taskId: task.id, sessionId });
        });
      } catch (error) {
        this.save(opId, { ...operation, state: "frozen" });
        const proof = await stopMacosExecution(this.directory, ref, execution.fingerprint);
        if (proof.exited) {
          this.save(opId, { ...operation, state: "closed", stoppedAt: new Date().toISOString() });
          this.binding = null;
          await conn.close();
        }
        throw error;
      }
      return this.lease(conn);
    } finally { this.connecting = false; }
  }
  private lease(conn: McpConnection): McpConnection {
    return { serviceId: conn.serviceId, endpoint: conn.endpoint, serverInfo: conn.serverInfo, protocolVersion: conn.protocolVersion, pid: conn.pid,
      get closed() { return conn.closed; }, get callEvidence() { return conn.callEvidence; }, listTools: signal => conn.listTools(signal), callTool: (tool, args, signal, hooks) => conn.callTool(tool, args, signal, hooks),
      close: async () => undefined };
  }

  async call(task: Task, meta: McpToolInfo, params: Record<string, unknown>, opId: string, signal?: AbortSignal, consume?: (operation: McpOperation) => void, invoke?: (args: Record<string, unknown>, hooks: McpCallHooks) => Promise<CallToolResult>): Promise<CallToolResult> {
    this.detectClosed();
    this.verify(meta.service, task);
    if (this.pending()) throw new McpError("cua_frozen", "电脑已冻结；停止调用并报告拥有者完成原操作恢复，不能换参数重试。");
    const binding = this.binding;
    if (!binding || binding.sessionId !== task.sessionId || binding.service.id !== meta.service.id || this.busy) throw new McpError("cua_binding_busy", "电脑连接正由另一操作使用；结束本轮并报告拥有者核实连接。");
    if (task.planMode && meta.effect !== "read") throw new McpError("cua_plan_read_only", "计划模式只允许观察电脑；请向拥有者说明所需操作后结束本轮。");
    const args = cuaArguments(meta.service.cua!, meta.remoteName, params, meta.service.toolAllowlist);
    if (meta.effect !== "read") requireCuaEligibility(binding.grants, meta.remoteName, args);
    else if (["get_window_state", "get_desktop_state"].includes(meta.remoteName)) clearObservationGrant(binding.grants, meta.remoteName, args);
    const operation: McpOperation = { serviceId: meta.service.id, configVersion: meta.service.configVersion, configuration: meta.service.cua!.kind === "cua-mac" ? meta.service.cua : undefined, effect: meta.effect,
      rawTool: { name: meta.remoteName, inputSchema: meta.rawInputSchema ?? meta.inputSchema }, modelTool: { name: meta.exposedName, inputSchema: meta.inputSchema }, arguments: args, execution: binding.execution, state: "prepared" };
    this.save(opId, operation);
    this.busy = true;
    let originalRequest: string | undefined;
    try {
      if (!invoke) throw new McpError("cua_official_required", "电脑业务工具必须由官方 MCP 扩展执行。");
      const result = await invoke(args, {
        recordCallRequest: async request => {
          this.verify(meta.service, task);
          if (signal?.aborted) throw new McpError("canceled", "电脑操作已取消，尚未发送；查询原操作并结束本轮。");
          const rpc = JSON.parse(request) as { params: { name: string; arguments: Record<string, unknown> } };
          if (rpc.params.name !== meta.remoteName || JSON.stringify(rpc.params.arguments) !== JSON.stringify(args)) throw new McpError("authorization_invalid", "电脑原调用目标或参数已改变；该请求未发送。", false);
          originalRequest = request;
        },
        beforeDispatch: () => {
          this.verify(meta.service, task);
          if (!originalRequest || signal?.aborted) throw new McpError("canceled", "电脑原调用已停止；该请求未发送。", false);
          if (meta.remoteName === "run_steps") revokeActionable(binding.grants, cuaBatchPlan(args).key);
          const sent: McpOperation = { ...operation, request: originalRequest, state: "sent" };
          if (consume) consume(sent); else this.store.withTx(() => { this.verify(meta.service, task); this.store.saveMcpOperation(opId, sent); });
        },
        recordCallProgress: async evidence => {
          const current = this.store.getToolOp(opId)?.mcp;
          if (!current?.request) throw new McpError("evidence_failed", "电脑原请求尚未保存；停止调用并检查存储。");
          this.save(opId, { ...current, ...(evidence.response ? { response: evidence.response } : {}) });
        },
      });
      const current = this.store.getToolOp(opId)!.mcp! as McpOperation;
      if (!current.response || !mcpResponseEnded(current.response)) throw new McpError("remote_incomplete", "电脑原请求尚无完整终结应答，已冻结电脑；停止调用并报告拥有者核实，不能重发旧动作。");
      this.save(opId, { ...current, state: "finished" });
      return result;
    } catch (error) {
      const current = this.store.getToolOp(opId)!.mcp! as McpOperation;
      if (error instanceof McpError && error.requestSent === false) this.save(opId, { ...current, state: "not_sent" });
      else if (current.request && (!current.response || !mcpResponseEnded(current.response))) {
        this.save(opId, { ...current, state: "frozen" });
        binding.grants = freshCuaGrants();
      } else this.save(opId, { ...current, state: current.request ? "finished" : "not_sent" });
      throw error;
    } finally { this.busy = false; }
  }

  /**
   * After host-result persistence and formatting, queue observation metadata;
   * session-history persistence is checked separately before activation.
   * Eligibility uses the final outgoing projection, not this formatted view,
   * and activates only once the result truly enters a model request
   * (deliverObservations): a same-group tool call cannot authorize its own
   * already-planned writes off an observation that just returned.
   * Only get_window_state (including batch trailing observes) and
   * get_desktop_state establish grants; images in write results and
   * verify_state predicate results are not executable observations.
   */
  recordObservation(opId: string, remoteName: string, result: CallToolResult, delivered: { content: { type: string; text?: string; ruukotoMediaRef?: unknown }[]; truncated?: boolean }, modelSeesImages: boolean): void {
    const operation = this.store.getToolOp(opId)?.mcp;
    if (!operation || operation.state !== "finished" || operation.execution?.executionId !== this.binding?.execution.executionId) throw new McpError("cua_observation_invalid", "新观察与电脑执行不匹配；停止操作并报告拥有者核实。");
    const binding = this.binding!, grants = binding.grants;
    const text = delivered.content.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text!).join("\n");
    // Screenshot grants require the image to actually reach the model input;
    // screenshots preserved offline (e.g. by restore) do not count as delivered.
    const image = modelSeesImages && delivered.content.some(part => part.type === "image" && !!part.ruukotoMediaRef);
    const truncated = delivered.truncated === true;
    const state = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent) ? result.structuredContent as Record<string, unknown> : undefined;
    const args = ((operation as McpOperation).arguments ?? {}) as Record<string, unknown>;
    // Grants attribute to the window the returned state reports (upstream may
    // resolve a different target through app/window overrides); missing fields
    // fall back to the request arguments. When both lack the fields the read is
    // unattributable — grant nothing and clear affected windows' grants and
    // baselines since the read baseline may already have moved.
    const stateKey = (inner: Record<string, unknown>) => {
      const pid = inner.pid ?? args.pid, wid = inner.window_id ?? args.window_id;
      return pid !== undefined && wid !== undefined ? `${pid}:${wid}` : undefined;
    };
    if (remoteName === "get_window_state") {
      const key = state ? stateKey(state) : undefined;
      if (state) invalidateCuaSnapshots(grants, state);
      if (state && key && !cuaObservationBlocked(state)) grants.pending.push({ opId, kind: "window", key, state, text, image, truncated });
      else dropObservationGrant(grants, state ? { pid: state.pid, window_id: state.window_id } : args);
    } else if (remoteName === "get_desktop_state") {
      grants.pending.push({ opId, kind: "desktop", ok: image && !cuaObservationBlocked(state) });
    } else if (remoteName === "run_steps") {
      const observation = state?.observation;
      const inner = observation && typeof observation === "object" && (observation as { ok?: unknown }).ok === true ? (observation as { state?: unknown }).state : undefined;
      const key = inner && typeof inner === "object" && !Array.isArray(inner) ? stateKey(inner as Record<string, unknown>) : undefined;
      // Trailing observation unusable (failed, missing or unattributable):
      // dispatch already revoked actionable grants; drop the diff baseline too.
      if (key) invalidateCuaSnapshots(grants, inner as Record<string, unknown>);
      if (key && !cuaObservationBlocked(inner as Record<string, unknown>)) grants.pending.push({ opId, kind: "window", key, state: inner as Record<string, unknown>, text, image, truncated });
      else dropObservationGrant(grants, key ? { pid: (inner as Record<string, unknown>).pid, window_id: (inner as Record<string, unknown>).window_id } : args);
    } else if (cuaToolEffect(binding.service.cua!, remoteName) === "write") {
      grants.pending.push({ opId, kind: "windowHint", need: cuaActionNeed(args) });
    }
  }

  pendingObservationOpIds(sessionId: string): string[] {
    return this.binding?.sessionId === sessionId ? this.binding.grants.pending.map(pending => pending.opId) : [];
  }

  /** Join only this host operation's persisted result and outgoing projection;
   *  SDK call ids may repeat across tasks. Missing history cancels pending effects. */
  deliverObservations(sessionId: string, delivered: ReadonlyMap<string, CuaObservationProjection>, recordedOpIds: ReadonlySet<string>): void {
    if (this.binding?.sessionId !== sessionId) return;
    for (const pending of [...this.binding.grants.pending]) {
      if (recordedOpIds.has(pending.opId)) continue;
      const operation = this.store.getToolOp(pending.opId)?.mcp;
      if (!operation || "transport" in operation) throw new McpError("cua_observation_invalid", "电脑观察的宿主操作记录缺失或类型不匹配；停止操作并报告拥有者核实存储。");
      this.observationDeliveryFailed(pending.opId, operation.rawTool.name);
    }
    deliverCuaObservations(this.binding.grants, delivered);
  }

  /** An observation call returned upstream but its result could not be
   *  delivered (persist/projection failure or isError): the upstream read
   *  baseline already moved, so the diff baseline is untrustworthy — drop it
   *  too; later observations must rebuild. */
  observationDeliveryFailed(opId: string, remoteName: string): void {
    const operation = this.store.getToolOp(opId)?.mcp;
    if (!operation || operation.execution?.executionId !== this.binding?.execution.executionId) return;
    const grants = this.binding!.grants;
    const pending = grants.pending.filter(entry => entry.opId === opId);
    grants.pending = grants.pending.filter(entry => entry.opId !== opId);
    for (const entry of pending) {
      if (entry.kind === "window") dropObservationBase(grants, entry.key);
      else if (entry.kind === "desktop") clearObservationGrant(grants, "get_desktop_state", {});
    }
    const args = ((operation as McpOperation).arguments ?? {}) as Record<string, unknown>;
    if (remoteName === "get_window_state" || remoteName === "run_steps") dropObservationGrant(grants, args);
    else if (remoteName === "get_desktop_state") clearObservationGrant(grants, remoteName, args);
  }

  async stop(expectedServiceId?: string): Promise<CodeCuaStatus> {
    if (this.stopping) {
      if (expectedServiceId && this.binding && this.binding.service.id !== expectedServiceId) throw new McpError("cua_service_changed", "当前电脑连接属于另一服务，未停止其他服务；请选择实际使用的原服务后核实停止。");
      return this.stopping;
    }
    this.stopping = this.stopExecution(expectedServiceId);
    try { return await this.stopping; } finally { this.stopping = null; }
  }

  private async stopExecution(expectedServiceId?: string): Promise<CodeCuaStatus> {
    if (this.busy || this.connecting) throw new McpError("cua_call_active", "电脑调用仍在执行；请先中断当前任务，再核实停止。");
    const latest = this.latestExecutions();
    if (expectedServiceId && (this.binding && this.binding.service.id !== expectedServiceId || latest.some(op => ["starting", "frozen", "recovering", "sent"].includes(op.mcp!.state) && !op.mcp!.stoppedAt && op.mcp!.serviceId !== expectedServiceId))) throw new McpError("cua_service_changed", "当前电脑连接属于另一服务，未停止其他服务；请选择实际使用的原服务后核实停止。");
    this.busy = true;
    try {
      const targets = new Map(latest.filter(op => ["starting", "frozen", "recovering", "sent"].includes(op.mcp!.state) && !op.mcp!.stoppedAt).map(op => [op.mcp!.execution.executionId, op.mcp!.execution]));
      if (this.binding) targets.set(this.binding.execution.executionId, this.binding.execution);
      for (const execution of targets.values()) {
        const proof = await stopMacosExecution(execution.directory, { executionId: execution.executionId }, execution.fingerprint);
        if (!proof.exited) throw new McpError("cua_stop_unverified", "原电脑执行停止尚未核实；保持冻结，请拥有者检查原执行现场。");
        const last = latest.find(op => op.mcp!.execution.executionId === execution.executionId);
        if (last) this.save(last.id, { ...last.mcp!, state: !["cua_connection", "cua_recovery_observe"].includes(last.toolName) && ["frozen", "recovering", "sent"].includes(last.mcp!.state) ? "frozen" : "closed", stoppedAt: new Date().toISOString() });
        if (this.binding?.execution.executionId === execution.executionId) { const connection = this.binding.conn ?? this.binding.transport!; this.binding = null; await connection.close(); }
      }
      return this.status();
    } finally { this.busy = false; }
  }

  private beginRecovery(): CodeCuaStatus {
    const op = this.original();
    if (!op.mcp!.stoppedAt || this.busy || this.binding) throw new McpError("cua_recovery_precondition", "须先核实原电脑执行停止，再选择检查并恢复取得新截图。");
    this.save(op.id, { ...op.mcp!, state: "recovering", ownerStartedAt: new Date().toISOString(), observationOpId: undefined, acceptedAt: undefined });
    return this.status();
  }

  async observe(): Promise<CodeCuaStatus> {
    if (this.original().mcp.state !== "recovering") this.beginRecovery();
    const original = this.original(), saved: McpOperation = { ...original.mcp!, observationOpId: undefined, observationArtifactIds: undefined };
    if (saved.state !== "recovering" || !saved.stoppedAt || !saved.ownerStartedAt || this.busy) throw new McpError("cua_recovery_precondition", "请拥有者先核实原执行停止，再选择检查并恢复取得新画面。");
    this.save(original.id, saved);
    const task = this.store.getTask(original.taskId)!, service = this.services.getService(saved.serviceId);
    if (!service?.enabled || !service.cua || !saved.configuration || JSON.stringify(service.cua) !== JSON.stringify(saved.configuration)) throw new McpError("cua_source_invalid", "原电脑配置已改变；保持冻结并检查原档案。");
    this.busy = true;
    let binding: Binding | null = null;
    let opId: string | undefined;
    try {
      const conn = await this.connect(service, task.sessionId, true, task.id);
      binding = this.binding!;
      const tools = await conn.listTools();
      const tool = ["get_desktop_state", "get_window_state"].map(name => tools.find(candidate => candidate.name === name)).find(candidate => candidate && cuaToolEffect(service.cua!, candidate.name) === "read" && !((candidate.inputSchema.required as string[] | undefined)?.length));
      if (!tool) throw new McpError("cua_observation_unavailable", "当前电脑程序没有可用的无参画面观察工具；保持冻结，请拥有者检查固定制品。");
      opId = randomId("op");
      const observationId = opId, operation: McpOperation = { ...saved, configVersion: service.configVersion, recoversOpId: original.id, effect: "read", rawTool: { name: tool.name, inputSchema: tool.inputSchema }, modelTool: { name: tool.name, inputSchema: tool.inputSchema }, arguments: {}, execution: binding.execution, state: "prepared", request: undefined, response: undefined, stoppedAt: undefined, ownerStartedAt: undefined, observationOpId: undefined, acceptedAt: undefined };
      this.store.withTx(() => { this.store.recordToolIntent({ id: observationId, taskId: task.id, sessionId: task.sessionId, toolName: "cua_recovery_observe", params: {} }); this.store.saveMcpOperation(observationId, operation); });
      let recoveryRequest: string | undefined;
      const result = await conn.callTool(operation.rawTool, {}, undefined, {
        recordCallRequest: async request => { recoveryRequest = request; },
        beforeDispatch: () => this.store.withTx(() => {
          const fresh = this.services.getService(service.id);
          if (!recoveryRequest || !fresh?.enabled || fresh.configVersion !== operation.configVersion || JSON.stringify(fresh.cua) !== JSON.stringify(service.cua)) throw new McpError("cua_source_invalid", "电脑配置已停用或变化，恢复观察未发送；保持冻结，请拥有者检查原配置后重新取得新观察。", false);
          this.store.saveMcpOperation(observationId, { ...operation, request: recoveryRequest, state: "sent" });
        }),
        recordCallProgress: async evidence => { const current = this.store.getToolOp(observationId)!.mcp! as McpOperation; this.save(observationId, { ...current, ...(evidence.response ? { response: evidence.response } : {}) }); },
      });
      const response = this.store.getToolOp(observationId)?.mcp?.response;
      if (!response || !mcpResponseEnded(response)) throw new McpError("remote_incomplete", "新观察尚无完整终结应答；保持冻结，请拥有者核实原电脑执行。");
      if (result.isError || ![...mcpImages(result).values()].some(image => !(image instanceof McpImageError))) throw new McpError("cua_observation_unavailable", "新观察未取得可核实截图；保持冻结，请拥有者检查桌面。");
      const formatted = formatMcpResult({ taskId: task.id, sessionId: task.sessionId }, this.artifacts, service.name, observationId, result);
      if (formatted.isError || !formatted.artifactIds?.length) throw new McpError("cua_observation_unavailable", "新截图未能保存；保持冻结，请拥有者检查存储。");
      this.store.withTx(() => {
        this.store.recordToolResult(observationId, "拥有者恢复观察：新截图已保存，等待拥有者接受。", false);
        this.store.appendEvent({ type: "task.tool_result", taskId: task.id, toolOpId: observationId, summary: "拥有者恢复观察：新截图已保存，等待拥有者接受。", isError: false, artifactIds: formatted.artifactIds ?? [] }, { taskId: task.id, sessionId: task.sessionId });
        this.store.saveMcpOperation(original.id, { ...saved, observationOpId: observationId, observationArtifactIds: formatted.artifactIds });
      });
      return this.status();
    } finally {
      try {
        if (binding) {
          const proof = await stopMacosExecution(binding.execution.directory, { executionId: binding.execution.executionId }, binding.execution.fingerprint);
          if (proof.exited) {
            const last = opId ? this.store.getToolOp(opId) : this.latestExecutions().find(operation => operation.mcp!.execution.executionId === binding!.execution.executionId);
            if (last?.mcp?.execution) this.save(last.id, { ...last.mcp, state: "closed", stoppedAt: new Date().toISOString() });
            this.binding = null;
            await binding.conn!.close();
          }
        }
      } finally { this.busy = false; }
    }
  }

  accept(observationId: string): CodeCuaStatus {
    const original = this.original(), mcp = original.mcp!, observation = mcp.observationOpId && this.store.getToolOp(mcp.observationOpId);
    if (!observation || observation.id !== observationId) throw new McpError("cua_observation_changed", "恢复观察已变化；请重新读取并检查当前截图，再接受该观察。");
    const service = this.services.getService(mcp.serviceId);
    if (!service?.enabled || service.configVersion !== observation.mcp?.configVersion || JSON.stringify(service.cua) !== JSON.stringify(mcp.configuration)) throw new McpError("cua_observation_changed", "电脑配置已变化；请重新启用原配置并取得新截图，再接受当前观察。");
    if (mcp.state !== "recovering" || !mcp.stoppedAt || !mcp.ownerStartedAt || !observation || observation.isError !== false || !observation.mcp?.response || !mcpResponseEnded(observation.mcp.response) || observation.mcp.state !== "closed" || this.binding || this.busy) throw new McpError("cua_recovery_precondition", "恢复前提不完整；请取得并检查新的已保存截图，核实观察执行已停止后再接受。");
    this.save(original.id, { ...mcp, state: "recovered", acceptedAt: new Date().toISOString() });
    return this.status();
  }

  async shutdown(sessionId?: string): Promise<void> {
    if (sessionId && this.status().sessionId !== sessionId) return;
    if (!this.busy && !this.connecting && (this.binding || this.pending())) await this.stop();
  }
}
