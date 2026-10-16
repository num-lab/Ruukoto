import { browserAddress, browserNavigation, navigateBrowser, type BrowserNavigation } from "./browser-navigation.ts";
import { sessionDisplayAttribution } from "@ruukoto/control/session-attribution.ts";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { utf8ByteLength } from "@ruukoto/view/utf8.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../shared/bridge.ts";
import { canReadDiff, isDiffTool, type DiffTool } from "./diff.ts";

interface DiffResult { entryId: string; field?: "text" | "patch" | "writeContent"; value?: OpResult<"read_tool_result">; error?: string; moreError?: string; nextOffset?: number; totalBytes?: number; loading?: boolean }
interface DiffSelection { sessionId: string; key: string; entryId: string | null }
export type InspectorTab = { id: string; kind: "diff"; title: string; selection: DiffSelection } | { id: string; kind: "agent"; title: string; sessionId: string } | { id: string; kind: "new"; title: string } | { id: string; kind: "browser"; title: string; navigation: BrowserNavigation } | { id: string; kind: "files"; title: string; workspaceId: string } | { id: string; kind: "file"; title: string; workspaceId: string; path: string; mode: "preview" | "source" };

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopInspector {
  tab: "agents" | "diff" = "agents";
  visible = false;
  private readonly tabsByParent = new Map<string, InspectorTab[]>();
  private readonly activeByParent = new Map<string, string>();
  private readonly results = new Map<string, NonNullable<DesktopInspector["result"]>>();
  parentSessionId: string | null = null;
  childSessionId: string | null = null;
  workId: string | null = null;
  works: OpResult<"work_list">["works"] = [];
  detail: OpResult<"work_get"> | null = null;
  workError: string | null = null;
  loadingWorks = false;
  diff: DiffSelection | null = null;
  result: DiffResult | null = null;
  readonly directories = new Map<string, { value?: OpResult<"list_workspace_files">; error?: string; loading: boolean }>();
  readonly files = new Map<string, { value?: OpResult<"read_workspace_file">; error?: string; loading: boolean }>();
  readonly folders = new Map<string, boolean>();
  private generation = 0;
  private workRead = 0;
  private detailRead = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly view: ViewState, private readonly history: (id: string) => Promise<void>, private readonly changed: () => void) {}

  private async request<K extends "work_list" | "work_get" | "read_tool_result" | "list_workspace_files" | "read_workspace_file">(op: K, params: OpParams<K>): Promise<DesktopResult<OpResult<K>>> {
    let result;
    try { result = await this.bridge.request("code", op, params); }
    catch { return { ok: false, error: { code: "ipc_unavailable", outcome: "not_sent", message: "桌面连接不可用，请重新连接后再读取。" } }; }
    // 控制面响应经主进程转发，类型在 IPC wire 边界还原。
    return result as DesktopResult<OpResult<K>>;
  }

  update(update: DesktopUpdate): void {
    if (update.type === "state" && update.state !== "online") { ++this.generation; this.directories.clear(); this.files.clear(); }
    if (update.type === "snapshot") {
      ++this.generation;
      this.directories.clear(); this.files.clear();
      this.works = []; this.detail = null; this.result = null; this.results.clear(); this.workError = null;
      if (update.instanceChanged || (this.parentSessionId && !this.view.sessions.some(session => session.id === this.parentSessionId))) {
        this.parentSessionId = null; this.childSessionId = null; this.workId = null; this.diff = null; this.tabsByParent.clear(); this.activeByParent.clear(); this.folders.clear();
      }
      if (this.parentSessionId) void this.loadWorks();
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
    if (tab.kind === "files") void this.loadDirectory(tab.workspaceId, "");
    if (tab.kind === "file") void this.loadFile(tab.workspaceId, tab.path);
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
    if (closing?.kind === "file") this.files.delete(this.fileKey(closing.workspaceId, closing.path));
    if (!rest.length) rest.push({ id: crypto.randomUUID(), kind: "new", title: "新标签" });
    const active = this.activeTab();
    this.tabsByParent.set(this.parentSessionId ?? "", rest);
    if (active?.id === id) this.selectTab(rest[Math.max(0, index - 1)].id);
    else this.changed();
  }
  workspace() {
    const parent = this.view.sessions.find(session => session.id === this.parentSessionId);
    const id = parent ? sessionDisplayAttribution(parent, this.view.projects).projectId : null;
    return this.view.projects.find(project => project.id === id);
  }
  fileKey(workspaceId: string, path: string): string { return `${workspaceId}:${path}`; }
  openFiles(): void {
    const workspace = this.workspace();
    if (workspace) this.addTab({ id: `files:${workspace.id}`, kind: "files", title: "文件树", workspaceId: workspace.id });
  }
  openFile(workspaceId: string, path: string): void { this.addTab({ id: `file:${workspaceId}:${path}`, kind: "file", title: path.split("/").at(-1) ?? path, workspaceId, path, mode: "preview" }); }
  openBrowser(address?: string): void {
    if (address && !browserAddress(address)) return;
    const existing = this.tabs().find(tab => tab.kind === "browser");
    if (existing?.kind === "browser" && address) existing.navigation = navigateBrowser(existing.navigation, address);
    this.addTab(existing ?? { id: "browser", kind: "browser", title: "浏览器", navigation: browserNavigation(address ? browserAddress(address)! : "about:blank") });
  }
  async loadDirectory(workspaceId: string, path: string, retry = false): Promise<void> {
    const key = this.fileKey(workspaceId, path);
    if (this.directories.has(key) && !retry) return;
    const generation = this.generation;
    const state: { value?: OpResult<"list_workspace_files">; error?: string; loading: boolean } = { loading: true };
    this.directories.set(key, state); this.changed();
    const result = await this.request("list_workspace_files", { workspace_id: workspaceId, path });
    if (generation !== this.generation || this.directories.get(key) !== state) return;
    state.loading = false;
    if (result.ok) state.value = result.value; else state.error = result.error.message;
    this.changed();
  }
  async loadFile(workspaceId: string, path: string, retry = false): Promise<void> {
    const key = this.fileKey(workspaceId, path);
    if (this.files.has(key) && !retry) return;
    const generation = this.generation;
    const state: { value?: OpResult<"read_workspace_file">; error?: string; loading: boolean } = { loading: true };
    this.files.set(key, state); this.changed();
    const result = await this.request("read_workspace_file", { workspace_id: workspaceId, path });
    if (generation !== this.generation || this.files.get(key) !== state) return;
    state.loading = false;
    if (result.ok) state.value = result.value; else state.error = result.error.message;
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
    const tool = this.view.openSession(this.parentSessionId).flow.tools.find(isDiffTool);
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
    if (!selection || !tabId || !tool || !canReadDiff(tool)) return;
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
  private async readPage(selection: DiffSelection, tool: DiffTool, tabId: string, state: DiffResult, offset: number): Promise<void> {
    const generation = this.generation;
    const field = state.field!;
    const result = await this.request("read_tool_result", { session_id: selection.sessionId, entry_id: state.entryId, field, offset, length: 64 * 1024 });
    if (generation !== this.generation || this.results.get(tabId) !== state) return;
    if (result.ok && field !== "text" && result.value.isError === true) {
      state.field = "text"; state.nextOffset = undefined; state.totalBytes = undefined;
      return this.readPage(selection, tool, tabId, state, 0);
    }
    state.loading = false;
    let error: string | undefined;
    if (!result.ok) error = `读取差异失败：${result.error.message}`;
    else {
      const page = result.value.content;
      const count = page ? utf8ByteLength(page.text) : 0;
      if (page === undefined || (page === null && offset !== 0) || (page && (page.offset !== offset || !Number.isSafeInteger(page.totalBytes) || page.totalBytes < offset + count || (state.totalBytes !== undefined && state.totalBytes !== page.totalBytes) || (!count && offset < page.totalBytes)))) error = "差异分页不连续，请重试。";
      else {
        const previous = offset ? state.value?.[field] ?? "" : "";
        state.value = { ...result.value, [field]: page === null ? null : previous + page.text, truncated: page !== null && offset + count < page.totalBytes };
        state.nextOffset = offset + count;
        state.totalBytes = page?.totalBytes ?? 0;
      }
    }
    if (offset) state.moreError = error;
    else state.error = error;
    this.changed();
  }
}
