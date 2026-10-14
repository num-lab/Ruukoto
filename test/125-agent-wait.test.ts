import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { getAgentReport, agentReportKey, listAgentWaits } from "@ruukoto/core/agent-wait.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import { createCodingTools } from "@ruukoto/agent/tool-router.ts";
import { getWorkflowStep, listWorkflowExecutions, listWorkflowRuns, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { afterTool, lastToolText, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const SCRIPT = 'await agent("change",{request:"修改",mode:"modify",target:"."}); await agent("validate",{request:"独立验证",mode:"verify",verify:"change",dependsOn:["change"]}); return await integrate("merge",{steps:["validate"],dependsOn:["validate"],check:"test \\"$(cat value.txt)\\" = changed"});';

for (const product of [undefined, codeProduct.runtime]) test(`agent_wait ${product?.type ?? "ruukoto"}：父轮让出真实 worker 与目录，修改、冻结、验证、汇总后继续检查且唯一报告`, async () => {
  let parentPhase = 0, runId = "";
  const t = await startTestRuntime("agent-wait-workflow", req => {
    if (lastUserText(req) === "等待修改工作流") {
      assert.ok(toolNamesOf(req).includes("agent_wait"));
      switch (parentPhase++) {
        case 0: return { kind: "tool_calls", calls: [{ id: "before", name: "read", arguments: { path: "value.txt" } }] };
        case 1: return { kind: "tool_calls", calls: [{ id: "start", name: "workflow_start", arguments: { title: "后台处理", script: SCRIPT, input: null, key: "modify" } }] };
        case 2:
          runId = (JSON.parse(lastToolText(req)) as { run: { id: string } }).run.id;
          return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "workflow", run_id: runId }] } }] };
        case 3:
          assert.equal((JSON.parse(lastToolText(req)) as { reason: string }).reason, "result", JSON.stringify({ result: lastToolText(req), run: t.runtime.getWorkflowDetail(runId) }));
          assert.equal(requireWorkflowRun(t.runtime.store, runId).status, "succeeded", lastToolText(req));
          return { kind: "tool_calls", calls: [{ id: "after", name: "read", arguments: { path: "value.txt" } }] };
        default:
          assert.match(lastToolText(req), /changed/);
          return { kind: "text", text: "父轮已核实修改与独立验证，工作完成" };
      }
    }
    assert.ok(!lastUserText(req).startsWith("[工作流最终回报]"), "等待父轮已经拥有报告，不再启动独立汇总");
    const verify = lastUserText(req).includes('"mode":"verify"');
    if (verify && afterTool(req)) {
      const execution = listWorkflowExecutions(t.runtime.store, runId).find(item => item.stepKey === "validate")!;
      const ops = t.runtime.store.listToolOpsByTask(execution.taskId);
      assert.ok(ops.every(op => op.isError === false), JSON.stringify(ops.map(op => ({ tool: op.toolName, result: op.resultSummary, isError: op.isError }))));
    }
    if (afterTool(req)) return { kind: "text", text: verify ? '{"passed":true,"reason":"字节已核实"}' : "修改完成" };
    return { kind: "tool_calls", calls: [{ id: verify ? "verify" : "change", name: verify ? "bash" : "write", arguments: verify
      ? { command: 'test "$(cat value.txt)" = changed' } : { path: "value.txt", content: "changed\n" } }] };
  }, { config: { ...realTools(), ...(product ? { product } : {}) }, workDirs: 1 });
  try {
    fs.writeFileSync(path.join(t.work[0], "value.txt"), "base\n");
    initGitRepo(t.work[0]);
    const rt = t.runtime, session = await rt.createSession({ projectName: "wait", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "等待修改工作流", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("等待父轮完成真实工作流", () => {
      const current = rt.store.getTask(parent.id)!;
      assert.ok(!["failed", "interrupted", "canceled"].includes(current.status), current.errorMessage ?? current.interruptReason ?? current.status);
      return current.status === "completed";
    }, 60_000);
    const run = requireWorkflowRun(rt.store, runId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.delivery?.status, "reported");
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "changed\n");
    assert.equal(getWorkflowStep(rt.store, runId, "validate")!.verification!.digest, getWorkflowStep(rt.store, runId, "change")!.frozen!.digest);
    assert.ok(listWorkflowExecutions(rt.store, runId).every(execution => execution.stopVerified === true));
    assert.equal(rt.store.listAllOccupancy().length, 0);
    const entries = parseSessionFile(rt.store.getSession(session.id)!.sessionFile!);
    assert.ok(entries.some(entry => {
      const message = entry.message as { role?: string; toolName?: string } | undefined;
      return entry.type === "message" && message?.role === "toolResult" && message.toolName === "agent_wait";
    }));
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => task.requestId.startsWith("workflow-final:")).length, 0);
  } finally { await t.shutdown(); }
});

