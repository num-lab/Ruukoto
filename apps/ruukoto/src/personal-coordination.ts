/** Bounded main-input coordination: four persisted tool-call batches per owner input, host-driven cutoff,
 *  main admission whose queue-or-place decision shares one commit with the cancellation barrier, and
 *  serialized queue progression that places stranded queued items itself.
 *  Note: 见 .agents/notes/implemented/architecture/2026-11-03-personal-coordination-cutoff.md
 */
import { AssistantEntry, CompactionEntry, ConversationBusy, defineDocFamily, GenerationTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, UserEntry, type ConversationId, type Cursor, type EntryDraft, type EntryId, type EntryRecord, type Harness, type InboxItem, type InboxState, type InputEntry, type InputSubmissionDraft, type Storage, type Submission, type SubmissionId, type SubmissionRecord, type TaskId, type Tx, type UserInput } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { copyJson, type Draft, type JsonRepresentation } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
import { PersonalAnalysisAdmission } from "./personal-delegation.ts";
import { PersonalError } from "./personal-error.ts";
import { PersonalWorkDoc, PersonalWorkNoteAdmission, requestPersonalWorkCancel, type PersonalWorkRef } from "./personal-work.ts";

export const PERSONAL_MAIN_TOOL_ROUNDS = 4;
export const PERSONAL_COORDINATION_ENTRY = "ruukoto.coordination-cutoff";
export type PersonalCoordinationCutoff = { version: 1; submission: SubmissionId; targets: PersonalWorkRef[]; cancelled?: PersonalWorkRef[]; marker?: EntryId };
export const PersonalCoordinationDoc = defineDocFamily<{ cutoff?: PersonalCoordinationCutoff }, null>({ kind: "ruukoto.coordination", scope: "session", version: 1, family: true, initial: () => ({}) });
const context = BACKGROUND_CONTEXT;

// Window boundaries are submission placements: user-model entries except compaction summaries, which
// the runtime appends mid-run with a user-role message — a compaction does not place a new input.
const isUserEntry = (entry: EntryRecord) => entry.kind !== CompactionEntry.kind && (entry.model ?? []).some(message => message?.role === "user");
const isBatchEntry = (entry: EntryRecord) => entry.kind === AssistantEntry.kind && (entry.model ?? []).some(message => message?.role === "assistant" && Array.isArray(message.content) && message.content.some(part => part?.type === "toolCall"));

type EntryScan = (query: { conversationId: ConversationId; minEntryId: EntryId; order: "ascending" }, limit: number, cursor: Cursor | undefined) => Promise<{ items: readonly EntryRecord[]; next?: Cursor }>;
const roundsAfter = async (scan: EntryScan, conversationId: ConversationId, afterEntryId: EntryId): Promise<number> => {
  let cursor: Cursor | undefined, rounds = 0;
  do {
    const page = await scan({ conversationId, minEntryId: afterEntryId, order: "ascending" }, 256, cursor);
    for (const entry of page.items) {
      if (entry.id <= afterEntryId) continue;
      if (isUserEntry(entry)) return rounds;
      if (isBatchEntry(entry)) rounds++;
    }
    cursor = page.next;
  } while (cursor);
  return rounds;
};

/** Distinct persisted tool-call assistant batches attributable to one owner input's window: entries after
 *  `afterEntryId`, ending at the next submission placement (a new input's entry or a reset — natural run
 *  boundaries; compaction summaries stay inside the owner's window). Entry-derived, so it survives
 *  reopen, successor generations, and replay. */
export async function personalCoordinationRounds(tx: Tx, conversationId: ConversationId, afterEntryId: EntryId): Promise<number> {
  return roundsAfter((query, limit, cursor) => tx.scanEntries(query, limit, cursor), conversationId, afterEntryId);
}

/** Batches committed since the latest owner-input entry — the live budget at request-prepare and
 *  tool-execution time, independent of which submission record is resolvable (multi-input runs alike). */
