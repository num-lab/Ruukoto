/**
 * 工具路由器：任务模式绑定的执行与结构化审批。
 *
 * - 每次调用都读取当前任务的 accessMode / 权限版本 / 授予路径，不缓存
 *   首次创建 SDK 会话时的模式；
 * - 编码工具（read/edit/write/bash）经工具工作进程执行：工作进程只在
 *   当前任务的执行边界内（请求确认 → 任务容器；完全访问 → 执行账户）；
 *   模式/环境变化时先停止并核实旧执行单元退出，再建立新环境；
 * - 结构化操作（request_file_access / http_request）始终形成具体审批
 *   请求；批准经条件更新单次消费后才执行，执行参数取自保存的不可变请求；
 * - 原始输出先落产物文件，再生成限长模型视图并附产物引用。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AccessMode, ApprovalScope, Task } from "../core/types.ts";
import type { Store } from "../core/store.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { CredentialStore } from "./execution/credentials.ts";
import type { ManagedProcessRegistry, ManagedUnitKind } from "./managed-processes.ts";
import { ExecutionError, type WorkerLauncher } from "./execution/launchers.ts";
import {
  assertGrantNotProtected,
  executeApprovedFileOp,
  executeApprovedHttpRequest,
  isProtectedPath,
  restrictedResolve,
  sha256Hex,
  type FileOpRequest,
} from "./execution/approved-ops.ts";
import * as dns from "node:dns";
import { ToolWorkerHost } from "./tool-worker/host.ts";
import { CONTAINER_WORKSPACE } from "./execution/launchers.ts";
import type { DataStream } from "./tool-worker/protocol.ts";

/** 编码工具（工作进程执行）。 */
export const CODING_TOOL_NAMES = ["read", "edit", "write", "bash"] as const;
/** 结构化审批操作。 */
export const APPROVAL_TOOL_NAMES = ["request_file_access", "http_request"] as const;
/** 产物查询工具。 */
export const ARTIFACT_TOOL_NAME = "read_artifact";
/** 全部由路由器处理的名字（其余走 mock 测试路径）。 */
export const ROUTED_TOOL_NAMES = new Set<string>([...CODING_TOOL_NAMES, ...APPROVAL_TOOL_NAMES, ARTIFACT_TOOL_NAME]);

const WORKER_CALL_TIMEOUT_MS = 10 * 60_000;

export interface ToolRouterDeps {
  store: Store;
  artifacts: ArtifactStore;
  credentials: CredentialStore;
  registry: ManagedProcessRegistry;
  /** 返回当前模式对应的工作进程启动器；未配置时抛 ExecutionError（不回退）。 */
  launcherFor: (mode: AccessMode) => WorkerLauncher;
  /** 始终排除的保护根目录（后台数据、服务凭据、控制面）。 */
  protectedRoots: string[];
  /**
   * 产物读取的范围判定（issue 05 §1）：同项目旧任务的产物在授权范围内可读，
   * 跨项目需有效授权；未提供时退回"仅当前任务"（兼容旧装配）。
   */
  artifactAccess?: (task: Task, artifact: { taskId: string; sessionId: string }) => boolean;
  /** 驱动器桥：审批等待与等待解除由 Driver 统一持有。 */
  bridge: {
    awaitApproval(input: {
      task: Task;
      hostOpId: string;
      toolName: string;
      params: Record<string, unknown>;
      scope: ApprovalScope;
      signal?: AbortSignal;
    }): Promise<ApprovalOutcome>;
    supersedeAllWaiters(): void;
  };
}

export interface RoutedCallInput {
  task: Task;
  hostOpId: string;
  sdkCallId: string;
  name: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 审批桥结果：决定 + 来源与审查理由（自动拒绝不得显示成"拥有者拒绝"）。 */
export interface ApprovalOutcome {
  decision: "approved" | "rejected" | "superseded";
  source: "owner" | "auto_review" | null;
  reviewReason: string | null;
}

export interface RoutedCallOutput {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError: boolean;
}

export class ToolRouter {
  private worker: ToolWorkerHost | null = null;
  private workerKey: string | null = null;
  /** 本次运行中 sdkCallId → 路由调用上下文（Driver 在 tool_call 门处登记）。 */
  private routedCalls = new Map<string, { hostOpId: string; task: Task }>();
  /** 本次运行中 sdkCallId → 工具名（与 routedCalls 同生命周期）。 */
  private toolNames = new Map<string, string>();
  /** hostOpId → 已捕获产物 id（供 tool_result 事件记录引用）。 */
  private artifactRefs = new Map<string, string[]>();

