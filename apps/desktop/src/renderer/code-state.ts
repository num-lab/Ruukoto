import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { sessionDisplayAttribution } from "@ruukoto/control/session-attribution.ts";
import type { Session } from "@ruukoto/core/types.ts";
import { ViewState, isActiveStatus } from "@ruukoto/view/state.ts";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";
import type { DesktopOp } from "../main/ipc.ts";
import type { DesktopBridge, DesktopFailure, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import { CodeWrites } from "./code-writes.ts";

export class DesktopRequestError extends Error {
  readonly code: string;
  constructor(readonly failure: DesktopFailure) { super(failure.message); this.code = failure.code; }
}
interface PendingCreation {
  op: "open_workspace" | "create_session";
  params: { cwd: string; project_id?: string; request_id: string };
  target: DesktopTarget;
  instanceId: string;
  busy: boolean;
  retried: boolean;
  waitGeneration: number | null;
}

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class CodeState {
  readonly view = new ViewState();
  readonly summaries = new Map<string, OpResult<"list_session_summaries">>();
  tabs: string[] = [];
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "connecting" };
  message: string | null = null;
  readError: string | null = null;
  pendingCreation: PendingCreation | null = null;
  private generation = 0;
  private readonly flowCursors = new Map<string, number>();
  private readonly requests = new Map<string, Promise<void>>();
  readonly writes: CodeWrites;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly changed: () => void, readonly target: DesktopTarget = "code") {
    this.writes = new CodeWrites(bridge, this.view, () => this.status.state === "online", changed, target);
  }

  private async request<K extends DesktopOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new DesktopRequestError(result.error);
    // preload 的响应是 IPC wire 数据，主进程只转发同仓控制面返回值。
    return result.value as OpResult<K>;
  }
  update(update: DesktopUpdate): void {
    if (update.type === "state") {
      this.status = update;
      if (update.state === "online") void this.reconcileCreation();
    } else if (update.type === "snapshot") {
      ++this.generation;
      this.requests.clear();
      this.flowCursors.clear();
      this.summaries.clear();
      this.readError = null;
      const instanceChanged = update.instanceChanged || (this.view.instanceId !== null && this.view.instanceId !== update.result.snapshot.instanceId);
      this.view.applySnapshot(update.result, instanceChanged);
      if (instanceChanged) this.tabs = [];
      this.tabs = this.tabs.filter(id => this.view.sessions.some(session => session.id === id));
      void this.loadSummaries();
      for (const id of this.tabs) void this.loadHistory(id);
      void this.reconcileCreation();
    } else if (update.type === "event") {
      this.view.applyEvent(update.event, update.kind);
      const body = update.event.body;
      if (body.type === "session.created" || body.type === "session.workspace_mapped" || body.type === "project.created" || body.type === "task.queued") void this.loadSummaries();
      if (body.type === "session.created") void this.reconcileCreation();
      if (body.type === "task.output_entry" && this.tabs.includes(body.sessionId)) void this.loadEntry(body.sessionId, body.entryId);
    }
    this.writes.update(update);
    this.changed();
  }
  sessionsFor(workspaceId: string): Session[] {
    return this.view.sessions.filter(session => sessionDisplayAttribution(session, this.view.projects).projectId === workspaceId && !this.view.subAgentSessionIds.includes(session.id) && !this.view.roleSessionIds.includes(session.id) && session.kind === "dev");
  }
  sessionName(id: string): string {
    for (const summaries of this.summaries.values()) {
      const summary = summaries.find(item => item.sessionId === id);
      if (summary?.name) return summary.name;
    }
    return this.view.sessions.find(session => session.id === id)?.name ?? "新会话";
  }
  openSession(id: string): void {
    if (!this.tabs.includes(id)) this.tabs.push(id);
    this.view.currentSessionId = id;
    const view = this.view.openSession(id);
    if (!view.historyLoaded) void this.loadHistory(id);
    this.changed();
  }
  closeSession(id: string): void {
    const index = this.tabs.indexOf(id);
    this.tabs = this.tabs.filter(tab => tab !== id);
    if (this.view.currentSessionId === id) this.view.currentSessionId = this.tabs[Math.max(0, index - 1)] ?? null;
    this.changed();
  }
  private report(text: string): void { this.message = text; this.changed(); }
  private run(key: string, action: (generation: number) => Promise<void>): Promise<void> {
    key = `${this.generation}:${key}`;
    const pending = this.requests.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const request = action(generation).catch(error => {
      if (generation === this.generation) this.readError = `读取会话失败：${error instanceof Error ? error.message : "请重新连接后再试。"}`;
    }).finally(() => { this.requests.delete(key); this.changed(); });
    this.requests.set(key, request);
    return request;
  }
  private loadSummaries(): Promise<void> {
    return this.run("summaries", async generation => {
      for (const workspace of this.view.projects) {
        const summaries = await this.request("list_session_summaries", { workspace_id: workspace.id });
        if (generation !== this.generation) return;
        this.summaries.set(workspace.id, summaries);
      }
    });
  }
  loadHistory(sessionId: string, mode: "replace" | "prepend" = "replace"): Promise<void> {
    return this.run(`history:${sessionId}`, async generation => {
      const view = this.view.openSession(sessionId);
      if (mode === "prepend" && !view.historyCursor) return;
      const page = await this.request("read_history", { session_id: sessionId, before: mode === "prepend" ? view.historyCursor ?? undefined : undefined, limit: 50 });
      if (generation !== this.generation) return;
      this.view.installHistoryPage(sessionId, page, mode);
      this.changed();
      await this.restoreEventFlow(sessionId, generation);
    });
  }
  private async restoreEventFlow(sessionId: string, generation: number): Promise<void> {
    const entries = this.view.openSession(sessionId).flow.historyEntries;
    const earliest = entries.reduce((at, entry) => !at || entry.timestamp < at ? entry.timestamp : at, "");
    const ids = new Set(entries.map(entry => entry.entryId));
    const relevant = new Set<string>();
    let before: string | undefined;
    do {
      const page = await this.request("list_tasks", { session_id: sessionId, before, limit: 50 });
      if (generation !== this.generation) return;
      for (const task of page.tasks) {
        if (!earliest || isActiveStatus(task.status) || (task.endedAt ?? task.createdAt) >= earliest || task.historyEntryIds.some(id => ids.has(id))) {
          if (!this.view.getTask(task.id)) this.view.upsertTask(task);
          relevant.add(task.id);
        }
      }
      const last = page.tasks.at(-1);
      if (!page.hasMore || !last || !earliest || (last.endedAt ?? last.createdAt) < earliest) break;
      before = last.id;
    } while (true);
    await Promise.all([...relevant].map(taskId => this.readTaskFlow(taskId)));
    if (generation !== this.generation) return;
    for (const entry of entries) {
      if (generation !== this.generation) return;
      if (entry.truncated) await this.loadEntry(sessionId, entry.entryId);
    }
  }
  private readTaskFlow(taskId: string): Promise<void> {
    return this.run(`task:${taskId}`, async generation => {
      const detail = await this.request("get_task", { task_id: taskId });
      if (generation !== this.generation) return;
      this.view.installTaskDetail(detail.task, detail.toolOps ?? [], detail.outputPreview, detail.seq);
      const view = this.view.openSession(detail.task.sessionId);
      let after = this.flowCursors.get(taskId) ?? 0;
      const missing = new Set<string>();
      const loaded = new Set(view.flow.historyEntries.filter(entry => !entry.truncated).map(entry => entry.entryId));
      do {
        const page = await this.request("read_task_events", { task_id: taskId, after_seq: after, limit: 100 });
        if (generation !== this.generation) return;
        for (const event of page.events) {
          view.flow.apply(event);
          if (event.body.type === "task.output_entry" && !loaded.has(event.body.entryId)) missing.add(event.body.entryId);
          after = Math.max(after, event.seq);
        }
        this.flowCursors.set(taskId, after);
        this.changed();
        if (page.nextAfter === null) break;
        after = page.nextAfter;
      } while (true);
      for (const entryId of missing) {
        if (generation !== this.generation) return;
        await this.loadEntry(detail.task.sessionId, entryId);
      }
    });
  }
  loadEntry(sessionId: string, entryId: string): Promise<void> {
    return this.run(`entry:${sessionId}:${entryId}`, async generation => {
      let entry: OpResult<"read_history_entry">;
      try { entry = await this.request("read_history_entry", { session_id: sessionId, entry_id: entryId, length: 64 * 1024 }); }
      catch (error) {
        if (error instanceof DesktopRequestError && error.code === "entry_not_found") return;
        throw error;
      }
      if (generation !== this.generation) return;
      let text = entry.text;
      let offset = entry.offset + utf8ByteLength(text);
      if (entry.offset !== 0) throw new DesktopRequestError({ code: "history_discontinuous", outcome: "rejected", message: "历史正文分页未从开头返回；请重新加载会话。" });
      while (offset < entry.totalBytes) {
        const page = await this.request("read_history_entry", { session_id: sessionId, entry_id: entryId, offset, length: 64 * 1024 });
        if (generation !== this.generation) return;
        if (!page.text || page.offset !== offset || page.totalBytes !== entry.totalBytes) throw new DesktopRequestError({ code: "history_discontinuous", outcome: "rejected", message: "历史正文分页未连续返回；请重新加载会话。" });
        text += page.text;
        offset += utf8ByteLength(page.text);
      }
      this.view.appendEntryView(sessionId, { ...entry, text, truncated: false });
    });
  }

  async create(op: PendingCreation["op"], params: { cwd: string; project_id?: string }): Promise<void> {
    if (this.pendingCreation) return this.reconcileCreation();
    if (!this.view.instanceId || this.status.state !== "online") { this.report("请等待连接恢复后再创建会话。"); return; }
    const pending: PendingCreation = { op, params: { ...params, request_id: crypto.randomUUID() }, target: this.target, instanceId: this.view.instanceId, busy: false, retried: false, waitGeneration: null };
    this.pendingCreation = pending;
    this.message = "正在创建会话…";
    this.changed();
    await this.sendCreation(pending);
  }
  private owns(pending: PendingCreation): boolean {
    if (pending.target === this.target && pending.instanceId === this.view.instanceId) return true;
    this.report("原操作结果仍未知；请连回原数据实例后核实左栏工作区树。当前实例不会重发原操作。");
    return false;
  }
  private complete(pending: PendingCreation, session: Session): void {
    if (!this.owns(pending)) return;
    if (!this.view.sessions.some(item => item.id === session.id)) this.view.sessions.push(session);
    this.pendingCreation = null;
    this.message = null;
    this.openSession(session.id);
    void this.loadSummaries();
  }
  private async reconcileCreation(): Promise<void> {
    const pending = this.pendingCreation;
    if (!pending || !this.owns(pending) || pending.busy) return;
    if (pending.waitGeneration !== null && this.generation <= pending.waitGeneration) return;
    const session = this.view.sessions.find(item => item.createRequestId === pending.params.request_id);
    if (session) { this.complete(pending, session); return; }
    if (this.status.state !== "online") return;
    if (pending.retried) { this.report("创建结果未知；请在左栏工作区树查看会话是否已建好，恢复连接后继续核实。"); return; }
    pending.retried = true;
    await this.sendCreation(pending);
  }
  private async sendCreation(pending: PendingCreation): Promise<void> {
    if (!this.owns(pending)) return;
    pending.busy = true;
    const generation = this.generation;
    let result: Session | OpResult<"open_workspace">;
    try { result = await this.request(pending.op, pending.params); }
    catch (error) {
      pending.busy = false;
      if (!this.owns(pending)) return;
      if (error instanceof DesktopRequestError && error.failure.outcome === "rejected") {
        this.pendingCreation = null;
        this.report(`会话创建失败：${error.message}`);
        return;
      }
      if (error instanceof DesktopRequestError && error.failure.outcome === "unknown") return this.reconcileCreation();
      pending.waitGeneration = generation;
      this.report("创建结果待核实；连接恢复后将按原操作核实，请在左栏工作区树查看会话。");
      if (this.generation > generation) await this.reconcileCreation();
      return;
    }
    pending.busy = false;
    this.complete(pending, "session" in result ? result.session : result);
  }
}
