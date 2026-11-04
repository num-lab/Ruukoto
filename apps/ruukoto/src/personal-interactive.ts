import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AgentDoc, defineDoc, defineDocFamily, defineEntry, ROOT_CONVERSATION_ID, type Cursor, type EntryId, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { PersonalError } from "./personal-error.ts";
import { PersonalAgentsDoc, PersonalWorkDoc, type PersonalWorkRef, type PersonalToolInstructions } from "./personal-work.ts";
import { personalSource } from "./personal-source.ts";
import { PersonalMcpConfigDoc } from "./personal-mcp.ts";
import { verifyPersonalToolInstructions, type PersonalToolOrigin } from "./personal-tool-source.ts";

export type PersonalControlledWork = { version: 1; identity: string; entry: EntryId; browser?: true; cua?: true; processes?: true };
type ControlAdmission = Omit<PersonalControlledWork, "entry"> & { work: PersonalWorkRef; source: PersonalToolOrigin["source"]; permission: PersonalToolOrigin["permission"]; telegram?: PersonalToolOrigin["telegram"] };
const WorkControl = defineEntry<ControlAdmission>("ruukoto.work-control");
type Claim = { claim: EntryId; origin: PersonalToolOrigin; instructions?: PersonalToolInstructions; acquired?: EntryId; released?: EntryId; stopped?: EntryId[] };
export const PersonalInteractiveDoc = defineDoc<{ resources: string[] }>({ kind: "ruukoto.interactive-resources", scope: "session", version: 1, initial: () => ({ resources: [] }) });
export const PersonalInteractiveResourceDoc = defineDocFamily<{ claims: Claim[]; owner?: EntryId }, null>({ kind: "ruukoto.interactive-resource", scope: "session", version: 1, family: true, initial: () => ({ claims: [] }) });
const InteractiveAdmission = defineEntry<{ version: 1; resource: string; origin: PersonalToolOrigin; instructions?: PersonalToolInstructions }>("ruukoto.interactive-admission");
const InteractiveOwnership = defineEntry<{ resource: string; claim: EntryId; action: "acquire" | "release"; stopped?: EntryId[] }>("ruukoto.interactive-ownership");
const invalid = () => new PersonalError("interactive_record_invalid", "原浏览器或电脑的归属证据无法核实，保留占用；请检查原工作记录。");
const resourceValid = (resource: string) => resource === "browser" || resource.startsWith("cua:") && resource.length > 4 && resource.length <= 256;

// Note: See .agents/notes/implemented/architecture/2026-11-04-personal-m2-execution.md
export async function qualifyPersonalControlledWork(tx: Tx, ref: PersonalWorkRef, origin: Awaited<ReturnType<typeof personalSource>>) {
  const work = await tx.doc(PersonalWorkDoc, ref.requestId, null);
  if (work.controlled || work.permission?.mode !== "full_access" || !work.source) return;
  const main = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID);
  const extensions = Array.isArray(main.extensions) ? main.extensions : [], tools = Array.isArray(main.tools) ? main.tools : [];
  const browser = extensions.includes("personal-browser") && tools.includes("browser") && (!origin.scheduled || origin.scope.tools.includes("browser") && origin.scope.extensions.includes("personal-browser"));
  const cua = !origin.scheduled && extensions.includes("personal-mcp") && (await tx.doc(PersonalMcpConfigDoc)).config?.services.some(service => service.enabled !== false && service.cua) === true;
  const processes = !origin.scheduled && extensions.includes("personal-background-processes") && tools.includes("process_start");
  if (!browser && !cua && !processes) return;
  const data: ControlAdmission = { version: 1, identity: `controlled_${randomUUID()}`, work: { ...ref }, source: { ...work.source }, permission: { ...work.permission }, ...(work.telegram ? { telegram: { ...work.telegram } } : {}), ...(browser ? { browser: true } : {}), ...(cua ? { cua: true } : {}), ...(processes ? { processes: true } : {}) };
  const entry = await tx.appendEntry(WorkControl, ROOT_CONVERSATION_ID, { data });
  const { work: _work, source: _source, permission: _permission, telegram: _telegram, ...controlled } = data;
  work.controlled = { ...controlled, entry: entry.id };
}