test("agent_wait：超时或人工问题只结束一次等待，后台工作仍继续", async () => {
  let phase = 0, runId = "";
  const t = await startTestRuntime("agent-wait-timeout", req => {
    if (lastUserText(req).startsWith("[工作流最终回报]")) return { kind: "text", text: "后备汇总" };
    if (phase++ === 0) return { kind: "tool_calls", calls: [{ id: "start", name: "workflow_start", arguments: { title: "后台处理", script: 'await ask("hold",{prompt:"继续吗"}); return "完成";', input: null, key: "hold" } }] };
    if (phase === 2) {
      runId = (JSON.parse(lastToolText(req)) as { run: { id: string } }).run.id;
      return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "workflow", run_id: runId }], timeout_ms: 1 } }] };
    }
    const result = JSON.parse(lastToolText(req)) as { reason: string };
    assert.ok(["timeout", "attention"].includes(result.reason));
    return { kind: "text", text: "工作仍在等待业务回答" };
  }, { config: { product: codeProduct.runtime } });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "wait", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "等待业务回答", modelSelection: rt.defaultSelection });
    await waitFor("等待调用返回", () => rt.store.getTask(parent.id)!.status === "completed");
    assert.ok(["running", "waiting"].includes(requireWorkflowRun(rt.store, runId).status));
    assert.equal(listWorkflowRuns(rt.store, session.id).length, 1);
  } finally { await t.shutdown(); }
});

test("非 Git 子任务持真实目录：新拥有者输入打断父等待，内部对话拒绝业务工具，晚到结果自动补报", async () => {
  let rt!: Runtime, phase = 0, newPhase = 0, childId = "", parentId = "";
  const t = await startTestRuntime("agent-wait-direct", req => {
    const input = lastUserText(req);
    if (input === "后台修改") {
      if (phase++ === 0) return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { key: "direct", request: "真实非 Git 修改", mode: "modify", target: "." } }] };
      if (phase === 2) {
        childId = rt.store.listTasksByStatus(["queued", "running"]).find(task => task.subAgentId !== null)!.id;
        return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "task", task_id: childId }] } }] };
      }
      assert.fail("新输入打断后不能恢复旧父模型执行");
    }
    if (input === "先回答新问题") {
      assert.ok(!toolNamesOf(req).some(name => ["write", "bash", "skill"].includes(name)));
      if (newPhase++ === 0) return { kind: "tool_calls", calls: [{ id: "hidden-write", name: "write", arguments: { path: "forbidden.txt", content: "禁止" } }] };
      assert.match(lastToolText(req), /白名单|资源|Tool write not found/);
      return { kind: "text", text: "新消息已处理，后台修改仍继续" };
    }
    if (input.startsWith("[后台工作最终回报]")) {
      assert.deepEqual(toolNamesOf(req), []);
      assert.match(input, /真实非 Git 修改|子任务/);
      assert.match(JSON.stringify(req.messages), /changed|子任务完工/);
      return { kind: "text", text: "后台修改已完成并自动回报" };
    }
    if (afterTool(req)) return { kind: "text", text: "子任务完工 changed" };
    return { kind: "tool_calls", calls: [{ id: "child-write", name: "bash", arguments: {
      command: "printf started > child-started; while [ ! -f child-release ]; do sleep 0.05; done; printf changed > value.txt",
    } }] };
  }, { config: { ...realTools(), product: codeProduct.runtime }, workDirs: 1 });
  rt = t.runtime;
  try {
    const session = await rt.createSession({ projectName: "direct", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "后台修改", accessMode: "full_access", modelSelection: rt.defaultSelection });
    parentId = parent.id;
    await waitFor("子任务持目录实际执行且父轮已等待", () => fs.existsSync(path.join(t.work[0], "child-started")) && listAgentWaits(rt.store, { taskId: parentId }).some(wait => wait.phase === "waiting"));
    const newTask = await rt.submit({ sessionId: session.id, requestId: "new-owner", input: "先回答新问题", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("新输入未取得工作目录也能结束", () => ["completed", "failed", "interrupted"].includes(rt.store.getTask(newTask.id)!.status));
    assert.equal(rt.store.getTask(newTask.id)!.status, "completed", rt.store.getTask(newTask.id)!.errorMessage ?? "新输入未完成");
    assert.equal(rt.store.getTask(parentId)!.status, "interrupted");
    assert.equal(rt.store.getTask(parentId)!.interruptReason, "owner_input");
    assert.equal(rt.store.getTask(childId)!.status, "running");
    assert.equal(rt.store.getTask(childId)!.cancelRequested, false);
    assert.ok(rt.store.listAllOccupancy().some(held => held.taskId === childId));
    assert.equal(fs.existsSync(path.join(t.work[0], "forbidden.txt")), false);
    assert.equal(rt.store.listToolOpsByTask(newTask.id).some(op => op.toolName === "write"), false);
    fs.writeFileSync(path.join(t.work[0], "child-release"), "continue\n");
    await waitFor("晚到结果自动补报", () => getAgentReport(rt.store, agentReportKey({ kind: "task", taskId: childId }))?.status === "reported");
    const report = getAgentReport(rt.store, agentReportKey({ kind: "task", taskId: childId }))!;
    assert.ok(report.consumption);
    const fallback = rt.store.getTask(report.fallbackTaskId!)!;
    assert.equal(rt.getTaskDetail(fallback.id)!.task.inputPurpose, "internal_report");
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => task.requestId.startsWith("agent-final:")).length, 1);
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "changed");
  } finally {
    fs.writeFileSync(path.join(t.work[0], "child-release"), "continue\n");
    await t.shutdown();
  }
});

