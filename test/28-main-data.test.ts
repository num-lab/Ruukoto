/**
 * main 应用数据空间集成测试（issue 02）。
 *
 * 覆盖工单验证项：
 * - main 能创建不同结构的表并跨重启读写；
 * - 迁移版本冲突不会静默覆盖；
 * - 破坏性操作进入确认（三种权限模式、拒绝、重复批准、陈旧版本、取消）；
 * - 核心任务、审批、事件和凭据表无法被应用数据工具访问；
 * - coding/chat/普通开发会话默认无法查询 main 数据；
 * - 大查询、恶意表名、超大字段和超时被拒绝并留下事件；
 * - 双库恢复：回执补记已提交 / 无回执记未提交 / 应用库不可用保留未知效果。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AppDataStore, AppDataConflictError, AppDataError, LIMITS } from "../src/agent/app-data/store.ts";
import { AppDataQueryRunner, runQuery, validateQueryRequest, QUERY_LIMITS } from "../src/agent/app-data/query.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
import type { PersistentEvent } from "../src/core/types.ts";
import {
  cleanupDirs,
  createProjectSession,
  lastUserText,
  makeTestDirs,
  pendingConfirmation,
  startTestRuntime,
  taskStatus,
  waitFor,
  writeModelsJson,
} from "./helpers/testkit.ts";
import { MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const CTX = { taskId: "task_test", sessionId: "sess_test", agentId: "main" };

async function tempStore(): Promise<{ dir: string; store: AppDataStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ruukoto-appdata-"));
  const store = new AppDataStore(path.join(dir, "main.db"));
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function defineTodos(store: AppDataStore, opId: string, expected = 0) {
  return store.defineTable({
    table: "todos",
    fields: [
      { name: "title", type: "text" },
      { name: "done", type: "boolean", nullable: true },
      { name: "due", type: "datetime", nullable: true },
    ],
    indexes: [{ name: "idx_todos_done", fields: ["done"] }],
    expected_schema_version: expected,
    reason: "测试建表",
    opId,
    ctx: CTX,
  });
}

// ---------- 存储层不变量 ----------

test("建表/插入/更新/删除与跨重启读写", async () => {
  const { dir, store, cleanup } = await tempStore();
  try {
    const created = defineTodos(store, "op_create");
    assert.equal(created.applied, true);
    assert.equal(created.schemaVersion, 1);
    assert.equal(created.revision, 1);

    const ins = store.insert({
      table: "todos",
      records: [
        { title: "买牛奶", done: false, due: "2026-09-24T09:00:00+08:00" },
        { title: "写周报", done: true },
      ],
      reason: "记录待办",
      opId: "op_ins1",
      ctx: CTX,
    });
    assert.deepEqual(ins.rows, [{ id: 1, version: 1 }, { id: 2, version: 1 }]);
    assert.equal(ins.revision, 2);

    const upd = store.updateRows({
      table: "todos",
      rows: [{ id: 1, expected_version: 1, set: { done: true } }],
      reason: "完成",
      opId: "op_upd1",
      ctx: CTX,
    });
    assert.equal(upd.updated, 1);
    assert.equal(store.getRow(store.getTable("todos")!, 1)!._version, 2);

    const del = store.deleteRows({
      table: "todos",
      rows: [{ id: 2, expected_version: 1 }],
      reason: "不需要了",
      opId: "op_del1",
      ctx: CTX,
    });
    assert.equal(del.updated, 1);

    // 跨重启：关闭重开后数据与版本保留
    const instanceId = store.getInstanceId();
    store.close();
    const reopened = new AppDataStore(path.join(dir, "main.db"));
    try {
      assert.equal(reopened.getInstanceId(), instanceId);
      assert.deepEqual(reopened.getVersions(), { schemaVersion: 1, revision: 4 });
      const row = reopened.getRow(reopened.getTable("todos")!, 1)!;
      assert.equal(row.title, "买牛奶");
      assert.equal(row.done, true);
      // datetime 统一为 UTC ISO
      assert.equal(row.due, "2026-09-24T01:00:00.000Z");
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("schema 版本冲突不静默覆盖；表已存在即冲突", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c1");
    // 过期版本：不覆盖
    assert.throws(
      () => defineTodos(store, "op_c2", 0),
      (err) => err instanceof AppDataConflictError && err.code === "schema_version_conflict",
    );
    // 同名不同定义：冲突而非 IF NOT EXISTS 掩盖
    assert.throws(
      () =>
        store.defineTable({
          table: "todos",
          fields: [{ name: "other", type: "text" }],
          expected_schema_version: 1,
          reason: "重复定义",
          opId: "op_c3",
          ctx: CTX,
        }),
      (err) => err instanceof AppDataConflictError && err.code === "table_exists",
    );
    // 失败不推进版本
    assert.deepEqual(store.getVersions(), { schemaVersion: 1, revision: 1 });
  } finally {
    await cleanup();
  }
});

test("关系与外键 RESTRICT：删除被引用行失败；删除被引用表被拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    store.defineTable({
      table: "projects",
      fields: [{ name: "name", type: "text" }],
      expected_schema_version: 0,
      reason: "项目表",
      opId: "op_p",
      ctx: CTX,
    });
    store.defineTable({
      table: "tasks",
      fields: [
        { name: "title", type: "text" },
        { name: "project", type: "integer", nullable: true, references: "projects" },
      ],
      expected_schema_version: 1,
      reason: "任务表",
      opId: "op_t",
      ctx: CTX,
    });
    store.insert({ table: "projects", records: [{ name: "ruukoto" }], reason: "建项目", opId: "op_pi", ctx: CTX });
    store.insert({ table: "tasks", records: [{ title: "t1", project: 1 }], reason: "建任务", opId: "op_ti", ctx: CTX });
    // 删除被引用行：RESTRICT 拒绝
    assert.throws(
      () => store.deleteRows({ table: "projects", rows: [{ id: 1, expected_version: 1 }], reason: "删", opId: "op_pd", ctx: CTX }),
      /RESTRICT|FOREIGN KEY/i,
    );
    // 删除被引用表：首版拒绝
    assert.throws(
      () =>
        store.migrate({
          expected_schema_version: 2,
          steps: [{ op: "drop_table", table: "projects" }],
          reason: "删表",
          opId: "op_pt",
          ctx: CTX,
        }),
      (err) => err instanceof AppDataError && err.code === "table_in_use",
    );
    // 关系只能指向已登记表
    assert.throws(
      () =>
        store.defineTable({
          table: "ghost",
          fields: [{ name: "x", type: "integer", references: "nope" }],
          expected_schema_version: 2,
          reason: "坏关系",
          opId: "op_g",
          ctx: CTX,
        }),
      (err) => err instanceof AppDataError && err.code === "table_not_found",
    );
  } finally {
    await cleanup();
  }
});

test("批量插入原子：一行非法整批回滚，版本与审计不推进", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    assert.throws(
      () =>
        store.insert({
          table: "todos",
          records: [{ title: "好行" }, { title: 123 as unknown as string }],
          reason: "混合批次",
          opId: "op_bad",
          ctx: CTX,
        }),
      (err) => err instanceof AppDataError && err.code === "invalid_value",
    );
    assert.equal(store.countRows("todos"), 0);
    assert.deepEqual(store.getVersions(), { schemaVersion: 1, revision: 1 });
    assert.equal(store.getReceipt("op_bad"), null);
  } finally {
    await cleanup();
  }
});

test("hostOpId 幂等：同参返回原结果，异参冲突", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    const first = store.insert({ table: "todos", records: [{ title: "a" }], reason: "r", opId: "op_same", ctx: CTX });
    const again = store.insert({ table: "todos", records: [{ title: "a" }], reason: "r", opId: "op_same", ctx: CTX });
    assert.equal(again.applied, false);
    assert.deepEqual(again.rows, first.rows);
    assert.equal(store.countRows("todos"), 1, "重复执行不产生第二行");
    assert.throws(
      () => store.insert({ table: "todos", records: [{ title: "b" }], reason: "r", opId: "op_same", ctx: CTX }),
      (err) => err instanceof AppDataConflictError && err.code === "op_conflict",
    );
  } finally {
    await cleanup();
  }
});

test("恶意名称与保留名被拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    for (const bad of ["sqlite_master", "app_tables", "_id", "Todos", "t;DROP TABLE x--", "todos;drop", "a".repeat(49)]) {
      assert.throws(
        () =>
          store.defineTable({
            table: bad,
            fields: [{ name: "f", type: "text" }],
            expected_schema_version: 0,
            reason: "r",
            opId: `op_${bad.length}`,
            ctx: CTX,
          }),
        (err) => err instanceof AppDataError && (err.code === "invalid_name" || err.code === "reserved_name"),
        `拒绝表名：${bad}`,
      );
    }
    // 字段保留名
    assert.throws(
      () =>
        store.defineTable({
          table: "ok_table",
          fields: [{ name: "_version", type: "text" }],
          expected_schema_version: 0,
          reason: "r",
          opId: "op_fv",
          ctx: CTX,
        }),
      (err) => err instanceof AppDataError,
    );
  } finally {
    await cleanup();
  }
});

test("超大字段/行/参数与行数上限被拒绝", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    const big = "x".repeat(LIMITS.maxFieldBytes + 1);
    assert.throws(
      () => store.insert({ table: "todos", records: [{ title: big }], reason: "r", opId: "op_big", ctx: CTX }),
      (err) => err instanceof AppDataError && err.code === "value_too_large",
    );
    // 恰好达到上限的值合法（上限即最大允许值）
    const atCap = store.insert({ table: "todos", records: [{ title: "x".repeat(LIMITS.maxFieldBytes) }], reason: "r", opId: "op_atcap", ctx: CTX });
    assert.equal(atCap.rows.length, 1);
    store.defineTable({
      table: "nums",
      fields: [
        { name: "i", type: "integer", nullable: true },
        { name: "r", type: "real", nullable: true },
      ],
      expected_schema_version: 1,
      reason: "数值表",
      opId: "op_nums",
      ctx: CTX,
    });
    assert.throws(
      () => store.insert({ table: "nums", records: [{ i: Number.MAX_SAFE_INTEGER + 1 }], reason: "r", opId: "op_unsafe", ctx: CTX }),
      (err) => err instanceof AppDataError && err.code === "invalid_value",
    );
    assert.throws(
      () => store.insert({ table: "nums", records: [{ r: Number.NaN }], reason: "r", opId: "op_nan", ctx: CTX }),
      (err) => err instanceof AppDataError && err.code === "invalid_value",
    );
    // 空 reason 拒绝
    assert.throws(
      () => store.insert({ table: "nums", records: [{ i: 1 }], reason: "  ", opId: "op_nor", ctx: CTX }),
      (err) => err instanceof AppDataError && err.code === "reason_required",
    );
  } finally {
    await cleanup();
  }
});

test("行版本冲突：更新/删除要求预期行版本", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    store.insert({ table: "todos", records: [{ title: "a" }], reason: "r", opId: "op_i", ctx: CTX });
    assert.throws(
      () => store.updateRows({ table: "todos", rows: [{ id: 1, expected_version: 9, set: { done: true } }], reason: "r", opId: "op_u", ctx: CTX }),
      (err) => err instanceof AppDataConflictError && err.code === "row_version_conflict",
    );
    assert.throws(
      () => store.deleteRows({ table: "todos", rows: [{ id: 1, expected_version: 9 }], reason: "r", opId: "op_d", ctx: CTX }),
      (err) => err instanceof AppDataConflictError && err.code === "row_version_conflict",
    );
  } finally {
    await cleanup();
  }
});

test("唯一索引遇重复数据整次回滚；迁移步骤上限", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    store.insert({ table: "todos", records: [{ title: "same" }, { title: "same" }], reason: "r", opId: "op_i", ctx: CTX });
    const before = store.getVersions();
    assert.throws(
      () =>
        store.migrate({
          expected_schema_version: 1,
          steps: [
            { op: "add_field", table: "todos", field: { name: "note", type: "text", nullable: true } },
            { op: "add_index", table: "todos", name: "uniq_title", fields: ["title"], unique: true },
          ],
          reason: "加唯一索引",
          opId: "op_mig",
          ctx: CTX,
        }),
      /UNIQUE|unique/i,
    );
    // 整次回滚：add_field 也不生效，版本不推进
    assert.deepEqual(store.getVersions(), before);
    assert.equal(store.getTable("todos")!.fields.some((f) => f.name === "note"), false);
    // 步骤上限
    assert.throws(
      () =>
        store.migrate({
          expected_schema_version: 1,
          steps: Array.from({ length: LIMITS.maxMigrateSteps + 1 }, (_, i) => ({
            op: "add_field",
            table: "todos",
            field: { name: `f${i}`, type: "text", nullable: true },
          })),
          reason: "超步数",
          opId: "op_many",
          ctx: CTX,
        }),
      (err) => err instanceof AppDataError && err.code === "too_many_steps",
    );
  } finally {
    await cleanup();
  }
});

test("审计回执：来源任务/agent/版本/理由齐全", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_audit");
    const receipt = store.getReceipt("op_audit")!;
    assert.equal(receipt.taskId, CTX.taskId);
    assert.equal(receipt.sessionId, CTX.sessionId);
    assert.equal(receipt.agentId, "main");
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.reason, "测试建表");
    assert.equal(receipt.toolName, "app_data_define_table");
  } finally {
    await cleanup();
  }
});

// ---------- 有界查询（存储边界 + 只读子进程） ----------

async function storeWithRows(rowCount: number): Promise<{ dir: string; store: AppDataStore; cleanup: () => Promise<void> }> {
  const t = await tempStore();
  defineTodos(t.store, "op_c");
  for (let i = 0; i < rowCount; i += 100) {
    const batch = Array.from({ length: Math.min(100, rowCount - i) }, (_, j) => ({
      title: `待办-${i + j}`,
      done: (i + j) % 3 === 0,
    }));
    t.store.insert({ table: "todos", records: batch, reason: "造数", opId: `op_seed_${i}`, ctx: CTX });
  }
  return t;
}

test("rows 查询：稀疏命中分页不漏行；显式超限拒绝", async () => {
  const { store, cleanup } = await storeWithRows(250);
  try {
    // 稀疏命中：done=true 每 3 行一条；候选窗口扫描有界
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = runQuery(store, validateQueryRequest({
        mode: "rows", table: "todos", fields: ["title", "done"],
        where: [{ field: "done", op: "eq", value: true }],
        limit: 10, cursor,
      }));
      assert.ok((result.scanned ?? 0) <= QUERY_LIMITS.maxCandidates);
      for (const row of result.rows as Array<{ _id: number }>) seen.push(row._id);
      if (result.complete) break;
      cursor = result.next_cursor as string;
      assert.ok(cursor, "不完整结果必须带继续游标");
    }
    assert.equal(seen.length, 84, "250 行中 done=true 共 84 行（0,3,...,249）");
    assert.equal(new Set(seen).size, seen.length, "分页不漏不重");
    // 显式超限拒绝
    assert.throws(
      () => validateQueryRequest({ mode: "rows", table: "todos", limit: QUERY_LIMITS.maxRows + 1 }),
      (err) => err instanceof AppDataError && err.code === "limit_exceeded",
    );
  } finally {
    await cleanup();
  }
});

test("rows 查询：结果字节预算与单条投影上限", async () => {
  const { store, cleanup } = await tempStore();
  try {
    store.defineTable({
      table: "blobs",
      fields: [{ name: "payload", type: "text" }],
      expected_schema_version: 0,
      reason: "大字段表",
      opId: "op_b",
      ctx: CTX,
    });
    // 每行约 8 KiB：64 KiB 结果预算最多 7 行（分两批插入，单批受 64 KiB 写入上限约束）
    const payload = "y".repeat(8 * 1024);
    for (const opId of ["op_bi1", "op_bi2"]) {
      store.insert({
        table: "blobs",
        records: Array.from({ length: 5 }, () => ({ payload })),
        reason: "造数",
        opId,
        ctx: CTX,
      });
    }
    const page = runQuery(store, validateQueryRequest({ mode: "rows", table: "blobs", limit: 100 }));
    assert.equal(page.complete, false);
    assert.ok((page.rows as unknown[]).length < 10, "字节预算截断");
    assert.ok(page.next_cursor, "带继续游标");
    // 接近行上限（32 KiB）的大行：每行约 28 KiB，三行超出 64 KiB 结果预算
    store.defineTable({
      table: "wide",
      fields: [{ name: "a", type: "text" }, { name: "b", type: "text" }, { name: "c", type: "text" }, { name: "d", type: "text" }],
      expected_schema_version: 1,
      reason: "大行表",
      opId: "op_h",
      ctx: CTX,
    });
    const chunk = "7".repeat(7 * 1024);
    for (const opId of ["op_h1", "op_h2", "op_h3"]) {
      store.insert({
        table: "wide",
        records: [{ a: chunk, b: chunk, c: chunk, d: chunk }],
        reason: "造数",
        opId,
        ctx: CTX,
      });
    }
    const wide = runQuery(store, validateQueryRequest({ mode: "rows", table: "wide", limit: 100 }));
    assert.equal(wide.complete, false, "超过 64 KiB 结果预算时截断留待下页");
    assert.equal((wide.rows as unknown[]).length, 2);
    assert.ok(wide.next_cursor, "带继续游标");
    const widePage2 = runQuery(store, validateQueryRequest({ mode: "rows", table: "wide", limit: 100, cursor: wide.next_cursor as string }));
    assert.equal((widePage2.rows as unknown[]).length, 1);
    assert.equal(widePage2.complete, true);
  } finally {
    await cleanup();
  }
});

test("rows 查询：跨页数据变化返回游标冲突", async () => {
  const { store, cleanup } = await storeWithRows(120);
  try {
    const first = runQuery(store, validateQueryRequest({ mode: "rows", table: "todos", limit: 50 }));
    assert.equal(first.complete, false);
    // 翻页前发生写入（revision 变化）
    store.insert({ table: "todos", records: [{ title: "新行" }], reason: "r", opId: "op_new", ctx: CTX });
    assert.throws(
      () => runQuery(store, validateQueryRequest({ mode: "rows", table: "todos", limit: 50, cursor: first.next_cursor as string })),
      (err) => err instanceof AppDataError && err.code === "cursor_conflict",
    );
  } finally {
    await cleanup();
  }
});

test("schema/changes 模式：表发现、单表定义与审计分页", async () => {
  const { store, cleanup } = await storeWithRows(5);
  try {
    const list = runQuery(store, validateQueryRequest({ mode: "schema" }));
    assert.deepEqual(list.tables, [{ name: "todos", fields: 3, indexes: 1 }]);
    const one = runQuery(store, validateQueryRequest({ mode: "schema", table: "todos" }));
    const table = one.table as { name: string; rowCount: number; fields: unknown[] };
    assert.equal(table.name, "todos");
    assert.equal(table.rowCount, 5);
    // 审计分页
    const changes = runQuery(store, validateQueryRequest({ mode: "changes", limit: 1 }));
    assert.equal((changes.changes as unknown[]).length, 1);
    assert.equal(changes.complete, false);
    const rest = runQuery(store, validateQueryRequest({ mode: "changes", limit: 100, cursor: changes.next_cursor as number }));
    assert.equal(rest.complete, true);
    assert.equal((rest.changes as unknown[]).length, 1);
    // 按操作 ID 核实提交结果
    const receipt = runQuery(store, validateQueryRequest({ mode: "changes", opId: "op_c" }));
    assert.equal((receipt.changes as Array<{ opId: string }>)[0]!.opId, "op_c");
    // 内部元表不可作为业务表查询
    assert.throws(
      () => runQuery(store, validateQueryRequest({ mode: "rows", table: "app_audit" })),
      (err) => err instanceof AppDataError && err.code === "table_not_found",
    );
  } finally {
    await cleanup();
  }
});

test("只读子进程：真实查询经子进程执行；超时真实终止进程", async () => {
  const { dir, store, cleanup } = await storeWithRows(10);
  const file = store.file;
  store.close();
  const runner = new AppDataQueryRunner();
  try {
    const result = await runner.run(file, validateQueryRequest({ mode: "rows", table: "todos", limit: 5 }));
    assert.equal((result.rows as unknown[]).length, 5);
    assert.equal(result.complete, false);
    // 受控挂点：子进程睡眠超过总预算 → SIGKILL 回收
    const started = Date.now();
    await assert.rejects(
      () => runner.run(file, validateQueryRequest({ mode: "rows", table: "todos" }), { stallMs: 10_000 }),
      (err) => err instanceof AppDataError && err.code === "query_timeout",
    );
    assert.ok(Date.now() - started < 8_000, "超时在预算附近返回");
    assert.equal(runner.inFlight, 0, "子进程已回收");
    // 超时后服务仍可用
    const again = await runner.run(file, validateQueryRequest({ mode: "schema" }));
    assert.equal(again.complete, true);
  } finally {
    await runner.dispose();
    await rm(dir, { recursive: true, force: true });
    await cleanup();
  }
});

// ---------- 集成：装配、门控、审批、恢复 ----------

function toolNamesOf(call: { tools: Array<Record<string, unknown>> | undefined }): string[] {
  return (call.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter((n) => typeof n === "string");
}

function appDataStoreOf(runtime: Runtime): AppDataStore {
  return (runtime as unknown as { appDataStore: AppDataStore }).appDataStore;
}

function appDataDbFile(dataDir: string): string {
  return path.join(path.resolve(dataDir), "agent-data", "main.db");
}

test("装配与门控：main 获得六个 app_data 工具；coding/chat/普通会话没有", async () => {
  const t = await startTestRuntime("appdata-tools", async (req) => ({
    kind: "text",
    text: `完成：${lastUserText(req).slice(0, 20)}`,
  }));
  try {
    const orch = t.runtime.orchestrator!;
    await orch.registerInboundEvent({ source: "test", externalId: "m1", targetRole: "main", body: "MAIN-MARK 整理" });
    await orch.registerInboundEvent({ source: "test", externalId: "c1", targetRole: "chat", body: "CHAT-MARK 群聊" });
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    await t.runtime.submit({ sessionId, requestId: "dev-1", input: "DEV-MARK 普通会话", modelSelection: t.runtime.defaultSelection });
    const parent = await t.runtime.submit({
      sessionId: t.runtime.store.getAgentRole("main")!.sessionId,
      requestId: "p-1",
      input: "父任务",
      modelSelection: t.runtime.defaultSelection,
    });
    await t.runtime.orchestrator!.delegate({ parentTaskId: parent.id, targetRole: "coding", input: "CODING-MARK 分析", idempotencyKey: "k1" });

    await waitFor("main 事件完成", () => t.runtime.store.getInboundEvent(t.runtime.store.findInboundEvent("test", "m1")!.id)!.status === "done");
    await waitFor("chat 事件完成", () => t.runtime.store.getInboundEvent(t.runtime.store.findInboundEvent("test", "c1")!.id)!.status === "done");
    await waitFor("coding 子任务完成", () => t.runtime.store.getTask(parent.id)!.status === "completed");
    await waitFor("coding 完成", () =>
      t.runtime.store
        .listTasksBySession(t.runtime.store.getAgentRole("coding")!.sessionId)
        .some((x) => x.status === "completed"),
    );

    const mainCall = t.server.calls.find((c) => lastUserText(c).includes("MAIN-MARK"))!;
    const mainTools = toolNamesOf(mainCall);
    assert.deepEqual(
      mainTools.filter((n) => n.startsWith("app_data_")).sort(),
      ["app_data_define_table", "app_data_delete", "app_data_insert", "app_data_migrate", "app_data_query", "app_data_update"].sort(),
    );
    const codingCall = t.server.calls.find((c) => lastUserText(c).includes("CODING-MARK"))!;
    assert.equal(toolNamesOf(codingCall).some((n) => n.startsWith("app_data_")), false, "coding 无应用数据工具");
    const chatCall = t.server.calls.find((c) => lastUserText(c).includes("CHAT-MARK"))!;
    assert.equal(toolNamesOf(chatCall).length, 0, "chat 空工具集合");
    const devCall = t.server.calls.find((c) => lastUserText(c).includes("DEV-MARK"))!;
    assert.equal(toolNamesOf(devCall).some((n) => n.startsWith("app_data_")), false, "普通开发会话无应用数据工具");
  } finally {
    await t.shutdown();
  }
});

function todoFlowResponder(): { responder: Responder; state: { step: number; queried: boolean } } {
  const state = { step: 0, queried: false };
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("TODO-FLOW")) {
      state.step += 1;
      if (state.step === 1) {
        return {
          kind: "tool_calls",
          calls: [{
            id: "d1", name: "app_data_define_table",
            arguments: {
              table: "todos",
              fields: [
                { name: "title", type: "text" },
                { name: "done", type: "boolean", nullable: true },
              ],
              expected_schema_version: 0,
              reason: "建立待办表",
            },
          }],
        };
      }
      if (state.step === 2) {
        return {
          kind: "tool_calls",
          calls: [{
            id: "i1", name: "app_data_insert",
            arguments: { table: "todos", records: [{ title: "买牛奶", done: false }], reason: "记录待办" },
          }],
        };
      }
      if (state.step === 3) {
        return {
          kind: "tool_calls",
          calls: [{ id: "q1", name: "app_data_query", arguments: { mode: "rows", table: "todos" } }],
        };
      }
      return { kind: "text", text: "done:待办流程完成" };
    }
    if (text.includes("TODO-QUERY") && !state.queried) {
      state.queried = true;
      return {
        kind: "tool_calls",
        calls: [{ id: "q2", name: "app_data_query", arguments: { mode: "rows", table: "todos", where: [{ field: "title", op: "eq", value: "买牛奶" }] } }],
      };
    }
    return { kind: "text", text: "done" };
  };
  return { responder, state };
}

test("main 经工具建表/插入/查询；跨重启读写；实例绑定稳定", async () => {
  const { dirs } = await makeTestDirs("appdata-e2e", 0);
  const server = new MockModelServer(todoFlowResponder().responder);
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  };
  let rt = await Runtime.start(config);
  try {
    const main = rt.store.getAgentRole("main")!;
    assert.ok(fs.existsSync(appDataDbFile(dirs.dataDir)), "main.db 已建立");
    assert.ok(rt.appDataStatus().available, "应用数据能力可用");
    const task = await rt.submit({ sessionId: main.sessionId, requestId: "t1", input: "TODO-FLOW", modelSelection: rt.defaultSelection });
    await waitFor("任务完成", () => rt.store.getTask(task.id)!.status === "completed");
    const ops = rt.store.listToolOpsByTask(task.id);
    assert.ok(ops.some((o) => o.toolName === "app_data_define_table" && o.resultSummary?.includes("已创建表 todos")));
    assert.ok(ops.some((o) => o.toolName === "app_data_insert" && o.resultSummary?.includes("插入 1 行")));
    assert.ok(ops.some((o) => o.toolName === "app_data_query" && o.resultSummary?.includes("买牛奶")));
    // 应用库登记到核心 meta
    const instanceId = rt.store.getMetaValue("app_data.main_instance_id");
    assert.ok(instanceId && instanceId.length > 0);
    await rt.stop("test_restart");
    rt = await Runtime.start(config);
    try {
      assert.equal(rt.store.getMetaValue("app_data.main_instance_id"), instanceId, "实例绑定跨重启稳定");
      assert.equal(appDataStoreOf(rt).getInstanceId(), instanceId);
      const main2 = rt.store.getAgentRole("main")!;
      assert.equal(main2.sessionId, main.sessionId, "main 会话身份不变");
      const task2 = await rt.submit({ sessionId: main2.sessionId, requestId: "t2", input: "TODO-QUERY", modelSelection: rt.defaultSelection });
      await waitFor("查询任务完成", () => rt.store.getTask(task2.id)!.status === "completed");
      const queryOp = rt.store.listToolOpsByTask(task2.id).find((o) => o.toolName === "app_data_query")!;
      assert.ok(queryOp.resultSummary!.includes("买牛奶"), "跨重启后业务数据可读");
      // 完整性：PRAGMA integrity_check 与 foreign_key_check
      const integrity = appDataStoreOf(rt).integrityCheck();
      assert.ok(integrity.ok, `应用库完整性：${integrity.integrity.join(",")}`);
      // 核心库预置的任务/审批/事件未被应用数据操作改变
      const coreCheck = rt.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number };
      assert.ok(Number(coreCheck.n) >= 2);
    } finally {
      await rt.stop("test_end").catch(() => {});
    }
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});

/** 造 3 行待办（define + insert），随后由 mark 指定的删除/查询脚本驱动。 */
function seedAndDeleteResponder(): Responder {
  let step = 0;
  let seeded2 = false;
  const deletedTexts = new Set<string>();
  return async (req) => {
    const text = lastUserText(req);
    if (text.includes("SEED3")) {
      step += 1;
      if (step === 1) {
        return {
          kind: "tool_calls",
          calls: [{
            id: "d1", name: "app_data_define_table",
            arguments: { table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表" },
          }],
        };
      }
      if (step === 2) {
        return {
          kind: "tool_calls",
          calls: [{
            id: "i1", name: "app_data_insert",
            arguments: {
              table: "todos",
              records: [{ title: "一" }, { title: "二" }, { title: "三" }],
              reason: "造三行",
            },
          }],
        };
      }
      return { kind: "text", text: "done:造数完成" };
    }
    if (text.includes("SEED2") && !seeded2) {
      seeded2 = true;
      return {
        kind: "tool_calls",
        calls: [{
          id: "i2", name: "app_data_insert",
          arguments: { table: "todos", records: [{ title: "四" }, { title: "五" }], reason: "补两行" },
        }],
      };
    }
    if (text.startsWith("DEL2") && !deletedTexts.has(text)) {
      deletedTexts.add(text);
      return {
        kind: "tool_calls",
        calls: [{
          id: "x1", name: "app_data_delete",
          arguments: { table: "todos", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "清理" },
        }],
      };
    }
    if (text.startsWith("DELREMAIN") && !deletedTexts.has(text)) {
      deletedTexts.add(text);
      return {
        kind: "tool_calls",
        calls: [{
          id: "x2", name: "app_data_delete",
          arguments: { table: "todos", rows: [{ id: 3, expected_version: 1 }], reason: "单行删除" },
        }],
      };
    }
    return { kind: "text", text: "done" };
  };
}

test("破坏性操作进入确认：范围/行 ID/版本固定，批准后执行一次；拒绝不执行", async () => {
  const t = await startTestRuntime("appdata-appr", seedAndDeleteResponder());
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    // 造数
    const seed = await t.runtime.submit({ sessionId: main.sessionId, requestId: "seed", input: "SEED3", modelSelection: t.runtime.defaultSelection });
    await waitFor("造数完成", () => t.runtime.store.getTask(seed.id)!.status === "completed");
    assert.equal(appStore.countRows("todos"), 3);

    // 多行删除 → 等待确认
    const del = await t.runtime.submit({ sessionId: main.sessionId, requestId: "del", input: "DEL2-APPROVE", modelSelection: t.runtime.defaultSelection });
    const conf = await pendingConfirmation(t.client, del.id);
    assert.equal(conf.toolName, "app_data_delete");
    assert.equal(conf.scope.kind, "app_data_change");
    assert.equal(conf.scope.change, "multi_row_write");
    assert.deepEqual(conf.scope.rowIds, [1, 2]);
    assert.equal(conf.scope.affected, 2);
    assert.ok(conf.scope.appDbInstanceId);
    // 批准前零变更
    assert.equal(appStore.countRows("todos"), 3);

    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("删除任务完成", () => t.runtime.store.getTask(del.id)!.status === "completed");
    assert.equal(appStore.countRows("todos"), 1, "批准后两行被删除");
    const consumed = t.runtime.store.getConfirmation(conf.id)!;
    assert.ok(consumed.consumedAt, "批准已消费");
    // 重复批准无效
    await assert.rejects(
      () => t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" }),
      /已失效|已被处理/,
    );

    // 补两行再拒绝：拒绝不执行
    const seed2 = await t.runtime.submit({ sessionId: main.sessionId, requestId: "seed2", input: "SEED2", modelSelection: t.runtime.defaultSelection });
    await waitFor("补数完成", () => t.runtime.store.getTask(seed2.id)!.status === "completed");
    assert.equal(appStore.countRows("todos"), 3);
    const del2 = await t.runtime.submit({ sessionId: main.sessionId, requestId: "del2", input: "DEL2-REJECT", modelSelection: t.runtime.defaultSelection });
    const conf2 = await pendingConfirmation(t.client, del2.id);
    await t.client.request("respond_confirmation", { confirmation_id: conf2.id, decision: "reject" });
    await waitFor("拒绝任务完成", () => t.runtime.store.getTask(del2.id)!.status === "completed");
    assert.equal(appStore.countRows("todos"), 3, "拒绝不执行");
    const delOp = t.runtime.store.listToolOpsByTask(del2.id).find((o) => o.toolName === "app_data_delete")!;
    assert.equal(delOp.isError, true);

    // 单行删除自动执行（无确认）
    const single = await t.runtime.submit({ sessionId: main.sessionId, requestId: "single", input: "DELREMAIN", modelSelection: t.runtime.defaultSelection });
    await waitFor("单行删除完成", () => t.runtime.store.getTask(single.id)!.status === "completed");
    assert.equal(t.runtime.store.listConfirmationsByTask(single.id).length, 0, "单行删除不产生审批");
    assert.equal(appStore.countRows("todos"), 2);
  } finally {
    await t.shutdown();
  }
});

