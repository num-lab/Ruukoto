import { browserAddress, browserNavigation, navigateBrowser, type BrowserNavigation } from "./browser-navigation.ts";
import { sessionDisplayAttribution } from "@ruukoto/control/session-attribution.ts";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopBridge, DesktopResult, DesktopTarget, DesktopUpdate, DesktopTerminalId, DesktopTerminalUpdate } from "../shared/bridge.ts";
import { canReadDiff, isDiffTool, type DiffTool } from "./diff.ts";
import { toolPage } from "./tool-page.ts";
import { FILE_PAGE_BYTES, readSnapshotFile, type PreviewFile, type ReadSnapshotState } from "./read-snapshot.ts";

interface DiffResult { entryId: string; field?: "text" | "patch" | "writeContent"; value?: OpResult<"read_tool_result">; error?: string; moreError?: string; nextOffset?: number; totalBytes?: number; loading?: boolean }
interface DiffSelection { sessionId: string; key: string; entryId: string | null }
interface ToolParams { loading: boolean; value?: Record<string, unknown>; error?: string }
interface GitState { value?: OpResult<"read_workspace_git">; error?: string; loading: boolean; loadingMore?: boolean; moreError?: string }
interface DirectoryState { value?: OpResult<"list_workspace_files">; error?: string; loading: boolean; loadingMore?: boolean; moreError?: string; cursors?: Set<string> }
function validDirectoryPage(page: OpResult<"list_workspace_files">, workspaceId: string, path: string, entries: OpResult<"list_workspace_files">["entries"], cursors: Set<string>): boolean {
  const paths = new Set(entries.map(entry => entry.path));
  return page.workspaceId === workspaceId && page.path === path && !(page.nextCursor && (cursors.has(page.nextCursor) || !page.entries.length)) && page.entries.every(entry => {
    if (paths.has(entry.path)) return false;
    paths.add(entry.path); return true;
  });
}
export type TerminalTab = { id: DesktopTerminalId; kind: "terminal"; title: string; workspaceId: string; cwd: string; instanceId: string; error?: string; exitCode?: number };
export type InspectorTab = TerminalTab | { id: string; kind: "read-snapshot"; title: string; path: string; sessionId: string; taskId: string; artifactId: string; mode: "preview" | "source" } | { id: string; kind: "git"; title: string; workspaceId: string } | { id: string; kind: "diff"; title: string; selection: DiffSelection } | { id: string; kind: "agent"; title: string; sessionId: string } | { id: string; kind: "new"; title: string } | { id: string; kind: "browser"; title: string; navigation: BrowserNavigation } | { id: string; kind: "files"; title: string; workspaceId: string } | { id: string; kind: "file"; title: string; workspaceId: string; path: string; mode: "preview" | "source" } | { id: string; kind: "background"; title: string };

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopInspector {
  tab: "agents" | "diff" = "agents";
  visible = false;
  private readonly tabsByParent = new Map<string, InspectorTab[]>();
  private readonly activeByParent = new Map<string, string>();
  private readonly results = new Map<string, NonNullable<DesktopInspector["result"]>>();
  private readonly toolResults = new Map<string, DiffResult>();
  private readonly params = new Map<string, ToolParams>();
  private online = true;
  private readonly terminalListeners = new Map<DesktopTerminalId, (update: DesktopTerminalUpdate) => void>();
  private readonly terminalWrites = new Map<DesktopTerminalId, Promise<void>>();
  readonly terminalStopFailures = new Map<DesktopTerminalId, { message: string; retrying: boolean }>();
  parentSessionId: string | null = null;
  childSessionId: string | null = null;
  workId: string | null = null;
  works: OpResult<"work_list">["works"] = [];
  detail: OpResult<"work_get"> | null = null;
  workError: string | null = null;
  loadingWorks = false;
  diff: DiffSelection | null = null;
  result: DiffResult | null = null;
  readonly directories = new Map<string, DirectoryState>();
  readonly files = new Map<string, { value?: PreviewFile; error?: string; loading: boolean }>();
  readonly repositories = new Map<string, GitState>();
  readonly folders = new Map<string, boolean>();
  readonly snapshots = new Map<string, ReadSnapshotState>();
  private readonly directoryRefreshes = new Map<string, Promise<void>>();
  private generation = 0;
  private workRead = 0;
  private detailRead = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly view: ViewState, private readonly history: (id: string) => Promise<void>, private readonly changed: () => void, readonly target: DesktopTarget = "code", private readonly background?: { sessionId: string | null; open(sessionId: string): void; close(): void }) {}

  private async request<K extends "work_list" | "work_get" | "read_tool_result" | "read_artifact" | "get_tool_op_params" | "list_workspace_files" | "read_workspace_file" | "read_workspace_git">(op: K, params: OpParams<K>): Promise<DesktopResult<OpResult<K>>> {
    let result;
    try { result = await this.bridge.request(this.target, op, params); }
    catch { return { ok: false, error: { code: "ipc_unavailable", outcome: "not_sent", message: "桌面连接不可用，请重新连接后再读取。" } }; }
    // 控制面响应经主进程转发，类型在 IPC wire 边界还原。
    return result as DesktopResult<OpResult<K>>;
  }

  update(update: DesktopUpdate): void {
    if (update.type === "terminal") { this.terminalListeners.get(update.id)?.(update); return; }
    if (update.type === "state") this.online = update.state === "online";
    if (update.type === "state" && !this.online) { ++this.generation; this.directories.clear(); this.files.clear(); this.repositories.clear(); this.snapshots.clear(); this.toolResults.clear(); this.params.clear(); this.results.clear(); this.result = null; return; }
    if (update.type === "snapshot") {
      ++this.generation;
      this.online = true; this.toolResults.clear(); this.params.clear();
      this.directories.clear(); this.files.clear(); this.repositories.clear(); this.snapshots.clear();
      this.works = []; this.detail = null; this.result = null; this.results.clear(); this.workError = null;
      if (update.instanceChanged || (this.parentSessionId && !this.view.sessions.some(session => session.id === this.parentSessionId))) {
        for (const tab of this.terminalTabs()) this.releaseTerminal(tab.id);
        this.parentSessionId = null; this.childSessionId = null; this.workId = null; this.diff = null; this.tabsByParent.clear(); this.activeByParent.clear(); this.folders.clear();
      }
      if (this.parentSessionId) void this.loadWorks();
      const active = this.activeTab();
      if (this.visible && active?.kind === "git") void this.loadGit(active.workspaceId);
    } else if (update.type === "event") {
      const body = update.event.body;
      if (body.type.startsWith("work_delegation.") || body.type.startsWith("subagent") || body.type === "task.queued" || body.type === "task.completed" || body.type === "task.failed" || body.type === "task.interrupted" || body.type === "task.canceled") {
        if (this.parentSessionId) void this.loadWorks();
      }
    }
    void this.loadDiff();
  }
  openParent(sessionId: string): void {
    if (this.parentSessionId === sessionId) return;
    // 后台状态只属于一个会话；换父会话时先清，活动标签若是后台页会立即重开新会话的状态。
    if (this.background?.sessionId) this.background.close();
    this.parentSessionId = sessionId; this.childSessionId = null; this.workId = null;
    this.works = []; this.detail = null; this.diff = null; this.result = null; this.workError = null;
    const active = this.activeTab();
    if (active) this.selectTab(active.id);
    void this.loadWorks();
  }
  tabs(): InspectorTab[] { return this.tabsByParent.get(this.parentSessionId ?? "") ?? []; }
  activeTab(): InspectorTab | undefined { return this.tabs().find(tab => tab.id === this.activeByParent.get(this.parentSessionId ?? "")) ?? this.tabs().at(-1); }
  private addTab(tab: InspectorTab): void {
    const parent = this.parentSessionId ?? "";
    const tabs = this.tabs();
    if (!tabs.some(item => item.id === tab.id)) {
      const active = this.activeTab();
      this.tabsByParent.set(parent, active?.kind === "new" ? tabs.map(item => item.id === active.id ? tab : item) : [...tabs, tab]);
    }
    this.visible = true;
    this.selectTab(tab.id);
  }
  selectTab(id: string): void {
    const tab = this.tabs().find(item => item.id === id);
    if (!tab) return;
    this.activeByParent.set(this.parentSessionId ?? "", id);
    this.childSessionId = null; this.diff = null; this.result = null;
    if (tab.kind === "diff") { this.tab = "diff"; this.diff = tab.selection; this.result = this.results.get(id) ?? null; void this.loadDiff(); }
    if (tab.kind === "git") void this.loadGit(tab.workspaceId);
    if (tab.kind === "files" && !this.directories.get(this.fileKey(tab.workspaceId, ""))?.loading) void this.loadDirectory(tab.workspaceId, "", true);
    if (tab.kind === "file") void this.loadFile(tab.workspaceId, tab.path);
    if (tab.kind === "read-snapshot") void this.loadReadSnapshot(tab);
    if (tab.kind === "background" && this.parentSessionId) this.background?.open(this.parentSessionId);
    if (tab.kind === "agent") { this.tab = "agents"; this.childSessionId = tab.sessionId; void this.history(tab.sessionId); }
    this.changed();
  }
  newTab(): void { this.addTab({ id: crypto.randomUUID(), kind: "new", title: "新标签" }); }
  closeTab(id: string): void {
    const tabs = this.tabs();
    const index = tabs.findIndex(tab => tab.id === id);
    const rest = tabs.filter(tab => tab.id !== id);
    this.results.delete(id);
    const closing = tabs.find(tab => tab.id === id);
    if (closing?.kind === "terminal") this.releaseTerminal(closing.id);
    if (closing?.kind === "file") this.files.delete(this.fileKey(closing.workspaceId, closing.path));
    if (closing?.kind === "read-snapshot") this.snapshots.delete(id);
    if (closing?.kind === "background") this.background?.close();
    if (!rest.length) rest.push({ id: crypto.randomUUID(), kind: "new", title: "新标签" });
    const active = this.activeTab();
    this.tabsByParent.set(this.parentSessionId ?? "", rest);
    if (active?.id === id) this.selectTab(rest[Math.max(0, index - 1)].id);
    else this.changed();
  }
  reorderTab(from: string, to: string): void {
    const tabs = this.tabs(), start = tabs.findIndex(tab => tab.id === from), end = tabs.findIndex(tab => tab.id === to);
    if (start < 0 || end < 0 || start === end) return;
    const active = this.activeTab();
    const next = [...tabs]; const [tab] = next.splice(start, 1); next.splice(end, 0, tab);
    this.tabsByParent.set(this.parentSessionId ?? "", next);
    if (active) this.activeByParent.set(this.parentSessionId ?? "", active.id);
    this.changed();
  }
  terminalTabs(): TerminalTab[] { return [...this.tabsByParent.values()].flat().filter((tab): tab is TerminalTab => tab.kind === "terminal"); }
  openTerminal(workspaceId = this.workspace()?.id): void {
    const workspace = this.view.projects.find(project => project.id === workspaceId);
    if (this.target !== "code" || !workspace?.rootDir || !this.view.instanceId) return;
    this.addTab({ id: crypto.randomUUID(), kind: "terminal", title: `终端 · ${workspace.name}`, workspaceId: workspace.id, cwd: workspace.rootDir.cwdReal, instanceId: this.view.instanceId });
  }
  listenTerminal(id: DesktopTerminalId, listener: (update: DesktopTerminalUpdate) => void): () => void {
    this.terminalListeners.set(id, listener);
    return () => { this.terminalListeners.delete(id); };
  }
  async startTerminal(tab: TerminalTab, cols: number, rows: number): Promise<boolean> {
    let result: DesktopResult<unknown>;
    try { result = await this.bridge.request("code", "desktop_terminal_open", { id: tab.id, workspace_id: tab.workspaceId, instance_id: tab.instanceId, cols, rows }); }
    catch { result = { ok: false, error: { code: "ipc_unavailable", outcome: "not_sent", message: "终端连接不可用，请关闭标签后重新打开应用。" } }; }
    if (!this.terminalTabs().includes(tab)) { if (result.ok) this.releaseTerminal(tab.id); return false; }
    if (!result.ok) { tab.error = result.error.message; this.changed(); return false; }
    return true;
  }
  sendTerminal(tab: TerminalTab, op: "desktop_terminal_input" | "desktop_terminal_resize", params: Record<string, unknown>): Promise<void> {
    const sending = (this.terminalWrites.get(tab.id) ?? Promise.resolve()).then(async () => {
      if (!this.terminalTabs().includes(tab) || tab.error || tab.exitCode !== undefined) return;
      let result: DesktopResult<unknown>;
      try { result = await this.bridge.request("code", op, { id: tab.id, ...params }); }
      catch { result = { ok: false, error: { code: "ipc_unavailable", outcome: "unknown", message: "终端输入或尺寸更新未能核实，请关闭标签后重新打开终端。" } }; }
      if (!result.ok && this.terminalTabs().includes(tab)) { tab.error = result.error.message; this.changed(); }
    });
    this.terminalWrites.set(tab.id, sending);
    void sending.then(() => { if (this.terminalWrites.get(tab.id) === sending) this.terminalWrites.delete(tab.id); });
    return sending;
  }
  private releaseTerminal(id: DesktopTerminalId): void {
    const failed = this.terminalStopFailures.get(id);
    if (failed) failed.retrying = true;
    void this.bridge.request("code", "desktop_terminal_kill", { id }).then(result => {
      if (result.ok) this.terminalStopFailures.delete(id);
      else this.terminalStopFailures.set(id, { message: result.error.message, retrying: false });
      this.changed();
    }).catch(() => { this.terminalStopFailures.set(id, { message: "终端回收无法核实，请在系统活动监视器中检查仍运行的命令。", retrying: false }); this.changed(); });
  }
  retryTerminalStop(id: DesktopTerminalId): void { this.releaseTerminal(id); this.changed(); }
  closeParent(sessionId: string): void {
    const tabs = this.tabsByParent.get(sessionId) ?? [];
    for (const tab of tabs) if (tab.kind === "terminal") this.releaseTerminal(tab.id);
    if (this.background?.sessionId === sessionId) this.background.close();
    this.tabsByParent.delete(sessionId); this.activeByParent.delete(sessionId);
  }
  openGit(): void {
    const workspace = this.workspace();
    if (workspace) this.addTab({ id: `git:${workspace.id}`, kind: "git", title: "Git graph", workspaceId: workspace.id });
  }
  async loadGit(workspaceId = this.workspace()?.id, retry = false): Promise<void> {
    if (this.target !== "code" || !this.online || !workspaceId) return;
    if (this.repositories.has(workspaceId) && !retry) return;
    const generation = this.generation;
    const state: GitState = { loading: true, value: this.repositories.get(workspaceId)?.value };
    this.repositories.set(workspaceId, state); this.changed();
    const result = await this.request("read_workspace_git", { workspace_id: workspaceId });
    if (generation !== this.generation || this.repositories.get(workspaceId) !== state) return;
    state.loading = false;
    if (result.ok && result.value.workspaceId === workspaceId) state.value = result.value;
    else state.error = result.ok ? "Git 仓库响应不属于此工作区，请重试。" : result.error.message;
    this.changed();
  }
  async loadMoreGit(workspaceId: string): Promise<void> {
    const state = this.repositories.get(workspaceId), repository = state?.value?.repository;
    const cursor = repository?.nextCursor;
    if (this.target !== "code" || !this.online || !state || !repository || !cursor || state.loading || state.loadingMore) return;
    const generation = this.generation;
    state.loadingMore = true; state.moreError = undefined; this.changed();
    const result = await this.request("read_workspace_git", { workspace_id: workspaceId, cursor });
    if (generation !== this.generation || this.repositories.get(workspaceId) !== state || state.value?.repository?.nextCursor !== cursor) return;
    state.loadingMore = false;
    if (!result.ok) state.moreError = `读取更早提交失败：${result.error.message}`;
    else {
      const page = result.value.repository, ids = new Set(repository.commits.map(commit => commit.id));
      if (result.value.workspaceId !== workspaceId || !page || page.head !== repository.head || page.nextCursor === cursor || page.commits.some(commit => ids.has(commit.id))) state.moreError = "Git 历史分页不一致，请刷新后继续浏览。";
      else state.value = { ...result.value, repository: { ...page, commits: [...repository.commits, ...page.commits] } };
    }
    this.changed();
  }
  workspace() {
    if (this.target !== "code") return undefined;
    const parent = this.view.sessions.find(session => session.id === this.parentSessionId);
    const id = parent ? sessionDisplayAttribution(parent, this.view.projects).projectId : null;
    return this.view.projects.find(project => project.id === id);
  }
  fileKey(workspaceId: string, path: string): string { return `${workspaceId}:${path}`; }
  private directoryExpanded(workspaceId: string, path: string): boolean {
    let current = path;
    while (current) {
      if (!this.folders.get(this.fileKey(workspaceId, current))) return false;
      const separator = current.lastIndexOf("/"); current = separator < 0 ? "" : current.slice(0, separator);
    }
    return true;
  }
  openFiles(): void {
    const workspace = this.workspace();
    if (this.target === "code" && workspace) this.addTab({ id: `files:${workspace.id}`, kind: "files", title: "文件树", workspaceId: workspace.id });
  }
  openBackground(): void {
    if (this.target !== "code" || !this.parentSessionId) return;
    this.addTab({ id: "background", kind: "background", title: "后台进程" });
  }
  openFile(workspaceId: string, path: string): void { if (this.target !== "code") return; this.addTab({ id: `file:${workspaceId}:${path}`, kind: "file", title: path.split("/").at(-1) ?? path, workspaceId, path, mode: "preview" }); }
  async openToolFile(sessionId: string, tool: DiffTool): Promise<boolean | null> {
    if (this.target !== "code") return false;
    const generation = this.generation, parent = this.parentSessionId;
    if (tool.paramsTruncated) await this.loadToolParams(sessionId, tool);
    if (generation !== this.generation || parent !== this.parentSessionId || !this.online) return null;
    const params = tool.paramsTruncated ? this.toolParams(sessionId, tool)?.value : tool.params;
    const source = this.view.sessions.find(session => session.id === sessionId);
    if (!source || typeof params?.path !== "string" || params.path.includes("\0")) return false;
    const segments: string[] = [];
    for (const part of (params.path.startsWith("/") ? params.path : `${source.cwdReal}/${params.path}`).split("/")) {
      if (part === "..") segments.pop(); else if (part && part !== ".") segments.push(part);
    }
    const absolute = `/${segments.join("/")}`;
    const workspace = this.view.projects.filter(project => project.rootDir && absolute.startsWith(`${project.rootDir.cwdReal.replace(/\/$/, "")}/`)).sort((a, b) => b.rootDir!.cwdReal.length - a.rootDir!.cwdReal.length)[0];
    if (!workspace) {
      if (tool.name !== "read" || tool.status !== "done" || !tool.taskId || tool.artifactIds.length !== 1) return false;
      this.addTab({ id: `read:${sessionId}:${tool.toolOpId ?? tool.entryId ?? tool.key}`, kind: "read-snapshot", title: absolute.split("/").at(-1) || "Read 快照", path: absolute, sessionId, taskId: tool.taskId, artifactId: tool.artifactIds[0], mode: "preview" });
      return true;
    }
    this.openFile(workspace.id, absolute.slice(workspace.rootDir!.cwdReal.replace(/\/$/, "").length + 1));
    return true;
  }
  openBrowser(address?: string): void {
    if (address && !browserAddress(address)) return;
    const existing = this.tabs().find(tab => tab.kind === "browser");
    if (existing?.kind === "browser" && address) existing.navigation = navigateBrowser(existing.navigation, address);
    this.addTab(existing ?? { id: "browser", kind: "browser", title: "浏览器", navigation: browserNavigation(address ? browserAddress(address)! : "about:blank") });
  }
  // Note: 见 .agents/notes/implemented/feature/2026-10-24-directory-pages-lazy-git.md
  async loadDirectory(workspaceId: string, path: string, retry = false, canContinue?: () => boolean): Promise<void> {
    if (this.target !== "code" || !this.online) return;
    const key = this.fileKey(workspaceId, path);
    if (this.directories.has(key) && !retry) return;
    const generation = this.generation, parent = this.parentSessionId;
    const previousState = this.directories.get(key), previous = previousState?.value;
    const state: DirectoryState = { loading: true, value: previous, cursors: previousState?.cursors };
    this.directories.set(key, state); this.changed();
    const active = () => { const tab = this.activeTab(); return parent === this.parentSessionId && this.visible && tab?.kind === "files" && tab.workspaceId === workspaceId && this.directoryExpanded(workspaceId, path) && (!canContinue || canContinue()); };
    let value: OpResult<"list_workspace_files"> | undefined, cursor: string | undefined;
    const cursors = new Set<string>(), last = previous?.entries.at(-1);
    do {
      if (cursor && !active()) { state.loading = false; this.changed(); return; }
      const result = await this.request("list_workspace_files", { workspace_id: workspaceId, path, ...(cursor ? { cursor } : {}) });
      if (generation !== this.generation || this.directories.get(key) !== state) return;
      if (!result.ok) { state.error = result.error.message; break; }
      if (!validDirectoryPage(result.value, workspaceId, path, value?.entries ?? [], cursors)) { state.error = "目录分页不一致，请刷新后继续浏览。"; break; }
      value = { ...result.value, entries: [...(value?.entries ?? []), ...result.value.entries] };
      cursor = value.nextCursor ?? undefined;
      if (cursor) cursors.add(cursor);
      const end = value.entries.at(-1);
      if (value.entries.length >= (previous?.entries.length ?? 0) && (!last || end && (end.kind === last.kind ? end.name >= last.name : end.kind === "file"))) break;
    } while (cursor);
    state.loading = false;
    if (value && !state.error) {
      state.value = value; state.cursors = cursors;
      const present = new Set(value.entries.map(entry => `${entry.kind}:${entry.path}`));
      for (const removed of previous?.entries.filter(entry => !present.has(`${entry.kind}:${entry.path}`)) ?? []) {
        const prefix = this.fileKey(workspaceId, removed.path);
        for (const cache of [this.directories, this.files, this.folders]) for (const cacheKey of cache.keys()) if (cacheKey === prefix || cacheKey.startsWith(`${prefix}/`)) cache.delete(cacheKey);
      }
    }
    this.changed();
  }
  async loadMoreDirectory(workspaceId: string, path: string): Promise<void> {
    const key = this.fileKey(workspaceId, path), state = this.directories.get(key), directory = state?.value, cursor = directory?.nextCursor;
    if (this.target !== "code" || !this.online || !state || !directory || !cursor || state.loading || state.loadingMore || state.error) return;
    const generation = this.generation;
    state.loadingMore = true; state.moreError = undefined; this.changed();
    const result = await this.request("list_workspace_files", { workspace_id: workspaceId, path, cursor });
    if (generation !== this.generation || this.directories.get(key) !== state || state.value?.nextCursor !== cursor) return;
    state.loadingMore = false;
    if (!result.ok) {
      if (result.error.code === "workspace_file_changed") state.error = result.error.message;
      else state.moreError = result.error.message;
    } else if (!validDirectoryPage(result.value, workspaceId, path, directory.entries, state.cursors ?? new Set([cursor]))) state.error = "目录分页不一致，请刷新后继续浏览。";
    else {
      state.value = { ...result.value, entries: [...directory.entries, ...result.value.entries] };
      if (result.value.nextCursor) (state.cursors ??= new Set([cursor])).add(result.value.nextCursor);
    }
    this.changed();
  }
  refreshDirectories(workspaceId: string, signal?: AbortSignal): Promise<void> {
    const generation = this.generation, parent = this.parentSessionId;
    const key = `${generation}:${workspaceId}`;
    const pending = this.directoryRefreshes.get(key);
    if (pending) return pending;
    const active = () => { const tab = this.activeTab(); return !signal?.aborted && generation === this.generation && parent === this.parentSessionId && this.target === "code" && this.online && this.visible && tab?.kind === "files" && tab.workspaceId === workspaceId; };
    if (!active()) return Promise.resolve();
    const refresh = (async () => {
      const paths = [""];
      while (paths.length && active()) {
        const path = paths.shift()!;
        const directoryKey = this.fileKey(workspaceId, path);
        if (!this.directoryExpanded(workspaceId, path)) continue;
        const state = this.directories.get(directoryKey);
        if (!state?.loading && !state?.loadingMore) await this.loadDirectory(workspaceId, path, true, active);
        if (!active()) return;
        for (const entry of this.directories.get(directoryKey)?.value?.entries ?? []) if (entry.kind === "directory" && this.folders.get(this.fileKey(workspaceId, entry.path))) paths.push(entry.path);
      }
    })().finally(() => this.directoryRefreshes.delete(key));
    this.directoryRefreshes.set(key, refresh);
    return refresh;
  }
  async loadFile(workspaceId: string, path: string, retry = false): Promise<void> {
    if (this.target !== "code" || !this.online) return;
    const key = this.fileKey(workspaceId, path);
    if (this.files.has(key) && !retry) return;
    const generation = this.generation;
    const state: { value?: PreviewFile; error?: string; loading: boolean } = { loading: true };
    this.files.set(key, state); this.changed();
    let offset = 0, version: string | undefined, bytes: Uint8Array | undefined;
    do {
      const result = await this.request("read_workspace_file", { workspace_id: workspaceId, path, offset, length: FILE_PAGE_BYTES, version });
      if (generation !== this.generation || this.files.get(key) !== state) return;
      if (!result.ok) { state.error = result.error.message; break; }
      const page = result.value;
      if (page.workspaceId !== workspaceId || page.path !== path || page.offset !== offset || page.encoding !== "base64" || !Number.isSafeInteger(page.size) || page.size < offset || typeof page.version !== "string" || !page.version || version !== undefined && (page.version !== version || page.size !== bytes!.length) || typeof page.data !== "string" || page.data.length > Math.ceil(Math.min(page.size - offset, FILE_PAGE_BYTES) / 3) * 4) {
        state.error = "文件分页来源或修订无法核实，请重新打开。"; break;
      }
      let chunk: Uint8Array;
      try { chunk = Uint8Array.from(atob(page.data), character => character.charCodeAt(0)); }
      catch { state.error = "文件分页内容无法解析，请重试。"; break; }
      if (chunk.length !== Math.min(page.size - offset, FILE_PAGE_BYTES)) { state.error = "文件分页内容不完整，请重试。"; break; }
      if (!bytes) {
        try { bytes = new Uint8Array(page.size); }
        catch { state.error = "当前窗口无法分配文件预览所需的内存。"; break; }
        version = page.version;
      }
      bytes.set(chunk, offset); offset += chunk.length;
    } while (offset < bytes!.length);
    state.loading = false;
    if (!state.error && bytes) {
      try { state.value = readSnapshotFile(path, bytes, bytes.length); }
      catch (cause) { if (!(cause instanceof RangeError)) throw cause; state.error = "当前窗口无法处理文件预览所需的内存，请关闭其他预览后重试。"; }
    }
    this.changed();
  }
  async loadReadSnapshot(tab: Extract<InspectorTab, { kind: "read-snapshot" }>, retry = false): Promise<void> {
    if (this.target !== "code" || !this.online || !this.tabs().includes(tab) || this.snapshots.has(tab.id) && !retry) return;
    const generation = this.generation;
    const state: ReadSnapshotState = { loading: true };
    this.snapshots.set(tab.id, state); this.changed();
    let offset = 0, bytes: Uint8Array | undefined, status: string | undefined;
    do {
      const result = await this.request("read_artifact", { task_id: tab.taskId, artifact_id: tab.artifactId, session_id: tab.sessionId, offset, length: FILE_PAGE_BYTES });
      if (generation !== this.generation || this.snapshots.get(tab.id) !== state || !this.tabs().includes(tab)) return;
      if (!result.ok) { state.error = `读取 Read 快照失败：${result.error.message}`; break; }
      const { artifact, data, encoding } = result.value, size = artifact.byteCount;
      if (artifact.id !== tab.artifactId || artifact.taskId !== tab.taskId || artifact.sessionId !== tab.sessionId || !["partial", "complete"].includes(artifact.status) || !Number.isSafeInteger(size) || size < offset || bytes && (size !== bytes.length || artifact.status !== status) || encoding !== "base64" || typeof data !== "string" || data.length > Math.ceil(Math.min(size - offset, FILE_PAGE_BYTES) / 3) * 4) {
        state.error = "Read 快照来源或大小无法核实，请重试。"; break;
      }
      let chunk: Uint8Array;
      try { chunk = Uint8Array.from(atob(data), character => character.charCodeAt(0)); }
      catch { state.error = "Read 快照内容无法解析，请重试。"; break; }
      if (chunk.length !== Math.min(size - offset, FILE_PAGE_BYTES)) { state.error = "Read 快照内容不完整，请重试。"; break; }
      if (!bytes) {
        try { bytes = new Uint8Array(size); }
        catch { state.error = "当前窗口无法分配 Read 快照所需的内存。"; break; }
        status = artifact.status;
      }
      bytes.set(chunk, offset); offset += chunk.length;
    } while (offset < bytes!.length);
    state.loading = false;
    if (!state.error && bytes) {
      try { state.file = readSnapshotFile(tab.path, bytes, bytes.length); }
      catch (cause) { if (!(cause instanceof RangeError)) throw cause; state.error = "当前窗口无法处理 Read 快照所需的内存，请关闭其他预览后重试。"; }
      state.partial = status === "partial";
    }
    this.changed();
  }
  selectChild(sessionId: string): void {
    const agent = this.view.subAgents.find(item => item.sessionId === sessionId);
    this.addTab({ id: `agent:${sessionId}`, kind: "agent", title: agent?.definition?.name ?? "SubAgent", sessionId });
  }
  agentForTool(tool: DiffTool) {
    if (typeof tool.params.sub_agent_id === "string") return this.agents().find(agent => agent.id === tool.params.sub_agent_id);
    const work = typeof tool.params.work_id === "string" ? this.workDelegations().find(work => work.id === tool.params.work_id) : this.workDelegations().find(work => work.requestKey === tool.params.key);
    return work ? this.agents().find(agent => agent.id === work.subAgentId) : undefined;
  }
  seedTabs(): void {
    if (!this.parentSessionId || this.tabsByParent.has(this.parentSessionId) || this.loadingWorks || !this.view.openSession(this.parentSessionId).historyLoaded) return;
    const tool = this.target === "code" ? this.view.openSession(this.parentSessionId).flow.tools.find(isDiffTool) : undefined;
    const agent = this.agents()[0];
    const visible = this.visible;
    if (tool) this.openDiff(this.parentSessionId, tool);
    if (agent) this.selectChild(agent.sessionId);
    if (!tool && !agent) this.tabsByParent.set(this.parentSessionId, []);
    this.visible = visible;
  }
  async loadWorks(): Promise<void> {
    const sessionId = this.parentSessionId;
    if (!sessionId) return;
    const read = ++this.workRead;
    const generation = this.generation;
    this.loadingWorks = true; this.workError = null;
    const result = await this.request("work_list", { session_id: sessionId });
    if (generation !== this.generation || read !== this.workRead || sessionId !== this.parentSessionId) return;
    this.loadingWorks = false;
    if (!result.ok) this.workError = `读取工作委托失败：${result.error.message}；请刷新重试。`;
    else {
      this.works = result.value.works;
      const agents = new Map(this.view.subAgents.map(agent => [agent.id, agent]));
      const works = new Map(this.view.workDelegations.map(work => [work.id, work]));
      for (const { work, agent } of this.works) { works.set(work.id, work); if (agent) agents.set(agent.id, agent); }
      this.view.subAgents = [...agents.values()];
      this.view.workDelegations = [...works.values()];
      if (this.workId) void this.selectWork(this.workId);
    }
    this.seedTabs();
    this.changed();
  }
  async selectWork(workId: string): Promise<void> {
    this.workId = workId; this.detail = null; this.workError = null;
    const generation = this.generation;
    const read = this.workRead;
    const detailRead = ++this.detailRead;
    const result = await this.request("work_get", { work_id: workId });
    if (generation !== this.generation || read !== this.workRead || detailRead !== this.detailRead || this.workId !== workId) return;
    if (!result.ok) this.workError = `读取工作详情失败：${result.error.message}；请刷新重试。`;
    else this.detail = result.value;
    this.changed();
  }
  agents() {
    return this.view.subAgents.filter(agent => agent.parentSessionId === this.parentSessionId);
  }
  workDelegations() {
    return this.view.workDelegations.filter(work => work.parentSessionId === this.parentSessionId);
  }
  openDiff(sessionId: string, tool: DiffTool): void {
    if (this.target !== "code") return;
    if (!this.parentSessionId) this.parentSessionId = sessionId;
    const existing = this.tabs().find(tab => tab.kind === "diff" && tab.selection.sessionId === sessionId && (tab.selection.key === tool.key || (tool.entryId !== null && tab.selection.entryId === tool.entryId)));
    this.addTab(existing ?? { id: `diff:${sessionId}:${tool.entryId ?? tool.key}`, kind: "diff", title: tool.target.split("/").at(-1) || tool.name, selection: { sessionId, key: tool.key, entryId: tool.entryId } });
  }
  selectedTool(): DiffTool | undefined {
    const selection = this.diff;
    return selection ? this.view.openSession(selection.sessionId).flow.items.find((item): item is DiffTool => item.kind === "tool" && (item.key === selection.key || (selection.entryId !== null && item.entryId === selection.entryId))) : undefined;
  }
  async loadDiff(): Promise<void> {
    const selection = this.diff;
    const tool = this.selectedTool();
    const tabId = this.activeTab()?.id;
    if (!this.online || !selection || !tabId || !tool || !canReadDiff(tool)) return;
    const field = tool.status === "error" || tool.status === "effect_unknown" || this.result?.value?.isError === true ? "text" : tool.name.toLowerCase() === "edit" ? "patch" : "writeContent";
    if (this.result?.entryId === tool.entryId && this.result.field === field) return;
    selection.entryId = tool.entryId;
    const state: DiffResult = { entryId: tool.entryId!, field, loading: true };
    this.result = state;
    this.results.set(tabId, state);
    await this.readPage(selection, tool, tabId, state, 0);
  }
  async loadMore(): Promise<void> {
    const selection = this.diff;
    const tool = this.selectedTool();
    const state = this.result;
    const tabId = this.activeTab()?.id;
    if (!selection || !tool || !state || !tabId || state.loading || state.nextOffset === undefined || state.totalBytes === undefined || state.nextOffset >= state.totalBytes) return;
    state.loading = true; state.moreError = undefined; this.changed();
    await this.readPage(selection, tool, tabId, state, state.nextOffset);
  }
  toolKey(sessionId: string, tool: DiffTool): string { return `${sessionId}:${tool.entryId ?? tool.key}`; }
  toolResult(sessionId: string, tool: DiffTool): DiffResult | undefined { return this.toolResults.get(this.toolKey(sessionId, tool)); }
  async loadTool(sessionId: string, tool: DiffTool, retry = false): Promise<void> {
    if (!this.online || !canReadDiff(tool)) return;
    const key = this.toolKey(sessionId, tool);
    const existing = this.toolResults.get(key);
    const field = tool.status === "error" || tool.status === "effect_unknown" || existing?.value?.isError === true || !isDiffTool(tool) ? "text" : "patch";
    if (existing?.field === field && !retry) return;
    const state: DiffResult = { entryId: tool.entryId!, field, loading: true };
    this.toolResults.set(key, state); this.changed();
    await this.readPage({ sessionId, key: tool.key, entryId: tool.entryId }, tool, key, state, 0, this.toolResults);
  }
  async moreTool(sessionId: string, tool: DiffTool): Promise<void> {
    const key = this.toolKey(sessionId, tool), state = this.toolResults.get(key);
    if (!this.online || !state || state.loading || state.nextOffset === undefined || state.totalBytes === undefined || state.nextOffset >= state.totalBytes) return;
    state.loading = true; state.moreError = undefined; this.changed();
    await this.readPage({ sessionId, key: tool.key, entryId: tool.entryId }, tool, key, state, state.nextOffset, this.toolResults);
  }
  toolParams(sessionId: string, tool: DiffTool): ToolParams | undefined { return this.params.get(`${sessionId}:${tool.toolOpId}`); }
  async loadToolParams(sessionId: string, tool: DiffTool, retry = false): Promise<void> {
    if (!this.online || !tool.toolOpId) return;
    const key = `${sessionId}:${tool.toolOpId}`;
    if (this.params.has(key) && !retry) return;
    const state: ToolParams = { loading: true };
    this.params.set(key, state); this.changed();
    const generation = this.generation;
    let text = "", offset = 0, total: number | undefined;
    while (true) {
      const result: DesktopResult<OpResult<"get_tool_op_params">> = await this.request("get_tool_op_params", { tool_op_id: tool.toolOpId, offset, length: 64 * 1024 });
      if (generation !== this.generation || this.params.get(key) !== state) return;
      if (!result.ok) { state.error = `读取参数失败：${result.error.message}`; break; }
      const page = result.value.params;
      const next = toolPage(page, offset, total);
      if (result.value.toolOp.id !== tool.toolOpId || result.value.toolOp.taskId !== tool.taskId || result.value.toolOp.toolName.toLowerCase() !== tool.name.toLowerCase() || this.view.tasks.get(tool.taskId ?? "")?.sessionId !== sessionId || !next) { state.error = "工具参数来源或分页不一致，请重试。"; break; }
      text += page.text; offset = next.nextOffset; total = next.totalBytes;
      if (offset < total) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch { state.error = "工具参数无法解析，请重试。"; break; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) state.error = "工具参数格式无效，请重试。";
      else state.value = parsed as Record<string, unknown>;
      break;
    }
    state.loading = false; this.changed();
  }
  private async readPage(selection: DiffSelection, tool: DiffTool, tabId: string, state: DiffResult, offset: number, cache = this.results): Promise<void> {
    const generation = this.generation;
    const field = state.field!;
    const result = await this.request("read_tool_result", { session_id: selection.sessionId, entry_id: state.entryId, field, offset, length: 64 * 1024 });
    if (generation !== this.generation || cache.get(tabId) !== state) return;
    if (result.ok && field !== "text" && result.value.isError === true) {
      state.field = "text"; state.nextOffset = undefined; state.totalBytes = undefined;
      return this.readPage(selection, tool, tabId, state, 0, cache);
    }
    state.loading = false;
    let error: string | undefined;
    if (!result.ok) error = `读取差异失败：${result.error.message}`;
    else {
      const page = result.value.content;
      const next = toolPage(page, offset, state.totalBytes);
      if (!next) error = "工具结果分页不连续，请重试。";
      else {
        const previous = offset ? state.value?.[field] ?? "" : "";
        state.value = { ...result.value, [field]: page == null ? null : previous + page.text, truncated: next.nextOffset < next.totalBytes };
        state.nextOffset = next.nextOffset;
        state.totalBytes = next.totalBytes;
      }
    }
    if (offset) state.moreError = error;
    else state.error = error;
    this.changed();
  }
}
