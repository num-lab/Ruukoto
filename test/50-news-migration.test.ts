import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";

const tables = ["schedules", "schedule_runs", "notification_ops"] as const;

function legacyDb(root: string): void {
  const db = new Db(root);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.tx(() => {
      // 独立定义真实 v17 CHECK；只降版本号会让迁移测试虚假通过。
      db.exec(`
DROP TABLE schedules;
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  owner_role TEXT NOT NULL DEFAULT 'main' CHECK (owner_role IN ('main')),
  create_key TEXT NOT NULL UNIQUE,
  params_digest TEXT NOT NULL,
  create_task_id TEXT,
  create_op_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('wake_main','notify')),
  rule TEXT NOT NULL,
  payload TEXT NOT NULL,
  target TEXT,
  approval_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','completed','canceled')),
  next_due_at TEXT,
  current_run_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  tz_data TEXT NOT NULL,
  reason TEXT NOT NULL,
  cancel_reason TEXT,
  cancel_op_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules (status, next_due_at);
ALTER TABLE schedule_runs DROP COLUMN news_result;
UPDATE meta SET value = '17' WHERE key = 'schema_version';
`);
      for (const [index, status] of ["active", "completed", "canceled"].entries()) {
        db.prepare(`INSERT INTO schedules VALUES (?, 'main', ?, 'digest-old', 'task-old', 'op-old', ?,
          '{"kind":"daily","time":"09:00","timeZone":"Asia/Shanghai"}', '{"text":"原正文"}',
          '{"channel":"mock","account":"bot","chatId":"owner","configVersion":1}', 'approval-old',
          ?, '2026-01-02T01:00:00Z', ?, 3, 'tz-old', 'reason-old', 'cancel-old', 'cancel-op-old',
          '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')`)
          .run(`schedule-${index}`, `key-${index}`, index === 0 ? "wake_main" : "notify", status, `run-${index}`);
        db.prepare(`INSERT INTO schedule_runs VALUES (?, ?, 3, '2026-01-01T01:00:00Z',
          '2026-01-01T09:00:00+08:00', '2026-01-01T02:00:00Z', 3600000,
          '2025-12-30T01:00:00Z', '2026-01-01T01:00:00Z', 'event-old', ?, ?)`)
          .run(`run-${index}`, `schedule-${index}`, `nop-${index}`, index === 0 ? null : "2026-01-01T03:00:00Z");
      }
      for (const [index, status] of ["pending", "sending", "sent", "failed", "effect_unknown", "canceled"].entries()) {
        db.prepare(`INSERT INTO notification_ops VALUES (?, 'schedule_run', ?, 'task-old', 'host-old',
          '{"channel":"mock","account":"bot","chatId":"owner","configVersion":1}', '原正文', 'digest-old',
          '[{"kind":"text","ref":"original","version":"","sha256":"source-old"}]',
          ?, 'wait-old', 'error-old', 'detail-old', 'message-old', 1, 'cancel-old', 'receipt-old',
          '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:02:00Z',
          '2026-01-01T00:03:00Z', '2026-01-01T00:04:00Z')`)
          .run(`nop-${index}`, `run-${index}`, status);
      }
    });
    db.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => db.exec("UPDATE schedules SET action = 'news'"), /CHECK constraint failed/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
}

function snapshot(db: Db | DatabaseSync) {
  return tables.map(table => ({
    rows: db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    indexes: db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? ORDER BY name").all(table),
    foreignKeys: db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
  }));
}

test("v17 → v18：保留调度计划、运行与发送事实，允许新闻动作并补空快照", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-news-migration-"));
  let db: Db | DatabaseSync | undefined;
  try {
    legacyDb(root);
    db = new DatabaseSync(path.join(root, "ruukoto.db"));
    const before = snapshot(db);
    const instance = db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get();
    db.close();
    db = undefined;
    for (let opening = 0; opening < 2; opening++) {
      db = new Db(root);
      assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
      assert.deepEqual(db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get(), instance);
      const after = snapshot(db);
      const runs = after[1]!.rows as Array<{ news_result?: unknown }>;
      for (const run of runs) {
        assert.equal(run.news_result, null);
        delete run.news_result;
      }
      assert.deepEqual(after, before);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal((db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
      assert.equal((db.prepare("PRAGMA foreign_keys").get() as any).foreign_keys, 1);
      assert.throws(() => db!.exec("DELETE FROM schedules WHERE id = 'schedule-0'"), /FOREIGN KEY constraint failed/);
      assert.throws(() => db!.exec("UPDATE schedules SET action = 'unregistered' WHERE id = 'schedule-0'"), /CHECK constraint failed/);
      db.exec("UPDATE schedules SET action = 'news' WHERE id = 'schedule-0'");
      const result = JSON.stringify({ status: "completed", items: [{ url: "https://example.org/news" }] });
      db.prepare("UPDATE schedule_runs SET news_result = ? WHERE id = 'run-0'").run(result);
      assert.equal((db.prepare("SELECT news_result FROM schedule_runs WHERE id = 'run-0'").get() as any).news_result, result);
      db.exec("UPDATE schedules SET action = 'wake_main' WHERE id = 'schedule-0'; UPDATE schedule_runs SET news_result = NULL");
      db.close();
      db = undefined;
    }
  } finally {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("新闻迁移失败时整体回滚旧 CHECK、运行列、数据与版本号", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-news-migration-rollback-"));
  let db: DatabaseSync | undefined;
  try {
    legacyDb(root);
    db = new DatabaseSync(path.join(root, "ruukoto.db"));
    const before = snapshot(db);
    db.exec(`CREATE TRIGGER reject_schema_version BEFORE UPDATE ON meta
      WHEN NEW.key = 'schema_version' AND NEW.value = '${SCHEMA_VERSION}'
      BEGIN SELECT RAISE(ABORT, 'version failure'); END`);
    db.close();
    db = undefined;
    assert.throws(() => new Db(root), /schema 迁移失败.*version failure/);
    db = new DatabaseSync(path.join(root, "ruukoto.db"));
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, "17");
    assert.deepEqual(snapshot(db), before);
    assert.throws(() => db!.exec("UPDATE schedules SET action = 'news'"), /CHECK constraint failed/);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'schedules_new'").get(), undefined);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
  } finally {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
