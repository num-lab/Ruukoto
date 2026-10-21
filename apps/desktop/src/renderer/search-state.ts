// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md
import type { HistorySearchWireCursor, OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopUpdate } from "../shared/bridge.ts";

export type SearchSummary = OpResult<"list_session_summaries">[number];
export type SearchHit = OpResult<"search_history">["hits"][number];
type SearchPage = OpResult<"search_history">;
type SearchCursor = NonNullable<SearchPage["cursor"]>;
export type SearchSourceIssue = NonNullable<SearchPage["sourceIssues"]>[number];
function searchCursorParams(cursor: SearchCursor): HistorySearchWireCursor {
  const legacy = { session_id: cursor.sessionId, byte_offset: cursor.byteOffset };
  return "phase" in cursor ? { ...legacy, phase: cursor.phase, read_offset: cursor.readOffset, query_key: cursor.queryKey, source: { file_dev: cursor.source.fileDev, file_ino: cursor.source.fileIno, min_size: cursor.source.minSize } } : legacy;
}

export const foldSearchText = (text: string): string => text.replace(/[A-Z]/g, letter => letter.toLowerCase());
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function relativeSearchTime(timestamp: string, now = Date.now()): string {
  const elapsed = Date.parse(timestamp) - now;
  if (!Number.isFinite(elapsed)) return "";
  for (const [unit, size] of [["year", 365 * 86_400_000], ["month", 30 * 86_400_000], ["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]] as const) {
    if (Math.abs(elapsed) >= size) return relativeTimeFormat.format(Math.trunc(elapsed / size), unit);
  }
  return relativeTimeFormat.format(0, "second");
}
export function isSearchShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean }, blocked: boolean, terminal: boolean): boolean {
  return !blocked && !event.isComposing && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey && !terminal);
}
export function searchSessions(summaries: SearchSummary[], query: string): SearchSummary[] {
  const needle = foldSearchText(query);
  const rank = (name: string) => name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
  return summaries.filter(item => !query.trim() || foldSearchText(item.name ?? "新会话").includes(needle)).sort((a, b) => (query.trim() ? rank(foldSearchText(a.name ?? "新会话")) - rank(foldSearchText(b.name ?? "新会话")) : 0) || b.lastActiveAt.localeCompare(a.lastActiveAt) || a.sessionId.localeCompare(b.sessionId)).slice(0, 8);
}

