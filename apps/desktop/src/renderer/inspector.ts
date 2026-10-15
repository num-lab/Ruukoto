import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../shared/bridge.ts";
import { canReadDiff, type DiffTool } from "./diff.ts";

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export class DesktopInspector {
  tab: "agents" | "diff" = "agents";
  parentSessionId: string | null = null;
  childSessionId: string | null = null;
  workId: string | null = null;
  works: OpResult<"work_list">["works"] = [];
  detail: OpResult<"work_get"> | null = null;
  workError: string | null = null;
  loadingWorks = false;
  diff: { sessionId: string; key: string; entryId: string | null } | null = null;
  result: { entryId: string; value?: OpResult<"read_tool_result">; error?: string } | null = null;
  private generation = 0;
  private workRead = 0;
  private detailRead = 0;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly view: ViewState, private readonly history: (id: string) => Promise<void>, private readonly changed: () => void) {}

  private async request<K extends "work_list" | "work_get" | "read_tool_result">(op: K, params: OpParams<K>): Promise<DesktopResult<OpResult<K>>> {
    let result;
    try { result = await this.bridge.request("code", op, params); }
    catch { return { ok: false, error: { code: "ipc_unavailable", outcome: "not_sent", message: "桌面连接不可用，请重新连接后再读取。" } }; }
    // 控制面响应经主进程转发，类型在 IPC wire 边界还原。
    return result as DesktopResult<OpResult<K>>;
  }

  update(update: DesktopUpdate): void {
    if (update.type === "snapshot") {
      ++this.generation;
      this.works = []; this.detail = null; this.result = null; this.workError = null;
      if (update.instanceChanged || (this.parentSessionId && !this.view.sessions.some(session => session.id === this.parentSessionId))) {
        this.parentSessionId = null; this.childSessionId = null; this.workId = null; this.diff = null;
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
    void this.loadWorks();
  }
  selectChild(sessionId: string): void {
    this.childSessionId = sessionId; this.tab = "agents";
    void this.history(sessionId); this.changed();
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
    this.diff = { sessionId, key: tool.key, entryId: tool.entryId }; this.result = null; this.tab = "diff";
    void this.loadDiff(); this.changed();
  }
  selectedTool(): DiffTool | undefined {
    const selection = this.diff;
    return selection ? this.view.openSession(selection.sessionId).flow.items.find((item): item is DiffTool => item.kind === "tool" && (item.key === selection.key || (selection.entryId !== null && item.entryId === selection.entryId))) : undefined;
  }
  async loadDiff(): Promise<void> {
    const selection = this.diff;
    const tool = this.selectedTool();
    if (!selection || !tool || !canReadDiff(tool) || this.result?.entryId === tool.entryId) return;
    const generation = this.generation;
    const resultState = { entryId: tool.entryId! };
    this.result = resultState;
    const result = await this.request("read_tool_result", { session_id: selection.sessionId, entry_id: tool.entryId!, length: 64 * 1024 });
    if (generation !== this.generation || this.diff !== selection || this.result !== resultState) return;
    this.result = result.ok ? { ...resultState, value: result.value } : { ...resultState, error: `读取差异失败：${result.error.message}；请重试。` };
    this.changed();
  }
}
