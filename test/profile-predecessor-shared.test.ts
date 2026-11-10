import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ProfileError } from "@ruukoto/core/profile-files.ts";
import { inspectSharedPredecessor } from "@ruukoto/core/profile-predecessor-shared.ts";

const DDL = fs.readFileSync(new URL("./fixtures/profile-predecessor/shared-schema58.sql", import.meta.url), "utf8");
const NOW = "2026-11-01T00:00:00.000Z";
const INSTANCE = "66e705a2-ac1d-45dc-b4c7-308954574741";

function fixture(product = "ruukoto-code", ddl = DDL) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-shared-admission-"));
  const database = path.join(root, "ruukoto.db");
  const db = new DatabaseSync(database);
  db.exec(ddl);
  const meta = db.prepare("INSERT INTO meta(key,value) VALUES (?,?)");
  meta.run("schema_version", "58"); meta.run("product.type", product); meta.run("instance_id", INSTANCE);
  db.prepare("INSERT INTO projects(id,name,created_at) VALUES ('project','synthetic',?)").run(NOW);
  db.prepare("INSERT INTO sessions(id,project_id,cwd,cwd_real,cwd_dev,cwd_ino,pi_session_id,created_at) VALUES ('session','project','/fixture','/fixture',1,2,'pi',?)").run(NOW);
  task(db, "task");
  return { root, database, db, close: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function task(db: DatabaseSync, id: string, status = "completed") {
  db.prepare("INSERT INTO tasks(id,session_id,request_id,input,queue_order,status,created_at,started_at,ended_at) VALUES (?,'session',?,'synthetic',1,?,?,?,?)")
    .run(id, id, status, NOW, status === "queued" ? null : NOW, status === "queued" ? null : NOW);
}
function tool(db: DatabaseSync, id: string, name = "bash", mcp: object | null = null, taskId = "task") {
  db.prepare("INSERT INTO tool_ops(id,task_id,tool_name,params,intent_recorded_at,mcp) VALUES (?,?,?,'{}',?,?)")
    .run(id, taskId, name, NOW, mcp === null ? null : JSON.stringify(mcp));
}
function expectRejected(database: string, code = "old_profile_execution_unverified") {
  assert.throws(() => inspectSharedPredecessor(database), (error: unknown) => error instanceof ProfileError && error.code === code);
}
function browser(dataDir: string) {
  const id = createHash("sha256").update(`${dataDir}\0session`).digest("hex").slice(0, 24);
  return { version: 1, bindings: [{ sessionId: "session", generation: INSTANCE, kind: "owned", state: "closed", profileDir: path.join(dataDir, "browser", id, "profile"),
    socketDir: `/tmp/ruukoto-browser-501-${id}`, cliSession: `rk-${id}`, cdpUrl: null, targetId: null,
    chrome: { pid: 2345, pgid: 2345, processIdentity: "darwin:Sun Nov  1 00:00:00 2026" }, daemon: null, dashboard: null,
    chromePending: false, daemonPending: false, dashboardPending: false, lockDir: null, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: true, failureCode: null, dashboardUrl: null, headed: false }] };
}
function cua(dataDir: string, executionId = "native", state = "closed") {
  return { serviceId: "service", configVersion: 3, effect: "unknown", rawTool: { name: "operation", inputSchema: {} }, modelTool: { name: "operation", inputSchema: {} }, arguments: {},
    execution: { executionId, fingerprint: "a".repeat(64), directory: path.join(dataDir, "cua-executions") }, state, stoppedAt: NOW };
}
function background(db: DatabaseSync, id = "process", state = "stopped") {
  const opId = `${id}-start`;
  tool(db, opId, "process_start");
  db.prepare("UPDATE tool_ops SET params=? WHERE id=?").run(JSON.stringify({ command: "synthetic" }), opId);
  const payload = { id, sessionId: "session", taskId: "task", hostOpId: opId, command: "synthetic", state, stopVerified: state === "stopped", version: 9, createdAt: NOW, updatedAt: NOW,
    workspace: { path: "/fixture", dev: 1, ino: 2 }, ref: { platform: "linux", executionId: id }, permissionVersion: 1,
    source: { kind: "coding-owner", projectId: "project", input: "synthetic", accessMode: "full_access", permissionVersion: 1, grantedPaths: [], inputSeq: 1 },
    handedOff: false, launchClaimed: false, launchFingerprint: null, referenceSnapshot: null, logEvidence: null, exit: { code: 0, signal: null }, reason: null, partial: false, stdoutBytes: 0, stderrBytes: 0 };
  db.prepare("INSERT INTO background_processes(id,session_id,task_id,host_op_id,state,payload) VALUES (?,'session','task',?,?,?)")
    .run(id, opId, state, JSON.stringify(payload));
  return payload;
}
function workflow(db: DatabaseSync, stopVerified: boolean | null = true) {
  const definition = { id: "definition", digest: "digest", script: "return null", interfaceVersion: 2, createdAt: NOW };
  db.prepare("INSERT INTO workflow_definitions(id,digest,payload) VALUES ('definition','digest',?)").run(JSON.stringify(definition));
  const payload = { id: "run", interfaceVersion: 2, requestKey: "request", paramsDigest: "params", definitionId: "definition", scriptDigest: "digest", input: null, inputDigest: "input",
    source: { sessionId: "session" }, modelSelection: {}, status: "succeeded", version: 8, reason: null, attempts: 1, maxAttempts: 2, durationMs: 1000, usedMs: 20,
    clockStartedAt: null, clockVerified: true, scriptUnits: [{ kind: "systemd_unit", id: "script.service", label: "script" }], scriptStopVerified: stopVerified,
    result: null, resultRecorded: true, createdAt: NOW, endedAt: NOW };
  db.prepare("INSERT INTO workflow_runs(id,source_session_id,request_key,params_digest,status,payload) VALUES ('run','session','request','params','succeeded',?)").run(JSON.stringify(payload));
  const execution = { id: "execution", runId: "run", stepKey: "step", kind: "agent", taskId: "task", number: 1, status: "finished", units: [], stopVerified: true };
  db.prepare("INSERT INTO workflow_executions(id,run_id,step_key,kind,task_id,number,payload) VALUES ('execution','run','step','agent','task',1,?)").run(JSON.stringify(execution));
  return { payload, execution };
}

for (const product of ["ruukoto", "ruukoto-code"]) {
  test(`stopped schema58 ${product} history is recognized without adopting it`, () => {
    const f = fixture(product);
    try {
      task(f.db, "queued", "queued");
      f.db.prepare("UPDATE tasks SET effect_unknown=1 WHERE id='task'").run();
      tool(f.db, "unknown-effect");
      f.db.prepare("UPDATE tool_ops SET effect_unknown=1 WHERE id='unknown-effect'").run();
      f.db.prepare("INSERT INTO task_browser_bindings(task_id,connection_id,created_at) VALUES ('task','dead-desktop',?)").run(NOW);
      const before = fs.readFileSync(f.database);
      inspectSharedPredecessor(f.database);
      assert.deepEqual(fs.readFileSync(f.database), before);
      assert.equal(f.db.prepare("SELECT effect_unknown FROM tool_ops WHERE id='unknown-effect'").get()!.effect_unknown, 1);
    } finally { f.close(); }
  });
}

test("exact schema fingerprint rejects changed checks, missing indexes, additional schema and newer versions", () => {
  for (const change of [
    "DROP INDEX idx_tasks_status",
    "CREATE TABLE future_resource(id TEXT)",
    "UPDATE meta SET value='59' WHERE key='schema_version'",
    "UPDATE meta SET value='invalid' WHERE key='instance_id'",
    "UPDATE meta SET value='foreign' WHERE key='product.type'",
  ]) {
    const f = fixture();
    try { f.db.exec(change); expectRejected(f.database, change.includes("value='59'") ? "old_profile_version_unsupported" : "old_profile_unrecognized"); }
    finally { f.close(); }
  }
  const f = fixture("ruukoto-code", DDL.replace("queue_order > 0", "queue_order >= 0"));
  try { expectRejected(f.database, "old_profile_unrecognized"); }
  finally { f.close(); }
});

test("metadata-only and malformed databases are not predecessor fingerprints", () => {
  const f = fixture();
  try {
    const unknown = path.join(f.root, "unknown.db");
    const db = new DatabaseSync(unknown);
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.prepare("INSERT INTO meta VALUES ('schema_version','58')").run();
    db.close();
    expectRejected(unknown, "old_profile_unrecognized");
    fs.writeFileSync(path.join(f.root, "corrupt.db"), "not a SQLite database");
    expectRejected(path.join(f.root, "corrupt.db"), "old_profile_unrecognized");
  } finally { f.close(); }
});

test("terminal task and dead backend do not clear residual occupancy or SubAgent ownership", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO occupancy(cwd_real,cwd_dev,cwd_ino,session_id,task_id,acquired_at) VALUES ('/fixture',1,2,'session','task',?)").run(NOW);
    expectRejected(f.database);
    f.db.exec("DELETE FROM occupancy");
    f.db.prepare("INSERT INTO sub_agents(id,definition,parent_session_id,session_id,work_dir,state,created_at) VALUES ('agent','{}','session','session','/fixture','unverified',?)").run(NOW);
    expectRejected(f.database);
    f.db.exec("UPDATE sub_agents SET state='idle'");
    inspectSharedPredecessor(f.database);
  } finally { f.close(); }
});

