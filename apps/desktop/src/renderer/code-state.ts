// Note: See .agents/notes/implemented/feature/2026-10-17-session-creation-settings.md
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";

import type { ModelSelection, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { HistoryRecovery } from "@ruukoto/view/history-recovery.ts";
import type { DesktopOp } from "../main/ipc.ts";
import type { DesktopAttachment, DesktopBridge, DesktopChatCreation, DesktopChatDraft, DesktopFailure, DesktopTarget, DesktopUpdate } from "../shared/bridge.ts";
import { DesktopApprovals } from "./approvals.ts";
import { DesktopBackgroundProcesses } from "./background-processes.ts";
import { DesktopQuestions } from "./owner-questions.ts";
import { CodeWrites } from "./code-writes.ts";
import { DesktopContext } from "./context-state.ts";
import { DesktopInspector } from "./inspector.ts";
import { DesktopSearch } from "./search-state.ts";
import { NativeBrowserState } from "./native-browser.ts";
import { DesktopScheduled } from "./scheduled-state.ts";
import { DesktopCompactions } from "./compaction-state.ts";

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
  taskId?: string;
  name?: string;
  requestId: string;
  target: DesktopTarget;
  instanceId: string;
  busy: boolean;
  retried: boolean;
  waitGeneration: number | null;
}

