/**
 * agent-direction issue 10：保存、使用和撤销限定的长期操作授权（standing permissions）。
 *
 * 证据分类：本文件全部是离线证据——模拟 IM 平台（回环 OneBot + FakeBotApi）+
 * 受控 helper 替身（test/helpers/fake-service-helper.mjs）+ 真实 Runtime/SQLite。
 * 真实 systemd/提权/sudoers 与真实 QQ/Telegram 证据见
 * .agents/scratch/agent-direction/smoke-10-standing-permissions.mts（另案在真实 Linux 执行）。
 *
 * 覆盖（对应工单验证与验收清单）：
 * - 存储层：创建/版本化/条件撤销幂等/唯一约束（同目标唯一、来源审批唯一）/候选
 *   与分页/使用记录/effect-unknown 定向失效扩散到所有入口；
 * - 迁移 v22 → v23：不产生任何授权、旧批准关联列为空、旧审批/产物/入站/outbox 可读；
 * - 闸门+服务工具模块级：命中授权零等待零通知、running 直接执行、独立批准记录与
 *   事件（新 taskId/hostOpId）、撤销/版本变化/修订不符回落人工；消费后无可信结果
 *   （协议错误/应答不符/产物失败）标效果未知并使授权失效；
 * - IM 双平台端到端：/approve-standing 保存+批准本次 → 另一独立任务命中执行一次 →
 *   /service-grants、/service-grant 查看 → /revoke-service-grant 撤销 → 下一次恢复
 *   人工审批；身份/自然语言/群消息/引用不建授权；重投与版本/ID 边界；跨平台不继承；
 *   TUI 提交不继承；入口绑定变化使授权失效；效果未知使该目标授权全部失效；后台重启
 *   保留有效授权但不恢复旧待批；
 * - 控制面/CLI：已认证 list/get/revoke；协议版本不符明确拒绝。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store, StoreConflictError } from "../src/core/store.ts";
import type { NotifyTarget, StandingPermission } from "../src/core/types.ts";

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

test("迁移 v22 → v23：不产生任何授权、旧批准关联列为空、旧审批/产物/入站/outbox 仍可读取", () => {
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
    const db = new Db(root);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
    assert.equal(db.getInstanceId(), "sp-keep-instance");
    const store = new Store(db);
    // 迁移不产生任何授权
    assert.equal(store.listStandingPermissionsPaged().items.length, 0);
    // 旧批准可读、事实不变、关联列为空（不转成长期授权）
    const conf = store.getConfirmation("conf-old")!;
    assert.equal(conf.status, "approved");
    assert.equal(conf.decisionSource, "owner");
    assert.equal(conf.standingPermissionId, null);
    assert.equal(conf.standingPermissionVersion, null);
    assert.ok(conf.consumedAt);
    // 旧产物/工具操作/入站/outbox 仍可读取
    assert.equal(store.getArtifact("art-old")!.status, "complete");
    assert.equal(store.getToolOp("op-old")!.toolName, "service_manage");
    assert.equal(store.findInboundEvent("telegram", "tg:42:1")!.status, "done");
    assert.equal((db.prepare("SELECT status FROM notification_ops WHERE id = 'nop-old'").get() as any).status, "sent");
    // 旧事件与外键完整
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    // 不存在的授权操作是明确拒绝（而不是空成功）
    assert.throws(() => store.withTx(() => store.revokeStandingPermission("sp_none", 1)), StoreConflictError);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ==================================================================
// 模块级：闸门窄路径 + 服务工具消费后分类（模式参考 test/78 moduleKit）
// ==================================================================

import { createHash } from "node:crypto";
import { createServiceTools, type ServiceToolsDeps } from "../src/agent/service-tools.ts";
import type { HostToolContext } from "../src/agent/host-tools.ts";
import { ApprovalGate } from "../src/agent/approval-gate.ts";
import type { ApprovalRequest } from "../src/agent/approval-gate.ts";
import { ToolOpLedger } from "../src/agent/tool-op-ledger.ts";
import { ArtifactStore } from "../src/agent/artifacts.ts";
import { createManagedProcessRegistry } from "../src/agent/managed-processes.ts";
import { waitFor } from "./helpers/testkit.ts";

const UNIT = "ruukoto-service-test.service";

interface FakeSvc {
  dir: string;
  helperPath: string;
  policyPath: string;
  starts(): number;
  calls(): string[][];
  restarts(): string[][];
  touch(name: string, content?: string): void;
}

function setupFakeService(root: string): FakeSvc {
  const dir = fs.mkdtempSync(path.join(root, "fake-svc-"));
  fs.copyFileSync(new URL("./helpers/fake-service-helper.mjs", import.meta.url), path.join(dir, "fake-service-helper.mjs"));
  fs.mkdirSync(path.join(dir, "units"));
  fs.mkdirSync(path.join(dir, "ops"));
  const policyPath = path.join(dir, "services.json");
  fs.writeFileSync(policyPath, JSON.stringify({ machineId: MACHINE, execUid: 1, execGid: 1, services: { [UNIT]: { actions: ["restart"] } } }));
  fs.writeFileSync(path.join(dir, "units", UNIT), "[Service]\nExecStart=/usr/bin/true\n");
  const stateOf = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as Record<string, any>;
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    [UNIT]: { loadState: "loaded", activeState: "active", subState: "running", mainPid: 1234, invocationId: "inv-initial-1", result: "success", activeEnterTimestamp: "2026-10-03T00:00:00Z", starts: 1 },
  }));
  const calls = (): string[][] => {
    try {
      return fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return {
    dir,
    helperPath: path.join(dir, "fake-service-helper.mjs"),
    policyPath,
    starts: () => Number(stateOf()[UNIT].starts),
    calls,
    restarts: () => calls().filter((c) => c[0] === "restart"),
    touch: (name, content = "") => fs.writeFileSync(path.join(dir, name), content),
  };
}

const ENTRY = { channel: "telegram", account: "bot-a", chatId: "42", actor: "telegram:42" };

interface ModuleKit {
  svc: FakeSvc;
  store: Store;
  gate: ApprovalGate;
  taskId: string;
  /** 建一条针对默认单元/真实修订的长期授权（范围自测真伪由断言承担）。 */
  createStanding(over?: Partial<Parameters<Store["createStandingPermission"]>[0]>): StandingPermission;
  call(name: string, params: Record<string, unknown>): Promise<any>;
  pendingConf(taskId?: string): Promise<any>;
  setApprovalImpl(fn: (input: ApprovalRequest<unknown>) => Promise<any>): void;
  setCandidateImpl(fn: (task: any, scope: any) => { id: string; version: number } | null): void;
  setStandingImpl(fn: (input: ApprovalRequest<unknown>) => any): void;
  failArtifactAppend(v: boolean): void;
  close(): void;
}

