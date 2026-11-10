import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { inspectDurablePredecessor, validateDurableManifest } from "@ruukoto/core/profile-predecessor-durable.ts";
import { ProfileError } from "@ruukoto/core/profile-files.ts";
import { bootstrapProfile, profileStorage, readProfile, selectProfile } from "@ruukoto/core/profile.ts";
import type { JsonValue } from "@earendil-works/chord/delta";

type Value = Record<string, JsonValue>;
type Row = Record<string, string | number | null>;
interface Fixture { schema: string[]; manifest: Value; documents: Row[]; revisions: Row[]; entries: Row[]; tasks: Row[]; conversations: Row[] }
interface PrivateFixture {
  db: DatabaseSync; filename: string;
  insert(table: string, row: Row): void; record(table: string, row: Row): void;
  task(kind?: string, version?: number): number; entry(kind: string, data: Value): number;
  document(kind: string, value: Value, key?: string, owner?: number, version?: number): number;
  delta(documentId: number, operations: JsonValue[], version?: number): void;
  inspect(): void; cleanup(): void;
}
const frozen = JSON.parse(fs.readFileSync(new URL("./fixtures/profile-predecessor/durable-completed-read.json", import.meta.url), "utf8")) as Fixture;
const manifest = frozen.manifest;
function copyFixture(historical = false, root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-durable-admission-"))): PrivateFixture {
  const filename = path.join(root, "personal.sqlite"), db = new DatabaseSync(filename);
  for (const sql of frozen.schema.filter(sql => sql.startsWith("CREATE TABLE"))) db.exec(sql);
  for (const sql of frozen.schema.filter(sql => sql.startsWith("CREATE INDEX"))) db.exec(sql);
  db.exec("INSERT INTO durable_schema VALUES (1,1); INSERT INTO durable_metadata VALUES (1,'1000000',1000000)");
  function insert(table: string, row: Row) { const columns = Object.keys(row); db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row)); }
  function record(table: string, row: Row) { insert(table, row); insert("record_ids", { id: row.id, record_type: table === "entries" ? "entry" : table.slice(0, -1) }); }
  if (historical) {
    for (const row of frozen.conversations) record("conversations", row);
    for (const row of frozen.documents) record("documents", row);
    for (const row of frozen.revisions) insert("document_revisions", row);
    for (const row of frozen.tasks) record("tasks", row);
    for (const row of frozen.entries) record("entries", row);
  } else record("conversations", { id: 1, owner_conversation_id: null, owner_task_id: null, record: '{"id":1}' });
  let id = 100, seq = 100;
  function task(kind = "pi.tool", version = 2) { const value: Value = { id: id++, conversationId: 1, kind, version, input: {}, background: false, abortRequested: false, state: { status: "terminal", outcome: { status: "completed", result: {} } }, startedAt: 1, endedAt: 2 }; record("tasks", { id: Number(value.id), conversation_id: 1, kind: JSON.stringify(kind), status: "terminal", abort_requested: 0, background: 0, record: JSON.stringify(value) }); return Number(value.id); }
  function entry(kind: string, data: Value) { const current = id++; record("entries", { id: current, conversation_id: 1, head: null, commit_seq: seq++, record: JSON.stringify({ id: current, conversationId: 1, kind, data }) }); return current; }
  function document(kind: string, value: Value, key?: string, owner = 0, version = 1) { const current = id++, created = seq++, scope = owner ? { kind: "conversation", conversationId: owner } : { kind: "session" }; record("documents", { id: current, kind: JSON.stringify(kind), family: key === undefined ? 0 : 1, key_value: JSON.stringify(key ?? ""), scope_kind: owner ? "conversation" : "session", owner_id: owner, created_at: created, retired_at: null, record: JSON.stringify({ id: current, kind, scope, ...(key === undefined ? {} : { key }), createdAt: created }) }); insert("document_revisions", { document_id: current, seq: created, kind: "base", version, content: JSON.stringify(value) }); return current; }
  function delta(documentId: number, operations: JsonValue[], version = 1) { insert("document_revisions", { document_id: documentId, seq: seq++, kind: "delta", version, content: JSON.stringify(operations) }); }
  if (!historical) document("ruukoto.format", manifest);
  function inspect() { inspectDurablePredecessor(filename, manifest); }
  return { db, filename, insert, record, task, entry, document, delta, inspect, cleanup() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function rejects(f: PrivateFixture, code?: string) { assert.throws(f.inspect, (error: unknown) => error instanceof ProfileError && (code === undefined || error.code === code)); }
const origin: Value = { conversationId: 1, generation: 1, inputs: [], sources: [], source: {}, permission: { mode: "full_access", version: 1 } };

test("recognizes both frozen manifests and rejects conversion, unknown fields and newer versions", () => {
  validateDurableManifest(manifest);
  const legacy = { ...manifest }; delete legacy.configuration; validateDurableManifest(legacy);
  for (const value of [{ ...manifest, pi: "1.4.0" }, { ...manifest, configuration: 2 }, { ...manifest, configurationMigration: {} }, { ...manifest, extra: true }, { ...manifest, extensions: { personal: 3 } }]) assert.throws(() => validateDurableManifest(value), ProfileError);
});
test("admits actual stopped legacy file and SubAgent delta slices without original business data", () => { const f = copyFixture(true); try { f.inspect(); } finally { f.cleanup(); } });
test("delta-only running file state cannot be hidden by terminal tasks or a stopped base", () => { const f = copyFixture(true); try { f.db.exec("DELETE FROM document_revisions WHERE document_id=63 AND seq=43; DELETE FROM entries WHERE id=65; DELETE FROM record_ids WHERE id=65"); rejects(f, "old_profile_execution_unverified"); } finally { f.cleanup(); } });
test("delta-only SubAgent work claim rejects", () => { const f = copyFixture(true); try { f.db.exec("DELETE FROM document_revisions WHERE document_id=28 AND seq=53"); rejects(f, "old_profile_execution_unverified"); } finally { f.cleanup(); } });
test("all seven actual Chord operations materialize in sequence", () => { const f = copyFixture(); try { const doc = f.document("ruukoto.permissions", { text: "abcd", values: [1,2], removed: true }); f.delta(doc, [["r", { text: "abcd", values: [1,2], removed: true }], ["a", ["text"], "ef"], ["t", ["text"], 2], ["p", ["values"], 1, 1, [3,4]], ["m", ["values"], [2,0,1]], ["s", ["mode"], "full_access"], ["d", ["removed"]]]); f.inspect(); } finally { f.cleanup(); } });
for (const operations of [[["s", ["missing", "child"], true]], [["s", ["__proto__", "polluted"], true]], [["p", ["values"], 99, 0, []]], [["m", ["values"], [0,0]]], [["new-op", []]], [["t", ["text"], 99]]]) test(`rejects malformed Chord tuple ${JSON.stringify(operations)}`, () => { const f = copyFixture(); try { const doc = f.document("ruukoto.permissions", { text: "a", values: [1,2] }); f.delta(doc, operations); rejects(f, "old_profile_unrecognized"); } finally { f.cleanup(); } });
test("rejects unknown document/task versions and full-schema lookalikes", () => {
  for (const change of [(f: PrivateFixture) => { f.document("ruukoto.future-resource", {}); }, (f: PrivateFixture) => { f.document("ruukoto.permissions", {}, undefined, 0, 2); }, (f: PrivateFixture) => { f.task("pi.tool", 3); }, (f: PrivateFixture) => { f.db.exec("DROP INDEX tasks_by_kind"); }, (f: PrivateFixture) => { f.db.exec("CREATE TABLE foreign_resource(id INTEGER)"); }]) { const f = copyFixture(); try { change(f); rejects(f); } finally { f.cleanup(); } }
});
test("rejects unsupported old revision even when followed by a supported base", () => { const f = copyFixture(); try { const id = f.document("ruukoto.permissions", {}); f.delta(id, [["s", ["mode"], "full_access"]], 2); rejects(f, "old_profile_version_unsupported"); } finally { f.cleanup(); } });
test("missing observation and orphan index cannot hide historical tools", () => { for (const sql of ["DELETE FROM entries WHERE id=65; DELETE FROM record_ids WHERE id=65", "DELETE FROM documents WHERE id=21; DELETE FROM document_revisions WHERE document_id=21; DELETE FROM record_ids WHERE id=21"]) { const f = copyFixture(true); try { f.db.exec(sql); rejects(f); } finally { f.cleanup(); } } });
test("unknown effects remain admissible when stopping has independent evidence", () => { const f = copyFixture(); try { const operation = f.task(), admitted = f.entry("ruukoto.tool-admission", { operation, origin, kind: "http_request" }), start = f.entry("ruukoto.tool-start", { operation, admission: admitted }), observed = f.entry("ruukoto.tool-observation", { operation, admission: admitted, effect: "effect_unknown", code: "interrupted", stopped: true }); f.document("ruukoto.tools", { operations: [operation] }); f.document("ruukoto.tool-operation", { operation: { operation, origin, kind: "http_request", admission: admitted, started: true, startEntry: start, stopped: true, effect: "effect_unknown", code: "interrupted", observation: observed } }, String(operation)); f.inspect(); } finally { f.cleanup(); } });
test("admits stopped command and rejects missing independent stop observation", () => { const f = copyFixture(); try { const taskId = f.task("ruukoto.command", 1), ref = { requestId: "command", taskId }, execution = { executionId: "execution" }, admitted = f.entry("ruukoto.command-admission", { ref, execution }), prepared = { fingerprint: "fingerprint" }, start = f.entry("ruukoto.command-start", { ref, prepared }), result = { effect: "effect_unknown", code: "interrupted" }, observed = f.entry("ruukoto.command-observation", { ref, execution, fingerprint: "fingerprint", result, stopped: true }); f.document("ruukoto.command", { command: { ref, execution, admission: admitted, prepared, started: true, startEntry: start, stopped: true, result, observation: observed } }, "command"); f.inspect(); f.db.prepare("DELETE FROM entries WHERE id=?").run(observed); f.db.prepare("DELETE FROM record_ids WHERE id=?").run(observed); rejects(f); } finally { f.cleanup(); } });
test("file job result/exit/host-ended/release are stop proofs; settlement alone is not", () => {
  for (const terminal of ["result", "exit", "host-ended", "release", "settle"]) { const f = copyFixture(); try {
    const id = "00000000-0000-4000-8000-000000000001", host = { pid: 123, startIdentity: null, incarnation: "00000000-0000-4000-8000-000000000002" }, request = { path: "/synthetic", access: "read" }, meta = { v: 1, id, host, phase: "prepare", access: "read", requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), request, deadlineAt: 1 }, admitted = f.entry("ruukoto.file-io-admission", meta), job: Value = { ...meta, admission: admitted, seq: 0, events: [] };
    function event(kind: string, extra: Value = {}) { job.seq = Number(job.seq) + 1; const saved = f.entry("ruukoto.file-io-lifecycle", { kind, jobId: id, host, seq: job.seq, ...extra }); (job.events as JsonValue[]).push(saved); return saved; }
    if (["result", "exit", "settle"].includes(terminal)) job.starting = event("starting");
    if (terminal === "result") { job.dispatch = event("dispatch"); const payload = { request }; job.result = { ok: true, payload, entry: event("result", { ok: true, payload }) }; }
    if (terminal === "exit") job.exit = { code: 0, entry: event("exit", { code: 0 }) };
    if (terminal === "host-ended") job.hostEnded = event("host-ended");
    if (terminal === "release") { job.noDispatch = event("no-dispatch"); job.released = event("release"); }
    if (terminal === "settle") job.settle = { outcome: "timeout", code: "file_io_timeout", entry: event("settle", { outcome: "timeout", code: "file_io_timeout" }) };
    f.document("ruukoto.file-io", { jobs: [id] }); f.document("ruukoto.file-io-job", { job }, id); if (terminal === "settle") rejects(f, "old_profile_execution_unverified"); else f.inspect();
  } finally { f.cleanup(); } }
});
test("settled app-data admits without opening business DB; unknown result rejects", () => { for (const effect of ["committed", "not_committed", "effect_unknown"]) { const f = copyFixture(); try { const operation = f.task(), admitted = f.entry("ruukoto.app-data-admission", { operation, origin, opId: "op" }), start = f.entry("ruukoto.app-data-start", { operation, admission: admitted }), result = { effect, code: effect, op_id: "op" }, observed = f.entry("ruukoto.app-data-observation", { operation, result }); f.document("ruukoto.app-data", { operations: [operation] }); f.document("ruukoto.app-data-operation", { operation: { operation, origin, opId: "op", admission: admitted, started: start, result, observation: observed } }, String(operation)); if (effect === "effect_unknown") rejects(f, "old_profile_execution_unverified"); else f.inspect(); } finally { f.cleanup(); } } });
test("background process needs stopped observation and released directory claim", () => { const f = copyFixture(); try { const operation = f.task(), taskId = f.task("ruukoto.background-start", 1), execution = { executionId: "background" }, admitted = f.entry("ruukoto.background-admission", { id: "background", operation, taskId, execution }), owner = { kind: "background", operation }, directory = { path: "/synthetic", dev: 1, ino: 2 }, acquired = f.entry("ruukoto.directory-claim", { owner, directory, action: "acquire" }), observation = f.entry("ruukoto.background-observation", { id: "background", state: "stopped", stopped: true, partial: false }), released = f.entry("ruukoto.directory-claim", { owner, directory, action: "release", acquired }); f.document("ruukoto.background-processes", { ids: ["background"] }); f.document("ruukoto.background-process", { process: { id: "background", operation, taskId, execution, admission: admitted, claim: acquired, state: "stopped", stopped: true, partial: false, observation } }, "background"); const claims = f.document("ruukoto.directory-claims", { claims: [{ owner, directory, acquired, released }] }); f.inspect(); f.delta(claims, [["d", ["claims",0,"released"]]]); rejects(f, "old_profile_execution_unverified"); } finally { f.cleanup(); } });
test("closed browser binding plus released interactive ownership admits", () => { const f = copyFixture(); try { const claim = f.entry("ruukoto.interactive-admission", { version: 1, resource: "browser", origin }), acquired = f.entry("ruukoto.interactive-ownership", { resource: "browser", claim, action: "acquire" }), binding = { sessionId: "1", generation: "generation", kind: "owned", state: "closed", chromePending: false, daemonPending: false, dashboardPending: false, socketDir: "/synthetic", cliSession: "session" }, stateJson = JSON.stringify({ version: 1, bindings: [binding] }), bindingEntry = f.entry("ruukoto.browser-binding-changed", { stateJson, sessionId: "1", generation: "generation", state: "closed" }), released = f.entry("ruukoto.interactive-ownership", { resource: "browser", claim, action: "release", stopped: [bindingEntry] }); f.document("ruukoto.browser", { operations: [], stateJson, bindingEntry }); f.document("ruukoto.interactive-resources", { resources: ["browser"] }); const doc = f.document("ruukoto.interactive-resource", { claims: [{ claim, origin, acquired, released, stopped: [bindingEntry] }] }, "browser"); f.inspect(); f.delta(doc, [["s", ["owner"], claim]]); rejects(f, "old_profile_execution_unverified"); } finally { f.cleanup(); } });
test("service stop proof binds inspection and both launcher exits", () => { const f = copyFixture(); try { const taskId = f.task("ruukoto.service-operation", 1), identity = { taskId, conversationId: 1, taskKind: "ruukoto.service-operation", unit: "app.service", machineId: "machine", inspectionId: "inspect_test", sources: [] }, admitted = f.entry("ruukoto.service-inspection-admission", identity), reply = { v: 1, ok: true, verb: "stop-inspect", machineId: "machine", inspectionId: "inspect_test", exited: true }, capture = (reply: Value) => ({ stdout: "", stderr: Buffer.from(`RUUKOTO_SERVICE_REPLY ${JSON.stringify(reply)}\n`).toString("base64"), truncated: false, code: "ok" }), stop = f.entry("ruukoto.service-inspection-stop", { inspectionId: "inspect_test", machineId: "machine", ...capture(reply), reply }); f.document("ruukoto.service-executions", { tasks: [] }); f.document("ruukoto.service-execution", { inspection: { ...identity, admission: admitted, stopped: true, stopEvidence: stop } }, String(taskId)); const operation = { ref: { requestId: "service", taskId }, consumed: true, hostOpId: "host", snapshot: { machineId: "machine" }, launcherStopped: true, result: { effect: "effect_unknown", code: "interrupted" } }; f.document("ruukoto.service-operation", { operation }, "service"); const stopReply = { v: 1, ok: true, verb: "stop-op", machineId: "machine", hostOpId: "host", opUnit: "ruukoto-service-op-host.service", exited: true, launcherExited: true }; f.entry("ruukoto.service-operation-evidence", { requestId: "service", verb: "stop-op", ...capture(stopReply) }); f.inspect(); } finally { f.cleanup(); } });
test("HTTP MCP completion and Cua sandbox stop are distinct from effect and RPC return", () => {
  for (const cua of [false, true]) { const f = copyFixture(); try { const operation = f.task(), config = { version: cua ? 3 : 4, services: [{ id: "service", ...(cua ? { cua: { sandboxId: "local:test" } } : {}) }] }, admitted = f.entry("ruukoto.mcp-admission", { operation, origin, config, service: "service", tool: "tool", args: {}, ...(cua ? {} : { recordVersion: 2, localEffect: "write" }) }), value: Value = { operation, origin, config, service: "service", tool: "tool", args: {}, admission: admitted, started: true, remoteEnded: true, effect: "effect_unknown", code: "finished", evidence: {} };
    if (!cua) { value.recordVersion = 2; value.localEffect = "write"; value.startedEntry = f.entry("ruukoto.mcp-start", { operation, admission: admitted, service: "service", tool: "tool", args: {}, localEffect: "write" }); value.result = {}; value.observation = f.entry("ruukoto.mcp-result", { operation, admission: admitted, result: {}, effect: "effect_unknown", code: "finished", remoteEnded: true }); }
    else { const execution = { cli: { scope: "scope", description: "description", invocationId: "invocation", group: "/group", dev: 1, ino: 2 }, sandbox: { containerId: "container", startedAt: "time", bootId: "boot", pid: 1, processIdentity: "identity" } }; value.cua = { execution }; value.observation = f.entry("ruukoto.mcp-observation", { operation, admission: admitted, evidence: {}, effect: "effect_unknown", code: "finished", remoteEnded: true }); f.entry("ruukoto.mcp-cua-recovery", { operation, execution, action: "stopped" }); }
    f.document("ruukoto.mcp-config", { operations: [operation] }); const doc = f.document("ruukoto.mcp", { operation: value }, String(operation)); f.inspect(); if (!cua) { f.delta(doc, [["s", ["operation","remoteEnded"], false]]); rejects(f); } else { f.db.exec("DELETE FROM record_ids WHERE id IN (SELECT id FROM entries WHERE json_extract(record,'$.kind')='ruukoto.mcp-cua-recovery'); DELETE FROM entries WHERE json_extract(record,'$.kind')='ruukoto.mcp-cua-recovery'"); rejects(f, "old_profile_execution_unverified"); }
  } finally { f.cleanup(); } }
});
test("scans beyond a page and rejects orphan revision/resource entries", () => { const f = copyFixture(); try { for (let n = 0; n < 300; n++) f.document("ruukoto.local-input", { digest: "digest" }, String(n)); f.entry("ruukoto.tool-start", { operation: 999, admission: 998 }); rejects(f, "old_profile_unrecognized"); } finally { f.cleanup(); } });