test("非 Git 持目录等待真实审批：attention 与新输入可对话，审批不因父轮退出失效", async () => {
  let rt!: Runtime, childId = "", parentPhase = 0, childPhase = 0, outside = "";
  const t = await startTestRuntime("agent-wait-approval", req => {
    const input = lastUserText(req);
    if (input === "委派待审批修改") {
      if (parentPhase++ === 0) return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { key: "approval", request: "修改后等待审批", mode: "modify", target: "." } }] };
      if (parentPhase === 2) {
        childId = rt.store.listTasksByStatus(["queued", "running"]).find(task => task.subAgentId)!.id;
        return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "task", task_id: childId }] } }] };
      }
      assert.equal((JSON.parse(lastToolText(req)) as { reason: string }).reason, "attention");
      assert.ok(!toolNamesOf(req).some(name => ["read", "write", "bash", "skill"].includes(name)));
      return { kind: "text", text: "后台需批准，工作尚未完成" };
    }
    if (input === "审批先保留，说明状态") {
      assert.ok(!toolNamesOf(req).some(name => ["read", "write", "bash", "skill"].includes(name)));
      return { kind: "text", text: "待审批工作仍保留" };
    }
    if (input.startsWith("[后台工作最终回报]")) return { kind: "text", text: "获批子工作已自动回报" };
    if (childPhase++ === 0) return { kind: "tool_calls", calls: [{ id: "write", name: "write", arguments: { path: "value.txt", content: "changed" } }] };
    if (childPhase === 2) return { kind: "tool_calls", calls: [{ id: "approval-read", name: "read", arguments: { path: "approval-fixture" } }] };
    assert.match(lastToolText(req), /APPROVED_FILE/);
    return { kind: "text", text: "获批修改完成" };
  }, { workDirs: 1, config: { product: codeProduct.runtime, toolFactory: ({ router }) => createCodingTools(router).map(tool => tool.name !== "read" ? tool : {
    ...tool,
    // 普通写入子工具不开放审批操作；此适配器只将已登记 read 导向真实审批闸门以验证持目录等待。
    execute: async (sdkCallId, _params, signal) => {
      router["toolNames"].set(sdkCallId, "request_file_access");
      const result = await router.executeRouted(sdkCallId, { path: outside, operation: "read", reason: "持目录审批机制验证" }, signal);
      return { content: [{ type: "text" as const, text: result.content.map(part => part.text ?? "").join("\n") }], details: undefined };
    },
  }) } });
  rt = t.runtime;
  try {
    outside = path.join(t.dirs.root, "outside.txt"); fs.writeFileSync(outside, "APPROVED_FILE"); outside = fs.realpathSync(outside);
    const session = await rt.createSession({ projectName: "approval", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "parent", input: "委派待审批修改", modelSelection: rt.defaultSelection });
    await waitFor("父轮看到真实审批并结束对话", () => {
      const current = rt.store.getTask(parent.id)!;
      assert.ok(!["failed", "interrupted", "canceled"].includes(current.status), current.errorMessage ?? current.status);
      return current.status === "completed";
    });
    assert.equal(rt.store.getTask(childId)!.status, "awaiting_confirmation");
    assert.ok(rt.store.listAllOccupancy().some(held => held.taskId === childId));
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "changed");
    const confirmation = rt.store.listConfirmationsByTask(childId).find(item => item.status === "pending")!;
    assert.ok(confirmation); assert.equal(confirmation.toolName, "request_file_access");
    const newTask = await rt.submit({ sessionId: session.id, requestId: "new", input: "审批先保留，说明状态", modelSelection: rt.defaultSelection });
    await waitFor("目录未空闲的新轮对话", () => rt.store.getTask(newTask.id)!.status === "completed");
    assert.equal(rt.store.getConfirmation(confirmation.id)!.status, "pending");
    await t.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
    await waitFor("获批子工作与自动补报完成", () => getAgentReport(rt.store, agentReportKey({ kind: "task", taskId: childId }))?.status === "reported");
    assert.equal(rt.store.getConfirmation(confirmation.id)!.status, "approved");
    assert.ok(rt.store.getConfirmation(confirmation.id)!.consumedAt);
    assert.equal(rt.store.getTask(childId)!.status, "completed");
  } finally { await t.shutdown(); }
});
