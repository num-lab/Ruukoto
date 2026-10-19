// Note: 见 .agents/notes/implemented/feature/2026-10-17-session-creation-settings.md
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { sessionDisplayAttribution } from "@ruukoto/control/session-attribution.ts";
import type { Session } from "@ruukoto/core/types.ts";
import { ViewState, isActiveStatus } from "@ruukoto/view/state.ts";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";
import type { DesktopOp } from "../main/ipc.ts";
import type { DesktopBridge, DesktopFailure, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import { DesktopApprovals } from "./approvals.ts";
import { CodeWrites } from "./code-writes.ts";
import { DesktopContext } from "./context-state.ts";
import { DesktopInspector } from "./inspector.ts";

export class DesktopRequestError extends Error {
  readonly code: string;
  constructor(readonly failure: DesktopFailure) { super(failure.message); this.code = failure.code; }
}
interface PendingCreation {
  op: "open_workspace" | "create_session";
  params: OpParams<"open_workspace"> & { request_id: string };
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
  private creationSourceId: string | null = null;
  private readonly flowCursors = new Map<string, number>();
  private readonly requests = new Map<string, Promise<void>>();
  private readonly pendingEntries = new Map<string, string | undefined>();
  readonly writes: CodeWrites;
  readonly approvals: DesktopApprovals;
  readonly inspector: DesktopInspector;
  readonly context: DesktopContext;
  navigation: Extract<DesktopUpdate, { type: "navigate" }> | null = null;
  notificationSelection: { sessionId: string; taskId: string } | null = null;
  refresh(): void { this.changed(); }
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly changed: () => void, readonly target: DesktopTarget = "code") {
    this.context = new DesktopContext(bridge, this.view, changed, target);
    this.approvals = new DesktopApprovals(bridge, this.view, changed, target);
    this.writes = new CodeWrites(bridge, this.view, () => this.status.state === "online", changed, target);
    this.inspector = new DesktopInspector(bridge, this.view, id => this.loadHistory(id), changed, target);
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
      this.inspector.update(update);
      if (update.state === "online") void this.reconcileCreation();
    } else if (update.type === "snapshot") {
      ++this.generation;
      this.requests.clear();
      this.pendingEntries.clear();
      this.flowCursors.clear();
      this.summaries.clear();
      this.readError = null;
      const instanceChanged = update.instanceChanged || (this.view.instanceId !== null && this.view.instanceId !== update.result.snapshot.instanceId);
      this.view.applySnapshot(update.result, instanceChanged);
      this.inspector.update({ ...update, instanceChanged });
      if (instanceChanged) { this.tabs = []; this.notificationSelection = null; this.creationSourceId = null; }
      this.tabs = this.tabs.filter(id => this.view.sessions.some(session => session.id === id));
      if (this.target === "code") void this.loadSummaries();
      for (const id of this.tabs) void this.loadHistory(id);
      if (this.inspector.childSessionId) void this.loadHistory(this.inspector.childSessionId);
      if (this.navigation) this.navigate(this.navigation);
      void this.reconcileCreation();
    } else if (update.type === "event") {
      this.view.applyEvent(update.event, update.kind);
      const body = update.event.body;
      if (this.target === "code" && (body.type === "session.created" || body.type === "session.workspace_mapped" || body.type === "project.created" || body.type === "task.queued")) void this.loadSummaries();
      if (body.type === "session.created") void this.reconcileCreation();
      if (body.type === "task.output_entry" && (this.tabs.includes(body.sessionId) || this.inspector.childSessionId === body.sessionId)) void this.loadEntry(body.sessionId, body.entryId, body.taskId);
      this.inspector.update(update);
    }
    if (update.type === "navigate") this.navigate(update);
    this.context.update(update);
    this.approvals.update(update);
    this.writes.update(update);
    this.changed();
  }
  private navigate(update: Extract<DesktopUpdate, { type: "navigate" }>): void {
    this.navigation = update;
    if (!this.view.instanceId) return;
    if (update.instanceId !== this.view.instanceId) { this.navigation = null; this.message = "通知所属的原目标已经变化，请查看原实例。"; return; }
    const child = this.view.subAgents.find(agent => agent.sessionId === update.navigation.sessionId);
    this.notificationSelection = update.navigation;
    this.openSession(child?.parentSessionId ?? update.navigation.sessionId);
    if (child) this.inspector.selectChild(child.sessionId);
    this.navigation = null;
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
    void this.context.load(id);
    if (!this.tabs.includes(id)) this.tabs.push(id);
    this.view.currentSessionId = id;
    this.rememberCreationSource();
    this.inspector.openParent(id);
    const view = this.view.openSession(id);
    if (!view.historyLoaded) void this.loadHistory(id);
    this.changed();
  }
  closeSession(id: string): void {
    this.rememberCreationSource();
    const index = this.tabs.indexOf(id);
    this.tabs = this.tabs.filter(tab => tab !== id);
    if (this.view.currentSessionId === id) this.view.currentSessionId = this.tabs[Math.max(0, index - 1)] ?? null;
    this.rememberCreationSource();
    if (this.view.currentSessionId) this.inspector.openParent(this.view.currentSessionId);
    this.changed();
  }
  private creationSource(): Session | undefined {
    const eligible = (session: Session) => this.target === "code" && session.kind === "dev" && !this.view.subAgentSessionIds.includes(session.id) && !this.view.roleSessionIds.includes(session.id);
    return this.view.sessions.find(session => session.id === this.view.currentSessionId && eligible(session)) ?? this.view.sessions.find(session => session.id === this.creationSourceId && eligible(session));
  }
  private rememberCreationSource(): void {
    const source = this.creationSource();
    if (source) this.creationSourceId = source.id;
  }
  private report(text: string): void { this.message = text; this.changed(); }
  private run(key: string, action: (generation: number) => Promise<void>): Promise<void> {
    key = `${this.generation}:${key}`;
    const pending = this.requests.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const request = action(generation).catch(error => {
      if (generation === this.generation) this.readError = `读取会话失败：${error instanceof Error ? error.message : "请重新连接后再试。"}`;
    }).finally(() => { this.requests.delete(key); this.inspector.seedTabs(); void this.inspector.loadDiff(); this.changed(); });
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
      if (entry.truncated) await this.loadEntry(sessionId, entry.entryId, entry.taskId ?? undefined);
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
        await this.loadEntry(detail.task.sessionId, entryId, detail.task.id);
      }
    });
  }
  // Note: 见 .agents/notes/implemented/feature/2026-10-18-completed-trace.md
  historyReady(sessionId: string, taskId: string): boolean { return ![...this.pendingEntries].some(([key, pendingTask]) => key.startsWith(`${sessionId}:`) && pendingTask === taskId); }
  loadEntry(sessionId: string, entryId: string, taskId?: string): Promise<void> {
    const key = `${sessionId}:${entryId}`;
    this.pendingEntries.set(key, taskId ?? this.pendingEntries.get(key));
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
      this.pendingEntries.delete(key);
    });
  }

  async create(op: PendingCreation["op"], params: { cwd: string; project_id?: string }): Promise<boolean> {
    if (this.pendingCreation) return this.reconcileCreation();
    if (!this.view.instanceId || this.status.state !== "online") { this.report("请等待连接恢复后再创建会话。"); return false; }
    const source = this.creationSource();
    if (source && this.writes.settingsPending(source.id)) { this.report("会话设置仍在保存或等待核实，请确认后台实际设置后再创建会话。"); return false; }
    const settings = source ? { mode: source.defaultAccessMode, ...(source.modelSelection ? { model_selection: { ...source.modelSelection } } : {}) } : {};
    const pending: PendingCreation = { op, params: { ...params, ...settings, request_id: crypto.randomUUID() }, target: this.target, instanceId: this.view.instanceId, busy: false, retried: false, waitGeneration: null };
    this.pendingCreation = pending;
    this.message = null;
    this.changed();
    return this.sendCreation(pending);
  }
  private owns(pending: PendingCreation): boolean {
    if (pending.target === this.target && pending.instanceId === this.view.instanceId) return true;
    this.report("原操作结果仍未知；请连回原数据实例后核实左栏工作区树。当前实例不会重发原操作。");
    return false;
  }
  private complete(pending: PendingCreation, session: Session): boolean {
    if (!this.owns(pending)) return false;
    if (!this.view.sessions.some(item => item.id === session.id)) this.view.sessions.push(session);
    this.pendingCreation = null;
    this.message = null;
    this.openSession(session.id);
    void this.loadSummaries();
    return true;
  }
  private async reconcileCreation(): Promise<boolean> {
    const pending = this.pendingCreation;
    if (!pending || !this.owns(pending) || pending.busy) return false;
    if (pending.waitGeneration !== null && this.generation <= pending.waitGeneration) return false;
    const session = this.view.sessions.find(item => item.createRequestId === pending.params.request_id);
    if (session) return this.complete(pending, session);
    if (this.status.state !== "online") return false;
    if (pending.retried) { this.report("创建结果未知；请在左栏工作区树查看会话是否已建好，恢复连接后继续核实。"); return false; }
    pending.retried = true;
    return this.sendCreation(pending);
  }
  private async sendCreation(pending: PendingCreation): Promise<boolean> {
    if (!this.owns(pending)) return false;
    pending.busy = true;
    const generation = this.generation;
    let result: Session | OpResult<"open_workspace">;
    try { result = await this.request(pending.op, pending.params); }
    catch (error) {
      pending.busy = false;
      if (!this.owns(pending)) return false;
      if (error instanceof DesktopRequestError && error.failure.outcome === "rejected") {
        this.pendingCreation = null;
        this.report(`会话创建失败：${error.message}`);
        return false;
      }
      if (error instanceof DesktopRequestError && error.failure.outcome === "unknown") return this.reconcileCreation();
      pending.waitGeneration = generation;
      this.report("创建结果待核实；连接恢复后将按原操作核实，请在左栏工作区树查看会话。");
      if (this.generation > generation) return this.reconcileCreation();
      return false;
    }
    pending.busy = false;
    return this.complete(pending, "session" in result ? result.session : result);
  }
}