test("live state is materialized even when only a WAL delta holds it", () => {
  const f = copyFixture();
  try {
    f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    const doc = f.document("pi.live", {}, undefined, 1);
    f.inspect();
    f.delta(doc, [["s", ["generation"], { attempt: 1 }]]);
    rejects(f, "old_profile_execution_unverified");
  } finally { f.cleanup(); }
});
test("browser operation requires observation-backed stopping independently of an empty browser", () => {
  const f = copyFixture();
  try {
    const operation = f.task(), admission = f.entry("ruukoto.browser-admission", { operation, origin });
    const startEntry = f.entry("ruukoto.browser-start", { operation, admission });
    const observation = f.entry("ruukoto.browser-observation", { operation, admission, effect: "effect_unknown", code: "interrupted", stopped: true });
    f.document("ruukoto.browser", { operations: [operation] });
    const doc = f.document("ruukoto.browser-operation", { operation: { operation, origin, admission, started: true, startEntry, observation, stopped: true, effect: "effect_unknown", code: "interrupted" } }, String(operation));
    f.inspect();
    f.delta(doc, [["s", ["operation", "stopped"], false]]);
    rejects(f, "old_profile_execution_unverified");
  } finally { f.cleanup(); }
});
test("successful service restart is settled even when launcherStopped remains false", () => {
  const f = copyFixture();
  try {
    const taskId = f.task("ruukoto.service-operation", 1), reply = { v: 1, ok: true, verb: "restart", launched: true, machineId: "machine", hostOpId: "host", opUnit: "ruukoto-service-op-host.service", exitCode: 0, observedAt: "2026-11-01T00:00:00Z" };
    f.entry("ruukoto.service-operation-evidence", { requestId: "service", verb: "restart", stdout: "", stderr: Buffer.from(`RUUKOTO_SERVICE_REPLY ${JSON.stringify(reply)}\n`).toString("base64"), truncated: false, code: "ok" });
    f.document("ruukoto.service-operation", { operation: { ref: { requestId: "service", taskId }, consumed: true, hostOpId: "host", snapshot: { machineId: "machine" }, launcherStopped: false, result: { effect: "executed", code: "command_completed", exitCode: 0 } } }, "service");
    f.inspect();
  } finally { f.cleanup(); }
});
test("orphan revisions and forged SQL/JSON identities reject", () => {
  for (const change of [(f: PrivateFixture) => f.insert("document_revisions", { document_id: 999, seq: 999, kind: "base", version: 1, content: "{}" }), (f: PrivateFixture) => f.db.exec("UPDATE documents SET owner_id=42"), (f: PrivateFixture) => f.db.exec("UPDATE durable_schema SET version=2")]) {
    const f = copyFixture(); try { change(f); rejects(f); } finally { f.cleanup(); }
  }
});

