import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalError } from "./personal-error.ts";
import { PersonalImApiError, type PersonalImAccess, type PersonalImDocument, type PersonalImKeyboard, type PersonalImSender } from "./personal-im-api.ts";
import { telegramSourceActive } from "./personal-permissions.ts";
import { samePersonalEntry, type PersonalEntryIdentity } from "./personal-telegram-records.ts";

export const PERSONAL_IM_DELIVERY = "personal-im-delivery";
export const PERSONAL_IM_TEXT_LIMIT = 4096;
export const PERSONAL_IM_SEND_ATTEMPTS = 3;
const TASK = "ruukoto.im-delivery";
const context = BACKGROUND_CONTEXT;
type PartState = "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled";
export type PersonalImDeliveryRef = { key: string; taskId: TaskId<PersonalImDeliveryResult> };
export type PersonalImDeliveryOutputRef = { publication: EntryId; output: EntryId } | { recovery: { requestId: string; image: string } };
export type PersonalImDeliveryInput = { key: string; source: PersonalEntryIdentity; messageId: number; text: string; keyboard?: PersonalImKeyboard; outputs?: PersonalImDeliveryOutputRef[]; retrieval?: { delivery: PersonalImDeliveryRef; segments: number[] } };
type Content = { kind: "text"; text: string } | { kind: "output"; output: PersonalImDeliveryOutputRef };
export type PersonalImDeliveryPart = Content & { index: number; state: PartState; claims: EntryId[]; observations: EntryId[]; code?: string; platformMessageId?: string; retryAt?: number };
export type PersonalImDeliveryResult = { state: PartState; textState: PartState | "none"; outputState: PartState | "none" };
export type PersonalImDeliveryRecord = { v: 1; ref: PersonalImDeliveryRef; admission: EntryId; input: PersonalImDeliveryInput; parent?: TaskId; parts: PersonalImDeliveryPart[]; canceled?: EntryId };
export type PersonalImDeliveryDocument = PersonalImDocument & { sha256: string; partial: boolean };
export type PersonalImDeliveryOutputLoader = (output: PersonalImDeliveryOutputRef, source: PersonalEntryIdentity, signal: AbortSignal) => Promise<PersonalImDeliveryDocument>;
export type PersonalImDeliveryAuthorization = (tx: Tx, input: PersonalImDeliveryInput, parent?: TaskId) => Promise<boolean | "wait">;
type Admission = { v: 1; ref: PersonalImDeliveryRef; input: PersonalImDeliveryInput; parent?: TaskId };
type Claim = { ref: PersonalImDeliveryRef; admission: EntryId; index: number; attempt: number; source: PersonalEntryIdentity; messageId: number; content: Content; keyboard?: PersonalImKeyboard; configurationVersion?: string };
type Observation = { ref: PersonalImDeliveryRef; admission: EntryId; index: number; claim?: EntryId; state: Exclude<PartState, "sending">; code: string; platformMessageId?: string; retryAt?: number };
export const PersonalImDeliveriesDoc = defineDoc<{ keys: string[] }>({ kind: "ruukoto.im-deliveries", scope: "session", version: 1, initial: () => ({ keys: [] }) });
export const PersonalImDeliveryDoc = defineDocFamily<{ delivery?: PersonalImDeliveryRecord }, null>({ kind: "ruukoto.im-delivery", scope: "session", version: 1, family: true, initial: () => ({}) });
const DeliveryAdmission = defineEntry<Admission>("ruukoto.im-delivery-admission");
const DeliveryClaim = defineEntry<Claim>("ruukoto.im-delivery-claim");
const DeliveryObservation = defineEntry<Observation>("ruukoto.im-delivery-observation");
const DeliveryCancel = defineEntry<{ ref: PersonalImDeliveryRef; admission: EntryId }>("ruukoto.im-delivery-cancel");
const invalid = () => new PersonalError("im_delivery_invalid", "原发送内容或收发记录无法核实，请查询原结果。");
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const content = (part: PersonalImDeliveryPart): Content => part.kind === "text" ? { kind: "text", text: part.text } : { kind: "output", output: { ...part.output } };
function validOutput(value: PersonalImDeliveryOutputRef) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "recovery" in value ? Object.keys(value).length === 1 && value.recovery && Object.keys(value.recovery).length === 2 && typeof value.recovery.requestId === "string" && value.recovery.requestId.length > 0 && value.recovery.requestId.length <= 1024 && typeof value.recovery.image === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.recovery.image) : positive(value.publication) && positive(value.output);
}