  constructor(private readonly deps: ToolRouterDeps) {}

  /**
   * tool_call 门处登记：hostOpId 已分配、执行意图已记录、当前任务已确定
   * （含模式边界应用后的最新任务）。
   */
  registerRoutedCall(sdkCallId: string, hostOpId: string, task: Task, toolName: string): void {
    this.routedCalls.set(sdkCallId, { hostOpId, task });
    this.toolNames.set(sdkCallId, toolName);
  }

  /** SDK 工具执行入口（宿主工具定义的 execute 转发到这里）。 */
  async executeRouted(sdkCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<RoutedCallOutput> {
    const call = this.routedCalls.get(sdkCallId);
    if (!call) return textResult("工具调用缺少宿主登记（非本任务上下文）", true);
    const toolName = this.toolNames.get(sdkCallId) ?? "unknown";
    try {
      return await this.executeTool({
        task: call.task,
        hostOpId: call.hostOpId,
        sdkCallId,
        name: toolName,
        params,
        signal,
      });
    } finally {
      this.routedCalls.delete(sdkCallId);
      this.toolNames.delete(sdkCallId);
    }
  }

  /** 当前工作进程身份（诊断用）。 */
  workerIdentity(): { kind: ManagedUnitKind; id: string; label: string } | null {
    return this.worker?.identity() ?? null;
  }

  artifactIdsFor(hostOpId: string): string[] {
    return this.artifactRefs.get(hostOpId) ?? [];
  }

  // ---------- 工作进程生命周期 ----------

  private workerKeyFor(task: Task): string {
    return `${task.id}:${task.accessMode}:${JSON.stringify(task.grantedPaths)}`;
  }

  /** 停止当前工作进程并核实执行单元已退出；false = 无法确认。 */
  async stopWorker(): Promise<boolean> {
    const worker = this.worker;
    if (!worker) return true;
    this.worker = null;
    this.workerKey = null;
    return worker.stop();
  }

  /**
   * 工具边界：应用待生效的模式切换。先解除等待中的审批（后续执行重新
   * 判定，不自动执行旧待批准操作），再停止并核实旧执行单元退出，最后
   * 落库新模式与权限版本。无法核实旧单元退出时抛错（任务失败、占用保留）。
   */
  async prepareToolBoundary(task: Task): Promise<Task> {
    if (!task.pendingAccessMode || task.pendingAccessMode === task.accessMode) return task;
    const to = task.pendingAccessMode;
    this.deps.bridge.supersedeAllWaiters();
    const identity = this.workerIdentity();
    const reaped = await this.stopWorker();
    if (!reaped) {
      throw new ExecutionError(
        "mode_switch_unverified",
        `无法核实旧执行单元（${identity?.id ?? "?"}）已退出，模式切换失败`,
      );
    }
    return this.deps.store.withTx(() => {
      const version = this.deps.store.applyModeSwitch(task.id, to);
      this.deps.store.appendEvent(
        {
          type: "task.mode_switched",
          taskId: task.id,
          sessionId: task.sessionId,
          from: task.accessMode,
          to,
          permissionVersion: version,
        },
        { taskId: task.id, sessionId: task.sessionId },
      );
      return this.deps.store.getTask(task.id)!;
    });
  }

  /** 确保工作进程匹配当前任务（模式与授予路径）；不匹配则回收重建。 */
  private async ensureWorker(task: Task): Promise<ToolWorkerHost> {
    const key = this.workerKeyFor(task);
    if (this.worker && this.workerKey === key) return this.worker;
    if (this.worker) {
      const identity = this.workerIdentity();
      const reaped = await this.stopWorker();
      if (!reaped) {
        throw new ExecutionError("mode_switch_unverified", `无法核实旧执行单元（${identity?.id ?? "?"}）已退出，拒绝建立新的执行环境`);
      }
    }
    const launcher = this.deps.launcherFor(task.accessMode); // 未配置 → 明确失败，不回退
    const session = this.deps.store.getSession(task.sessionId);
    if (!session) throw new ExecutionError("invalid_state", `会话不存在：${task.sessionId}`);
    const host = await ToolWorkerHost.start(launcher, {
      taskId: task.id,
      mode: task.accessMode,
      workspace: session.cwdReal,
      grantedPaths: task.grantedPaths,
    });
    this.worker = host;
    this.workerKey = key;
    // 登记可回收身份（容器/systemd 单元/进程组），停止路径统一经此回收
    const identity = host.identity();
    this.deps.registry.register({
      kind: identity.kind,
      id: identity.id,
      label: identity.label,
      stop: async () => {
        const reaped = await host.stop();
        if (this.worker === host) {
          this.worker = null;
          this.workerKey = null;
        }
        return reaped;
      },
    });
    return host;
  }

  // ---------- 调用入口 ----------

  async executeTool(input: RoutedCallInput): Promise<RoutedCallOutput> {
    switch (input.name) {
      case "read":
      case "edit":
      case "write":
      case "bash":
        return this.executeCodingTool(input.task, input);
      case "request_file_access":
      case "http_request":
        return this.executeApprovalOp(input.task, input);
      case ARTIFACT_TOOL_NAME:
        return this.readArtifact(input.task, input);
      default:
        return textResult(`未知工具：${input.name}`, true);
    }
  }

  private async executeCodingTool(task: Task, input: RoutedCallInput): Promise<RoutedCallOutput> {
    let host: ToolWorkerHost;
    try {
      host = await this.ensureWorker(task);
    } catch (err) {
      return textResult(`执行环境不可用：${(err as Error).message}（不回退到其他执行方式）`, true);
    }
    const artifactsByStream = new Map<DataStream, { id: string; name: string }>();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(new Error("aborted by host"));
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });

    let captureFailed: string | null = null;
    const onData = (stream: DataStream, chunk: Buffer) => {
      if (captureFailed) return;
      let entry = artifactsByStream.get(stream);
      if (!entry) {
        const name =
          stream === "stdout"
            ? `${input.name} stdout`
            : stream === "stderr"
              ? `${input.name} stderr`
              : `${input.name} 文件正文`;
        const artifact = this.deps.artifacts.begin({ taskId: task.id, sessionId: task.sessionId, name });
        entry = { id: artifact.id, name };
        artifactsByStream.set(stream, entry);
      }
      try {
        this.deps.artifacts.append(entry.id, chunk);
      } catch (err) {
        // 磁盘写入失败：停止执行，保留已捕获部分与失败原因
        captureFailed = (err as Error).message;
        controller.abort(new Error("artifact_write_failed"));
      }
    };

    try {
      const result = await host.call({
        opId: input.hostOpId,
        sdkCallId: input.sdkCallId,
        name: input.name,
        params: input.params,
        timeoutMs: WORKER_CALL_TIMEOUT_MS,
        onData,
        signal: controller.signal,
      });
      const artifactIds = Array.from(artifactsByStream.values()).map((a) => a.id);
      this.artifactRefs.set(input.hostOpId, artifactIds);
      if (captureFailed) {
        const content = Array.isArray(result.content) ? [...(result.content as any[])] : [];
        content.push({ type: "text", text: `输出捕获失败，执行已停止：${captureFailed}` });
        return { content, details: result.details, isError: true };
      }
      // 结果帧已回收（无论工具成功或失败）= 本次捕获完整，产物定稿
      for (const entry of artifactsByStream.values()) {
        this.deps.artifacts.complete(entry.id);
      }
      const content = Array.isArray(result.content) ? [...(result.content as any[])] : [];
      for (const entry of artifactsByStream.values()) {
        const bytes = this.deps.artifacts.byteLength(entry.id);
        content.push({
          type: "text",
          text: `[完整正文已捕获：artifact ${entry.id}（${bytes} 字节，${entry.name}）——需要更多内容时用 read_artifact 工具按偏移查询]`,
        });
      }
      return { content, details: result.details, isError: Boolean(result.isError) };
    } catch (err) {
      const artifactIds = Array.from(artifactsByStream.values()).map((a) => a.id);
      this.artifactRefs.set(input.hostOpId, artifactIds);
      if (captureFailed) {
        // 中止由捕获失败触发：报告真实原因（已保留部分与失败原因），不报告完整成功
        return textResult(`输出捕获失败，执行已停止：${captureFailed}`, true);
      }
      return textResult(`工具执行失败：${(err as Error).message}`, true);
    } finally {
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  // ---------- 结构化审批操作 ----------

  private async executeApprovalOp(task: Task, input: RoutedCallInput): Promise<RoutedCallOutput> {
    const scopeResult =
      input.name === "request_file_access" ? this.fileOpScope(input.params) : await this.httpOpScope(input.params);
    if ("error" in scopeResult) {
      return textResult(scopeResult.error, true);
    }
    const approval = await this.deps.bridge.awaitApproval({
      task,
      hostOpId: input.hostOpId,
      toolName: input.name,
      params: input.params,
      scope: scopeResult.scope,
      signal: input.signal,
    });
    if (approval.decision !== "approved") {
      // 自动拒绝不能显示成"拥有者拒绝"：按决定来源区分文案
      const reason =
        approval.decision === "rejected"
          ? approval.source === "auto_review"
            ? `自动审查拒绝执行该操作：${approval.reviewReason ?? "未给出理由"}`
            : "拥有者拒绝执行该操作"
          : "模式已切换或任务已停止，该审批已失效；如仍需要请重新申请";
      return textResult(reason, true);
    }

    // 单次消费：条件更新校验批准未消费、权限版本匹配、任务仍活动，
    // 原子记录消费（= 执行开始）
    const confirmation = this.deps.store
      .listConfirmationsByTask(task.id)
      .find((c) => c.toolOpId === input.hostOpId && c.status === "approved");
    if (!confirmation) return textResult("审批记录缺失或已失效，操作未执行", true);
    const consumed = this.deps.store.withTx(() => {
      const ok = this.deps.store.consumeApproval({
        confirmationId: confirmation.id,
        expectedPermissionVersion: confirmation.permissionVersion,
        activeStatuses: ["running", "awaiting_confirmation"],
      });
      if (ok) {
        this.deps.store.appendEvent(
          {
            type: "task.approval_consumed",
            taskId: task.id,
            confirmationId: confirmation.id,
            toolOpId: input.hostOpId,
            toolName: input.name,
          },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
      return ok;
    });
    if (!consumed) {
      return textResult("批准已失效（任务结束、权限版本变化或已被消费），操作未执行", true);
    }

    // 执行参数完全取自审批保存的不可变请求
    if (scopeResult.kind === "file") {
      const outcome = executeApprovedFileOp(scopeResult.fileRequest);
      const text = outcome.ok && outcome.content !== undefined ? `${outcome.message}\n${outcome.content}` : outcome.message;
      return textResult(text, !outcome.ok);
    }
    const outcome = await executeApprovedHttpRequest(scopeResult.httpRequest, this.deps.credentials);
    const head = Object.entries(outcome.responseHeaders)
      .slice(0, 20)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    return textResult(`HTTP ${outcome.status ?? "无响应"}\n${head}\n\n${outcome.body}`, !outcome.ok);
  }

  private fileOpScope(
    params: Record<string, unknown>,
  ): { kind: "file"; scope: ApprovalScope; fileRequest: FileOpRequest } | { error: string } {
    const target = String(params["path"] ?? "");
    const operation = params["operation"] === "write" ? "read_write" : "read";
    const content = params["content"];
    if (!target) return { error: "缺少目标路径" };
    if (operation === "read_write" && typeof content !== "string") {
      return { error: "写操作必须提供完整待写内容 content" };
    }
    let resolved: string;
    let targetDev: number | null = null;
    let targetIno: number | null = null;
    let originalSha256: string | null = null;
    try {
      resolved = restrictedResolve(target, { allowMissingLast: true });
      if (isProtectedPath(resolved, this.deps.protectedRoots)) {
        return { error: "目标位于控制面/服务数据目录内，始终排除，不可申请" };
      }
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(resolved);
      } catch {
        st = null;
      }
      if (st?.isDirectory()) return { error: "目标是目录，只能对文件申请文件操作" };
      if (st) {
        targetDev = st.dev;
        targetIno = st.ino;
        if (operation === "read_write") {
          originalSha256 = sha256Hex(fs.readFileSync(resolved));
        }
      } else if (operation === "read_write") {
        const parent = restrictedResolve(resolved.replace(/\/[^/]+$/, ""), { allowMissingLast: false });
        const parentSt = fs.lstatSync(parent);
        targetDev = parentSt.dev;
        targetIno = parentSt.ino;
      } else {
        return { error: `目标文件不存在：${resolved}` };
      }
    } catch (err) {
      return { error: `目标路径校验失败：${(err as Error).message}` };
    }
    const contentBuf = operation === "read_write" ? Buffer.from(content as string, "utf8") : null;
    const scope: ApprovalScope = {
      kind: "file_operation",
      path: resolved,
      access: operation,
      originalSha256,
      contentSha256: contentBuf ? sha256Hex(contentBuf) : null,
      contentBytes: contentBuf ? contentBuf.length : null,
    };
    return {
      kind: "file",
      scope,
      fileRequest: {
        path: resolved,
        access: operation,
        content: contentBuf ? (content as string) : undefined,
        targetDev,
        targetIno,
        originalSha256,
        protectedRoots: this.deps.protectedRoots,
      },
    };
  }

  private async httpOpScope(
    params: Record<string, unknown>,
  ): Promise<
    | { kind: "http"; scope: ApprovalScope; httpRequest: { method: string; url: string; headers: Record<string, string>; body?: string; credentialName?: string; pinnedAddress: string; pinnedFamily: number } }
    | { error: string }
  > {
    const method = String(params["method"] ?? "");
    const url = String(params["url"] ?? "");
    if (!method) return { error: "缺少 HTTP 方法" };
    if (!url) return { error: "缺少目标 URL" };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: "无法解析目标 URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `不支持的目标协议：${parsed.protocol}（仅 http/https）` };
    }
    const headers: Record<string, string> = {};
    if (params["headers"] && typeof params["headers"] === "object") {
      for (const [k, v] of Object.entries(params["headers"] as Record<string, unknown>)) {
        headers[k] = String(v);
      }
    }
    const body = typeof params["body"] === "string" ? (params["body"] as string) : undefined;
    const credentialName = typeof params["credential"] === "string" ? (params["credential"] as string) : undefined;
    const credentialRefs: Array<{ name: string; purpose: string }> = [];
    if (credentialName) {
      const binding = this.deps.credentials.get(credentialName);
      if (!binding) return { error: `凭据绑定不存在：${credentialName}` };
      credentialRefs.push({ name: binding.name, purpose: binding.purpose });
      if (parsed.host.toLowerCase() !== binding.host.toLowerCase()) {
        return { error: `凭据 ${binding.name} 绑定到 ${binding.host}，与目标 ${parsed.host} 不一致（凭据不得转发到其他地址）` };
      }
    }
    // 解析在批准时完成并固定（防 DNS 重绑定）：执行的连接范围即此处的解析结果
    let pinnedAddress: string;
    let pinnedFamily: number;
    try {
      const resolved = await dns.promises.lookup(parsed.hostname, { all: true });
      if (resolved.length === 0) throw new Error("无解析结果");
      pinnedAddress = resolved[0]!.address;
      pinnedFamily = resolved[0]!.family;
    } catch (err) {
      return { error: `目标主机解析失败：${(err as Error).message}` };
    }
    const scope: ApprovalScope = {
      kind: "http_request",
      method: method.toUpperCase(),
      url: parsed.toString(),
      credentials: credentialRefs,
    };
    return {
      kind: "http",
      scope,
      httpRequest: { method: scope.method, url: scope.url, headers, body, credentialName, pinnedAddress, pinnedFamily },
    };
  }

  // ---------- 产物查询 ----------

  private readArtifact(task: Task, input: RoutedCallInput): RoutedCallOutput {
    const artifactId = String(input.params["artifact_id"] ?? "");
    const offset = Number(input.params["offset"] ?? 0);
    const length = Math.min(Number(input.params["length"] ?? 64 * 1024), 256 * 1024);
    const artifact = this.deps.store.getArtifact(artifactId);
    if (!artifact) {
      return textResult(`产物不存在：${artifactId}`, true);
    }
    const allowed = this.deps.artifactAccess
      ? this.deps.artifactAccess(task, artifact)
      : artifact.taskId === task.id;
    if (!allowed) {
      return textResult(`产物不属于可读取范围：${artifactId}（同项目旧任务需有效范围，跨项目需拥有者授权）`, true);
    }
    const buf = this.deps.artifacts.read(artifactId, Math.max(0, offset), Math.max(1, length));
    const encoding = input.params["encoding"] === "base64" ? "base64" : "utf8";
    const body = encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
    return textResult(
      `artifact ${artifactId}（${artifact.name}，共 ${artifact.byteCount} 字节，${artifact.status}）偏移 ${offset} 起的 ${buf.length} 字节：\n${body}`,
      false,
    );
  }
}

function textResult(text: string, isError: boolean): RoutedCallOutput {
  return { content: [{ type: "text", text }], isError };
}

// ---------- 宿主侧工具定义 ----------

/**
 * 注册到 SDK 会话的宿主工具定义：read/edit/write/bash 与审批操作、产物
 * 查询。execute 全部转发给路由器（模式与权限在调用时读取，不缓存）；
 * 不加载项目自动发现的扩展。
 */
export function createCodingTools(router: ToolRouter): ToolDefinition[] {
  const routedTool = (def: { name: string; label: string; description: string; parameters: any }) =>
    defineTool({
      ...def,
      // 同一任务的工作进程按"工具名 → 当前调用"关联原始输出流：并发同名调用
      // 会串流，因此宿主工具一律顺序执行（SDK 支持按工具声明顺序执行）
      executionMode: "sequential",
      execute: async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        const out = await router.executeRouted(toolCallId, params, signal);
        if (out.isError) {
          // 与上游工具一致：失败以异常表示（含产物引用与原因的完整说明）
          const text = out.content.map((c) => c.text ?? "").join("\n");
          throw new Error(text || "工具执行失败");
        }
        return { content: out.content, details: out.details } as any;
      },
    } as any) as ToolDefinition;