test("inspection leaves the supplied database bytes unchanged", () => {
  const f = copyFixture(true);
  try { const before = fs.readFileSync(f.filename); f.inspect(); assert.deepEqual(fs.readFileSync(f.filename), before); }
  finally { f.cleanup(); }
});
test("service stop with only one exited process is not a stop proof", () => {
  const f = copyFixture();
  try {
    const taskId = f.task("ruukoto.service-operation", 1), reply = { v: 1, ok: true, verb: "stop-op", machineId: "machine", hostOpId: "host", opUnit: "ruukoto-service-op-host.service", exited: true, launcherExited: false };
    f.entry("ruukoto.service-operation-evidence", { requestId: "service", verb: "stop-op", stdout: "", stderr: Buffer.from(`RUUKOTO_SERVICE_REPLY ${JSON.stringify(reply)}\n`).toString("base64"), truncated: false, code: "ok" });
    f.document("ruukoto.service-operation", { operation: { ref: { requestId: "service", taskId }, consumed: true, hostOpId: "host", snapshot: { machineId: "machine" }, launcherStopped: true, result: { effect: "effect_unknown", code: "interrupted" } } }, "service");
    rejects(f, "old_profile_execution_unverified");
  } finally { f.cleanup(); }
});

type OwnerJournalMode = "delete" | "truncate" | "persist";

