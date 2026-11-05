import { type Cursor, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { PersonalWorkDoc, PersonalWorkTask, personalWorkRef, personalWorkSummary, type PersonalWorkInstructionSnapshot, type PersonalWorkRef } from "./personal-work.ts";
import { personalDelegation, personalDelegationProgress } from "./personal-delegation.ts";
import { isDeepStrictEqual } from "node:util";
import { PersonalDesktopActionDoc, PersonalDesktopActionsDoc, personalDesktopTarget, personalDesktopTargets } from "./personal-desktop-actions.ts";
import { PersonalQuestionsDoc, personalQuestion, personalQuestionActions, refreshPersonalQuestions, type PersonalQuestion } from "./personal-questions.ts";
import { PersonalError } from "./personal-error.ts";
import type { PersonalDesktopApproval, PersonalDesktopFamily, PersonalDesktopOperation, PersonalDesktopPage, PersonalDesktopQuestion, PersonalDesktopState, PersonalDesktopWork } from "@ruukoto/view/personal-protocol.ts";

type Offsets = { approvals?: number; works?: number; delegations?: number; questions?: number };
const PAGE_SIZE = 8;
function page<T>(items: T[], offset = 0): PersonalDesktopPage<T> { return { items: items.slice(offset, offset + PAGE_SIZE), total: items.length, ...(offset + PAGE_SIZE < items.length ? { nextOffset: offset + PAGE_SIZE } : {}) }; }
function question(value: PersonalQuestion): PersonalDesktopQuestion {
  const text = Array.from(value.questions[0].question);
  return { id: value.id, version: value.version, status: value.status, question: text.slice(0, 140).join("") + (text.length > 140 ? "…" : ""), ...personalQuestionActions(value), admission: value.admission, occurrence: value.admission, ...(value.origin.work ? { work: value.origin.work.ref.taskId } : {}) };
}

async function workProgress(tx: Tx, ref: PersonalWorkRef): Promise<PersonalDesktopWork["progress"]> {
  const work = await tx.doc(PersonalWorkDoc, ref.requestId, null), notes = work.notes ?? [], read = new Set<EntryId>();
  const original = await tx.submissionByRequest(ref.agentId, `personal-work:${ref.taskId}`);
  let originalRead = false, cursor: Cursor | undefined;
  do {
    const scanned = await tx.scanEntries({ conversationId: ref.agentId, order: "descending", minEntryId: original?.entry }, 256, cursor);
    for (const entry of scanned.items) {
      if (entry.kind !== "ruukoto.model-request") continue;
      const data = entry.data as { payload?: unknown; references?: { instructions?: PersonalWorkInstructionSnapshot } } | undefined;
      const snapshot = data?.payload === undefined ? undefined : data.references?.instructions;
      if (!snapshot || snapshot.version !== 1 || !isDeepStrictEqual(snapshot.work, ref)) continue;
      originalRead = true;
      for (const note of snapshot.notes) if (notes.some(saved => saved.requestId === note.requestId && saved.admission === note.admission)) read.add(note.admission);
    }
    cursor = scanned.next;
  } while (cursor && (!originalRead || notes.some(note => note.admission !== undefined && !read.has(note.admission))));
  let completed = Number(original?.status === "done"), accounted = Number(original?.status === "done" || original?.status === "unanswered");
  for (const note of notes) {
    const native = await tx.submissionByRequest(ref.agentId, `personal-work:${ref.taskId}:note:${note.requestId}`);
    completed += Number(native?.status === "done"); accounted += Number(native?.status === "done" || native?.status === "unanswered");
  }
  return { accepted: notes.length + 1, modelRead: Number(originalRead) + notes.filter(note => note.admission !== undefined && read.has(note.admission)).length, completed, accounted };
}

// Note: See .agents/notes/implemented/feature/2026-11-04-personal-desktop-file-loop.md
export async function personalDesktopState(tx: Tx, revision: number, offsets: Offsets = {}, changedOperations: ReadonlySet<string | number> = new Set()): Promise<PersonalDesktopState> {
  const cards: PersonalDesktopApproval[] = [], updates: PersonalDesktopApproval[] = [];
  const acted = new Set<string>();
  for (const requestId of (await tx.doc(PersonalDesktopActionsDoc)).requests) {
    const request = (await tx.doc(PersonalDesktopActionDoc, requestId, null)).action?.receipt.request;
    if (!request) throw new PersonalError("desktop_action_stale", "原选择回执缺失，请保留档案并核实原卡片。");
    acted.add(`${request.family}:${request.operation}:${request.admission}`);
  }
  for (const value of await personalDesktopTargets(tx)) {
    const canonical = value.summary, family = canonical.family ?? "tools";
    const recovery = canonical.actions?.some(action => !["approve", "reject", "check"].includes(action));
    if (canonical.approval === "unneeded" && canonical.decisionEntry === undefined && !canonical.notice && !canonical.claim && !canonical.check && !recovery && !value.retained && !acted.has(`${family}:${canonical.operation}:${canonical.admission}`) && (canonical.effect !== "effect_unknown" || canonical.code === "started" || family === "background")) continue;
    if (changedOperations.has(`${family}:${canonical.operation}`) || family === "tools" && changedOperations.has(canonical.operation)) updates.push(canonical);
    for (const occurrence of value.occurrences) cards.push({ ...canonical, occurrence });
  }
  cards.sort((a, b) => b.occurrence - a.occurrence);
  const works: PersonalDesktopWork[] = [], refs: PersonalWorkRef[] = [], groups = new Set<EntryId>();
  let cursor: Cursor | undefined;
  do {
    const scanned = await tx.scanTasks({ kind: PersonalWorkTask.definition.name, order: "descending" }, 64, cursor);
    for (const task of scanned.items) {
      const ref = await personalWorkRef(tx, task.id), facts = await tx.doc(PersonalWorkDoc, ref.requestId, null);
      if (facts.delegation) groups.add(facts.delegation.entryId);
      refs.push(ref);
    }
    cursor = scanned.next;
  } while (cursor);
  for (const ref of refs.slice(offsets.works ?? 0, (offsets.works ?? 0) + PAGE_SIZE)) {
    const facts = await tx.doc(PersonalWorkDoc, ref.requestId, null), { services: _services, tools: _tools, notes: _notes, ...summary } = await personalWorkSummary(tx, ref, { local: true });
    works.push({ ...summary, progress: await workProgress(tx, ref), ...(facts.delegation ? { delegation: facts.delegation.entryId } : {}) });
  }
  const delegations = [];
  for (const id of [...groups].slice(offsets.delegations ?? 0, (offsets.delegations ?? 0) + PAGE_SIZE)) {
    const { members: _members, nextOffset: _next, ...summary } = await personalDelegationProgress(tx, { entryId: id }, 0, { local: true });
    const report = (await personalDelegation(tx, { entryId: id })).report;
    delegations.push({ ...summary, ...(summary.report ? { report: { ...summary.report, ...(report?.version === 2 && report.publication !== undefined ? { publication: report.publication } : {}) } } : {}) });
  }
  await refreshPersonalQuestions(tx);
  const questions: PersonalDesktopQuestion[] = [], questionUpdates: PersonalDesktopQuestion[] = [];
  for (const id of (await tx.doc(PersonalQuestionsDoc)).ids) {
    const value = question(await personalQuestion(tx, id));
    questions.push(value);
    if (changedOperations.has(`questions:${id}`)) questionUpdates.push(value);
  }
  questions.sort((a, b) => b.occurrence - a.occurrence);
  return { v: 1, revision, approvals: page(cards, offsets.approvals), works: { ...page(refs, offsets.works), items: works }, delegations: { ...page([...groups], offsets.delegations), items: delegations }, questions: page(questions, offsets.questions), ...(updates.length ? { approvalUpdates: updates } : {}), ...(questionUpdates.length ? { questionUpdates } : {}) };
}

export async function personalDesktopOperation(tx: Tx, revision: number, operation: TaskId, offset = 0, family: PersonalDesktopFamily = "tools"): Promise<PersonalDesktopOperation> {
  const value = await personalDesktopTarget(tx, family, operation);
  const text = JSON.stringify({ target: value.target, params: value.params }, null, 2);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new PersonalError("tool_input_invalid", "原操作读取位置无效，请从头核实原操作。");
  let end = Math.min(offset + 4096, text.length);
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]) && /[\udc00-\udfff]/.test(text[end])) end--;
  return { v: 1, revision, operation, admission: value.summary.admission, summary: value.summary, text: text.slice(offset, end), offset, ...(end < text.length ? { nextOffset: end } : {}) };
}