test("full_access 与 auto-review 的破坏性数据操作仍需拥有者确认", async () => {
  const t = await startTestRuntime("appdata-modes", seedAndDeleteResponder());
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    const seed = await t.runtime.submit({ sessionId: main.sessionId, requestId: "seed", input: "SEED3", modelSelection: t.runtime.defaultSelection });
    await waitFor("造数完成", () => t.runtime.store.getTask(seed.id)!.status === "completed");

    // full_access：多行删除仍进入确认
    const del = await t.runtime.submit({
      sessionId: main.sessionId, requestId: "del-fa", input: "DEL2-FA",
      accessMode: "full_access", modelSelection: t.runtime.defaultSelection,
    });
    const conf = await pendingConfirmation(t.client, del.id);
    assert.equal(conf.scope.kind, "app_data_change");
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "reject" });
    await waitFor("full_access 删除任务完成", () => t.runtime.store.getTask(del.id)!.status === "completed");
    assert.equal(appStore.countRows("todos"), 3, "full_access 拒绝后不执行");

    // auto-review：转拥有者（不自动批准）
    const del2 = await t.runtime.submit({
      sessionId: main.sessionId, requestId: "del-ar", input: "DEL2-AR",
      accessMode: "auto-review", modelSelection: t.runtime.defaultSelection,
    });
    await waitFor("自动审查转人工", async () => {
      const detail = await taskStatus(t.client, del2.id);
      return detail.confirmations.some((c: any) => c.reviewStatus === "asked_owner");
    });
    const conf2 = await pendingConfirmation(t.client, del2.id);
    assert.equal(conf2.reviewStatus, "asked_owner");
    await t.client.request("respond_confirmation", { confirmation_id: conf2.id, decision: "reject" });
    await waitFor("auto-review 删除任务完成", () => t.runtime.store.getTask(del2.id)!.status === "completed");
    assert.equal(appStore.countRows("todos"), 3);
  } finally {
    await t.shutdown();
  }
});

