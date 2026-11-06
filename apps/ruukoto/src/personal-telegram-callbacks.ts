import { isDeepStrictEqual } from "node:util";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalImApiError, type PersonalImAccess } from "./personal-im-api.ts";
import { telegramSourceActive } from "./personal-permissions.ts";
import type { PersonalTelegramApi } from "./personal-telegram-api.ts";
import type { PersonalEntryIdentity } from "./personal-telegram-records.ts";

const TASK = "ruukoto.telegram-callback-ack";
type State = "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled";
export type PersonalTelegramCallbackOutcome = { state: Exclude<State, "pending" | "sending">; code: string; effect: "returned" | "not_sent" | "effect_unknown" };
export type PersonalTelegramCallbackRef = { key: string; taskId: TaskId<PersonalTelegramCallbackOutcome> };
export type PersonalTelegramCallbackInput = { key: string; source: PersonalEntryIdentity; queryId: string; fingerprint: string; origin: EntryId };
export type PersonalTelegramCallbackRecord = { v: 1; ref: PersonalTelegramCallbackRef; input: PersonalTelegramCallbackInput; admission: EntryId; state: State; claim?: EntryId; observation?: EntryId; code?: string; effect?: PersonalTelegramCallbackOutcome["effect"] };
export const PersonalTelegramCallbacksDoc = defineDoc<{ keys: string[] }>({ kind: "ruukoto.telegram-callback-acks", scope: "session", version: 1, initial: () => ({ keys: [] }) });
export const PersonalTelegramCallbackDoc = defineDocFamily<{ ack?: PersonalTelegramCallbackRecord }, null>({ kind: "ruukoto.telegram-callback-ack", scope: "session", version: 1, family: true, initial: () => ({}) });
export const PersonalTelegramCallbackAdmission = defineEntry<{ v: 1; ref: PersonalTelegramCallbackRef; input: PersonalTelegramCallbackInput }>("ruukoto.telegram-callback-ack-admission");
export const PersonalTelegramCallbackClaim = defineEntry<{ ref: PersonalTelegramCallbackRef; admission: EntryId; source: PersonalEntryIdentity; queryId: string; fingerprint: string }>("ruukoto.telegram-callback-ack-claim");
export const PersonalTelegramCallbackObservation = defineEntry<{ ref: PersonalTelegramCallbackRef; admission: EntryId; claim?: EntryId } & PersonalTelegramCallbackOutcome>("ruukoto.telegram-callback-ack-observation");
const invalid = () => new PersonalError("telegram_callback_ack_invalid", "原按钮应答记录无法核实，请保留档案并查询原决定。");
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const fingerprint = (value: string) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function validInput(input: PersonalTelegramCallbackInput) {
  return input && typeof input === "object" && input.source && typeof input.source === "object" && input.source.platform === undefined && typeof input.source.botId === "string" && /^[1-9][0-9]{0,15}$/.test(input.source.botId) && typeof input.source.ownerId === "string" && /^[1-9][0-9]{0,15}$/.test(input.source.ownerId) && typeof input.source.generation === "string" && input.source.generation.length > 0 && input.source.generation.length <= 256 && typeof input.queryId === "string" && input.queryId.length > 0 && Buffer.byteLength(input.queryId) <= 256 && !/[\x00-\x1f\x7f]/.test(input.queryId) && input.key === `telegram-callback:${input.source.botId}:${input.queryId}` && fingerprint(input.fingerprint) && positive(input.origin);
}

