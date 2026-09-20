/**
 * 集成：生命周期控制。
 *
 * 覆盖：显式中断（模型调用取消、无重试）、取消排队任务、取消活动任务、
 * 取消与完成竞争只产生一个终态、确认拒绝后模型继续、失效确认不得再执行、
 * 拒绝正常终止的子进程被强制回收。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  startTestRuntime,
  routeResponder,
  waitFor,
  createProjectSession,
  taskStatus,
} from "./helpers/testkit.ts";

const TERMINALS = new Set(["completed", "failed", "canceled", "interrupted"]);

function lifecycleRoutes() {
  return routeResponder([
    {
      match: /SLOWRESP/,
      respond: async () => {
        await new Promise((r) => setTimeout(r, 800));
        return { kind: "text", text: "slow-response" };
      },
    },
    {
      match: /QUICK/,
      respond: () => ({ kind: "text", text: "quick-done" }),
    },
    {
      // 工具批：mock_gate 需确认；拒绝后模型继续（第二次调用直接文本回复）
      match: /GATEREJ/,
      respond: (req) => {
        const needsGate = !JSON.stringify(req.messages).includes("拥有者拒绝");
        if (needsGate) {
          return {
            kind: "tool_calls",
            calls: [{ id: "call_gate_rej", name: "mock_gate", arguments: { note: "删除文件" } }],
          };
        }
        return { kind: "text", text: "rejection-handled" };
      },
    },
    {
      match: /SPAWN/,
      respond: (req, text) => {
        const pidFile = text.replace(/^SPAWN:/, "").trim();
        const alreadySpawned = JSON.stringify(req.messages).includes("spawn-exit");
        if (!alreadySpawned && pidFile.length > 0) {
          return {
            kind: "tool_calls",
            calls: [
              {
                id: "call_spawn_1",
                name: "mock_spawn",
                arguments: {
                  file: process.execPath,
                  args: [
                    "-e",
                    `const fs=require('fs');fs.writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},500);`,
                    pidFile,
                  ],
                },
              },
            ],
          };
        }
        return { kind: "text", text: "spawn-done" };
      },
    },
  ]);
}

test("显式中断：模型调用被取消，不自动重试，终态 interrupted", async () => {
  const t = await startTestRuntime("interrupt", lifecycleRoutes());
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "i1",
      input: "SLOWRESP:请回答",
    });
    await waitFor(
      "任务运行中且模型已调用",
      async () => (await taskStatus(t.client, task.id)).task.status === "running" && t.server.calls.length >= 1,
    );
    const callsBefore = t.server.calls.length;

    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务进入中断", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted");

    const { task: final } = await taskStatus(t.client, task.id);
    assert.equal(final.interruptReason, "owner_interrupt");
    assert.equal(final.cancelRequested, false, "interrupt 不设置取消意图");
    // abort 后没有新的模型调用（无自动重试）
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.server.calls.length, callsBefore, "中断后不得再次调用模型");
  } finally {
    await t.shutdown();
  }
});

test("取消排队任务不执行；取消活动任务记录取消意图", async () => {
  const t = await startTestRuntime("cancel", lifecycleRoutes());
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const t1 = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "c1",
      input: "SLOWRESP:长任务",
    });
    const t2 = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "c2",
      input: "QUICK:排队任务",
    });
    await waitFor("t1 运行", async () => (await taskStatus(t.client, t1.id)).task.status === "running");

    await t.client.request("cancel", { task_id: t2.id });
    assert.equal((await taskStatus(t.client, t2.id)).task.status, "canceled", "排队任务直接取消");
    assert.equal((await taskStatus(t.client, t2.id)).task.startedAt, null, "被取消的排队任务不得启动");

    await t.client.request("cancel", { task_id: t1.id });
    await waitFor("t1 取消完成", async () => (await taskStatus(t.client, t1.id)).task.status === "canceled");
    assert.equal((await taskStatus(t.client, t1.id)).task.cancelRequested, true, "活动取消应记录取消意图");
  } finally {
    await t.shutdown();
  }
});

test("取消与自然完成竞争：只有一个终态，重复取消无额外效果", async () => {
  const t = await startTestRuntime("race", lifecycleRoutes());
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "race1",
      input: "QUICK:极快任务",
    });
    // 与执行并发地取消
    const cancelPromise = t.client.request("cancel", { task_id: task.id }).catch((err: any) => err.code);
    await cancelPromise;
    await waitFor("任务到达终态", async () => TERMINALS.has((await taskStatus(t.client, task.id)).task.status));

    const { task: final } = await taskStatus(t.client, task.id);
    assert.ok(TERMINALS.has(final.status), "必须是唯一终态");
    // 再取消：已结束的任务返回 invalid_state，不再变更
    await assert.rejects(
      () => t.client.request("cancel", { task_id: task.id }),
      (err: any) => err.code === "invalid_state",
    );
    const after = (await taskStatus(t.client, task.id)).task;
    assert.equal(after.status, final.status, "终态不得被二次取消改变");
  } finally {
    await t.shutdown();
  }
});

test("拒绝确认：只阻止该操作，模型按拒绝结果继续；失效确认不得再执行", async () => {
  const t = await startTestRuntime("reject", lifecycleRoutes());
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!, {
      confirmTools: ["mock_gate"],
    });
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "rej1",
      input: "GATEREJ:请执行需要确认的操作",
    });
    let confirmationId = "";
    await waitFor("进入等待确认", async () => {
      const status = await taskStatus(t.client, task.id);
      if (status.task.status !== "awaiting_confirmation") return false;
      confirmationId = status.confirmations.find((c: any) => c.status === "pending")?.id ?? "";
      return confirmationId !== "";
    });

    await t.client.request("respond_confirmation", { confirmation_id: confirmationId, decision: "reject" });
    await waitFor("任务完成（模型继续）", async () => (await taskStatus(t.client, task.id)).task.status === "completed");

    const detail = await taskStatus(t.client, task.id);
    const gateOp = detail.toolOps.find((op: any) => op.sdkCallId === "call_gate_rej");
    assert.ok(gateOp, "应有 mock_gate 的执行意图记录");
    assert.equal(gateOp.isError, true, "被拒绝的操作记录为已知错误结果");
    assert.ok(gateOp.resultSummary.includes("拒绝"), "结果应说明被拒绝");
    assert.equal(detail.task.effectUnknown, false, "被拒绝的操作不产生效果不明");

    // 重复应答：失效确认被拒绝
    await assert.rejects(
      () => t.client.request("respond_confirmation", { confirmation_id: confirmationId, decision: "approve" }),
      (err: any) => err.code === "stale_confirmation",
      "重复批准必须被拒绝",
    );
  } finally {
    await t.shutdown();
  }
});

test("等待确认时中断：任务中断、确认失效、被确认的工具不得执行", async () => {
  const t = await startTestRuntime("gate-interrupt", lifecycleRoutes());
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!, {
      confirmTools: ["mock_gate"],
    });
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "gi1",
      input: "GATEREJ:需要确认后执行",
    });
    let confirmationId = "";
    await waitFor("进入等待确认", async () => {
      const status = await taskStatus(t.client, task.id);
      if (status.task.status !== "awaiting_confirmation") return false;
      confirmationId = status.confirmations.find((c: any) => c.status === "pending")?.id ?? "";
      return confirmationId !== "";
    });

    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted");

    const detail = await taskStatus(t.client, task.id);
    const confirmation = detail.confirmations.find((c: any) => c.id === confirmationId);
    assert.ok(confirmation, "确认请求应保留记录");
    assert.equal(confirmation.status, "stale", "未决确认应标为失效");
    // 模型只被调用一次：中断后模型调用与确认等待一并取消
    assert.equal(t.server.calls.length, 1, "中断后不得再次调用模型");
  } finally {
    await t.shutdown();
  }
});

test("拒绝正常终止的子进程：中断时升级强制回收，占用随后释放", async () => {
  const t = await startTestRuntime("reap", lifecycleRoutes());
  try {
    const dirA = t.work[0]!;
    const pidFile = path.join(t.dirs.root, "child.pid");
    const { sessionId } = await createProjectSession(t.client, dirA, {
      projectName: "reap-p",
    });
    // 通过 submit 的输入把 pidFile 传给 responder 生成的工具参数
    const task = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "spawn1",
      input: `SPAWN:${pidFile}`,
    });
    // responder 需要动态 pidFile；这里直接等待工具执行产生 pid 文件
    await waitFor("子进程写入 pid 文件", () => fs.existsSync(pidFile), 20_000);
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(childPid > 0);

    await t.client.request("interrupt", { task_id: task.id });
    await waitFor("任务中断", async () => (await taskStatus(t.client, task.id)).task.status === "interrupted");

    // 子进程确实被回收（SIGTERM 被忽略 → SIGKILL 升级）
    let gone = false;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
      } catch {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(gone, "忽略 SIGTERM 的子进程必须被 SIGKILL 回收");

    // 占用已释放：同目录新任务可以启动
    const next = await t.client.request<any>("submit", {
      session_id: sessionId,
      request_id: "spawn2",
      input: "QUICK:占用回收后的新任务",
    });
    await waitFor("新任务完成", async () => (await taskStatus(t.client, next.id)).task.status === "completed");
  } finally {
    await t.shutdown();
  }
});
