import assert from "node:assert/strict";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { CodeScheduleError, controlCodeSchedule, getCodeScheduleRun, getCodeScheduleRunForTask, getCodeScheduledTaskSource, registerCodeScheduleRun, saveCodeSchedule } from "@ruukoto/core/code-scheduler.ts";
import { requireSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { createWorkflowRun, listWorkflowExecutions, registerWorkflowStep, requireWorkflowRun, saveWorkflowDefinition, updateWorkflowRun } from "@ruukoto/core/workflow.ts";
import { listAgentReports, registerAgentWait } from "@ruukoto/core/agent-wait.ts";
import { browserTaskAllowed } from "@ruukoto/agent/browser-tools.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import { lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

async function scheduledSource(runtime: Runtime, cwd: string) {
  const { session } = await runtime.openWorkspace({ cwd });
  return runtime.store.withTx(() => {
    const store = runtime.store, workspace = store.getProject(session.projectId)!.rootDir!;
    const at = "2030-01-02T00:00:00.000Z";
    const config = { title: "固定来源", instructions: "执行 Coding 定时工作", workspaceId: session.projectId, permission: "full_access" as const,
      modelSelection: runtime.defaultSelection, rule: { kind: "once" as const, at, timeZone: "UTC", disambiguation: "compatible" as const } };
    const plan = saveCodeSchedule(store, { requestId: "source-plan", config, workspace, nextDueAt: at, now: "2030-01-01T00:00:00.000Z" }).plan;
    store.setSessionQueueState(session.id, "paused", "test_source");
    const root = store.insertQueuedTask({ sessionId: session.id, requestId: "source-root", input: config.instructions,
      accessMode: config.permission, modelSelection: config.modelSelection, submissionDigest: "source-root" }).task;
    const run = registerCodeScheduleRun(store, { scheduleId: plan.id, expectedVersion: plan.version, sessionId: session.id, rootTaskId: root.id,
      scheduledAt: at, coalescedFrom: at, coalescedThrough: at, nextDueAt: null, now: at });
    store.transitionTask(root.id, ["queued"], "running");
    return { session, plan, run, root: store.getTask(root.id)! };
  });
}

test("Coding 定时委派、双向消息与结果唤醒沿原运行；取消截住迟到派生", async () => {
  let finishChild!: () => void;
  const childGate = new Promise<void>(resolve => { finishChild = resolve; });
  const t = await startTestRuntime("code-scheduled-delegation", async req => {
    if (lastUserText(req).includes("[SubAgent 委派")) await childGate;
    return { kind: "text", text: "子工作已完成" };
  }, { config: { product: product.runtime } });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[0]);
    const child = await rt.subagents!.delegate({ parentTaskId: source.root.id, key: "child", request: "完成子工作", paramsDigest: "child" });
    await waitFor("子模型已开始", () => t.server.calls.length === 1);
    assert.equal(getCodeScheduleRunForTask(rt.store, child.task.id)?.id, source.run.id);
    assert.equal(requireSubAgentExecution(rt.store.getTask(child.task.id)!.readScope?.execution).source.codeScheduledRunId, source.run.id);

    const toParent = await rt.subagents!.message({ senderTaskId: child.task.id, workId: child.work.id, key: "parent", text: "阶段结果", paramsDigest: "parent" });
    assert.equal(toParent.delivery, "wake");
    const messageWake = rt.store.getTask(toParent.message.deliveredTaskId!)!;
    assert.equal(messageWake.sessionId, source.session.id);
    assert.deepEqual(messageWake.modelSelection, source.run.snapshot.modelSelection);
    assert.equal(messageWake.accessMode, source.run.snapshot.permission);
    assert.equal(getCodeScheduleRunForTask(rt.store, messageWake.id)?.id, source.run.id);
    assert.equal(browserTaskAllowed(rt.store, messageWake), true, "可信定时续接保留浏览器资格");
    assert.equal(browserTaskAllowed(rt.store, rt.store.getTask(child.task.id)!), false, "SubAgent 不获得浏览器资格");

    const toChild = await rt.subagents!.message({ senderTaskId: source.root.id, workId: child.work.id, key: "child", text: "补充工作", toSubAgentId: child.agent.id, paramsDigest: "child-message" });
    assert.equal(toChild.delivery, "pending");
    finishChild();
    await waitFor("补充消息已投递", () => rt.store.getSubAgentMessage(toChild.message.id)?.deliveredTaskId !== null);
    const messageTaskId = rt.store.getSubAgentMessage(toChild.message.id)!.deliveredTaskId!;
    assert.equal(getCodeScheduleRunForTask(rt.store, messageTaskId)?.id, source.run.id);
    await waitFor("结果唤醒已登记", () => rt.store.findTaskByRequest(source.session.id, `wake:${child.task.id}`) !== null);
    const resultWake = rt.store.findTaskByRequest(source.session.id, `wake:${child.task.id}`)!;
    assert.equal(resultWake.status, "queued");
    assert.equal(getCodeScheduleRunForTask(rt.store, resultWake.id)?.id, source.run.id);
    assert.deepEqual(resultWake.modelSelection, source.run.snapshot.modelSelection);

    rt.store.withTx(() => controlCodeSchedule(rt.store, { requestId: "cancel", planId: source.plan.id, expectedVersion: source.plan.version, control: "cancel" }));
    assert.throws(() => getCodeScheduledTaskSource(rt.store, messageWake.id), CodeScheduleError);
    assert.equal(browserTaskAllowed(rt.store, messageWake), false);
    const taskCount = rt.store.listTasksByWork(child.work.id).length;
    await assert.rejects(rt.subagents!.message({ senderTaskId: source.root.id, workId: child.work.id, key: "late", text: "迟到工作", toSubAgentId: child.agent.id, paramsDigest: "late" }));
    assert.equal(rt.store.listTasksByWork(child.work.id).length, taskCount);
  } finally { finishChild(); await t.shutdown(); }
});