export async function requirePersonalControlledWork(tx: Tx, ref: PersonalWorkRef, family: "browser" | "cua" | "processes") {
  const work = await tx.doc(PersonalWorkDoc, ref.requestId, null), controlled = work.controlled;
  const entry = controlled && await tx.entry(WorkControl, controlled.entry), task = await tx.task(ref.taskId);
  if (!controlled || controlled.version !== 1 || controlled[family] !== true || !/^controlled_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(controlled.identity) || !entry || entry.conversationId !== ROOT_CONVERSATION_ID || !isDeepStrictEqual(work.ref, ref) || task?.kind !== "ruukoto.background-work" || task.conversationId !== ROOT_CONVERSATION_ID || !task.background || task.version !== 4 || task.id >= entry.id || !isDeepStrictEqual(task.input, { requestId: ref.requestId, agentId: ref.agentId, content: task.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input.content : undefined }) || !work.source || work.permission?.mode !== "full_access") throw new PersonalError("controlled_work_forbidden", "此工作没有原浏览器、电脑或后台执行资格；请结束本轮并报告拥有者。");
  const { entry: _entry, ...facts } = controlled;
  if (!isDeepStrictEqual(entry.data, { ...facts, work: ref, source: work.source, permission: work.permission, ...(work.telegram ? { telegram: work.telegram } : {}) })) throw invalid();
  const original = await personalSource(tx, work.source.requestId);
  if (!isDeepStrictEqual(original.source, work.source) || !isDeepStrictEqual(original.permission, work.permission) || !isDeepStrictEqual(original.telegram, work.telegram) || original.scheduled && (family !== "browser" || !original.scope.tools.includes("browser") || !original.scope.extensions.includes("personal-browser"))) throw invalid();
  return { identity: controlled.identity, entry: controlled.entry };
}

export async function registerPersonalInteractive(tx: Tx, resource: string, origin: PersonalToolOrigin, instructions?: PersonalToolInstructions): Promise<EntryId> {
  if (!resourceValid(resource) || origin.permission.mode !== "full_access" || !origin.work && origin.conversationId === ROOT_CONVERSATION_ID) throw invalid();
  if (origin.work) await requirePersonalControlledWork(tx, origin.work.ref, resource.startsWith("cua:") ? "cua" : "browser");
  else { const source = await personalSource(tx, origin.source.requestId); if (resource !== "browser" || !source.scheduled || source.submission.conversationId !== origin.conversationId || !source.scope.tools.includes("browser") || !source.scope.extensions.includes("personal-browser")) throw invalid(); }
  const state = await tx.doc(PersonalInteractiveResourceDoc, resource, null);
  const existing = state.claims.findLast(value => !value.released && (origin.work ? value.origin.work?.ref.taskId === origin.work.ref.taskId : value.origin.source.requestId === origin.source.requestId));
  if (existing) return existing.claim;
  const data = { version: 1 as const, resource, origin, ...(instructions ? { instructions } : {}) };
  const entry = await tx.appendEntry(InteractiveAdmission, ROOT_CONVERSATION_ID, { data });
  state.claims.push({ claim: entry.id, origin, ...(instructions ? { instructions } : {}) });
  const index = await tx.doc(PersonalInteractiveDoc);
  if (!index.resources.includes(resource)) index.resources.push(resource);
  return entry.id;
}

async function acquire(tx: Tx, resource: string, claim: EntryId): Promise<boolean> {
  const state = await tx.doc(PersonalInteractiveResourceDoc, resource, null), value = state.claims.find(value => value.claim === claim);
  if (!value || value.released) throw new PersonalError("interactive_released", "原资源归属已结束，未执行；请查询原工作。");
  if (state.owner !== undefined) return state.owner === claim;
  if (state.claims.find(value => !value.released)?.claim !== claim) return false;
  value.acquired = (await tx.appendEntry(InteractiveOwnership, ROOT_CONVERSATION_ID, { data: { resource, claim, action: "acquire" } })).id;
  state.owner = claim;
  return true;
}

