/**
 * 架构工单 05：工具操作账本（直接构造 Store 与假族核实，重启回归起真实 Runtime）。
 *
 * - 结果与事件成对、同一句，重复补记不重发；标效果未知幂等并写任务标记；
 * - 分类器（停止与重启同一个）：审批未消费 → 无写入效果 → 族核实 → 效果未知；
 * - 停止：中止前快照只含按审批判定且执行可能已开始的操作，快照内操作中止期间
 *   落了结果仍标未知；快照外、中止期间批准被消费而无结果的操作也标未知；
 * - 重启：覆盖全部任务（含终态）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import type { ApprovalScope } from "../src/core/types.ts";
import { ToolOpLedger, hasNoWriteEffect, type FamilyCheck } from "../src/agent/tool-op-ledger.ts";
import { APP_DATA_LEDGER } from "../src/agent/app-data/tools.ts";
import { SCHEDULER_LEDGER } from "../src/agent/scheduler-tools.ts";
import { CHAT_RESULT_LEDGER } from "../src/agent/chat-result-tools.ts";
import { WEB_SEARCH_LEDGER } from "../src/agent/web-search.ts";
import { HOST_DATA_LEDGER } from "../src/agent/host-tools.ts";
import { Runtime, type RuntimeConfig } from "../src/runtime/runtime.ts";
import { createMockTools } from "../src/agent/mock-tools.ts";
import { MockModelServer } from "./helpers/mock-provider.ts";
import { cleanupDirs, makeTestDirs, writeModelsJson } from "./helpers/testkit.ts";

const SCOPE: ApprovalScope = { kind: "tool", workspaceOnly: true };

function fakeFamily(verdict: "committed" | "not_committed" | "unverifiable"): FamilyCheck {
  return { verify: () => verdict, committed: (when) => `已提交：假账本（${when}）`, notCommitted: (when) => `已知未提交：假账本（${when}）` };
}

function kit(families: ConstructorParameters<typeof ToolOpLedger>[1] = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ledger-"));
  const db = new Db(root);
  const store = new Store(db);
  const ledger = new ToolOpLedger(store, families, [APP_DATA_LEDGER, SCHEDULER_LEDGER, CHAT_RESULT_LEDGER]);
  const project = store.createProject("p");
  const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi-1", confirmTools: [] });
  let n = 0;
  const newTask = (status: "running" | "completed" = "running") => {
    const { task } = store.insertQueuedTask({
      sessionId: session.id,
      requestId: `r${++n}`,
      input: "x",
      modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" },
      submissionDigest: `r${n}`,
    });
    store.transitionTask(task.id, ["queued"], "running", {});
    if (status === "completed") store.transitionTask(task.id, ["running"], "completed", { endedAt: new Date().toISOString() });
    return store.getTask(task.id)!;
  };
  const task = newTask();
  /** 记录执行意图；approval 给出时登记审批（consumed = 批准并消费）。 */
  const op = (toolName: string, params: Record<string, unknown> = {}, opts: { approval?: "pending" | "consumed"; taskId?: string } = {}) => {
    const id = `op_${++n}`;
    const taskId = opts.taskId ?? task.id;
    store.withTx(() => store.recordToolIntent({ id, taskId, sessionId: session.id, toolName, params }));
    if (opts.approval) {
      const c = store.withTx(() => store.createConfirmation({ taskId, sessionId: session.id, toolOpId: id, toolName, params, scope: SCOPE, permissionVersion: 1 }));
      if (opts.approval === "consumed") {
        store.withTx(() => store.respondConfirmation(c.id, "approved", { source: "owner" }));
        assert.ok(store.withTx(() => store.consumeApproval({ confirmationId: c.id, expectedPermissionVersion: 1, activeStatuses: ["running", "awaiting_confirmation"] })));
      }
    }
    return id;
  };
  const get = (id: string) => store.getToolOp(id)!;
  const events = (type: string, opId: string) =>
    store.getEventsAfter(0).filter((e) => e.body.type === type && (e.body as any).toolOpId === opId);
  const cleanup = () => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { store, ledger, task, newTask, op, get, events, cleanup };
}

test("配对：结果与事件同一句、重复补记不重发；标效果未知幂等并写任务标记", () => {
  const k = kit();
  try {
    const id = k.op("bash");
    assert.equal(k.store.withTx(() => k.ledger.recordResult(k.task, id, "已完成", false)), true);
    assert.equal(k.store.withTx(() => k.ledger.recordResult(k.task, id, "另一句", true)), false, "以先写者为准");
    assert.equal(k.get(id).resultSummary, "已完成");
    const results = k.events("task.tool_result", id);
    assert.equal(results.length, 1);
    assert.equal((results[0]!.body as any).summary, "已完成", "落库与事件同一句");

    const other = k.op("bash");
    assert.equal(k.store.withTx(() => k.ledger.markEffectUnknown(k.task, other)), true);
    assert.equal(k.store.withTx(() => k.ledger.markEffectUnknown(k.task, other)), false);
    assert.equal(k.get(other).effectUnknown, true);
    assert.equal(k.events("task.tool_effect_unknown", other).length, 1);
    assert.equal(k.store.getTask(k.task.id)!.effectUnknown, true, "任务标记");
  } finally {
    k.cleanup();
  }
});