function bootstrapFixture(mode: OwnerJournalMode) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-durable-bootstrap-")));
  const oldRoots = ["data", "agent", "control", "pending", "workspace", "agent-work"];
  for (const name of oldRoots) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const dataDir = path.join(root, "data"), f = copyFixture(true, dataDir);
  const ownerFile = path.join(dataDir, "owner.sqlite"), owner = new DatabaseSync(ownerFile);
  try {
    assert.equal(owner.prepare(`PRAGMA journal_mode=${mode}`).get()!.journal_mode, mode);
    // Commit and remove a synthetic table to leave an empty schema and a real cold rollback journal.
    owner.exec("CREATE TABLE fixture_owner(id INTEGER); DROP TABLE fixture_owner");
    assert.deepEqual(owner.prepare("SELECT name FROM sqlite_schema").all(), []);
  } finally { owner.close(); }
  fs.writeFileSync(path.join(dataDir, "profile.json"), JSON.stringify(manifest) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "model.json"), '{"key":"synthetic-predecessor-only"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "control.token"), "synthetic-predecessor-token\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "pending-test.json"), '{"input":"never replay"}\n');
  fs.writeFileSync(path.join(root, "workspace", "source.ts"), "original workspace\n");
  fs.writeFileSync(path.join(root, "agent-work", "source.ts"), "original work copy\n");
  f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  f.document("ruukoto.local-input", { digest: "synthetic-committed-wal-input" }, "old-request");
  const selection = selectProfile({ dataDir }, {}), storage = profileStorage(selection);
  const snapshot = () => oldRoots.flatMap(name => [name, ...fs.readdirSync(path.join(root, name), { recursive: true }).map(child => path.join(name, String(child)))]).sort().map(name => {
    const filename = path.join(root, name), stat = fs.lstatSync(filename);
    return { name, dev: stat.dev, ino: stat.ino, mode: stat.mode, bytes: stat.isFile() ? fs.readFileSync(filename) : null };
  });
  return { dataDir, ownerFile, selection, storage, snapshot, cleanup() {
    const preparation = path.join(storage.rootDir, "preparation.json");
    if (fs.existsSync(preparation)) {
      const record = JSON.parse(fs.readFileSync(preparation, "utf8")) as { socketPath: string };
      fs.rmSync(path.dirname(record.socketPath), { recursive: true, force: true });
    }
    f.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

function assertOwnerLock(ownerFile: string, mode: OwnerJournalMode, expected: "busy" | "acquired"): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const owner = new DatabaseSync(process.argv[1]);
    try {
      owner.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=" + process.argv[2] + "; BEGIN EXCLUSIVE");
      owner.exec("ROLLBACK");
      process.stdout.write("acquired");
    } catch (error) {
      if (error.errcode !== 5) throw error;
      process.stdout.write("busy");
    } finally { owner.close(); }
  `, ownerFile, mode], { encoding: "utf8", timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected);
}

for (const mode of ["delete", "truncate", "persist"] as const) {
  test(`stopped durable ${mode} owner activates blank storage while holding exclusion through publication`, async () => {
    const f = bootstrapFixture(mode);
    try {
      const journal = f.ownerFile + "-journal";
      assert.equal(fs.existsSync(journal), mode !== "delete");
      if (mode === "truncate") assert.equal(fs.statSync(journal).size, 0);
      if (mode === "persist") {
        const bytes = fs.readFileSync(journal);
        assert.ok(bytes.length > 0);
        assert.deepEqual(bytes.subarray(0, 8), Buffer.alloc(8));
      }
      assert.ok(fs.statSync(path.join(f.dataDir, "personal.sqlite-wal")).size > 0);
      assert.ok(fs.existsSync(path.join(f.dataDir, "personal.sqlite-shm")));
      const before = f.snapshot(), checkpoints: string[] = [];
      const profile = await bootstrapProfile(f.selection, { checkpoint(name) {
        if (name !== "before-activation" && name !== "after-activation") return;
        checkpoints.push(name);
        assert.equal(fs.existsSync(path.join(f.storage.rootDir, "profile.json")), name === "after-activation");
        assertOwnerLock(f.ownerFile, mode, "busy");
      } });
      assert.deepEqual(checkpoints, ["before-activation", "after-activation"]);
      assert.equal(readProfile(f.selection)!.instanceId, profile.instanceId);
      const fresh = new DatabaseSync(path.join(profile.dataDir, "ruukoto.db"), { readOnly: true });
      try {
        assert.equal(fresh.prepare("SELECT count(*) AS count FROM tasks").get()!.count, 0);
        assert.equal(fresh.prepare("SELECT value FROM meta WHERE key='instance_id'").get()!.value, profile.instanceId);
      } finally { fresh.close(); }
      assert.equal(fs.existsSync(path.join(profile.dataDir, "personal.sqlite")), false);
      assert.equal(fs.existsSync(path.join(profile.agentDir, "model.json")), false);
      assert.deepEqual(fs.readdirSync(profile.pendingDir).sort(), [".ruukoto-role.json", "desktop", "tui"]);
      assert.notEqual(fs.readFileSync(path.join(profile.controlDir, "owner.token"), "utf8"), fs.readFileSync(path.join(f.dataDir, "control.token"), "utf8"));
      assertOwnerLock(f.ownerFile, mode, "acquired");
      assert.equal((await bootstrapProfile(f.selection)).instanceId, profile.instanceId);
      assert.deepEqual(f.snapshot(), before);
    } finally { f.cleanup(); }
  });

  test(`live durable ${mode} owner rejects activation without changing original files or sidecars`, { timeout: 20_000 }, async () => {
    const f = bootstrapFixture(mode);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const owner = new DatabaseSync(process.argv[1]);
      owner.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=" + process.argv[2] + "; BEGIN EXCLUSIVE");
      process.stdin.resume();
      process.stdin.once("end", () => { owner.exec("ROLLBACK"); owner.close(); });
      process.stdout.write("locked\\n");
    `, f.ownerFile, mode], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const ready = new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.includes("locked\n")) resolve(); });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Synthetic durable owner exited before locking: ${code} ${stderr}`)));
    });
    try {
      await ready;
      const before = f.snapshot();
      await assert.rejects(bootstrapProfile(f.selection), { code: "old_profile_busy" });
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(readProfile(f.selection), null);
      assert.equal(fs.existsSync(path.join(f.storage.rootDir, "preparation.json")), false);
      for (const directory of [f.storage.dataDir, f.storage.agentDir, f.storage.controlDir, f.storage.pendingDir]) assert.equal(fs.existsSync(directory), false);
      assert.deepEqual(f.snapshot(), before);
      child.stdin.end();
      const [code, signal] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(signal, null);
      assert.deepEqual(f.snapshot(), before);
    } finally {
      child.stdin.end();
      try { await exited; } finally { f.cleanup(); }
    }
  });
}