export async function personalCoordinationTailRounds(tx: Tx, conversationId: ConversationId): Promise<number> {
  let cursor: Cursor | undefined, rounds = 0;
  do {
    const page = await tx.scanEntries({ conversationId, order: "descending" }, 256, cursor);
    for (const entry of page.items) {
      if (isUserEntry(entry)) return rounds;
      if (isBatchEntry(entry)) rounds++;
    }
    cursor = page.next;
  } while (cursor);
  return rounds;
}

/** Exact works this input successfully created or appended: analysis admissions instructed by it and
 *  accepted note admissions sourced to it. Queries, rejected appends, delegation-mates instructed by
 *  other inputs, and calls never admitted never appear here. */
export async function personalCoordinationTargets(tx: Tx, record: SubmissionRecord): Promise<PersonalWorkRef[]> {
  const targets = new Map<TaskId, PersonalWorkRef>();
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: record.conversationId, minEntryId: record.entry, order: "ascending" }, 256, cursor);
    for (const entry of page.items) {
      if (record.entry !== undefined && entry.id <= record.entry) continue;
      if (isUserEntry(entry)) return [...targets.values()];
      const data = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const source = (data as { source?: JsonValue }).source;
      if (!source || typeof source !== "object" || Array.isArray(source)) continue;
      if ((source as { submissionId?: unknown }).submissionId !== record.id) continue;
      if (entry.kind === PersonalAnalysisAdmission.kind) {
        const work = (data as { work?: PersonalWorkRef }).work;
        if (work) targets.set(work.taskId, work);
      } else if (entry.kind === PersonalWorkNoteAdmission.kind && (source as { kind?: unknown }).kind === "input") {
        const ref = (data as { ref?: PersonalWorkRef }).ref;
        if (ref) targets.set(ref.taskId, ref);
      }
    }
    cursor = page.next;
  } while (cursor);
  return [...targets.values()];
}

/** Persisted cutoff intent for one owner input, when any exists. Doc members are overlay-bound, so the
 *  member is materialized here — callers read it after their own commit has settled. */
export async function personalCoordinationCutoff(tx: Tx, requestId: string | undefined): Promise<PersonalCoordinationCutoff | undefined> {
  const cutoff = requestId === undefined ? undefined : (await tx.doc(PersonalCoordinationDoc, requestId, null)).cutoff;
  return cutoff === undefined ? undefined : copyJson(cutoff) as PersonalCoordinationCutoff;
}

// The persisted intent alone proves only that the input stopped: `cancelled` is written after the
// actual cancellation registrations, so intent-only and terminal-skipped targets never read as done.
export function personalCoordinationCutoffText(cutoff: PersonalCoordinationCutoff): string {
  if (cutoff.cancelled === undefined) return "本轮协调超出批次预算已停止；取消登记尚未完成，停止与效果以原记录为准；请从后台工作查询状态。";
  return cutoff.cancelled.length ? `本轮协调超出批次预算已停止；已登记 ${cutoff.cancelled.length} 项工作的取消请求，停止与效果以原记录为准；请从后台工作查询状态。` : "本轮协调超出批次预算已停止；没有需要取消的工作；请重新提交请求。";
}

/** Admission of one main input, bound to the coordinator's in-commit barrier: a `held` that is true
 *  queues the draft instead of placing it or advancing the queue. `held` is read inside the deciding
 *  commit, and commits serialize on the Session line while the coordinator marks every committed
 *  evaluable settle synchronously at adoption — so the check can never be stale: a settle committed
 *  before the admission commit is held, and one committed after finds the input already queued. */
export type PersonalMainAdmission = (draft: InputSubmissionDraft, context: Context) => Promise<Submission>;

// Mirror of upstream `pickInputEntry()`: the input entry's kind and data as strict JSON, without
// other fields an untyped caller might pass.
const pickInputEntry = ({ kind, data }: InputEntry | JsonRepresentation<InputEntry>): InputEntry => data === undefined ? { kind } : { kind, data: copyJson(data, { omitUndefinedProperties: true }) };