test("Coding 定时工作流步骤和最终报告保持运行来源", async () => {
  const t = await startTestRuntime("code-scheduled-workflow", () => ({ kind: "text", text: "步骤完成" }), { config: { product: product.runtime } });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[0]);
    const workflow = rt.workflows!.start({ sourceTaskId: source.root.id, requestKey: "workflow", input: null,
      script: 'return await agent("step", {request: "完成步骤"});' });
    assert.equal(workflow.source.codeScheduledRunId, source.run.id);
    await waitFor("工作流完成", () => ["succeeded", "failed", "partial", "paused"].includes(requireWorkflowRun(rt.store, workflow.id).status));
    assert.equal(requireWorkflowRun(rt.store, workflow.id).status, "succeeded");
    const executions = listWorkflowExecutions(rt.store, workflow.id);
    assert.ok(executions.length > 0);
    for (const execution of executions) assert.equal(getCodeScheduleRunForTask(rt.store, execution.taskId)?.id, source.run.id);
    await waitFor("工作流报告已入队", () => requireWorkflowRun(rt.store, workflow.id).delivery?.taskId !== null && requireWorkflowRun(rt.store, workflow.id).delivery?.taskId !== undefined);
    const report = rt.store.getTask(requireWorkflowRun(rt.store, workflow.id).delivery!.taskId!)!;
    assert.equal(report.sessionId, source.session.id);
    assert.equal(getCodeScheduleRunForTask(rt.store, report.id)?.id, source.run.id);
    assert.deepEqual(report.modelSelection, source.run.snapshot.modelSelection);
  } finally { await t.shutdown(); }
});

