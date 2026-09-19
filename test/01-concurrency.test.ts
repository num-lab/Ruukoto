/**
 * 集成：并发与目录互斥。
 *
 * 覆盖：同会话 FIFO、不同目录并行、符号链接别名互斥、等待确认期间保留
 * 占用、重复后台启动被拒。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  startTestRuntime,
  routeResponder,
  waitFor,
  createProjectSession,
  taskStatus,
} from "./helpers/testkit.ts";
import { InstanceLockError } from "../src/core/instance-lock.ts";
import { Runtime } from "../src/runtime/runtime.ts";

const slowRoutes = routeResponder([
  {
    match: /SLOW:/,
    respond: async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { kind: "text", text: "slow-done" };
    },
  },
  {
    match: /QUICK:/,
    respond: () => ({ kind: "text", text: "quick-done" }),
  },
  {
    match: /GATE:/,
    respond: (req) => {
      const alreadyExecuted = req.messages.some((m) => m.role === "tool");
      if (!alreadyExecuted) {
        return {
          kind: "tool_calls",
          calls: [{ id: "call_gate_1", name: "mock_gate", arguments: { note: "外部写操作" } }],
        };
      }
      return { kind: "text", text: "gate-done" };
    },
  },
]);

test("同会话 FIFO：后提交任务排队，按序执行", async () => {
  const t = await startTestRuntime("fifo", slowRoutes);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const task = await t.client.request<any>("submit", {
        session_id: sessionId,
        request_id: `r${i}`,
        input: `SLOW:任务${i}`,
      });
      ids.push(task.id);
    }
    await waitFor("三个任务全部完成", async () => {
      for (const id of ids) {
        if ((await taskStatus(t.client, id)).task.status !== "completed") return false;
      }
      return true;
    });
    // FIFO：started_at 单调不减
    const started = [];
    for (const id of ids) started.push((await taskStatus(t.client, id)).task.startedAt);
    assert.deepEqual([...started].sort(), started, "任务应按提交顺序启动");
  } finally {
    await t.shutdown();
  }
});

test("不同目录并行执行；同目录符号链接别名互斥", async () => {
  const t = await startTestRuntime("parallel", slowRoutes);
  try {
    const dirA = t.work[0]!;
    const dirB = t.work[1]!;
    const aliasA = path.join(t.dirs.root, "alias-to-work-0");
    fs.symlinkSync(dirA, aliasA, "dir");

    const sA = await createProjectSession(t.client, dirA, { projectName: "p-a" });
    const sAlias = await createProjectSession(t.client, aliasA, { projectName: "p-alias" });
    const sB = await createProjectSession(t.client, dirB, { projectName: "p-b" });

    const taskA = await t.client.request<any>("submit", {
      session_id: sA.sessionId,
      request_id: "a1",
      input: "SLOW:目录A长任务",
    });
    await waitFor("任务A进入运行", async () => (await taskStatus(t.client, taskA.id)).task.status === "running");

    // 独立目录 B 可并行
    const taskB = await t.client.request<any>("submit", {
      session_id: sB.sessionId,
      request_id: "b1",
      input: "QUICK:目录B",
    });
    await waitFor("任务B完成", async () => (await taskStatus(t.client, taskB.id)).task.status === "completed");
    assert.equal((await taskStatus(t.client, taskA.id)).task.status, "running", "A 应仍在运行（并行证据）");

    // 同一目录的符号链接别名：占用互斥，别名会话的任务只能等待
    const taskAlias = await t.client.request<any>("submit", {
      session_id: sAlias.sessionId,
      request_id: "alias1",
      input: "QUICK:别名目录",
    });
    await waitFor("别名任务排队", async () => (await taskStatus(t.client, taskAlias.id)).task.status === "queued");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await taskStatus(t.client, taskAlias.id)).task.status, "queued", "别名任务不得与原目录任务并行");

    await waitFor("任务A完成", async () => (await taskStatus(t.client, taskA.id)).task.status === "completed");
    await waitFor("别名任务随后执行", async () => (await taskStatus(t.client, taskAlias.id)).task.status === "completed");
  } finally {
    await t.shutdown();
  }
});

test("等待确认期间保留目录占用", async () => {
  const t = await startTestRuntime("gate-occupancy", slowRoutes);
  try {
    const dirA = t.work[0]!;
    const s1 = await createProjectSession(t.client, dirA, { projectName: "g1", confirmTools: ["mock_gate"] });
    const s2 = await createProjectSession(t.client, dirA, { projectName: "g2", confirmTools: [] });

    const task1 = await t.client.request<any>("submit", {
      session_id: s1.sessionId,
      request_id: "g-1",
      input: "GATE:需要确认",
    });
    let confirmationId = "";
    await waitFor("进入等待确认", async () => {
      const status = await taskStatus(t.client, task1.id);
      if (status.task.status !== "awaiting_confirmation") return false;
      const pending = status.confirmations.filter((c: any) => c.status === "pending");
      confirmationId = pending[0]?.id ?? "";
      return confirmationId !== "";
    });

    // 同目录第二个会话的任务必须等待（占用未释放）
    const task2 = await t.client.request<any>("submit", {
      session_id: s2.sessionId,
      request_id: "g-2",
      input: "QUICK:同目录第二任务",
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await taskStatus(t.client, task2.id)).task.status, "queued", "等待确认期间同目录任务不得启动");

    await t.client.request("respond_confirmation", { confirmation_id: confirmationId, decision: "approve" });
    await waitFor("任务1完成", async () => (await taskStatus(t.client, task1.id)).task.status === "completed");
    await waitFor("任务2随后完成", async () => (await taskStatus(t.client, task2.id)).task.status === "completed");
  } finally {
    await t.shutdown();
  }
});

test("重复后台启动被实例锁拒绝", async () => {
  const t = await startTestRuntime("lock", slowRoutes);
  try {
    await assert.rejects(
      () => Runtime.start({ dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir }),
      (err: unknown) => err instanceof InstanceLockError,
      "第二个后台实例必须被拒绝",
    );
  } finally {
    await t.shutdown();
  }
});