// Mirror of upstream `appendInput()`: `entry`'s kind and data, or `pi.user`, with the user message.
const appendMainInput = async (tx: Tx, content: UserInput | JsonRepresentation<UserInput>, entry: InputEntry | JsonRepresentation<InputEntry> | undefined, now: number) => {
  const message = { role: "user" as const, content, timestamp: now };
  return entry === undefined ? tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, { model: [message] }) : tx.appendEntry(ROOT_CONVERSATION_ID, { ...pickInputEntry(entry), model: [message] });
};

// Queued-input modes no upstream boundary can select: `applyBoundary` — reached from foreign
// admission commits (native compaction summaries, resets, any write submission), the run's own
// `final` boundary and mid-run `postTools` boundaries — picks exactly "steer"/"followUp"/"write",
// so a parked item is invisible to every queue-advancing commit this module does not own. A
// queued owner input can therefore advance only through the barrier-checked commits below, which
// is the whole point of parking. `Submission.abort` and `withdrawQueuedInputs` still match parked
// items — any non-write mode is an input to them — so withdrawal is unaffected.
const PERSONAL_PARKED_STEER = "ruukoto.parked-steer", PERSONAL_PARKED_FOLLOWUP = "ruukoto.parked-followUp";

/** The upstream spelling of a queued input item's mode: parked modes unwrap to the mode they
 *  stand for, so callers verifying their own queued admission keep one vocabulary. */
export function personalUnparkMode(mode: string): string {
  return mode === PERSONAL_PARKED_STEER ? "steer" : mode === PERSONAL_PARKED_FOLLOWUP ? "followUp" : mode;
}

const isSteer = (item: InboxItem) => personalUnparkMode(item.mode) === "steer";
const isFollowUp = (item: InboxItem) => personalUnparkMode(item.mode) === "followUp";

// Items queued through native admission — a caller bypassing `admitInput` on root — or persisted
// before parking still carry the live spellings upstream boundaries can select. Every commit this
// module owns rewrites them parked before its barrier decision, so the barrier's authority covers
// the whole queue rather than only coordinator-admitted items. Writes are untouched.
const parkLiveItems = (items: InboxItem[]) => {
  for (const item of items) {
    if (item.mode === "steer") (item as { mode: string }).mode = PERSONAL_PARKED_STEER;
    else if (item.mode === "followUp") (item as { mode: string }).mode = PERSONAL_PARKED_FOLLOWUP;
  }
};

// Mirror of upstream `applyBoundary(tx, boundary, "final", now)` under the host's fixed
// `one-at-a-time` queue modes: every queued write lands first — a head targeting before the active
// range settles `unanswered` stale — then the first steer and first follow-up input in ID order.
// Writes land first so inputs queued before a reset run in the new context; selected and stale
// items are removed positionally. Parked items count for the user picks (the live spellings stay
// placeable for inboxes persisted before parking), so only this barrier-checked call selects them.
async function placeMainBoundary(tx: Tx, inbox: Draft<InboxState>, head: EntryId | undefined, now: number): Promise<SubmissionId[]> {
  const items = inbox.items;
  const writes = items.flatMap((item, index) => item.mode === "write" ? [index] : []);
  const users = [items.findIndex(isSteer), items.findIndex(isFollowUp)].filter(index => index >= 0).sort((a, b) => a - b);
  // `appendEntry()` copies the drafts' values; the items are removed only afterwards.
  for (const index of writes) {
    const item = items[index];
    if (item.mode !== "write") continue;
    const draft = item.entry as unknown as EntryDraft;
    if (typeof draft.head === "number" && head !== undefined && draft.head < head) { tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" }); continue; }
    const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, draft);
    if (draft.head !== undefined) head = draft.head === "self" ? entry.id : draft.head;
    tx.placeSubmission(item.id, entry.id);
  }
  const placed: SubmissionId[] = [];
  for (const index of users) {
    const item = items[index];
    if (item.mode === "write") continue;
    const entry = await appendMainInput(tx, item.content, item.entry, now);
    tx.placeSubmission(item.id, entry.id);
    placed.push(item.id);
  }
  for (const index of [...writes, ...users].sort((a, b) => b - a)) items.splice(index, 1);
  return placed;
}