test("分类器：审批未消费 → 无写入效果 → 族核实 → 效果未知（重启）", () => {
  const k = kit({ app_data: fakeFamily("committed"), scheduler: fakeFamily("not_committed"), delegation: fakeFamily("unverifiable") });
  try {
    const read = k.op("read");
    const get = k.op("http_request", { method: "get", url: "https://x" });
    const post = k.op("http_request", { method: "POST", url: "https://x" }, { approval: "consumed" });
    const fileRead = k.op("request_file_access", { path: "/a", operation: "read" }, { approval: "consumed" });
    const fileWrite = k.op("request_file_access", { path: "/a", operation: "write" }, { approval: "pending" });
    const fileReadPending = k.op("request_file_access", { path: "/a", operation: "read" }, { approval: "pending" });
    const appDelete = k.op("app_data_delete", {}, { approval: "pending" });
    const appInsert = k.op("app_data_insert");
    const schedule = k.op("schedule_create");
    const delegate = k.op("coding_delegate", { key: "k" });
    const mcp = k.op("mcp_svc_write");
    const bash = k.op("bash");
    k.store.withTx(() => k.ledger.settleAll());

    for (const id of [read, get, fileRead]) {
      assert.equal(k.get(id).resultSummary, "未完成：只读操作在后台重启前中止，无写入效果");
      assert.equal(k.get(id).effectUnknown, false);
    }
    assert.equal(k.get(fileWrite).resultSummary, "已知未执行：审批未消费即发生后台重启（批准不跨重启执行）");
    assert.equal(k.get(fileReadPending).resultSummary, "已知未执行：审批未消费即发生后台重启（批准不跨重启执行）", "审批未消费优先于无写入效果");
    assert.equal(k.get(appDelete).resultSummary, "已知未执行：审批未消费即发生后台重启（批准不跨重启执行）", "审批未消费优先于族核实");
    assert.equal(k.get(appInsert).resultSummary, "已提交：假账本（后台重启前）");
    assert.equal(k.get(appInsert).isError, false);
    assert.equal(k.get(schedule).resultSummary, "已知未提交：假账本（后台重启前）");
    assert.equal(k.get(schedule).isError, true);
    for (const id of [post, delegate, mcp, bash]) {
      assert.equal(k.get(id).resultSummary, null);
      assert.equal(k.get(id).effectUnknown, true, `${k.get(id).toolName} 效果未知`);
    }
    assert.equal(k.store.getTask(k.task.id)!.effectUnknown, true);
  } finally {
    k.cleanup();
  }
});

test("重启：终态任务残留的操作同样补记；族核实缺失即效果未知", () => {
  const k = kit();
  try {
    const done = k.newTask("completed");
    const bash = k.op("bash", {}, { taskId: done.id });
    const read = k.op("read", {}, { taskId: done.id });
    const accept = k.op("chat_result_accept", {}, { taskId: done.id });
    k.store.withTx(() => k.ledger.settleAll());
    assert.equal(k.get(bash).effectUnknown, true);
    assert.equal(k.get(accept).effectUnknown, true, "未提供族核实 = 无法核实");
    assert.match(k.get(read).resultSummary ?? "", /无写入效果/);
    assert.equal(k.store.getTask(done.id)!.effectUnknown, true, "终态任务补标任务级效果未知");
    assert.equal(k.store.getTask(k.task.id)!.effectUnknown, false);
  } finally {
    k.cleanup();
  }
});

test("停止：快照只含按审批判定且可能已开始的操作；快照内落了结果仍标未知；中止期间被消费的也标未知", () => {
  const k = kit({ app_data: fakeFamily("unverifiable") });
  try {
    const running = k.op("bash");
    const read = k.op("read");
    const insert = k.op("app_data_insert");
    const waiting = k.op("mock_gate", {}, { approval: "pending" });
    const stillWaiting = k.op("mock_gate", {}, { approval: "pending" });
    const snapshot = k.ledger.beginStop(k.task.id);
    assert.deepEqual(snapshot, [running], "只读、族操作与审批未消费的不在快照");

    // 中止期间：bash 以「已中止」结束；批准刚好被消费、执行未落结果
    k.store.withTx(() => k.ledger.recordResult(k.task, running, "Command aborted", true));
    const conf = k.store.listConfirmationsByTask(k.task.id).find((c) => c.toolOpId === waiting)!;
    k.store.withTx(() => k.store.respondConfirmation(conf.id, "approved", { source: "owner" }));
    k.store.withTx(() => k.store.consumeApproval({ confirmationId: conf.id, expectedPermissionVersion: 1, activeStatuses: ["running", "awaiting_confirmation"] }));

    const unknown = k.store.withTx(() => k.ledger.settleTask(k.task, snapshot));
    assert.deepEqual(unknown.sort(), [running, waiting, insert].sort());
    assert.equal(k.get(read).resultSummary, "未完成：只读操作在停止前中止，无写入效果");
    assert.equal(k.get(stillWaiting).resultSummary, "已知未执行：审批未消费即停止");
    assert.equal(k.get(insert).resultSummary, null, "族无法核实：留给终态事务标未知");
  } finally {
    k.cleanup();
  }
});