export function personalImTextSegments(text: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + PERSONAL_IM_TEXT_LIMIT, text.length);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
    parts.push(text.slice(start, end)); start = end;
  }
  return parts;
}
function expectedContents(input: PersonalImDeliveryInput): Content[] { return [...personalImTextSegments(input.text).map(text => ({ kind: "text" as const, text })), ...(input.outputs ?? []).map(output => ({ kind: "output" as const, output }))]; }
function keyboardFor(value: PersonalImDeliveryRecord, index: number) { return value.input.keyboard && value.parts[index].kind === "text" && value.parts.findLastIndex(part => part.kind === "text") === index ? copyJson(value.input.keyboard) as PersonalImKeyboard : undefined; }
function groupState(parts: PersonalImDeliveryPart[]): PartState | "none" {
  if (!parts.length) return "none";
  return (["effect_unknown", "sending", "pending", "failed", "canceled", "sent"] as const).find(state => parts.some(part => part.state === state))!;
}
export function personalImDeliveryResult(value: PersonalImDeliveryRecord): PersonalImDeliveryResult {
  return { state: groupState(value.parts) as PartState, textState: groupState(value.parts.filter(part => part.kind === "text")), outputState: groupState(value.parts.filter(part => part.kind === "output")) };
}
function validInput(value: PersonalImDeliveryInput) {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.key === "string" && value.key.length > 0 && value.key.length <= 1024 && !value.key.includes("\0") && positive(value.messageId) && typeof value.text === "string" && value.source && typeof value.source === "object" && !Array.isArray(value.source) && (value.source.platform === undefined || value.source.platform === "qq") && typeof value.source.botId === "string" && /^[1-9]\d*$/.test(value.source.botId) && typeof value.source.ownerId === "string" && /^[1-9]\d*$/.test(value.source.ownerId) && typeof value.source.generation === "string" && value.source.generation.length > 0 && value.source.generation.length <= 256 && (value.outputs === undefined || Array.isArray(value.outputs) && value.outputs.length <= 8 && value.outputs.every(validOutput)) && (value.text.length > 0 || !!value.outputs?.length) && (value.keyboard === undefined || value.text.length > 0 && value.source.platform === undefined && !value.retrieval && !value.outputs?.length && Array.isArray(value.keyboard) && value.keyboard.length > 0 && value.keyboard.every(row => Array.isArray(row) && row.length > 0 && row.every(button => button && typeof button.text === "string" && button.text.trim().length > 0 && typeof button.callback_data === "string" && Buffer.byteLength(button.callback_data) > 0 && Buffer.byteLength(button.callback_data) <= 64)));
}
export async function personalImDeliveryRecord(tx: Tx, ref: PersonalImDeliveryRef) {
  const value = (await tx.doc(PersonalImDeliveryDoc, ref.key, null)).delivery;
  if (!value || !isDeepStrictEqual(value.ref, ref) || value.input.key !== ref.key) throw invalid();
  return value;
}
async function parentCanceled(tx: Tx, value: PersonalImDeliveryRecord) {
  if (value.parent === undefined) return false;
  const parent = await tx.task(value.parent);
  if (!parent || parent.id >= value.ref.taskId) throw invalid();
  return parent.abortRequested || (parent.state.status === "terminal" || parent.state.status === "completing") && parent.state.outcome.status !== "completed";
}
async function observation(tx: Tx, value: PersonalImDeliveryRecord, part: PersonalImDeliveryPart, state: Observation["state"], code: string, extra: Pick<Observation, "platformMessageId" | "retryAt"> = {}) {
  const claim = part.state === "sending" ? part.claims.at(-1) : undefined;
  const entry = await tx.appendEntry(DeliveryObservation, ROOT_CONVERSATION_ID, { data: { ref: value.ref, admission: value.admission, index: part.index, ...(claim === undefined ? {} : { claim }), state, code, ...extra } });
  part.state = state; part.code = code; part.observations.push(entry.id);
  if (extra.platformMessageId) part.platformMessageId = extra.platformMessageId;
  if (extra.retryAt !== undefined) part.retryAt = extra.retryAt; else delete part.retryAt;
}
async function stopPending(tx: Tx, value: PersonalImDeliveryRecord, code: string) { for (const part of value.parts) if (part.state === "pending") await observation(tx, value, part, "canceled", code); }
async function terminalInterrupted(tx: Tx, value: PersonalImDeliveryRecord) {
  const task = await tx.task(value.ref.taskId);
  if (!task || task.kind !== TASK || !isDeepStrictEqual(task.input, { key: value.ref.key })) throw invalid();
  return task.state.status === "terminal" && ["faulted", "orphaned", "failed"].includes(task.state.outcome.status);
}
async function reconcileInterrupted(tx: Tx, value: PersonalImDeliveryRecord) {
  for (const part of value.parts) if (part.state === "sending") await observation(tx, value, part, "effect_unknown", "send_interrupted");
  await stopPending(tx, value, "delivery_interrupted");
}
async function recoverTerminal(tx: Tx, value: PersonalImDeliveryRecord) { if (await terminalInterrupted(tx, value)) await reconcileInterrupted(tx, value); }
function textReceipt(parts: PersonalImDeliveryPart[]) {
  const state = groupState(parts), platformMessageId = state === "sent" ? parts.at(-1)?.platformMessageId : undefined;
  if (state === "sent" && !platformMessageId) throw invalid();
  return { state, ...(platformMessageId === undefined ? {} : { platformMessageId }) };
}
// The closure stays in its preparing transaction; all table reads precede its recovery writes.
export async function preparePersonalImDeliveryTextReceipt(tx: Tx, ref: PersonalImDeliveryRef) {
  const value = await personalImDeliveryRecord(tx, ref), interrupted = await terminalInterrupted(tx, value);
  return async () => { if (interrupted) await reconcileInterrupted(tx, value); return textReceipt(value.parts.filter(part => part.kind === "text")); };
}
export async function settlePersonalImDelivery(tx: Tx, ref: PersonalImDeliveryRef) { const value = await personalImDeliveryRecord(tx, ref); await recoverTerminal(tx, value); return personalImDeliveryResult(value); }
export async function personalImDeliveryTextReceipt(tx: Tx, ref: PersonalImDeliveryRef, before?: EntryId) {
  if (before === undefined) return (await preparePersonalImDeliveryTextReceipt(tx, ref))();
  const value = await personalImDeliveryRecord(tx, ref);
  if (!positive(before) || before <= value.admission) throw invalid();
  const parts = [];
  for (const part of value.parts) if (part.kind === "text") {
    let state: PartState = part.state, platformMessageId = part.platformMessageId;
    if (before !== undefined) {
      state = "pending"; platformMessageId = undefined;
      for (const id of [...part.claims, ...part.observations].filter(id => id < before).sort((a, b) => a - b)) {
        const entry = await tx.entry(id);
        if (!entry || !DeliveryClaim.is(entry) && !DeliveryObservation.is(entry) || !isDeepStrictEqual(entry.data.ref, ref) || entry.data.admission !== value.admission || entry.data.index !== part.index) throw invalid();
        if (DeliveryClaim.is(entry)) { state = "sending"; platformMessageId = undefined; }
        else if (DeliveryObservation.is(entry)) { state = entry.data.state; platformMessageId = entry.data.platformMessageId; }
      }
    }
    parts.push({ ...part, state, platformMessageId });
  }
  return textReceipt(parts);
}
export async function cancelPersonalImDelivery(tx: Tx, ref: PersonalImDeliveryRef) {
  const value = await personalImDeliveryRecord(tx, ref);
  if (!value.parts.some(part => part.state === "pending" || part.state === "sending")) return;
  if (!value.canceled) value.canceled = (await tx.appendEntry(DeliveryCancel, ROOT_CONVERSATION_ID, { data: { ref, admission: value.admission } })).id;
  await stopPending(tx, value, "delivery_canceled");
}
function complete(value: PersonalImDeliveryRecord) { return { status: "terminal" as const, outcome: { status: "completed" as const, result: personalImDeliveryResult(value) } }; }
function next(value: PersonalImDeliveryRecord) { const part = value.parts.find(part => part.state === "pending"); return part ? { status: "running" as const, checkpoint: { phase: "send" as const, index: part.index } } : complete(value); }