// Mirror of upstream `admitSubmission()` for `type: "input"` drafts on the root conversation, with
// the cancellation barrier joined to the deciding commit and queued items parked. A known
// requestId dedupes without writing; `whenBusy: "reject"` on a live run throws `ConversationBusy`.
// Held, busy or queued work pushes a parked inbox item — never a live mode — so no upstream
// boundary can place it ahead of an unfinished cancellation registration. Idle-and-clear places
// the entry and starts the run; an idle non-empty queue runs the final boundary in the same
// commit, exactly as upstream admission does.
async function admitMainInput(tx: Tx, draft: InputSubmissionDraft, held: () => boolean, now: number): Promise<SubmissionRecord> {
  const inputEntry = draft.entry;
  if (inputEntry !== undefined) {
    const { kind } = inputEntry;
    if (typeof kind !== "string" || kind.length === 0 || kind.startsWith("pi.")) throw new TypeError(`An input entry's kind must be a non-empty string not starting with "pi.", got ${String(kind)}`);
  }
  if (draft.requestId !== undefined) {
    const existing = await tx.submissionByRequest(ROOT_CONVERSATION_ID, draft.requestId);
    if (existing !== undefined) {
      if (existing.type !== "input") throw new Error(`Request ${draft.requestId} already identifies a submission of type ${existing.type}`);
      return existing;
    }
  }
  const requestId = draft.requestId === undefined ? {} : { requestId: draft.requestId };
  const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID), inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
  parkLiveItems(inbox.items);
  const busy = live.run !== undefined;
  if (busy && draft.whenBusy === "reject") throw new ConversationBusy(ROOT_CONVERSATION_ID);
  // Boundary reads precede the commit's first table write, as upstream `prepareBoundary` requires:
  // the head marker is read whenever a boundary might run over pre-existing items, and `held` may
  // still drain mid-commit, so it cannot gate this read.
  const head = busy || inbox.items.length === 0 ? undefined : (await tx.latestHeadMarker(ROOT_CONVERSATION_ID))?.head;
  if (!held() && !busy && inbox.items.length === 0) {
    const entry = await appendMainInput(tx, draft.content, inputEntry, now);
    const record = await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, ...requestId, type: "input", status: "placed", entry: entry.id });
    live.run = { taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID }), inputs: [record.id] };
    return record;
  }
  const record = await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, ...requestId, type: "input", status: "queued" });
  const parked = draft.whenBusy === "steer" ? PERSONAL_PARKED_STEER : PERSONAL_PARKED_FOLLOWUP;
  // InboxItem.mode is closed over the three modes upstream boundaries select; a parked mode is
  // host JSON those selectors can never match, so this SDK boundary is where the cast belongs.
  inbox.items.push({ id: record.id, mode: parked, content: copyJson(draft.content, { omitUndefinedProperties: true }) as JsonRepresentation<UserInput>, ...(inputEntry === undefined ? {} : { entry: pickInputEntry(inputEntry) }) } as unknown as InboxItem);
  if (!held() && !busy) {
    const inputs = await placeMainBoundary(tx, inbox, head, now);
    if (inputs.length) live.run = { taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID }), inputs };
  }
  return record;
}

/** Commit one main-input admission and return its durable handle. Callers that cannot reach the
 *  coordinator pass `held: () => true` — queueing is always the safe admission. */
export async function personalMainAdmit(harness: Harness, draft: InputSubmissionDraft, held: () => boolean, now: () => number, callContext: Context): Promise<Submission> {
  const record = await harness.commit(tx => admitMainInput(tx, draft, held, now()), callContext);
  const submission = await harness.submission(record.id, callContext);
  if (!submission) throw new PersonalError("submission_missing", "新提交的主会话输入记录缺失，请保留档案。");
  return submission;
}

