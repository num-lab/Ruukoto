import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopBridge, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";

export type DesktopContextValue = OpResult<"get_context_breakdown"> & {
  display: { systemTokens: number; toolTokens: number; messageTokens: number; usedTokens: number; maxTokens: number | null; usedPercent: number | null };
};
export interface DesktopContextState {
  loading: boolean;
  error: string | null;
  missing: boolean;
  value: DesktopContextValue | null;
}
class ContextReadError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const emptyState = (): DesktopContextState => ({ loading: false, error: null, missing: false, value: null });

// Note: See .agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md
export class DesktopContext {
  private readonly states = new Map<string, DesktopContextState>();
  private readonly requests = new Map<string, Promise<void>>();
  private readonly refreshAfterRead = new Set<string>();
  private generation = 0;
  private online = true;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly view: ViewState, private readonly changed: () => void, private readonly target: DesktopTarget = "code") {}
  private key(sessionId: string): string { return `${this.view.instanceId}:${sessionId}`; }
  get(sessionId: string): DesktopContextState { return this.states.get(this.key(sessionId)) ?? emptyState(); }
  private async request<K extends "list_prompt_requests" | "get_context_breakdown">(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new ContextReadError(result.error.code, result.error.message);
    // The main process forwards the control response verbatim; restore types at the IPC boundary.
    return result.value as OpResult<K>;
  }
  update(update: DesktopUpdate): void {
    if (update.type === "snapshot" || (update.type === "state" && update.state !== "online")) {
      ++this.generation;
      this.states.clear();
      this.requests.clear();
      this.refreshAfterRead.clear();
    }
    if (update.type === "state") this.online = update.state === "online";
    const sessionId = this.view.currentSessionId;
    if (!sessionId) return;
    if (update.type === "snapshot" || (update.type === "state" && update.state === "online")) void this.load(sessionId);
    if (update.type === "event" && update.kind === "live" && ["task.output_entry", "task.completed", "task.failed", "task.interrupted", "task.canceled"].includes(update.event.body.type)) {
      const taskId = update.event.taskId;
      const sourceSessionId = update.event.sessionId ?? (taskId ? this.view.getTask(taskId)?.sessionId : null);
      if (sourceSessionId === sessionId) {
        if (this.requests.has(this.key(sessionId))) this.refreshAfterRead.add(this.key(sessionId));
        else void this.load(sessionId);
      }
    }
  }
  load(sessionId: string): Promise<void> {
    if (!this.online || !this.view.instanceId || !this.view.sessions.some(session => session.id === sessionId)) return Promise.resolve();
    const key = this.key(sessionId);
    const pending = this.requests.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const state = { ...emptyState(), loading: true };
    this.states.set(key, state);
    this.changed();
    const owns = () => generation === this.generation && key === this.key(sessionId) && this.states.get(key) === state && this.view.sessions.some(session => session.id === sessionId);
    const request = (async () => {
      const page = await this.request("list_prompt_requests", { session_id: sessionId, limit: 1 });
      if (!owns()) return;
      const record = page.records[0];
      if (!record) { state.missing = true; return; }
      if (record.sessionId !== sessionId) throw new ContextReadError("context_mismatch", "Context record does not belong to this chat");
      const value = await this.request("get_context_breakdown", { session_id: sessionId, record_id: record.id });
      if (!owns()) return;
      if (value.record.sessionId !== sessionId || value.record.id !== record.id) throw new ContextReadError("context_mismatch", "Context details do not match the requested record");
      const { breakdown } = value;
      const systemTokens = breakdown.categories.find(category => category.key === "systemPrompt")?.tokens ?? 0;
      const toolTokens = breakdown.categories.find(category => category.key === "toolSchemas")?.tokens ?? 0;
      const maxTokens = breakdown.window?.contextWindow ?? null;
      state.value = { ...value, display: { systemTokens, toolTokens, messageTokens: breakdown.estimatedTotal - systemTokens - toolTokens, usedTokens: breakdown.estimatedTotal, maxTokens, usedPercent: maxTokens === null ? null : breakdown.estimatedTotal / maxTokens * 100 } };
    })().catch(error => {
      if (owns()) state.error = error instanceof ContextReadError ? `Couldn't read context: ${error.message} Reopen the details and try again.` : "Couldn't read context. Reopen the details and try again.";
    }).finally(() => {
      if (!owns()) return;
      state.loading = false;
      this.requests.delete(key);
      this.changed();
      if (this.refreshAfterRead.delete(key)) return this.load(sessionId);
    });
    this.requests.set(key, request);
    return request;
  }
}