test("确认期间版本变化使批准失效，不执行新出现的行", async () => {
  const t = await startTestRuntime("appdata-stale", seedAndDeleteResponder());
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    const seed = await t.runtime.submit({ sessionId: main.sessionId, requestId: "seed", input: "SEED3", modelSelection: t.runtime.defaultSelection });
    await waitFor("造数完成", () => t.runtime.store.getTask(seed.id)!.status === "completed");

    const del = await t.runtime.submit({ sessionId: main.sessionId, requestId: "del", input: "DEL2-STALE", modelSelection: t.runtime.defaultSelection });
    const conf = await pendingConfirmation(t.client, del.id);
    // 确认期间发生写入：revision 变化
    appStore.insert({ table: "todos", records: [{ title: "新行" }], reason: "并发写", opId: "op_concurrent", ctx: { taskId: "other", sessionId: "other", agentId: "main" } });
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("删除任务完成", () => t.runtime.store.getTask(del.id)!.status === "completed");
    const delOp = t.runtime.store.listToolOpsByTask(del.id).find((o) => o.toolName === "app_data_delete")!;
    assert.equal(delOp.isError, true);
    assert.ok(delOp.resultSummary!.includes("版本在确认期间已变化"), "陈旧批准不执行");
    assert.equal(appStore.countRows("todos"), 4, "行未被删除");
  } finally {
    await t.shutdown();
  }
});

