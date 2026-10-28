import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import { ViewState, isActiveStatus } from "./state.ts";
import { utf8ByteLength } from "./utf8.ts";

type HistoryOp = "list_tasks" | "get_task" | "read_task_events" | "read_history_entry";

interface HistoryRecoveryDeps {
  state: ViewState;
  request<K extends HistoryOp>(op: K, params: OpParams<K>): Promise<OpResult<K>>;
  entryPageBytes: number;
  completeEntry(entry: HistoryEntryView): boolean;
  isMissingEntry(error: unknown): boolean;
  changed(): void;
  entryFailed(error: unknown): void;
}

export class HistoryRecoveryError extends Error {
  readonly code = "history_discontinuous";
}

/** 只编排注入的读取；历史页安装、首屏时序和连接生命周期由客户端持有。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-shared-history-recovery.md
 * Note: 见 .agents/notes/implemented/feature/2026-10-28-desktop-message-actions.md
 */
export class HistoryRecovery {
  private epoch = 0;
  private readonly cursors = new Map<string, number>();
  private readonly requests = new Map<string, Promise<void>>();
  private readonly pendingEntries = new Map<string, { sessionId: string; taskId?: string }>();

  constructor(private readonly deps: HistoryRecoveryDeps) {}

  get generation(): number { return this.epoch; }

  reset(): void {
    ++this.epoch;
    this.cursors.clear();
    this.requests.clear();
    this.pendingEntries.clear();
  }

  /** 所有阶段沿用读历史页前捕获的代次；过时调用不发请求，也不创建会话视图。 */
  async readTasks(sessionId: string, entries: HistoryEntryView[], generation: number): Promise<Set<string> | null> {
    const earliest = entries.reduce((at, entry) => !at || entry.timestamp < at ? entry.timestamp : at, "");
    const ids = new Set(entries.map(entry => entry.entryId));
    const relevant = new Set<string>();
    let before: string | undefined;
    for (;;) {
      if (generation !== this.epoch) return null;
      const page = await this.deps.request("list_tasks", { session_id: sessionId, before, limit: 50 });
      if (generation !== this.epoch) return null;
      for (const task of page.tasks) {
        if (!earliest || isActiveStatus(task.status) || (task.endedAt ?? task.createdAt) >= earliest || task.historyEntryIds.some(id => ids.has(id))) {
          if (!this.deps.state.getTask(task.id)) this.deps.state.upsertTask(task);
          relevant.add(task.id);
        }
      }
      const last = page.tasks.at(-1);
      if (!page.hasMore || !last || !earliest || (last.endedAt ?? last.createdAt) < earliest) break;
      before = last.id;
    }
    // 分支历史里的消息可以关联来源会话的任务；这些任务不在当前会话的 list_tasks 结果里。
    const referenced = new Set(entries.map(entry => entry.taskId).filter((id): id is string => !!id));
    for (const taskId of this.deps.state.sessions.find(item => item.id === sessionId)?.branchSource?.taskIds ?? []) {
      if (!referenced.has(taskId) || this.deps.state.getTask(taskId)) continue;
      if (generation !== this.epoch) return null;
      const detail = await this.deps.request("get_task", { task_id: taskId });
      if (generation !== this.epoch) return null;
      this.deps.state.upsertTask(detail.task);
    }
    return relevant;
  }

  restoreTask(taskId: string, generation: number): Promise<void> {
    return this.run(`task:${taskId}`, generation, () => this.readTask(taskId, generation));
  }

  /** 分支会话不复制任务账本；把来源任务的事件投影到当前分支，只用于展示 trace。 */
  restoreBranchTask(sessionId: string, taskId: string, generation: number): Promise<void> {
    return this.run(`branch-task:${sessionId}:${taskId}`, generation, () => this.readBranchTask(sessionId, taskId, generation));
  }

