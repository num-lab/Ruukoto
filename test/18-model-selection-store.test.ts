import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { ModelSelection } from "../src/core/types.ts";

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
