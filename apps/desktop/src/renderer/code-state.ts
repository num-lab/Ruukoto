// Note: 见 .agents/notes/implemented/feature/2026-10-17-session-creation-settings.md
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { sessionDisplayAttribution } from "@ruukoto/control/session-attribution.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { ModelSelection, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import { ViewState, isActiveStatus } from "@ruukoto/view/state.ts";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";
import type { DesktopOp } from "../main/ipc.ts";
import type { DesktopAttachment, DesktopBridge, DesktopFailure, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import { DesktopApprovals } from "./approvals.ts";
import { CodeWrites } from "./code-writes.ts";
import { DesktopContext } from "./context-state.ts";
import { DesktopInspector } from "./inspector.ts";
import { DesktopSearch } from "./search-state.ts";

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
  defaultModelKnown = false;
  private generation = 0;
  private defaultModelRead = 0;
  /** 恢复窗口内累计的变更只画一次：中间投影会把已收起 trace 画成展开态。 */
  private quiet = 0;
  private dirty = false;
  private creationSourceId: string | null = null;
  private readonly flowCursors = new Map<string, number>();
  private readonly requests = new Map<string, Promise<void>>();
  private readonly pendingEntries = new Map<string, string | undefined>();
  readonly writes: CodeWrites;
  readonly approvals: DesktopApprovals;
  readonly inspector: DesktopInspector;
  readonly context: DesktopContext;
  readonly search: DesktopSearch;
  navigation: Extract<DesktopUpdate, { type: "navigate" }> | null = null;
  notificationSelection: { sessionId: string; taskId: string } | null = null;
  refresh(): void { this.mark(); }
  // Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-creation-spinner.md
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly changed: () => void, readonly target: DesktopTarget = "code") {
    this.context = new DesktopContext(bridge, this.view, changed, target);
    this.approvals = new DesktopApprovals(bridge, this.view, changed, target);
    this.search = new DesktopSearch(bridge, changed);
    this.writes = new CodeWrites(bridge, this.view, () => this.status.state === "online", changed, target);
    this.inspector = new DesktopInspector(bridge, this.view, id => this.loadHistory(id), changed, target);
  }

  private async request<K extends DesktopOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new DesktopRequestError(result.error);
    // preload 的响应是 IPC wire 数据，主进程只转发同仓控制面返回值。
    return result.value as OpResult<K>;
  }
  /** 恢复期间合并重绘；最外层结束后才把最终投影交给界面。 */
  private settle<T>(action: () => Promise<T>): Promise<T> {
    ++this.quiet;
    return action().finally(() => {
      if (--this.quiet > 0 || !this.dirty) return;
      this.dirty = false;
      this.changed();
    });
  }
  /** 恢复窗口内只记下需要重绘，窗口关闭时统一发出。 */
  private mark(): void {
    if (this.quiet > 0) { this.dirty = true; return; }
    this.changed();
  }
  update(update: DesktopUpdate): void {
    if (update.type === "terminal") { this.inspector.update(update); return; }
    if (update.type === "state") {
      this.status = update;
      if (update.state !== "online") { ++this.defaultModelRead; this.defaultModelKnown = false; }
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
      this.defaultModelKnown = true;
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
      if (this.target === "code" && body.type === "model.config_changed") void this.refreshDefaultModel();
      if (this.target === "code" && (body.type === "session.created" || body.type === "session.workspace_mapped" || body.type === "project.created" || body.type === "task.queued")) void this.loadSummaries();
      if (body.type === "session.created") void this.reconcileCreation();
      if (body.type === "task.output_entry" && (this.tabs.includes(body.sessionId) || this.inspector.childSessionId === body.sessionId)) void this.loadEntry(body.sessionId, body.entryId, body.taskId);
      this.inspector.update(update);
    }
    if (update.type === "navigate") this.navigate(update);
    if (this.target === "code") this.search.update(update);
    this.context.update(update);
    this.approvals.update(update);
    this.writes.update(update);
    this.mark();
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
  private async refreshDefaultModel(): Promise<void> {
    this.defaultModelKnown = false;
    const generation = this.generation, read = ++this.defaultModelRead;
    try {
      const config = await this.request("get_model_config", {});
      if (generation !== this.generation || read !== this.defaultModelRead || this.status.state !== "online") return;
      const selection = config.runtimeDefault;
      const model = config.models.find(model => model.provider === selection.provider && model.modelId === selection.modelId);
      this.view.defaultModel = { provider: selection.provider, id: selection.modelId, name: model?.name ?? selection.modelId, thinkingLevel: selection.thinkingLevel };
      this.defaultModelKnown = true;
      this.mark();
    } catch { if (generation === this.generation && read === this.defaultModelRead) this.report("后台默认模型刷新失败，请重新连接核实后再创建会话。"); }
  }
  newChatSelection(explicit: ModelSelection | null): ModelSelection | null {
    if (explicit) return explicit;
    if (!this.defaultModelKnown) return null;
    const { provider, id: modelId, thinkingLevel } = this.view.defaultModel;
    const option = this.writes.models.find(model => model.available && model.provider === provider && model.modelId === modelId);
    const level = option?.thinkingLevels.find(level => level === thinkingLevel);
    return level ? { provider, modelId, thinkingLevel: level } : null;
  }
  /** 工作区树只列未存档的普通会话；存档只影响这份列表，历史与任务仍按会话 id 读取。 */
  sessionsFor(workspaceId: string): Session[] {
    return this.view.sessions.filter(session => sessionDisplayAttribution(session, this.view.projects).projectId === workspaceId && !this.view.subAgentSessionIds.includes(session.id) && !this.view.roleSessionIds.includes(session.id) && session.kind === "dev" && session.archivedAt === null);
  }
  /** 设置页的已存档会话：同一批普通开发会话，只看存档状态。 */
  archivedSessions(): Session[] {
    return this.view.sessions.filter(session => session.archivedAt !== null && session.kind === "dev" && !this.view.subAgentSessionIds.includes(session.id) && !this.view.roleSessionIds.includes(session.id)).sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  }
  /** 存档或取消存档；失败按既有设置写入的提示呈现。 */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await this.writes.setArchived(sessionId, archived);
    // 存档的会话不该留在打开的标签里，否则列表与标签互相矛盾。
    if (archived && this.tabs.includes(sessionId)) this.closeSession(sessionId);
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
    this.mark();
  }
  closeSession(id: string): void {
    this.inspector.closeParent(id);
    this.rememberCreationSource();
    const index = this.tabs.indexOf(id);
    this.tabs = this.tabs.filter(tab => tab !== id);
    if (this.view.currentSessionId === id) this.view.currentSessionId = this.tabs[Math.max(0, index - 1)] ?? null;
    this.rememberCreationSource();
    if (this.view.currentSessionId) this.inspector.openParent(this.view.currentSessionId);
    this.mark();
  }
  private creationSource(): Session | undefined {
    const eligible = (session: Session) => this.target === "code" && session.kind === "dev" && !this.view.subAgentSessionIds.includes(session.id) && !this.view.roleSessionIds.includes(session.id);
    return this.view.sessions.find(session => session.id === this.view.currentSessionId && eligible(session)) ?? this.view.sessions.find(session => session.id === this.creationSourceId && eligible(session));
  }
  private rememberCreationSource(): void {
    const source = this.creationSource();
    if (source) this.creationSourceId = source.id;
  }
  private report(text: string): void { this.message = text; this.mark(); }
  private run(key: string, action: (generation: number) => Promise<void>): Promise<void> {
    key = `${this.generation}:${key}`;
    const pending = this.requests.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const request = action(generation).catch(error => {
      if (generation === this.generation) this.readError = `读取会话失败：${error instanceof Error ? error.message : "请重新连接后再试。"}`;
    }).finally(() => { this.requests.delete(key); this.inspector.seedTabs(); void this.inspector.loadDiff(); this.mark(); });
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
      // 有界快照只带近期任务；旧任务状态晚到会让历史页首次渲染把已完成 trace 当成展开态再收起。
      // 状态读取失败时仍先装历史页，保持原先「历史可见、错误报到 readError」的降级。
      // Note: 见 .agents/notes/implemented/bug-fix/2026-10-19-trace-hydration-flash.md
      let relevant: Set<string> | null = null;
      await this.settle(async () => {
        relevant = await this.restoreTaskStatuses(sessionId, page.entries, generation).catch(error => {
          this.view.installHistoryPage(sessionId, page, mode);
          throw error;
        });
        if (!relevant) return;
        this.view.installHistoryPage(sessionId, page, mode);
        this.mark();
        await this.restoreEventFlow(sessionId, generation, relevant);
      });
    });
  }
  /** 装入历史窗口内任务的状态，返回需要补读事件流与工具详情的任务；代次变化时返回 null。 */
  private async restoreTaskStatuses(sessionId: string, entries: HistoryEntryView[], generation: number): Promise<Set<string> | null> {
    const earliest = entries.reduce((at, entry) => !at || entry.timestamp < at ? entry.timestamp : at, "");
    const ids = new Set(entries.map(entry => entry.entryId));
    const relevant = new Set<string>();
    let before: string | undefined;
    do {
      const page = await this.request("list_tasks", { session_id: sessionId, before, limit: 50 });
      if (generation !== this.generation) return null;
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
    return relevant;
  }
  private async restoreEventFlow(sessionId: string, generation: number, relevant: Set<string>): Promise<void> {
    await Promise.all([...relevant].map(taskId => this.readTaskFlow(taskId)));
    if (generation !== this.generation) return;
    for (const entry of this.view.openSession(sessionId).flow.historyEntries) {
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
        this.mark();
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
  // Note: 见 .agents/notes/implemented/bug-fix/2026-10-19-trace-hydration-flash.md
  historyReady(sessionId: string, taskId: string): boolean { return ![...this.pendingEntries].some(([key, pendingTask]) => key.startsWith(`${sessionId}:`) && pendingTask === taskId); }
  loadEntry(sessionId: string, entryId: string, taskId?: string): Promise<void> {
    const key = `${sessionId}:${entryId}`;
    // 已在历史页里的条目只会补全正文，身份已可见；再挡自动收起会让打开会话时已收起的 trace 先展开再收起。
    const known = this.view.openSession(sessionId).flow.historyEntries.some(entry => entry.entryId === entryId);
    if (!known) this.pendingEntries.set(key, taskId ?? this.pendingEntries.get(key));
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

  // Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-new-chat.md
  /** 新对话在首条消息落地时才建会话：按所选工作区与草稿设置建好后把草稿交给它发送。 */
  async startChat(input: { workspaceId: string; text: string; attachments: DesktopAttachment[]; mode: SessionDefaultMode; modelSelection: ModelSelection | null }, upload: (sessionId: string, tokens: string[]) => Promise<DesktopAttachment[]>): Promise<string | null> {
    if (!input.text.trim() && !input.attachments.length) return null;
    if (!input.modelSelection) { this.report("请选择模型后再发送。"); return null; }
    const workspace = this.view.projects.find(project => project.id === input.workspaceId && project.rootDir !== null);
    if (!workspace?.rootDir) { this.report("所选工作区已不可用，请重新选择。"); return null; }
    // create() 在途时不另发请求：先拒绝，免得把草稿交给正在核实的另一个会话。
    if (this.pendingCreation) { this.report("上一个创建仍在核实，请稍后再发送。"); return null; }
    if (!await this.create("create_session", { project_id: workspace.id, cwd: workspace.rootDir.cwdReal }, { mode: input.mode, modelSelection: input.modelSelection })) return null;
    const sessionId = this.view.currentSessionId;
    if (!sessionId) return null;
    // 附件按草稿登记的 token 现在才上传：上传需要会话身份，失败时不发送。
    let attachments: DesktopAttachment[] = [];
    if (input.attachments.length) {
      try { attachments = await upload(sessionId, input.attachments.map(item => item.id)); }
      catch (error) { this.report(error instanceof Error ? error.message : "附件未能上传，请重新选择。"); return null; }
    }
    this.writes.edit(sessionId, input.text);
    if (attachments.length) this.writes.draft(sessionId).attachments = attachments;
    void this.writes.send(sessionId);
    return sessionId;
  }

  async create(op: PendingCreation["op"], params: { cwd: string; project_id?: string }, settingsOverride?: { mode: SessionDefaultMode; modelSelection: ModelSelection | null }): Promise<boolean> {
    if (this.pendingCreation) return this.reconcileCreation();
    if (!this.view.instanceId || this.status.state !== "online") { this.report("请等待连接恢复后再创建会话。"); return false; }
    const source = this.creationSource();
    if (source && this.writes.settingsPending(source.id)) { this.report("会话设置仍在保存或等待核实，请确认后台实际设置后再创建会话。"); return false; }
    const settings = settingsOverride ? { mode: settingsOverride.mode, ...(settingsOverride.modelSelection ? { model_selection: { ...settingsOverride.modelSelection } } : {}) } : source ? { mode: source.defaultAccessMode, ...(source.modelSelection ? { model_selection: { ...source.modelSelection } } : {}) } : {};
    const pending: PendingCreation = { op, params: { ...params, ...settings, request_id: crypto.randomUUID() }, target: this.target, instanceId: this.view.instanceId, busy: false, retried: false, waitGeneration: null };
    this.pendingCreation = pending;
    this.message = null;
    this.mark();
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
    this.mark();
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
