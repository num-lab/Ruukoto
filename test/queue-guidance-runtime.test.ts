/**
 * coding-message-control：runtime/控制面 级引导与队列重排验证。
 *
 * - submit guidance=true：与源 Task 同事务登记 pending 路由，源不出现在队列，
 *   目标在下一安全边界接入（joined）或任务结束后回退队首（fallback）。
 * - steer_task：已排队输入显式转换为引导。
 * - queue_reorder：乐观并发按 expected_revision 校验。
 */

import test from "node:test";
import assert from "node:assert";
import {
  afterTool,
  createProjectSession,
  routeResponder,
  startTestRuntime,
  taskStatus,
  waitFor,
} from "./helpers/testkit.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

const routes = routeResponder([
  {
    // 两段式任务：先调用一个无审批的延迟工具，给引导留出下一次请求边界
    match: /TWO:/,
    respond: (req) => {
      if (!afterTool(req)) {
        return { kind: "tool_calls", calls: [{ id: "call_d1", name: "mock_delay", arguments: { ms: 2000 } }] };
      }
      return { kind: "text", text: "two-done" };
    },
  },
  {
    match: /SLOW:/,
    respond: async () => {
      await new Promise((r) => setTimeout(r, 2500));
      return { kind: "text", text: "slow-done" };
    },
  },
  { match: /QUICK:/, respond: () => ({ kind: "text", text: "quick-done" }) },
]);

test("显式引导在下一请求边界接入目标任务", async () => {
  const t = await startTestRuntime("guide-join", routes);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const target = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "g-t1", input: "TWO:目标任务",
    });
    await waitFor("目标任务运行中", async () => (await taskStatus(t.client, target.id)).task.status === "running");

    const source = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "g-s1", input: "QUICK:引导输入", guidance: true,
    });
    // 同事务登记 pending 路由；源仍 queued 但不属于队列成员
    let guidance = t.runtime.store.getTaskGuidance(source.id);
    assert.equal(guidance?.state, "pending");
    assert.equal(guidance?.targetTaskId, target.id);
    const queue = t.runtime.store.getTaskQueue(sessionId);
    assert.ok(!queue.tasks.some((item) => item.taskId === source.id), "待接入引导源不得出现在队列");

    await waitFor("目标任务完成", async () => (await taskStatus(t.client, target.id)).task.status === "completed", 60_000);
    guidance = t.runtime.store.getTaskGuidance(source.id);
    assert.ok(guidance && ["joined", "fallback"].includes(guidance.state), `引导应已落定，实际 ${guidance?.state}`);
    if (guidance.state === "joined") {
      const src = t.runtime.store.getTask(source.id)!;
      assert.equal(src.status, "canceled", "已接入引导源不得独立执行");
      assert.equal(src.interruptReason, "converted_to_guidance");
      assert.ok(guidance.entryId, "已接入引导须记录历史条目");
    } else {
      // 错过边界：回到队首并独立执行
      const q = t.runtime.store.getTaskQueue(sessionId);
      assert.equal(q.tasks[0]?.taskId, source.id);
      await waitFor("回退输入执行完成", async () => (await taskStatus(t.client, source.id)).task.status === "completed", 60_000);
    }
  } finally {
    await t.shutdown();
  }
});

test("steer_task 转换排队输入；目标结束后回退队首", async () => {
  const t = await startTestRuntime("guide-fallback", routes);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const active = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "f-t1", input: "SLOW:目标任务",
    });
    const q2 = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "f-s2", input: "QUICK:排队二",
    });
    const q3 = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "f-s3", input: "QUICK:排队三",
    });
    await waitFor("目标任务运行中", async () => (await taskStatus(t.client, active.id)).task.status === "running");

    // steer_task 把排队输入转换为当前任务的引导
    await t.client.request<any>("steer_task", { task_id: q3.id });
    const guidance = t.runtime.store.getTaskGuidance(q3.id);
    assert.equal(guidance?.state, "pending");
    assert.equal(guidance?.targetTaskId, active.id);

    // SLOW 只有一段应答：任务在引导下一边界前结束 → 回退队首
    await waitFor("目标任务完成", async () => (await taskStatus(t.client, active.id)).task.status === "completed", 60_000);
    const settled = t.runtime.store.getTaskGuidance(q3.id);
    assert.ok(settled && ["fallback", "joined"].includes(settled.state), `引导应已落定，实际 ${settled?.state}`);
    if (settled.state === "fallback") {
      const q = t.runtime.store.getTaskQueue(sessionId);
      assert.equal(q.tasks[0]?.taskId, q3.id, "回退引导须置于队首");
    }
    await waitFor("队列清空", async () => {
      for (const id of [q2.id, q3.id]) {
        if (!["completed", "canceled"].includes((await taskStatus(t.client, id)).task.status)) return false;
      }
      return true;
    }, 60_000);
    if (settled.state === "fallback") {
      const s2 = t.runtime.store.getTask(q2.id)!, s3 = t.runtime.store.getTask(q3.id)!;
      assert.ok(s3.startedAt! <= s2.startedAt!, "回退引导应先于普通排队项启动");
    }
  } finally {
    await t.shutdown();
  }
});

test("queue_reorder 交换排队顺序并推进修订", async () => {
  const t = await startTestRuntime("queue-reorder", routes);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "r-t1", input: "SLOW:占位任务",
    });
    const a = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "r-a", input: "QUICK:A",
    });
    const b = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "r-b", input: "QUICK:B",
    });
    const c = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "r-c", input: "QUICK:C",
    });

    const detail = await t.client.request<any>("task_queue", { session_id: sessionId });
    assert.deepEqual(detail.reorderableTaskIds, [a.id, b.id, c.id]);
    const revision = detail.queue.revision as number;

    // 过期修订被拒绝
    await assert.rejects(
      t.client.request<any>("queue_reorder", { session_id: sessionId, task_ids: [c.id, b.id, a.id], expected_revision: revision + 1 }),
      (err: any) => err.code === "queue_conflict",
    );

    await t.client.request<any>("queue_reorder", { session_id: sessionId, task_ids: [c.id, b.id, a.id], expected_revision: revision });
    const after = await t.client.request<any>("task_queue", { session_id: sessionId });
    assert.deepEqual(after.reorderableTaskIds, [c.id, b.id, a.id]);
    assert.equal(after.queue.revision, revision + 1);
    // 持久顺序事实与 reorderable 列表一致
    const order = new Map(after.queue.tasks.map((item: any, i: number) => [item.taskId, i]));
    assert.ok(order.get(c.id)! < order.get(b.id)! && order.get(b.id)! < order.get(a.id)!);
  } finally {
    await t.shutdown();
  }
});
