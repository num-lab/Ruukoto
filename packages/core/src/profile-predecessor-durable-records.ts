import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { apply, assertValidOp, type JsonValue, type Path } from "@earendil-works/chord/delta";
import { ProfileError } from "./profile-files.ts";
import { DOCUMENT_KINDS, DURABLE_SQL, ENTRY_KINDS, ENTRY_VERSIONS, TASK_KINDS } from "./profile-predecessor-durable-format.ts";

export type ObjectValue = { [key: string]: JsonValue };
export interface Document { id: number; kind: string; key: string; owner: number; retired: boolean; value: ObjectValue }
export interface Entry { id: number; kind: string; conversation: number; data: ObjectValue; record: ObjectValue }
export interface Task { id: number; kind: string; conversation: number; record: ObjectValue; terminal: boolean }
export interface Snapshot { documents: Document[]; entries: Map<number, Entry>; tasks: Map<number, Task>; conversations: Set<number> }

export function invalid(reason: string): never { throw new ProfileError("old_profile_unrecognized", `The old durable profile has invalid ${reason}; preserve it and inspect it with its original program.`); }
export function unsupported(reason: string): never { throw new ProfileError("old_profile_version_unsupported", `The old durable profile uses unsupported ${reason}; no replacement was activated.`); }
export function occupied(reason: string): never { throw new ProfileError("old_profile_execution_unverified", `The old durable profile has unverified ${reason}; resolve it with its original program before retrying.`); }
export function object(value: unknown): ObjectValue { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("record shape"); return value as ObjectValue; }
export function array(value: unknown): JsonValue[] { if (!Array.isArray(value)) invalid("record list"); return value as JsonValue[]; }
export function string(value: unknown): string { if (typeof value !== "string" || value.length === 0) invalid("record identity"); return value; }
export function number(value: unknown, minimum = 1): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid("record number"); return value; }
export function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid("record flag"); return value; }
export function same(a: unknown, b: unknown): void { if (!isDeepStrictEqual(a, b)) invalid("cross-record evidence"); }
export function parse(value: unknown): JsonValue { if (typeof value !== "string") invalid("JSON storage"); try { return JSON.parse(value) as JsonValue; } catch { return invalid("JSON storage"); } }
export function pick(value: ObjectValue, keys: readonly string[]): ObjectValue { const result: ObjectValue = {}; for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key]; return result; }
export function exact(value: ObjectValue, keys: readonly string[]): void { if (Object.keys(value).some(key => !keys.includes(key))) invalid("record fields"); }
export function entry(snapshot: Snapshot, id: unknown, kind: string, after = 0, conversation?: number): Entry {
  const result = snapshot.entries.get(number(id));
  if (!result || result.kind !== kind || result.id <= after || conversation !== undefined && result.conversation !== conversation) invalid("entry evidence");
  return result;
}
export function task(snapshot: Snapshot, id: unknown, kind?: string): Task { const result = snapshot.tasks.get(number(id)); if (!result || kind !== undefined && result.kind !== kind) invalid("task reference"); return result; }
export function singleton(snapshot: Snapshot, kind: string): ObjectValue | undefined { return snapshot.documents.find(doc => doc.kind === kind && !doc.retired)?.value; }

function resolve(value: JsonValue, path: Path): JsonValue {
  for (const segment of path) {
    if (Array.isArray(value)) { if (typeof segment !== "number" || !Number.isSafeInteger(segment) || segment < 0 || segment >= value.length) invalid("delta path"); value = value[segment]; }
    else { const parent = object(value); if (typeof segment !== "string" || !Object.hasOwn(parent, segment)) invalid("delta path"); value = parent[segment]; }
  }
  return value;
}
function delta(value: JsonValue, raw: JsonValue): JsonValue {
  for (const op of array(raw)) {
    try { assertValidOp(op); } catch { invalid("Chord delta"); }
    if (op[0] !== "r") {
      for (const segment of op[1]) if (typeof segment === "number" && !Number.isSafeInteger(segment)) invalid("delta index");
      if (op[0] === "p") { const target = resolve(value, op[1]); if (!Array.isArray(target) || !Number.isSafeInteger(op[2]) || !Number.isSafeInteger(op[3]) || op[2] > target.length || op[3] > target.length - op[2]) invalid("delta splice"); }
      else if (op[0] !== "m") {
        const parent = resolve(value, op[1].slice(0, -1)), key = op[1][op[1].length - 1];
        if (Array.isArray(parent)) { if (typeof key !== "number" || key > parent.length || op[0] !== "s" && key === parent.length) invalid("delta path"); }
        else { const record = object(parent); if (typeof key !== "string" || op[0] !== "s" && !Object.hasOwn(record, key)) invalid("delta path"); }
        if (op[0] === "t") { const target = resolve(value, op[1]); if (typeof target !== "string" || !Number.isSafeInteger(op[2]) || op[2] > target.length) invalid("delta string range"); }
      }
    }
    try { value = apply(value, [op]); } catch { invalid("Chord delta application"); }
  }
  return value;
}

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const expectedSql = DURABLE_SQL.map(normalize).sort();
const tables = ["conversations", "entries", "tasks", "submissions", "documents"] as const;
type Row = Record<string, string | number | null>;
function rows(db: DatabaseSync, sql: string): Row[] { return db.prepare(sql).all() as Row[]; }