  private async readBranchTask(sessionId: string, taskId: string, generation: number): Promise<void> {
    const detail = await this.deps.request("get_task", { task_id: taskId });
    if (generation !== this.epoch) return;
    this.deps.state.upsertTask(detail.task);
    const view = this.deps.state.openSession(sessionId);
    for (const op of detail.toolOps ?? []) view.flow.tool(op);
    const cursor = `branch:${sessionId}:${taskId}`;
    let after = this.cursors.get(cursor) ?? 0;
    for (;;) {
      if (generation !== this.epoch) return;
      const page = await this.deps.request("read_task_events", { task_id: taskId, after_seq: after, limit: 100 });
      if (generation !== this.epoch) return;
      for (const event of page.events) {
        view.flow.apply(event);
        after = Math.max(after, event.seq);
      }
      this.cursors.set(cursor, after);
      this.deps.changed();
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
  }

  private async readTask(taskId: string, generation: number): Promise<void> {
    const detail = await this.deps.request("get_task", { task_id: taskId });
    if (generation !== this.epoch) return;
    this.deps.state.installTaskDetail(detail.task, detail.toolOps ?? [], detail.outputPreview, detail.seq);
    const view = this.deps.state.openSession(detail.task.sessionId);
    // 详情 seq 只保护详情版本；恢复历史事件必须从本任务自己的游标开始。
    let after = this.cursors.get(taskId) ?? 0;
    const missing = new Set<string>();
    const loaded = new Set(view.flow.historyEntries.filter(entry => !entry.truncated || !this.deps.completeEntry(entry)).map(entry => entry.entryId));
    for (;;) {
      if (generation !== this.epoch) return;
      const page = await this.deps.request("read_task_events", { task_id: taskId, after_seq: after, limit: 100 });
      if (generation !== this.epoch) return;
      for (const event of page.events) {
        view.flow.apply(event);
        if (event.body.type === "task.output_entry" && !loaded.has(event.body.entryId)) missing.add(event.body.entryId);
        after = Math.max(after, event.seq);
      }
      this.cursors.set(taskId, after);
      this.deps.changed();
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    for (const entryId of missing) await this.loadEntry(detail.task.sessionId, entryId, generation, taskId);
  }

  historyReady(sessionId: string, taskId: string): boolean {
    return ![...this.pendingEntries.values()].some(pending => pending.sessionId === sessionId && pending.taskId === taskId);
  }

  loadEntry(sessionId: string, entryId: string, generation: number, taskId?: string): Promise<void> {
    if (generation !== this.epoch) return Promise.resolve();
    const key = `${sessionId}:${entryId}`;
    const known = this.deps.state.openSession(sessionId).flow.historyEntries.some(entry => entry.entryId === entryId);
    if (!known) this.pendingEntries.set(key, { sessionId, taskId: taskId ?? this.pendingEntries.get(key)?.taskId });
    return this.run(`entry:${key}`, generation, () => this.readEntry(sessionId, entryId, generation).catch(error => {
      // 缺失或失败保留未就绪事实；逐条报告后仍可恢复其他正文。
      if (generation === this.epoch && !this.deps.isMissingEntry(error)) this.deps.entryFailed(error);
    }));
  }

  private async readEntry(sessionId: string, entryId: string, generation: number): Promise<void> {
    const entry = await this.deps.request("read_history_entry", { session_id: sessionId, entry_id: entryId, length: this.deps.entryPageBytes });
    if (generation !== this.epoch) return;
    if (entry.offset !== 0) throw new HistoryRecoveryError("历史正文分页未从开头返回；请重新加载会话。");
    let text = entry.text;
    let offset = utf8ByteLength(text);
    if (offset > entry.totalBytes) throw new HistoryRecoveryError("历史正文分页未连续返回；请重新加载会话。");
    const complete = this.deps.completeEntry(entry);
    while (complete && offset < entry.totalBytes) {
      const page = await this.deps.request("read_history_entry", { session_id: sessionId, entry_id: entryId, offset, length: this.deps.entryPageBytes });
      if (generation !== this.epoch) return;
      const next = offset + utf8ByteLength(page.text);
      if (!page.text || page.offset !== offset || page.totalBytes !== entry.totalBytes || next > entry.totalBytes) {
        throw new HistoryRecoveryError("历史正文分页未连续返回；请重新加载会话。");
      }
      text += page.text;
      offset = next;
    }
    const changed = this.deps.state.appendEntryView(sessionId, complete ? { ...entry, text, truncated: false } : entry);
    this.pendingEntries.delete(`${sessionId}:${entryId}`);
    if (changed) this.deps.changed();
  }

  private run(key: string, generation: number, action: () => Promise<void>): Promise<void> {
    if (generation !== this.epoch) return Promise.resolve();
    key = `${generation}:${key}`;
    const pending = this.requests.get(key);
    if (pending) return pending;
    const request = action().catch(error => {
      if (generation === this.epoch) throw error;
    }).finally(() => { this.requests.delete(key); });
    this.requests.set(key, request);
    return request;
  }
}
