/** Coding 的持续电脑连接；冻结与恢复事实随原工具操作落盘。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "@ruukoto/core/store.ts";
import { randomId, type McpOperation, type Task, type ToolOp } from "@ruukoto/core/types.ts";
import { ownerQuestionTaskEligible } from "@ruukoto/core/owner-questions.ts";
import type { ArtifactStore } from "../artifacts.ts";
import { prepareMacosStdioExecution, stopMacosExecution } from "../execution/native-macos-identity.ts";
import { cuaArguments, cuaProgram, cuaToolEffect } from "./cua.ts";
import { connectMcpStdio, McpError, mcpResponseEnded, type McpConnection, type McpTimeouts, type CallToolResult } from "./transport.ts";
import type { McpServiceConfig, McpStore } from "./store.ts";
import { formatMcpResult, type PlannedTool } from "./tools.ts";
import { mcpImages, McpImageError } from "./images.ts";

type Execution = McpOperation["execution"];
interface Binding { service: McpServiceConfig; sessionId: string; conn: McpConnection; execution: Execution; observed: boolean }
export interface CodeCuaStatus {
  state: "idle" | "connecting" | "active" | "frozen" | "recovering";
  sessionId?: string;
  stopped: boolean;
  ownerStarted: boolean;
  observation?: { id: string; artifactIds: string[] };
}

export class CodeCuaManager {
  private binding: Binding | null = null;
  private busy = false;
  private connecting = false;
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

  private latestExecutions(): ToolOp[] {
    return this.store.listOpenMcpOperations(this.binding?.execution.executionId);
  }
  private pending(): ToolOp | undefined { return this.latestExecutions().find(op => ["starting", "frozen", "recovering", "sent"].includes(op.mcp!.state)); }
  private save(opId: string, value: McpOperation): void {
    this.store.withTx(() => { const saved = this.store.getToolOp(opId)?.mcp; this.store.saveMcpOperation(opId, { ...saved, ...value }); });
  }
  private original(): ToolOp {
    const op = this.pending();
    if (!op) throw new McpError("cua_recovery_unavailable", "没有待恢复的电脑操作；请读取当前电脑状态。");
    return this.store.getToolOp(op.id)!;
  }

  private detectClosed(): void {
    if (!this.binding?.conn.closed) return;
    this.binding.observed = false;
    const last = this.latestExecutions().find(op => op.mcp!.execution.executionId === this.binding!.execution.executionId);
    if (last && !["recovered", "frozen", "recovering"].includes(last.mcp!.state)) this.save(last.id, { ...last.mcp!, state: "frozen" });
  }

  status(): CodeCuaStatus {
    this.detectClosed();
    const op = this.pending(), mcp = op?.mcp;
    const observation = mcp?.observationOpId && this.store.getToolOp(mcp.observationOpId);
    const task = op && this.store.getTask(op.taskId);
    return { state: this.connecting ? "connecting" : mcp ? mcp.state === "recovering" ? "recovering" : "frozen" : this.binding ? "active" : "idle", sessionId: task?.sessionId ?? this.binding?.sessionId,
      stopped: !!mcp?.stoppedAt, ownerStarted: !!mcp?.ownerStartedAt,
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

  async connect(service: McpServiceConfig, sessionId: string, recovering = false, taskId?: string): Promise<McpConnection> {
    this.detectClosed();
    if (this.busy && !recovering) throw new McpError("cua_binding_busy", "电脑管理动作仍在执行；请等待原操作结束。");
    if (!service.cua || service.cua.kind !== "cua-mac") throw new McpError("cua_product_invalid", "Code 仅支持本机 Mac 电脑入口；请拥有者检查配置。");
    if (!recovering && this.pending()) throw new McpError("cua_frozen", "电脑已冻结；请拥有者核实原执行停止并完成恢复，不能重发旧操作。");
    if (this.binding) {
      if (this.binding.sessionId !== sessionId || this.binding.service.id !== service.id || this.binding.service.configVersion !== service.configVersion) throw new McpError("cua_binding_busy", "电脑已由另一主会话或配置使用；请拥有者先暂停原会话的电脑连接。");
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
      this.binding = { service, sessionId, conn, execution, observed: false };
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

  async call(task: Task, meta: PlannedTool, params: Record<string, unknown>, opId: string, signal?: AbortSignal, consume?: (operation: McpOperation) => void): Promise<CallToolResult> {
    this.detectClosed();
    this.verify(meta.service, task);
    if (this.pending()) throw new McpError("cua_frozen", "电脑已冻结；停止调用并报告拥有者完成原操作恢复，不能换参数重试。");
    const binding = this.binding;
    if (!binding || binding.sessionId !== task.sessionId || binding.service.id !== meta.service.id || this.busy) throw new McpError("cua_binding_busy", "电脑连接正由另一操作使用；结束本轮并报告拥有者核实连接。");
    if (task.planMode && meta.effect !== "read") throw new McpError("cua_plan_read_only", "计划模式只允许观察电脑；请向拥有者说明所需操作后结束本轮。");
    if (!binding.observed && meta.effect !== "read") throw new McpError("cua_observation_required", "电脑连接需要先取得新的画面；先调用画面观察工具，再根据新画面操作。");
    const args = cuaArguments(meta.service.cua!, meta.remoteName, params);
    const operation: McpOperation = { serviceId: meta.service.id, configVersion: meta.service.configVersion, configuration: meta.service.cua!.kind === "cua-mac" ? meta.service.cua : undefined, effect: meta.effect,
      rawTool: { name: meta.remoteName, inputSchema: meta.rawInputSchema ?? meta.inputSchema }, modelTool: { name: meta.exposedName, inputSchema: meta.inputSchema }, arguments: args, execution: binding.execution, state: "prepared" };
    this.save(opId, operation);
    if (["get_desktop_state", "get_window_state"].includes(meta.remoteName)) binding.observed = false;
    this.busy = true;
    try {
      const result = await binding.conn.callTool(operation.rawTool, args, signal, {
        recordCallRequest: async request => {
          this.verify(meta.service, task);
          if (signal?.aborted) throw new McpError("canceled", "电脑操作已取消，尚未发送；查询原操作并结束本轮。");
          const sent: McpOperation = { ...operation, request, state: "sent" };
          if (consume) consume(sent); else this.store.withTx(() => { this.verify(meta.service, task); this.store.saveMcpOperation(opId, sent); });
        },
        recordCallProgress: async evidence => {
          const current = this.store.getToolOp(opId)?.mcp;
          if (!current?.request) throw new McpError("evidence_failed", "电脑原请求尚未保存；停止调用并检查存储。");
          this.save(opId, { ...current, ...(evidence.response ? { response: evidence.response } : {}) });
        },
      });
      const current = this.store.getToolOp(opId)!.mcp!;
      if (!current.response || !mcpResponseEnded(current.response)) throw new McpError("remote_incomplete", "电脑原请求尚无完整终结应答，已冻结电脑；停止调用并报告拥有者核实，不能重发旧动作。");
      this.save(opId, { ...current, state: "finished" });
      if (mcpImages(result).size) binding.observed = false;
      return result;
    } catch (error) {
      const current = this.store.getToolOp(opId)!.mcp!;
      if (current.request && (!current.response || !mcpResponseEnded(current.response))) {
        this.save(opId, { ...current, state: "frozen" });
        binding.observed = false;
      } else this.save(opId, { ...current, state: current.request ? "finished" : "not_sent" });
      throw error;
    } finally { this.busy = false; }
  }

  acceptObservation(opId: string): void {
    const operation = this.store.getToolOp(opId)?.mcp;
    if (!operation || operation.state !== "finished" || operation.execution.executionId !== this.binding?.execution.executionId) throw new McpError("cua_observation_invalid", "新观察与电脑执行不匹配；停止操作并报告拥有者核实。");
    this.binding.observed = true;
  }

  async stop(): Promise<CodeCuaStatus> {
    if (this.busy || this.connecting) throw new McpError("cua_call_active", "电脑调用仍在执行；请先中断当前任务，再核实停止。");
    this.busy = true;
    try {
      const latest = this.latestExecutions();
      const targets = new Map(latest.filter(op => ["starting", "frozen", "recovering", "sent"].includes(op.mcp!.state) && !op.mcp!.stoppedAt).map(op => [op.mcp!.execution.executionId, op.mcp!.execution]));
      if (this.binding) targets.set(this.binding.execution.executionId, this.binding.execution);
      for (const execution of targets.values()) {
        const proof = await stopMacosExecution(execution.directory, { executionId: execution.executionId }, execution.fingerprint);
        if (!proof.exited) throw new McpError("cua_stop_unverified", "原电脑执行停止尚未核实；保持冻结，请拥有者检查原执行现场。");
        const last = latest.find(op => op.mcp!.execution.executionId === execution.executionId);
        if (last) this.save(last.id, { ...last.mcp!, state: last.toolName !== "cua_recovery_observe" && ["frozen", "recovering", "sent"].includes(last.mcp!.state) ? "frozen" : "closed", stoppedAt: new Date().toISOString() });
        if (this.binding?.execution.executionId === execution.executionId) { const connection = this.binding.conn; this.binding = null; await connection.close(); }
      }
      return this.status();
    } finally { this.busy = false; }
  }

  beginRecovery(): CodeCuaStatus {
    const op = this.original();
    if (!op.mcp!.stoppedAt || this.busy || this.binding) throw new McpError("cua_recovery_precondition", "须先核实原电脑执行停止并检查桌面结果，再选择开始恢复。");
    this.save(op.id, { ...op.mcp!, state: "recovering", ownerStartedAt: new Date().toISOString(), observationOpId: undefined, acceptedAt: undefined });
    return this.status();
  }

  async observe(): Promise<CodeCuaStatus> {
    const original = this.original(), saved: McpOperation = { ...original.mcp!, observationOpId: undefined, observationArtifactIds: undefined };
    if (saved.state !== "recovering" || !saved.stoppedAt || !saved.ownerStartedAt || this.busy) throw new McpError("cua_recovery_precondition", "请拥有者先核实停止并选择开始恢复，再取得新画面。");
    const task = this.store.getTask(original.taskId)!, service = this.services.getService(saved.serviceId);
    if (!service?.enabled || !service.cua || !saved.configuration || JSON.stringify(service.cua) !== JSON.stringify(saved.configuration)) throw new McpError("cua_source_invalid", "原电脑配置已改变；保持冻结并检查原档案。");
    this.busy = true;
    let binding: Binding | null = null;
    let opId: string | undefined;
    try {
      this.save(original.id, saved);
      const conn = await this.connect(service, task.sessionId, true, task.id);
      binding = this.binding!;
      const tools = await conn.listTools();
      const tool = ["get_desktop_state", "get_window_state"].map(name => tools.find(candidate => candidate.name === name)).find(candidate => candidate && cuaToolEffect(service.cua!, candidate.name) === "read" && !(candidate.inputSchema.required?.length));
      if (!tool) throw new McpError("cua_observation_unavailable", "当前电脑程序没有可用的无参画面观察工具；保持冻结，请拥有者检查固定制品。");
      opId = randomId("op");
      const observationId = opId, operation: McpOperation = { ...saved, configVersion: service.configVersion, recoversOpId: original.id, effect: "read", rawTool: { name: tool.name, inputSchema: tool.inputSchema }, modelTool: { name: tool.name, inputSchema: tool.inputSchema }, arguments: {}, execution: binding.execution, state: "prepared", request: undefined, response: undefined, stoppedAt: undefined, ownerStartedAt: undefined, observationOpId: undefined, acceptedAt: undefined };
      this.store.withTx(() => { this.store.recordToolIntent({ id: observationId, taskId: task.id, sessionId: task.sessionId, toolName: "cua_recovery_observe", params: {} }); this.store.saveMcpOperation(observationId, operation); });
      const result = await conn.callTool(operation.rawTool, {}, undefined, {
        recordCallRequest: async request => this.store.withTx(() => {
          const fresh = this.services.getService(service.id);
          if (!fresh?.enabled || fresh.configVersion !== operation.configVersion || JSON.stringify(fresh.cua) !== JSON.stringify(service.cua)) throw new McpError("cua_source_invalid", "电脑配置已停用或变化，恢复观察未发送；保持冻结，请拥有者检查原配置后重新取得新观察。");
          this.store.saveMcpOperation(observationId, { ...operation, request, state: "sent" });
        }),
        recordCallProgress: async evidence => { const current = this.store.getToolOp(observationId)!.mcp!; this.save(observationId, { ...current, ...(evidence.response ? { response: evidence.response } : {}) }); },
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
            if (last?.mcp) this.save(last.id, { ...last.mcp, state: "closed", stoppedAt: new Date().toISOString() });
            this.binding = null;
            await binding.conn.close();
          }
        }
      } finally { this.busy = false; }
    }
  }

  accept(observationId: string): CodeCuaStatus {
    const original = this.original(), mcp = original.mcp!, observation = mcp.observationOpId && this.store.getToolOp(mcp.observationOpId);
    if (!observation || observation.id !== observationId) throw new McpError("cua_observation_changed", "恢复观察已变化；请重新读取并检查当前截图，再接受该观察。");
    if (mcp.state !== "recovering" || !mcp.stoppedAt || !mcp.ownerStartedAt || !observation || observation.isError !== false || !observation.mcp?.response || !mcpResponseEnded(observation.mcp.response) || observation.mcp.state !== "closed" || this.binding || this.busy) throw new McpError("cua_recovery_precondition", "恢复前提不完整；请取得并检查新的已保存截图，核实观察执行已停止后再接受。");
    this.save(original.id, { ...mcp, state: "recovered", acceptedAt: new Date().toISOString() });
    return this.status();
  }

  async shutdown(): Promise<void> { if (!this.busy && !this.connecting && (this.binding || this.pending())) await this.stop(); }
}
