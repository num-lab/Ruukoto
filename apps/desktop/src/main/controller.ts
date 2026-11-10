import { ControlClientError } from "@ruukoto/control/client.ts";
import { ControlConnection, type ConnectionCallbacks, type ConnectionConfig } from "@ruukoto/control/connection.ts";
import { ensureBackend, type EnsureBackendOptions, type EnsureBackendResult } from "@ruukoto/control/ensure-backend.ts";
import { resolveClientConfig } from "@ruukoto/control/connect.ts";
import { ProfileError } from "@ruukoto/core/profile.ts";
import type { DesktopFailure, DesktopUpdate } from "../shared/bridge.ts";
import type { OpParams, OpResult, TuiOp } from "@ruukoto/control/ops.ts";
import { DesktopError, type DesktopBackendConfig } from "./environment.ts";
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
    : { code: error instanceof DesktopError || error instanceof ProfileError ? error.code : "desktop_failed", outcome: "not_sent", message: error instanceof Error ? error.message : "The desktop operation failed; reconnect." };
  if (token) failure.message = failure.message.replaceAll(token, "[token hidden]");
  return failure;
}

// Note: See .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class CodeController {
  private connection: Connection | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private stopped = false;
  private token: string | undefined;
  submissions: DesktopSubmissions | null = null;
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "connecting" };
  /** MyGo native-browser bridge: injected only by the MyGo shell; registration, narrow-command replies and event uplink go through the current connection. */
  private readonly browserBridge: DesktopBrowserBridge | null;

  constructor(readonly config: DesktopBackendConfig, private readonly publish: (update: DesktopUpdate) => void, private readonly deps: ControllerDeps = {
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
    const secret = this.token;
    if (secret) failure = { ...failure, message: failure.message.replaceAll(secret, "[token hidden]") };
    this.state({ type: "state", state: "failed", error: failure, detail: failure.message, ...(failure.versions ? { recovery: versionRecovery(failure.versions, this.config.managed, this.config.profile) } : {}) });
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
    this.publish({ type: "profile", profile: { instanceId: this.config.profile.instanceId, draftKey: this.config.profile.desktopDraftKey } });
    if (!this.config.managed) {
      const result = await this.deps.ensure(this.config);
      if (this.stopped) return;
      if (!result.ok) {
        this.failed({ code: result.code ?? "backend_start_failed", outcome: "not_sent", message: result.error, ...(result.versions ? { versions: result.versions } : {}) });
        return;
      }
    }
    this.token = resolveClientConfig(this.config.profile).token;
    this.connection = this.deps.connection({
      profile: this.config.profile, token: this.token,
      ...(this.browserBridge ? { callHandler: (op: string, params: Record<string, unknown>, callId: string) => this.browserBridge!.handleCall(op, params, callId, () => this.connection) } : {}),
    }, {
      onState: (state, detail, error) => {
        if (this.stopped || generation !== this.generation) return;
        if (state === "failed" && error) this.failed(serializeFailure(error, this.token));
        else this.state({ type: "state", state, detail: detail?.replaceAll(this.token!, "[token hidden]") });
      },
      onSnapshot: (result, context) => {
        if (this.stopped || generation !== this.generation) return;
        this.publish({ type: "snapshot", result, instanceChanged: context.instanceChanged });
        void this.submissions?.reconcile();
        this.browserBridge?.register(this.connection);
      },
      onEvent: (event, kind) => {
        if (this.stopped || generation !== this.generation) return;
        this.publish({ type: "event", event, kind });
        if (event.body.type === "session.context_compaction") void this.submissions?.reconcile();
      },
    });
    if (this.pendingStore && !this.submissions) this.submissions = new DesktopSubmissions(this.pendingStore, () => this.connection, this.publish, (op, params) => this.request(op, params));
    try { await this.connection.start(); }
    catch (error) {
      // Transport failures are retried by ControlConnection's backoff; explicit rejections were already reported via onState and stop retrying.
      if (this.status.state !== "reconnecting" && this.status.state !== "failed") this.failed(serializeFailure(error, this.token));
    }

  }
  close(): void { this.stopped = true; ++this.generation; this.submissions?.close(); this.connection?.close(); }
  async dispatch(op: DesktopOp, params: OpParams<DesktopOp>): Promise<unknown> {
    if (op === "code_schedule_save" || op === "code_schedule_control") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before saving the schedule.");
      return this.submissions.schedule(op, params as OpParams<"code_schedule_save" | "code_schedule_control">);
    }
    if (op === "compact_session") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before compacting context.");
      return this.submissions.compact(params as OpParams<"compact_session">);
    }
    if (op === "session_background_end") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before ending the chat's background.");
      return this.submissions.endBackground(params);
    }
    if (op === "submit" || op === "owner_question_answer") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before sending.");
      return this.submissions.submit(op, params);
    }
    if (op === "owner_question_cancel") {
      if (!this.submissions) throw new DesktopError("connection_unavailable", "Wait for the connection to recover before canceling the question.");
      return this.submissions.cancelQuestion(params);
    }
    return this.request(op, params);
  }
  /** Page facts uplinked to the control plane (gating/navigation/close); MyGo shell only. */
  browserEvent(event: DesktopBrowserEvent): void {
    this.browserBridge?.event(this.connection, event);
  }
  instanceId(): string | null { return this.connection?.instanceId ?? null; }
  connectionIdentity(): object | null { return this.connection; }
  async request<K extends TuiOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    if (!this.connection || this.stopped) throw new ControlClientError("connection_unavailable", "Connection unavailable: request not sent", "not_sent");
    try { return await this.connection.request(op, params); }
    catch (error) {
      const failure = serializeFailure(error, this.token);
      throw new ControlClientError(failure.code, failure.message, failure.outcome, failure.versions);
    }
  }
}
