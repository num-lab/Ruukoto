import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../shared/bridge.ts";
import type { PersonalDesktopEvent, PersonalDesktopFrame, PersonalDesktopLive, PersonalTimelineEntry, PersonalTimelinePage } from "@ruukoto/view/personal-protocol.ts";
import type { OwnerAnswer, OwnerQuestionItem } from "@ruukoto/core/owner-question-input.ts";

type Identity = Extract<DesktopUpdate, { type: "personal_identity" }>["identity"];
type Receipt = { kind: "accepted" | "pending" | "missing"; requestId: string; status?: string; answer?: string };
type Question = { id: string; version: number; status: string; question: string; canAnswer: boolean; canCancel: boolean };
type QuestionDetail = { id: string; version: number; status: string; questions: OwnerQuestionItem[]; origin: { telegram?: unknown } };
type ApprovalKind = "tools" | "mcp" | "app-data" | "services";
export type PersonalApproval = { kind: ApprovalKind; key: string; operation?: number; ref?: { taskId: number }; canDecide: boolean; approval?: string; decision?: string; target?: string; tool?: string; name?: string; service?: string; unit?: string; status?: string };
type Work = { ref: { taskId: number; agentId: number; requestId: string }; label: string; content: string; state: string; cancelRequested: boolean; stopVerified: boolean; closed: boolean };
type List<T> = { items: T[]; nextOffset?: number };
type QueryKind = ApprovalKind | "questions" | "works";
type PermissionMode = "confirm" | "auto-review" | "full_access";
type HistoryBody = { entry: number; offset: number; text: string; nextOffset?: number };
const pathFor = { tools: "/tools/operations", mcp: "/mcp/operations", "app-data": "/app-data/operations", services: "/services", questions: "/questions", works: "/works" };
const emptyLive = (): PersonalDesktopLive => ({ tools: [], toolCount: 0, inbox: [], inboxCount: 0 });

