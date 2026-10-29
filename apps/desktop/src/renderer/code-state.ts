// Note: 见 .agents/notes/implemented/feature/2026-10-17-session-creation-settings.md
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { sessionDisplayAttribution } from "@ruukoto/control/session-attribution.ts";
import type { ModelSelection, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { HistoryRecovery } from "@ruukoto/view/history-recovery.ts";
import type { DesktopOp } from "../main/ipc.ts";
import type { DesktopAttachment, DesktopBridge, DesktopFailure, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import { DesktopApprovals } from "./approvals.ts";
import { DesktopBackgroundProcesses } from "./background-processes.ts";
import { DesktopQuestions } from "./owner-questions.ts";
import { CodeWrites } from "./code-writes.ts";
import { DesktopContext } from "./context-state.ts";
import { DesktopInspector } from "./inspector.ts";
import { DesktopSearch } from "./search-state.ts";
import { NativeBrowserState } from "./native-browser.ts";
import { DesktopScheduled } from "./scheduled-state.ts";

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
interface PendingBranch {
  sessionId: string;
  taskId: string;
  requestId: string;
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
  pendingBranch: PendingBranch | null = null;
  defaultModelKnown = false;
  private generation = 0;
  private questionRead = 0;
  private defaultModelRead = 0;
  /** 恢复窗口内累计的变更只画一次：中间投影会把已收起 trace 画成展开态。 */
  private quiet = 0;
  private dirty = false;
  private creationSourceId: string | null = null;
  private readonly history: HistoryRecovery;
  private readonly requests = new Map<string, Promise<void>>();
  readonly writes: CodeWrites;
  readonly approvals: DesktopApprovals;
  readonly questions: DesktopQuestions;
  readonly background: DesktopBackgroundProcesses;
  readonly inspector: DesktopInspector;
  readonly browser = new NativeBrowserState();
  readonly context: DesktopContext;
  readonly search: DesktopSearch;
  readonly scheduled: DesktopScheduled;
  navigation: Extract<DesktopUpdate, { type: "navigate" }> | null = null;
  notificationSelection: { sessionId: string; taskId: string } | null = null;
  refresh(): void { this.mark(); }
  // Note: 见 .agents/notes/implemented/feature/2026-10-20-desktop-creation-spinner.md
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly changed: () => void, readonly target: DesktopTarget = "code") {
    this.context = new DesktopContext(bridge, this.view, changed, target);
    this.approvals = new DesktopApprovals(bridge, this.view, changed, target);
    this.search = new DesktopSearch(bridge, changed);
    this.scheduled = new DesktopScheduled(bridge, this, changed);
    this.background = new DesktopBackgroundProcesses(bridge, this.view, () => this.status.state === "online", changed);
    this.questions = new DesktopQuestions(bridge, this.view, () => this.status.state === "online", changed);
    this.writes = new CodeWrites(bridge, this.view, () => this.status.state === "online", changed, target);
    this.inspector = new DesktopInspector(bridge, this.view, id => this.loadHistory(id), changed, target, this.background);
    this.history = new HistoryRecovery({
      state: this.view, request: (op, params) => this.request(op, params), entryPageBytes: 64 * 1024,
      completeEntry: () => true, isMissingEntry: error => error instanceof DesktopRequestError && error.code === "entry_not_found",
      changed: () => this.mark(), entryFailed: error => { this.readError = `读取会话失败：${error instanceof Error ? error.message : "请重新连接后再试。"}`; },
    });
  }

  private async request<K extends DesktopOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new DesktopRequestError(result.error);
    // preload 的响应是 IPC wire 数据，主进程只转发同仓控制面返回值。
    return result.value as OpResult<K>;
  }
  /** 恢复期间合并重绘；最外层结束后才把最终投影交给界面。 */
  private settle<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    ++this.quiet;
    return action().finally(() => {
      if (generation !== this.generation || --this.quiet > 0 || !this.dirty) return;
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
    if (update.type === "browser_event") { this.browser.update(update); this.mark(); return; }
    if (update.type === "state") {
      this.status = update;
      if (update.state !== "online") { ++this.defaultModelRead; this.defaultModelKnown = false; }
      this.inspector.update(update);
      if (update.state === "online") { void this.reconcileCreation(); void this.reconcileBranch(); void this.loadOwnerQuestions(); }
    } else if (update.type === "snapshot") {
      ++this.generation;
      this.requests.clear();
      this.history.reset();
      this.quiet = 0;
      this.dirty = false;
      this.summaries.clear();
      this.readError = null;
      const instanceChanged = update.instanceChanged || (this.view.instanceId !== null && this.view.instanceId !== update.result.snapshot.instanceId);
      this.view.applySnapshot(update.result, instanceChanged);
      this.defaultModelKnown = true;
      this.inspector.update({ ...update, instanceChanged });
      if (instanceChanged) {
        this.tabs = [];
        this.notificationSelection = null;
        this.creationSourceId = null;
        // 旧实例里的分支无法在新实例核实，不能继续按原键重发。
        if (this.pendingBranch) { this.pendingBranch = null; this.message = "分支结果未知：数据实例已改变，请查看原实例的会话列表。"; }
      }
      this.tabs = this.tabs.filter(id => this.view.sessions.some(session => session.id === id));
      if (this.target === "code") void this.loadSummaries();
      for (const id of this.tabs) void this.loadHistory(id);
      if (this.inspector.childSessionId) void this.loadHistory(this.inspector.childSessionId);
      if (this.navigation) this.navigate(this.navigation);
      void this.loadOwnerQuestions();
      void this.reconcileCreation();
      void this.reconcileBranch();
    } else if (update.type === "event") {
      this.view.applyEvent(update.event, update.kind);
      const body = update.event.body;
      if (body.type === "owner_question.changed" && body.question.sessionId === this.view.currentSessionId) void this.loadOwnerQuestions();
      if (this.target === "code" && body.type === "model.config_changed") void this.refreshDefaultModel();
      if (this.target === "code" && (body.type === "session.created" || body.type === "session.workspace_mapped" || body.type === "project.created" || body.type === "task.queued")) void this.loadSummaries();
      if (body.type === "session.created") { void this.reconcileCreation(); void this.reconcileBranch(); }
      if (body.type === "task.output_entry" && (this.tabs.includes(body.sessionId) || this.inspector.childSessionId === body.sessionId)) void this.loadEntry(body.sessionId, body.entryId, body.taskId);
      this.inspector.update(update);
    }
    if (update.type === "navigate") this.navigate(update);
    if (this.target === "code") this.search.update(update);
    this.context.update(update);
    this.approvals.update(update);
    this.writes.update(update);
    this.questions.update(update);
    this.background.update(update);
    if (this.target === "code") this.scheduled.update(update);
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
  private async loadOwnerQuestions(): Promise<void> {
    const sessionId = this.view.currentSessionId, instanceId = this.view.instanceId, generation = this.generation, read = ++this.questionRead;
    if (this.target !== "code" || !sessionId || !instanceId) return;
    const current = () => read === this.questionRead && generation === this.generation && sessionId === this.view.currentSessionId && instanceId === this.view.instanceId;
    let result: OpResult<"owner_questions">;
    try { result = await this.request("owner_questions", { session_id: sessionId }); }
    catch (error) { if (current()) { this.questions.message = `拥有者问题查询失败：${(error as Error).message}；请重新选择会话查询。`; this.mark(); } return; }
    if (!current()) return;
    const known = this.view.ownerQuestions.filter(question => question.sessionId === sessionId);
    const questions = result.questions.map(question => {
      const latest = known.find(item => item.id === question.id);
      return latest && latest.version > question.version ? latest : question;
    });
    questions.unshift(...known.filter(question => question.status === "pending" && !questions.some(item => item.id === question.id)));
    this.view.ownerQuestions = [...this.view.ownerQuestions.filter(question => question.sessionId !== sessionId), ...questions];
    this.mark();
  }
  openSession(id: string): void {
    void this.context.load(id);
    if (!this.tabs.includes(id)) this.tabs.push(id);
    this.view.currentSessionId = id;
    void this.loadOwnerQuestions();
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
    void this.loadOwnerQuestions();
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
    const request = this.read(action).finally(() => { this.requests.delete(key); });
    this.requests.set(key, request);
    return request;
  }
  private read(action: (generation: number) => Promise<void>): Promise<void> {
    const generation = this.generation;
    return action(generation).catch(error => {
      if (generation === this.generation) this.readError = `读取会话失败：${error instanceof Error ? error.message : "请重新连接后再试。"}`;
    }).finally(() => {
      if (generation !== this.generation) return;
      this.inspector.seedTabs(); void this.inspector.loadDiff(); this.mark();
    });
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
    const recoveryGeneration = this.history.generation;
    return this.run(`history:${sessionId}`, async generation => {
      const view = this.view.openSession(sessionId);
      if (mode === "prepend" && !view.historyCursor) return;
      const page = await this.request("read_history", { session_id: sessionId, before: mode === "prepend" ? view.historyCursor ?? undefined : undefined, limit: 50 });
      if (generation !== this.generation) return;
      const branchTaskIds = new Set(this.view.sessions.find(item => item.id === sessionId)?.branchSource?.taskIds ?? []);
      const branchTasks = [...new Set(page.entries.map(entry => entry.taskId).filter((taskId): taskId is string => !!taskId))].filter(taskId => branchTaskIds.has(taskId));
      // 有界快照只带近期任务；旧任务状态晚到会让历史页首次渲染把已完成 trace 当成展开态再收起。
      // 状态读取失败时仍先装历史页，保持原先「历史可见、错误报到 readError」的降级。
      // Note: 见 .agents/notes/implemented/bug-fix/2026-10-19-trace-hydration-flash.md
      let relevant: Set<string> | null = null;
      await this.settle(async () => {
        relevant = await this.history.readTasks(sessionId, page.entries, recoveryGeneration).catch(error => {
          if (generation === this.generation) this.view.installHistoryPage(sessionId, page, mode);
          throw error;
        });
        if (!relevant || generation !== this.generation) return;
        this.view.installHistoryPage(sessionId, page, mode);
        this.mark();
        if (generation !== this.generation) return;
        await Promise.all([
          ...[...relevant].map(taskId => this.read(() => this.history.restoreTask(taskId, recoveryGeneration))),
          ...branchTasks.map(taskId => this.read(() => this.history.restoreBranchTask(sessionId, taskId, recoveryGeneration))),
        ]);
        if (generation !== this.generation) return;
        for (const entry of this.view.openSession(sessionId).flow.historyEntries) {
          if (generation !== this.generation) return;
          if (entry.truncated) await this.history.loadEntry(sessionId, entry.entryId, recoveryGeneration, entry.taskId ?? undefined);
        }
      });
    });
  }
  historyReady(sessionId: string, taskId: string): boolean { return this.history.historyReady(sessionId, taskId); }
  loadEntry(sessionId: string, entryId: string, taskId?: string): Promise<void> {
    const generation = this.history.generation;
    return this.read(() => this.history.loadEntry(sessionId, entryId, generation, taskId));
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
    if (this.pendingBranch) { this.report("正在建立分支，请稍后再发送。"); return null; }
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

  // Note: 见 .agents/notes/implemented/feature/2026-10-28-desktop-message-actions.md
  /** 从已完成任务建立分支；应答丢失后按原请求键核实，不重复创建。 */
  async branch(sessionId: string, taskId: string): Promise<boolean> {
    if (this.pendingCreation) { this.report("会话创建仍在核实，请稍后再建立分支。"); return false; }
    if (this.pendingBranch) {
      if (this.pendingBranch.sessionId === sessionId && this.pendingBranch.taskId === taskId) {
        // 上次发布未完成时保留原键；用户再次点击即按原键重试。
        this.pendingBranch.retried = false;
        this.pendingBranch.waitGeneration = null;
        return this.reconcileBranch();
      }
      this.report("另一个分支操作仍在进行，请稍后重试。");
      return false;
    }
    if (!this.view.instanceId || this.status.state !== "online") { this.report("请等待连接恢复后再建立分支。"); return false; }
    const session = this.view.sessions.find(item => item.id === sessionId);
    const task = this.view.tasks.get(taskId);
    if (!session || task?.status !== "completed" || (task.sessionId !== sessionId && !session.branchSource?.taskIds.includes(taskId))) { this.report("任务尚未完成或不属于当前会话，无法建立分支。"); return false; }
    if (this.writes.settingsPending(sessionId)) { this.report("会话设置仍在保存或等待核实，请确认后台实际设置后再建立分支。"); return false; }
    const pending: PendingBranch = { sessionId, taskId, requestId: crypto.randomUUID(), target: this.target, instanceId: this.view.instanceId, busy: false, retried: false, waitGeneration: null };
    this.pendingBranch = pending;
    this.message = null;
    this.mark();
    return this.sendBranch(pending);
  }
  private ownsBranch(pending: PendingBranch): boolean {
    if (pending.target === this.target && pending.instanceId === this.view.instanceId) return true;
    this.report("原分支结果仍未知；请连回原数据实例后核实左栏工作区树。当前实例不会重发原操作。");
    return false;
  }
  private completeBranch(pending: PendingBranch, session: Session): boolean {
    if (!this.ownsBranch(pending)) return false;
    if (!this.view.sessions.some(item => item.id === session.id)) this.view.sessions.push(session);
    this.pendingBranch = null;
    this.message = `已建立分支：${session.name ?? "新会话"}`;
    this.openSession(session.id);
    void this.loadSummaries();
    return true;
  }
  private async reconcileBranch(): Promise<boolean> {
    const pending = this.pendingBranch;
    if (!pending || !this.ownsBranch(pending) || pending.busy) return false;
    if (pending.waitGeneration !== null && this.generation <= pending.waitGeneration) return false;
    const session = this.view.sessions.find(item => item.createRequestId === pending.requestId);
    if (session) return this.completeBranch(pending, session);
    if (this.status.state !== "online") return false;
    if (pending.retried) { this.report("分支结果未知；请在左栏工作区树查看会话是否已建好，恢复连接后继续核实。"); return false; }
    pending.retried = true;
    return this.sendBranch(pending);
  }
  private async sendBranch(pending: PendingBranch): Promise<boolean> {
    if (!this.ownsBranch(pending)) return false;
    pending.busy = true;
    this.mark();
    const generation = this.generation;
    let session: Session;
    try { session = await this.request("branch_session", { session_id: pending.sessionId, task_id: pending.taskId, request_id: pending.requestId }); }
    catch (error) {
      pending.busy = false;
      if (!this.ownsBranch(pending)) return false;
      if (error instanceof DesktopRequestError && error.failure.outcome === "rejected") {
        try {
          const found = await this.request("find_branch_session", { request_id: pending.requestId });
          if (found.session) return this.completeBranch(pending, found.session);
          if (found.status === "failed") {
            this.pendingBranch = null;
            this.report(`建立分支失败：${found.error ?? error.message}`);
            return false;
          }
          if (found.status === "not_found") {
            this.pendingBranch = null;
            this.report(`建立分支失败：${error.message}`);
            return false;
          }
          this.report(`分支尚未发布${found.error ? `：${found.error}` : ""}；再次点击分支按钮按原请求重试。`);
          return false;
        } catch {
          this.report("分支结果待核实；连接恢复后将按原操作核实，请查看左栏工作区树。");
          return false;
        }
      }
      if (error instanceof DesktopRequestError && error.failure.outcome === "unknown") return this.reconcileBranch();
      pending.waitGeneration = generation;
      this.report("分支结果待核实；连接恢复后将按原操作核实，请在左栏工作区树查看会话。");
      if (this.generation > generation) return this.reconcileBranch();
      return false;
    }
    pending.busy = false;
    return this.completeBranch(pending, session);
  }

  async create(op: PendingCreation["op"], params: { cwd: string; project_id?: string }, settingsOverride?: { mode: SessionDefaultMode; modelSelection: ModelSelection | null }): Promise<boolean> {
    if (this.pendingCreation) return this.reconcileCreation();
    if (this.pendingBranch) { this.report("正在建立分支，请稍后再创建会话。"); return false; }
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
