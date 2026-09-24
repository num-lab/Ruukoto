import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { NotifyTarget } from "../src/core/types.ts";
import { SchedulerStore } from "../src/scheduler/store.ts";

const target: NotifyTarget = { channel: "mock", account: "bot", chatId: "owner", configVersion: 1 };

test("v15 → v16：保留通知的全部发送事实、索引与唯一键，重复打开不改写", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-inbound-migration-"));
  const old = new DatabaseSync(path.join(root, "ruukoto.db"));
  // 独立定义旧结构，防止当前 schema 已放宽 CHECK 使迁移测试虚假通过。
  old.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '15'), ('instance_id', 'keep-instance');
CREATE TABLE notification_ops (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('schedule_run','confirmation','owner_reply')),
  source_key TEXT NOT NULL,
  task_id TEXT,
  host_op_id TEXT,
  target TEXT NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','effect_unknown','canceled')),
  wait_reason TEXT,
  error_kind TEXT,
  error_message TEXT,
  platform_message_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_op_id TEXT,
  late_receipt TEXT,
  created_at TEXT NOT NULL,
  sending_at TEXT,
  settled_at TEXT,
  updated_at TEXT NOT NULL,
  not_before TEXT,
  UNIQUE (source_kind, source_key)
);
CREATE INDEX idx_notification_ops_status ON notification_ops (status, created_at);
CREATE INDEX idx_notification_ops_task ON notification_ops (task_id);
`);
  const statuses = ["pending", "sending", "sent", "failed", "effect_unknown", "canceled"];
  for (const [index, status] of statuses.entries()) {
    old.prepare(`INSERT INTO notification_ops VALUES (?, ?, ?, 'task-old', 'host-old', ?, '原正文',
      'digest-old', '[{"kind":"text","ref":"original","version":"","sha256":"source-old"}]',
      ?, 'wait-old', 'error-old', 'detail-old', 'message-old', 1, 'cancel-old', 'receipt-old',
      '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:02:00Z',
      '2026-01-01T00:03:00Z', '2026-01-01T00:04:00Z')`)
      .run(`nop-${index}`, ["schedule_run", "confirmation", "owner_reply"][index % 3]!, `key-${index}`, JSON.stringify(target), status);
  }
  const before = old.prepare("SELECT * FROM notification_ops ORDER BY id").all();
  const indexes = old.prepare("PRAGMA index_list(notification_ops)").all();
  old.close();
  let db: Db | undefined;
  try {
    for (let opening = 0; opening < 2; opening++) {
      db = new Db(root);
      assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
      assert.equal(db.getInstanceId(), "keep-instance");
      assert.deepEqual(db.prepare("SELECT * FROM notification_ops ORDER BY id").all(), before);
      assert.deepEqual(db.prepare("PRAGMA index_list(notification_ops)").all(), indexes);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(() => db!.exec(`INSERT INTO notification_ops
        (id, source_kind, source_key, target, text, text_sha256, status, created_at, updated_at)
        SELECT 'nop-duplicate', source_kind, source_key, target, text, text_sha256, status, created_at, updated_at
        FROM notification_ops WHERE id = 'nop-0'`), /UNIQUE constraint failed: notification_ops.source_kind, notification_ops.source_key/);
      db.close();
      db = undefined;
    }
    db = new Db(root);
    const store = new Store(db);
    const sched = new SchedulerStore(store);
    const { op } = store.withTx(() => sched.insertOp({ sourceKind: "inbound_event", sourceKey: "evt-new", taskId: null, hostOpId: null, target, text: "评审摘要", sourceRefs: [] }));
    assert.equal(op.sourceKind, "inbound_event");
    assert.equal(sched.listOps({}).items.length, statuses.length + 1);
    assert.throws(() => db!.prepare("UPDATE notification_ops SET source_kind = 'unregistered' WHERE id = ?").run(op.id), /CHECK constraint failed/);
  } finally {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("入站事件通知：同键幂等、异参冲突，发送结果未知后不重新领取", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-inbound-outbox-"));
  const db = new Db(root);
  const store = new Store(db);
  const sched = new SchedulerStore(store);
  const input = { sourceKind: "inbound_event" as const, sourceKey: "evt-review", taskId: "task-summary", hostOpId: null, target, text: "评审摘要", sourceRefs: [] };
  try {
    const first = store.withTx(() => sched.insertOp(input));
    assert.equal(first.created, true);
    const seq = store.getMaxSeq();
    const repeated = store.withTx(() => sched.insertOp(input));
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.op, first.op);
    assert.equal(store.getMaxSeq(), seq);
    assert.throws(() => store.withTx(() => sched.insertOp({ ...input, text: "替换摘要" })), { code: "request_conflict" });
    assert.throws(() => store.withTx(() => sched.insertOp({ ...input, target: { ...target, configVersion: 2 } })), { code: "request_conflict" });
    assert.equal(store.withTx(() => sched.claim(first.op.id)), true);
    assert.equal(store.withTx(() => sched.claim(first.op.id)), false);
    assert.equal(store.withTx(() => sched.markSendingUnknown()), 1);
    assert.equal(store.withTx(() => sched.markSendingUnknown()), 0);
    const afterRestart = store.withTx(() => sched.insertOp(input));
    assert.equal(afterRestart.created, false);
    assert.equal(afterRestart.op.id, first.op.id);
    assert.equal(afterRestart.op.status, "effect_unknown");
    assert.equal(store.withTx(() => sched.claim(first.op.id)), false);
    assert.deepEqual(sched.listPending(new Date().toISOString(), 10), []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