// Note: See .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class CodeState {
  readonly view = new ViewState();
  readonly summaries = new Map<string, OpResult<"list_session_summaries">>();
  tabs: string[] = [];
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "connecting" };
  message: string | null = null;
  readError: string | null = null;
  pendingCreation: PendingCreation | null = null;
  pendingBranch: PendingBranch | null = null;
  recoveredChats: DesktopChatDraft[] = [];
  chatNotCreated = false;
  private startingChat: { requestId: string; instanceId: string } | null = null;
  private chatBusy = false;
  defaultModelKnown = false;
  private generation = 0;
  private questionRead = 0;
  private defaultModelRead = 0;
  /** Accumulated changes within a restore window draw once: intermediate projections would paint collapsed traces as expanded. */
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
  readonly compactions: DesktopCompactions;
  readonly search: DesktopSearch;
  readonly scheduled: DesktopScheduled;
  navigation: Extract<DesktopUpdate, { type: "navigate" }> | null = null;
  notificationSelection: { sessionId: string; taskId: string } | null = null;
  refresh(): void { this.mark(); }
  // Note: See .agents/notes/implemented/feature/2026-10-20-desktop-creation-spinner.md
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly changed: () => void, readonly target: DesktopTarget = "code") {
    this.compactions = new DesktopCompactions(bridge, this.view, () => this.status.state === "online", changed);
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
      changed: () => this.mark(), entryFailed: error => { this.readError = `Couldn't load the chat: ${error instanceof Error ? error.message : "Reconnect and try again."}`; },
    });
  }

  private async request<K extends DesktopOp>(op: K, params: OpParams<K>): Promise<OpResult<K>> {
    const result = await this.bridge.request(this.target, op, params);
    if (!result.ok) throw new DesktopRequestError(result.error);
    // Preload responses are IPC wire data; the main process only forwards same-repo control-plane returns.
    return result.value as OpResult<K>;
  }
  /** Merge redraws during restore; only hand the final projection to the UI when the outermost finishes. */
  private settle<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    ++this.quiet;
    return action().finally(() => {
      if (generation !== this.generation || --this.quiet > 0 || !this.dirty) return;
      this.dirty = false;
      this.changed();
    });
  }
  /** Within a restore window only record the need to redraw; emit once when the window closes. */
  private mark(): void {
    if (this.quiet > 0) { this.dirty = true; return; }
    this.changed();
  }
  update(update: DesktopUpdate): void {
    if (update.type === "terminal") { this.inspector.update(update); return; }
    if (update.type === "browser_event") { this.browser.update(update); this.mark(); return; }
    if (update.type === "chat_drafts") {
      this.recoveredChats = update.drafts.filter(draft => draft.instanceId === this.view.instanceId);
      for (const draft of this.recoveredChats) {
        if (draft.sessionId && draft.uploadedAttachments && this.view.sessions.some(session => session.id === draft.sessionId) && !this.writes.checking(draft.sessionId)) this.writes.installFirstChat(draft.sessionId, draft.text, draft.uploadedAttachments, draft.submissionRequestId, draft.requestId, draft.mode, draft.modelSelection, true);
      }
      if (update.error) this.message = update.error;
    } else if (update.type === "state") {
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
        this.recoveredChats = [];
        // A branch in the old instance can't be verified in the new one — stop resending along the original key.
        if (this.pendingBranch) { this.pendingBranch = null; this.message = "Branch outcome unknown: the data instance changed. Check the original instance's chat list."; }
      }
      this.tabs = this.tabs.filter(id => this.view.sessions.some(session => session.id === id));
      void this.loadSummaries();
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
      if (body.type === "model.config_changed") void this.refreshDefaultModel();
      if ((body.type === "session.created" || body.type === "project.created" || body.type === "task.queued")) void this.loadSummaries();
      if (body.type === "session.created") { void this.reconcileCreation(); void this.reconcileBranch(); }
      if (body.type === "task.output_entry" && (this.tabs.includes(body.sessionId) || this.inspector.childSessionId === body.sessionId)) void this.loadEntry(body.sessionId, body.entryId, body.taskId);
      this.inspector.update(update);
    }
    if (update.type === "navigate") this.navigate(update);
    this.search.update(update);
    this.compactions.update(update);
    this.context.update(update);
    this.approvals.update(update);
    this.writes.update(update);
    this.questions.update(update);
    this.background.update(update);
    this.scheduled.update(update);
    this.mark();
  }
  private navigate(update: Extract<DesktopUpdate, { type: "navigate" }>): void {
    this.navigation = update;
    if (!this.view.instanceId) return;
    if (update.instanceId !== this.view.instanceId) { this.navigation = null; this.message = "The notification's original target changed. Check the original instance."; return; }
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
    } catch { if (generation === this.generation && read === this.defaultModelRead) this.report("Backend default model refresh failed. Reconnect to verify before creating a chat."); }
  }
  newChatSelection(explicit: ModelSelection | null): ModelSelection | null {
    if (explicit) return explicit;
    if (!this.defaultModelKnown) return null;
    const { provider, id: modelId, thinkingLevel } = this.view.defaultModel;
    const option = this.writes.models.find(model => model.available && model.provider === provider && model.modelId === modelId);
    const level = option?.thinkingLevels.find(level => level === thinkingLevel);
    return level ? { provider, modelId, thinkingLevel: level } : null;
  }
  /** The workspace tree lists only unarchived ordinary chats; archiving affects only this list — history and tasks still read by session id. */
  sessionsFor(workspaceId: string): Session[] {
    return this.view.sessions.filter(session => session.projectId === workspaceId && !this.view.subAgentSessionIds.includes(session.id) && session.kind === "dev" && session.archivedAt === null);
  }
  managedSessions(): Session[] {
    return this.view.projects.filter(project => project.managed).flatMap(project => this.sessionsFor(project.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  workspaceName(workspaceId: string): string {
    const workspace = this.view.projects.find(project => project.id === workspaceId);
    return workspace?.managed ? "No workspace" : workspace?.name ?? "Unknown workspace";
  }
  async revealWorkspace(workspaceId: string): Promise<void> {
    const result = await this.bridge.request(this.target, "desktop_workspace_path", { workspace_id: workspaceId, instance_id: this.view.instanceId });
    if (!result.ok) { this.report(result.error.message); return; }
    const folder = result.value as { path: string };
    try {
      const revealed = await window.ruukoto.reveal(folder.path);
      if (!revealed.ok) this.report(revealed.error.message);
    } catch { this.report("Couldn't open the folder. Reopen the app and try again."); }
  }
  /** The settings page's archived chats: the same ordinary dev chats, filtered by archive state. */
  archivedSessions(): Session[] {
    return this.view.sessions.filter(session => session.archivedAt !== null && session.kind === "dev" && !this.view.subAgentSessionIds.includes(session.id)).sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  }
  /** Archive or unarchive; failures surface through the existing settings-write notice. */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await this.writes.setArchived(sessionId, archived);
    // An archived chat must not stay in open tabs, or the list and tabs contradict each other.
    if (archived && this.tabs.includes(sessionId)) this.closeSession(sessionId);
  }
  sessionName(id: string): string {
    for (const summaries of this.summaries.values()) {
      const summary = summaries.find(item => item.sessionId === id);
      if (summary?.name) return summary.name;
    }
    return this.view.sessions.find(session => session.id === id)?.name ?? "New chat";
  }
  sessionNeedsDecision(id: string): boolean {
    return this.view.pendingApprovals().some(item => item.sessionId === id) || this.view.ownerQuestions.some(item => item.sessionId === id && item.status === "pending");
  }
  private async loadOwnerQuestions(): Promise<void> {
    const sessionId = this.view.currentSessionId, instanceId = this.view.instanceId, generation = this.generation, read = ++this.questionRead;
    if (!sessionId || !instanceId) return;
    const current = () => read === this.questionRead && generation === this.generation && sessionId === this.view.currentSessionId && instanceId === this.view.instanceId;
    let result: OpResult<"owner_questions">;
    try { result = await this.request("owner_questions", { session_id: sessionId }); }
    catch (error) { if (current()) { this.questions.message = `Owner question query failed: ${(error as Error).message} Select the chat again to query.`; this.mark(); } return; }
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
    const eligible = (session: Session) => session.kind === "dev" && !this.view.subAgentSessionIds.includes(session.id);
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
      if (generation === this.generation) this.readError = `Couldn't load the chat: ${error instanceof Error ? error.message : "Reconnect and try again."}`;
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
      // The bounded snapshot only carries recent tasks; late task state makes the first history render treat completed traces as expanded then collapse them.
      // On state-read failure still load the history page first, keeping the original "history visible, errors reported to readError" degradation.
      // Note: See .agents/notes/implemented/bug-fix/2026-10-19-trace-hydration-flash.md
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

  // Note: See .agents/notes/implemented/feature/2026-10-20-desktop-new-chat.md
  // Note: See .agents/notes/implemented/feature/2026-11-07-managed-coding-workspaces.md
  /** The native journal retains the first-send identity through creation and upload failures. */
  async startChat(input: { requestId?: string; workspaceId: string; text: string; attachments: DesktopAttachment[]; mode: SessionDefaultMode; modelSelection: ModelSelection | null }, upload: (sessionId: string, tokens: string[]) => Promise<DesktopAttachment[]>, ownsDraft: () => boolean = () => true): Promise<string | null> {
    if (!input.text.trim() && !input.attachments.length) return null;
    if (!input.modelSelection) { this.report("Select a model before sending."); return null; }
    const workspace = this.view.projects.find(project => project.id === input.workspaceId && project.rootDir !== null && !project.managed);
    if (input.workspaceId && !workspace?.rootDir) { this.report("The selected workspace is unavailable. Select another one."); return null; }
    if (this.pendingCreation) { this.report("The previous creation is still being verified. Send again later."); return null; }
    if (this.pendingBranch) { this.report("A branch is being created. Send again later."); return null; }
    if (this.chatBusy || !this.view.instanceId || this.status.state !== "online") return null;
    const requestId = input.requestId ?? this.startingChat?.requestId ?? crypto.randomUUID();
    const instanceId = this.startingChat?.requestId === requestId ? this.startingChat.instanceId : this.view.instanceId;
    if (instanceId !== this.view.instanceId) { this.report("The first message belongs to the original data instance. Reconnect to it and retry."); return null; }
    this.startingChat = { requestId, instanceId };
    this.chatBusy = true;
    this.chatNotCreated = false;
    let created: DesktopChatCreation;
    try {
      const result = await this.bridge.request(this.target, "desktop_chat_start", { request_id: requestId, workspace_id: input.workspaceId, text: input.text, tokens: input.attachments.map(item => item.id), mode: input.mode, model_selection: input.modelSelection });
      if (!result.ok) throw new DesktopRequestError(result.error);
      created = result.value as DesktopChatCreation;
    } catch (error) {
      this.chatBusy = false;
      this.chatNotCreated = error instanceof DesktopRequestError && error.code === "chat_not_created";
      if (this.chatNotCreated) this.startingChat = null;
      this.report(error instanceof Error ? error.message : "First-message creation unverified. Restore the connection and retry.");
      return null;
    }
    if (instanceId !== this.view.instanceId) { this.chatBusy = false; this.report("The first message belongs to the original data instance. Reconnect to it and retry."); return null; }
    const { session, project, draft } = created;
    if (!this.view.projects.some(item => item.id === project.id)) this.view.projects.push(project);
    if (!this.view.sessions.some(item => item.id === session.id)) this.view.sessions.push(session);
    this.recoveredChats = [...this.recoveredChats.filter(item => item.requestId !== requestId), draft];
    if (!ownsDraft()) { this.chatBusy = false; this.startingChat = null; this.mark(); return null; }
    let attachments = draft.uploadedAttachments;
    if (!attachments) {
      try { attachments = await upload(session.id, input.attachments.map(item => item.id)); }
      catch (error) { this.chatBusy = false; this.report(error instanceof Error ? error.message : "The attachment couldn't upload. Try again."); return null; }
    }
    this.chatBusy = false;
    if (instanceId !== this.view.instanceId) { this.report("The first message belongs to the original data instance. Reconnect to it and retry."); return null; }
    if (!ownsDraft()) { this.startingChat = null; this.mark(); return null; }
    this.writes.installFirstChat(session.id, draft.text, attachments, draft.submissionRequestId, requestId, draft.mode, draft.modelSelection);
    this.startingChat = null;
    this.openSession(session.id);
    void this.writes.send(session.id);
    return session.id;
  }
  async pendingChat(sessionId: string): Promise<DesktopChatDraft | undefined> {
    const existing = this.recoveredChats.find(draft => draft.sessionId === sessionId);
    if (existing) return existing;
    const response = await this.bridge.request(this.target, "desktop_chat_drafts", {});
    if (!response.ok) { this.report(response.error.message); return; }
    this.recoveredChats = (response.value as DesktopChatDraft[]).filter(draft => draft.instanceId === this.view.instanceId);
    return this.recoveredChats.find(draft => draft.sessionId === sessionId);
  }
  resumePreparedChat(draft: DesktopChatDraft): boolean {
    if (!draft.sessionId || !draft.uploadedAttachments || this.writes.checking(draft.sessionId)) return false;
    this.writes.installFirstChat(draft.sessionId, draft.text, draft.uploadedAttachments, draft.submissionRequestId, draft.requestId, draft.mode, draft.modelSelection, true);
    this.openSession(draft.sessionId);
    return true;
  }

  // Note: See .agents/notes/implemented/feature/2026-10-28-desktop-message-actions.md
  /** Branch from persisted history or a completed task; reconcile a lost response with its original key. */
  async branch(sessionId: string, taskId?: string, name?: string): Promise<boolean> {
    if (this.pendingCreation) { this.report("Chat creation is still being verified. Branch again later."); return false; }
    if (this.pendingBranch) {
      if (this.pendingBranch.sessionId === sessionId && this.pendingBranch.taskId === taskId && this.pendingBranch.name === name) {
        // An explicit retry keeps the original source, name and request key.
        this.pendingBranch.retried = false;
        this.pendingBranch.waitGeneration = null;
        return this.reconcileBranch();
      }
      this.report("Another branch operation is still running. Try again later.");
      return false;
    }
    if (!this.view.instanceId || this.status.state !== "online") { this.report("Wait for the connection to recover before branching."); return false; }
    const session = this.view.sessions.find(item => item.id === sessionId);
    const task = taskId ? this.view.tasks.get(taskId) : undefined;
    if (!session || taskId && (task?.status !== "completed" || (task.sessionId !== sessionId && !session.branchSource?.taskIds.includes(taskId)))) { this.report("The task isn't finished or doesn't belong to this chat; can't branch."); return false; }
    if (this.writes.settingsPending(sessionId)) { this.report("Chat settings are still saving or unverified. Confirm the actual backend settings before branching."); return false; }
    const pending: PendingBranch = { sessionId, taskId, name, requestId: crypto.randomUUID(), target: this.target, instanceId: this.view.instanceId, busy: false, retried: false, waitGeneration: null };
    this.pendingBranch = pending;
    this.message = null;
    this.mark();
    return this.sendBranch(pending);
  }
  private ownsBranch(pending: PendingBranch): boolean {
    if (pending.target === this.target && pending.instanceId === this.view.instanceId) return true;
    this.report("The original branch outcome is still unknown; reconnect to the original data instance and check the left workspace tree. This instance won't resend the original operation.");
    return false;
  }
  private completeBranch(pending: PendingBranch, session: Session): boolean {
    if (!this.ownsBranch(pending)) return false;
    if (!this.view.sessions.some(item => item.id === session.id)) this.view.sessions.push(session);
    this.pendingBranch = null;
    this.message = `Branched: ${session.name ?? "New chat"}`;
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
    if (pending.retried) { this.report("Branch outcome unknown; check the left workspace tree for whether the chat was created, and verify once connected."); return false; }
    pending.retried = true;
    return this.sendBranch(pending);
  }
  private async sendBranch(pending: PendingBranch): Promise<boolean> {
    if (!this.ownsBranch(pending)) return false;
    pending.busy = true;
    this.mark();
    const generation = this.generation;
    let session: Session;
    try { session = await this.request("branch_session", { session_id: pending.sessionId, ...(pending.taskId ? { task_id: pending.taskId } : {}), ...(pending.name !== undefined ? { name: pending.name } : {}), request_id: pending.requestId }); }
    catch (error) {
      pending.busy = false;
      if (!this.ownsBranch(pending)) return false;
      if (error instanceof DesktopRequestError && error.failure.outcome === "rejected") {
        try {
          const found = await this.request("find_branch_session", { request_id: pending.requestId });
          if (found.session) return this.completeBranch(pending, found.session);
          if (found.status === "failed") {
            this.pendingBranch = null;
            this.report(`Branch failed: ${found.error ?? error.message}`);
            return false;
          }
          if (found.status === "not_found") {
            this.pendingBranch = null;
            this.report(`Branch failed: ${error.message}`);
            return false;
          }
          this.report(`Branch not yet published${found.error ? `: ${found.error}` : ""}; click the branch button again to retry along the original request.`);
          return false;
        } catch {
          this.report("Branch outcome unverified; it will be verified along the original operation once connected. Check the left workspace tree.");
          return false;
        }
      }
      if (error instanceof DesktopRequestError && error.failure.outcome === "unknown") return this.reconcileBranch();
      pending.waitGeneration = generation;
      this.report("Branch outcome unverified; it will be verified along the original operation once connected. Check the left workspace tree.");
      if (this.generation > generation) return this.reconcileBranch();
      return false;
    }
    pending.busy = false;
    return this.completeBranch(pending, session);
  }

  async create(op: PendingCreation["op"], params: { cwd: string; project_id?: string }, settingsOverride?: { mode: SessionDefaultMode; modelSelection: ModelSelection | null }): Promise<boolean> {
    if (this.pendingCreation) return this.reconcileCreation();
    if (this.pendingBranch) { this.report("A branch is being created. Create a chat again later."); return false; }
    if (!this.view.instanceId || this.status.state !== "online") { this.report("Wait for the connection to recover before creating a chat."); return false; }
    const source = this.creationSource();
    if (source && this.writes.settingsPending(source.id)) { this.report("Chat settings are still saving or unverified. Confirm the actual backend settings before creating a chat."); return false; }
    const settings = settingsOverride ? { mode: settingsOverride.mode, ...(settingsOverride.modelSelection ? { model_selection: { ...settingsOverride.modelSelection } } : {}) } : source ? { mode: source.defaultAccessMode, ...(source.modelSelection ? { model_selection: { ...source.modelSelection } } : {}) } : {};
    const pending: PendingCreation = { op, params: { ...params, ...settings, request_id: crypto.randomUUID() }, target: this.target, instanceId: this.view.instanceId, busy: false, retried: false, waitGeneration: null };
    this.pendingCreation = pending;
    this.message = null;
    this.mark();
    return this.sendCreation(pending);
  }
  private owns(pending: PendingCreation): boolean {
    if (pending.target === this.target && pending.instanceId === this.view.instanceId) return true;
    this.report("The original operation outcome is still unknown; reconnect to the original data instance and check the left workspace tree. This instance won't resend it.");
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
    if (pending.retried) { this.report("Create outcome unknown; check the left workspace tree for whether the chat was created, and verify once connected."); return false; }
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
        this.report(`Chat creation failed: ${error.message}`);
        return false;
      }
      if (error instanceof DesktopRequestError && error.failure.outcome === "unknown") return this.reconcileCreation();
      pending.waitGeneration = generation;
      this.report("Create outcome unverified; it will be verified along the original operation once connected. Check the left workspace tree.");
      if (this.generation > generation) return this.reconcileCreation();
      return false;
    }
    pending.busy = false;
    return this.complete(pending, "session" in result ? result.session : result);
  }
}