async function verifyOrigin(tx: Tx, input: PersonalTelegramCallbackInput) {
  const origin = await tx.entry(input.origin), data = origin?.data;
  if (!origin || origin.conversationId !== ROOT_CONVERSATION_ID || origin.model !== undefined || !data || typeof data !== "object" || Array.isArray(data) || data.requestId !== input.key || data.generation !== input.source.generation || data.queryId !== input.queryId) throw invalid();
  if (origin.kind === "ruukoto.telegram-callback") {
    if (typeof data.token !== "string" || !data.token || Buffer.byteLength(data.token) > 64 || typeof data.display !== "string" || !data.display || !isDeepStrictEqual(data, { requestId: input.key, generation: input.source.generation, queryId: input.queryId, token: data.token, display: data.display })) throw invalid();
  } else if (origin.kind !== "ruukoto.telegram-callback-rejected" || typeof data.reason !== "string" || !data.reason || !isDeepStrictEqual(data, { requestId: input.key, generation: input.source.generation, queryId: input.queryId, fingerprint: input.fingerprint, reason: data.reason })) throw invalid();
}

async function lookup(tx: Tx, key: string, expectedFingerprint?: string) {
  const value = (await tx.doc(PersonalTelegramCallbackDoc, key, null)).ack;
  if (!value) return;
  if (value.v !== 1 || !validInput(value.input) || value.ref.key !== key || value.input.key !== key || !positive(value.ref.taskId)) throw invalid();
  if (expectedFingerprint !== undefined && value.input.fingerprint !== expectedFingerprint) throw new PersonalError("telegram_input_conflict", "同一按钮请求的原内容不同，请保留档案并查询原决定。");
  return value;
}

async function record(tx: Tx, ref: PersonalTelegramCallbackRef) {
  const value = await lookup(tx, ref.key);
  if (!value || value.ref.taskId !== ref.taskId) throw invalid();
  return value;
}

async function observe(tx: Tx, value: PersonalTelegramCallbackRecord, outcome: PersonalTelegramCallbackOutcome) {
  if (value.observation || value.state !== "pending" && value.state !== "sending") throw invalid();
  value.observation = (await tx.appendEntry(PersonalTelegramCallbackObservation, ROOT_CONVERSATION_ID, { data: { ref: value.ref, admission: value.admission, ...(value.claim === undefined ? {} : { claim: value.claim }), ...outcome } })).id;
  value.state = outcome.state; value.code = outcome.code; value.effect = outcome.effect;
  return { status: "terminal" as const, outcome: { status: "completed" as const, result: outcome } };
}

function interruptedOutcome(claimed: boolean): PersonalTelegramCallbackOutcome {
  return claimed ? { state: "effect_unknown", code: "telegram_callback_ack_interrupted", effect: "effect_unknown" } : { state: "canceled", code: "telegram_callback_ack_interrupted", effect: "not_sent" };
}