  const readTool = routedTool({
    name: "read",
    label: "read",
    description: "读取文件内容（在任务执行边界内；输出超限时完整正文保存为产物，可用 read_artifact 继续）。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径（相对或绝对）" }),
      offset: Type.Optional(Type.Number({ description: "起始行（1 起）" })),
      limit: Type.Optional(Type.Number({ description: "读取行数" })),
    }),
  });
  const editTool = routedTool({
    name: "edit",
    label: "edit",
    description: "对文件做精确文本替换（edits[].oldText 必须精确匹配）。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径" }),
      edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
    }),
  });
  const writeTool = routedTool({
    name: "write",
    label: "write",
    description: "创建或整体重写文件。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径" }),
      content: Type.String({ description: "完整内容" }),
    }),
  });
  const bashTool = routedTool({
    name: "bash",
    label: "bash",
    description: "在工作区执行 bash 命令（在任务执行边界内；输出完整捕获为产物）。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的命令" }),
      timeout: Type.Optional(Type.Number({ description: "超时秒数" })),
    }),
  });
  const requestFileAccess = routedTool({
    name: "request_file_access",
    label: "request_file_access",
    description:
      "申请对授权工作区之外单个文件的一次性读取或写入（需拥有者批准后执行）。审批会列出目标文件与写入内容；批准只对该次操作有效。",
    parameters: Type.Object({
      path: Type.String({ description: "目标文件的绝对路径" }),
      operation: Type.Union([Type.Literal("read"), Type.Literal("write")], { description: "读或写" }),
      content: Type.Optional(Type.String({ description: "operation=write 时的完整待写内容" })),
      reason: Type.String({ description: "申请原因（随审批展示）" }),
    }),
  });
  const httpRequest = routedTool({
    name: "http_request",
    label: "http_request",
    description:
      "发起一次外部 HTTP(S) 请求（需拥有者批准后执行）。审批会列出方法、完整目标、头部与正文；凭据按预配置绑定注入，值不展示。默认不跟随重定向、不重试。",
    parameters: Type.Object({
      method: Type.String({ description: "HTTP 方法，如 GET/POST" }),
      url: Type.String({ description: "完整目标 URL" }),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "请求头" })),
      body: Type.Optional(Type.String({ description: "请求正文" })),
      credential: Type.Optional(Type.String({ description: "凭据绑定名称（由拥有者预配置）" })),
      reason: Type.String({ description: "申请原因（随审批展示）" }),
    }),
  });
  const readArtifact = routedTool({
    name: ARTIFACT_TOOL_NAME,
    label: ARTIFACT_TOOL_NAME,
    description: "按产物 id、偏移和长度读取本任务已捕获的工具完整正文。",
    parameters: Type.Object({
      artifact_id: Type.String({ description: "产物 id（见工具结果中的 artifact 引用）" }),
      offset: Type.Optional(Type.Number({ description: "起始字节，默认 0" })),
      length: Type.Optional(Type.Number({ description: "读取字节数，默认 64KB，上限 256KB" })),
      encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
    }),
  });
  return [readTool, editTool, writeTool, bashTool, requestFileAccess, httpRequest, readArtifact];
}