// Note: See .agents/notes/implemented/architecture/2026-11-06-personal-telegram-delivery.md
export async function requestPersonalImDelivery(tx: Tx, input: PersonalImDeliveryInput, parent?: TaskId): Promise<PersonalImDeliveryRef> {
  if (!validInput(input) || parent !== undefined && !positive(parent)) throw invalid();
  const previous = (await tx.doc(PersonalImDeliveryDoc, input.key, null)).delivery;
  if (previous) {
    if (!isDeepStrictEqual(previous.input, input) || previous.parent !== parent) throw new PersonalError("im_delivery_conflict", "原发送请求已登记，内容不符；请查询原结果。");
    return { ...previous.ref };
  }
  if (!await telegramSourceActive(tx, input.source)) throw new PersonalError("im_delivery_source_inactive", "原私聊入口已失效，未登记发送；请查询原入口。");
  if (parent !== undefined && !await tx.task(parent)) throw invalid();
  if (input.retrieval) {
    const original = await personalImDeliveryRecord(tx, input.retrieval.delivery), indices = input.retrieval.segments;
    if (input.outputs?.length || !samePersonalEntry(original.input.source, input.source) || !Array.isArray(indices) || !indices.length || indices.some((index, position) => !Number.isSafeInteger(index) || index < 0 || index >= original.parts.length || original.parts[index].kind !== "text" || position > 0 && index <= indices[position - 1]) || input.text !== indices.map(index => { const part = original.parts[index]; return part.kind === "text" ? part.text : ""; }).join("")) throw new PersonalError("im_retrieval_invalid", "所选内容不属于原私聊的已保存结果，未重新发送。");
  }
  const ref = { key: input.key, taskId: await tx.createTask(PersonalImDeliveryTask, { key: input.key }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) };
  const fixed = copyJson(input) as PersonalImDeliveryInput;
  const admission = (await tx.appendEntry(DeliveryAdmission, ROOT_CONVERSATION_ID, { data: { v: 1, ref, input: fixed, ...(parent === undefined ? {} : { parent }) } })).id;
  (await tx.doc(PersonalImDeliveryDoc, input.key, null)).delivery = { v: 1, ref, admission, input: fixed, ...(parent === undefined ? {} : { parent }), parts: expectedContents(fixed).map((part, index) => ({ ...part, index, state: "pending", claims: [], observations: [] })) };
  (await tx.doc(PersonalImDeliveriesDoc)).keys.push(input.key);
  return ref;
}

