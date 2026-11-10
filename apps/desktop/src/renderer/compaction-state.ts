import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { SessionCompactionRequest } from "@ruukoto/core/types.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopBridge, DesktopCompactionResult, DesktopUpdate } from "../shared/bridge.ts";

export interface DesktopCompactionState {
  request: SessionCompactionRequest | null;
  pending: PendingRequest | null;
  loading: boolean;
  stopping: boolean;
  message: string | null;
}
const empty = (): DesktopCompactionState => ({ request: null, pending: null, loading: false, stopping: false, message: null });
class CompactionReadError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export class DesktopCompactions {
  private readonly states = new Map<string, DesktopCompactionState>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly starting = new Set<string>();
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly view: ViewState, private readonly online: () => boolean, private readonly changed: () => void) {}
  private key(sessionId: string, instanceId = this.view.instanceId): string { return `${instanceId}:${sessionId}`; }
  get(sessionId: string): DesktopCompactionState {
    const key = this.key(sessionId);
    let state = this.states.get(key);
    if (!state) { state = empty(); this.states.set(key, state); }
    return state;
  }
  occupied(sessionId: string): boolean { const state = this.get(sessionId); return this.starting.has(this.key(sessionId)) || !!state.pending || state.request?.status === "running"; }
  private accept(result: DesktopCompactionResult): void {
    const { record, outcome } = result;
    if (typeof record.params.session_id !== "string") return;
    const key = this.key(record.params.session_id, record.instanceId);
    const state = this.states.get(key) ?? empty();
    this.states.set(key, state);
    const createdAt = outcome.kind === "accepted" ? outcome.request.createdAt : record.createdAt;
    if (state.request && state.request.requestId !== record.requestId && createdAt <= state.request.createdAt) return;
    if (state.request?.requestId === record.requestId && state.request.status !== "running" && outcome.kind !== "accepted") return;
    if (outcome.kind === "accepted") {
      if (state.pending && state.pending.requestId !== record.requestId) return;
      if (state.request?.requestId === outcome.request.requestId && state.request.status !== "running" && outcome.request.status === "running") return;
      state.request = outcome.request;
      state.pending = outcome.request.status === "running" ? record : null;
      state.message = null;
    } else if (outcome.kind === "rejected") { state.pending = null; state.message = outcome.message; }
    else { state.pending = record; state.message = outcome.kind === "foreign_instance" ? "The compaction request belongs to another data instance. Reconnect to that instance to verify." : outcome.message; }
    this.changed();
  }
  update(update: DesktopUpdate): void {
    if (update.type === "compaction") this.accept(update.result);
    if (update.type === "pending") {
      for (const { record } of update.entries) {
        if (record.op !== "compact_session" || typeof record.params.session_id !== "string") continue;
        const key = this.key(record.params.session_id, record.instanceId), state = this.states.get(key) ?? empty();
        this.states.set(key, state);
        if (state.request && state.request.requestId !== record.requestId && record.createdAt <= state.request.createdAt) continue;
        if (state.request?.requestId !== record.requestId || state.request.status === "running") state.pending = record;
      }
    }
    if (update.type === "snapshot" || update.type === "state" && update.state === "online") {
      if (this.view.currentSessionId) void this.load(this.view.currentSessionId);
      for (const state of this.states.values()) if (state.pending?.instanceId === this.view.instanceId) void this.load(String(state.pending.params.session_id));
    }
    if (update.type === "event" && update.event.body.type === "session.context_compaction") void this.load(update.event.body.sessionId);
  }
  private async request<K extends "get_session_compaction" | "interrupt_session_compaction">(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const result = await this.bridge.request("code", op, params);
    if (!result.ok) throw new CompactionReadError(result.error.code, result.error.message);
    return result.value as OpResult<K>;
  }
  private apply(sessionId: string, request: SessionCompactionRequest): void {
    const state = this.get(sessionId);
    if (state.pending && state.pending.requestId !== request.requestId) return;
    if (state.request && state.request.requestId !== request.requestId && request.createdAt < state.request.createdAt) return;
    if (state.request?.requestId === request.requestId && state.request.status !== "running" && request.status === "running") return;
    state.request = request;
    if (request.status !== "running") state.pending = null;
    state.message = null;
  }
  load(sessionId: string): Promise<void> {
    const key = this.key(sessionId);
    if (!this.online() || !this.view.instanceId) return Promise.resolve();
    const existing = this.reads.get(key);
    if (existing) return existing;
    const state = this.get(sessionId);
    const knownRequestId = state.pending?.requestId ?? state.request?.requestId;
    state.loading = true;
    this.changed();
    const read = (async () => {
      try {
        const request = await this.request("get_session_compaction", { session_id: sessionId, ...(state.pending ? { request_id: state.pending.requestId } : {}) });
        if (key !== this.key(sessionId) || knownRequestId !== (state.pending?.requestId ?? state.request?.requestId)) return;
        if (request) this.apply(sessionId, request);
        else if (state.pending) state.message = "The compaction result isn't available yet. Verify the original request.";
      } catch (error) { if (key === this.key(sessionId)) state.message = error instanceof Error ? error.message : "Couldn't read the compaction result. Restore the connection and try again."; }
      finally { state.loading = false; this.reads.delete(key); this.changed(); }
    })();
    this.reads.set(key, read);
    return read;
  }
  async start(sessionId: string, prompt = ""): Promise<boolean> {
    const state = this.get(sessionId), key = this.key(sessionId);
    if (!this.online() || !this.view.instanceId) { state.message = "Restore the ruukoto connection before compacting context."; this.changed(); return false; }
    if (this.occupied(sessionId)) { state.message = "The compaction request is still running or unverified. Check its result first."; this.changed(); return false; }
    const requestId = crypto.randomUUID();
    state.request = null;
    state.pending = { requestId, op: "compact_session", instanceId: this.view.instanceId, params: { session_id: sessionId, request_id: requestId, ...(prompt ? { prompt } : {}) }, createdAt: new Date().toISOString() };
    this.starting.add(key); state.message = null; this.changed();
    try {
      const result = await this.bridge.request("code", "compact_session", { session_id: sessionId, request_id: requestId, ...(prompt ? { prompt } : {}) });
      if (key !== this.key(sessionId)) return false;
      if (!result.ok) { if (result.error.outcome === "rejected" || result.error.outcome === "not_sent") state.pending = null; state.message = result.error.message; return false; }
      const value = result.value as DesktopCompactionResult;
      this.accept(value);
      return value.outcome.kind === "accepted" || this.get(sessionId).request?.requestId === value.record.requestId;
    } catch { state.message = "No host response. Reopen the app to verify the compaction request."; return false; }
    finally { this.starting.delete(key); this.changed(); }
  }
  async retry(sessionId: string): Promise<void> {
    const state = this.get(sessionId), pending = state.pending, key = this.key(sessionId);
    if (!this.online() || !pending || state.request?.status === "running" || this.starting.has(key)) return;
    this.starting.add(key); this.changed();
    try {
      const result = await this.bridge.request("code", "compact_session", pending.params);
      if (key !== this.key(sessionId)) return;
      if (result.ok) this.accept(result.value as DesktopCompactionResult);
      else state.message = result.error.message;
    } catch { state.message = "No host response. Reopen the app to verify the compaction request."; }
    finally { this.starting.delete(key); this.changed(); }
  }
  async stop(sessionId: string): Promise<void> {
    const state = this.get(sessionId), key = this.key(sessionId);
    const request = state.request;
    if (!this.online() || !request || request.status !== "running" || state.stopping) return;
    state.stopping = true; this.changed();
    try {
      const result = await this.request("interrupt_session_compaction", { session_id: sessionId, request_id: request.requestId });
      if (key === this.key(sessionId)) this.apply(sessionId, result);
    } catch (error) { if (key === this.key(sessionId)) { state.message = error instanceof Error ? error.message : "Stop outcome unverified. Read the compaction result again."; await this.load(sessionId); } }
    finally { state.stopping = false; this.changed(); }
  }
}
