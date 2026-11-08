import type { DesktopBridge, DesktopResult, DesktopUpdate } from "../shared/bridge.ts";
import type { PersonalSettingsSnapshot } from "../shared/personal-settings.ts";
import type { PersonalDesktopAction, PersonalDesktopActionName, PersonalDesktopActionReceipt, PersonalDesktopApproval, PersonalDesktopAttachment, PersonalDesktopDelegation, PersonalDesktopEvent, PersonalDesktopFamily, PersonalDesktopFrame, PersonalDesktopLive, PersonalDesktopOperation, PersonalDesktopOutput, PersonalDesktopQuestion, PersonalDesktopState, PersonalDesktopWork, PersonalTimelineEntry, PersonalTimelinePage } from "@ruukoto/view/personal-protocol.ts";
import type { PersonalInputDraft } from "../shared/personal-desktop.ts";
import { parseOwnerAnswers, parseOwnerQuestions, type OwnerAnswer, type OwnerQuestionItem } from "@ruukoto/core/owner-question-input.ts";
import { loadPersonalCuaImage, type CuaImagePage } from "./personal-cua-image.ts";

type Identity = Extract<DesktopUpdate, { type: "personal_identity" }>["identity"];
type Receipt = { kind: "accepted" | "pending" | "missing"; requestId: string; status?: string; answer?: string };
type Question = { id: string; version: number; status: string; question: string; canAnswer: boolean; canCancel: boolean };
export type QuestionDetail = { id: string; version: number; status: string; admission?: number; questions: OwnerQuestionItem[]; origin: { telegram?: unknown }; answer?: { answers: OwnerAnswer[] } };
export type PersonalQuestionDraft = { index: number; review: boolean; answers: OwnerAnswer[] };
type ApprovalKind = "tools" | "mcp" | "app-data" | "services";
export type PersonalApproval = { kind: ApprovalKind; key: string; operation?: number; ref?: { taskId: number }; canDecide: boolean; approval?: string; decision?: string; target?: string; tool?: string; name?: string; service?: string; unit?: string; status?: string };
type Work = Omit<PersonalDesktopWork, "progress"> & { progress?: PersonalDesktopWork["progress"] };
export type PersonalApprovalDetail = { text: string; nextOffset?: number; complete: boolean; admission: number; family?: PersonalDesktopFamily; error?: string };
type PersonalCardRef = Pick<PersonalDesktopApproval, "family" | "operation"> & { admission?: number };
export function personalCardKey(value: PersonalCardRef) { return `${value.family ?? "tools"}:${value.operation}`; }
export type PersonalPresentedMessage = PersonalTimelineEntry & { requestKey?: string; pendingStatus?: string; displayKey?: number };
type LocalInput = { text: string; attachments?: PersonalDesktopAttachment[]; timestamp: number; anchor: number; status?: string; requestId?: string };
type List<T> = { items: T[]; nextOffset?: number };
type QueryKind = ApprovalKind | "questions" | "works";
type PermissionMode = "confirm" | "auto-review" | "full_access";
type HistoryBody = { entry: number; offset: number; text: string; nextOffset?: number };
const pathFor = { tools: "/tools/operations", mcp: "/mcp/operations", "app-data": "/app-data/operations", services: "/services", questions: "/questions", works: "/works" };
const emptyLive = (): PersonalDesktopLive => ({ tools: [], toolCount: 0, inbox: [], inboxCount: 0 });
const sameAction = (left: PersonalDesktopAction, right: PersonalDesktopAction) => (["v", "requestId", "family", "operation", "admission", "occurrence", "action", "questionVersion", "observation", "check"] as const).every(key => left[key] === right[key]) && JSON.stringify(left.answers?.map(answer => [answer.text, answer.option, answer.options])) === JSON.stringify(right.answers?.map(answer => [answer.text, answer.option, answer.options]));