export class DesktopSearch {
  open = false;
  query = "";
  composing = false;
  online = false;
  summaries: SearchSummary[] | null = null;
  summariesLoading = false;
  summariesError: string | null = null;
  hits: SearchHit[] = [];
  loading = false;
  error: string | null = null;
  complete = false;
  sourceIssues: SearchSourceIssue[] = [];
  unindexedSessionIds: string[] = [];
  progress = { indexedBytes: 0, scannedBytes: 0 };
  private instanceId: string | null = null;
  private generation = 0;
  private summariesGeneration = 0;
  private busy = false;
  private ready = false;
  private targetCount = 20;
  private cursor: SearchCursor | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, private readonly changed: () => void) {}

  get sessions(): SearchSummary[] { return searchSessions(this.summaries ?? [], this.query); }
  get uncovered(): boolean { return this.sourceIssues.length > 0 || this.unindexedSessionIds.length > 0; }
  get hasMore(): boolean { return !!this.query.trim() && !this.complete && !this.error; }
  get status(): string {
    if (!this.online) return "Code 已离线，恢复连接后可重新搜索。";
    if (this.summariesError) return `会话列表读取失败：${this.summariesError} 请重试。`;
    if (this.summariesLoading || this.summaries === null) return "正在加载会话列表…";
    if (this.error) return this.error;
    if (this.loading) return this.hits.length ? "继续搜索中…" : "暂未找到，继续搜索中…";
    if (!this.query.trim()) return "";
    if (!this.complete) return this.hits.length ? "向下滚动可继续加载搜索结果。" : "输入关键词搜索聊天内容。";
    if (this.hits.length || this.sessions.length) return "搜索完成。";
    return this.uncovered ? "部分历史未覆盖，当前可读范围未找到结果。" : "没有找到。";
  }
  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.query = "";
    this.composing = false;
    this.reset();
    if (open && (this.summaries === null || this.summariesError)) void this.loadSummaries();
    this.changed();
  }
  setQuery(query: string): void {
    if (this.query === query) return;
    this.query = query;
    this.reset();
    this.schedule();
    this.changed();
  }
  setComposing(composing: boolean): void {
    this.composing = composing;
    if (composing) { this.reset(); this.changed(); }
    else this.schedule();
  }
  private reset(): void {
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ready = false;
    this.targetCount = 20;
    this.cursor = null;
    this.hits = [];
    this.loading = false;
    this.error = null;
    this.complete = false;
    this.sourceIssues = [];
    this.unindexedSessionIds = [];
    this.progress = { indexedBytes: 0, scannedBytes: 0 };
  }
  private schedule(): void {
    if (!this.open || !this.online || !this.instanceId || this.composing || !this.query.trim()) return;
    if (this.timer) clearTimeout(this.timer);
    this.loading = true;
    this.timer = setTimeout(() => { this.timer = null; this.ready = true; void this.pump(); }, 180);
  }
  loadMore(): void {
    if (!this.hasMore || this.loading) return;
    this.targetCount = this.hits.length + 20;
    this.ready = true;
    void this.pump();
  }
  retry(): void { this.reset(); this.schedule(); if (this.summaries === null || this.summariesError) void this.loadSummaries(); this.changed(); }
  update(update: DesktopUpdate): void {
    if (update.type === "state") {
      this.online = update.state === "online";
      if (!this.online) { this.reset(); ++this.summariesGeneration; this.summariesLoading = false; this.summaries = null; }
      else if (this.instanceId) { void this.loadSummaries(); this.schedule(); }
    } else if (update.type === "snapshot") {
      this.instanceId = update.result.snapshot.instanceId;
      this.reset();
      this.summaries = null;
      ++this.summariesGeneration;
      if (this.online) void this.loadSummaries();
      this.schedule();
    } else if (update.type === "event" && ["session.created", "session.workspace_mapped", "session.archive_changed", "project.created", "task.queued"].includes(update.event.body.type)) void this.loadSummaries();
  }
  async loadSummaries(): Promise<void> {
    if (!this.online || !this.instanceId) return;
    const generation = ++this.summariesGeneration;
    this.summariesLoading = true;
    this.summariesError = null;
    this.changed();
    let response;
    try { response = await this.bridge.request("code", "list_session_summaries", { scope: "workspace_chats" }); }
    catch { if (generation === this.summariesGeneration) { this.summariesLoading = false; this.summariesError = "读取会话列表失败，请重试。"; this.changed(); } return; }
    if (generation !== this.summariesGeneration) return;
    this.summariesLoading = false;
    if (!response.ok) this.summariesError = response.error.message;
    else this.summaries = response.value as SearchSummary[];
    this.changed();
  }
  private async pump(): Promise<void> {
    if (this.busy || !this.ready || !this.open || !this.online || this.composing || this.complete || this.error || this.hits.length >= this.targetCount) return;
    this.busy = true;
    this.loading = true;
    const generation = this.generation;
    const cursor = this.cursor;
    this.changed();
    let response;
    try { response = await this.bridge.request("code", "search_history", { query: this.query, scope: "workspace_chats", limit: Math.min(20, this.targetCount - this.hits.length), ...(cursor ? { cursor: searchCursorParams(cursor) } : {}) }); }
    catch { if (generation === this.generation) this.error = "聊天搜索失败，请重试。"; }
    this.busy = false;
    if (generation !== this.generation) { void this.pump(); return; }
    if (response && !response.ok) this.error = response.error.message;
    else if (response?.ok) {
      const page = response.value as SearchPage;
      const known = new Set(this.hits.map(hit => JSON.stringify([hit.sessionId, hit.entryId])));
      this.hits.push(...page.hits.filter(hit => !known.has(JSON.stringify([hit.sessionId, hit.entryId]))));
      this.complete = page.complete;
      this.cursor = page.cursor;
      if (!page.complete && (!page.cursor || JSON.stringify(page.cursor) === JSON.stringify(cursor))) this.error = "搜索进度未推进，请重新搜索。";
      for (const issue of page.sourceIssues ?? []) if (!this.sourceIssues.some(item => item.sessionId === issue.sessionId && item.code === issue.code)) this.sourceIssues.push(issue);
      for (const id of page.unindexedSessionIds) if (!this.unindexedSessionIds.includes(id)) this.unindexedSessionIds.push(id);
      if (page.progress) { this.progress.indexedBytes += page.progress.indexedBytes; this.progress.scannedBytes += page.progress.scannedBytes; }
    }
    this.loading = false;
    this.changed();
    if (!this.error && !this.complete && this.hits.length < this.targetCount) {
      this.loading = true;
      this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, 0);
    }
  }
}