function deliveryTask(im?: PersonalImAccess, loadOutput?: PersonalImDeliveryOutputLoader, authorize?: PersonalImDeliveryAuthorization, getHarness?: () => Harness) {
  return defineTask<{ key: string }, { phase: "send"; index: number; retryAt?: number } | { phase: "verify"; index: number }, PersonalImDeliveryResult>({
    name: TASK, version: 1, initial: () => ({ phase: "send", index: 0 }),
    phases: {
      async send(current, runtime, callContext) {
        const ref: PersonalImDeliveryRef = { key: current.input.key, taskId: current.id };
        if (current.state.checkpoint.retryAt) await runtime.sleep(current.state.checkpoint.retryAt, callContext);
        let selected: PersonalImDeliveryPart | undefined, source: PersonalEntryIdentity | undefined;
        await runtime.commit(async tx => {
          const value = await personalImDeliveryRecord(tx, ref);
          if (value.canceled || await parentCanceled(tx, value) || !await telegramSourceActive(tx, value.input.source) || im && !im.isActive(value.input.source)) { await stopPending(tx, value, "source_or_parent_inactive"); return complete(value); }
          if (value.parts.some(part => part.state === "sending")) throw invalid();
          const part = value.parts.find(part => part.state === "pending");
          if (!part) return complete(value);
          selected = copyJson(part) as PersonalImDeliveryPart; source = { ...value.input.source };
          return undefined;
        }, callContext);
        if (!selected || !source) return;
        const index = selected.index;
        let file: PersonalImDeliveryDocument | undefined, fileError: string | undefined;
        if (selected.kind === "output") {
          try {
            if (!loadOutput) throw new PersonalError("im_output_unavailable", "最终文件读取入口不可用。");
            file = await loadOutput(selected.output, source, runtime.signal);
            if (file.partial || file.bytes.byteLength > 8 * 1024 * 1024) throw new PersonalError("output_partial", "此文件只保存了片段或超过8MiB，无法完整发送。");
            if (createHash("sha256").update(file.bytes).digest("hex") !== file.sha256) throw new PersonalError("artifact_unavailable", "原文件完整性无法核实。");
          } catch (error) {
            fileError = error instanceof PersonalError ? error.code : "im_output_unavailable";
            if (!(error instanceof PersonalError)) process.stderr.write("[ruukoto:personal] 最终文件读取失败，原业务结果保留；请查询原文件。\n");
          }
        }
        let fixed: PersonalImSender | undefined, target: { owner: string; message: number; content: Content; keyboard?: PersonalImKeyboard } | undefined;
        let waiting = false;
        const claim = async () => {
          await runtime.commit(async tx => {
            const value = await personalImDeliveryRecord(tx, ref), part = value.parts[index];
            if (!part || part.state !== "pending") { if (part?.state === "canceled") return complete(value); throw invalid(); }
            if (value.canceled || await parentCanceled(tx, value) || !await telegramSourceActive(tx, source!) || im && !im.isActive(source!)) { await stopPending(tx, value, "source_or_parent_inactive"); return complete(value); }
            const allowed = authorize ? await authorize(tx, value.input, value.parent) : true;
            if (allowed === "wait") { waiting = true; return undefined; }
            if (!allowed) { await stopPending(tx, value, "source_or_parent_inactive"); return complete(value); }
            if (fileError) { await observation(tx, value, part, "failed", fileError); return next(value); }
            const prior = value.parts.slice(0, index);
            if (prior.some(part => part.state !== "sent" && !(part.kind === "output" && part.state === "failed"))) throw invalid();
            const version = im?.configurationVersion(source!);
            const keyboard = keyboardFor(value, index);
            const entry = await tx.appendEntry(DeliveryClaim, ROOT_CONVERSATION_ID, { data: { ref, admission: value.admission, index, attempt: part.claims.length, source: source!, messageId: value.input.messageId, content: content(part), ...(keyboard === undefined ? {} : { keyboard }), ...(version === undefined ? {} : { configurationVersion: version }) } });
            part.state = "sending"; part.claims.push(entry.id); delete part.retryAt;
            target = { owner: source!.ownerId, message: value.input.messageId, content: content(part), ...(keyboard === undefined ? {} : { keyboard }) };
            return { status: "running", checkpoint: { phase: "verify", index } };
          }, callContext);
          if (target) fixed = im?.sender(source!);
        };
        for (;;) {
          const harness = getHarness?.();
          let wake!: () => void, stop!: (error: unknown) => void;
          const changed = new Promise<void>((resolve, reject) => { wake = resolve; stop = reject; });
          void changed.catch(() => undefined);
          const unsubscribe = harness?.subscribeCommits(wake), unclose = harness?.subscribeClose(() => stop(new PersonalError("im_delivery_wait_stopped", "原发送等待已停止，请查询原结果。")));
          const abort = () => stop(runtime.signal.reason); runtime.signal.addEventListener("abort", abort, { once: true });
          try {
            waiting = false;
            if (im) await im.withEntry(source, claim); else await claim();
            if (!waiting) break;
            if (!harness) throw invalid();
            await changed;
          } finally { unsubscribe?.(); unclose?.(); runtime.signal.removeEventListener("abort", abort); }
        }
        if (!target) return;
        let message: string | undefined, failure: PersonalImApiError | undefined;
        try {
          if (!fixed) throw new PersonalImApiError("im_target_inactive", "原入口不可用，未发送。", "not_sent");
          if (target.content.kind === "text") message = await fixed.send(target.owner, target.message, target.content.text, runtime.signal, target.keyboard);
          else {
            if (!file || !fixed.document) throw new PersonalImApiError("im_media_unavailable", "原入口不支持文件发送，未发送。", "not_sent");
            message = await fixed.document(target.owner, target.message, file, runtime.signal);
          }
          if (typeof message !== "string" || !message) throw new PersonalImApiError("im_send_unverified", "原发送回执无法核实。", "effect_unknown");
        } catch (error) {
          failure = error instanceof PersonalImApiError ? error : new PersonalImApiError("im_send_unverified", "原发送结果无法核实，请查询原私聊。", "effect_unknown");
          if (!(error instanceof PersonalImApiError)) process.stderr.write("[ruukoto:personal] 原发送结果无法核实，后续部分已停止；请查询原私聊。\n");
        }
        await runtime.commit(async tx => {
          const value = await personalImDeliveryRecord(tx, ref), part = value.parts[index];
          if (!part || part.state !== "sending") throw invalid();
          if (value.input.source.platform === undefined && failure?.effect === "not_sent" && failure.code === "telegram_rate_limited" && failure.retryAfterMs !== undefined && Number.isSafeInteger(failure.retryAfterMs) && failure.retryAfterMs > 0 && part.claims.length < PERSONAL_IM_SEND_ATTEMPTS && !value.canceled && !await parentCanceled(tx, value) && await telegramSourceActive(tx, value.input.source) && (!im || im.isActive(value.input.source))) {
            const retryAt = runtime.now() + failure.retryAfterMs;
            if (positive(retryAt)) {
              await observation(tx, value, part, "pending", failure.code, { retryAt });
              return { status: "running", checkpoint: { phase: "send", index, retryAt } };
            }
          }
          const state = failure ? failure.effect === "not_sent" ? "failed" : "effect_unknown" : "sent";
          await observation(tx, value, part, state, failure?.code ?? "sent", message && !failure ? { platformMessageId: message } : {});
          if (state === "effect_unknown" || state === "failed" && part.kind === "text") await stopPending(tx, value, state === "effect_unknown" ? "previous_send_unknown" : "previous_send_failed");
          return next(value);
        }, callContext);
      },
      async verify(current, runtime, callContext) {
        await runtime.commit(async tx => {
          const value = await personalImDeliveryRecord(tx, { key: current.input.key, taskId: current.id }), part = value.parts[current.state.checkpoint.index];
          if (!part || part.state !== "sending") throw invalid();
          await observation(tx, value, part, "effect_unknown", "send_interrupted"); await stopPending(tx, value, "previous_send_unknown");
          return complete(value);
        }, callContext);
      },
    },
    async abort(current, runtime, callContext) {
      await runtime.commit(async tx => {
        const ref = { key: current.input.key, taskId: current.id }, value = await personalImDeliveryRecord(tx, ref);
        await cancelPersonalImDelivery(tx, ref);
        for (const part of value.parts) if (part.state === "sending") await observation(tx, value, part, "effect_unknown", "send_interrupted");
        return { status: "terminal", outcome: { status: "aborted", result: personalImDeliveryResult(value) } };
      }, callContext);
    },
  });
}
const PersonalImDeliveryTask = deliveryTask();