// This connection is only for a private coherent copy; exclusion and source identity belong to the caller.
export function readSnapshot(copyDatabasePath: string): Snapshot {
  let db: DatabaseSync;
  try { db = new DatabaseSync(copyDatabasePath, { readOnly: true }); } catch { return invalid("database copy"); }
  try { return load(db); }
  catch (error) { if (error instanceof ProfileError) throw error; return invalid("database copy"); }
  finally { db.close(); }
}
function load(db: DatabaseSync): Snapshot {
  const physical = rows(db, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'");
  if (!physical.some(row => row.name === "durable_schema" && row.type === "table")) invalid("schema fingerprint");
  const versions = rows(db, "SELECT singleton, version FROM durable_schema");
  if (versions.length !== 1 || versions[0].singleton !== 1) invalid("schema marker");
  if (versions[0].version !== 1) unsupported("durable schema version");
  same(physical.map(row => normalize(string(row.sql))).sort(), expectedSql);
  const check = db.prepare("PRAGMA quick_check").get();
  if (!check || Object.values(check).some(value => value !== "ok")) invalid("database integrity");
  const metadata = rows(db, "SELECT * FROM durable_metadata");
  if (metadata.length !== 1 || metadata[0].singleton !== 1 || !/^[1-9][0-9]*$/.test(string(metadata[0].next_id))) invalid("allocation metadata");
  const nextId = BigInt(string(metadata[0].next_id)), nextSeq = number(metadata[0].next_seq);
  const ids = new Map<number, string>();
  for (const row of rows(db, "SELECT * FROM record_ids")) { const id = number(row.id); if (BigInt(id) >= nextId) invalid("allocation metadata"); ids.set(id, string(row.record_type)); }
  const snapshot: Snapshot = { documents: [], entries: new Map(), tasks: new Map(), conversations: new Set() };
  const seen = new Set<number>(), records = new Map<string, Row[]>();
  for (const table of tables) {
    const values = rows(db, `SELECT * FROM ${table} ORDER BY id`); records.set(table, values);
    for (const row of values) { const id = number(row.id); if (ids.get(id) !== (table === "entries" ? "entry" : table.slice(0, -1)) || seen.has(id)) invalid("record allocation"); seen.add(id); }
  }
  if (seen.size !== ids.size) invalid("orphan record allocation");
  for (const row of records.get("conversations")!) { const value = object(parse(row.record)); same(value.id, row.id); snapshot.conversations.add(number(row.id)); }
  if (!snapshot.conversations.has(1)) invalid("root conversation");
  for (const row of records.get("tasks")!) {
    const value = object(parse(row.record)), kind = string(value.kind), state = object(value.state);
    same([value.id, value.conversationId, value.kind, state.status, value.abortRequested, value.background], [row.id, row.conversation_id, parse(row.kind), row.status, row.abort_requested === 1, row.background === 1]);
    if (!snapshot.conversations.has(number(value.conversationId))) invalid("task conversation");
    const allowed = Object.hasOwn(TASK_KINDS, kind) ? TASK_KINDS[kind] : undefined; if (!allowed || !allowed.includes(number(value.version))) unsupported("task kind or version");
    const terminal = state.status === "terminal";
    if (terminal) { if (!["completed", "failed", "aborted"].includes(string(object(state.outcome).status))) occupied("terminal task outcome"); number(value.endedAt, 0); }
    else if (state.status !== "pending" || value.startedAt !== undefined || value.endedAt !== undefined) occupied("task execution");
    snapshot.tasks.set(number(value.id), { id: number(value.id), kind, conversation: number(value.conversationId), record: value, terminal });
  }
  for (const saved of snapshot.tasks.values()) if (saved.record.owner !== undefined) task(snapshot, saved.record.owner);
  for (const row of records.get("conversations")!) {
    const value = object(parse(row.record)), owner = value.owner === undefined ? undefined : object(value.owner);
    same([owner?.conversationId ?? null, owner?.taskId ?? null], [row.owner_conversation_id, row.owner_task_id]);
    if (owner?.conversationId !== undefined && !snapshot.conversations.has(number(owner.conversationId))) invalid("conversation owner");
    if (owner?.taskId !== undefined) task(snapshot, owner.taskId);
  }
  for (const row of records.get("entries")!) {
    const value = object(parse(row.record)), kind = string(value.kind), id = number(value.id), conversation = number(value.conversationId);
    same([id, conversation, value.head === "self" ? id : value.head ?? null], [row.id, row.conversation_id, row.head]);
    if (!snapshot.conversations.has(conversation) || number(row.commit_seq) >= nextSeq) invalid("entry conversation or sequence");
    if (!Object.hasOwn(ENTRY_KINDS, kind)) unsupported("entry kind");
    if (value.byTaskId !== undefined) task(snapshot, value.byTaskId);
    const data = value.data === undefined ? {} : object(value.data), version = ENTRY_VERSIONS[kind];
    if (version && data[version[0]] !== version[1]) unsupported("entry version");
    snapshot.entries.set(id, { id, kind, conversation, data, record: value });
  }
  for (const row of records.get("submissions")!) {
    const value = object(parse(row.record));
    same([value.id, value.conversationId, value.status, value.requestId ?? null], [row.id, row.conversation_id, row.status, row.request_id === null ? null : parse(row.request_id)]);
    if (!snapshot.conversations.has(number(value.conversationId)) || !["input", "write"].includes(string(value.type))) invalid("submission identity");
  }
  const revisions = new Map<number, Row[]>();
  for (const row of rows(db, "SELECT * FROM document_revisions ORDER BY document_id, seq")) { const id = number(row.document_id); if (ids.get(id) !== "document") invalid("orphan revision"); const list = revisions.get(id) ?? []; list.push(row); revisions.set(id, list); }
  const addresses = new Set<string>();
  for (const row of records.get("documents")!) {
    const record = object(parse(row.record)), scope = object(record.scope), kind = string(parse(row.kind)), signature = DOCUMENT_KINDS[kind];
    if (!signature) unsupported("document kind");
    const key = parse(row.key_value); if (typeof key !== "string" || row.family !== signature[1] || row.scope_kind !== signature[2]) invalid("document address");
    same([record.id, record.kind, scope.kind, record.key ?? "", record.createdAt, record.retiredAt ?? null], [row.id, kind, row.scope_kind, key, row.created_at, row.retired_at]);
    const owner = scope.kind === "session" ? 0 : scope.kind === "conversation" ? number(scope.conversationId) : number(scope.taskId);
    same(owner, row.owner_id);
    if (scope.kind === "conversation" && !snapshot.conversations.has(owner) || scope.kind === "task" && !snapshot.tasks.has(owner) || row.family === 0 && (key !== "" || record.key !== undefined)) invalid("document owner");
    const created = number(row.created_at); if (created >= nextSeq || row.retired_at !== null && (number(row.retired_at) < created || number(row.retired_at) >= nextSeq)) invalid("document lifetime");
    const address = JSON.stringify([kind, key, owner]); if (row.retired_at === null) { if (addresses.has(address)) invalid("duplicate document address"); addresses.add(address); }
    const chain = revisions.get(number(row.id)); if (!chain?.length) invalid("missing document base");
    let value: JsonValue | undefined, previous = 0;
    for (const revision of chain) {
      const seq = number(revision.seq); if (seq < created || seq <= previous || seq >= nextSeq || row.retired_at !== null && seq > number(row.retired_at)) invalid("revision sequence");
      if (revision.version !== signature[0]) unsupported("document version");
      const content = parse(revision.content);
      if (revision.kind === "base") value = content;
      else if (revision.kind === "delta" && value !== undefined) value = delta(value, content);
      else invalid("revision kind or missing base");
      previous = seq;
    }
    snapshot.documents.push({ id: number(row.id), kind, key, owner, retired: row.retired_at !== null, value: object(value) });
  }
  return snapshot;
}
