/**
 * issue 14：/context 数据层 —— 上下文窗口预算分解。
 *
 * 覆盖：
 * - selectionBreakdown 纯函数：分类占比的工作示例（字面期望值）、未分类项、
 *   旧记录缺快照降级、损坏记录（分类合计超过估算总量/快照与预算不一致）报错；
 * - get_context_breakdown 端点：快照字段（contextWindow/输出上限/思考/工具结果
 *   预留/安全余量）来自请求当时配置；已用 + 尚余 + 预留 = 总窗口；
 * - 归属校验：错误会话/不存在记录被拒绝；未认证连接被拒绝；
 * - 旧记录（window_snapshot 为 NULL）如实降级：无总窗口占比，仍有输入预算占比。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import {
  startTestRuntime,
  waitFor,
  createProjectSession,
  taskStatus,
  routeResponder,
} from "./helpers/testkit.ts";
import { ControlClient } from "@ruukoto/control/client.ts";
import { CONTROL_PROTOCOL_VERSION } from "@ruukoto/control/protocol.ts";
import { selectionBreakdown } from "@ruukoto/agent/context-selector.ts";
import type { SelectionRecord } from "@ruukoto/core/types.ts";

function makeRecord(overrides: Partial<SelectionRecord>): SelectionRecord {
  return {
    id: "sel_x",
    taskId: "task_x",
    sessionId: "ses_x",
    callIndex: 1,
    strategy: "deterministic-v1",
    configVersion: 1,
    model: "mock/mock-model",
    totalMessages: 3,
    includedIndices: [0, 1, 2],
    excluded: [],
    includedMemories: [],
    excludedMemories: [],
    instructionVersion: "",
    cappedToolResults: [],
    estimates: {},
    budget: 1000,
    estimatedTotal: 1000,
    usage: null,
    promptArtifactId: null,
    windowSnapshot: { contextWindow: 2000, maxTokens: 500, thinkingBudget: 100, toolResultReserve: 300, safetyMargin: 100 },
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

test("breakdown 纯函数：分类占比工作示例", () => {
  // 快照：预留 500+100+300+100 = 1000，预算 = 2000 − 1000 = 1000
  const record = makeRecord({
    estimates: { systemPrompt: 500, toolSchemas: 250, memories: 100, mandatoryTurn: 100, historyTurns: 50 },
    estimatedTotal: 1000,
  });
  const b = selectionBreakdown(record);
  assert.equal(b.budget, 1000);
  assert.equal(b.estimatedTotal, 1000);
  assert.equal(b.remainingInput, 0);
  assert.deepEqual(b.window, { contextWindow: 2000, maxTokens: 500, thinkingBudget: 100, toolResultReserve: 300, safetyMargin: 100 });
  assert.equal(b.windowUnavailableReason, null);

  const byKey = new Map(b.categories.map((c) => [c.key, c]));
  assert.equal(byKey.size, 16, "十六个已知分类，包含执行资源和子代理角色");
  assert.equal(byKey.get("subagentRoles")!.label, "子代理角色");
  assert.equal(byKey.get("subagentRoles")!.tokens, 0);
  assert.equal(byKey.get("resourcePhase")!.label, "执行资源");
  assert.equal(byKey.get("resourcePhase")!.tokens, 0);
  assert.equal(byKey.get("skills")!.label, "技能");
  assert.equal(byKey.get("compactionSummary")!.label, "压缩摘要");
  assert.equal(byKey.get("workList")!.label, "工作清单");
  assert.equal(byKey.get("workList")!.tokens, 0, "没有工作清单的旧记录仍显示零用量");
  const sys = byKey.get("systemPrompt")!;
  assert.equal(sys.label, "系统提示");
  assert.equal(sys.tokens, 500);
  assert.equal(sys.pctOfBudget, 50);
  assert.equal(sys.pctOfWindow, 25);
  assert.equal(byKey.get("toolSchemas")!.pctOfWindow, 12.5);
  assert.equal(byKey.get("historyTurns")!.pctOfBudget, 5);
  assert.equal(byKey.get("projectInstructions")!.tokens, 0, "缺失分类按 0 展示");
  assert.equal(byKey.get("projectInstructions")!.pctOfWindow, 0);
  assert.equal(b.other, null, "分类合计等于估算总量时无未分类项");
});

test("breakdown 纯函数：未分类项与缺快照降级", () => {
  const withOther = selectionBreakdown(
    makeRecord({ estimates: { systemPrompt: 600, unknownFutureKey: 200 }, estimatedTotal: 800 }),
  );
  assert.equal(withOther.other!.tokens, 200, "未知分类键与差额计入未分类");
  assert.equal(withOther.other!.pctOfBudget, 20);
  assert.equal(withOther.other!.pctOfWindow, 10);
  assert.equal(withOther.remainingInput, 200);

  const legacy = selectionBreakdown(makeRecord({ windowSnapshot: null, estimates: { systemPrompt: 500 } }));
  assert.equal(legacy.window, null);
  assert.match(legacy.windowUnavailableReason!, /快照/);
  assert.equal(legacy.categories.find((c) => c.key === "systemPrompt")!.pctOfWindow, null);
  assert.equal(legacy.categories.find((c) => c.key === "systemPrompt")!.pctOfBudget, 50, "输入预算占比仍可用");

  // 窗口值不可靠：如实降级并给出不可用原因，不按损坏处理
  const unreliable = selectionBreakdown(
    makeRecord({
      estimates: { systemPrompt: 500 },
      windowSnapshot: { contextWindow: 0, maxTokens: 500, thinkingBudget: 100, toolResultReserve: 300, safetyMargin: 100 },
    }),
  );
  assert.equal(unreliable.window, null);
  assert.match(unreliable.windowUnavailableReason!, /窗口值/);
  assert.equal(unreliable.categories.find((c) => c.key === "systemPrompt")!.pctOfWindow, null);
});

test("breakdown 纯函数：损坏记录明确报错", () => {
  // 分类合计超过估算总量
  assert.throws(
    () => selectionBreakdown(makeRecord({ estimates: { systemPrompt: 1200 }, estimatedTotal: 1000 })),
    /损坏/,
  );
  // 快照与预算不一致（预算 ≠ 窗口 − 预留）
  assert.throws(
    () =>
      selectionBreakdown(
        makeRecord({ budget: 900, windowSnapshot: { contextWindow: 2000, maxTokens: 500, thinkingBudget: 100, toolResultReserve: 300, safetyMargin: 100 } }),
      ),
    /损坏/,
  );
});

test("get_context_breakdown：快照来自请求当时配置，合计等于总窗口", async () => {
  const t = await startTestRuntime("ctx-bd", (req, callIndex) => {
    if (callIndex === 0) {
      return { kind: "tool_calls", calls: [{ id: "c1", name: "mock_mark", arguments: { path: "/tmp/ruukoto-ctx-bd.txt", content: "第一批" } }] };
    }
    return { kind: "text", text: "完成" };
  });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = (await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "ctx-bd-1",
      input: "写入标记后总结",
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 20_000);
    assert.equal(t.server.calls.length, 2);

    const list = await t.client.request<any>("list_selection_records", { session_id: sessionId, limit: 5 });
    assert.equal(list.records.length, 2, "list_selection_records 返回 { records } 包装");

    for (const record of list.records) {
      const result = await t.client.request<any>("get_context_breakdown", { session_id: sessionId, record_id: record.id });
      assert.equal(result.record.id, record.id);
      const b = result.breakdown;
      // 测试环境已知配置：窗口 200,000，maxTokens 1024，思考 0，工具结果预留 8000，安全余量 2000
      assert.deepEqual(b.window, { contextWindow: 200_000, maxTokens: 1024, thinkingBudget: 0, toolResultReserve: 8000, safetyMargin: 2000 });
      assert.equal(b.budget, 200_000 - 1024 - 8000 - 2000);
      assert.equal(b.remainingInput, b.budget - b.estimatedTotal);
      const categorySum = b.categories.reduce((n: number, c: any) => n + c.tokens, 0) + (b.other?.tokens ?? 0);
      assert.equal(categorySum, b.estimatedTotal, "分类合计 = 估算总量");
      const reserves = b.window.maxTokens + b.window.thinkingBudget + b.window.toolResultReserve + b.window.safetyMargin;
      assert.equal(b.estimatedTotal + b.remainingInput + reserves, b.window.contextWindow, "已用 + 尚余 + 预留 = 总窗口");
      // 分类 token 与记录估算一致；占比在 [0, 100]
      for (const c of b.categories) {
        assert.equal(c.tokens, record.estimates[c.key] ?? 0, `${c.key} 与选择记录估算一致`);
        assert.ok(c.pctOfWindow >= 0 && c.pctOfWindow <= 100);
        assert.ok(c.pctOfBudget >= 0 && c.pctOfBudget <= 100);
      }
    }
  } finally {
    await t.shutdown();
  }
});

test("get_context_breakdown：快照跟随请求当时配置（较小上下文窗口）", async () => {
  // 不同窗口配置的记录各自还原：窗口 50,000（maxTokens 仍为 1024）
  const t = await startTestRuntime("ctx-small", routeResponder([]), { contextWindow: 50_000 });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = (await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "ctx-small-1",
      input: "你好",
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    const list = await t.client.request<any>("list_selection_records", { session_id: sessionId, limit: 5 });
    const result = await t.client.request<any>("get_context_breakdown", { session_id: sessionId, record_id: list.records[0].id });
    assert.deepEqual(result.breakdown.window, {
      contextWindow: 50_000,
      maxTokens: 1024,
      thinkingBudget: 0,
      toolResultReserve: 8000,
      safetyMargin: 2000,
    });
    assert.equal(result.breakdown.budget, 50_000 - 1024 - 8000 - 2000);
  } finally {
    await t.shutdown();
  }
});

test("get_context_breakdown：归属校验与旧记录降级", async () => {
  const t = await startTestRuntime("ctx-own", routeResponder([]));
  try {
    const a = await createProjectSession(t.client, t.work[0]!, { projectName: "pa" });
    const b = await createProjectSession(t.client, t.work[1]!, { projectName: "pb" });
    const task = (await t.client.request<any>("submit", {
      model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: a.sessionId,
      request_id: "ctx-own-1",
      input: "你好",
    })) as any;
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    const list = await t.client.request<any>("list_selection_records", { session_id: a.sessionId, limit: 5 });
    const record = list.records[0];

    await assert.rejects(
      t.client.request("get_context_breakdown", { record_id: record.id, session_id: b.sessionId }),
      /不属于该会话|不存在/,
    );
    await assert.rejects(
      t.client.request("get_context_breakdown", { record_id: "sel_不存在", session_id: a.sessionId }),
      /不存在/,
    );

    // 旧记录：清掉快照列，如实降级（仍有输入预算占比，无总窗口占比）
    (t.runtime.store as any).db.prepare("UPDATE selection_records SET window_snapshot = NULL WHERE id = ?").run(record.id);
    const degraded = await t.client.request<any>("get_context_breakdown", { session_id: a.sessionId, record_id: record.id });
    assert.equal(degraded.breakdown.window, null);
    assert.match(degraded.breakdown.windowUnavailableReason, /快照/);
    assert.equal(degraded.breakdown.categories.find((c: any) => c.key === "systemPrompt").pctOfWindow, null);
    assert.ok(typeof degraded.breakdown.categories.find((c: any) => c.key === "systemPrompt").pctOfBudget === "number");
  } finally {
    await t.shutdown();
  }
});

test("get_context_breakdown：未认证连接被拒绝", async () => {
  const t = await startTestRuntime("ctx-auth", routeResponder([]));
  try {
    const socket = net.createConnection(t.runtime.socketPath());
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const reply = await new Promise<any>((resolve) => {
      socket.on("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8").trim())));
      socket.write(
        `${JSON.stringify({ v: CONTROL_PROTOCOL_VERSION, id: "1", op: "get_context_breakdown", params: { session_id: "ses_x", record_id: "sel_x" } })}\n`,
      );
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, "unauthorized");
    socket.destroy();
  } finally {
    await t.shutdown();
  }
});

test("get_session_usage：累计实际用量包含缓存，隔离会话，不计缺失 usage", async () => {
  const t = await startTestRuntime("session-usage", routeResponder([]));
  try {
    const a = await createProjectSession(t.client, t.work[0]!, { projectName: "usage-a" });
    const b = await createProjectSession(t.client, t.work[1]!, { projectName: "usage-b" });
    assert.deepEqual(await t.client.request("get_session_usage", { session_id: a.sessionId }), { input: 0, output: 0 });
    await assert.rejects(t.client.request("get_session_usage", { session_id: "ses_missing" }), /会话不存在/);
    await assert.rejects(t.client.request("get_session_usage", {}), /session_id/);
    for (const [index, sessionId] of [a.sessionId, a.sessionId, b.sessionId].entries()) {
      const task = await t.client.request<any>("submit", {
        model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId, request_id: `usage-${index}`, input: "你好",
      });
      await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
    }
    await waitFor("实际用量落盘", async () => {
      const usage = await t.client.request<any>("get_session_usage", { session_id: a.sessionId });
      return usage.input === 200 && usage.output === 20;
    });
    const records = t.runtime.store.listSelectionRecordsBySession(a.sessionId);
    const before = t.runtime.store.getMaxSeq();
    t.runtime.store.withTx(() => {
      t.runtime.store.setSelectionRecordUsage(records[0]!.id, { input: 100, output: 20, cacheRead: 200, cacheWrite: 300 });
      t.runtime.store.setSelectionRecordUsage(records[1]!.id, { input: 50, output: 8, cacheRead: 20 });
      t.runtime.store.insertSelectionRecord({ ...records[0]!, id: "sel_no_usage", callIndex: 99, estimatedTotal: 999_999 });
      t.runtime.store.setSelectionRecordUsage("sel_missing", { input: 900, output: 900 });
    });
    assert.deepEqual(await t.client.request("get_session_usage", { session_id: a.sessionId }), { input: 670, output: 28 });
    assert.deepEqual(await t.client.request("get_session_usage", { session_id: b.sessionId }), { input: 100, output: 10 });
    const events = t.runtime.store.getEventsAfter(before);
    assert.deepEqual(events.map((event) => ({ body: event.body, sessionId: event.sessionId, taskId: event.taskId })), [
      { body: { type: "session.usage_updated", sessionId: a.sessionId }, sessionId: a.sessionId, taskId: null },
      { body: { type: "session.usage_updated", sessionId: a.sessionId }, sessionId: a.sessionId, taskId: null },
    ], "只在 usage 确实写入后发出刷新事件");
  } finally {
    await t.shutdown();
  }
});