// Note: 见 .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
export class PersonalState {
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "connecting" };
  identity: Identity | null = null;
  readonly view = { instanceId: null as string | null };
  entries = new Map<number, PersonalTimelineEntry>();
  bodies = new Map<number, string>();
  live = emptyLive();
  message: string | null = null;
  draft = "";
  draftMismatch = false;
  sending = false;
  checking = false;
  ready = false;
  loadingHistory = false;
  loadingBody = new Set<number>();
  pending: Extract<DesktopUpdate, { type: "personal_pending" }>["record"] = null;
  pendingResult: Receipt | null = null;
  questions: Question[] = [];
  approvals: PersonalApproval[] = [];
  works: Work[] = [];
  mode: PermissionMode = "auto-review";
  actionBusy = false;
  question: QuestionDetail | null = null;
  answers: OwnerAnswer[] = [];
  approval: { value: PersonalApproval; text: string; nextOffset?: number; complete: boolean } | null = null;
  work: { summary: Work; result: { text?: string; nextOffset?: number; state: string; next?: string; notice?: string } } | null = null;
  next: Partial<Record<QueryKind, number>> = {};
  private pages: Partial<Record<QueryKind, unknown[]>> = {};
  private generation = 0;
  private runId = "";
  private subscription = "";
  private seq = -1;
  private through = 0;
  private cursor: string | undefined;
  private polling: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private querying = new Set<QueryKind>();
  private disposed = false;
  constructor(private readonly bridge: Pick<DesktopBridge, "request">, readonly changed: () => void) {}
  get online() { return this.status.state === "online" && this.identity?.online === true && this.ready; }
  get busy() { return !!this.live.run || this.live.inboxCount > 0; }
  get canSend() { return this.online && !this.sending && !this.pending && !this.draftMismatch && !!this.draft.trim(); }
  get historyMore() { return !!this.cursor; }
  get timeline() { return [...this.entries.values()].sort((a, b) => a.entry - b.entry); }
  get activeMessage() { return this.live.generation?.message; }
  refresh() { this.changed(); }
  start() { this.disposed = false; this.timers(); }
  dispose() { this.disposed = true; ++this.generation; clearInterval(this.polling); this.polling = undefined; }
  visible() { if (this.online) { void this.refreshQueries(); void this.reconcile(); } }
  private timers() {
    clearInterval(this.polling); this.polling = undefined;
    if (this.online && !this.disposed) this.polling = setInterval(() => { if (this.pending) void this.reconcile(); if (this.busy || this.questions.some(value => value.status === "pending") || this.approvals.some(value => value.canDecide) || this.works.some(value => !["completed", "failed", "canceled", "faulted", "orphaned"].includes(value.state))) void this.refreshQueries(); }, 5000);
  }
  update(update: DesktopUpdate) {
    if (update.type === "state") {
      this.status = update;
      if (update.state !== "online") { ++this.generation; this.ready = false; this.reading = false; this.querying.clear(); this.loadingHistory = false; this.loadingBody.clear(); }
      this.timers();
    } else if (update.type === "personal_identity") {
      const key = JSON.stringify([update.identity.remoteId, update.identity.origin, update.identity.profile.id, update.identity.profile.directory]);
      if (this.view.instanceId !== key) {
        if (this.view.instanceId && this.draft) this.draftMismatch = true;
        ++this.generation; this.entries.clear(); this.bodies.clear(); this.live = emptyLive(); this.questions = []; this.approvals = []; this.works = []; this.pages = {}; this.next = {}; this.question = null; this.approval = null; this.work = null;
        this.view.instanceId = key; this.ready = false;
      }
      if (!update.identity.online || this.identity?.runId !== update.identity.runId) { ++this.generation; this.ready = false; this.reading = false; this.querying.clear(); }
      this.identity = update.identity;
      if (update.identity.runId) this.runId = update.identity.runId;
      this.timers();
    } else if (update.type === "personal_frame") this.frame(update.frame);
    else if (update.type === "personal_pending") { if (update.result?.kind === "accepted" && (update.record ?? this.pending)?.input === this.draft) this.draft = ""; this.pending = update.record; this.pendingResult = update.result ?? null; }
    else return;
    this.changed();
  }
  frame(frame: PersonalDesktopFrame) {
    if (this.status.state !== "online" || !this.identity || frame.runId !== this.identity.runId) return;
    if (frame.type === "snapshot") {
      ++this.generation; this.runId = frame.runId; this.subscription = frame.subscription; this.seq = frame.seq; this.through = frame.timeline.through; this.cursor = frame.timeline.nextCursor;
      for (const entry of frame.timeline.items) this.entries.set(entry.entry, entry);
      this.live = structuredClone(frame.live); this.ready = true; this.reading = false; this.querying.clear(); this.loadingHistory = false; this.loadingBody.clear();
      this.timers(); void this.refreshQueries(); void this.reconcile();
    } else {
      if (!this.ready || frame.runId !== this.runId || frame.subscription !== this.subscription) return;
      if (frame.seq <= this.seq) return;
      if (frame.seq !== this.seq + 1) { this.ready = false; this.message = "消息观察流需要重新同步。"; this.timers(); void this.request("reconnect", {}); return; }
      this.seq = frame.seq;
      for (const event of frame.events) this.event(event);
      if (frame.events.some(event => event.type === "run_end" || event.type === "tool_execution_end" || event.type === "submission")) void this.refreshQueries();
    }
    this.changed();
  }
  private event(event: PersonalDesktopEvent) {
    if (event.type === "message_end" || event.type === "entry_appended") { this.entries.set(event.entry.entry, event.entry); if (event.entry.role === "assistant" && this.live.generation) delete this.live.generation.message; }
    else if (event.type === "run_start") this.live.run = { inputs: event.inputs, total: event.total };
    else if (event.type === "run_end") { delete this.live.run; delete this.live.generation; this.live.tools = []; this.live.toolCount = 0; }
    else if (event.type === "inbox_update") { this.live.inbox = event.items; this.live.inboxCount = event.total; }
    else if (event.type === "message_start" && event.message.role === "assistant") this.live.generation = { attempt: this.live.generation?.attempt ?? 1, message: structuredClone(event.message) };
    else if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "message") { this.live.generation = { attempt: this.live.generation?.attempt ?? 1, message: structuredClone(change.message) }; continue; }
        const message = this.live.generation?.message; if (!message) continue;
        const blocks = message.blocks ??= [], index = blocks.findIndex(value => value.index === change.contentIndex);
        if ("block" in change) { const value = { ...change.block, index: change.contentIndex }; if (index >= 0) blocks[index] = value; else blocks.push(value); }
        else if (change.type === "toolcall_delta") message.truncated = true;
        else {
          let value = blocks[index];
          if (!value || value.type === "toolCall") { value = { index: change.contentIndex, type: change.type === "text_delta" ? "text" : "thinking", text: "", truncated: index < 0 }; blocks.push(value); }
          value.text = (value.text + change.delta).slice(0, 65536); value.truncated ||= change.truncated;
        }
        blocks.sort((a, b) => a.index - b.index);
        message.text = blocks.flatMap(value => value.type === "text" ? [value.text] : []).join("\n");
        message.thinking = blocks.flatMap(value => value.type === "thinking" ? [value.text] : []).join("\n");
        message.truncated ||= blocks.some(value => value.truncated);
      }
    } else if (event.type === "tool_execution_start") { this.live.tools.push({ callId: event.toolCallId, name: event.toolName, status: "running", taskId: event.taskId, truncated: event.truncated }); this.live.toolCount++; }
    else if (event.type === "tool_execution_update") {
      const tool = this.live.tools.find(value => value.callId === event.toolCallId);
      if (tool) { const output = event.output; if (output?.set !== undefined) tool.output = output.set; else if (output) tool.output = (tool.output ?? "").slice(output.trimStart ?? 0) + (output.append ?? ""); tool.output = tool.output?.slice(-65536); tool.truncated ||= event.truncated; }
    } else if (event.type === "tool_execution_end") {
      const tool = this.live.tools.find(value => value.callId === event.toolCallId); if (tool) { tool.status = "done"; if (event.entry) tool.entry = event.entry.entry; }
    } else if (event.type === "agent_changed") this.live.model = event.model;
    else if (event.type === "task_failed") this.message = event.message;
  }
  private async request<T>(op: string, params: Record<string, unknown>): Promise<DesktopResult<T>> {
    try { return await this.bridge.request("personal", op, params) as DesktopResult<T>; }
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "宿主应答丢失，请核实原请求；不会自动重新提交。" } }; }
  }
  private remote<T>(method: "GET" | "POST", path: string, body?: unknown) { return this.request<T>("desktop_personal_request", { method, path, ...(body === undefined ? {} : { body }) }); }
  edit(value: string) { this.draft = value; this.changed(); }
  discardDraft() { this.draft = ""; this.draftMismatch = false; this.changed(); }
  async send() {
    if (!this.canSend) return;
    if (new TextEncoder().encode(this.draft).byteLength > 16384) { this.message = "每条输入最多16 KiB，请缩短后再发送。"; this.changed(); return; }
    const text = this.draft, generation = this.generation; this.sending = true; this.changed();
    const result = await this.request<Receipt>("desktop_personal_input_submit", { text });
    this.sending = false;
    if (generation !== this.generation) return;
    if (!result.ok) this.message = result.error.message;
    else { this.pendingResult = result.value; if (result.value.kind === "accepted" && this.draft === text) this.draft = ""; }
    this.changed();
  }
  async reconcile(restore = false) {
    if (this.checking || this.status.state !== "online") return;
    const generation = this.generation; this.checking = true; this.changed();
    const result = await this.request<Receipt | null>(restore ? "desktop_personal_input_restore" : "desktop_personal_input_reconcile", {});
    if (generation !== this.generation) { this.checking = false; if (this.online && !this.disposed) void this.reconcile(); return; }
    this.checking = false;
    if (!result.ok) this.message = result.error.message;
    else { this.pendingResult = result.value; if (result.value?.kind === "accepted") { if (this.pending?.input === this.draft) this.draft = ""; this.pending = null; } }
    this.changed();
  }
  async older() {
    if (!this.online || !this.cursor || this.loadingHistory) return;
    const generation = this.generation, through = this.through, cursor = this.cursor; this.loadingHistory = true; this.changed();
    const result = await this.remote<PersonalTimelinePage>("GET", `/timeline?through=${through}&cursor=${encodeURIComponent(cursor)}`);
    if (generation !== this.generation) return;
    this.loadingHistory = false;
    if (!result.ok) this.message = result.error.message;
    else if (result.value.through === through) { for (const entry of result.value.items) if (!this.entries.has(entry.entry)) this.entries.set(entry.entry, entry); this.cursor = result.value.nextCursor; }
    this.changed();
  }
  async body(entry: number) {
    if (!this.online || this.loadingBody.has(entry)) return;
    const generation = this.generation; this.loadingBody.add(entry); this.changed();
    let offset: number | undefined = 0, text = "";
    while (offset !== undefined) {
      const result: DesktopResult<HistoryBody> = await this.remote<HistoryBody>("GET", `/history/entry?entry=${entry}&offset=${offset}`);
      if (generation !== this.generation) return;
      if (!result.ok) { this.message = result.error.message; break; }
      if (result.value.entry !== entry || result.value.offset !== offset || result.value.nextOffset !== undefined && result.value.nextOffset <= offset) { this.message = "消息正文不属于原读取，请重新同步。"; break; }
      text += result.value.text; offset = result.value.nextOffset;
      if (offset === undefined) this.bodies.set(entry, text);
    }
    this.loadingBody.delete(entry); this.changed();
  }
  async refreshQueries() {
    if (!this.online || this.reading) return;
    const generation = this.generation; this.reading = true;
    await Promise.all((Object.keys(pathFor) as QueryKind[]).map(kind => this.page(kind, 0, generation)));
    const result = await this.remote<{ default: { mode: PermissionMode } }>("GET", "/permissions");
    if (generation === this.generation) { if (result.ok) this.mode = result.value.default.mode; this.reading = false; this.changed(); }
  }
  async more(kind: QueryKind) { const offset = this.next[kind]; if (offset !== undefined && this.online) await this.page(kind, offset, this.generation); }
  private async page(kind: QueryKind, offset: number, generation: number) {
    if (this.querying.has(kind)) return;
    this.querying.add(kind);
    const result = await this.remote<List<unknown>>("GET", `${pathFor[kind]}?offset=${offset}`);
    if (generation !== this.generation) return;
    this.querying.delete(kind);
    if (!result.ok) { if (!["tools_config_missing", "mcp_config_missing", "service_config_missing"].includes(result.error.code)) this.message = result.error.message; return; }
    const items = offset ? [...(this.pages[kind] ?? []), ...result.value.items] : result.value.items;
    this.pages[kind] = items; this.next[kind] = result.value.nextOffset;
    if (kind === "questions") this.questions = items as Question[];
    else if (kind === "works") this.works = items as Work[];
    else this.approvals = (Object.keys(pathFor) as QueryKind[]).filter((key): key is ApprovalKind => key !== "questions" && key !== "works").flatMap(key => (this.pages[key] ?? []).map(value => { const item = value as Omit<PersonalApproval, "kind" | "key">; return { ...item, kind: key, key: `${key}:${item.operation ?? item.ref?.taskId}` }; }));
    this.changed();
  }
  async selectQuestion(id: string) {
    const generation = this.generation, result = await this.remote<QuestionDetail>("GET", `/question?question=${encodeURIComponent(id)}`);
    if (generation !== this.generation) return;
    if (result.ok) { this.question = result.value; this.answers = result.value.questions.map(() => ({ text: "" })); } else this.message = result.error.message;
    this.changed();
  }
  async answerQuestion(cancel = false) {
    const question = this.question; if (!question || this.actionBusy || question.status !== "pending" || !cancel && question.origin.telegram) return;
    const generation = this.generation, requestId = crypto.randomUUID(); this.actionBusy = true; this.changed();
    const result = await this.remote("POST", cancel ? "/question/cancel" : "/question/answer", { question: question.id, version: question.version, requestId, ...(cancel ? {} : { answers: this.answers }) });
    if (generation !== this.generation) { this.actionBusy = false; return; }
    if (!result.ok) { const receipt = await this.remote("GET", `/question/receipt?requestId=${requestId}`); this.message = receipt.ok && receipt.value ? "原问题决定已登记。" : result.error.message; }
    else this.question = null;
    this.actionBusy = false; await this.refreshQueries(); this.changed();
  }
  async selectApproval(value: PersonalApproval, more = false) {
    const generation = this.generation, offset = more && this.approval?.value.key === value.key ? this.approval.nextOffset ?? 0 : 0;
    const route = value.kind === "services" ? `/service?service=${value.ref!.taskId}` : `/${value.kind === "tools" ? "tools" : value.kind}/operation?operation=${value.operation}`;
    const result = await this.remote<{ text?: string; evidence?: string; nextOffset?: number }>("GET", `${route}&offset=${offset}`);
    if (generation !== this.generation) return;
    if (result.ok) this.approval = { value, text: (offset ? this.approval?.text ?? "" : "") + (result.value.text ?? result.value.evidence ?? ""), nextOffset: result.value.nextOffset, complete: result.value.nextOffset === undefined };
    else this.message = result.error.message;
    this.changed();
  }
  async decide(decision: "approved" | "rejected") {
    const selected = this.approval; if (!selected?.value.canDecide || !selected.complete || this.actionBusy) return;
    const value = selected.value, generation = this.generation; this.actionBusy = true; this.changed();
    const route = value.kind === "services" ? `/service/decide?service=${value.ref!.taskId}` : value.kind === "tools" ? "/tools/decide" : `/${value.kind}/decide?operation=${value.operation}`;
    const result = await this.remote("POST", route, { decision, ...(value.kind === "tools" ? { operation: value.operation } : {}) });
    if (generation !== this.generation) { this.actionBusy = false; return; }
    this.message = result.ok ? "本次决定已登记，请核实实际操作结果。" : result.error.message; this.approval = null; this.actionBusy = false; await this.refreshQueries(); this.changed();
  }
  async selectWork(value: Work, more = false) {
    const generation = this.generation, offset = more ? this.work?.result.nextOffset ?? 0 : 0;
    const result = await this.remote<NonNullable<PersonalState["work"]>>("GET", `/work?work=${value.ref.taskId}&offset=${offset}`);
    if (generation !== this.generation) return;
    if (result.ok) this.work = { ...result.value, result: { ...result.value.result, text: (offset ? this.work?.result.text ?? "" : "") + (result.value.result.text ?? "") } }; else this.message = result.error.message;
    this.changed();
  }
  async cancelWork(value: Work) { if (this.actionBusy || value.cancelRequested) return; this.actionBusy = true; const generation = this.generation, result = await this.remote("POST", `/work/cancel?work=${value.ref.taskId}`); if (generation !== this.generation) { this.actionBusy = false; return; } this.message = result.ok ? "已请求取消原工作，停止状态仍需核实。" : result.error.message; this.actionBusy = false; await this.refreshQueries(); this.changed(); }
  async setMode(mode: PermissionMode) { const generation = this.generation, result = await this.remote("POST", "/permissions", { mode }); if (generation !== this.generation) return; if (result.ok) this.mode = mode; else this.message = result.error.message; this.changed(); }
}
