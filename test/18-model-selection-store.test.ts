import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { isAccessMode, isSessionDefaultMode, SESSION_DEFAULT_MODES, type ModelSelection } from "@ruukoto/core/types.ts";

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

test("新会话初始模式、模型与 session.created 原子落盘，失败不留下会话", () => {
  const f = fixture();
  try {
    const { store, db, root, session } = f;
    const input = { projectId: session.projectId, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "initial", confirmTools: [], defaultAccessMode: "full_access" as const, modelSelection: b, createRequestId: "initial" };
    const created = store.withTx(() => store.createSession(input));
    const row = db.prepare("SELECT default_access_mode, default_access_mode_version, model_selection, model_selection_version FROM sessions WHERE id = ?").get(created.id)!;
    assert.equal(row.default_access_mode, "full_access");
    assert.equal(row.default_access_mode_version, 0);
    assert.deepEqual(JSON.parse(String(row.model_selection)), b);
    assert.equal(row.model_selection_version, 1);
    const event = store.getEventsAfter(0).find(event => event.body.type === "session.created" && event.body.sessionId === created.id)!;
    assert.equal(event.body.type, "session.created");
    if (event.body.type === "session.created") assert.deepEqual(event.body.session, created);
    const seq = store.getMaxSeq();
    db.exec("CREATE TRIGGER reject_create_event BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'session.created' BEGIN SELECT RAISE(ABORT, 'event failure'); END");
    assert.throws(() => store.withTx(() => store.createSession({ ...input, piSessionId: "failed", createRequestId: "failed" })), /event failure/);
    assert.equal(store.findSessionByCreateRequestId("failed"), null);
    assert.equal(store.getMaxSeq(), seq);
  } finally { f.cleanup(); }
});

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

test("旧队列批量补配置事件保持有界，所有任务可同步", () => {
  const f = fixture();
  try {
    const { store, db, session } = f;
    store.withTx(() => {
      for (let i = 0; i < 2000; i++) db.prepare("INSERT INTO tasks (id, session_id, request_id, input, status, created_at, queue_order) VALUES (?, ?, ?, '', 'queued', '', ?)").run(`legacy-${i}-${"x".repeat(50)}`, session.id, String(i), i + 1);
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