test("伪造身份：coding 会话调用 app_data 工具不执行、不读数据（装配层即边界）", async () => {
  let queried = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("CODING-ATTACK")) {
      queried += 1;
      if (queried === 1) {
        return { kind: "tool_calls", calls: [{ id: "a1", name: "app_data_query", arguments: { mode: "rows", table: "todos" } }] };
      }
      return { kind: "text", text: "被阻止，结束" };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("appdata-forge", responder);
  try {
    // main 先写入一行私密数据
    const appStore = appDataStoreOf(t.runtime);
    appStore.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表", opId: "op_seed_f", ctx: CTX });
    appStore.insert({ table: "todos", records: [{ title: "MAIN-SECRET-9901" }], reason: "r", opId: "op_seed_f2", ctx: CTX });

    const coding = t.runtime.store.getAgentRole("coding")!;
    const task = await t.runtime.submit({ sessionId: coding.sessionId, requestId: "atk", input: "CODING-ATTACK 查数据", modelSelection: t.runtime.defaultSelection });
    await waitFor("任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    assert.ok(queried >= 1);
    // 未注册工具：SDK 直接拒绝，不产生执行意图、不读数据
    assert.equal(t.runtime.store.listToolOpsByTask(task.id).filter((o) => o.toolName === "app_data_query").length, 0, "不产生执行意图");
    assert.equal(t.runtime.store.listConfirmationsByTask(task.id).length, 0, "不产生审批");
    const history = fs.readFileSync(t.runtime.store.getSession(coding.sessionId)!.sessionFile!, "utf8");
    assert.ok(!history.includes("MAIN-SECRET-9901"), "main 数据未进入 coding 会话");
  } finally {
    await t.shutdown();
  }
});


test("核心表与内部元表无法被应用数据工具访问", async () => {
  let step = 0;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("CORE-PROBE")) {
      step += 1;
      const tables = ["tasks", "confirmations", "events", "app_audit", "app_tables", "sqlite_master"];
      if (step <= tables.length) {
        return { kind: "tool_calls", calls: [{ id: `p${step}`, name: "app_data_query", arguments: { mode: "rows", table: tables[step - 1] } }] };
      }
      return { kind: "text", text: "done" };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("appdata-core", responder);
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const task = await t.runtime.submit({ sessionId: main.sessionId, requestId: "probe", input: "CORE-PROBE", modelSelection: t.runtime.defaultSelection });
    await waitFor("探针任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    const ops = t.runtime.store.listToolOpsByTask(task.id).filter((o) => o.toolName === "app_data_query");
    assert.equal(ops.length, 6);
    for (const op of ops) {
      assert.equal(op.isError, true, `拒绝访问：${JSON.stringify(op.params).slice(0, 60)}`);
      assert.ok(op.resultSummary!.includes("表不存在"), "核心/内部表不可见");
    }
  } finally {
    await t.shutdown();
  }
});

test("批准后存储层才拒绝：错误照常经校验失败路径（留 app_data.rejected、冲突附当前版本）（架构工单 04）", async () => {
  const done = new Set<string>();
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    const once = (mark: string, call: { name: string; arguments: Record<string, unknown> }) =>
      text.includes(mark) && !done.has(mark) ? (done.add(mark), { kind: "tool_calls" as const, calls: [{ id: mark, ...call }] }) : null;
    return (
      once("SEED-T", { name: "app_data_define_table", arguments: { table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表" } }) ??
      // 审批前的范围构造不查表与版本：未知表、schema 版本冲突都在批准后由存储层发现
      once("GHOST-DEL", { name: "app_data_delete", arguments: { table: "ghosts", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "清理" } }) ??
      once("SCHEMA-DEL", { name: "app_data_delete", arguments: { table: "todos", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], expected_schema_version: 999, reason: "清理" } }) ??
      { kind: "text", text: "done" }
    );
  };
  const t = await startTestRuntime("appdata-post-approval", responder);
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const run = async (input: string) => {
      const task = await t.runtime.submit({ sessionId: main.sessionId, requestId: input, input, modelSelection: t.runtime.defaultSelection });
      const conf = input === "SEED-T" ? null : await pendingConfirmation(t.client, task.id);
      if (conf) await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
      await waitFor(`${input} 完成`, () => t.runtime.store.getTask(task.id)!.status === "completed");
      return t.runtime.store.listToolOpsByTask(task.id).find((o) => o.toolName.startsWith("app_data_"))!;
    };
    await run("SEED-T");

    const ghost = await run("GHOST-DEL");
    assert.equal(ghost.isError, true);
    const rejected = t.runtime.store.getEventsAfter(0).filter((e) => e.body.type === "app_data.rejected" && e.taskId === ghost.taskId);
    assert.equal(rejected.length, 1, "获批后的存储层拒绝留 app_data.rejected");
    assert.equal((rejected[0]!.body as any).source, "validation");

    const schema = await run("SCHEMA-DEL");
    assert.match(schema.resultSummary!, /schema 版本冲突.*（当前版本：/, "冲突附当前版本");
  } finally {
    await t.shutdown();
  }
});

test("main 工具校验失败留 app_data.rejected 事件；恶意表名拒绝", async () => {
  let badCalled = false;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("BAD-NAME") && !badCalled) {
      badCalled = true;
      return {
        kind: "tool_calls",
        calls: [{
          id: "b1", name: "app_data_define_table",
          arguments: { table: "app_tables", fields: [{ name: "x", type: "text" }], expected_schema_version: 0, reason: "注入" },
        }],
      };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("appdata-badname", responder);
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    const task = await t.runtime.submit({ sessionId: main.sessionId, requestId: "bad", input: "BAD-NAME", modelSelection: t.runtime.defaultSelection });
    await waitFor("任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    const rejected = t.runtime.store.getEventsAfter(0).filter((e) => e.body.type === "app_data.rejected");
    assert.ok(rejected.length >= 1, "校验失败留事件");
    assert.ok(rejected.every((e) => (e.body as any).source === "validation"));
    // 目录未被污染
    assert.equal(appStore.getTable("app_tables"), null);
    const check = appStore.listTables();
    assert.equal(check.length, 0);
  } finally {
    await t.shutdown();
  }
});

test("审计失败回滚业务变更：不留部分写入", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    store.faultNextWrite = new Error("disk full");
    assert.throws(() => store.insert({ table: "todos", records: [{ title: "a" }], reason: "r", opId: "op_f", ctx: CTX }), /disk full/);
    assert.equal(store.countRows("todos"), 0, "业务变更回滚");
    assert.equal(store.getReceipt("op_f"), null, "无审计回执");
    assert.deepEqual(store.getVersions(), { schemaVersion: 1, revision: 1 }, "版本不推进");
  } finally {
    await cleanup();
  }
});

