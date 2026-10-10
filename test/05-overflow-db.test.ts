/**
 * 集成：上下文超限与数据库写入失败。
 *
 * 覆盖：超限任务中断（context_overflow）并暂停该会话队列，不自动摘要、
 * 不循环重试；数据库写入失败时不应答成功、不启动外部操作。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startTestRuntime,
  routeResponder,
  waitFor,
  createProjectSession,
  taskStatus,
} from "./helpers/testkit.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";

test("上下文超限：任务中断并暂停会话队列，不摘要不重试", async () => {
  // contextWindow=50（远小于系统提示+工具定义）：issue 05 的选择器在请求
  // 前判定必留内容超预算 → context_budget_exceeded 中断；若请求被发出，
  // mock 固定 usage（input=100 > 50）也会命中 isContextOverflow →
  // context_overflow。两条路径语义一致：中断、暂停队列、不摘要、不重试。
  const t = await startTestRuntime(
    "overflow",
    routeResponder([
      { match: /OVER/, respond: () => ({ kind: "text", text: "ok" }) },
      { match: /QUICK/, respond: () => ({ kind: "text", text: "done" }) },
    ]),
    {
      contextWindow: 50,
      // 收紧预留使极小窗口的预算配置合法（本用例故意验证超限路径）
      config: {
        budgetOverrides: { maxTokens: 20, toolResultReserve: 0, safetyMargin: 0, memoryBudget: 0 },
      },
    },
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "ov1",
      input: "OVER:会超限的任务",
    });
    await waitFor("任务因超限中断", async () => {
      const { task: st } = await taskStatus(t.client, task.id);
      return (
        st.status === "interrupted" &&
        (st.interruptReason === "context_overflow" || String(st.interruptReason).startsWith("context_budget_exceeded"))
      );
    });

    // 模型至多被调用一次：不循环重试（请求前阻断时为 0 次）
    assert.ok(t.server.calls.length <= 1, "超限后不得反复调用模型");

    // 该会话队列暂停：新提交排队不启动
    const next = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "ov2",
      input: "QUICK:暂停期间提交",
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await taskStatus(t.client, next.id)).task.status, "queued", "超限后队列应暂停");

    // 拥有者恢复后继续（上下文调整策略由 issue 05 负责）
    await t.client.request("resume_queue", { session_id: sessionId });
    await waitFor("恢复后执行", async () => (await taskStatus(t.client, next.id)).task.status === "interrupted");

    // JSONL 无压缩条目（不自动摘要）
    const snap = await t.client.handshake();
    const sessionRec = snap.snapshot.sessions.find((s: any) => s.id === sessionId);
    assert.ok(sessionRec?.sessionFile, "会话文件应已回填");
    const entries = parseSessionFile(String(sessionRec.sessionFile));
    assert.ok(!entries.some((e: any) => e.type === "compaction"), "不得产生压缩摘要条目");
  } finally {
    await t.shutdown();
  }
});

test("数据库写入失败：不应答成功、不启动外部操作", async () => {
  const t = await startTestRuntime(
    "db-fail",
    routeResponder([
      {
        match: /EXT/,
        respond: () => {
          return {
            kind: "tool_calls",
            calls: [{ id: "call_ext", name: "mock_mark", arguments: { path: "/tmp/should-never-happen", content: "x" } }],
          };
        },
      },
      { match: /QUICK/, respond: () => ({ kind: "text", text: "done" }) },
    ]),
  );
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    // 注入写入失败（测试专用故障点）：提交事务失败，请求必须报错而非确认成功
    t.runtime.store.db.faultNextWrite = new Error("injected: disk on fire");
    const outcome = await t.client
      .request("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        session_id: sessionId,
        request_id: "dbfail-1",
        input: "EXT:外部操作",
      })
      .then(
        () => ({ ok: true as const }),
        (err: any) => ({ ok: false as const, code: err.code }),
      );
    assert.equal(outcome.ok, false, "数据库失败时提交不得确认成功");
    assert.equal(t.server.calls.length, 0, "任何外部操作都不得启动");

    // 故障清除后同一 request_id 可正常提交（此前未落库）
    const task = await t.client.request<any>("submit", { model_selection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
      session_id: sessionId,
      request_id: "dbfail-1",
      input: "QUICK:故障恢复后的普通任务",
    });
    assert.ok(task.id, "故障恢复后应正常接收");
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed");
  } finally {
    await t.shutdown();
  }
});