export async function waitPersonalInteractive(reader: Pick<ToolExecutionApi, "watchDoc" | "commit">, resource: string, claim: EntryId, context: Context, validate?: (tx: Tx) => Promise<void>) {
  const watch = await reader.watchDoc(PersonalInteractiveResourceDoc, resource, context);
  if (!watch) throw invalid();
  try {
    await new Promise<void>((resolve, reject) => {
      let checking = false, dirty = false;
      const check = async () => {
        if (checking) { dirty = true; return; }
        checking = true;
        try {
          do { dirty = false; if (await reader.commit(async tx => { await validate?.(tx); return acquire(tx, resource, claim); }, context)) { resolve(); return; } } while (dirty);
        } catch (error) { reject(error); }
        finally { checking = false; }
      };
      watch.start(async () => check());
      void watch.closed.then(() => reject(new PersonalError("interactive_wait_stopped", "原资源排队已停止，未抢占其他工作；请查询原工作。")));
      void check();
    });
  } finally { await watch.stop(); }
}

export async function assertPersonalInteractiveOwner(tx: Tx, resource: string, claim: EntryId) {
  const state = await tx.doc(PersonalInteractiveResourceDoc, resource, null), value = state.claims.find(value => value.claim === claim);
  if (state.owner !== claim || !value?.acquired || value.released) throw new PersonalError("interactive_not_owner", "原工作尚未取得浏览器或电脑归属，未执行；请等待原工作队列。");
}

export async function preparePersonalInteractiveRelease(tx: Tx, resource: string, claim: EntryId, evidence: { stopped: EntryId[] }): Promise<() => Promise<void>> {
  const state = await tx.doc(PersonalInteractiveResourceDoc, resource, null), value = state.claims.find(value => value.claim === claim);
  if (!value) throw invalid();
  if (value.released) return async () => {};
  if (value.acquired && state.owner !== claim) throw invalid();
  if (new Set(evidence.stopped).size !== evidence.stopped.length) throw invalid();
  for (const id of evidence.stopped) if (!Number.isSafeInteger(id) || id <= value.claim || !await tx.entry(id)) throw invalid();
  const stopped = evidence.stopped.slice();
  // Prepare every family's evidence before any release entry starts the transaction's write phase.
  return async () => {
    value.stopped = stopped;
    value.released = (await tx.appendEntry(InteractiveOwnership, ROOT_CONVERSATION_ID, { data: { resource, claim, action: "release", stopped } })).id;
    if (state.owner === claim) delete state.owner;
  };
}

export async function personalInteractiveWorkClaims(tx: Tx, taskId: TaskId) {
  const claims: { resource: string; claim: EntryId; acquired?: EntryId; released?: EntryId }[] = [];
  for (const resource of (await tx.doc(PersonalInteractiveDoc)).resources) for (const value of (await tx.doc(PersonalInteractiveResourceDoc, resource, null)).claims) if (value.origin.work?.ref.taskId === taskId) claims.push({ resource, claim: value.claim, ...(value.acquired ? { acquired: value.acquired } : {}), ...(value.released ? { released: value.released } : {}) });
  return claims;
}