test("停止路径：应用数据写操作按回执核实，不误标 effect_unknown", async () => {
  let delCalled = false;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("DEL2-STOP") && !delCalled) {
      delCalled = true;
      return {
        kind: "tool_calls",
        calls: [{
          id: "x1", name: "app_data_delete",
          arguments: { table: "todos", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "清理" },
        }],
      };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("appdata-stop", responder);
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    appStore.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表", opId: "op_pre", ctx: CTX });
    appStore.insert({ table: "todos", records: [{ title: "一" }, { title: "二" }], reason: "造数", opId: "op_pre2", ctx: CTX });
    // 任务进入等待确认（保持活动），期间模拟"应用库已提交、核心结果未记录"的在途操作
    const task = await t.runtime.submit({ sessionId: main.sessionId, requestId: "stop1", input: "DEL2-STOP", modelSelection: t.runtime.defaultSelection });
    await waitFor("任务等待确认", () => t.runtime.store.getTask(task.id)!.status === "awaiting_confirmation");
    t.runtime.store.withTx(() => {
      t.runtime.store.recordToolIntent({ id: "op_inflight", taskId: task.id, sessionId: main.sessionId, toolName: "app_data_insert", params: { table: "todos" } });
    });
    appStore.insert({ table: "todos", records: [{ title: "已提交" }], reason: "r", opId: "op_inflight", ctx: CTX });
    await t.runtime.stop("test_restart");
    // stop 后重开核心库读结果
    const db = new (await import("../src/core/db.ts")).Db(t.dirs.dataDir);
    try {
      const op = db.prepare("SELECT result_summary, is_error, effect_unknown FROM tool_ops WHERE id = 'op_inflight'").get() as any;
      assert.ok(op.result_summary.includes("已提交"), "回执补记已提交");
      assert.equal(Number(op.is_error), 0);
      assert.equal(Number(op.effect_unknown), 0, "不标未知效果");
      // 等待确认中的删除：批准未消费 → 已知未执行，行保留
      const delOp = db.prepare("SELECT result_summary, is_error FROM tool_ops WHERE task_id = ? AND tool_name = 'app_data_delete'").get(task.id) as any;
      assert.ok(delOp.result_summary.includes("未执行") || delOp.result_summary.includes("未提交"), "未消费的批准不执行");
    } finally {
      db.close();
    }
  } finally {
    await t.shutdown();
  }
});