// Note: See .agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md
// Note: See .agents/notes/implemented/feature/2026-11-04-personal-desktop-file-loop.md
// Note: See .agents/notes/implemented/simplification/2026-11-07-personal-send-feedback.md
// Note: See .agents/notes/implemented/feature/2026-11-05-personal-desktop-decisions.md
// Note: See .agents/notes/implemented/architecture/2026-11-07-personal-inbound-attachments.md
export class PersonalState {
  status: Extract<DesktopUpdate, { type: "state" }> = { type: "state", state: "connecting" };
  identity: Identity | null = null;
  readonly view = { instanceId: null as string | null };
  entries = new Map<number, PersonalPresentedMessage>();
  private readonly messageAnimations = new Set<number>();
  private messagesVisible = false;
  bodies = new Map<number, string>();
  live = emptyLive();
  message: string | null = null;
  draft = "";
  attachments: PersonalDesktopAttachment[] = [];
  attachmentFailed = false;
  attaching = false;
  private draftId: string | undefined;
  private draftWrites: Promise<void> = Promise.resolve();
  draftMismatch = false;
  sending = false;
  checking = false;
  ready = false;
  loadingHistory = false;
  loadingBody = new Set<number>();
  outputBusy = false;
  readonly outputStatus = new Map<string, string>();
  pending: Extract<DesktopUpdate, { type: "personal_pending" }>["record"] = null;
  pendingResult: Receipt | null = null;
  questions: Question[] = [];
  approvals: PersonalApproval[] = [];
  works: Work[] = [];
  cards = new Map<number, PersonalDesktopApproval>();
  questionCards = new Map<number, PersonalDesktopQuestion>();
  readonly questionDetails = new Map<string, QuestionDetail>();
  private readonly questionDrafts = new Map<string, PersonalQuestionDraft>();
  private readonly questionLoading = new Map<string, Promise<boolean>>();
  private readonly questionRevisions = new Map<string, number>();
  readonly acting = new Set<string>();
  readonly uncertainActions = new Map<string, PersonalDesktopAction>();
  private readonly actionRefreshing = new Map<string, Promise<void>>();
  private hostActions = new Set<string>();
  readonly cuaImages = new Map<number, { observation: number; images: { id: string; src: string; loaded: boolean }[] }>();
  readonly cuaImageLoading = new Set<number>();
  private invalidatedObservations = new Map<number, number>();
  readonly details = new Map<string, PersonalApprovalDetail>();
  readonly deciding = new Set<number>();
  readonly uncertainDecisions = new Set<number>();
  delegations: PersonalDesktopDelegation[] = [];
  projectionNext: Partial<Record<"approvals" | "works" | "delegations" | "questions", number>> = {};
  projection = false;
  private revision = -1;
  private cardRevisions = new Map<string, number>();
  private detailLoading = new Map<string, Promise<boolean>>();
  readonly refreshingCards = new Set<string>();
  private projectionLoading = new Set<string>();
  private sent = new Map<string, LocalInput>();
  private submitting: LocalInput | null = null;
  private pendingDecisions = new Set<string>();
  readonly uncertainApprovals = new Set<string>();
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
  constructor(private readonly bridge: Pick<DesktopBridge, "request"> & Partial<Pick<DesktopBridge, "pickAttachments">>, readonly changed: () => void) {}
  get online() { return this.status.state === "online" && this.identity?.online === true && this.ready; }
  get busy() { return !!this.live.run || this.live.inboxCount > 0; }
  get canSend() { return this.online && !this.sending && !this.attaching && !this.attachmentFailed && !this.pending && !this.draftMismatch && (!!this.draft.trim() || this.attachments.length > 0); }
  get canAttach() { return this.online && !this.sending && !this.attaching && !this.pending && !this.draftMismatch && this.attachments.length < 4; }
  get historyMore() { return !!this.cursor; }
  get timeline(): PersonalPresentedMessage[] {
    const associated = new Set([...this.entries.values()].flatMap(entry => entry.input?.historyEntry === undefined ? [] : [entry.input.historyEntry]));
    const entries = [...this.entries.values()].filter(entry => !associated.has(entry.entry)).map(entry => ({ ...entry, requestKey: entry.input?.requestId }));
    // Legacy history has no request keys for merging local message placeholders.
    if (!this.projection) return entries.sort((a, b) => a.entry - b.entry);
    const received = new Set(entries.flatMap(entry => entry.requestKey ? [entry.requestKey] : []));
    const local = [...this.sent];
    if (this.submitting && !this.submitting.requestId) local.push(["", this.submitting]);
    const pending: PersonalPresentedMessage[] = local.filter(([key]) => !received.has(key)).map(([requestKey, value]) => ({ entry: value.anchor, displayKey: value.anchor, conversation: 0, kind: "local-input", role: "user", text: value.text, ...(value.attachments?.length ? { attachments: value.attachments } : {}), timestamp: value.timestamp, partial: false, truncated: false, requestKey: requestKey || undefined, pendingStatus: value.status }));
    return [...entries, ...pending].sort((a, b) => a.entry - b.entry);
  }
  get activeMessage() { return this.live.generation?.message; }
  refresh() { this.changed(); }
  start() { this.disposed = false; this.timers(); }
  dispose() { this.hidden(); this.disposed = true; ++this.generation; clearInterval(this.polling); this.polling = undefined; }
  visible() { this.messagesVisible = true; if (this.online) { void this.refreshQueries(); void this.reconcile(); } }
  hidden() { this.messagesVisible = false; this.messageAnimations.clear(); }
  takeMessageAnimation(key: number) {
    if (this.submitting && !this.submitting.requestId && this.entries.get(key)?.input) return false;
    return this.messageAnimations.delete(key);
  }
  private timers() {
    clearInterval(this.polling); this.polling = undefined;
    if (this.online && !this.disposed) this.polling = setInterval(() => { if (this.pending) void this.reconcile(); for (const action of this.uncertainActions.values()) void this.inspectAction(action); if (!this.projection && (this.busy || this.questions.some(value => value.status === "pending") || this.approvals.some(value => value.canDecide) || this.works.some(value => !["completed", "failed", "aborted", "faulted", "orphaned"].includes(value.state)))) void this.refreshQueries(); }, 5000);
  }
  update(update: DesktopUpdate) {
    if (update.type === "state") {
      this.status = update;
      if (update.state !== "online") { ++this.generation; this.messageAnimations.clear(); this.submitting = null; this.detailLoading.clear(); this.questionLoading.clear(); this.actionRefreshing.clear(); this.projectionLoading.clear(); this.ready = false; this.reading = false; this.querying.clear(); this.loadingHistory = false; this.loadingBody.clear(); }
      this.timers();
    } else if (update.type === "personal_identity") {
      const key = JSON.stringify([update.identity.remoteId, update.identity.origin, update.identity.profile.id, update.identity.profile.directory]);
      if (this.view.instanceId !== key) {
        if (this.view.instanceId && (this.draft || this.attachments.length || this.attachmentFailed)) this.draftMismatch = true;
        ++this.generation; this.entries.clear(); this.messageAnimations.clear(); this.bodies.clear(); this.live = emptyLive(); this.questions = []; this.approvals = []; this.works = []; this.pages = {}; this.next = {}; this.question = null; this.approval = null; this.work = null;
        this.cards.clear(); this.details.clear(); this.detailLoading.clear(); this.deciding.clear(); this.uncertainDecisions.clear(); this.pendingDecisions.clear(); this.uncertainApprovals.clear(); this.refreshingCards.clear(); this.sent.clear(); this.submitting = null; this.cardRevisions.clear(); this.projection = false; this.revision = -1; this.delegations = []; this.projectionNext = {};
        this.questionCards.clear(); this.questionDetails.clear(); this.questionDrafts.clear(); this.questionLoading.clear(); this.questionRevisions.clear(); this.acting.clear(); this.uncertainActions.clear(); this.actionRefreshing.clear(); this.hostActions.clear(); this.cuaImages.clear(); this.cuaImageLoading.clear(); this.invalidatedObservations.clear();
        this.outputStatus.clear();
        this.view.instanceId = key; this.ready = false;
      }
      if (!update.identity.online || this.identity?.runId !== update.identity.runId) { ++this.generation; this.messageAnimations.clear(); this.submitting = null; this.ready = false; this.reading = false; this.querying.clear(); this.revision = -1; this.cardRevisions.clear(); this.detailLoading.clear(); this.questionLoading.clear(); this.actionRefreshing.clear(); this.projectionLoading.clear(); }
      this.identity = update.identity;
      if (update.identity.runId) this.runId = update.identity.runId;
      this.timers();
    } else if (update.type === "personal_frame") this.frame(update.frame);
    else if (update.type === "personal_draft") this.installDraft(update.draft);
    else if (update.type === "personal_pending") {
      const record = update.record ?? this.pending;
      if (record) this.rememberInput(record.requestId, record.input, update.result?.kind === "accepted" ? update.result.status : "checking", record.attachments);
      if (update.result?.kind === "accepted" && record?.input === this.draft && JSON.stringify(record.attachments ?? []) === JSON.stringify(this.attachments)) { this.draft = ""; this.attachments = []; }
      this.pending = update.record; this.pendingResult = update.result ?? null;
    }
    else if (update.type === "personal_decisions") {
      const next = new Set(update.items.map(value => `${value.kind}:${value.operation}`));
      for (const key of this.pendingDecisions) if (!next.has(key)) { this.uncertainApprovals.delete(key); if (key.startsWith("tools:")) this.uncertainDecisions.delete(Number(key.slice(6))); }
      this.pendingDecisions = next;
      for (const value of update.items) { this.uncertainApprovals.add(`${value.kind}:${value.operation}`); if (value.kind === "tools") this.uncertainDecisions.add(value.operation); }
    }
    else if (update.type === "personal_actions") {
      const next = new Set(update.items.map(personalCardKey));
      for (const key of this.hostActions) if (!next.has(key)) { const request = this.uncertainActions.get(key); if (request) void this.refreshAction(request); }
      this.hostActions = next;
      for (const value of update.items) {
        this.uncertainActions.set(personalCardKey(value), value);
        if (value.family === "questions" && value.answers && value.questionVersion) this.questionDrafts.set(`${value.operation}:${value.questionVersion}`, { index: 0, review: true, answers: structuredClone(value.answers) });
      }
    }
    else return;
    this.changed();
  }
  frame(frame: PersonalDesktopFrame) {
    if (this.status.state !== "online" || !this.identity || frame.runId !== this.identity.runId) return;
    if (frame.type === "snapshot") {
      this.messageAnimations.clear();
      ++this.generation; this.submitting = null; this.detailLoading.clear(); this.questionLoading.clear(); this.actionRefreshing.clear(); this.projectionLoading.clear(); this.runId = frame.runId; this.subscription = frame.subscription; this.seq = frame.seq; this.through = frame.timeline.through; this.cursor = frame.timeline.nextCursor;
      for (const entry of frame.timeline.items) this.installEntry(entry);
      this.live = structuredClone(frame.live); this.ready = true; this.reading = false; this.querying.clear(); this.loadingHistory = false; this.loadingBody.clear();
      this.projection = frame.state !== undefined;
      if (frame.state) this.installProjection(frame.state);
      void this.inspectSnapshot(frame);
      this.timers(); void this.refreshQueries(); void this.reconcile();
    } else {
      if (!this.ready || frame.runId !== this.runId || frame.subscription !== this.subscription) return;
      if (frame.seq <= this.seq) return;
      if (frame.seq !== this.seq + 1) { this.ready = false; this.message = "The message observation stream needs resyncing."; this.timers(); void this.request("reconnect", {}); return; }
      this.seq = frame.seq;
      for (const event of frame.events) this.event(event);
      if (frame.events.some(event => event.type === "run_end" || event.type === "tool_execution_end" || event.type === "submission")) void this.refreshQueries();
    }
    this.changed();
  }
  private event(event: PersonalDesktopEvent) {
    if (event.type === "personal_state") this.installProjection(event.state);
    else if (event.type === "message_end" || event.type === "entry_appended") { this.installEntry(event.entry, true); if (event.entry.role === "assistant" && this.live.generation) delete this.live.generation.message; }
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
    catch { return { ok: false, error: { code: "bridge_unavailable", outcome: "unknown", message: "The host response was lost; verify the original request. It won't be resubmitted automatically." } }; }
  }
  private remote<T>(method: "GET" | "POST", path: string, body?: unknown) { return this.request<T>("desktop_personal_request", { method, path, ...(body === undefined ? {} : { body }) }); }
  async output(value: PersonalDesktopOutput, action: "preview" | "save") {
    if (!this.online || this.outputBusy || value.partial || value.bytes > 8 * 1024 * 1024 || !this.entries.get(value.publication)?.outputs?.some(saved => saved.output === value.output)) return;
    const generation = this.generation, identity = this.identity!, key = `${value.publication}:${value.output}`;
    this.outputBusy = true; this.outputStatus.delete(key); this.changed();
    const result = await this.request<{ state: "saved" | "previewed" | "canceled" }>(`desktop_personal_output_${action}`, { origin: identity.origin, remoteId: identity.remoteId, profileId: identity.profile.id, publication: value.publication, output: value.output });
    this.outputBusy = false;
    if (generation !== this.generation) { this.changed(); return; }
    if (!result.ok) this.outputStatus.set(key, result.error.message);
    else if (result.value.state === "saved") this.outputStatus.set(key, "File saved");
    this.changed();
  }
  private installDraft(value: PersonalInputDraft) {
    if (this.draftMismatch || value.origin !== this.identity?.origin || value.remoteId !== this.identity.remoteId || value.profile.id !== this.identity.profile.id || value.profile.directory !== this.identity.profile.directory) return;
    this.draftId = value.id; this.draft = value.input; this.attachments = structuredClone(value.attachments); this.attachmentFailed = value.failed;
  }
  edit(value: string) {
    this.draft = value; this.changed();
    const id = this.draftId, instance = this.view.instanceId;
    if (!id || this.draftMismatch || new TextEncoder().encode(value).byteLength > 16384) return;
    this.draftWrites = this.draftWrites.then(async () => {
      if (instance !== this.view.instanceId || id !== this.draftId) return;
      const result = await this.request<PersonalInputDraft>("desktop_personal_draft_save", { id, text: value });
      if (!result.ok && instance === this.view.instanceId) { this.attachmentFailed = true; this.message = result.error.message; this.changed(); }
    });
  }
  async discardDraft() {
    if (this.sending || this.attaching || this.pending) return;
    if (this.draftId) await this.draftWrites;
    if (this.draftMismatch) { this.draft = ""; this.attachments = []; this.attachmentFailed = false; this.draftMismatch = false; this.draftId = undefined; }
    const result = await this.request<PersonalInputDraft>("desktop_personal_draft_read", {});
    const id = result.ok && result.value?.id || this.draftId;
    if (id) {
      const discarded = await this.request<PersonalInputDraft>("desktop_personal_draft_discard", { id });
      if (!discarded.ok) { this.message = discarded.error.message; this.changed(); return; }
      if (discarded.value) this.installDraft(discarded.value);
    } else { this.draft = ""; this.attachments = []; this.attachmentFailed = false; this.draftMismatch = false; }
    this.changed();
  }
  async attach() {
    if (!this.canAttach || !this.bridge.pickAttachments) return;
    const generation = this.generation; this.attaching = true; this.changed();
    try {
      await this.draftWrites;
      if (!this.draftId) {
        const result = await this.request<PersonalInputDraft>("desktop_personal_draft_read", {});
        if (!result.ok || !result.value) { this.attachmentFailed = true; this.message = result.ok ? "The original draft is unavailable. Reconnect and choose attachments again." : result.error.message; return; }
        if (generation !== this.generation) return;
        const text = this.draft; this.installDraft(result.value);
        if (text !== this.draft) { this.draft = text; const saved = await this.request<PersonalInputDraft>("desktop_personal_draft_save", { id: this.draftId, text }); if (!saved.ok) { this.attachmentFailed = true; this.message = saved.error.message; return; } }
      }
      if (generation !== this.generation || !this.draftId) return;
      const result = await this.bridge.pickAttachments(this.draftId, "personal");
      if (generation !== this.generation) return;
      if (!result.ok) { this.attachmentFailed = true; this.message = result.error.message; }
      else {
        const saved = await this.request<PersonalInputDraft>("desktop_personal_draft_read", {});
        if (generation !== this.generation) return;
        if (saved.ok && saved.value) this.installDraft(saved.value);
        else { this.attachmentFailed = true; this.message = saved.ok ? "Attachment state unverified. Reconnect and read the original draft." : saved.error.message; }
      }
    } catch { if (generation === this.generation) { this.attachmentFailed = true; this.message = "Attachment preparation interrupted; this input wasn't sent. Choose the attachments again."; } }
    finally { this.attaching = false; this.changed(); }
  }
  async removeAttachment(attachmentId: string) {
    if (!this.online || this.draftMismatch || this.attaching || this.sending || this.pending || !this.draftId) return;
    await this.draftWrites;
    const generation = this.generation, result = await this.request<PersonalInputDraft>("desktop_personal_attachment_remove", { id: this.draftId, attachmentId });
    if (generation !== this.generation) return;
    if (result.ok) this.installDraft(result.value); else this.message = result.error.message;
    this.changed();
  }
  async send() {
    if (!this.canSend) return;
    if (new TextEncoder().encode(this.draft).byteLength > 16384) { this.message = "Each input is limited to 16 KiB. Shorten it and send again."; this.changed(); return; }
    const text = this.draft, attachments = structuredClone(this.attachments), generation = this.generation;
    const submitting: LocalInput = { text, attachments, timestamp: Date.now(), anchor: this.inputAnchor(), status: "checking" };
    if (this.messagesVisible && this.projection) this.messageAnimations.add(submitting.anchor);
    this.submitting = submitting; this.sending = true; this.changed();
    if (this.draftId) await this.draftWrites;
    if (generation !== this.generation || this.attachmentFailed) { this.messageAnimations.delete(submitting.anchor); if (this.submitting === submitting) this.submitting = null; this.sending = false; this.changed(); return; }
    const result = await this.request<Receipt>("desktop_personal_input_submit", { text, ...(attachments.length ? { attachments } : {}), ...(this.draftId ? { draftId: this.draftId } : {}) });
    this.sending = false;
    if (generation !== this.generation) { if (this.submitting === submitting) this.submitting = null; return; }
    if (!result.ok) { this.messageAnimations.delete(submitting.anchor); this.message = result.error.message; if (submitting.requestId && this.pending?.requestId !== submitting.requestId && ["not_sent", "rejected"].includes(result.error.outcome)) this.sent.delete(submitting.requestId); }
    else { this.pendingResult = result.value; if (result.value.kind === "accepted") { this.rememberInput(result.value.requestId, text, result.value.status, attachments); if (this.draft === text && JSON.stringify(this.attachments) === JSON.stringify(attachments)) { this.draft = ""; this.attachments = []; } } }
    if (this.submitting === submitting) this.submitting = null;
    this.changed();
  }
  private inputAnchor() {
    const anchor = Math.max(0, ...this.entries.keys(), ...[...this.cards.values()].map(card => card.occurrence));
    return Math.max(anchor + .5, ...[...this.sent.values()].map(value => value.anchor + .001));
  }
  private rememberInput(requestId: string, text: string, status?: string, attachments?: PersonalDesktopAttachment[]) {
    if (this.submitting && !this.submitting.requestId) this.submitting.requestId = requestId;
    const canonical = [...this.entries.values()].find(entry => entry.input?.requestId === requestId);
    if (canonical) {
      if (this.submitting?.requestId === requestId) {
        if (canonical.displayKey !== this.submitting.anchor) this.messageAnimations.delete(canonical.displayKey ?? canonical.entry);
        canonical.displayKey = this.submitting.anchor;
      }
      this.bodies.set(canonical.entry, text); return;
    }
    const previous = this.sent.get(requestId) ?? (this.submitting?.requestId === requestId ? this.submitting : null);
    this.sent.set(requestId, { text, ...(attachments?.length ? { attachments: structuredClone(attachments) } : {}), timestamp: previous?.timestamp ?? Date.now(), anchor: previous?.anchor ?? this.inputAnchor(), status });
  }
  async reconcile(restore = false) {
    if (this.checking || this.status.state !== "online") return;
    const generation = this.generation; this.checking = true; this.changed();
    const result = await this.request<Receipt | null>(restore ? "desktop_personal_input_restore" : "desktop_personal_input_reconcile", {});
    if (generation !== this.generation) { this.checking = false; if (this.online && !this.disposed) void this.reconcile(); return; }
    this.checking = false;
    if (!result.ok) this.message = result.error.message;
    else { this.pendingResult = result.value; if (result.value?.kind === "accepted") { const local = this.sent.get(result.value.requestId); if (local) local.status = result.value.status; if (this.pending?.input === this.draft) this.draft = ""; this.pending = null; } }
    this.changed();
  }
  async older() {
    if (!this.online || !this.cursor || this.loadingHistory) return;
    const generation = this.generation, through = this.through, cursor = this.cursor; this.loadingHistory = true; this.changed();
    const result = await this.remote<PersonalTimelinePage>("GET", `/timeline?through=${through}&cursor=${encodeURIComponent(cursor)}`);
    if (generation !== this.generation) return;
    this.loadingHistory = false;
    if (!result.ok) this.message = result.error.message;
    else if (result.value.through === through) { for (const entry of result.value.items) this.installEntry(entry); this.cursor = result.value.nextCursor; }
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
      if (result.value.entry !== entry || result.value.offset !== offset || result.value.nextOffset !== undefined && result.value.nextOffset <= offset) { this.message = "The message body doesn't belong to the original read. Resync."; break; }
      text += result.value.text; offset = result.value.nextOffset;
      if (offset === undefined) this.bodies.set(entry, text);
    }
    this.loadingBody.delete(entry); this.changed();
  }
  async refreshQueries() {
    if (!this.online || this.reading) return;
    const generation = this.generation; this.reading = true;
    await Promise.all((Object.keys(pathFor) as QueryKind[]).filter(kind => !this.projection || kind === "questions" && !this.questionCards.size).map(kind => this.page(kind, 0, generation)));
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
    if (this.projection && (kind === "works" || kind === "tools")) return;
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
    if (!result.ok) { const receipt = await this.remote("GET", `/question/receipt?requestId=${requestId}`); this.message = receipt.ok && receipt.value ? "The original question decision is recorded." : result.error.message; }
    else this.question = null;
    this.actionBusy = false; await this.refreshQueries(); this.changed();
  }
  async selectApproval(value: PersonalApproval, more = false) {
    const generation = this.generation, offset = more && this.approval?.value.key === value.key ? this.approval.nextOffset ?? 0 : 0;
    if (this.approval?.value.key === value.key) { this.approval = { ...this.approval, complete: false }; this.changed(); }
    const route = value.kind === "services" ? `/service?service=${value.ref!.taskId}` : `/${value.kind === "tools" ? "tools" : value.kind}/operation?operation=${value.operation}`;
    const result = await this.remote<{ summary?: Omit<PersonalApproval, "kind" | "key">; text?: string; evidence?: string; nextOffset?: number }>("GET", `${route}&offset=${offset}`);
    if (generation !== this.generation) return;
    if (result.ok) {
      const summary = result.value.summary, matches = summary && (value.kind === "services" ? summary.ref?.taskId === value.ref?.taskId : summary.operation === value.operation);
      const canonical = matches ? { ...value, ...summary } : { ...value, canDecide: false };
      if (matches && !canonical.canDecide) this.uncertainApprovals.delete(value.key);
      this.approval = { value: canonical, text: (offset ? this.approval?.text ?? "" : "") + (result.value.text ?? result.value.evidence ?? ""), nextOffset: result.value.nextOffset, complete: result.value.nextOffset === undefined };
    }
    else this.message = result.error.message;
    this.changed();
  }
  async decide(decision: "approved" | "rejected") {
    const selected = this.approval; if (!selected?.value.canDecide || !selected.complete || this.actionBusy || this.uncertainApprovals.has(selected.value.key)) return;
    const value = selected.value, generation = this.generation; this.actionBusy = true; this.uncertainApprovals.add(value.key); this.changed();
    const route = value.kind === "services" ? `/service/decide?service=${value.ref!.taskId}` : value.kind === "tools" ? "/tools/decide" : `/${value.kind}/decide?operation=${value.operation}`;
    const result = await this.remote("POST", route, { decision, ...(value.kind === "tools" ? { operation: value.operation } : {}) });
    if (generation !== this.generation) { this.actionBusy = false; return; }
    this.message = result.ok ? "This decision is recorded; verify the actual operation outcome." : result.error.message;
    if (!result.ok && result.error.outcome === "not_sent") this.uncertainApprovals.delete(value.key);
    this.actionBusy = false; await this.selectApproval(value); await this.refreshQueries(); this.changed();
  }
  private installCard(value: PersonalDesktopApproval, revision: number) {
    const key = personalCardKey(value), family = value.family ?? "tools";
    if (revision < (this.cardRevisions.get(key) ?? -1)) return;
    this.cardRevisions.set(key, revision);
    const detail = this.details.get(key);
    if (detail && detail.admission !== value.admission) { this.details.delete(key); this.detailLoading.delete(key); }
    for (const [id, card] of this.cards) if (personalCardKey(card) === key && card.admission === value.admission) this.cards.set(id, { ...value, occurrence: card.occurrence });
    this.cards.set(value.occurrence, value);
    if (family === "mcp" && this.cuaImages.get(value.operation)?.observation !== value.observation) this.cuaImages.delete(value.operation);
    this.refreshingCards.delete(key);
    if (!value.canDecide) { this.uncertainApprovals.delete(key); if (family === "tools") this.uncertainDecisions.delete(value.operation); }
  }
  private installEntry(entry: PersonalTimelineEntry, live = false) {
    const old = this.entries.get(entry.entry), status = (value: string) => value === "queued" ? 0 : value === "placed" ? 1 : 2;
    if (old?.input && entry.input && status(old.input.status) > status(entry.input.status)) return;
    const local = entry.input ? this.sent.get(entry.input.requestId) : undefined;
    const displayKey = old?.displayKey ?? local?.anchor ?? entry.entry;
    this.entries.set(entry.entry, { ...entry, displayKey });
    const visible = (value: PersonalTimelineEntry) => !value.partial && (value.role === "user" || value.role === "assistant") && (!!value.text.trim() || value.truncated || !!value.outputs?.length || !!value.attachments?.length);
    if (live && this.messagesVisible && !local && visible(entry) && (!old || !visible(old))) this.messageAnimations.add(displayKey);
    if (entry.input) {
      if (local) this.bodies.set(entry.entry, local.text);
      this.sent.delete(entry.input.requestId);
      if (entry.input.historyEntry !== undefined) this.messageAnimations.delete(entry.input.historyEntry);
    }
  }
  private async inspectSnapshot(frame: Extract<PersonalDesktopFrame, { type: "snapshot" }>) {
    const generation = this.generation;
    const originals = new Map<string, PersonalCardRef>([...this.cards.values()].map(value => [personalCardKey(value), value]));
    for (const operation of this.uncertainDecisions) { const value = { family: "tools" as const, operation }; if (!originals.has(personalCardKey(value))) originals.set(personalCardKey(value), value); }
    const operations = [...originals.values()].filter(value => !this.details.has(personalCardKey(value)) || !frame.state?.approvals.items.some(card => personalCardKey(card) === personalCardKey(value) && (value.admission === undefined || card.admission === value.admission)));
    const inputs = [...this.entries.values()].filter(entry => entry.input && (entry.input.status === "queued" || entry.input.status === "placed") && !frame.timeline.items.some(value => value.entry === entry.entry));
    for (const value of operations) this.refreshingCards.add(personalCardKey(value));
    const questions = [...new Map([...this.questionCards.values()].map(question => [question.id, question])).values()].filter(question => !frame.state?.questions?.items.some(value => value.id === question.id));
    const reads = [...operations.map(value => () => this.loadCard(value)), ...questions.map(question => () => this.loadQuestion(question)), ...inputs.map(entry => async () => {
      const result = await this.remote<{ v: 1; revision: number; entry: PersonalTimelineEntry | null }>("GET", `/desktop/input?requestId=${encodeURIComponent(entry.input!.requestId)}`);
      if (generation !== this.generation) return;
      if (result.ok && result.value.entry?.input?.requestId === entry.input!.requestId) this.installEntry(result.value.entry);
      else if (result.ok) this.message = result.value.entry === null ? "The original message's admission record is missing. Verify the original backend archive." : "The original message display record doesn't match the request. Resync.";
      else if (!result.ok) this.message = result.error.message;
    })];
    for (let index = 0; index < reads.length && generation === this.generation; index += 4) await Promise.all(reads.slice(index, index + 4).map(read => read()));
    if (generation === this.generation) this.changed();
  }
  private installProjection(value: PersonalDesktopState, kind?: "approvals" | "works" | "delegations" | "questions") {
    if (value.revision < this.revision) return;
    this.projection = true; this.revision = value.revision;
    for (const card of [...value.approvals.items, ...(value.approvalUpdates ?? [])]) this.installCard(card, value.revision);
    for (const question of [...value.questions?.items ?? [], ...value.questionUpdates ?? []]) this.installQuestion(question, value.revision);
    if (!kind || kind === "works") this.works = kind === "works" ? [...this.works.filter(work => !value.works.items.some(item => item.ref.taskId === work.ref.taskId)), ...value.works.items] : value.works.items;
    if (!kind || kind === "delegations") this.delegations = kind === "delegations" ? [...this.delegations.filter(group => !value.delegations.items.some(item => item.ref.entryId === group.ref.entryId)), ...value.delegations.items] : value.delegations.items;
    for (const key of ["approvals", "works", "delegations", "questions"] as const) if (!kind || kind === key) this.projectionNext[key] = value[key]?.nextOffset;
  }
  async moreProjection(kind: "approvals" | "works" | "delegations" | "questions") {
    const offset = this.projectionNext[kind]; if (!this.online || offset === undefined || this.projectionLoading.has(kind)) return;
    this.projectionLoading.add(kind); const generation = this.generation;
    const result = await this.remote<PersonalDesktopState>("GET", `/desktop/state?${kind}=${offset}`);
    this.projectionLoading.delete(kind);
    if (generation !== this.generation) return;
    if (result.ok) this.installProjection(result.value, kind); else this.message = result.error.message;
    this.changed();
  }
  async loadCard(value: PersonalCardRef, more = false) {
    if (!this.online) return false;
    const key = personalCardKey(value), { operation, family = "tools" } = value;
    const loading = this.detailLoading.get(key); if (loading) return loading;
    const previous = this.details.get(key), offset = more ? previous?.nextOffset ?? 0 : 0, generation = this.generation;
    const pending: Promise<boolean> = this.remote<PersonalDesktopOperation>("GET", `/desktop/operation?family=${family}&operation=${operation}&offset=${offset}`).then(result => {
      if (generation !== this.generation || this.detailLoading.get(key) !== pending) return false;
      let verified = false;
      this.detailLoading.delete(key);
      if (!result.ok) this.details.set(key, { text: previous?.text ?? "", complete: false, admission: value.admission ?? previous?.admission ?? 0, family, error: result.error.message });
      else if (result.value.operation !== operation || result.value.summary.operation !== operation || personalCardKey(result.value.summary) !== key || result.value.summary.admission !== result.value.admission || value.admission !== undefined && result.value.admission !== value.admission || result.value.offset !== offset || result.value.nextOffset !== undefined && result.value.nextOffset <= offset) this.message = "The operation record doesn't belong to the original read. Verify again.";
      else if (offset && previous?.admission !== result.value.admission) this.details.set(key, { text: "", complete: false, admission: result.value.admission, family, error: "The operation content's original record is inconsistent. Read it again." });
      else {
        if (result.value.revision >= (this.cardRevisions.get(key) ?? -1)) { this.installCard(result.value.summary, result.value.revision); this.refreshingCards.delete(key); }
        this.details.set(key, { text: (offset ? previous?.text ?? "" : "") + result.value.text, complete: result.value.nextOffset === undefined, admission: result.value.admission, family, nextOffset: result.value.nextOffset });
        verified = true;
      }
      this.changed();
      return verified;
    });
    this.detailLoading.set(key, pending); return pending;
  }
  actionBlocked(family: PersonalDesktopFamily, operation: number) { const key = personalCardKey({ family, operation }); return !this.online || this.acting.has(key) || this.uncertainActions.has(key) || this.uncertainApprovals.has(key); }
  private installQuestion(value: PersonalDesktopQuestion, revision: number) {
    if (revision < (this.questionRevisions.get(value.id) ?? -1)) return;
    this.questionRevisions.set(value.id, revision);
    for (const [id, question] of this.questionCards) if (question.id === value.id) this.questionCards.set(id, { ...value, occurrence: question.occurrence });
    this.questionCards.set(value.occurrence, value);
  }
  questionDraft(value: PersonalDesktopQuestion): PersonalQuestionDraft {
    const key = `${value.id}:${value.version}`;
    let draft = this.questionDrafts.get(key);
    if (!draft) { draft = { index: 0, review: false, answers: this.questionDetails.get(value.id)?.questions.map(() => ({ text: "" })) ?? [] }; this.questionDrafts.set(key, draft); }
    return draft;
  }
  async loadQuestion(value: Pick<PersonalDesktopQuestion, "id" | "admission" | "version">) {
    if (!this.online) return false;
    const key = `${value.id}:${value.version}`, pending = this.questionLoading.get(key); if (pending) return pending;
    const generation = this.generation;
    const reading = this.remote<QuestionDetail>("GET", `/question?question=${value.id}`).then(result => {
      if (generation !== this.generation) return false;
      this.questionLoading.delete(key);
      if (!result.ok) { this.message = result.error.message; this.changed(); return false; }
      const detail = result.value;
      const canonical = [...this.questionCards.values()].find(question => question.id === value.id), status = detail.status;
      if (detail.id !== value.id || detail.admission !== value.admission || !Number.isSafeInteger(detail.version) || detail.version < Math.max(value.version, canonical?.version ?? 0) || !["pending", "answered", "canceled", "stale"].includes(status)) { this.message = "The question state changed. Refresh the original card."; this.changed(); return false; }
      try { detail.questions = parseOwnerQuestions(detail.questions); if (detail.answer) detail.answer.answers = parseOwnerAnswers(detail.answer.answers, detail.questions); }
      catch { this.message = "The original question content is unverified. Keep the card and read it again."; this.changed(); return false; }
      this.installQuestion({ ...(canonical ?? { id: detail.id, admission: value.admission, occurrence: value.admission, question: Array.from(detail.questions[0].question).slice(0, 140).join("") }), version: detail.version, status: status as PersonalDesktopQuestion["status"], canAnswer: status === "pending" && !detail.origin.telegram, canCancel: status === "pending" }, this.questionRevisions.get(value.id) ?? this.revision);
      this.questionDetails.set(value.id, detail);
      const draft = this.questionDrafts.get(`${value.id}:${detail.version}`);
      if (draft && draft.answers.length !== detail.questions.length) draft.answers = detail.questions.map(() => ({ text: "" }));
      this.changed();
      return true;
    });
    this.questionLoading.set(key, reading); return reading;
  }
  chooseQuestion(value: PersonalDesktopQuestion, selected: number | number[]) {
    if (!value.canAnswer || this.actionBlocked("questions", Number(value.id))) return;
    const detail = this.questionDetails.get(value.id), draft = this.questionDraft(value), item = detail?.questions[draft.index];
    if (!item?.options) return;
    const indexes = (typeof selected === "number" ? [selected] : selected).toSorted((a, b) => a - b);
    if (indexes.some(index => index < 0 || index >= item.options!.length)) return;
    const labels = indexes.map(index => typeof item.options![index] === "string" ? item.options![index] : item.options![index].label);
    draft.answers[draft.index] = { text: labels.join("\n"), ...(indexes.length ? item.multiple ? { options: indexes } : { option: indexes[0] } : {}) };
    this.changed();
    if (!item.multiple && indexes.length) {
      if (detail!.questions.length === 1) void this.answerCard(value);
      else this.nextQuestion(value);
    }
  }
  editQuestion(value: PersonalDesktopQuestion, text: string) { const draft = this.questionDraft(value); draft.answers[draft.index] = { text }; this.changed(); }
  nextQuestion(value: PersonalDesktopQuestion, skip = false) {
    const draft = this.questionDraft(value), detail = this.questionDetails.get(value.id); if (!detail) return;
    if (skip) draft.answers[draft.index] = { text: "" };
    else if (!draft.answers[draft.index]?.text.trim()) return;
    if (detail.questions.length === 1) { void this.answerCard(value); return; }
    if (draft.index + 1 === detail.questions.length) draft.review = true; else draft.index++;
    this.changed();
  }
  backQuestion(value: PersonalDesktopQuestion) { const draft = this.questionDraft(value); if (draft.review) draft.review = false; else if (draft.index > 0) draft.index--; this.changed(); }
  async answerCard(value: PersonalDesktopQuestion, cancel = false) {
    const canonical = this.questionCards.get(value.occurrence);
    if (!canonical || canonical.id !== value.id || canonical.version !== value.version || canonical.admission !== value.admission) return;
    value = canonical;
    if (cancel ? !value.canCancel : !value.canAnswer) return;
    const detail = this.questionDetails.get(value.id);
    if (!cancel && (!detail || detail.version !== value.version || detail.admission !== value.admission)) return;
    let answers: OwnerAnswer[] | undefined;
    if (!cancel) { try { answers = parseOwnerAnswers(this.questionDraft(value).answers, detail!.questions); } catch { this.message = "Check the original question's answers."; this.changed(); return; } }
    await this.performAction({ v: 1, requestId: crypto.randomUUID(), family: "questions", operation: Number(value.id), admission: value.admission, occurrence: value.occurrence, action: cancel ? "cancel_question" : "answer", questionVersion: value.version, ...(answers ? { answers } : {}) });
    await this.refreshQuestionState();
  }
  private async refreshQuestionState() {
    const generation = this.generation, state = await this.remote<PersonalDesktopState>("GET", "/desktop/state");
    if (generation === this.generation && state.ok) this.installProjection(state.value);
    this.changed();
  }
  private async performAction(request: PersonalDesktopAction) {
    if (this.actionBlocked(request.family, request.operation)) return;
    const key = personalCardKey(request), generation = this.generation;
    this.acting.add(key); this.uncertainActions.set(key, request); this.changed();
    const result = await this.remote<PersonalDesktopActionReceipt>("POST", "/desktop/action", request);
    this.acting.delete(key);
    if (generation !== this.generation) return;
    if (!result.ok) { this.message = result.error.message; if (["not_sent", "rejected"].includes(result.error.outcome)) this.uncertainActions.delete(key); }
    else if (!sameAction(result.value.request, request)) this.message = "The selection receipt doesn't belong to the original card. Verify the original request.";
    else if (result.value.state !== "admitted") { await this.refreshAction(request); if (generation !== this.generation) return; this.message = result.value.state === "failed" ? "This selection didn't finish. Verify the original record." : result.value.state === "effect_unknown" ? "This selection's outcome is unverified. Check the original record." : this.message; }
    if (this.uncertainActions.has(key)) await this.inspectAction(request);
    this.changed();
  }
  async inspectAction(request: PersonalDesktopAction) {
    if (!this.online) return;
    const generation = this.generation, result = await this.remote<PersonalDesktopActionReceipt | null>("GET", `/desktop/action?requestId=${request.requestId}`);
    if (generation !== this.generation) return;
    if (result.ok && result.value && sameAction(result.value.request, request) && result.value.state !== "admitted") await this.refreshAction(request);
    else if (!result.ok) this.message = result.error.message;
    this.changed();
  }
  private refreshAction(request: PersonalDesktopAction): Promise<void> {
    const key = personalCardKey(request), loading = this.actionRefreshing.get(key); if (loading) return loading;
    const generation = this.generation, current = () => generation === this.generation && this.uncertainActions.get(key)?.requestId === request.requestId;
    const pending = (async () => {
      if (!current()) return;
      let verified: boolean;
      if (request.family === "questions") {
        const question = { id: String(request.operation), admission: request.admission, version: request.questionVersion ?? 0 };
        await this.questionLoading.get(`${question.id}:${question.version}`);
        if (!current()) return;
        verified = await this.loadQuestion(question);
      } else {
        await this.detailLoading.get(key);
        if (!current()) return;
        verified = await this.loadCard(request);
      }
      if (current() && verified) this.uncertainActions.delete(key);
    })().finally(() => { if (this.actionRefreshing.get(key) === pending) this.actionRefreshing.delete(key); this.changed(); });
    this.actionRefreshing.set(key, pending); return pending;
  }
  async cardAction(value: PersonalDesktopApproval, action: PersonalDesktopActionName) {
    const canonical = this.cards.get(value.occurrence);
    if (!canonical || canonical.admission !== value.admission || canonical.operation !== value.operation || (canonical.family ?? "tools") !== (value.family ?? "tools") || !canonical.actions?.includes(action) || this.actionBlocked(value.family ?? "tools", value.operation)) return;
    value = canonical;
    const detail = this.details.get(personalCardKey(value));
    if (!detail?.complete || detail.admission !== value.admission || (detail.family ?? "tools") !== (value.family ?? "tools") || this.refreshingCards.has(personalCardKey(value))) return;
    try {
      const original: unknown = JSON.parse(detail.text);
      if (!original || typeof original !== "object" || !("target" in original) || typeof original.target !== "string" || !("params" in original) || !original.params || typeof original.params !== "object" || value.target !== original.target.slice(0, 512) || value.targetTruncated !== (original.target.length > 512)) return;
    } catch { return; }
    if (action === "accept" && !this.canAcceptCua(value)) return;
    if (action === "observe" && value.observation !== undefined) { this.invalidatedObservations.set(value.operation, value.observation); this.cuaImages.delete(value.operation); }
    await this.performAction({ v: 1, requestId: crypto.randomUUID(), family: value.family ?? "tools", operation: value.operation, admission: value.admission, occurrence: value.occurrence, action, ...(action === "accept" ? { observation: value.observation } : {}), ...(["claim_applied", "claim_not_applied"].includes(action) && value.check ? { check: value.check.entry } : {}) });
    await this.loadCard(value);
    if (action === "observe") { const canonical = this.cards.get(value.occurrence); if (canonical?.observation) await this.loadCuaImages(canonical); }
  }
  canAcceptCua(value: PersonalDesktopApproval) {
    const images = this.cuaImages.get(value.operation);
    return value.observation !== undefined && this.invalidatedObservations.get(value.operation) !== value.observation && images?.observation === value.observation && !!value.images?.length && value.images.every(image => !image.partial && images.images.some(loaded => loaded.id === image.id && loaded.loaded));
  }
  cuaImageLoaded(value: PersonalDesktopApproval, id: string, loaded: boolean) {
    const images = this.cuaImages.get(value.operation); if (!images || images.observation !== value.observation) return;
    const image = images.images.find(image => image.id === id); if (!image) return;
    image.loaded = loaded; if (!loaded) this.message = "The new screenshot can't be displayed. Observe again.";
    this.changed();
  }
  async loadCuaImages(value: PersonalDesktopApproval) {
    if (!this.online || !value.observation || this.cuaImageLoading.has(value.operation) || this.invalidatedObservations.get(value.operation) === value.observation) return;
    const observation = value.observation, generation = this.generation, profile = this.identity!.profile;
    this.cuaImageLoading.add(value.operation); this.cuaImages.delete(value.operation); this.changed();
    const current = () => generation === this.generation && this.cards.get(value.occurrence)?.observation === observation;
    const images: { id: string; src: string; loaded: boolean }[] = [];
    try {
      const settings = await this.request<Pick<PersonalSettingsSnapshot, "profile" | "revisions">>("desktop_personal_settings_request", { request: { v: 1, op: "settings.read", limit: 1 } });
      if (!current()) return;
      if (!settings.ok) { this.message = settings.error.message; return; }
      if (settings.value.profile.id !== profile.id || settings.value.profile.directory !== profile.directory) throw new Error("The new screenshot doesn't belong to the original archive. Reconnect.");
      const expectedRevision = settings.value.revisions.mcp;
      for (const image of value.images ?? []) {
        const src = await loadPersonalCuaImage(image, observation, async offset => {
          const result = await this.request<CuaImagePage & { profile: Identity["profile"] }>("desktop_personal_settings_request", { request: { v: 1, op: "mcp.cua-image", profile, expectedRevision, operation: value.operation, observation, image: image.id, offset } });
          if (!result.ok) { this.message = result.error.message; return null; }
          if (result.value.profile.id !== profile.id || result.value.profile.directory !== profile.directory) throw new Error("The new screenshot doesn't belong to the original archive. Reconnect.");
          return result.value;
        }, current);
        if (!src || !current()) return;
        images.push({ id: image.id, src, loaded: false });
      }
      if (current()) this.cuaImages.set(value.operation, { observation, images });
    } catch (error) { if (current()) this.message = (error as Error).message; }
    finally { this.cuaImageLoading.delete(value.operation); this.changed(); }
  }
  async decideCard(value: PersonalDesktopApproval, decision: "approved" | "rejected") {
    if (value.actions) { await this.cardAction(value, decision === "approved" ? "approve" : "reject"); return; }
    const canonical = this.cards.get(value.occurrence), key = personalCardKey(value), detail = this.details.get(key);
    if (!this.online || !canonical?.canDecide || (canonical.family ?? "tools") !== "tools" || personalCardKey(canonical) !== key || canonical.admission !== value.admission || !detail?.complete || detail.admission !== canonical.admission || this.refreshingCards.has(key) || this.deciding.has(value.operation) || this.uncertainDecisions.has(value.operation)) return;
    try {
      const original: unknown = JSON.parse(detail.text);
      if (!original || typeof original !== "object" || !("target" in original) || typeof original.target !== "string" || !("params" in original) || !original.params || typeof original.params !== "object" || Array.isArray(original.params) || canonical.target !== original.target.slice(0, 512) || canonical.targetTruncated !== (original.target.length > 512)) return;
    } catch { return; }
    const generation = this.generation; this.deciding.add(value.operation); this.uncertainDecisions.add(value.operation); this.changed();
    const result = await this.remote("POST", "/tools/decide", { operation: value.operation, decision });
    this.deciding.delete(value.operation);
    if (generation !== this.generation) return;
    if (!result.ok) { this.message = result.error.message; if (result.error.outcome === "not_sent") this.uncertainDecisions.delete(value.operation); }
    await this.loadCard(value);
    this.changed();
  }
  async cancelDelegation(value: PersonalDesktopDelegation) {
    if (!this.online || this.actionBusy || value.cancelRequested) return;
    this.actionBusy = true; this.changed(); const generation = this.generation;
    const result = await this.remote("POST", `/delegation/cancel?delegation=${value.ref.entryId}`);
    if (generation !== this.generation) { this.actionBusy = false; return; }
    this.message = result.ok ? null : result.error.message;
    const canonical = await this.remote<PersonalDesktopState>("GET", "/desktop/state");
    if (generation === this.generation && canonical.ok) this.installProjection(canonical.value);
    this.actionBusy = false; this.changed();
  }
  async selectWork(value: Work, more = false) {
    const generation = this.generation, offset = more ? this.work?.result.nextOffset ?? 0 : 0;
    const result = await this.remote<NonNullable<PersonalState["work"]>>("GET", `/work?work=${value.ref.taskId}&offset=${offset}`);
    if (generation !== this.generation) return;
    if (result.ok) this.work = { ...result.value, result: { ...result.value.result, text: (offset ? this.work?.result.text ?? "" : "") + (result.value.result.text ?? "") } }; else this.message = result.error.message;
    this.changed();
  }
  async cancelWork(value: Work) { if (this.actionBusy || value.cancelRequested) return; this.actionBusy = true; const generation = this.generation, result = await this.remote("POST", `/work/cancel?work=${value.ref.taskId}`); if (generation !== this.generation) { this.actionBusy = false; return; } this.message = result.ok ? "Cancel requested for the original work; the stop state still needs verification." : result.error.message; this.actionBusy = false; await this.refreshQueries(); this.changed(); }
  async setMode(mode: PermissionMode) { const generation = this.generation, result = await this.remote("POST", "/permissions", { mode }); if (generation !== this.generation) return; if (result.ok) this.mode = mode; else this.message = result.error.message; this.changed(); }
}