test("根任务先结束时，迟到子结果进入父会话前不能关闭 Coding 调度运行", async () => {
  let finishChild!: () => void;
  const gate = new Promise<void>(resolve => { finishChild = resolve; });
  const t = await startTestRuntime("code-scheduled-late-result", async () => {
    await gate;
    return { kind: "text", text: "迟到子结果" };
  }, { config: { product: product.runtime } });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[0]);
    const child = await rt.subagents!.delegate({ parentTaskId: source.root.id, key: "late-result", request: "稍后完成", paramsDigest: "late-result" });
    await waitFor("子模型已开始", () => t.server.calls.length === 1);
    rt.store.withTx(() => rt.store.endTask(source.root.id, ["running"], "completed"));
    await waitFor("根结果已登记", () => rt.store.getTask(source.root.id)?.resultSummary !== null);
    finishChild();
    await waitFor("迟到结果路由完成", () => rt.store.findTaskByRequest(source.session.id, `wake:${child.task.id}`) !== null || getCodeScheduleRun(rt.store, source.run.id)?.closedAt !== null);
    assert.equal(getCodeScheduleRun(rt.store, source.run.id)?.closedAt, null);
    const wake = rt.store.findTaskByRequest(source.session.id, `wake:${child.task.id}`)!;
    assert.equal(wake.status, "queued");
    assert.equal(getCodeScheduleRunForTask(rt.store, wake.id)?.id, source.run.id);
  } finally { finishChild(); await t.shutdown(); }
});

test("Code工作流宿主操作保留运行反链，未知效果纳入整项恢复", async () => {
  const t = await startTestRuntime("cs-host", () => ({ kind: "text", text: "不应调用模型" }), { config: { product: product.runtime, workflowAgent: null } });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[0]);
    const workflow = rt.store.withTx(() => {
      const definition = saveWorkflowDefinition(rt.store, "return 1;");
      const run = createWorkflowRun(rt.store, { interfaceVersion: 2, id: "code-host", requestKey: "host", paramsDigest: "host", definitionId: definition.id, scriptDigest: definition.digest, input: null, inputDigest: "host",
        source: { product: "ruukoto-code", projectId: source.session.projectId, sessionId: source.session.id, taskId: source.root.id, permissionVersion: source.root.permissionVersion, accessMode: source.root.accessMode, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null, codeScheduledRunId: source.run.id },
        modelSelection: rt.defaultSelection, status: "running", version: 1, reason: null, attempts: 0, maxAttempts: 10, durationMs: 60_000, usedMs: 0, clockStartedAt: null, clockVerified: true, scriptUnits: [], scriptStopVerified: null, result: null, resultRecorded: false, createdAt: new Date().toISOString(), endedAt: null });
      registerWorkflowStep(rt.store, { runId: run.id, key: "host", ordinal: 1, kind: "integrate", params: {}, dependsOn: [] });
      return run;
    });
    let hostId = "";
    await rt.workflowHostOperation({ runId: workflow.id, stepKey: "host", key: "host", params: {} }, async (_execution, task) => { hostId = task.id; return { ok: true }; });
    assert.ok(hostId);
    assert.equal(getCodeScheduleRunForTask(rt.store, hostId)!.id, source.run.id);
    assert.equal(getCodeScheduledTaskSource(rt.store, hostId)!.runId, source.run.id);
    rt.store.withTx(() => rt.store.setEffectUnknown(hostId));
    await rt.codeScheduler!.scan();
    assert.equal(getCodeScheduleRun(rt.store, source.run.id)!.reason, "effect_unknown");
    assert.equal(rt.getCodeSchedule({ planId: source.plan.id }).plan.status, "paused");
    rt.store.withTx(() => {
      rt.store.endTask(source.root.id, ["running"], "completed");
      const current = requireWorkflowRun(rt.store, workflow.id);
      updateWorkflowRun(rt.store, { ...current, status: "failed", terminalVersion: current.version, resultRecorded: true,
        delivery: { version: current.version, facts: "宿主操作效果未知", text: "保留原记录", taskId: null, status: "pending", reason: null } });
    });
    await rt.codeScheduler!.scan();
    const detail = rt.getCodeSchedule({ planId: source.plan.id });
    const ack = await rt.controlCodeSchedule({ requestId: "host-ack", planId: source.plan.id, expectedVersion: detail.plan.version, control: "resume", acknowledgeRunId: source.run.id, expectedRunVersion: detail.activeRun!.version });
    assert.equal(ack.run!.status, "interrupted");
    assert.equal(requireWorkflowRun(rt.store, workflow.id).delivery!.status, "undelivered");
    assert.equal(rt.store.getTask(hostId)!.effectUnknown, true);
    assert.equal(t.server.calls.length, 0);
  } finally { await t.shutdown(); }
});