test("恢复：回执补记已提交 / 无回执记未提交 / 应用库丢失保留未知效果", async () => {
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  const configFor = (dirs: { dataDir: string; agentDir: string; root: string }): RuntimeConfig => ({
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  });
  /** 构造崩溃现场：running 任务 + 未落结果的应用数据操作（可选回执）。 */
  const seedCrash = async (prefix: string, withReceipt: boolean): Promise<{ dirs: TestDirsLike; config: RuntimeConfig }> => {
    const { dirs } = await makeTestDirs(prefix, 0);
    await writeModelsJson(dirs, baseUrl);
    const config = configFor(dirs);
    const rt = await Runtime.start(config);
    const main = rt.store.getAgentRole("main")!;
    await rt.stop("prep");
    const { Db } = await import("../src/core/db.ts");
    const db = new Db(dirs.dataDir);
    try {
      db.prepare(
        `INSERT INTO tasks (id, session_id, request_id, input, status, access_mode, permission_version, granted_paths,
           cancel_requested, effect_unknown, history_entry_ids, created_at, agent_id)
         VALUES ('task_crash', ?, 'req_crash', '崩溃任务', 'running', 'confirm', 1, '[]', 0, 0, '[]', ?, 'main')`,
      ).run(main.sessionId, new Date().toISOString());
      db.prepare(
        `INSERT INTO tool_ops (id, task_id, tool_name, params, intent_recorded_at, effect_unknown)
         VALUES ('op_crash', 'task_crash', 'app_data_insert', '{}', ?, 0)`,
      ).run(new Date().toISOString());
      db.prepare(
        `INSERT INTO tool_ops (id, task_id, tool_name, params, intent_recorded_at, effect_unknown)
         VALUES ('op_crash_query', 'task_crash', 'app_data_query', '{}', ?, 0)`,
      ).run(new Date().toISOString());
    } finally {
      db.close();
    }
    const app = new AppDataStore(appDataDbFile(dirs.dataDir));
    try {
      app.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表", opId: "op_seed_c", ctx: { taskId: "task_crash", sessionId: main.sessionId, agentId: "main" } });
      if (withReceipt) {
        app.insert({ table: "todos", records: [{ title: "崩溃前已提交" }], reason: "r", opId: "op_crash", ctx: { taskId: "task_crash", sessionId: main.sessionId, agentId: "main" } });
      }
    } finally {
      app.close();
    }
    return { dirs, config };
  };
  type TestDirsLike = Awaited<ReturnType<typeof makeTestDirs>>["dirs"];
  try {
    // 场景 1：有回执 → 补记已提交
    {
      const { dirs, config } = await seedCrash("appdata-rcv1", true);
      const rt = await Runtime.start(config);
      try {
        const op = rt.store.getToolOp("op_crash")!;
        assert.ok(op.resultSummary!.includes("已提交"), "回执存在：补记已提交");
        assert.equal(op.effectUnknown, false);
        assert.equal(appDataStoreOf(rt).countRows("todos"), 1, "业务行确实落库");
        const task = rt.store.getTask("task_crash")!;
        assert.equal(task.status, "interrupted");
        assert.equal(task.effectUnknown, false);
        const resultEvents = () =>
          rt.store.getEventsAfter(0).filter((e) => e.body.type === "task.tool_result" && (e.body as any).toolOpId === "op_crash");
        assert.equal(resultEvents().length, 1);
        await rt.stop("s1");
        // 重复恢复不重复发布（tool_ops 条件更新幂等）
        const rt2 = await Runtime.start(config);
        try {
          const events2 = rt2.store.getEventsAfter(0).filter((e) => e.body.type === "task.tool_result" && (e.body as any).toolOpId === "op_crash");
          assert.equal(events2.length, 1, "重复恢复不重复补记");
        } finally {
          await rt2.stop("s1b");
        }
      } finally {
        await cleanupDirs(dirs);
      }
    }
    // 场景 2：无回执（批准消费但未提交）→ 记未提交
    {
      const { dirs, config } = await seedCrash("appdata-rcv2", false);
      const rt = await Runtime.start(config);
      try {
        const op = rt.store.getToolOp("op_crash")!;
        assert.ok(op.resultSummary!.includes("已知未提交"), "无回执：记未提交");
        assert.equal(op.effectUnknown, false);
        assert.equal(appDataStoreOf(rt).countRows("todos"), 0);
        // 只读查询：不误标未知写入效果，按「无写入效果」补记
        const queryOp = rt.store.getToolOp("op_crash_query")!;
        assert.ok(queryOp.resultSummary!.includes("无写入效果"), "只读查询按无写入效果补记");
        assert.equal(queryOp.effectUnknown, false);
      } finally {
        await rt.stop("s2");
        await cleanupDirs(dirs);
      }
    }
    // 场景 3：应用库丢失 → 能力停止，保留未知效果
    {
      const { dirs, config } = await seedCrash("appdata-rcv3", true);
      fs.rmSync(appDataDbFile(dirs.dataDir));
      const rt = await Runtime.start(config);
      try {
        const op = rt.store.getToolOp("op_crash")!;
        assert.equal(op.resultSummary, null, "无法核实：结果仍缺失");
        assert.equal(op.effectUnknown, true, "保留未知效果");
        const unavailable = rt.store.getEventsAfter(0).filter((e) => e.body.type === "app_data.unavailable");
        assert.ok(unavailable.length >= 1, "应用库丢失留 unavailable 事件");
        assert.equal(rt.appDataStatus().available, false);
      } finally {
        await rt.stop("s3");
        await cleanupDirs(dirs);
      }
    }
    // 场景 4：应用库损坏（不可读）→ 能力停止，保留未知效果，不重建
    {
      const { dirs, config } = await seedCrash("appdata-rcv4", true);
      fs.writeFileSync(appDataDbFile(dirs.dataDir), Buffer.from("not a sqlite database".repeat(64)));
      const rt = await Runtime.start(config);
      try {
        const op = rt.store.getToolOp("op_crash")!;
        assert.equal(op.resultSummary, null, "无法核实：结果仍缺失");
        assert.equal(op.effectUnknown, true, "保留未知效果");
        assert.equal(rt.appDataStatus().available, false);
        assert.match(rt.appDataStatus().reason ?? "", /不可用|损坏|failed/i);
        // 损坏文件保留原位（不重建、不清空）
        assert.ok(fs.readFileSync(appDataDbFile(dirs.dataDir)).toString("utf8").startsWith("not a sqlite"));
      } finally {
        await rt.stop("s4");
        await cleanupDirs(dirs);
      }
    }
  } finally {
    await server.close();
  }
});


