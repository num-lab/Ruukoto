import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { isAccessMode, isSessionDefaultMode, SESSION_DEFAULT_MODES, type ModelSelection } from "../src/core/types.ts";

const a: ModelSelection = { provider: "one", modelId: "a", thinkingLevel: "off" };
const b: ModelSelection = { provider: "two", modelId: "b", thinkingLevel: "max" };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-model-store-"));
  const db = new Db(root);
  const store = new Store(db);
  const project = store.withTx(() => store.createProject("test"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi", confirmTools: [] }));
  return { root, db, store, session, cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("Plan 选择持久化为任务工作方式与 auto-review，默认变更和切换拒绝不改原任务", () => {
  const f = fixture();
  const { store, db, session } = f;
  try {
    assert.deepEqual(SESSION_DEFAULT_MODES, ["confirm", "full_access", "auto-review", "plan"]);
    assert.equal(isSessionDefaultMode("plan"), true);
    assert.equal(isAccessMode("plan"), false);
    const selected = store.withTx(() => store.setSessionDefaultMode(session.id, "plan", 0));
    assert.equal(selected.defaultAccessMode, "plan");
    assert.equal(selected.defaultAccessModeVersion, 1);
    assert.throws(() => store.withTx(() => store.setSessionDefaultMode(session.id, "confirm", 0)), { code: "default_mode_conflict" });
    const input = { sessionId: session.id, requestId: "plan", input: "完善计划", planMode: true, modelSelection: a, submissionDigest: "plan" };
    const planned = store.withTx(() => store.insertQueuedTask(input)).task;
    assert.equal(planned.accessMode, "auto-review");
    assert.equal(planned.planMode, true);
    assert.deepEqual(store.getTask(planned.id), planned);
    const queued = store.getEventsAfter(0).find(e => e.body.type === "task.queued" && e.body.taskId === planned.id)!;
    assert.equal(queued.body.type === "task.queued" && queued.body.planMode, true);
    store.withTx(() => store.setSessionDefaultMode(session.id, "full_access", 1));
    assert.deepEqual(store.getTask(planned.id), planned);
    assert.equal(store.withTx(() => store.insertQueuedTask(input)).task.id, planned.id);
    const confirmation = store.withTx(() => store.createConfirmation({ taskId: planned.id, sessionId: session.id,
      toolOpId: "op", toolName: "request_file_access", params: {}, scope: { kind: "tool", workspaceOnly: false }, permissionVersion: 1 }));
    const seq = store.getMaxSeq();
    for (const mode of ["confirm", "full_access", "auto-review"] as const) {
      assert.throws(() => store.withTx(() => store.requestModeSwitch(planned.id, mode)), { code: "invalid_params" });
      assert.throws(() => store.withTx(() => store.applyModeSwitch(planned.id, mode)), { code: "invalid_params" });
    }
    assert.deepEqual(store.getTask(planned.id), planned);
    assert.deepEqual(store.getConfirmation(confirmation.id), confirmation);
    assert.equal(store.getMaxSeq(), seq);
    for (const mode of ["confirm", "full_access"] as const) {
      assert.throws(() => store.withTx(() => store.insertQueuedTask({ ...input, requestId: mode, accessMode: mode })), { code: "invalid_params" });
    }
    const ordinary = store.withTx(() => store.insertQueuedTask({ ...input, requestId: "ordinary", input: "/plan 原文", planMode: false,
      resumesTaskId: planned.id, accessMode: "confirm", submissionDigest: "ordinary" })).task;
    assert.equal(ordinary.planMode, false);
    assert.equal(store.withTx(() => store.requestModeSwitch(ordinary.id, "full_access")), true);
    assert.equal(store.withTx(() => store.applyModeSwitch(ordinary.id, "full_access")), 2);
    assert.equal(store.getTask(ordinary.id)!.accessMode, "full_access");
    assert.throws(() => db.prepare("UPDATE tasks SET plan_mode = 2 WHERE id = ?").run(planned.id), /CHECK constraint failed/);
  } finally { f.cleanup(); }
});

test("v31 模式升级保留全部会话字段、任务与引用，不从旧 /plan 文本回填计划状态", () => {
  const f = fixture();
  const { db, store, session, root } = f;
  const child = store.withTx(() => store.createSession({ projectId: session.projectId, cwd: root, cwdReal: root,
    cwdDev: 1, cwdIno: 2, piSessionId: "child", confirmTools: ["read"], createRequestId: "child-request" }));
  const group = store.withTx(() => store.createSession({ projectId: session.projectId, kind: "qq_group", cwd: root, cwdReal: root,
    cwdDev: 1, cwdIno: 3, piSessionId: "group", confirmTools: [], createRequestId: "group-request" }));
  store.withTx(() => {
    store.setSessionDefaultMode(session.id, "auto-review", 0);
    store.setSessionDefaultMode(group.id, "full_access", 0);
    store.setSessionModel(session.id, b, 0);
    store.setSessionQueueState(session.id, "paused", "保留原因");
    db.prepare("UPDATE sessions SET workspace_project_id = ?, session_file = ? WHERE id = ?").run(session.projectId, "history.jsonl", session.id);
    db.prepare("INSERT INTO sub_agents (id, parent_session_id, session_id, work_dir, state, created_at) VALUES ('sub', ?, ?, ?, 'idle', 'now')")
      .run(session.id, child.id, root);
    db.prepare("INSERT INTO agent_roles (id, project_id, session_id, work_dir, tools, created_at) VALUES ('chat', ?, ?, ?, '[]', 'now')")
      .run(session.projectId, group.id, root);
  });
  const task = store.withTx(() => store.insertQueuedTask({ sessionId: session.id, requestId: "old-plan", input: "/plan 保留原文",
    accessMode: "auto-review", modelSelection: a, submissionDigest: "old-plan", workId: "work", subAgentId: "sub",
    readScope: { paths: [], sourceRefs: [] } })).task;
  const continued = store.withTx(() => store.insertQueuedTask({ sessionId: session.id, requestId: "old-continue", input: "继续",
    accessMode: "confirm", modelSelection: b, submissionDigest: "old-continue", resumesTaskId: task.id })).task;
  store.withTx(() => {
    db.prepare("INSERT INTO work_delegations (id, parent_session_id, origin_task_id, sub_agent_id, request_key, params_digest, created_at) VALUES ('work', ?, ?, 'sub', 'key', 'digest', 'now')")
      .run(session.id, task.id);
    store.createConfirmation({ taskId: task.id, sessionId: session.id, toolOpId: "old-op", toolName: "read", params: {},
      scope: { kind: "tool", workspaceOnly: false }, permissionVersion: 1 });
    store.createArtifact({ id: "old-artifact", taskId: task.id, sessionId: session.id, name: "old" });
    store.requestModeSwitch(task.id, "confirm");
  });
  const tables = ["sessions", "tasks", "sub_agents", "work_delegations", "agent_roles", "confirmations", "artifacts", "events"];
  const saved = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  const instance = db.getInstanceId();
  db.close();
  const raw = new DatabaseSync(path.join(root, "ruukoto.db"));
  try {
    raw.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get() as { sql: string }).sql;
    raw.exec(sql.replace("CREATE TABLE sessions", "CREATE TABLE sessions_v31").replace(",'plan'", ""));
    raw.exec("INSERT INTO sessions_v31 SELECT * FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_v31 RENAME TO sessions; CREATE UNIQUE INDEX idx_sessions_create_request ON sessions (create_request_id) WHERE create_request_id IS NOT NULL; ALTER TABLE tasks DROP COLUMN plan_mode; UPDATE meta SET value = '31' WHERE key = 'schema_version'; COMMIT");
    assert.throws(() => raw.prepare("UPDATE sessions SET default_access_mode = 'plan' WHERE id = ?").run(session.id), /CHECK constraint failed/);
    raw.exec(`CREATE TRIGGER reject_plan_upgrade BEFORE UPDATE ON meta
      WHEN NEW.key = 'schema_version' AND NEW.value = '${SCHEMA_VERSION}'
      BEGIN SELECT RAISE(ABORT, 'upgrade failure'); END`);
  } finally { raw.close(); }
  assert.throws(() => new Db(root), /upgrade failure/);
  const rolledBack = new DatabaseSync(path.join(root, "ruukoto.db"));
  try {
    assert.equal((rolledBack.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, "31");
    assert.equal((rolledBack.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some(column => column.name === "plan_mode"), false);
    assert.deepEqual(rolledBack.prepare("SELECT * FROM sessions ORDER BY 1").all(), saved[0]);
    assert.deepEqual(rolledBack.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => rolledBack.prepare("UPDATE sessions SET default_access_mode = 'plan' WHERE id = ?").run(session.id), /CHECK constraint failed/);
    rolledBack.exec("DROP TRIGGER reject_plan_upgrade");
  } finally { rolledBack.close(); }
  const upgraded = new Db(root);
  try {
    const current = new Store(upgraded);
    tables.forEach((table, index) => assert.deepEqual(upgraded.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), saved[index], table));
    assert.equal(current.getTask(task.id)!.planMode, false);
    assert.equal(current.getTask(continued.id)!.planMode, false);
    assert.equal(current.getTask(task.id)!.input, "/plan 保留原文");
    assert.equal(upgraded.getInstanceId(), instance);
    assert.equal((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((upgraded.prepare("PRAGMA foreign_keys").get() as any).foreign_keys, 1);
    current.withTx(() => current.setSessionDefaultMode(session.id, "plan", 1));
    assert.equal(current.getSession(session.id)!.defaultAccessMode, "plan");
    assert.equal(current.findSessionByCreateRequestId("child-request")!.id, child.id);
  } finally { upgraded.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("会话模型 CAS、不可变提交摘要及旧队列配置都与持久事件原子提交", () => {
  const f = fixture();
  const { store, db, session } = f;
  try {
    store.withTx(() => store.initializeSessionModelSelections(a));
    const v1 = store.getSession(session.id)!;
    assert.equal(v1.modelSelectionVersion, 1);
    store.withTx(() => store.initializeSessionModelSelections(b));
    assert.deepEqual(store.getSession(session.id), v1);
    const seq = store.getMaxSeq();
    store.withTx(() => store.setSessionModel(session.id, a, 1));
    assert.equal(store.getMaxSeq(), seq);
    assert.throws(() => store.withTx(() => store.setSessionModel(session.id, b, 0)), { code: "model_selection_conflict" });
    db.exec("CREATE TRIGGER reject_model_event BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'session.model_selection_changed' BEGIN SELECT RAISE(ABORT, 'event failure'); END");
    assert.throws(() => store.withTx(() => store.setSessionModel(session.id, b, 1)), /event failure/);
    assert.deepEqual(store.getSession(session.id), v1);
    db.exec("DROP TRIGGER reject_model_event");
    store.withTx(() => store.setSessionModel(session.id, b, 1));
    const input = { sessionId: session.id, requestId: "r1", input: "hello", modelSelection: a, submissionDigest: "original" };
    const task = store.withTx(() => store.insertQueuedTask(input)).task;
    store.withTx(() => store.applyModeSwitch(task.id, "full_access"));
    assert.equal(store.withTx(() => store.insertQueuedTask(input)).duplicate, true);
    assert.throws(() => store.findMatchingSubmission({ ...input, submissionDigest: "different" }), { code: "request_conflict" });
    assert.deepEqual(store.getTask(task.id)!.modelSelection, a);
    const legacy = store.withTx(() => store.insertQueuedTask({ ...input, requestId: "old" })).task;
    db.prepare("UPDATE tasks SET model_selection = NULL, submission_digest = NULL WHERE id = ?").run(legacy.id);
    assert.equal(store.countLegacyQueuedTasks(session.id), 1);
    assert.throws(() => store.findMatchingSubmission({ ...input, requestId: "old" }), { code: "request_conflict" });
    assert.throws(() => store.withTx(() => { store.fillLegacyQueuedModelSelections(session.id, b); throw new Error("occupancy active"); }));
    assert.equal(store.getTask(legacy.id)!.modelSelection, null);
    store.withTx(() => { store.fillLegacyQueuedModelSelections(session.id, b); store.setSessionQueueState(session.id, "active", null); });
    assert.deepEqual(store.getTask(legacy.id)!.modelSelection, b);
    assert.equal(store.getTask(legacy.id)!.submissionDigest, null);
    assert.deepEqual(store.getTask(task.id)!.modelSelection, a);
    const events = store.getEventsAfter(seq);
    assert.ok(events.some(e => e.body.type === "tasks.model_selection_recorded" && e.body.taskIds.includes(legacy.id)));
  } finally { f.cleanup(); }
});

for (const version of [2, 3, 4]) {
  test(`v${version} 升级到当前版本保留旧任务、历史事件及空模型记录`, () => {
    const f = fixture();
    const { db, store, session, root } = f;
    const task = store.withTx(() => store.insertQueuedTask({ sessionId: session.id, requestId: "old", input: "original", modelSelection: a, submissionDigest: "digest" })).task;
    store.withTx(() => store.transitionTask(task.id, ["queued"], "completed"));
    const events = store.getEventsAfter(0);
    db.exec("ALTER TABLE sessions DROP COLUMN model_selection; ALTER TABLE sessions DROP COLUMN model_selection_version; ALTER TABLE tasks DROP COLUMN model_selection; ALTER TABLE tasks DROP COLUMN submission_digest;");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
    db.close();
    const upgraded = new Db(root);
    try {
      const current = new Store(upgraded);
      assert.equal(current.getTask(task.id)!.input, "original");
      assert.equal(current.getTask(task.id)!.status, "completed");
      assert.equal(current.getTask(task.id)!.modelSelection, null);
      assert.equal(current.getTask(task.id)!.submissionDigest, null);
      assert.equal(current.getSession(session.id)!.modelSelectionVersion, 0);
      assert.deepEqual(current.getEventsAfter(0), events);
      assert.equal((upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
    } finally { upgraded.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test("旧队列批量补配置事件保持有界，所有任务可同步", () => {
  const f = fixture();
  try {
    const { store, db, session } = f;
    store.withTx(() => {
      for (let i = 0; i < 2000; i++) db.prepare("INSERT INTO tasks (id, session_id, request_id, input, status, created_at) VALUES (?, ?, ?, '', 'queued', '')").run(`legacy-${i}-${"x".repeat(50)}`, session.id, String(i));
    });
    const seq = store.getMaxSeq();
    store.withTx(() => store.fillLegacyQueuedModelSelections(session.id, b));
    const events = store.getEventsAfter(seq);
    assert.ok(events.length > 1);
    assert.equal(events.reduce((n, e) => n + (e.body.type === "tasks.model_selection_recorded" ? e.body.taskIds.length : 0), 0), 2000);
    assert.ok(events.every(e => Buffer.byteLength(JSON.stringify(e)) < 33 * 1024));
    assert.equal(store.countLegacyQueuedTasks(session.id), 0);
  } finally { f.cleanup(); }
});