test("queued tasks qualify only without any start or resource evidence", () => {
  for (const mutation of [
    "UPDATE tasks SET status='queued',ended_at=NULL",
    "UPDATE tasks SET status='queued',started_at=NULL,ended_at=NULL,effect_unknown=1",
  ]) {
    const f = fixture();
    try { f.db.exec(mutation); expectRejected(f.database); } finally { f.close(); }
  }
  const f = fixture();
  try { task(f.db, "queued", "queued"); tool(f.db, "bad", "read", null, "queued"); expectRejected(f.database); }
  finally { f.close(); }
});

test("all background rows require matching stopped receipts, including late rows", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 151; i++) background(f.db, `process-${i}`);
    inspectSharedPredecessor(f.database);
    background(f.db, "late", "stop_unverified");
    expectRejected(f.database);
    assert.equal(f.db.prepare("SELECT state FROM background_processes WHERE id='late'").get()!.state, "stop_unverified");
  } finally { f.close(); }
});

test("work-copy host snapshot has versioned stop evidence independent of terminal tasks", () => {
  const f = fixture();
  const host = { version: 1, parentTaskId: "task", workId: "work", operation: "verify", source: { path: "/fixture", dev: 1, ino: 2 }, units: [{ kind: "process_group", id: "999", label: "worker" }], stopVerified: true };
  try {
    const save = () => f.db.prepare("UPDATE tasks SET read_scope=?").run(JSON.stringify({ paths: [], sourceRefs: [], workCopyHost: host }));
    save(); inspectSharedPredecessor(f.database);
    host.stopVerified = false; save(); expectRejected(f.database);
    host.stopVerified = true; host.version = 2; save(); expectRejected(f.database, "old_profile_version_unsupported");
    f.db.exec("UPDATE tasks SET read_scope=NULL,request_id='work-copy-host:orphan'"); expectRejected(f.database);
  } finally { f.close(); }
});