test("应用库实例身份不符：能力停止并保留未知效果（不覆盖既有绑定）", async () => {
  const { dirs } = await makeTestDirs("appdata-identity", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  };
  try {
    let rt = await Runtime.start(config);
    const genuine = rt.store.getMetaValue("app_data.main_instance_id");
    assert.ok(genuine);
    // 篡改登记：身份不符
    rt.store.withTx(() => rt.store.setMetaValue("app_data.main_instance_id", `appdb_${"0".repeat(36)}`));
    await rt.stop("tamper");

    rt = await Runtime.start(config);
    try {
      assert.equal(rt.appDataStatus().available, false);
      assert.match(rt.appDataStatus().reason ?? "", /标识与登记不符/);
      const events = rt.store.getEventsAfter(0).filter((e) => e.body.type === "app_data.unavailable");
      assert.ok(events.length >= 1);
      // 不覆盖既有实例绑定：登记仍是篡改值（由拥有者处理），应用库文件未被重建
      assert.equal(rt.store.getMetaValue("app_data.main_instance_id"), `appdb_${"0".repeat(36)}`);
      assert.ok(fs.existsSync(appDataDbFile(dirs.dataDir)), "旧库保留");
    } finally {
      await rt.stop("end");
    }
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("既有 main 角色重启：角色记录里的工具清单副本不影响装配，项目/会话/工作目录/模型绑定不变", async () => {
  const { dirs } = await makeTestDirs("appdata-upgrade", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  };
  try {
    let rt = await Runtime.start(config);
    const before = rt.store.getAgentRole("main")!;
    // 模拟早期版本留下的 main 记录（清单副本无 app_data）；工具类别以代码里的会话类别清单为准
    rt.store.db.prepare("UPDATE agent_roles SET tools = ? WHERE id = 'main'").run(JSON.stringify(["host_data", "web_search"]));
    await rt.stop("pre-upgrade");

    rt = await Runtime.start(config);
    try {
      const after = rt.store.getAgentRole("main")!;
      const task = await rt.submit({ sessionId: after.sessionId, requestId: "after-upgrade", input: "UPGRADE-MARK", modelSelection: rt.defaultSelection });
      await waitFor("main 任务完成", () => rt.store.getTask(task.id)!.status === "completed");
      const call = server.calls.find((c) => lastUserText(c).includes("UPGRADE-MARK"))!;
      assert.ok(toolNamesOf(call).includes("app_data_query"), "旧副本不含 app_data，main 照样装配应用数据工具");
      assert.equal(after.projectId, before.projectId);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.workDir, before.workDir);
      assert.deepEqual(after.modelSelection, before.modelSelection);
      // 再重启一次：身份幂等，角色记录不再被改写
      await rt.stop("again");
      rt = await Runtime.start(config);
      const again = rt.store.getAgentRole("main")!;
      assert.deepEqual(again.tools, after.tools);
      assert.equal(again.sessionId, before.sessionId);
    } finally {
      await rt.stop("end").catch(() => {});
    }
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("查询阻塞期间控制面请求仍能应答；超时后任务以错误收尾", async () => {
  let queried = false;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("SLOW-QUERY") && !queried) {
      queried = true;
      return { kind: "tool_calls", calls: [{ id: "q1", name: "app_data_query", arguments: { mode: "schema" } }] };
    }
    return { kind: "text", text: "done" };
  };
  // 受控挂点：查询子进程睡眠 5s（超过 2s 总预算）
  const t = await startTestRuntime("appdata-stall", responder, { config: { appData: { queryStallMs: 5000 } } });
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    appStore.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表", opId: "op_pre_s", ctx: CTX });
    const task = await t.runtime.submit({ sessionId: main.sessionId, requestId: "slow", input: "SLOW-QUERY", modelSelection: t.runtime.defaultSelection });
    await waitFor("任务运行中", () => t.runtime.store.getTask(task.id)!.status === "running");
    // 查询子进程阻塞期间，控制面请求正常应答
    const started = Date.now();
    const detail = await t.client.request<any>("get_task", { task_id: task.id });
    assert.ok(detail.task.id === task.id, "控制面在查询阻塞期间应答");
    assert.ok(Date.now() - started < 1500, "控制面应答不被阻塞");
    // 查询超时：子进程被终止，工具以错误收尾，任务完成
    await waitFor("任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed", 20_000);
    const queryOp = t.runtime.store.listToolOpsByTask(task.id).find((o) => o.toolName === "app_data_query")!;
    assert.equal(queryOp.isError, true);
    assert.ok(queryOp.resultSummary!.includes("子进程已终止"), "超时如实报告");
    const rejected = t.runtime.store.getEventsAfter(0).filter((e) => e.body.type === "app_data.rejected" && (e.body as any).source === "timeout");
    assert.equal(rejected.length, 1, "超时留 app_data.rejected 事件");
  } finally {
    await t.shutdown();
  }
});

// ---------- 评审修复回归（提交 b008508 评审：2×P1 + 5×P2） ----------

test("P1：连续空窗口后游标仍推进——稀疏命中在候选预算边界后可达", async () => {
  const { store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    // 1,100 行，仅最后一行匹配（候选预算 1,000）
    for (let i = 0; i < 1100; i += 100) {
      store.insert({
        table: "todos",
        records: Array.from({ length: 100 }, (_, j) => ({ title: `t-${i + j}`, done: i + j === 1099 })),
        reason: "造数",
        opId: `op_s${i}`,
        ctx: CTX,
      });
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 10; ) {
      pages += 1;
      const result = runQuery(store, validateQueryRequest({
        mode: "rows", table: "todos", fields: ["title"],
        where: [{ field: "done", op: "eq", value: true }],
        cursor,
      }));
      for (const row of result.rows as Array<{ _id: number }>) seen.push(row._id);
      if (result.complete) break;
      cursor = result.next_cursor as string;
      assert.ok(cursor, `第 ${pages} 页不完整必须带游标`);
    }
    assert.deepEqual(seen, [1100], "唯一匹配行（最后一行）可达");
    assert.ok(pages >= 2, "空窗口页也推进");
  } finally {
    await cleanup();
  }
});

test("P2：结果预算截断时不越过未返回的匹配行（与候选推进并存）", async () => {
  const { store, cleanup } = await tempStore();
  try {
    store.defineTable({
      table: "wide",
      fields: [{ name: "a", type: "text" }, { name: "b", type: "text" }, { name: "c", type: "text" }, { name: "d", type: "text" }],
      expected_schema_version: 0,
      reason: "大行表",
      opId: "op_w",
      ctx: CTX,
    });
    const chunk = "7".repeat(7 * 1024);
    for (const opId of ["op_w1", "op_w2", "op_w3"]) {
      store.insert({ table: "wide", records: [{ a: chunk, b: chunk, c: chunk, d: chunk }], reason: "造数", opId, ctx: CTX });
    }
    // 三行各约 28 KiB：第一页返回两行，第三行（已匹配但未返回）留给下一页
    const page1 = runQuery(store, validateQueryRequest({ mode: "rows", table: "wide", limit: 100 }));
    assert.equal((page1.rows as unknown[]).length, 2);
    assert.equal(page1.complete, false);
    const page2 = runQuery(store, validateQueryRequest({ mode: "rows", table: "wide", limit: 100, cursor: page1.next_cursor as string }));
    assert.deepEqual((page2.rows as Array<{ _id: number }>).map((r) => r._id), [3], "未返回的匹配行不丢");
    assert.equal(page2.complete, true);
  } finally {
    await cleanup();
  }
});

test("P2：update/rewrite_rows 合并后整行超 32 KiB 被拒绝并整体回滚", async () => {
  const { store, cleanup } = await tempStore();
  try {
    store.defineTable({
      table: "docs",
      fields: [
        { name: "a", type: "text", nullable: true },
        { name: "b", type: "text", nullable: true },
        { name: "c", type: "text", nullable: true },
        { name: "d", type: "text", nullable: true },
        { name: "e", type: "text", nullable: true },
      ],
      expected_schema_version: 0,
      reason: "文档表",
      opId: "op_d",
      ctx: CTX,
    });
    store.insert({ table: "docs", records: [{ a: "1".repeat(16 * 1024 - 100) }], reason: "r", opId: "op_di", ctx: CTX });
    // 逐字段写入合法值，合并后整行将超 32 KiB
    store.updateRows({ table: "docs", rows: [{ id: 1, expected_version: 1, set: { b: "2".repeat(16 * 1024 - 100) } }], reason: "r", opId: "op_du1", ctx: CTX });
    const before = store.getVersions();
    const beforeRow = store.getRow(store.getTable("docs")!, 1)!;
    assert.throws(
      () => store.updateRows({ table: "docs", rows: [{ id: 1, expected_version: 2, set: { c: "3".repeat(16 * 1024 - 100) } }], reason: "r", opId: "op_du2", ctx: CTX }),
      (err) => err instanceof AppDataError && err.code === "row_too_large",
    );
    assert.deepEqual(store.getVersions(), before, "revision 不推进");
    assert.deepEqual(store.getRow(store.getTable("docs")!, 1), beforeRow, "行内容不变");
    assert.equal(store.getReceipt("op_du2"), null, "无审计回执");
    // rewrite_rows 同一路径
    assert.throws(
      () =>
        store.migrate({
          expected_schema_version: 1,
          steps: [{ op: "rewrite_rows", table: "docs", rows: [{ id: 1, expected_version: 2, set: { c: "3".repeat(16 * 1024 - 100) } }] }],
          reason: "重写",
          opId: "op_rw",
          ctx: CTX,
        }),
      (err) => err instanceof AppDataError && err.code === "row_too_large",
    );
    assert.deepEqual(store.getVersions(), before);
  } finally {
    await cleanup();
  }
});

test("P2：既有库缺失审计表即损坏——停止能力，不静默重建", async () => {
  const { dir, store, cleanup } = await tempStore();
  try {
    defineTodos(store, "op_c");
    store.insert({ table: "todos", records: [{ title: "a" }], reason: "r", opId: "op_i", ctx: CTX });
    store.close();
    // 移除审计表（模拟不完整恢复/损坏）
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path.join(dir, "main.db"));
    raw.exec("DROP TABLE app_audit");
    raw.close();
    assert.throws(
      () => new AppDataStore(path.join(dir, "main.db")),
      (err) => err instanceof AppDataError && err.code === "storage_corrupt",
    );
    // 业务行仍在（文件未被重建/清空）
    const raw2 = new DatabaseSync(path.join(dir, "main.db"));
    const n = raw2.prepare("SELECT COUNT(*) AS n FROM todos").get() as { n: number };
    assert.equal(Number(n.n), 1);
    raw2.close();
  } finally {
    await cleanup();
  }
});

test("P2：op_id 经工具入口过滤审计；schema 分页输出带继续游标", async () => {
  let step = 0;
  let secondCursor: string | null = null;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("AUDIT-LOOKUP")) {
      step += 1;
      if (step === 1) {
        return { kind: "tool_calls", calls: [{ id: "c1", name: "app_data_query", arguments: { mode: "changes", op_id: "op_known" } }] };
      }
      if (step === 2) {
        return { kind: "tool_calls", calls: [{ id: "c2", name: "app_data_query", arguments: { mode: "changes", op_id: "op_missing" } }] };
      }
      if (step === 3) {
        return { kind: "tool_calls", calls: [{ id: "c3", name: "app_data_query", arguments: { mode: "schema", limit: 1 } }] };
      }
      if (step === 4) {
        // 从上一页工具输出提取游标继续（验证输出确实可遍历）
        const serialized = JSON.stringify(req.messages);
        const m = serialized.match(/next_cursor=([a-z0-9_]+)/);
        secondCursor = m?.[1] ?? null;
        return { kind: "tool_calls", calls: [{ id: "c4", name: "app_data_query", arguments: { mode: "schema", limit: 1, cursor: secondCursor } }] };
      }
      return { kind: "text", text: "done" };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("appdata-opid", responder);
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    // 造三张表 + 一条已知回执
    for (const name of ["table_a", "table_b", "table_c"]) {
      appStore.defineTable({
        table: name, fields: [{ name: "f", type: "text" }],
        expected_schema_version: appStore.getVersions().schemaVersion, reason: "建表",
        opId: `op_mk_${name}`, ctx: CTX,
      });
    }
    appStore.insert({ table: "table_a", records: [{ f: "x" }], reason: "r", opId: "op_known", ctx: CTX });

    const task = await t.runtime.submit({ sessionId: main.sessionId, requestId: "audit", input: "AUDIT-LOOKUP", modelSelection: t.runtime.defaultSelection });
    await waitFor("任务完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
    const ops = t.runtime.store.listToolOpsByTask(task.id).filter((o) => o.toolName === "app_data_query");
    assert.equal(ops.length, 4);
    // op_id 过滤：只返回指定操作的回执
    assert.ok(ops[0]!.resultSummary!.includes("op_known"), "按 op_id 命中");
    assert.ok(!ops[0]!.resultSummary!.includes("op_mk_table_a"), "不混入其他操作");
    // 不存在的 op_id：明确错误
    assert.equal(ops[1]!.isError, true);
    assert.ok(ops[1]!.resultSummary!.includes("没有该操作的审计回执"));
    // schema 分页：第一页带 next_cursor，第二页含下一张表
    assert.ok(ops[2]!.resultSummary!.includes("next_cursor=table_a"), "schema 分页输出继续游标");
    assert.ok(ops[2]!.resultSummary!.includes("table_a") && !ops[2]!.resultSummary!.includes("table_b"));
    assert.ok(secondCursor === "table_a", "模型侧从输出取到游标");
    assert.ok(ops[3]!.resultSummary!.includes("table_b"), "游标翻页有效");
  } finally {
    await t.shutdown();
  }
});

test("P1：终态任务缺结果的应用数据操作在重启时按回执补记", async () => {
  const { dirs } = await makeTestDirs("appdata-terminal", 0);
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  await writeModelsJson(dirs, baseUrl);
  const config: RuntimeConfig = {
    dataDir: dirs.dataDir,
    agentDir: dirs.agentDir,
    socketPath: path.join(dirs.root, "c.sock"),
    thinkingLevel: "off",
    modelProvider: "mock",
    modelId: "mock-model",
    toolFactory: (ctx) => createMockTools(ctx),
  };
  try {
    let rt = await Runtime.start(config);
    const main = rt.store.getAgentRole("main")!;
    await rt.stop("prep");
    // 构造"任务已完成、核心结果缺失、应用库已提交"的现场（连续落盘失败的终态）
    const { Db } = await import("../src/core/db.ts");
    const db = new Db(dirs.dataDir);
    try {
      db.prepare(
        `INSERT INTO tasks (id, session_id, request_id, input, status, access_mode, permission_version, granted_paths,
           cancel_requested, effect_unknown, history_entry_ids, created_at, started_at, ended_at, agent_id)
         VALUES ('task_done', ?, 'req_done', '已完成任务', 'completed', 'confirm', 1, '[]', 0, 0, '[]', ?, ?, ?, 'main')`,
      ).run(main.sessionId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      db.prepare(
        `INSERT INTO tool_ops (id, task_id, tool_name, params, intent_recorded_at, effect_unknown)
         VALUES ('op_done', 'task_done', 'app_data_insert', '{}', ?, 0)`,
      ).run(new Date().toISOString());
    } finally {
      db.close();
    }
    const app = new AppDataStore(appDataDbFile(dirs.dataDir));
    try {
      app.defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表", opId: "op_seed_t", ctx: { taskId: "task_done", sessionId: main.sessionId, agentId: "main" } });
      app.insert({ table: "todos", records: [{ title: "已提交" }], reason: "r", opId: "op_done", ctx: { taskId: "task_done", sessionId: main.sessionId, agentId: "main" } });
    } finally {
      app.close();
    }
    rt = await Runtime.start(config);
    try {
      const op = rt.store.getToolOp("op_done")!;
      assert.ok(op.resultSummary!.includes("已提交"), "终态任务的缺失结果按回执补记");
      assert.equal(op.effectUnknown, false);
      assert.equal(rt.store.getTask("task_done")!.effectUnknown, false);
    } finally {
      await rt.stop("end");
    }
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});

test("P1：核心结果写入失败时立即按回执核实（不等到重启）", async () => {
  const responder = seedAndDeleteResponder();
  const t = await startTestRuntime("appdata-writefail", responder);
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    const appStore = appDataStoreOf(t.runtime);
    const seed = await t.runtime.submit({ sessionId: main.sessionId, requestId: "seed", input: "SEED3", modelSelection: t.runtime.defaultSelection });
    await waitFor("造数完成", () => t.runtime.store.getTask(seed.id)!.status === "completed");

    const del = await t.runtime.submit({ sessionId: main.sessionId, requestId: "del", input: "DEL2-APPROVE", modelSelection: t.runtime.defaultSelection });
    const conf = await pendingConfirmation(t.client, del.id);
    // 确定性故障注入：approval_consumed 事件提交（consume 事务落盘）的同一同步
    // 窗口内设置核心库写失败——下一次核心写就是该工具的结果落盘
    const origBroadcast = t.runtime.store.onCommitted;
    t.runtime.store.onCommitted = (events) => {
      origBroadcast?.(events);
      if (events.some((e) => e.body.type === "task.approval_consumed" && (e.body as any).confirmationId === conf.id)) {
        t.runtime.store.db.faultNextWrite = new Error("injected core write failure");
      }
    };
    await t.client.request("respond_confirmation", { confirmation_id: conf.id, decision: "approve" });
    await waitFor("删除任务完成", () => t.runtime.store.getTask(del.id)!.status === "completed");
    const delOp = t.runtime.store.listToolOpsByTask(del.id).find((o) => o.toolName === "app_data_delete")!;
    assert.ok(delOp.resultSummary !== null, "结果写入失败后立即补记，不留缺失");
    assert.ok(delOp.resultSummary!.includes("已提交"), "按回执核实为已提交");
    assert.equal(delOp.effectUnknown, false);
    assert.equal(appStore.countRows("todos"), 1, "应用库变更已生效");
  } finally {
    await t.shutdown();
  }
});

test("P2：停止在途只读查询不标 effect_unknown", async () => {
  let queried = false;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("SLOW-STOP") && !queried) {
      queried = true;
      return { kind: "tool_calls", calls: [{ id: "q1", name: "app_data_query", arguments: { mode: "schema" } }] };
    }
    return { kind: "text", text: "done" };
  };
  const t = await startTestRuntime("appdata-qstop", responder, { config: { appData: { queryStallMs: 30_000 } } });
  try {
    const main = t.runtime.store.getAgentRole("main")!;
    appDataStoreOf(t.runtime).defineTable({ table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "建表", opId: "op_pre_q", ctx: CTX });
    const task = await t.runtime.submit({ sessionId: main.sessionId, requestId: "qs", input: "SLOW-STOP", modelSelection: t.runtime.defaultSelection });
    await waitFor("查询在途", () =>
      t.runtime.store.listToolOpsByTask(task.id).some((o) => o.toolName === "app_data_query"),
    );
    await t.runtime.stop("test_restart");
    const db = new (await import("../src/core/db.ts")).Db(t.dirs.dataDir);
    try {
      const op = db.prepare("SELECT result_summary, effect_unknown FROM tool_ops WHERE task_id = ? AND tool_name = 'app_data_query'").get(task.id) as any;
      assert.ok(op, "查询操作已记录");
      assert.equal(Number(op.effect_unknown), 0, "只读查询不标未知效果");
      assert.ok(op.result_summary !== null, "结果已补记（超时结果或已知未执行）");
    } finally {
      db.close();
    }
  } finally {
    await t.shutdown();
  }
});