export async function verifyPersonalInteractive(tx: Tx, keys: string[]) {
  const index = await tx.doc(PersonalInteractiveDoc);
  if (!Array.isArray(index.resources) || new Set(index.resources).size !== index.resources.length || keys.length !== index.resources.length || keys.some(key => !index.resources.includes(key)) || index.resources.some(resource => !resourceValid(resource))) throw invalid();
  const admissions = new Set<EntryId>(), ownerships = new Set<EntryId>();
  for (const resource of index.resources) {
    const state = await tx.doc(PersonalInteractiveResourceDoc, resource, null);
    if (!Array.isArray(state.claims) || !state.claims.length || new Set(state.claims.map(value => value.claim)).size !== state.claims.length) throw invalid();
    let previous = 0;
    for (const value of state.claims) {
      const admission = await tx.entry(InteractiveAdmission, value.claim), acquired = value.acquired && await tx.entry(InteractiveOwnership, value.acquired), released = value.released && await tx.entry(InteractiveOwnership, value.released);
      if (!admission || value.claim <= previous || admission.conversationId !== ROOT_CONVERSATION_ID || value.origin.permission.mode !== "full_access" || admissions.has(value.claim) || !isDeepStrictEqual(admission.data, { version: 1, resource, origin: value.origin, ...(value.instructions ? { instructions: value.instructions } : {}) }) || value.acquired && (!acquired || acquired.conversationId !== ROOT_CONVERSATION_ID || acquired.id <= admission.id || ownerships.has(acquired.id) || !isDeepStrictEqual(acquired.data, { resource, claim: value.claim, action: "acquire" })) || value.released && (!released || released.conversationId !== ROOT_CONVERSATION_ID || released.id <= (value.acquired ?? value.claim) || ownerships.has(released.id) || !isDeepStrictEqual(released.data, { resource, claim: value.claim, action: "release", stopped: value.stopped })) || !value.released && value.stopped !== undefined) throw invalid();
      if (value.origin.work) {
        await requirePersonalControlledWork(tx, value.origin.work.ref, resource.startsWith("cua:") ? "cua" : "browser");
        if (!value.released) { const agent = (await tx.doc(PersonalAgentsDoc)).agents.find(agent => agent.id === value.origin.conversationId); if (!isDeepStrictEqual(agent?.work, value.origin.work.ref) || (await tx.task(value.origin.work.ref.taskId))?.state.status === "terminal") throw invalid(); }
      } else { const source = await personalSource(tx, value.origin.source.requestId); if (resource !== "browser" || !source.scheduled || source.submission.conversationId !== value.origin.conversationId || !isDeepStrictEqual(source.source, value.origin.source) || !isDeepStrictEqual(source.permission, value.origin.permission) || !isDeepStrictEqual(source.telegram, value.origin.telegram) || !source.scope.tools.includes("browser") || !source.scope.extensions.includes("personal-browser")) throw invalid(); }
      await verifyPersonalToolInstructions(tx, value.instructions, value.origin, value.claim);
      if (value.released && (!Array.isArray(value.stopped) || new Set(value.stopped).size !== value.stopped.length)) throw invalid();
      for (const id of value.stopped ?? []) if (!Number.isSafeInteger(id) || id <= value.claim || !value.released || id >= value.released || !await tx.entry(id)) throw invalid();
      admissions.add(value.claim); if (acquired) ownerships.add(acquired.id); if (released) ownerships.add(released.id);
      previous = value.claim;
    }
    const active = state.claims.filter(value => value.acquired && !value.released);
    if (active.length > 1 || active[0]?.claim !== state.owner || state.owner !== undefined && state.claims.find(value => !value.released)?.claim !== state.owner) throw invalid();
    for (const [i, value] of state.claims.entries()) if (value.acquired && state.claims.slice(0, i).some(earlier => !earlier.released || earlier.released >= value.acquired!)) throw invalid();
  }
  const controls = new Set<EntryId>(), identities = new Set<string>();
  let cursor: Cursor | undefined;
  do { const page = await tx.scanTasks({ kind: "ruukoto.background-work" }, 256, cursor); for (const task of page.items) {
    const input = task.input;
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.requestId !== "string") throw invalid();
    const work = await tx.doc(PersonalWorkDoc, input.requestId, null), controlled = work.controlled;
    if (!controlled) continue;
    const family = controlled.browser ? "browser" : controlled.cua ? "cua" : controlled.processes ? "processes" : undefined;
    if (!family || !work.ref || controls.has(controlled.entry) || identities.has(controlled.identity)) throw invalid();
    await requirePersonalControlledWork(tx, work.ref, family);
    controls.add(controlled.entry); identities.add(controlled.identity);
  } cursor = page.next; } while (cursor);
  cursor = undefined;
  do { const conversations = await tx.scanConversations({}, 256, cursor); for (const conversation of conversations.items) { let next: Cursor | undefined; do { const page = await tx.scanEntries({ conversationId: conversation.id }, 256, next); for (const entry of page.items) {
    if (InteractiveAdmission.is(entry) && !admissions.has(entry.id) || InteractiveOwnership.is(entry) && !ownerships.has(entry.id) || WorkControl.is(entry) && !controls.has(entry.id)) throw invalid();
  } next = page.next; } while (next); } cursor = conversations.next; } while (cursor);
}
