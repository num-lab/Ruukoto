import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { listAgentReports, listAgentWaits } from "@ruukoto/core/agent-wait.ts";
import { getBackgroundProcess } from "@ruukoto/core/background-processes.ts";
import { afterTool, lastToolText, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

test("wait 等到主命令退出、明确停止后恢复目录，进程结果不登记报告", async () => {
  let phase = 0, processId = "";
  const t = await startTestRuntime("wait-background-exit", request => {
    assert.ok(toolNamesOf(request).includes("wait"));
    assert.ok(!toolNamesOf(request).includes("agent_wait"));
    switch (phase++) {
      case 0: return { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: "printf finished" } }] };
      case 1:
        processId = JSON.parse(lastToolText(request)).process_id;
        assert.ok(!toolNamesOf(request).includes("write"));
        return { kind: "tool_calls", calls: [{ id: "wait-exit", name: "wait", arguments: { targets: [{ kind: "process", process_id: processId }] } }] };
      case 2: {
        const result = JSON.parse(lastToolText(request));
        assert.equal(result.reason, "attention");
        assert.equal(result.targets[0].attention, "command_exited");
        assert.equal(result.targets[0].stopVerified, false);
        assert.equal(t.runtime.store.getOccupancyByDir(session.cwdReal)?.processId, processId);
        return { kind: "tool_calls", calls: [{ id: "stop", name: "process_stop", arguments: { process_id: processId } }] };
      }
      case 3: return { kind: "tool_calls", calls: [{ id: "wait-stop", name: "wait", arguments: { targets: [{ kind: "process", process_id: processId }] } }] };
      case 4: {
        const result = JSON.parse(lastToolText(request));
        assert.equal(result.reason, "result");
        assert.equal(result.targets[0].stopVerified, true);
        assert.ok(toolNamesOf(request).includes("write"));
        return { kind: "tool_calls", calls: [{ id: "write", name: "write", arguments: { path: "after.txt", content: "后台已核实停止" } }] };
      }
      default: return { kind: "text", text: "完成" };
    }
  }, { workDirs: 1, config: { ...realTools(), product: product.runtime } });
  const session = await t.runtime.createSession({ projectName: "wait-process", cwd: t.work[0], mode: "full_access" });
  const task = await t.runtime.submit({ sessionId: session.id, requestId: "run", input: "运行、等待并核实停止", modelSelection: t.runtime.defaultSelection });
  try {
    await waitFor("进程等待后完成写入", () => {
      const current = t.runtime.store.getTask(task.id)!;
      assert.ok(!["failed", "interrupted", "canceled"].includes(current.status), current.errorMessage ?? current.interruptReason ?? current.status);
      return current.status === "completed";
    }, 30_000);
    assert.equal(fs.readFileSync(path.join(t.work[0], "after.txt"), "utf8"), "后台已核实停止");
    assert.equal(listAgentWaits(t.runtime.store, { taskId: task.id }).length, 0);
    assert.equal(listAgentReports(t.runtime.store, { taskId: task.id }).length, 0);
    assert.equal(t.runtime.store.listAllOccupancy().length, 0);
  } finally { await t.shutdown(); }
});

for (const interruption of ["owner", "cancel"] as const) test(`进程 wait 的 ${interruption} 中断及时结束父轮，后台继续持有目录`, async () => {
  let processId = "", waitingPhase = 0;
  const t = await startTestRuntime(`wait-background-${interruption}`, request => {
    if (lastUserText(request) === "新问题") return { kind: "text", text: "先回答新问题" };
    if (waitingPhase++ === 0) return { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: "sleep 60" } }] };
    if (waitingPhase === 2) {
      processId = JSON.parse(lastToolText(request)).process_id;
      return { kind: "tool_calls", calls: [{ id: "wait-process", name: "wait", arguments: { targets: [{ kind: "process", process_id: processId }], timeout_ms: 30_000 } }] };
    }
    assert.fail("被中断后不能继续旧模型轮");
  }, { workDirs: 1, config: { ...realTools(), product: product.runtime } });
  const session = await t.runtime.createSession({ projectName: "wait-process", cwd: t.work[0], mode: "full_access" });
  const task = await t.runtime.submit({ sessionId: session.id, requestId: "run", input: "等待后台", modelSelection: t.runtime.defaultSelection });
  try {
    await waitFor("已订阅后台等待", () => t.runtime["backgroundProcesses"]["waits"].has(task.id));
    if (interruption === "owner") {
      const next = t.runtime.submit({ sessionId: session.id, requestId: "next", input: "新问题", modelSelection: t.runtime.defaultSelection });
      await waitFor("新输入及时打断等待", () => t.runtime.store.getTask(task.id)!.status === "interrupted", 3000);
      const queued = await next;
      await waitFor("新问题已应答", () => t.runtime.store.getTask(queued.id)!.status === "completed");
    } else {
      const canceled = t.runtime.cancelTask(task.id);
      await waitFor("取消及时打断等待", () => t.runtime.store.getTask(task.id)!.status === "canceled", 3000);
      await canceled;
    }
    assert.equal(getBackgroundProcess(t.runtime.store, processId)!.state, "running");
    assert.equal(t.runtime.store.getOccupancyByDir(session.cwdReal)?.processId, processId);
    assert.equal(t.runtime["backgroundProcesses"]["waits"].size, 0);
    assert.equal(t.runtime.store.getTask(task.id)!.effectUnknown, false);
  } finally { await t.shutdown(); }
});

test("wait 拒绝混合或重复进程目标，未发出后台操作", async () => {
  let phase = 0;
  const t = await startTestRuntime("wait-background-invalid", request => {
    if (afterTool(request)) assert.match(lastToolText(request), /validation|valid|校验|targets/i);
    if (phase++ === 0) return { kind: "tool_calls", calls: [{ id: "mixed", name: "wait", arguments: { targets: [{ kind: "process", process_id: "foreign" }, { kind: "task", task_id: "foreign" }] } }] };
    if (phase === 2) return { kind: "tool_calls", calls: [{ id: "duplicate", name: "wait", arguments: { targets: [{ kind: "process", process_id: "foreign" }, { kind: "process", process_id: "foreign" }] } }] };
    return { kind: "text", text: "参数已拒绝" };
  }, { config: { product: product.runtime } });
  try {
    const session = await t.runtime.createSession({ projectName: "wait-process", cwd: t.work[0] });
    const task = await t.runtime.submit({ sessionId: session.id, requestId: "run", input: "错误目标", modelSelection: t.runtime.defaultSelection });
    await waitFor("错误目标已拒绝", () => t.runtime.store.getTask(task.id)!.status === "completed");
    assert.equal(listAgentWaits(t.runtime.store, { taskId: task.id }).length, 0);
    assert.equal(t.runtime.listBackgroundProcesses(session.id).processes.length, 0);
  } finally { await t.shutdown(); }
});