test("workflow run and every execution need their own stop proof", () => {
  const f = fixture();
  try {
    const { payload, execution } = workflow(f.db);
    inspectSharedPredecessor(f.database);
    execution.stopVerified = false;
    f.db.prepare("UPDATE workflow_executions SET payload=?").run(JSON.stringify(execution)); expectRejected(f.database);
    execution.stopVerified = true;
    f.db.prepare("UPDATE workflow_executions SET payload=?").run(JSON.stringify(execution));
    payload.scriptStopVerified = null;
    f.db.prepare("UPDATE workflow_runs SET payload=?").run(JSON.stringify(payload)); expectRejected(f.database);
    payload.scriptStopVerified = true; payload.interfaceVersion = 3;
    f.db.prepare("UPDATE workflow_runs SET payload=?").run(JSON.stringify(payload)); expectRejected(f.database, "old_profile_version_unsupported");
  } finally { f.close(); }
});

test("closed browser keeps historical PIDs and unknown outcomes but rejects pending ownership", () => {
  const f = fixture(), state = browser("/selected/data");
  try {
    const save = () => f.db.prepare("INSERT INTO meta(key,value) VALUES ('browser_bindings_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
    save(); inspectSharedPredecessor(f.database, { dataDir: "/selected/data" });
    assert.throws(() => inspectSharedPredecessor(f.database, { dataDir: "/different/data" }), ProfileError);
    state.bindings[0].daemonPending = true; save(); expectRejected(f.database);
    state.bindings[0].daemonPending = false; state.bindings[0].state = "paused"; save(); expectRejected(f.database);
    state.bindings[0].state = "closed"; state.version = 2; save(); expectRejected(f.database, "old_profile_version_unsupported");
  } finally { f.close(); }
});

test("Cua inspects latest execution rows and separately launched recovery execution", () => {
  const f = fixture();
  try {
    tool(f.db, "original", "cua_connection", cua("/selected/data", "original", "frozen"));
    inspectSharedPredecessor(f.database, { dataDir: "/selected/data" });
    const recovery = { ...cua("/selected/data", "recovery", "finished"), recoversOpId: "original", stoppedAt: undefined };
    tool(f.db, "recovery", "cua_recovery_observe", recovery); expectRejected(f.database);
    f.db.prepare("UPDATE tool_ops SET mcp=? WHERE id='recovery'").run(JSON.stringify({ ...recovery, state: "closed", stoppedAt: NOW }));
    inspectSharedPredecessor(f.database);
    tool(f.db, "late", "cua_connection", { ...cua("/selected/data", "original", "finished"), stoppedAt: undefined }); expectRejected(f.database);
  } finally { f.close(); }
});

test("HTTP MCP uses remote termination rather than read effect or task completion", () => {
  const f = fixture();
  try {
    const mcp = { recordVersion: 2, transport: "http", serviceId: "service", configVersion: 1, remoteName: "read", effect: "read", state: "frozen", started: true, remoteEnded: false };
    tool(f.db, "http", "mcp__service__read", mcp); expectRejected(f.database);
    mcp.remoteEnded = true;
    f.db.prepare("UPDATE tool_ops SET mcp=?,effect_unknown=1").run(JSON.stringify(mcp)); inspectSharedPredecessor(f.database);
    mcp.recordVersion = 3;
    f.db.prepare("UPDATE tool_ops SET mcp=?").run(JSON.stringify(mcp)); expectRejected(f.database, "old_profile_version_unsupported");
  } finally { f.close(); }
});

test("unknown metadata/tool families and consumed service operations reject without replay", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO meta VALUES ('future_resource','{}')").run(); expectRejected(f.database, "old_profile_unrecognized");
    f.db.exec("DELETE FROM meta WHERE key='future_resource'");
    tool(f.db, "unknown", "new_worker"); expectRejected(f.database);
    f.db.exec("DELETE FROM tool_ops"); tool(f.db, "service", "service_manage");
    f.db.prepare("INSERT INTO confirmations(id,task_id,session_id,tool_op_id,tool_name,params,status,created_at) VALUES ('approval','task','session','service','service_manage','{}','approved',?)").run(NOW);
    inspectSharedPredecessor(f.database);
    f.db.prepare("UPDATE confirmations SET consumed_at=?").run(NOW); expectRejected(f.database);
  } finally { f.close(); }
});

test("private coherent WAL copy includes a committed blocker and inspection closes on rejection", () => {
  const f = fixture();
  try {
    f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
    f.db.prepare("INSERT INTO occupancy(cwd_real,cwd_dev,cwd_ino,session_id,task_id,acquired_at) VALUES ('/late',1,3,'session','task',?)").run(NOW);
    const sourceBytes = fs.readFileSync(f.database), walBytes = fs.readFileSync(f.database + "-wal");
    const privateDir = path.join(f.root, "private"); fs.mkdirSync(privateDir);
    const copy = path.join(privateDir, "ruukoto.db");
    fs.copyFileSync(f.database, copy); fs.copyFileSync(f.database + "-wal", copy + "-wal");
    expectRejected(copy);
    assert.deepEqual(fs.readFileSync(f.database), sourceBytes); assert.deepEqual(fs.readFileSync(f.database + "-wal"), walBytes);
    const writable = new DatabaseSync(copy);
    try { writable.exec("BEGIN EXCLUSIVE; DELETE FROM occupancy; COMMIT"); } finally { writable.close(); }
    inspectSharedPredecessor(copy);
  } finally { f.close(); }
});