/** Recovery-observation seam: invoked at persisted stage boundaries — after the round count is read and
 *  again after the run is confirmed dead, before the completion commit. Tests hold these to prove
 *  mid-evaluation events still reach a recheck and crash windows land on durable boundaries. */
export type PersonalCoordinationProbe = (record: SubmissionRecord, stage: "rounds" | "before-completion", rounds?: number) => void | Promise<void>;

/** Progression-observation seam: invoked inside a progression attempt just before each storage read —
 *  `"unanswered-scan"` before the unevaluated-settle sweep, `"queued-scan"` before the queued-head read.
 *  Tests hold or fail these to exercise interleavings and failure containment inside the attempt. */
export type PersonalProgressionProbe = (stage: "unanswered-scan" | "queued-scan") => void | Promise<void>;

/** Returns true when the submission is terminal for coordination purposes — settled, or over-budget and
 *  cut off — so the watcher stops re-evaluating it. Live inputs within budget stay under watch. */
async function evaluate(harness: Harness, record: SubmissionRecord, probe?: PersonalCoordinationProbe): Promise<boolean> {
  if (record.status === "done") return true;
  if (record.status === "queued") return false;
  // Terminal without an entry means withdrawn before placement (`submission.abort()` on a queued
  // record, or a revoked report/question input): nothing placed, nothing to coordinate — finished,
  // not pending. Returning false here would let every sweep rediscover the record forever.
  if (record.entry === undefined) return true;
  const entry = record.entry;
  const rounds = await harness.commit(tx => personalCoordinationRounds(tx, record.conversationId, entry), context);
  await probe?.(record, "rounds", rounds);
  if (rounds <= PERSONAL_MAIN_TOOL_ROUNDS) return record.status !== "placed";
  const key = record.requestId ?? `submission:${record.id}`;
  // Intent commit: durable cutoff + exact cancellation targets before anything else touches the run.
  const cutoff = await harness.commit(async tx => {
    const fresh = record.requestId ? await tx.submissionByRequest(record.conversationId, record.requestId) : record;
    const doc = await tx.doc(PersonalCoordinationDoc, key, null);
    if (doc.cutoff) return copyJson(doc.cutoff) as PersonalCoordinationCutoff;
    if (!fresh || fresh.status === "done" || fresh.entry === undefined) return undefined;
    const intent: PersonalCoordinationCutoff = { version: 1, submission: record.id, targets: await personalCoordinationTargets(tx, fresh) };
    doc.cutoff = intent;
    return copyJson(intent) as PersonalCoordinationCutoff;
  }, context);
  if (!cutoff) return true;
  // The input's run must be dead before the completion commit, or cancellation registration and the
  // marker would observe a live generation. Generations roll over mid-abort, so re-resolve the owner
  // each round and abort the current task; a run that has already moved to a later owner input is never touched.
  // The abort mark is committed inside abortTask — its join is intentionally not awaited: a held
  // invocation must not block the cutoff, which is retried instead.
  const source = await harness.submission(record.id, context);
  for (let guard = 0; guard < 128; guard++) {
    const current = (await source?.status(context))?.status;
    if (current === undefined || current !== "placed") break;
    const live = await harness.snapshot(LiveDoc, record.conversationId, context);
    const owner = live?.run?.inputs.includes(record.id) ? live.run.taskId : undefined;
    if (owner !== undefined) void harness.abortTask(owner, context).catch(() => process.stderr.write(`[ruukoto:coordination] run abort unconfirmed for input ${record.id}; retrying.\n`));
    if (guard === 127) throw new PersonalError("coordination_abort_unconfirmed", "原输入的运行仍未结束，协调切断留待重试；请查询原状态。");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  // The marker is appended with cancellation registration in one atomic commit, not as a write
  // submission: a queued write behind a live later run can wedge when that run faults without a
  // boundary, and the fixed key would keep returning the same stuck record on reopen. `marker`
  // on the intent makes the append replay-safe without a request key.
  await probe?.(record, "before-completion");
  const rescan = await harness.commit(async tx => {
    const doc = await tx.doc(PersonalCoordinationDoc, key, null);
    const current = doc.cutoff;
    if (!current) return { aborted: [] as PersonalWorkRef[], targets: [] as PersonalWorkRef[] };
    if (current.marker !== undefined) return { aborted: [] as PersonalWorkRef[], targets: copyJson(current.targets) as PersonalWorkRef[] };
    const refs: PersonalWorkRef[] = [];
    if (!current.cancelled) {
      const fresh = record.requestId ? await tx.submissionByRequest(record.conversationId, record.requestId) : record;
      if (fresh) for (const ref of await personalCoordinationTargets(tx, fresh)) if (!current.targets.some(target => target.taskId === ref.taskId)) current.targets.push(ref);
      for (const ref of current.targets) {
        const task = await tx.task(ref.taskId);
        const work = await tx.doc(PersonalWorkDoc, ref.requestId, null);
        // Terminal targets are skipped, never counted; a previously-flagged work already has its
        // cancellation registered, so it counts without a repeat request.
        if (!task || task.state.status === "terminal") continue;
        if (!work.cancelRequested) await requestPersonalWorkCancel(tx, ref);
        refs.push(copyJson(ref) as PersonalWorkRef);
      }
      current.cancelled = refs;
    }
    current.marker = (await tx.appendEntry(record.conversationId, { kind: PERSONAL_COORDINATION_ENTRY, model: [], data: { submission: record.id, requestId: record.requestId ?? null, targets: current.targets.map(ref => ref.taskId) } })).id;
    return { aborted: refs, targets: copyJson(current.targets) as PersonalWorkRef[] };
  }, context);
  for (const ref of rescan.aborted) void harness.abortTask(ref.taskId, context).catch(() => process.stderr.write(`[ruukoto:coordination] work ${ref.taskId} post-cancel physical stop unverified; query the original record.\n`));
  return true;
}

/** Host-side cutoff driver and admission owner: watches run ownership and settle events, evaluates
 *  submissions serially, performs intent→abort→cancel→marker independently of the invocation being
 *  aborted, owns the barrier every main admission and queue progression reads in-commit, and places
 *  stranded queued inputs itself once placement is safe. */
export async function startPersonalCoordination(harness: Harness, storage: Storage, context: Context, probe?: PersonalCoordinationProbe, progressProbe?: PersonalProgressionProbe, now: () => number = () => Date.now()): Promise<{ close: () => Promise<void>; admit: PersonalMainAdmission }> {
  const evaluated = new Set<SubmissionId>(), pending = new Set<SubmissionId>(), dirty = new Set<SubmissionId>(), deferred = new Set<SubmissionId>(), attempts = new Map<SubmissionId, number>();
  let queue = Promise.resolve(), closed = false, openSweepDone = false;
  // The barrier every main admission and progression commit reads in-transaction: an evaluable
  // settle is `pending` synchronously at its commit's adoption (the listener below), or still
  // undiscovered while the open sweep runs; `dirty` covers the pending→recheck gap and `deferred`
  // holds paused recoveries — a paused retry is not a completed cancellation registration.
  const held = () => closed || !openSweepDone || pending.size > 0 || dirty.size > 0 || deferred.size > 0;
  const enqueue = (id: SubmissionId, internal = false) => {
    if (closed || evaluated.has(id)) return;
    // Recovery that exhausted its in-process budget defers to a genuine later event or reopen —
    // the coordinator's own sweep must not count as one, or exhausted inputs retry forever.
    if (deferred.has(id)) { if (internal) return; deferred.delete(id); }
    // Events landing mid-evaluation coalesce into a recheck instead of being dropped: the evaluation
    // read a state these events may have already changed.
    if (pending.has(id)) { dirty.add(id); return; }
    pending.add(id);
    queue = queue.then(async () => {
      try {
        const submission = await harness.submission(id, context);
        const record = await submission?.status(context);
        if (record && record.conversationId === ROOT_CONVERSATION_ID && record.type === "input" && await evaluate(harness, record, probe)) { evaluated.add(id); attempts.delete(id); }
      } catch (error) {
        process.stderr.write(`[ruukoto:coordination] coordination check unconfirmed for input ${id}; original state preserved: ${error instanceof Error ? error.message : "unknown error"}\n`);
        const count = (attempts.get(id) ?? 0) + 1;
        // Unfinished cutoff stages are replay-safe, so a bounded in-process retry is owned here;
        // beyond the bound the input defers to the reopen sweep or the next genuine event.
        if (count < 4) { attempts.set(id, count); dirty.add(id); }
        else { attempts.delete(id); deferred.add(id); process.stderr.write(`[ruukoto:coordination] coordination of input ${id} remains unfinished after retries; reopen or a later event resumes it.\n`); }
      } finally {
        // The recheck backoff keeps the record `pending` through it: an admission or progression
        // commit reading `held` mid-gap must still see this unfinished coordination.
        const recheck = !closed && dirty.delete(id) && !evaluated.has(id);
        if (recheck) await new Promise(resolve => setTimeout(resolve, 25));
        pending.delete(id);
        if (recheck) enqueue(id);
        scheduleProgress();
      }
    });
  };
  // A run that faults or aborts ends without a final boundary, so queued submissions can sit in the
  // inbox forever: nothing else places them. Progression is serialized on the same queue as cutoff
  // evaluation, and its placement commit reads `held` in-transaction — the barrier and the
  // queue-or-place decision share one commit, so no interleaving can put a successor ahead of an
  // unfinished cancellation registration.
  let progressing = false, progressDirty = false, progressAttempts = 0;
  // Records that could still need evaluation: placed inputs settled unanswered. Terminal entryless
  // records (withdrawn before placement) and non-input submissions need nothing — but any remaining
  // evaluable record, including a retry-exhausted deferred one, holds the barrier: a paused retry is
  // not a completed cancellation registration, so queued successors may never advance past it. The
  // sweep just must not restart deferred inputs itself; a genuine event or reopen does.
  const sweepUnevaluated = async () => {
    let cursor: Cursor | undefined, found = false;
    do {
      const page = await storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID, status: "unanswered" }, 256, cursor, context);
      for (const record of page.items) {
        if (record.type !== "input" || record.entry === undefined) continue;
        if (evaluated.has(record.id) || pending.has(record.id)) continue;
        found = true;
        if (!deferred.has(record.id)) enqueue(record.id, true);
      }
      cursor = page.next;
    } while (cursor && !closed);
    return found;
  };
  const scheduleProgress = () => {
    if (closed) return;
    if (progressing) { progressDirty = true; return; }
    queue = queue.then(progressOnce);
  };
  const progressOnce = async () => {
    progressing = true;
    // An unfinished attempt is replay-safe — the boundary only places what is still queued — so
    // bounded in-process retry is owned here; beyond the bound the next event or reopen resumes it.
    const fail = (error: unknown) => {
      process.stderr.write(`[ruukoto:coordination] queue progression unconfirmed; original state preserved: ${error instanceof Error ? error.message : "unknown error"}\n`);
      if (++progressAttempts < 4) progressDirty = true;
      else { progressAttempts = 0; process.stderr.write(`[ruukoto:coordination] queue progression remains unfinished after retries; reopen or a later event resumes it.\n`); }
    };
    // Every failure inside an attempt lands in `fail` — nothing may reject the shared chain or a
    // transient read error would drop every evaluation and progression chained behind it.
    try {
      if (closed || pending.size || dirty.size || deferred.size || !openSweepDone) return;
      // An over-budget input's settle event may not have been enqueued yet: scan before advancing
      // the queue, or a successor could place ahead of its cancellation registration.
      await progressProbe?.("unanswered-scan");
      if (await sweepUnevaluated()) return;
      if (closed || pending.size || dirty.size || deferred.size) return;
      await progressProbe?.("queued-scan");
      await harness.commit(async tx => {
        // Live spellings are parked before the barrier's early return, so even a held commit
        // shrinks the window in which a native-queued item stays selectable upstream.
        const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
        parkLiveItems(inbox.items);
        if (held()) return;
        const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
        if (live.run !== undefined || inbox.items.length === 0) return;
        const head = (await tx.latestHeadMarker(ROOT_CONVERSATION_ID))?.head;
        const inputs = await placeMainBoundary(tx, inbox, head, now());
        if (inputs.length) live.run = { taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID }), inputs };
      }, context);
      progressAttempts = 0;
    } catch (error) {
      fail(error);
    } finally {
      progressing = false;
      if (!closed && progressDirty) { progressDirty = false; scheduleProgress(); }
    }
  };
  const admit: PersonalMainAdmission = async (draft, callContext) => {
    const submission = await personalMainAdmit(harness, draft, held, now, callContext);
    scheduleProgress();
    return submission;
  };
  const watch = await harness.watchDoc(LiveDoc, ROOT_CONVERSATION_ID, context);
  watch?.start(async live => { for (const id of live?.run?.inputs ?? []) enqueue(id); if (!live?.run) scheduleProgress(); });
  const unsubscribe = harness.subscribeCommits(publication => {
    for (const change of publication.changes) {
      if (change.type !== "submission") continue;
      const value = change.value as SubmissionRecord;
      if (value.conversationId !== ROOT_CONVERSATION_ID) continue;
      // Only evaluable settles may hold the barrier — a withdrawn record's entryless unanswered
      // settle and a stale write's are finished, not pending — and every queued record schedules
      // progression so an input admitted while idle-behind-others advances as soon as it is head.
      if (value.status === "unanswered" && value.type === "input" && value.entry !== undefined) enqueue(value.id);
      else if (value.status === "queued") scheduleProgress();
    }
  });
  void (async () => {
    // Persisted live-spelling items — queued before parking existed, or by a native submit while
    // the coordinator was down — are parked once at open so no upstream boundary can select them
    // under a barrier that outlived the last process. Later commits keep re-parking whatever
    // lands live after this pass.
    for (let attempt = 0; attempt < 3 && !closed; attempt++) {
      try { await harness.commit(async tx => { parkLiveItems((await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items); }, context); break; }
      catch (error) {
        process.stderr.write(`[ruukoto:coordination] inbox mode parking unconfirmed; a later admission or progression commit retries it: ${error instanceof Error ? error.message : "unknown error"}\n`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    let cursor: Cursor | undefined, failures = 0;
    do {
      const page = await storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID, status: "unanswered" }, 256, cursor, context).catch((error: unknown) => {
        process.stderr.write(`[ruukoto:coordination] open sweep page failed; leftovers stay pending until retry or next event: ${error instanceof Error ? error.message : "unknown error"}\n`);
        return undefined;
      });
      if (!page) {
        if (closed || ++failures >= 3) break;
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      failures = 0;
      for (const record of page.items) if (record.type === "input" && record.entry !== undefined) enqueue(record.id, true);
      cursor = page.next;
    } while (cursor && !closed);
    // The sweep may end early on persistent failure; either way admissions stop waiting on it —
    // new settles are covered by the listener and leftovers surface on the next event or reopen.
    openSweepDone = true;
    if (!closed) scheduleProgress();
  })();
  let closing: Promise<void> | undefined;
  return {
    // Idempotent: the harness-terminal path and an explicit close can race; share one stop.
    close() {
      return closing ??= (async () => { closed = true; unsubscribe(); await watch?.stop(); await queue; })();
    },
    admit,
  };
}