function moduleKit(prefix: string): ModuleKit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ruukoto-sp-mod-${prefix}-`));
  const svc = setupFakeService(root);
  const db = new Db(root);
  const store = new Store(db);
  const ledger = new ToolOpLedger(store);
  // 替身策略的真实修订（与 helper 同名算法：policy = sha256(services.json)）
  const policyRevision = () => createHash("sha256").update(fs.readFileSync(svc.policyPath)).digest("hex");
  let candidateImpl: (task: any, scope: any) => { id: string; version: number } | null = (task, scope) => {
    // 与 Runtime.standingCandidate 等价的检索口径（入口身份钉版固定；真实运行时另查
    // IM 来源事件与钉版目标，端到端测试覆盖那一层）
    const sp = store.findStandingCandidate({
      sessionId: task.sessionId,
      ...ENTRY,
      machineId: scope.machineId,
      unit: scope.unit,
      action: "restart",
    });
    return sp ? { id: sp.id, version: sp.version } : null;
  };
  const gate = new ApprovalGate({ store, ledger, reviewer: () => undefined, standingCandidate: (task, scope) => candidateImpl(task, scope) });
  const artifacts = new ArtifactStore(root, store);
  const registry = createManagedProcessRegistry();
  const project = store.createProject("p");
  const stat = fs.statSync(root);
  const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "pi-1", confirmTools: [] });
  const { task } = store.insertQueuedTask({
    sessionId: session.id,
    requestId: "r1",
    input: "svc 模块测试",
    modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" },
    submissionDigest: "r1",
  });
  store.transitionTask(task.id, ["queued"], "running", {});
  let ctx: HostToolContext = { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId: "" };
  let approvalImpl: (input: any) => Promise<any> = (input) => gate.request(input);
  let standingImpl: (input: any) => any = (input) => gate.requestStanding(input);
  let failAppend = false;
  const deps: ServiceToolsDeps = {
    coreStore: store,
    artifacts: new Proxy(artifacts, {
      get(target, prop) {
        if (prop === "append" && failAppend) return () => { throw new Error("注入：产物写入失败"); };
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    registry,
    config: { helperPath: svc.helperPath, policyPath: svc.policyPath, useSudo: false, sudoPath: "", timeouts: { inspectMs: 5_000, restartMs: 10_000, stopMs: 2_500 } },
    taskContext: () => ctx,
    verifyMain: () => null,
    requestApproval: (input) => approvalImpl(input),
    requestStanding: (input) => standingImpl(input),
    recordArtifact: () => {},
    markEffectUnknown: (opId) => {
      store.withTx(() => ledger.markEffectUnknown({ id: ctx.taskId, sessionId: ctx.sessionId }, opId));
    },
  };
  const tools = createServiceTools(deps);
  return {
    svc,
    store,
    gate,
    taskId: task.id,
    createStanding(over = {}) {
      const unitDef = fs.readFileSync(path.join(svc.dir, "units", UNIT));
      return store.withTx(() =>
        store.createStandingPermission({
          sessionId: session.id,
          projectId: project.id,
          machineId: MACHINE,
          unit: UNIT,
          action: "restart",
          policyRevision: policyRevision(),
          unitRevision: createHash("sha256").update(unitDef).digest("hex"),
          ...ENTRY,
          pinnedTarget: TG_TARGET,
          approvalId: `conf_src_${randomBytes(8).toString("hex")}`,
          createdByEventId: `evt_src_${randomBytes(8).toString("hex")}`,
          ...over,
        }),
      );
    },
    async call(name, params) {
      ctx = { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId: `op_${randomBytes(12).toString("hex")}` };
      store.recordToolIntent({ id: ctx.hostOpId, taskId: task.id, sessionId: session.id, toolName: name, params });
      return await tools.find((t) => t.name === name)!.execute(ctx.hostOpId, params, undefined, undefined, {} as any);
    },
    async pendingConf(taskId = task.id) {
      let found: any = null;
      await waitFor("模块级待审批", () => (found = store.listConfirmationsByTask(taskId).find((c) => c.status === "pending") ?? null) !== null);
      return found;
    },
    setApprovalImpl(fn) {
      approvalImpl = fn;
    },
    setCandidateImpl(fn) {
      candidateImpl = fn;
    },
    setStandingImpl(fn) {
      standingImpl = fn;
    },
    failArtifactAppend(v) {
      failAppend = v;
    },
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const taskEvents = (k: ModuleKit, type: string): any[] => k.store.getTaskEventsAfter(k.taskId, 0, 1000).filter((e) => e.body.type === type).map((e) => e.body);

test("模块级：命中有效授权——零等待零通知、running 直接执行一次、独立已批准记录与事件；授权本身不被消费", async () => {
  const k = moduleKit("hit");
  try {
    const sp = k.createStanding();
    const result = await k.call("service_manage", { unit: UNIT, action: "restart" });
    const text = textOf(result);
    assert.ok(text.includes("管理命令结果"), text);
    assert.ok(text.includes(`授权依据：长期授权 ${sp.id} v1`), text);
    assert.equal(k.svc.starts(), 2, "恰好执行一次");
    assert.equal(k.svc.restarts().length, 1);
    // 零等待：无 pending 审批、无 awaiting 事件、任务保持 running
    assert.equal(k.store.listConfirmationsByStatus("pending").length, 0);
    assert.equal(taskEvents(k, "task.awaiting_confirmation").length, 0);
    assert.equal(k.store.getTask(k.taskId)!.status, "running");
    assert.equal(taskEvents(k, "task.confirmation_reviewed").length, 0, "不启动自动审查");
    // 独立的已批准记录（新审批 ID；decisionSource + 授权关联；与授权打印核实）
    const confs = k.store.listConfirmationsByTask(k.taskId);
    assert.equal(confs.length, 1);
    const conf = confs[0]!;
    assert.notEqual(conf.id, sp.approvalId, "使用记录是与来源审批独立的审批 ID");
    assert.equal(conf.status, "approved");
    assert.equal(conf.decisionSource, "standing_permission");
    assert.equal(conf.standingPermissionId, sp.id);
    assert.equal(conf.standingPermissionVersion, 1);
    assert.ok(conf.consumedAt, "本次批准已单次消费");
    // 长期授权本身不被消费（版本与记录不变）
    assert.equal(k.store.getStandingPermission(sp.id)!.version, 1);
    assert.equal(k.store.getStandingPermission(sp.id)!.revokedAt, null);
    // 事件（决定与消费各一条，均携带授权 ID/版本）
    const resolved = taskEvents(k, "task.confirmation_resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].source, "standing_permission");
    assert.equal(resolved[0].standingPermissionId, sp.id);
    const consumed = taskEvents(k, "task.approval_consumed");
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0].standingPermissionId, sp.id);
    assert.equal(consumed[0].standingPermissionVersion, 1);
    // 授权视角的使用记录
    const usages = k.store.listConfirmationsByStanding(sp.id);
    assert.equal(usages.length, 1);
    assert.equal(usages[0]!.id, conf.id);
  } finally {
    k.close();
  }
});

test("模块级：无候选 → 照常人工逐次审批（不含授权字段与事件）", async () => {
  const k = moduleKit("none");
  try {
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    assert.equal(conf.decisionSource, null);
    assert.equal(conf.standingPermissionId, null);
    assert.equal(taskEvents(k, "task.awaiting_confirmation").length, 1, "等待事件照常发布");
    assert.equal(k.store.getTask(k.taskId)!.status, "awaiting_confirmation");
    k.gate.resolve(conf.id, "approved");
    const result = await exec;
    assert.ok(textOf(result).includes("管理命令结果"));
    assert.equal(k.svc.starts(), 2);
    const resolved = taskEvents(k, "task.confirmation_resolved");
    assert.equal(resolved[0].source, "owner");
  } finally {
    k.close();
  }
});

test("模块级：候选读取后撤销/版本变化——消费事务重读拦截，回落人工路径重新判定", async () => {
  const k = moduleKit("revoked");
  try {
    const sp = k.createStanding();
    // 候选核实后、消费事务前的窗口：候选函数返回旧版本（撤销先提交）
    k.setCandidateImpl(() => {
      k.store.withTx(() => k.store.revokeStandingPermission(sp.id, 1));
      return { id: sp.id, version: 1 };
    });
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    assert.equal(k.svc.starts(), 1, "撤销后不再自动放行");
    assert.equal(taskEvents(k, "task.approval_consumed").length, 0, "未留下半成品的授权使用");
    assert.equal(conf.decisionSource, null, "回落后是全新的单次审批");
    k.gate.resolve(conf.id, "approved");
    const result = await exec;
    assert.ok(textOf(result).includes("管理命令结果"));
    assert.equal(k.svc.starts(), 2, "人工重新批准后照常执行");
  } finally {
    k.close();
  }
});

test("模块级：范围修订不符——消费事务内复核拒绝旧授权并回落人工，不留半成品记录", async () => {
  const k = moduleKit("rev-mismatch");
  try {
    // 授权范围绑定的是旧修订；照顾真实运行时之外的窄路径兜底（候选函数不查修订）
    k.createStanding({ policyRevision: "f".repeat(64) });
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    assert.equal(k.svc.starts(), 1);
    const confs = k.store.listConfirmationsByTask(k.taskId);
    assert.equal(confs.length, 1, "窄路径未创建半成品批准记录");
    assert.equal(confs[0]!.id, conf.id);
    assert.equal(confs[0]!.standingPermissionId, null);
    k.gate.resolve(conf.id, "approved");
    await exec;
    assert.equal(k.svc.starts(), 2);
  } finally {
    k.close();
  }
});

test("模块级：任务取消意图先提交——不再自动放行，回落人工", async () => {
  const k = moduleKit("cancel-intent");
  try {
    k.createStanding();
    k.store.setCancelRequested(k.taskId, true);
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    assert.equal(k.svc.starts(), 1);
    // 取消意图下的人工批准照常可用（批准即放弃取消——当前既有语义）
    k.gate.resolve(conf.id, "approved");
    await exec;
    assert.equal(k.svc.starts(), 2);
  } finally {
    k.close();
  }
});

test("模块级：/approve-standing 联动——决定/关联/授权同事务；授权撤销后当前批准不再执行", async () => {
  const k = moduleKit("link-consume");
  try {
    k.setCandidateImpl(() => null); // 本条只走等待型决定链
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    // 模拟 /approve-standing 的决定事务：创建授权 + 链接当前批准（授权 ID/版本）
    const sp = k.createStanding({ approvalId: conf.id });
    const applied = k.gate.resolve(conf.id, "approved", {
      txExtra: () => ({ standingPermission: { id: sp.id, version: 1 } }),
    });
    assert.equal(applied, true);
    const linked = k.store.getConfirmation(conf.id)!;
    assert.equal(linked.decisionSource, "standing_permission");
    assert.equal(linked.standingPermissionId, sp.id);
    const resolved = taskEvents(k, "task.confirmation_resolved");
    assert.equal(resolved[0].source, "standing_permission");
    assert.equal(resolved[0].standingPermissionId, sp.id);
    // 撤销先提交：本次尚未消费的放行失效（不是独立批准）
    k.store.withTx(() => k.store.revokeStandingPermission(sp.id, 1));
    await assert.rejects(exec, /关联的长期授权 .* 已撤销或失效/);
    assert.equal(k.svc.starts(), 1, "批准失效后零执行");
    assert.equal(k.store.getConfirmation(conf.id)!.status, "stale");
  } finally {
    k.close();
  }
});

test("模块级：消费后无可信结果——协议错误标效果未知并使同目标授权失效", async () => {
  const k = moduleKit("proto-error");
  try {
    const sp = k.createStanding();
    // 确定性 seam：授权放行（窄路径）后、helper restart 前开启垃圾协议标志
    // （首个 inspect 已在放行前完成，垃圾应答只影响 restart 调用）
    k.setStandingImpl((input) => {
      const result = k.gate.requestStanding(input);
      if (result) k.svc.touch("garbage-protocol");
      return result;
    });
    await assert.rejects(k.call("service_manage", { unit: UNIT, action: "restart" }), /管理命令结果未知/);
    assert.equal(k.svc.restarts().length, 1, "restart 已派发（消费后可信应答缺失，诚实未知）");
    const op = k.store.listToolOpsByTask(k.taskId)[0]!;
    assert.equal(op.effectUnknown, true, "消费后无可信结果 = 效果未知");
    assert.equal(k.store.getStandingPermission(sp.id)!.revokedReason, "effect_unknown", "同目标授权已失效");
    assert.equal(k.store.getStandingPermission(sp.id)!.version, 2, "失效同样递增版本");
    // 下一项任务即使相同目标也必须恢复人工审批（旧授权不复活）
    fs.rmSync(path.join(k.svc.dir, "garbage-protocol"), { force: true });
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    assert.equal(k.svc.restarts().length, 1, "授权失效后未批准零执行");
    k.gate.resolve(conf.id, "rejected");
    await assert.rejects(exec, /拥有者拒绝执行/);
    assert.equal(k.svc.restarts().length, 1);
    return;
  } finally {
    k.close();
  }
});

test("模块级：派发后失败与产物保存失败——均标效果未知并使授权失效；可信的请求前拒绝不失效", async () => {
  const k = moduleKit("after-launch-unknown");
  try {
    const sp = k.createStanding();
    k.svc.touch("fail-after-launch");
    await assert.rejects(k.call("service_manage", { unit: UNIT, action: "restart" }), /管理命令结果未知/);
    assert.equal(k.svc.starts(), 2, "restart 已生效（不能描述为零执行）");
    assert.equal(k.store.getStandingPermission(sp.id)!.revokedReason, "effect_unknown");
    // 失败授权失效后：同一 op 再次调用恢复人工审批（不自动重试、换 ID 也不放行）
    const exec = k.call("service_manage", { unit: UNIT, action: "restart" });
    const conf = await k.pendingConf();
    k.gate.resolve(conf.id, "approved");
    await assert.rejects(exec, /管理命令结果未知/, "fail-after-launch 仍然如实未知（本次是人工批准后的独立操作）");
    assert.equal(k.svc.restarts().length, 2, "每次批准依然是各自恰好一次派发");
  } finally {
    k.close();
  }
});

test("模块级：产物保存失败（capture_failed）按效果未知处理并使授权失效", async () => {
  const k = moduleKit("capture-fail");
  try {
    const sp = k.createStanding();
    // 确定性 seam：放行后才让负责 restart 原始字节的产物写入失败（inspect 产物不受影响）
    k.setStandingImpl((input) => {
      const result = k.gate.requestStanding(input);
      if (result) k.failArtifactAppend(true);
      return result;
    });
    await assert.rejects(k.call("service_manage", { unit: UNIT, action: "restart" }), /管理命令结果未知/);
    assert.equal(k.svc.starts(), 2, "restart 实际已派发——保守记为效果未知");
    assert.equal(k.store.listToolOpsByTask(k.taskId)[0]!.effectUnknown, true);
    assert.equal(k.store.getStandingPermission(sp.id)!.revokedReason, "effect_unknown");
  } finally {
    k.close();
  }
});

test("模块级：可信的请求前拒绝（launched:false）为已知未执行、授权不失效", async () => {
  const k = moduleKit("refusal-clean");
  try {
    k.createStanding();
    k.svc.touch("reload-required"); // helper 在请求 systemd 前拒绝（launched:false）
    await assert.rejects(k.call("service_manage", { unit: UNIT, action: "restart" }), /管理操作未执行/);
    assert.equal(k.svc.starts(), 1, "已知未执行");
    assert.equal(k.store.getToolOp(k.store.listToolOpsByTask(k.taskId)[0]!.id)!.effectUnknown ?? false, false);
    const sp = k.store.listStandingPermissionsPaged().items[0]!;
    assert.equal(k.store.getStandingPermission(sp.id)!.revokedAt, null, "确定未派发不触发授权失效");
  } finally {
    k.close();
  }
});

// ==================================================================
// 端到端：IM 双平台 + 真实 Runtime（沿用 test/78 模式）
// ==================================================================

import { createMockTools } from "../src/agent/mock-tools.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { cleanupDirs, lastUserText, makeTestDirs, writeModelsJson } from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot, type MockOneBot } from "./helpers/mock-onebot.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";

const QQ_OWNER = "880001";
const TG_TOKEN = "123456:SECRET-TOKEN-XYZ";
const TG_OWNER = 42;
const QQ_TIMEOUTS = { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 50, reconnectMaxMs: 150, sweepIntervalMs: 80 };

interface ImHarness {
  dirs: Awaited<ReturnType<typeof makeTestDirs>>["dirs"];
  config: RuntimeConfig;
  svc: FakeSvc;
  model: MockModelServer;
  onebot: MockOneBot;
  api: FakeBotApi;
  apiBase: string;
  rt: Runtime | null;
  close(): Promise<void>;
}

function onelineSends(text: string): Responder {
  return async (req) => {
    const last = req.messages.at(-1) as any;
    if (last?.role === "tool") {
      const toolText = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      return { kind: "text", text: `FINAL: ${toolText.slice(0, 1200)}` };
    }
    const t = lastUserText(req);
    const restart = t.match(/SVC-RESTART\s+(\S+)/);
    if (restart) return { kind: "tool_calls", calls: [{ id: "svc-rst-1", name: "service_manage", arguments: { unit: restart[1], action: "restart" } }] };
    if (t.includes(text)) return { kind: "text", text: `ACK ${text}` };
    return { kind: "text", text: "REPLY-TEXT" };
  };
}

async function imHarness(prefix: string, responder: Responder): Promise<ImHarness> {
  const { dirs } = await makeTestDirs(prefix, 0);
  const onebot = await startMockOneBot({});
  const model = new MockModelServer(responder);
  await writeModelsJson(dirs, await model.start());
  const api = new FakeBotApi({ token: TG_TOKEN, ownerId: TG_OWNER });
  const apiBase = await api.start();
  const svc = setupFakeService(dirs.root);
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
    qq: QQ_TIMEOUTS,
    telegram: { pollTimeoutSec: 1, backoffMs: 50 },
    scheduler: { tickMs: 30, sendTimeoutMs: 1_000 },
    service: { helperPath: svc.helperPath, policyPath: svc.policyPath, useSudo: false, allowNonLinuxPlatform: true, timeouts: { inspectMs: 5_000, restartMs: 10_000, stopMs: 2_500 } },
  };
  return {
    dirs,
    config,
    svc,
    model,
    onebot,
    api,
    apiBase,
    rt: null,
    async close() {
      await onebot.close();
      await api.close();
      await model.close();
      await cleanupDirs(dirs);
    },
  };
}

async function startWithPlatforms(h: ImHarness): Promise<Runtime> {
  const rt = await Runtime.start(h.config);
  h.rt = rt;
  await rt.addCredentialBinding({ name: "qq-test", host: h.onebot.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
  await rt.qqConfigure({ endpoint: h.onebot.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq-test", ownerUserId: QQ_OWNER });
  await rt.qqSetEnabled(true);
  await rt.addCredentialBinding({ name: "tg", host: new URL(h.apiBase).host, header: "none", purpose: "telegram_bot", secret: TG_TOKEN });
  await rt.telegramConfigure({ apiBase: h.apiBase, credential: "tg", ownerUserId: String(TG_OWNER) });
  await rt.telegramSetEnabled(true);
  await waitFor("QQ 已核实登录账号在线", () => rt.qqStatus().online === true);
  await waitFor("Telegram 轮询在线", () => rt.telegramStatus().online === true);
  return rt;
}

// ---------- 通用辅助 ----------

const tgTexts = (api: FakeBotApi) => api.sends.map((s) => String(s.text));
const qqTexts = (onebot: MockOneBot) =>
  onebot.actions
    .filter((a) => a.action === "send_private_msg")
    .map((a) => (a.params.message as any[]).filter((s) => s?.type === "text").map((s) => String(s.data?.text ?? "")).join(""));
const pushQq = (onebot: MockOneBot, messageId: number, text: string) =>
  onebot.pushPrivateMessage({ userId: QQ_OWNER, messageId, segments: [{ type: "text", data: { text } }] });

async function waitPending(rt: Runtime): Promise<void> {
  await waitFor("待审批数 1", () => rt.store.listConfirmationsByStatus("pending").length === 1);
}
const solePending = (rt: Runtime) => {
  const all = rt.store.listConfirmationsByStatus("pending");
  assert.equal(all.length, 1, "恰有一个待审批");
  return all[0]!;
};

const textOf = (result: any): string => (result.content as any[]).map((p) => (p.type === "text" ? p.text : "")).join("\n");

const svcResponder = (): Responder => onelineSends("GO");

/** 等待某任务的最终回答到达相应入口（owner_reply）。 */
const finalCame = (texts: () => string[], match: string) => texts().some((t) => t.includes("FINAL:") && t.includes(match));

/** 找到排除已知任务外的最新 SVC-RESTART 主力（created_at 可能同一毫秒，不能用次序取最后一条）。 */
async function nextSvcTask(rt: Runtime, exclude: ReadonlySet<string>): Promise<import("../src/core/types.ts").Task> {
  let found: import("../src/core/types.ts").Task | null = null;
  await waitFor("新 SVC-RESTART 任务登记", () => {
    found = rt.store.listTasksBySession(rt.store.getAgentRole("main")!.sessionId).find((t) => t.input.includes("SVC-RESTART") && !exclude.has(t.id)) ?? null;
    return found !== null;
  });
  return found!;
}

const taskDone = async (rt: Runtime, taskId: string): Promise<void> => {
  await waitFor("任务完成", () => {
    const t = rt.store.getTask(taskId)!;
    return t.status === "completed" || t.status === "failed" || t.status === "canceled" || t.status === "interrupted";
  });
};

test("Telegram 全流程：申请 → 长期批准 → 本次执行 → 独立任务自动放行 → 查看 → 撤销 → 恢复人工审批（覆盖点 1/2/5）", async () => {
  const h = await imHarness("sp-tg-flow", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    // 普通审批申请（通知同时提供单次批准与长期批准两种说明）
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("通知送达 Telegram", () => tgTexts(h.api).some((t) => t.includes("【需要审批】") && t.includes(conf.id)));
    const notice = tgTexts(h.api).find((t) => t.includes("【需要审批】"))!;
    assert.ok(notice.includes(`/approve ${conf.id} ${conf.permissionVersion}`), notice);
    assert.ok(notice.includes(`/approve-standing ${conf.id} ${conf.permissionVersion}`), notice);
    assert.ok(notice.includes("长期"), notice);

    // 长期批准：保存授权 + 批准本次（回执区分"授权已保存、批准已接受"与执行成功）
    const callsBefore = h.model.calls.length;
    h.api.push({ text: `/approve-standing ${conf.id} ${conf.permissionVersion}` });
    await waitFor("长期批准回执", () => tgTexts(h.api).some((t) => t.includes("长期授权已保存：") && t.includes("不代表操作已经成功")));
    const sp = rt.store.listStandingPermissionsPaged().items[0]!;
    assert.ok(sp, "授权已保存");
    assert.ok(tgTexts(h.api).some((t) => t.includes(sp.id) && t.includes(`/revoke-service-grant ${sp.id} 1`)), "回执含授权 ID 与撤销命令");
    await waitFor("当前操作完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    await waitFor("本次恰好执行一次", () => tgTexts(h.api).some((t) => finalCame(() => tgTexts(h.api), "管理命令结果")));
    assert.equal(h.svc.starts(), 2);
    assert.equal(h.model.calls.length, callsBefore + 1, "命令本身零模型调用（+1 仅为原任务获批后的最终回答）");
    // 来源审批登记决定来源与授权关联
    const decided = rt.store.getConfirmation(conf.id)!;
    assert.equal(decided.decisionSource, "standing_permission");
    assert.equal(decided.standingPermissionId, sp.id);
    assert.ok(decided.consumedAt, "本次批准单次消费");
    assert.equal(sp.approvalId, conf.id);
    assert.equal(sp.version, 1);
    assert.equal(rt.store.getEventsAfter(0, 5000).filter((e) => e.body.type === "standing_permission.created").length, 1);

    // 另一项独立任务命中精确范围：自动放行恰好执行一次，零额外审批
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    const second = await nextSvcTask(rt, new Set([conf.taskId]));
    await taskDone(rt, second.id);
    assert.equal(h.svc.starts(), 3, "第二次恰好执行一次");
    assert.equal(h.svc.restarts().length, 2);
    const mainSession = rt.store.getAgentRole("main")!.sessionId;
    const tasks = rt.store.listTasksBySession(mainSession).filter((t) => t.input.includes("SVC-RESTART"));
    assert.equal(tasks.length, 2);
    assert.notEqual(tasks[0]!.id, tasks[1]!.id, "两次独立 taskId");
    const usages = rt.store.listConfirmationsByStanding(sp.id);
    assert.equal(usages.length, 2, "两次独立批准/消费");
    assert.notEqual(usages[0]!.id, usages[1]!.id, "批准记录不同");
    assert.notEqual(usages[0]!.toolOpId, usages[1]!.toolOpId, "hostOpId 不同");
    assert.ok(usages.every((u) => u.standingPermissionId === sp.id && u.consumedAt), "只有长期授权相同");
    assert.equal(rt.store.listConfirmationsByStatus("pending").length, 0, "第二次零人工审批");
    assert.ok(tgTexts(h.api).some((t) => finalCame(() => tgTexts(h.api), "授权依据：长期授权")), "最终回答如实标注授权依据");

    // 查看列表与详情（展示两次独立消费）
    h.api.push({ text: "/service-grants" });
    await waitFor("授权目录回执", () => tgTexts(h.api).some((t) => t.includes("本入口长期授权 1 项") && t.includes(sp.id) && t.includes("有效")));
    h.api.push({ text: `/service-grant ${sp.id}` });
    await waitFor("授权详情回执", () =>
      tgTexts(h.api).some((t) => t.includes(`长期授权 ${sp.id}`) && t.includes("使用记录 2 次") && t.includes(`审批 ${conf.id}`) && t.includes(UNIT)),
    );

    // 撤销 → 下一次恢复人工审批，未批准零执行
    h.api.push({ text: `/revoke-service-grant ${sp.id} 1` });
    await waitFor("撤销回执", () => tgTexts(h.api).some((t) => t.includes(`已撤销长期授权 ${sp.id}`) && t.includes("v1 → v2")));
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    assert.equal(h.svc.starts(), 3, "撤销后不经批准零执行");
    const back = solePending(rt);
    h.api.push({ text: `/reject ${back.id} ${back.permissionVersion}` });
    await waitFor("拒绝收尾", () => rt.store.getTask(back.taskId)!.status === "completed");
    assert.equal(h.svc.starts(), 3);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("QQ 全流程：长期批准保存+本次 → 第二任务自动放行 → 详情两次消费 → 撤销恢复审批（覆盖点 1/2）", async () => {
  const h = await imHarness("sp-qq-flow", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    pushQq(h.onebot, 1, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("QQ 通知送达", () => qqTexts(h.onebot).some((t) => t.includes(`/approve-standing ${conf.id}`)));
    pushQq(h.onebot, 2, `/approve-standing ${conf.id} ${conf.permissionVersion}`);
    await waitFor("QQ 长期批准回执", () => qqTexts(h.onebot).some((t) => t.includes("长期授权已保存：")));
    await waitFor("QQ 本次恰好一次", () => finalCame(() => qqTexts(h.onebot), "管理命令结果"));
    assert.equal(h.svc.starts(), 2);
    const sp = rt.store.listStandingPermissionsPaged().items[0]!;
    assert.equal(sp.channel, "qq_private");
    assert.equal(sp.chatId, QQ_OWNER);
    pushQq(h.onebot, 3, `SVC-RESTART ${UNIT}`);
    const second = await nextSvcTask(rt, new Set([conf.taskId]));
    await taskDone(rt, second.id);
    assert.equal(h.svc.starts(), 3, "第二任务自动放行恰好一次");
    assert.equal(rt.store.listConfirmationsByStanding(sp.id).length, 2);
    pushQq(h.onebot, 4, `/service-grant ${sp.id}`);
    await waitFor("QQ 详情回执", () => qqTexts(h.onebot).some((t) => t.includes(`长期授权 ${sp.id}`) && t.includes("使用记录 2 次")));
    pushQq(h.onebot, 5, `/revoke-service-grant ${sp.id} 1`);
    await waitFor("QQ 撤销回执", () => qqTexts(h.onebot).some((t) => t.includes(`已撤销长期授权 ${sp.id}`)));
    pushQq(h.onebot, 6, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    assert.equal(h.svc.starts(), 3, "撤销后恢复人工审批");
    const back = solePending(rt);
    pushQq(h.onebot, 7, `/reject ${back.id} ${back.permissionVersion}`);
    await waitFor("QQ 拒绝收尾", () => rt.store.getTask(back.taskId)!.status === "completed");
    assert.equal(h.svc.starts(), 3);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("创建边界：自然语言/引用/非服务审批/部分 ID/版本错误/重复消息都不能创建授权（覆盖点 3/4）", async () => {
  const h = await imHarness("sp-boundaries", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    await waitFor("通知送达", () => tgTexts(h.api).some((t) => t.includes(conf.id)));
    const callsBefore = h.model.calls.length;
    const grantsBefore = () => rt.store.listStandingPermissionsPaged().items.length;
    assert.equal(grantsBefore(), 0);

    // 自然语言包含命令文本：走普通入站登记为任务事件，不建授权、不产生控制事件
    h.api.push({ text: `请帮我看看 /approve-standing ${conf.id} ${conf.permissionVersion} 是干什么的` });
    await waitFor("自然语言登记为普通入站", () =>
      rt.store.listInboundByStatus(["registered", "queued", "done"]).some((e) => e.eventKind === "task" && e.body.includes("是干什么的")),
    );
    assert.ok(
      !rt.store.listInboundByStatus(["registered", "queued", "done"]).some((e) => e.eventKind === "im_approval" && e.body.includes("是干什么的")),
      "自然语言不产生审批控制事件",
    );
    assert.equal(grantsBefore(), 0);
    // 引用（回复）消息：命令在引用里不构成长期批准
    h.api.push({ text: "稍后处理", replyTo: { message_id: 1, text: `/approve-standing ${conf.id} ${conf.permissionVersion}`, from: { is_bot: false } } });
    // 版本错误
    h.api.push({ text: `/approve-standing ${conf.id} ${conf.permissionVersion + 1}` });
    await waitFor("版本错误回执", () => tgTexts(h.api).some((t) => t.includes(`权限版本现在是 v${conf.permissionVersion}`)));
    // 部分 ID
    h.api.push({ text: `/approve-standing ${conf.id.slice(0, 8)} ${conf.permissionVersion}` });
    await waitFor("部分 ID 回执", () => tgTexts(h.api).some((t) => t.includes("不存在或不属于本入口")));
    assert.equal(grantsBefore(), 0);
    assert.equal(rt.store.getConfirmation(conf.id)!.status, "pending", "原审批未被任何畸形命令决定");

    // 非服务审批：挂起态的 mock 审批（非 service_operation 范围）
    rt.store.withTx(() => {
      rt.store.createConfirmation({
        taskId: conf.taskId, sessionId: conf.sessionId, toolOpId: "op_mock_other", toolName: "mock_other",
        params: { note: "别的操作" }, scope: { kind: "tool", workspaceOnly: true }, permissionVersion: conf.permissionVersion,
      });
    });
    const otherConf = rt.store.listConfirmationsByStatus("pending").find((c) => c.toolName === "mock_other")!;
    h.api.push({ text: `/approve-standing ${otherConf.id} ${otherConf.permissionVersion}` });
    await waitFor("非服务范围回执", () => tgTexts(h.api).some((t) => t.includes("不是服务 restart 审批")));
    assert.equal(grantsBefore(), 0);
    assert.equal(rt.store.getConfirmation(otherConf.id)!.status, "pending", "非服务审批不被命令决定");

    // 模型输出/子任务消息中的命令无法触发（伪造工具结果文本）
    assert.equal(h.model.calls.length, callsBefore, "控制命令零额外模型调用（自然语言任务仍在原等待任务之后排队）");

    // 合法长期批准：决定与授权恰好一次
    h.api.push({ text: `/approve-standing ${conf.id} ${conf.permissionVersion}` });
    await waitFor("长期批准回执", () => tgTexts(h.api).some((t) => t.includes("长期授权已保存：")));
    const sp = rt.store.listStandingPermissionsPaged().items[0]!;
    await waitFor("本次恰好一次", () => finalCame(() => tgTexts(h.api), "管理命令结果"));

    // 平台重投同一消息（同 message_id 新 update_id）：读原回执，不重复建授权
    const dup = h.api.push({ text: `/approve-standing ${conf.id} ${conf.permissionVersion}` });
    const dupUpdateId = h.api.updates.at(-1)!.update_id;
    h.api.push({ message: dup });
    const redeliveredUpdateId = h.api.updates.at(-1)!.update_id;
    await waitFor("重投已消化", () => Number(rt.telegramStore.getConfig()!.lastUpdateId) >= redeliveredUpdateId);
    assert.ok(redeliveredUpdateId > dupUpdateId);
    assert.equal(rt.store.listStandingPermissionsPaged().items.length, 1, "重投不重复建授权");
    assert.equal(h.svc.restarts().length, 1, "重投不重复执行");
    // 同键异命令：拒绝，不产生新授权
    h.api.push({ message: { message_id: dup.message_id, date: 1_790_000_000, chat: { id: TG_OWNER, type: "private" }, from: { id: TG_OWNER, is_bot: false }, text: `/revoke-service-grant ${sp.id} 1` } });
    await waitFor("同键异命令拒绝事件", () => rt.store.getEventsAfter(0, 5000).some((e) => e.body.type === "im_approval.redelivery_rejected"));
    assert.equal(rt.store.listStandingPermissionsPaged().items.length, 1);
    assert.equal(rt.store.getStandingPermission(sp.id)!.revokedAt, null, "同键异命令不能撤销授权");

    // 已决定的审批再次长期批准：不会重复保存
    h.api.push({ text: `/approve-standing ${conf.id} ${conf.permissionVersion}` });
    await waitFor("重复长期批准回执", () => tgTexts(h.api).some((t) => t.includes("已失效或已处理") && t.includes(conf.id)));
    assert.equal(rt.store.listStandingPermissionsPaged().items.length, 1);
    assert.equal(h.svc.restarts().length, 1);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("跨平台不继承：Telegram 授权不放行 QQ 任务；两平台各自独立授权、各自仅放行自己入口", async () => {
  const h = await imHarness("sp-cross", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    // Telegram 建立授权
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const tgConf = solePending(rt);
    h.api.push({ text: `/approve-standing ${tgConf.id} ${tgConf.permissionVersion}` });
    await waitFor("TG 长期批准回执", () => tgTexts(h.api).some((t) => t.includes("长期授权已保存：")));
    const tgSp = rt.store.listStandingPermissionsPaged().items[0]!;
    await waitFor("TG 本次执行", () => rt.store.getTask(tgConf.taskId)!.status === "completed");
    assert.equal(h.svc.starts(), 2);

    // QQ 同服务任务：共享 main 不继承——仍逐次审批
    pushQq(h.onebot, 1, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    const qqConf = solePending(rt);
    assert.equal(h.svc.starts(), 2, "TG 授权不放行 QQ 任务");
    // QQ 查看 TG 授权详情：不属于本入口
    pushQq(h.onebot, 2, `/service-grant ${tgSp.id}`);
    await waitFor("跨平台详情拒绝", () => qqTexts(h.onebot).some((t) => t.includes("长期授权") && t.includes("不属于本入口")));
    // QQ 建立自己的授权
    pushQq(h.onebot, 3, `/approve-standing ${qqConf.id} ${qqConf.permissionVersion}`);
    await waitFor("QQ 长期批准回执", () => qqTexts(h.onebot).some((t) => t.includes("长期授权已保存：")));
    await waitFor("QQ 本次执行", () => rt.store.getTask(qqConf.taskId)!.status === "completed");
    const grants = rt.store.listStandingPermissionsPaged().items;
    assert.equal(grants.length, 2, "两平台各一条授权");
    assert.equal(h.svc.starts(), 3);

    // 各自第二任务：各自自动放行（互不经手）
    pushQq(h.onebot, 4, `SVC-RESTART ${UNIT}`);
    const qqSecond = await nextSvcTask(rt, new Set([tgConf.taskId, qqConf.taskId]));
    await taskDone(rt, qqSecond.id);
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    const tgSecond = await nextSvcTask(rt, new Set([tgConf.taskId, qqConf.taskId, qqSecond.id]));
    await taskDone(rt, tgSecond.id);
    assert.equal(h.svc.starts(), 5, "两平台各自放行各一次");
    assert.equal(rt.store.listConfirmationsByStanding(tgSp.id).length, 2);
    const qqSp = grants.find((g) => g.id !== tgSp.id)!;
    assert.equal(rt.store.listConfirmationsByStanding(qqSp.id).length, 2);

    // TUI/直接提交不继承：无 IM 来源的任务走人工审批
    const main = rt.store.getAgentRole("main")!;
    const tui = await rt.submit({ sessionId: main.sessionId, requestId: "ui-1", input: `SVC-RESTART ${UNIT}`, modelSelection: rt.defaultSelection });
    await waitPending(rt);
    assert.equal(h.svc.starts(), 5, "TUI 提交不继承任何 IM 授权");
    const tuiConf = solePending(rt);
    assert.equal(tuiConf.standingPermissionId, null);
    rt.respondConfirmation(tuiConf.id, "approved");
    await waitFor("TUI 批准任务完成", () => rt.store.getTask(tui.id)!.status === "completed");
    assert.equal(h.svc.starts(), 6, "人工批准后照常执行");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("入口绑定变化使该入口授权失效（递增版本保留记录）；另一平台独立授权不受影响；重绑后不复活", async () => {
  const h = await imHarness("sp-rebind", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    // QQ 建授权
    pushQq(h.onebot, 1, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    const qqConf = solePending(rt);
    pushQq(h.onebot, 2, `/approve-standing ${qqConf.id} ${qqConf.permissionVersion}`);
    await waitFor("QQ 长期批准回执", () => qqTexts(h.onebot).some((t) => t.includes("长期授权已保存：")));
    const qqSp = rt.store.listStandingPermissionsPaged().items[0]!;
    await waitFor("QQ 本次执行", () => rt.store.getTask(qqConf.taskId)!.status === "completed");
    // Telegram 建授权（第二单元不可用——改查目录即可验证不受影响；这里同样给 UNIT 独立授权共用目标）
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const tgConf = solePending(rt);
    h.api.push({ text: `/approve-standing ${tgConf.id} ${tgConf.permissionVersion}` });
    await waitFor("TG 长期批准回执", () => tgTexts(h.api).some((t) => t.includes("长期授权已保存：")));
    const tgSp = rt.store.listStandingPermissionsPaged().items.find((g) => g.id !== qqSp.id)!;
    assert.ok(tgSp, "TG 授权已建立");
    await waitFor("TG 本次执行", () => rt.store.getTask(tgConf.taskId)!.status === "completed");

    // QQ 停用：该入口稳定身份死亡 → 授权明确失效（保留记录）；TG 授权不受影响
    await rt.qqSetEnabled(false);
    const qqAfter = rt.store.getStandingPermission(qqSp.id)!;
    assert.equal(qqAfter.revokedReason, "entry_changed");
    assert.equal(qqAfter.version, 2, "失效递增版本");
    assert.equal(rt.store.getStandingPermission(tgSp.id)!.revokedAt, null, "Telegram 授权不受影响");
    // 重新启用 + 原 owner（同稳定身份重新绑定）：旧授权不复活、挑不中
    await rt.qqSetEnabled(true);
    await waitFor("QQ 重连在线", () => rt.qqStatus().online === true);
    assert.equal(rt.store.getStandingPermission(qqSp.id)!.revokedReason, "entry_changed", "旧授权不复活");
    pushQq(h.onebot, 3, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    assert.equal(h.svc.starts(), 3, "重绑后旧授权不放行，恢复人工审批（QQ/TG 此前各执行一次共 3 次 starts）");
    const back = solePending(rt);
    pushQq(h.onebot, 4, `/reject ${back.id} ${back.permissionVersion}`);
    await waitFor("QQ 拒绝收尾", () => rt.store.getTask(back.taskId)!.status === "completed");
    assert.equal(h.svc.starts(), 3, "拒绝后零执行");
    // 失效目录依然可查（含失效原因）
    pushQq(h.onebot, 5, "/service-grants");
    await waitFor("QQ 失效目录回执", () => qqTexts(h.onebot).some((t) => t.includes(qqSp.id) && t.includes("已失效（入口绑定/代次变化）")));
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("目标效果未知：该目标两平台授权一并失效（不自动重试）；核实后人工重建才恢复", async () => {
  const h = await imHarness("sp-effect-unknown", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    let qqMsgId = 0;
    for (const [push, texts] of [
      [(msg: string) => h.api.push({ text: msg }), () => tgTexts(h.api)],
      [(msg: string) => pushQq(h.onebot, ++qqMsgId, msg), () => qqTexts(h.onebot)],
    ] as const) {
      push(`SVC-RESTART ${UNIT}`);
      await waitPending(rt);
      const conf = solePending(rt);
      push(`/approve-standing ${conf.id} ${conf.permissionVersion}`);
      await waitFor("长期批准回执", () => texts().some((t) => t.includes("长期授权已保存：")));
      await waitFor("本次执行完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    }
    assert.equal(rt.store.listStandingPermissionsPaged().items.filter((g) => g.revokedAt === null).length, 2);
    assert.equal(h.svc.starts(), 3);

    // QQ 第二任务：自动放行；helper 派发后失败 → 效果未知 → 该目标所有授权失效
    h.svc.touch("fail-after-launch");
    pushQq(h.onebot, 3, `SVC-RESTART ${UNIT}`);
    await waitFor("QQ 效果未知最终回答", () => qqTexts(h.onebot).some((t) => finalCame(() => qqTexts(h.onebot), "管理命令结果未知")));
    assert.equal(h.svc.starts(), 4, "restart 已生效（不描述为零执行）");
    assert.equal(h.svc.restarts().length, 3, "不自动重发");
    const grants = rt.store.listStandingPermissionsPaged().items;
    assert.ok(grants.every((g) => g.revokedReason === "effect_unknown"), "两平台授权一并失效");
    assert.ok(rt.store.getEventsAfter(0, 5000).some((e) => e.body.type === "standing_permission.revoked" && (e.body as any).reason === "effect_unknown" && Boolean((e.body as any).opId)), "失效事件带触发操作 ID");

    // 换 ID、另一平台都不能自动重试：QQ/TG 新任务走到人工待审批；核实后拒绝则零执行
    pushQq(h.onebot, 4, `SVC-RESTART ${UNIT}`);
    await waitPending(rt);
    assert.equal(h.svc.starts(), 4, "失效后不经批准零执行（换任务换 opId 同一目标）");
    const qqBack = solePending(rt);
    pushQq(h.onebot, 5, `/reject ${qqBack.id} ${qqBack.permissionVersion}`);
    await waitFor("QQ 任务收尾", () => rt.store.getTask(qqBack.taskId)!.status === "completed");
    assert.equal(h.svc.restarts().length, 3, "拒绝后零执行");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("后台正常重启保留有效授权：重启后独立任务仍自动放行恰好一次", async () => {
  const h = await imHarness("sp-restart-keep", svcResponder());
  let rt = await startWithPlatforms(h);
  try {
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    h.api.push({ text: `/approve-standing ${conf.id} ${conf.permissionVersion}` });
    await waitFor("长期批准回执", () => tgTexts(h.api).some((t) => t.includes("长期授权已保存：")));
    await waitFor("本次执行完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    const sp = rt.store.listStandingPermissionsPaged().items[0]!;
    await rt.stop("restart");
    h.rt = null;

    rt = h.rt = await Runtime.start(h.config);
    assert.equal(rt.store.getStandingPermission(sp.id)!.revokedAt, null, "后台重启保留有效授权");
    assert.equal(rt.store.getStandingPermission(sp.id)!.version, 1);
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    const second = await nextSvcTask(rt, new Set([conf.taskId]));
    await taskDone(rt, second.id);
    assert.equal(h.svc.restarts().length, 2, "重启后自动放行恰好一次");
    assert.equal(rt.store.listConfirmationsByStatus("pending").length, 0);
    assert.equal(rt.store.listConfirmationsByStanding(sp.id).length, 2);
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});

test("拥有者控制面：list/get/revoke 有界有据；版本冲突明确拒绝；重复撤销幂等（含入口停用后的遗留管理）", async () => {
  const h = await imHarness("sp-control", svcResponder());
  const rt = await startWithPlatforms(h);
  try {
    h.api.push({ text: `SVC-RESTART ${UNIT}` });
    await waitPending(rt);
    const conf = solePending(rt);
    h.api.push({ text: `/approve-standing ${conf.id} ${conf.permissionVersion}` });
    await waitFor("长期批准回执", () => tgTexts(h.api).some((t) => t.includes("长期授权已保存：")));
    await waitFor("本次执行完成", () => rt.store.getTask(conf.taskId)!.status === "completed");
    const sp = rt.store.listStandingPermissionsPaged().items[0]!;

    const list = rt.serviceGrantList({ limit: 10 });
    assert.equal(list.items.length, 1);
    assert.equal(list.nextCursor, null);
    assert.deepEqual(list.items[0]!.id, sp.id);
    const detail = rt.serviceGrantGet(sp.id);
    assert.equal(detail.permission.unit, UNIT);
    assert.equal(detail.usages.length, 1, "一次独立消费记录");
    assert.equal(detail.usages[0]!.standingPermissionId, sp.id);
    assert.throws(() => rt.serviceGrantGet("sp_none"), /长期授权不存在/);
    // 版本冲突：不执行
    assert.throws(() => rt.serviceGrantRevoke(sp.id, 99), (err: Error) => (err as any).code === "version_conflict");
    assert.equal(rt.store.getStandingPermission(sp.id)!.revokedAt, null);
    // 正常撤销（入口停用后同样可用的遗留目录管理）
    const revoked = rt.serviceGrantRevoke(sp.id, 1);
    assert.equal(revoked.version, 2);
    assert.equal(revoked.revokedReason, "owner_revoked");
    const again = rt.serviceGrantRevoke(sp.id, 2);
    assert.equal(again.version, 2, "重复撤销幂等（不再次变更）");
    assert.equal(rt.serviceGrantGet(sp.id).permission.revokedReason, "owner_revoked", "目录可见撤销原因");
  } finally {
    await h.rt?.stop("test_end");
    await h.close();
  }
});