test("未知子结果的待报告可在版本绑定确认时终结为未送达，不要求新模型清账", async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await startTestRuntime("cs-unknown-report", async () => { await gate; return { kind: "text", text: "未知子结果" }; }, { config: { product: product.runtime } });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[0]);
    const child = await rt.subagents!.delegate({ parentTaskId: source.root.id, key: "unknown-child", request: "受控子任务", paramsDigest: "unknown-child" });
    await waitFor("子模型已开始", () => t.server.calls.length === 1);
    rt.store.withTx(() => {
      registerAgentWait(rt.store, { id: "unknown-wait", sdkCallId: "unknown-wait", taskId: source.root.id, sessionId: source.session.id, deadline: null, targets: [{ kind: "task", taskId: child.task.id }],
        source: child.task.readScope!.execution!.source, snapshot: { taskId: source.root.id, permissionVersion: source.root.permissionVersion, selectionRecordId: null, promptArtifactId: null, instructions: null, skills: null } });
      rt.store.endTask(source.root.id, ["running"], "completed");
      rt.store.setEffectUnknown(child.task.id);
    });
    release();
    await waitFor("未知结果等待报告", () => listAgentReports(rt.store).some(report => report.status === "pending") && rt.store.getTask(child.task.id)!.status === "completed");
    await rt.codeScheduler!.scan();
    await rt.resumeQueue(source.session.id);
    await rt.codeScheduler!.scan();
    const detail = rt.getCodeSchedule({ planId: source.plan.id });
    const input = { requestId: "ack", planId: source.plan.id, expectedVersion: detail.plan.version, control: "resume" as const, acknowledgeRunId: source.run.id, expectedRunVersion: detail.activeRun!.version };
    await assert.rejects(rt.controlCodeSchedule({ ...input, requestId: "stale", expectedRunVersion: 0 }), { code: "schedule_source_invalid" });
    assert.equal(listAgentReports(rt.store)[0].status, "pending");
    const confirmed = await rt.controlCodeSchedule(input);
    assert.equal(confirmed.run!.status, "interrupted"); assert.equal(confirmed.plan.status, "completed");
    assert.equal(listAgentReports(rt.store)[0].status, "undelivered");
    assert.equal(listAgentReports(rt.store)[0].reason, "effect_unknown_acknowledged");
    assert.equal(rt.store.getTask(child.task.id)!.effectUnknown, true);
    assert.equal(t.server.calls.length, 1);
  } finally { release(); await t.shutdown(); }
});

for (const ending of ["source-revoked", "work-canceled"] as const) test(`已停止子工作 ${ending} 不会永远等待无法产生的结果唤醒`, async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await startTestRuntime(`cs-${ending}`, async () => { await gate; return { kind: "text", text: "子任务已结束" }; }, { config: { product: product.runtime } });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[0]);
    const child = await rt.subagents!.delegate({ parentTaskId: source.root.id, key: "child", request: "受控子任务", paramsDigest: "child" });
    await waitFor("子模型已开始", () => t.server.calls.length === 1);
    if (ending === "source-revoked") rt.setWebSearch({ enabled: false, expectedVersion: rt.store.getWebSearch().version });
    else {
      const canceled = rt.subagents!.cancelWork({ workId: child.work.id, by: "owner", reason: "取消子工作", parentSessionId: source.session.id });
      release(); await canceled;
    }
    rt.store.withTx(() => rt.store.endTask(source.root.id, ["running"], "completed"));
    release();
    await waitFor("子结果落盘", () => rt.store.getTask(child.task.id)!.resultSummary !== null);
    await rt.codeScheduler!.scan();
    await waitFor("整项保留失败事实后关闭", () => getCodeScheduleRun(rt.store, source.run.id)!.closedAt !== null);
    assert.equal(getCodeScheduleRun(rt.store, source.run.id)!.status, "failed");
    assert.equal(rt.store.getTask(child.task.id)!.effectUnknown, false);
    assert.equal(rt.store.findTaskByRequest(source.session.id, `wake:${child.task.id}`), null);
    assert.equal(t.server.calls.length, 1);
  } finally { release(); await t.shutdown(); }
});