test("结果写入失败：只对族能核实的操作即时补记", () => {
  const k = kit({ app_data: fakeFamily("committed") });
  try {
    const insert = k.op("app_data_insert");
    const bash = k.op("bash");
    k.store.withTx(() => k.ledger.settleAfterWriteFailure(k.task, insert));
    k.store.withTx(() => k.ledger.settleAfterWriteFailure(k.task, bash));
    assert.equal(k.get(insert).resultSummary, "已提交：假账本（结果写入失败前）");
    assert.equal(k.get(bash).resultSummary, null);
    assert.equal(k.get(bash).effectUnknown, false, "真实结果已拿到，不标未知");
  } finally {
    k.cleanup();
  }
});

test("无写入效果按工具名或持久化参数判定", () => {
  assert.equal(hasNoWriteEffect({ toolName: "web_search", params: {} }, [WEB_SEARCH_LEDGER]), true);
  assert.equal(hasNoWriteEffect({ toolName: "http_request", params: { method: "HEAD" } }), true);
  assert.equal(hasNoWriteEffect({ toolName: "http_request", params: { method: "DELETE" } }), false);
  assert.equal(hasNoWriteEffect({ toolName: "request_file_access", params: { operation: "write" } }), false);
  assert.equal(hasNoWriteEffect({ toolName: "memory_revoke", params: {} }, [HOST_DATA_LEDGER]), false);
  assert.equal(hasNoWriteEffect({ toolName: "mcp_svc_read", params: {} }), false, "动态名字按审批判定");
  assert.equal(hasNoWriteEffect({ toolName: "hasOwnProperty", params: {} }), false, "原型链上的键不当作规则");
});

test("重启回归：活动任务未结束的 read 不标效果未知；终态任务残留的 bash 补标效果未知；中断事件按任务标记", async () => {
  const server = new MockModelServer(async () => ({ kind: "text", text: "ok" }));
  const baseUrl = await server.start();
  const { dirs } = await makeTestDirs("ledger-restart", 0);
  try {
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
    const rt = await Runtime.start(config);
    const main = rt.store.getAgentRole("main")!;
    await rt.stop("prep");
    const db = new Db(dirs.dataDir);
    try {
      const now = new Date().toISOString();
      // task_flagged：崩溃前已被运行时标过效果未知（如 MCP 写调用超时），重启时无新操作
      for (const [id, status, flagged] of [["task_live", "running", 0], ["task_done", "completed", 0], ["task_flagged", "running", 1]] as const) {
        db.prepare(
          `INSERT INTO tasks (id, session_id, request_id, input, status, access_mode, permission_version, granted_paths,
             cancel_requested, effect_unknown, history_entry_ids, created_at, agent_id)
           VALUES (?, ?, ?, 'x', ?, 'confirm', 1, '[]', 0, ?, '[]', ?, 'main')`,
        ).run(id, main.sessionId, `req_${id}`, status, flagged, now);
      }
      db.prepare(`INSERT INTO tool_ops (id, task_id, tool_name, params, intent_recorded_at, effect_unknown) VALUES ('op_read', 'task_live', 'read', '{}', ?, 0)`).run(now);
      db.prepare(`INSERT INTO tool_ops (id, task_id, tool_name, params, intent_recorded_at, effect_unknown) VALUES ('op_bash', 'task_done', 'bash', '{}', ?, 0)`).run(now);
    } finally {
      db.close();
    }
    const rt2 = await Runtime.start(config);
    try {
      const live = rt2.store.getTask("task_live")!;
      assert.equal(live.status, "interrupted");
      assert.equal(live.effectUnknown, false, "只读操作中止不算效果未知");
      assert.equal(rt2.store.getToolOp("op_read")!.resultSummary, "未完成：只读操作在后台重启前中止，无写入效果");
      const interrupted = (taskId: string) =>
        (rt2.store.getEventsAfter(0).find((e) => e.body.type === "task.interrupted" && (e.body as any).taskId === taskId)!.body as any).effectUnknown;
      assert.equal(interrupted("task_live"), false);
      assert.equal(interrupted("task_flagged"), true, "中断事件与任务标记一致（与停止路径同一口径）");
      assert.equal(rt2.store.getToolOp("op_bash")!.effectUnknown, true, "终态任务残留的操作补标效果未知");
      assert.equal(rt2.store.getTask("task_done")!.effectUnknown, true);
    } finally {
      await rt2.stop("end");
    }
  } finally {
    await server.close();
    await cleanupDirs(dirs);
  }
});
