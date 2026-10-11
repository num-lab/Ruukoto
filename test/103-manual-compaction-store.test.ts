/** 真实 SQLite 验证手动压缩迁移、幂等、唯一终态和事务失败后的旧点。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store, StoreConflictError } from "@ruukoto/core/store.ts";
import { finishCompactionRequest, getCompactionRequest, getLatestSessionCompaction, recoverCompactionRequests, reserveCompactionRequest, updateCompactionSource } from "@ruukoto/core/compaction.ts";
import type { ContextCheckpoint, SessionCompactionRequest } from "@ruukoto/core/types.ts";

const selection = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" as const };
const now = "2026-10-11T00:00:00.000Z";

function checkpoint(id: string, manualRequestId: string | null = null): Omit<ContextCheckpoint, "status"> {
  return { id, sessionId: "session", summarizedCount: 3, clearedCount: 3, fingerprint: "source-prefix", summary: "已确认决定与未完成工作", summaryUntil: now,
    clearedRefs: {}, clearedResults: 0, summaryModel: "mock/mock-model", summaryStatus: "ok", summaryError: null, promptVersion: "compaction-v2",
    usage: null, estimateBefore: 100, estimateAfter: 40, taskId: manualRequestId ? null : "original-task", callIndex: manualRequestId ? null : 1, manualRequestId, createdAt: now };
}

function request(requestId: string, expectedCheckpointId: string | null = "original"): SessionCompactionRequest {
  return { requestId, sessionId: "session", prompt: "保留  迁移细节\n和未完成工作", paramsDigest: `digest-${requestId}`, modelSelection: selection,
    summaryModel: { provider: "mock", modelId: "mock-model" }, source: null, expectedCheckpointId, status: "running", checkpointId: null,
    summarizedCount: 0, estimateBefore: null, estimateAfter: null, errorCode: null, errorMessage: null, createdAt: now, endedAt: null };
}

test("schema 33 的真实 NOT NULL 旧点完整迁移，手动来源可空且索引继续约束唯一有效点", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-compaction-schema-"));
  let db: Db | null = null;
  try {
    db = new Db(root);
    const original = checkpoint("original");
    const initial = new Store(db);
    initial.withTx(() => initial.insertCheckpoint(original));
    db.close(); db = null;
    const raw = new DatabaseSync(path.join(root, "ruukoto.db"));
    const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_checkpoints'").get() as { sql: string }).sql
      .replace("task_id TEXT,", "task_id TEXT NOT NULL,").replace("call_index INTEGER,", "call_index INTEGER NOT NULL,").replace("  manual_request_id TEXT,\n", "");
    const columns = (raw.prepare("PRAGMA table_info(context_checkpoints)").all() as Array<{ name: string }>).map(row => row.name).filter(name => name !== "manual_request_id").join(", ");
    raw.exec("ALTER TABLE context_checkpoints RENAME TO old_checkpoints");
    raw.exec("DROP INDEX idx_context_checkpoints_active");
    raw.exec(sql);
    raw.exec(`INSERT INTO context_checkpoints (${columns}) SELECT ${columns} FROM old_checkpoints`);
    raw.exec("DROP TABLE old_checkpoints");
    raw.exec("CREATE UNIQUE INDEX idx_context_checkpoints_active ON context_checkpoints (session_id) WHERE status = 'active'");
    raw.exec("DROP TABLE compaction_requests");
    raw.prepare("UPDATE meta SET value = '33' WHERE key = 'schema_version'").run();
    assert.equal((raw.prepare("PRAGMA table_info(context_checkpoints)").all() as Array<{ name: string; notnull: number }>).find(row => row.name === "task_id")!.notnull, 1);
    raw.close();
    db = new Db(root);
    const store = new Store(db);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, String(SCHEMA_VERSION));
    assert.deepEqual(store.getActiveCheckpoint("session"), { ...original, status: "active" });
    const columnsAfter = db.prepare("PRAGMA table_info(context_checkpoints)").all() as Array<{ name: string; notnull: number }>;
    assert.equal(columnsAfter.find(row => row.name === "task_id")!.notnull, 0);
    assert.equal(columnsAfter.find(row => row.name === "call_index")!.notnull, 0);
    store.withTx(() => store.insertCheckpoint(checkpoint("manual", "external-request")));
    assert.equal(store.getActiveCheckpoint("session")!.manualRequestId, "external-request");
    assert.equal(store.getActiveCheckpoint("session")!.taskId, null);
    assert.equal(store.getActiveCheckpoint("session")!.callIndex, null);
    assert.equal(store.getCheckpoint("original")!.status, "superseded");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM context_checkpoints WHERE status = 'active'").get()!.n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM compaction_requests").get()!.n, 0, "来源标识不要求存在本实例操作回执");
  } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("同键复用、异参和忙时拒绝；取消与成功只产生一个终态，成功事件提交后才可见", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-compaction-state-"));
  const db = new Db(root);
  const store = new Store(db);
  try {
    store.withTx(() => store.insertCheckpoint(checkpoint("original")));
    const accepted = store.withTx(() => reserveCompactionRequest(store, request("cancel-first")));
    assert.deepEqual(store.withTx(() => reserveCompactionRequest(store, { ...accepted, modelSelection: { ...selection, modelId: "changed" } })), accepted);
    assert.throws(() => store.withTx(() => reserveCompactionRequest(store, { ...accepted, paramsDigest: "different" })), (error: unknown) => error instanceof StoreConflictError && error.code === "request_conflict");
    assert.throws(() => store.withTx(() => reserveCompactionRequest(store, request("competing"))), (error: unknown) => error instanceof StoreConflictError && error.code === "session_busy");
    store.withTx(() => finishCompactionRequest(store, accepted.requestId, { status: "cancelled" }));
    assert.equal(store.withTx(() => finishCompactionRequest(store, accepted.requestId, { status: "succeeded" }, checkpoint("cancelled-result", accepted.requestId))).status, "cancelled");
    assert.equal(store.getActiveCheckpoint("session")!.id, "original");
    const next = store.withTx(() => reserveCompactionRequest(store, request("success-first")));
    const source = { file: "/read-only/history", dev: 1, ino: 2, byteLimit: 100, fingerprint: "history", entryId: "tail", messageCount: 4, excluded: [] };
    store.withTx(() => updateCompactionSource(store, next.requestId, source, "original"));
    let broadcast = 0;
    store.onCommitted = events => {
      if (!events.some(event => event.body.type === "session.context_compaction" && event.body.status === "succeeded")) return;
      assert.equal(store.getActiveCheckpoint("session")!.id, "success-point");
      assert.equal(getCompactionRequest(store, next.requestId)!.status, "succeeded");
      broadcast++;
    };
    const finished = store.withTx(() => finishCompactionRequest(store, next.requestId, { status: "succeeded", summarizedCount: 3, estimateBefore: 100, estimateAfter: 40 }, checkpoint("success-point", next.requestId)));
    assert.equal(finished.checkpointId, "success-point");
    assert.equal(broadcast, 1);
    assert.equal(getLatestSessionCompaction(store, "session")!.requestId, next.requestId);
    assert.equal(store.withTx(() => finishCompactionRequest(store, next.requestId, { status: "cancelled" })).status, "succeeded");
    assert.equal(store.getCheckpoint("original")!.status, "superseded");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(body, '$.type') = 'session.context_compaction' AND json_extract(body, '$.status') != 'running'").get()!.n, 2);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("提交事件失败整体回滚；旧点变化拒绝发布；重启仅中断在途请求，不覆盖已成功结果", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-compaction-rollback-"));
  let db = new Db(root);
  let store = new Store(db);
  try {
    store.withTx(() => store.insertCheckpoint(checkpoint("original")));
    store.withTx(() => reserveCompactionRequest(store, request("rollback")));
    db.exec(`CREATE TRIGGER reject_compaction_event BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.status') = 'succeeded' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
    assert.throws(() => store.withTx(() => finishCompactionRequest(store, "rollback", { status: "succeeded" }, checkpoint("rolled-back", "rollback"))));
    assert.equal(store.getActiveCheckpoint("session")!.id, "original");
    assert.equal(store.getCheckpoint("rolled-back"), null);
    assert.equal(getCompactionRequest(store, "rollback")!.status, "running");
    db.exec("DROP TRIGGER reject_compaction_event");
    store.withTx(() => store.insertCheckpoint(checkpoint("changed")));
    assert.throws(() => store.withTx(() => finishCompactionRequest(store, "rollback", { status: "succeeded" }, checkpoint("wrong-old-point", "rollback"))), (error: unknown) => error instanceof StoreConflictError && error.code === "checkpoint_conflict");
    store.withTx(() => finishCompactionRequest(store, "rollback", { status: "failed", errorCode: "checkpoint_conflict" }));
    store.withTx(() => reserveCompactionRequest(store, request("committed", "changed")));
    store.withTx(() => finishCompactionRequest(store, "committed", { status: "succeeded" }, checkpoint("committed-point", "committed")));
    store.withTx(() => reserveCompactionRequest(store, request("interrupted", "committed-point")));
    db.close();
    db = new Db(root); store = new Store(db);
    assert.deepEqual(store.withTx(() => recoverCompactionRequests(store)).map(row => [row.requestId, row.status]), [["interrupted", "interrupted"]]);
    assert.equal(getCompactionRequest(store, "committed")!.status, "succeeded");
    assert.equal(store.getActiveCheckpoint("session")!.id, "committed-point");
    assert.deepEqual(store.withTx(() => recoverCompactionRequests(store)), []);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
