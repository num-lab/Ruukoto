import { ControlClientError } from "@ruukoto/control/client.ts";
import { ControlConnection, type ConnectionCallbacks, type ConnectionConfig } from "@ruukoto/control/connection.ts";
import { ensureBackend, type EnsureBackendOptions, type EnsureBackendResult } from "@ruukoto/control/ensure-backend.ts";
import { resolveOwnerToken } from "@ruukoto/control/connect.ts";
import { readOwnerToken } from "@ruukoto/control/owner-token.ts";
import type { DesktopFailure, DesktopUpdate } from "../shared/bridge.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { DesktopError, type CodeTargetConfig } from "./environment.ts";
import { versionRecovery } from "./recovery.ts";
import { DesktopSubmissions } from "./submissions.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import type { DesktopOp } from "./ipc.ts";
import { DesktopBrowserBridge, type MyGoBrowserTransport } from "./browser-bridge.ts";
import type { DesktopBrowserEvent } from "@ruukoto/control/protocol.ts";

type Connection = Pick<ControlConnection, "start" | "close" | "request"> & { instanceId?: string | null };
export interface ControllerDeps {
  ensure(options: EnsureBackendOptions): Promise<EnsureBackendResult>;
  connection(config: ConnectionConfig, callbacks: ConnectionCallbacks): Connection;
}
export function serializeFailure(error: unknown, token?: string): DesktopFailure {
  const failure: DesktopFailure = error instanceof ControlClientError
    ? { code: error.code, outcome: error.outcome, message: error.message, ...(error.versions ? { versions: error.versions } : {}) }
    : { code: error instanceof DesktopError ? error.code : "desktop_failed", outcome: "not_sent", message: error instanceof Error ? error.message : "桌面操作失败；请重新连接。" };
  if (token) failure.message = failure.message.replaceAll(token, "[令牌已隐藏]");
  return failure;
}

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class CodeController {
  private connection: Connection | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private stopped = false;
  private token: string | undefined;
  submissions: DesktopSubmissions | null = null;
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "connecting" };
  /** MyGo 原生浏览器桥：仅 MyGo 外壳注入；登记、窄命令应答与事件上行经当前连接。 */
  private readonly browserBridge: DesktopBrowserBridge | null;

  constructor(readonly config: CodeTargetConfig, private readonly publish: (update: DesktopUpdate) => void, private readonly deps: ControllerDeps = {
    ensure: ensureBackend,
    connection: (config, callbacks) => new ControlConnection(config, callbacks),
  }, private readonly pendingStore?: PendingRequestStore, browserTransport?: MyGoBrowserTransport) {
    this.browserBridge = browserTransport ? new DesktopBrowserBridge(browserTransport) : null;
  }

  private state(update: Extract<DesktopUpdate, { type: "state" }>): void {
    this.status = update;
    this.publish(update);
  }
  private failed(failure: DesktopFailure): void {
    const secret = this.token ?? this.config.env?.RUUKOTO_OWNER_TOKEN ?? readOwnerToken(this.config.controlDir);
    if (secret) failure = { ...failure, message: failure.message.replaceAll(secret, "[令牌已隐藏]") };
    this.state({ type: "state", state: "failed", error: failure, detail: failure.message, ...(failure.versions ? { recovery: versionRecovery("code", failure.versions, this.config.managed, this.config.controlDir) } : {}) });
  }
  reconnect(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.connect().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.connection?.close();
    this.state({ type: "state", state: "connecting" });
    try { await this.connectTarget(generation); }
    catch (error) { if (!this.stopped) this.failed(serializeFailure(error, this.token)); }
  }
  private async connectTarget(generation: number): Promise<void> {
    if (!this.config.managed) {
      const result = await this.deps.ensure(this.config);
      if (this.stopped) return;
      if (!result.ok) {
        this.failed({ code: result.code ?? "backend_start_failed", outcome: "not_sent", message: result.error, ...(result.versions ? { versions: result.versions } : {}) });
        return;
      }
    }
    this.token = this.config.managed ? readOwnerToken(this.config.controlDir) ?? undefined : resolveOwnerToken(this.config.controlDir);
    if (!this.token) throw new DesktopError("owner_token_missing", "开发档案的 owner.token 不可读；请重启开发启动器。");
    this.connection = this.deps.connection({
      socketPath: this.config.socketPath, token: this.token, expectedProduct: "ruukoto-code",
      ...(this.browserBridge ? { callHandler: (op: string, params: Record<string, unknown>, callId: string) => this.browserBridge!.handleCall(op, params, callId, () => this.connection) } : {}),
    }, {
      onState: (state, detail, error) => {
        if (this.stopped || generation !== this.generation) return;
        if (state === "failed" && error) this.failed(serializeFailure(error, this.token));
        else this.state({ type: "state", state, detail: detail?.replaceAll(this.token!, "[令牌已隐藏]") });
      },
      onSnapshot: (result, context) => {
        if (this.stopped || generation !== this.generation) return;
        this.publish({ type: "snapshot", result, instanceChanged: context.instanceChanged });
        void this.submissions?.reconcile();
        this.browserBridge?.register(this.connection);
      },
      onEvent: (event, kind) => { if (!this.stopped && generation === this.generation) this.publish({ type: "event", event, kind }); },
    });
    if (this.pendingStore && !this.submissions) this.submissions = new DesktopSubmissions(this.pendingStore, () => this.connection, this.publish, (op, params) => this.request(op, params));
    try { await this.connection.start(); }
    catch (error) {
      // 传输失败由 ControlConnection 退避重连；明确拒绝已由 onState 报告并停止重试。
      if (this.status.state !== "reconnecting" && this.status.state !== "failed") this.failed(serializeFailure(error, this.token));
    }

  }
  close(): void { this.stopped = true; ++this.generation; this.submissions?.close(); this.connection?.close(); }
  async dispatch(op: DesktopOp, params: OpParams<DesktopOp>): Promise<unknown> {
    if (op === "code_schedule_save" || op === "code_schedule_control") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "请等待连接恢复后再保存计划。");
      return this.submissions.schedule(op, params as OpParams<"code_schedule_save" | "code_schedule_control">);
    }
    if (op === "session_background_end") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "请等待连接恢复后再结束会话后台。");
      return this.submissions.endBackground(params);
    }
    if (op === "submit" || op === "owner_question_answer") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "请等待连接恢复后再发送。");
      return this.submissions.submit(op, params);
    }
    if (op === "owner_question_cancel") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "请等待连接恢复后再取消问题。");
      return this.submissions.cancelQuestion(params);
    }
    return this.request(op, params);
  }
  /** 页面事实上行到控制面（闸门/导航/关闭）；MyGo 外壳限定。 */
  browserEvent(event: DesktopBrowserEvent): void {
    this.browserBridge?.event(this.connection, event);
  }
  instanceId(): string | null { return this.connection?.instanceId ?? null; }
  connectionIdentity(): object | null { return this.connection; }
  async request<K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    if (!this.connection || this.stopped) throw new ControlClientError("connection_unavailable", "连接不可用：请求未发送", "not_sent");
    try { return await this.connection.request(op, params); }
    catch (error) {
      const failure = serializeFailure(error, this.token);
      throw new ControlClientError(failure.code, failure.message, failure.outcome, failure.versions);
    }
  }
}
