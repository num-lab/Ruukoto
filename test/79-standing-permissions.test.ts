/** 旧格式长期授权的持久字段、约束与拒绝升级保证；保留历史账本。 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store, StoreConflictError } from "@ruukoto/core/store.ts";
import type { NotifyTarget, StandingPermission } from "@ruukoto/core/types.ts";

// ---------- 存储层夹具：真实 SQLite（同 test/63/64 风格） ----------

const TG_TARGET: NotifyTarget = { channel: "telegram", account: "bot-a", chatId: "42", configVersion: 3 };
const QQ_TARGET: NotifyTarget = { channel: "qq_private", account: "80001", chatId: "880001", configVersion: 2 };
const MACHINE = "fake-machine-0001";
const REV = "a".repeat(64);

function storeKit(prefix: string): { root: string; db: Db; store: Store; sessionId: string; projectId: string; close(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ruukoto-sp-${prefix}-`));
  const db = new Db(root);
  const store = new Store(db);
  const project = store.createProject("p");
  const stat = fs.statSync(root);
  const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "pi-1", confirmTools: [] });
  return {
    root,
    db,
    store,
    projectId: project.id,
    sessionId: session.id,
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function grantInput(k: { sessionId: string; projectId: string }, over: Partial<Parameters<Store["createStandingPermission"]>[0]> = {}): Parameters<Store["createStandingPermission"]>[0] {
  return {
    sessionId: k.sessionId,
    projectId: k.projectId,
    machineId: MACHINE,
    unit: "svc-a.service",
    action: "restart",
    policyRevision: REV,
    unitRevision: "b".repeat(64),
    channel: "telegram",
    account: "bot-a",
    chatId: "42",
    actor: "telegram:42",
    pinnedTarget: TG_TARGET,
    approvalId: `conf_${randomBytes(12).toString("hex")}`,
    createdByEventId: `evt_${randomBytes(12).toString("hex")}`,
    ...over,
  };
}

test("存储层：创建/版本化/条件撤销幂等；事件与关联记录落盘", () => {
  const k = storeKit("basic");
  try {
    const store = k.store;
    store.withTx(() => store.createStandingPermission(grantInput(k)));
    const list = store.listStandingPermissionsPaged();
    assert.equal(list.items.length, 1);
    const sp = list.items[0]!;
    assert.equal(sp.version, 1);
    assert.equal(sp.revokedAt, null);
    assert.match(sp.id, /^sp_/);
    assert.equal(sp.unit, "svc-a.service");
    assert.equal(sp.pinnedTarget.configVersion, 3);

    // 候选查询命中（完整入口稳定身份 + 目标）
    const candidate = store.findStandingCandidate({
      sessionId: k.sessionId, channel: "telegram", account: "bot-a", chatId: "42", actor: "telegram:42",
      machineId: MACHINE, unit: "svc-a.service", action: "restart",
    });
    assert.equal(candidate?.id, sp.id);
    // 任一身份维度不符即无候选（跨平台/改账号/改 actor 不继承）
    for (const patch of [{ channel: "qq_private" }, { account: "other" }, { chatId: "999" }, { actor: "telegram:43" }] as const) {
      assert.equal(store.findStandingCandidate({ sessionId: k.sessionId, channel: "telegram", account: "bot-a", chatId: "42", actor: "telegram:42", machineId: MACHINE, unit: "svc-a.service", action: "restart", ...patch }), null);
    }

    // 版本错误：撤销不得生效（条件更新）
    assert.throws(
      () => store.withTx(() => store.revokeStandingPermission(sp.id, 99)),
      (err: Error) => err instanceof StoreConflictError && (err as StoreConflictError).code === "version_conflict",
    );
    assert.equal(store.getStandingPermission(sp.id)!.revokedAt, null);

    // 正确版本撤销：版本递增、保留记录；重复撤销幂等（不再变更、无重复事件）
    const first = store.withTx(() => store.revokeStandingPermission(sp.id, 1));
    assert.equal(first.changed, true);
    assert.equal(first.permission.version, 2);
    assert.ok(first.permission.revokedAt);
    assert.equal(first.permission.revokedReason, "owner_revoked");
    const again = store.withTx(() => store.revokeStandingPermission(sp.id, 2));
    assert.equal(again.changed, false);
    assert.equal(store.getStandingPermission(sp.id)!.version, 2, "重复撤销不再次变更");
    assert.equal(store.findStandingCandidate({
      sessionId: k.sessionId, channel: "telegram", account: "bot-a", chatId: "42", actor: "telegram:42",
      machineId: MACHINE, unit: "svc-a.service", action: "restart",
    }), null, "撤销后无候选");

    const events = store.getEventsAfter(0, 100).map((e) => e.body.type);
    assert.equal(events.filter((t) => t === "standing_permission.created").length, 1);
    assert.equal(events.filter((t) => t === "standing_permission.revoked").length, 1);
    const revoked = store.getEventsAfter(0, 100).find((e) => e.body.type === "standing_permission.revoked")!.body as any;
    assert.equal(revoked.version, 2);
    assert.equal(revoked.reason, "owner_revoked");
  } finally {
    k.close();
  }
});

test("存储层：同目标重复与同一来源审批都不得重复保存；撤销后可重建（旧授权不复活）", () => {
  const k = storeKit("unique");
  try {
    const store = k.store;
    store.withTx(() => store.createStandingPermission(grantInput(k, { approvalId: "conf_a" })));
    // 同目标第二条（即使入口或修订不同）：未撤销唯一约束拒绝
    assert.throws(
      () => store.withTx(() => store.createStandingPermission(grantInput(k, { approvalId: "conf_b", policyRevision: "c".repeat(64) }))),
      (err: Error) => err instanceof StoreConflictError && (err as StoreConflictError).code === "duplicate",
    );
    store.withTx(() => store.revokeStandingPermission(store.findStandingCandidate({
      sessionId: k.sessionId, channel: "telegram", account: "bot-a", chatId: "42", actor: "telegram:42",
      machineId: MACHINE, unit: "svc-a.service", action: "restart",
    })!.id, 1));
    // 已撤销后可重建（新授权独立版本）；旧授权行保留且不复活
    store.withTx(() => store.createStandingPermission(grantInput(k, { approvalId: "conf_c" })));
    const all = store.listStandingPermissionsPaged().items;
    assert.equal(all.length, 2);
    assert.equal(all.filter((p) => p.revokedAt === null).length, 1);
    assert.equal(all.find((p) => p.revokedAt === null)!.approvalId, "conf_c");
    // 来源审批唯一：旧审批 ID 不能重新建授权
    assert.throws(
      () => store.withTx(() => store.createStandingPermission(grantInput(k, { approvalId: "conf_a", unit: "svc-b.service" }))),
      (err: Error) => err instanceof StoreConflictError && (err as StoreConflictError).code === "duplicate",
    );
    // 其他入口（QQ）的同目标授权互不影响；另一单元/机器独立计数
    store.withTx(() => store.createStandingPermission(grantInput(k, { channel: "qq_private", account: "80001", chatId: "880001", actor: "qq_private:880001", pinnedTarget: QQ_TARGET, approvalId: "conf_qq" })));
    assert.ok(store.findStandingCandidate({ sessionId: k.sessionId, channel: "qq_private", account: "80001", chatId: "880001", actor: "qq_private:880001", machineId: MACHINE, unit: "svc-a.service", action: "restart" }));
  } finally {
    k.close();
  }
});

test("存储层：effect_unknown 定向失效扩散到同 main、本机、单元、动作的所有入口；其他服务不受影响", () => {
  const k = storeKit("unknown");
  try {
    const store = k.store;
    store.withTx(() => store.createStandingPermission(grantInput(k, { approvalId: "conf_tg" })));
    store.withTx(() => store.createStandingPermission(grantInput(k, { channel: "qq_private", account: "80001", chatId: "880001", actor: "qq_private:880001", pinnedTarget: QQ_TARGET, approvalId: "conf_qq" })));
    store.withTx(() => store.createStandingPermission(grantInput(k, { unit: "svc-b.service", approvalId: "conf_b", pinnedTarget: { ...TG_TARGET, configVersion: 4 } })));
    const invalidated = store.withTx(() =>
      store.invalidateStandingForTarget({ sessionId: k.sessionId, machineId: MACHINE, unit: "svc-a.service", action: "restart", opId: "op_dead" }),
    );
    assert.equal(invalidated.length, 2, "两平台的同目标授权一并失效");
    const items = store.listStandingPermissionsPaged().items;
    for (const sp of items) {
      if (sp.unit === "svc-a.service") {
        assert.ok(sp.revokedAt, `${sp.id} 已失效`);
        assert.equal(sp.revokedReason, "effect_unknown");
        assert.equal(sp.version, 2);
      } else {
        assert.equal(sp.revokedAt, null, "其他服务授权不受影响");
      }
    }
    const revokedEvents = store.getEventsAfter(0, 200).filter((e) => e.body.type === "standing_permission.revoked").map((e) => e.body as any);
    assert.equal(revokedEvents.length, 2);
    assert.ok(revokedEvents.every((b) => b.opId === "op_dead"), "失效事件携带触发操作 ID");
    // 再次定向失效：无有效授权，零事件
    const again = store.withTx(() => store.invalidateStandingForTarget({ sessionId: k.sessionId, machineId: MACHINE, unit: "svc-a.service", action: "restart", opId: "op_dead2" }));
    assert.equal(again.length, 0);
  } finally {
    k.close();
  }
});

test("存储层：分页有界、游标校验；按入口过滤；授权使用记录关联查询", () => {
  const k = storeKit("paged");
  try {
    const store = k.store;
    const { task } = store.insertQueuedTask({
      sessionId: k.sessionId, requestId: "r1", input: "t",
      modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "r1",
    });
    let first: StandingPermission | null = null;
    for (let i = 0; i < 3; i++) {
      first = store.withTx(() => store.createStandingPermission(grantInput(k, { unit: `svc-${i}.service`, approvalId: `conf_${i}` })));
      store.withTx(() => {
        const c = store.insertApprovedConfirmation({
          taskId: task.id, sessionId: k.sessionId, toolOpId: `op_${i}${"0".repeat(23)}`, toolName: "service_manage",
          params: { unit: `svc-${i}.service` }, scope: { kind: "service_operation", machineId: MACHINE, unit: `svc-${i}.service`, action: "restart", policyRevision: REV, unitRevision: "b".repeat(64), taskId: task.id, toolOpId: `op_${i}${"0".repeat(23)}` },
          permissionVersion: 1, standingPermissionId: first!.id, standingPermissionVersion: 1,
        });
        assert.equal(c.status, "approved");
        assert.equal(c.decisionSource, "standing_permission");
        assert.equal(c.standingPermissionId, first!.id);
      });
    }
    const page1 = store.listStandingPermissionsPaged({ limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.hasMore, true);
    const page2 = store.listStandingPermissionsPaged({ limit: 2, before: page1.items[1]!.id });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.hasMore, false);
    assert.throws(() => store.listStandingPermissionsPaged({ before: "sp_none" }), StoreConflictError);
    const filtered = store.listStandingPermissionsPaged({ channel: "qq_private", account: "80001", chatId: "880001", actor: "qq_private:880001" });
    assert.equal(filtered.items.length, 0, "无关入口过滤为空");
    const usages = store.listConfirmationsByStanding(first!.id);
    assert.equal(usages.length, 1);
    assert.equal(usages[0]!.toolName, "service_manage");
  } finally {
    k.close();
  }
});

test("旧服务授权 schema 明确拒绝启动，旧批准与外发事实保留原样", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-sp-migrate-"));
  const old = new DatabaseSync(path.join(root, "ruukoto.db"));
  // 独立定义 v22 必需对象（沿用 test/43 风格，防当前 schema 放宽使迁移虚假通过）
  old.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '22'), ('instance_id', 'sp-keep-instance');
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'dev' CHECK (kind IN ('dev','qq_group')),
  cwd TEXT NOT NULL, cwd_real TEXT NOT NULL, cwd_dev INTEGER NOT NULL, cwd_ino INTEGER NOT NULL,
  pi_session_id TEXT NOT NULL, session_file TEXT, confirm_tools TEXT NOT NULL DEFAULT '[]',
  queue_state TEXT NOT NULL DEFAULT 'active' CHECK (queue_state IN ('active','paused')),
  queue_pause_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
  input TEXT NOT NULL, status TEXT NOT NULL, access_mode TEXT NOT NULL DEFAULT 'confirm',
  permission_version INTEGER NOT NULL DEFAULT 1, granted_paths TEXT NOT NULL DEFAULT '[]',
  pending_access_mode TEXT, interrupt_reason TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  effect_unknown INTEGER NOT NULL DEFAULT 0, error_message TEXT, history_entry_ids TEXT NOT NULL DEFAULT '[]',
  resumes_task_id TEXT, agent_id TEXT, parent_task_id TEXT, source_event_id TEXT, deadline TEXT,
  result_summary TEXT, result_ref TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  UNIQUE (session_id, request_id)
);
CREATE TABLE confirmations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL,
  tool_op_id TEXT NOT NULL, tool_name TEXT NOT NULL, params TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{"kind":"tool","workspaceOnly":true}',
  cwd_dev INTEGER NOT NULL DEFAULT 0, cwd_ino INTEGER NOT NULL DEFAULT 0,
  permission_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','stale')),
  created_at TEXT NOT NULL, responded_at TEXT, consumed_at TEXT,
  review_status TEXT, review_decision TEXT, review_reason TEXT, review_model TEXT,
  review_policy_version TEXT, decision_source TEXT
);
CREATE TABLE tool_ops (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), tool_name TEXT NOT NULL,
  sdk_call_id TEXT, params TEXT NOT NULL, intent_recorded_at TEXT NOT NULL,
  result_summary TEXT, is_error INTEGER, effect_unknown INTEGER NOT NULL DEFAULT 0, recorded_result_at TEXT
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT NOT NULL,
  name TEXT NOT NULL, byte_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'partial' CHECK (status IN ('partial','complete')), created_at TEXT NOT NULL
);
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, session_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE inbound_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, actor TEXT,
  target_role TEXT NOT NULL CHECK (target_role IN ('main','coding','chat')), body TEXT NOT NULL,
  artifact_refs TEXT NOT NULL DEFAULT '[]', reply_target TEXT, received_at TEXT NOT NULL,
  event_kind TEXT NOT NULL DEFAULT 'task' CHECK (event_kind IN ('task','im_approval')),
  status TEXT NOT NULL CHECK (status IN ('registered','queued','done','failed')),
  task_id TEXT, UNIQUE (source, external_id)
);
CREATE TABLE notification_ops (
  id TEXT PRIMARY KEY, source_kind TEXT NOT NULL CHECK (source_kind IN ('schedule_run','confirmation','owner_reply','inbound_event')),
  source_key TEXT NOT NULL, task_id TEXT, host_op_id TEXT, target TEXT NOT NULL, text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL, source_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','effect_unknown','canceled')),
  wait_reason TEXT, error_kind TEXT, error_message TEXT, platform_message_id TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0, cancel_op_id TEXT, late_receipt TEXT,
  created_at TEXT NOT NULL, sending_at TEXT, settled_at TEXT, updated_at TEXT NOT NULL, not_before TEXT,
  UNIQUE (source_kind, source_key)
);
INSERT INTO projects VALUES ('proj-old', 'old-proj', '2026-01-01T00:00:00Z');
INSERT INTO sessions (id, project_id, cwd, cwd_real, cwd_dev, cwd_ino, pi_session_id, created_at)
  VALUES ('sess-old', 'proj-old', '/tmp/x', '/tmp/x', 1, 1, 'pi-old', '2026-01-01T00:00:00Z');
INSERT INTO tasks (id, session_id, request_id, input, status, created_at)
  VALUES ('task-old', 'sess-old', 'req-old', '旧任务', 'completed', '2026-01-01T00:00:00Z');
INSERT INTO confirmations (id, task_id, session_id, tool_op_id, tool_name, params, status, created_at, responded_at, consumed_at, decision_source)
  VALUES ('conf-old', 'task-old', 'sess-old', 'op-old', 'service_manage', '{}', 'approved', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:01:30Z', 'owner');
INSERT INTO tool_ops VALUES ('op-old', 'task-old', 'service_manage', 'sdk-old', '{}', '2026-01-01T00:00:00Z', 'done', 0, 0, '2026-01-01T00:02:00Z');
INSERT INTO artifacts VALUES ('art-old', 'task-old', 'sess-old', 'service-restart:x', 128, 'complete', '2026-01-01T00:00:00Z');
INSERT INTO inbound_events (id, source, external_id, actor, target_role, body, received_at, status)
  VALUES ('evt-old', 'telegram', 'tg:42:1', 'telegram:42', 'main', '/approvals', '2026-01-01T00:00:00Z', 'done');
INSERT INTO notification_ops (id, source_kind, source_key, target, text, text_sha256, status, created_at, updated_at)
  VALUES ('nop-old', 'inbound_event', 'evt-old', '{"channel":"telegram","account":"bot","chatId":"42","configVersion":1}', '回执', 'sha-old', 'sent', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z');
`);
  old.close();
  try {
    assert.throws(() => new Db(root), { code: "schema_version_unsupported" });
    const db = new DatabaseSync(path.join(root, "ruukoto.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, "22");
    assert.equal(db.prepare("SELECT status FROM confirmations WHERE id = 'conf-old'").get()!.status, "approved");
    assert.equal(db.prepare("SELECT status FROM notification_ops WHERE id = 'nop-old'").get()!.status, "sent");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