export function personalImDelivery(getHarness: () => Harness, im: PersonalImAccess, loadOutput?: PersonalImDeliveryOutputLoader, authorize?: PersonalImDeliveryAuthorization) {
  return { extension: defineExtension({ name: PERSONAL_IM_DELIVERY, tasks: [deliveryTask(im, loadOutput, authorize, getHarness)] }), request: requestPersonalImDelivery, cancel: cancelPersonalImDelivery,
    async get(ref: PersonalImDeliveryRef) { return getHarness().commit(async tx => copyJson(await personalImDeliveryRecord(tx, ref)) as PersonalImDeliveryRecord, context); },
    async wait(ref: PersonalImDeliveryRef) { await getHarness().waitForTask(ref.taskId, context); return getHarness().commit(tx => settlePersonalImDelivery(tx, ref), context); },
    async abort(ref: PersonalImDeliveryRef) { await getHarness().commit(tx => cancelPersonalImDelivery(tx, ref), context); await getHarness().abortTask(ref.taskId, context); await getHarness().waitForTask(ref.taskId, context); return getHarness().commit(tx => settlePersonalImDelivery(tx, ref), context); },
    verify: verifyPersonalImDeliveries,
  };
}

export async function verifyPersonalImDeliveries(tx: Tx, keys?: string[]) {
  const index = (await tx.doc(PersonalImDeliveriesDoc)).keys;
  if (!Array.isArray(index) || new Set(index).size !== index.length || keys && !isDeepStrictEqual([...index].sort(), [...keys].sort())) throw invalid();
  const tasks = new Set<TaskId>(), entries = new Set<EntryId>(), interrupted: PersonalImDeliveryRecord[] = [];
  for (const key of index) {
    const value = (await tx.doc(PersonalImDeliveryDoc, key, null)).delivery, task = value && await tx.task(value.ref.taskId), admission = value && await tx.entry(DeliveryAdmission, value.admission);
    if (!value || value.v !== 1 || !validInput(value.input) || value.input.key !== key || value.ref.key !== key || tasks.has(value.ref.taskId) || task?.kind !== TASK || task.version !== 1 || task.conversationId !== ROOT_CONVERSATION_ID || task.owner !== undefined || !task.background || !isDeepStrictEqual(task.input, { key }) || !admission || admission.conversationId !== ROOT_CONVERSATION_ID || admission.model !== undefined || !isDeepStrictEqual(admission.data, { v: 1, ref: value.ref, input: value.input, ...(value.parent === undefined ? {} : { parent: value.parent }) }) || !Array.isArray(value.parts) || !isDeepStrictEqual(value.parts.map(content), expectedContents(value.input))) throw invalid();
    tasks.add(task.id); entries.add(value.admission);
    if (value.parent !== undefined) { const parent = await tx.task(value.parent); if (!parent || parent.id >= task.id) throw invalid(); }
    if (value.input.retrieval) {
      const original = await personalImDeliveryRecord(tx, value.input.retrieval.delivery), positions = value.input.retrieval.segments;
      if (original.admission >= value.admission || !samePersonalEntry(value.input.source, original.input.source) || !Array.isArray(positions) || !positions.length || positions.some((position, offset) => !Number.isSafeInteger(position) || position < 0 || position >= original.parts.length || original.parts[position].kind !== "text" || offset > 0 && position <= positions[offset - 1]) || value.input.outputs?.length || value.input.text !== positions.map(position => { const part = original.parts[position]; return part.kind === "text" ? part.text : ""; }).join("")) throw invalid();
    }
    if (value.canceled) { const cancel = await tx.entry(DeliveryCancel, value.canceled); if (!cancel || cancel.conversationId !== ROOT_CONVERSATION_ID || cancel.id <= value.admission || !isDeepStrictEqual(cancel.data, { ref: value.ref, admission: value.admission })) throw invalid(); entries.add(cancel.id); }
    let unfinished = false, predecessor = value.admission;
    for (const [position, part] of value.parts.entries()) {
      if (part.index !== position || !["pending", "sending", "sent", "failed", "effect_unknown", "canceled"].includes(part.state) || !Array.isArray(part.claims) || part.claims.length > PERSONAL_IM_SEND_ATTEMPTS || !Array.isArray(part.observations) || new Set(part.claims).size !== part.claims.length || new Set(part.observations).size !== part.observations.length) throw invalid();
      let state: PartState = "pending", last = value.admission, attempt = 0, claim: EntryId | undefined, message: string | undefined, code: string | undefined, retryAt: number | undefined;
      const history = [...part.claims, ...part.observations].sort((a, b) => a - b);
      if (new Set(history).size !== history.length) throw invalid();
      for (const id of history) {
        if (!positive(id) || id <= last || entries.has(id)) throw invalid();
        const entry = await tx.entry(id); if (!entry || entry.conversationId !== ROOT_CONVERSATION_ID || entry.model !== undefined) throw invalid();
        if (part.claims.includes(id)) {
          const keyboard = keyboardFor(value, position);
          if (!DeliveryClaim.is(entry) || state !== "pending" || unfinished || id <= predecessor || !isDeepStrictEqual(entry.data, { ref: value.ref, admission: value.admission, index: position, attempt, source: value.input.source, messageId: value.input.messageId, content: content(part), ...(keyboard === undefined ? {} : { keyboard }), ...(entry.data.configurationVersion === undefined ? {} : { configurationVersion: entry.data.configurationVersion }) }) || entry.data.configurationVersion !== undefined && (typeof entry.data.configurationVersion !== "string" || !entry.data.configurationVersion) || value.canceled && id >= value.canceled) throw invalid();
          state = "sending"; claim = id; attempt++; retryAt = undefined;
        } else {
          if (!DeliveryObservation.is(entry)) throw invalid();
          const data = entry.data;
          if (!isDeepStrictEqual(data, { ref: value.ref, admission: value.admission, index: position, ...(state === "sending" ? { claim } : {}), state: data.state, code: data.code, ...(data.platformMessageId === undefined ? {} : { platformMessageId: data.platformMessageId }), ...(data.retryAt === undefined ? {} : { retryAt: data.retryAt }) }) || typeof data.code !== "string" || !data.code || (state !== "pending" && state !== "sending") || !["pending", "sent", "failed", "effect_unknown", "canceled"].includes(data.state) || state === "pending" && !["failed", "canceled"].includes(data.state) || state === "pending" && data.state === "failed" && part.kind !== "output" || state === "sending" && data.state === "canceled" || data.state === "pending" && (state !== "sending" || value.input.source.platform !== undefined || attempt >= PERSONAL_IM_SEND_ATTEMPTS || data.code !== "telegram_rate_limited" || !Number.isSafeInteger(data.retryAt) || data.retryAt! < 1) || data.state !== "pending" && data.retryAt !== undefined || (data.state === "sent") !== (typeof data.platformMessageId === "string" && !!data.platformMessageId) || data.state !== "sent" && data.platformMessageId !== undefined) throw invalid();
          state = data.state; code = data.code; message = data.platformMessageId; retryAt = data.retryAt;
        }
        last = id; entries.add(id);
      }
      if (state !== part.state || code !== part.code || message !== part.platformMessageId || retryAt !== part.retryAt || part.claims.length !== attempt) throw invalid();
      if (part.state !== "sent" && !(part.kind === "output" && part.state === "failed")) unfinished = true;
      if (part.state === "sent" || part.kind === "output" && part.state === "failed") predecessor = last;
    }
    if (task.state.status === "terminal") {
      if (["failed", "faulted", "orphaned"].includes(task.state.outcome.status)) interrupted.push(value);
      else if (value.parts.some(part => part.state === "pending" || part.state === "sending") || !isDeepStrictEqual(task.state.outcome.result, personalImDeliveryResult(value))) throw invalid();
    } else if (task.state.status !== "completing") {
      const checkpoint = task.state.checkpoint;
      if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || checkpoint.phase !== "send" && checkpoint.phase !== "verify" || typeof checkpoint.index !== "number" || !Number.isSafeInteger(checkpoint.index) || checkpoint.index < 0 || checkpoint.index >= value.parts.length || checkpoint.phase === "verify" && value.parts[checkpoint.index].state !== "sending" || checkpoint.phase === "send" && (value.parts.some(part => part.state === "sending") || value.parts.some(part => part.state === "pending") && value.parts.find(part => part.state === "pending")?.index !== checkpoint.index) || checkpoint.retryAt !== undefined && (!Number.isSafeInteger(checkpoint.retryAt) || Number(checkpoint.retryAt) < 1 || !value.canceled && checkpoint.retryAt !== value.parts[checkpoint.index].retryAt)) throw invalid();
    }
  }
  let cursor: Cursor | undefined;
  do { const page = await tx.scanTasks({ kind: TASK }, 256, cursor); if (page.items.some(task => !tasks.has(task.id))) throw invalid(); cursor = page.next; } while (cursor);
  do {
    const page = await tx.scanConversations({}, 256, cursor);
    for (const conversation of page.items) {
      let partCursor: Cursor | undefined;
      do { const page = await tx.scanEntries({ conversationId: conversation.id }, 256, partCursor); if (page.items.some(entry => [DeliveryAdmission.kind, DeliveryClaim.kind, DeliveryObservation.kind, DeliveryCancel.kind].includes(entry.kind) && !entries.has(entry.id))) throw invalid(); partCursor = page.next; } while (partCursor);
    }
    cursor = page.next;
  } while (cursor);
  // Finish every integrity read before recovery observations enter the transaction.
  for (const value of interrupted) await reconcileInterrupted(tx, value);
}