// Note: See .agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md
export function personalTelegramCallbacks(im: PersonalImAccess, transport: (source: PersonalEntryIdentity) => PersonalTelegramApi | undefined) {
  const task = defineTask<{ key: string }, { phase: "send" } | { phase: "verify" }, PersonalTelegramCallbackOutcome>({ name: TASK, version: 1, initial: () => ({ phase: "send" }), phases: {
    async send(current, runtime, context) {
      const original = (await runtime.snapshot(PersonalTelegramCallbackDoc, current.input.key, context))?.ack;
      if (!original) throw invalid();
      let api: PersonalTelegramApi | undefined, queryId: string | undefined;
      await im.withEntry(original.input.source, async () => {
        await runtime.commit(async tx => {
          const value = await record(tx, { key: current.input.key, taskId: current.id });
          if (value.state !== "pending" || value.claim || value.observation) throw invalid();
          await verifyOrigin(tx, value.input);
          if (runtime.signal.aborted || !im.isActive(value.input.source) || !await telegramSourceActive(tx, value.input.source)) return observe(tx, value, { state: "canceled", code: "telegram_callback_source_inactive", effect: "not_sent" });
          value.claim = (await tx.appendEntry(PersonalTelegramCallbackClaim, ROOT_CONVERSATION_ID, { data: { ref: value.ref, admission: value.admission, source: value.input.source, queryId: value.input.queryId, fingerprint: value.input.fingerprint } })).id;
          value.state = "sending"; queryId = value.input.queryId;
          return { status: "running", checkpoint: { phase: "verify" } };
        }, context);
        if (queryId) api = transport(original.input.source);
      });
      if (!queryId) return;
      let outcome: PersonalTelegramCallbackOutcome = { state: "sent", code: "telegram_callback_acknowledged", effect: "returned" };
      try { if (!api) throw new PersonalImApiError("telegram_callback_transport_inactive", "原按钮应答入口不可用。", "not_sent"); await api.answerCallback(queryId, runtime.signal); }
      catch (error) { outcome = error instanceof PersonalImApiError ? { state: error.effect === "not_sent" ? "failed" : "effect_unknown", code: error.code, effect: error.effect } : { state: "effect_unknown", code: "telegram_callback_ack_unverified", effect: "effect_unknown" }; }
      await runtime.commit(async tx => observe(tx, await record(tx, { key: current.input.key, taskId: current.id }), outcome), context);
    },
    async verify(current, runtime, context) {
      await runtime.commit(async tx => {
        const value = await record(tx, { key: current.input.key, taskId: current.id });
        if (value.state !== "sending" || !value.claim) throw invalid();
        return observe(tx, value, { state: "effect_unknown", code: "telegram_callback_ack_interrupted", effect: "effect_unknown" });
      }, context);
    },
  }, async abort(current, runtime, context) {
    await runtime.commit(async tx => {
      const value = await record(tx, { key: current.input.key, taskId: current.id });
      const result = value.state === "sending" ? { state: "effect_unknown" as const, code: "telegram_callback_ack_interrupted", effect: "effect_unknown" as const } : { state: "canceled" as const, code: "telegram_callback_ack_canceled", effect: "not_sent" as const };
      await observe(tx, value, result);
      return { status: "terminal", outcome: { status: "aborted", result } };
    }, context);
  } });
  return { extension: defineExtension({ name: "personal-telegram-callbacks", tasks: [task] }), lookup,
    async request(tx: Tx, input: PersonalTelegramCallbackInput): Promise<PersonalTelegramCallbackRef> {
      if (!validInput(input)) throw invalid();
      const old = await lookup(tx, input.key, input.fingerprint);
      if (old) return { ...old.ref };
      if (!await telegramSourceActive(tx, input.source)) throw invalid();
      const ref = { key: input.key, taskId: await tx.createTask(task, { key: input.key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) };
      const fixed: PersonalTelegramCallbackInput = { key: input.key, source: { botId: input.source.botId, ownerId: input.source.ownerId, generation: input.source.generation }, queryId: input.queryId, fingerprint: input.fingerprint, origin: input.origin };
      const admission = (await tx.appendEntry(PersonalTelegramCallbackAdmission, ROOT_CONVERSATION_ID, { data: { v: 1, ref, input: fixed } })).id;
      (await tx.doc(PersonalTelegramCallbackDoc, input.key, null)).ack = { v: 1, ref, input: fixed, admission, state: "pending" };
      (await tx.doc(PersonalTelegramCallbacksDoc)).keys.push(input.key);
      return ref;
    }, verify: verifyPersonalTelegramCallbacks,
  };
}

export async function verifyPersonalTelegramCallbacks(tx: Tx) {
  const keys = (await tx.doc(PersonalTelegramCallbacksDoc)).keys;
  if (!Array.isArray(keys) || new Set(keys).size !== keys.length) throw invalid();
  const tasks = new Set<TaskId>(), entries = new Set<EntryId>(), interrupted: PersonalTelegramCallbackRecord[] = [];
  for (const key of keys) {
    if (typeof key !== "string") throw invalid();
    const value = await lookup(tx, key), task = value && await tx.task(value.ref.taskId), admission = value && await tx.entry(PersonalTelegramCallbackAdmission, value.admission);
    if (!value || !positive(value.admission) || tasks.has(value.ref.taskId) || task?.kind !== TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || task.owner !== undefined || !task.background || !isDeepStrictEqual(task.input, { key }) || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || admission.model !== undefined || admission.id <= value.input.origin || !isDeepStrictEqual(admission.data, { v: 1, ref: value.ref, input: value.input }) || !["pending", "sending", "sent", "failed", "effect_unknown", "canceled"].includes(value.state)) throw invalid();
    await verifyOrigin(tx, value.input);
    tasks.add(task.id); entries.add(value.admission);
    if (entries.has(value.input.origin)) throw invalid();
    entries.add(value.input.origin);
    if (value.claim !== undefined) {
      const claim = await tx.entry(PersonalTelegramCallbackClaim, value.claim);
      if (!claim || claim.id <= value.admission || claim.conversationId !== ROOT_CONVERSATION_ID || claim.model !== undefined || !isDeepStrictEqual(claim.data, { ref: value.ref, admission: value.admission, source: value.input.source, queryId: value.input.queryId, fingerprint: value.input.fingerprint })) throw invalid();
      entries.add(claim.id);
    }
    const terminal = value.state !== "pending" && value.state !== "sending";
    if (!terminal) {
      if (value.observation !== undefined || value.code !== undefined || value.effect !== undefined || value.state === "pending" && value.claim !== undefined || value.state === "sending" && value.claim === undefined) throw invalid();
      if (task.state.status === "terminal") {
        if (!["failed", "faulted", "orphaned"].includes(task.state.outcome.status)) throw invalid();
        interrupted.push(value);
        continue;
      }
      const checkpoint = task.state.checkpoint;
      if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.phase !== (value.state === "pending" ? "send" : "verify")) throw invalid();
      continue;
    }
    const observation = value.observation !== undefined && await tx.entry(PersonalTelegramCallbackObservation, value.observation);
    const result = { state: value.state, code: value.code, effect: value.effect };
    if (!observation || observation.id <= (value.claim ?? value.admission) || observation.conversationId !== ROOT_CONVERSATION_ID || observation.model !== undefined || typeof value.code !== "string" || !value.code || !["returned", "not_sent", "effect_unknown"].includes(value.effect!) || (value.state === "canceled" ? value.claim !== undefined || value.effect !== "not_sent" : value.claim === undefined || value.effect !== (value.state === "sent" ? "returned" : value.state === "failed" ? "not_sent" : "effect_unknown"))) throw invalid();
    if (!isDeepStrictEqual(observation.data, { ref: value.ref, admission: value.admission, ...(value.claim === undefined ? {} : { claim: value.claim }), ...result }) || task.state.status !== "terminal") throw invalid();
    if (["completed", "aborted"].includes(task.state.outcome.status) ? !isDeepStrictEqual(task.state.outcome.result, result) : !["failed", "faulted", "orphaned"].includes(task.state.outcome.status) || !isDeepStrictEqual(result, interruptedOutcome(value.claim !== undefined))) throw invalid();
    entries.add(observation.id);
  }
  let cursor: Cursor | undefined;
  do { const page = await tx.scanTasks({ kind: TASK }, 256, cursor); if (page.items.some(task => !tasks.has(task.id))) throw invalid(); cursor = page.next; } while (cursor);
  cursor = undefined;
  do { const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor); if (page.items.some(entry => ["ruukoto.telegram-callback", "ruukoto.telegram-callback-rejected", PersonalTelegramCallbackAdmission.kind, PersonalTelegramCallbackClaim.kind, PersonalTelegramCallbackObservation.kind].includes(entry.kind) && !entries.has(entry.id))) throw invalid(); cursor = page.next; } while (cursor);
  // A terminal task keeps its fault receipt; only the verified transport observation is reconciled.
  for (const value of interrupted) await observe(tx, value, interruptedOutcome(value.claim !== undefined));
}
