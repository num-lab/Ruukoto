import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@ruukoto/core/types.ts";
import { getWorkflowDeliveryRun, getWorkflowQuestion, listWorkflowExecutions, listWorkflowRuns, requireWorkflowRun, updateWorkflowRun, workflowDeliveryKey } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { parseRule, firstDue } from "@ruukoto/channels/scheduler/time.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot } from "./helpers/mock-onebot.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

function source(rt: Runtime, session: Session) {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "拥有者批量任务", accessMode: "full_access",
      modelSelection: rt.defaultSelection, submissionDigest: "source" }).task;
    rt.store.transitionTask(task.id, ["queued"], "running"); return rt.store.getTask(task.id)!;
  });
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("dev 最终汇总排在当前聊天之后，冻结终态代次、零工具且只唤醒一次；普通请求键不能伪造绑定", async () => {
  const child = latch(), chat = latch();
  const t = await startTestRuntime("workflow-final-dev", async req => {
    if (lastUserText(req) === "日常聊天") { await chat.promise; return { kind: "text", text: "聊天完成" }; }
    if (lastUserText(req).startsWith("[工作流最终回报]")) { assert.deepEqual(toolNamesOf(req), []); return { kind: "text", text: "最终汇总" }; }
    return { kind: "text", text: "普通任务" };
  }, { config: { product: codeProduct.runtime, workflowAgent: async () => { await child.promise; return { output: "步骤资料" }; } } });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "final", input: null, script: 'return await agent("one",{request:"处理"});' });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await rt.resumeQueue(session.id);
    await rt.submit({ sessionId: session.id, requestId: "chat", input: "日常聊天", modelSelection: rt.defaultSelection });
    await waitFor("聊天已进入模型", () => t.server.calls.length === 1);
    child.release();
    await waitFor("最终汇总已排队", () => requireWorkflowRun(rt.store, run.id).delivery?.taskId != null);
    const finished = requireWorkflowRun(rt.store, run.id), wake = rt.store.getTask(finished.delivery!.taskId!)!;
    assert.equal(wake.status, "queued"); assert.equal(wake.agentId, null); assert.equal(wake.sourceEventId, null);
    assert.equal(getWorkflowDeliveryRun(rt.store, wake.id)!.id, run.id);
    const key = workflowDeliveryKey(finished);
    rt.store.withTx(() => updateWorkflowRun(rt.store, requireWorkflowRun(rt.store, run.id)));
    assert.equal(workflowDeliveryKey(requireWorkflowRun(rt.store, run.id)), key);
    await assert.rejects(rt.submit({ sessionId: session.id, requestId: key, input: wake.input, modelSelection: rt.defaultSelection }), { code: "request_conflict" });
    assert.equal(t.server.calls.length, 1);
    chat.release();
    await waitFor("最终汇总完成", () => requireWorkflowRun(rt.store, run.id).delivery?.status === "reported");
    assert.equal(rt.store.findTaskByRequest(session.id, key)!.id, wake.id);
    assert.equal(t.server.calls.length, 2);
    assert.equal(rt.store.listTasksBySession(session.id).some(task => task.requestId.startsWith("wake:")), false);
    const fake = await rt.submit({ sessionId: session.id, requestId: "workflow-final:fake:1", input: "普通输入", modelSelection: rt.defaultSelection });
    await waitFor("普通请求完成", () => rt.store.getTask(fake.id)!.status === "completed");
    assert.equal(getWorkflowDeliveryRun(rt.store, fake.id), null);
    assert.ok(toolNamesOf(t.server.calls[2]).includes("mock_delay"));
  } finally { child.release(); chat.release(); await t.shutdown(); }
});

for (const window of ["queued", "result-missing"] as const) test(`dev 冷恢复 ${window}：复用原汇总任务和键，结果事务补记一次`, async () => {
  const t = await startTestRuntime("workflow-final-recover", () => ({ kind: "text", text: "唯一汇总" }), { config: { product: codeProduct.runtime } });
  let restarted: Runtime | null = null;
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "recover", input: null, script: 'return await progress("done",{text:"完成"});' });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("唯一汇总已登记", () => requireWorkflowRun(rt.store, run.id).delivery?.taskId != null);
    const before = requireWorkflowRun(rt.store, run.id), taskId = before.delivery!.taskId!, key = workflowDeliveryKey(before);
    if (window === "result-missing") {
      await rt.orchestrator!.stop();
      await rt.resumeQueue(session.id);
      await waitFor("结果落盘窗口前任务完成", () => rt.store.getTask(taskId)!.status === "completed");
      assert.equal(rt.store.getTask(taskId)!.resultSummary, null);
    }
    t.client.close(); await rt.stop("test_restart");
    restarted = await Runtime.start(rt.config);
    if (window === "queued") await restarted.resumeQueue(session.id);
    const after = restarted;
    await waitFor("恢复补记汇总结果", () => requireWorkflowRun(after.store, run.id).delivery?.status === "reported");
    assert.equal(requireWorkflowRun(after.store, run.id).delivery!.taskId, taskId);
    assert.equal(after.store.findTaskByRequest(session.id, key)!.id, taskId);
    assert.equal(after.store.listTasksBySession(session.id).filter(task => getWorkflowDeliveryRun(after.store, task.id)).length, 1);
    assert.equal(t.server.calls.length, 1);
    assert.equal(after.store.getTask(taskId)!.resultSummary, "唯一汇总");
  } finally { await restarted?.stop("test_end"); await t.shutdown(); }
});

for (const platform of ["telegram", "qq_private"] as const) test(`${platform} 真实适配器替身：等待不占聊天，业务回答去重，最终仅沿原入口一次回报`, async () => {
  const api = new FakeBotApi({ token: "123:workflow-secret", ownerId: 42 }), apiBase = await api.start();
  const qq = await startMockOneBot({});
  let rt!: Runtime;
  const t = await startTestRuntime("workflow-final-im", req => {
    const text = lastUserText(req);
    if (text.includes("START-WORKFLOW") && !text.startsWith("[工作流最终回报]")) {
      const main = rt.store.getAgentRole("main")!;
      const task = rt.store.listTasksBySession(main.sessionId).find(item => item.status === "running")!;
      rt.workflows!.start({ sourceTaskId: task.id, requestKey: "im", input: null, script: 'await ask("question",{prompt:"业务选择",options:["yes","no"]}); return await Promise.all([agent("good",{request:"成功项"}),agent("bad",{request:"失败项",output:{format:"json",schema:{type:"number"}}})]);' });
      return { kind: "text", text: "已受理" };
    }
    if (text.startsWith("[工作流最终回报]")) { assert.deepEqual(toolNamesOf(req), []); return { kind: "text", text: `IM-FINAL${"全部成功".repeat(1500)}` }; }
    return { kind: "text", text: "CHAT-OK" };
  }, { config: { workflowAgent: async () => ({ output: "步骤正文" }), scheduler: { tickMs: 20 }, qq: { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 30, reconnectMaxMs: 100 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } } });
  rt = t.runtime;
  let seq = 900;
  const push = (text: string) => platform === "telegram" ? api.push({ text }) : qq.pushPrivateMessage({ userId: "880001", messageId: seq++, segments: [{ type: "text", data: { text } }] });
  try {
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: "123:workflow-secret" });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await rt.addCredentialBinding({ name: "qq", host: qq.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
    await rt.qqConfigure({ endpoint: qq.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq", ownerUserId: "880001" }); await rt.qqSetEnabled(true);
    await waitFor("双平台在线", () => rt.telegramStatus().online === true && rt.qqStatus().online === true);
    push("START-WORKFLOW");
    await waitFor("持久问题与通知", () => listWorkflowRuns(rt.store).length === 1 && rt.sched.listOps({ limit: 50 }).items.some(op => op.sourceKind === "workflow_question" && op.status === "sent"));
    const run = listWorkflowRuns(rt.store)[0], q = getWorkflowQuestion(rt.store, run.id, "question")!;
    push("日常聊天"); await waitFor("等待中仍完成聊天", () => t.server.calls.length === 2);
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.status, "pending");
    const wrong = `/workflow-answer ${run.id} question ${q.runVersion} ${q.version} "yes"`;
    if (platform === "telegram") qq.pushPrivateMessage({ userId: "880001", messageId: seq++, segments: [{ type: "text", data: { text: wrong } }] });
    else api.push({ text: wrong });
    await waitFor("跨平台拒绝控制回执", () => rt.store.db.prepare("SELECT 1 FROM inbound_events WHERE event_kind = 'im_workflow'").get() !== undefined);
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.status, "pending");
    const reply = push(wrong);
    await waitFor("原入口最终回报", () => rt.sched.listOps({ limit: 100 }).items.some(op => op.sourceKind === "owner_reply" && op.sourceKey.includes("#workflow-final:") && op.status === "sent"));
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "partial");
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.answer, "yes");
    assert.equal(t.server.calls.length, 3, "两条普通消息和一轮整项最终汇总；控制命令不调用模型");
    if (platform === "telegram") api.push({ message: reply });
    else qq.pushPrivateMessage({ userId: "880001", messageId: seq - 1, segments: [{ type: "text", data: { text: wrong } }] });
    await rt.scheduler!.tick(); await rt.scheduler!.idle();
    const reports = rt.sched.listOps({ limit: 100 }).items.filter(op => op.sourceKind === "owner_reply" && op.sourceKey.includes("#workflow-final:"));
    assert.equal(reports.length, 1); assert.equal(reports[0].target.channel, platform); assert.match(reports[0].text, /IM-FINAL/);
    assert.match(reports[0].text, /终态 partial/); assert.match(reports[0].text, /步骤 bad：failed/);
    assert.equal(rt.store.listTasksBySession(run.source.sessionId).some(task => task.requestId.startsWith("wake:")), false);
  } finally { await t.shutdown(); await api.close(); await qq.close(); }
});

for (const mode of ["success", "retry", "cancel"] as const) test(`定时工作流 ${mode}：根任务结束不提前关闭，最终仅调度路径`, async () => {
  const cancel = mode === "cancel";
  const target = { channel: "telegram", account: "1", chatId: "42", configVersion: 1 }, clock = { now: Date.parse("2026-10-12T00:00:00Z") };
  const reports: string[] = [], branch = latch(); let rt!: Runtime;
  const finalReports = () => reports.filter(text => !text.startsWith("【工作流需要回答】"));
  const t = await startTestRuntime("workflow-final-scheduler", req => {
    if (lastUserText(req).startsWith("[工作流最终回报]")) { assert.deepEqual(toolNamesOf(req), []); return { kind: "text", text: "SCHEDULE-FINAL" }; }
    const task = rt.store.listTasksByStatus(["running"]).find(item => rt.store.getSessionIdentity(item.sessionId)?.kind === "scheduled")!;
    rt.workflows!.start({ sourceTaskId: task.id, requestKey: "question", input: null, script: 'return await ask("question",{prompt:"继续?"});' });
    rt.workflows!.start({ sourceTaskId: task.id, requestKey: "branch", input: null, script: 'return await agent("branch",{request:"独立工作"});' });
    return { kind: "text", text: "ROOT-ACK" };
  }, { config: { qqDisabled: true, workflowAgent: async context => { await branch.promise; return { output: "分支完成", isError: mode === "retry" && context.step.attempts === 1 }; },
    scheduler: { now: () => clock.now, tickMs: 0, channel: { target: () => target, send: async input => { reports.push(input.text); return { platformMessageId: "sent" }; } } } } });
  rt = t.runtime;
  try {
    const main = rt.store.getAgentRole("main")!, rule = parseRule({ kind: "once", at: "2026-10-12T00:00:01Z", time_zone: "UTC" });
    const schedule = rt.store.withTx(() => rt.sched.insertSchedule({ createKey: "workflow", paramsDigest: "workflow", createTaskId: null, createOpId: null,
      projectId: main.projectId, createPermissionVersion: 1, accessMode: "full_access", rule, instruction: "启动工作流", sourceRefs: [], target,
      nextDueAt: firstDue(rule, clock.now), tzData: "test", reason: "test" }, "test"));
    clock.now += 1000; await rt.scheduler!.tick();
    await waitFor("根任务结果已记录，问题仍等待", () => listWorkflowRuns(rt.store).length === 2 && listWorkflowRuns(rt.store).some(run => run.status === "waiting") &&
      rt.store.getTask(rt.sched.listRuns(schedule.id, 1)[0].rootTaskId!)!.resultSummary !== null);
    const scheduled = rt.sched.listRuns(schedule.id, 1)[0];
    rt.scheduler!.closeFinished(); assert.equal(rt.sched.getRun(scheduled.id)!.closedAt, null); assert.equal(finalReports().length, 0);
    const run = listWorkflowRuns(rt.store).find(item => item.requestKey === "question")!, q = getWorkflowQuestion(rt.store, run.id, "question")!;
    if (cancel) {
      await rt.scheduleCancel({ scheduleId: schedule.id, expectedVersion: schedule.version, reason: "取消计划" });
      assert.ok(listWorkflowRuns(rt.store).every(item => item.status === "canceled"));
      assert.throws(() => rt.answerWorkflowQuestion({ runId: run.id, stepKey: "question", version: q.version, runVersion: q.runVersion, requestKey: "late", answer: "yes" }), { code: "stale_answer" });
    } else {
      rt.answerWorkflowQuestion({ runId: run.id, stepKey: "question", version: q.version, runVersion: q.runVersion, requestKey: "answer", answer: "yes" });
      await waitFor("问题运行汇总完成", () => requireWorkflowRun(rt.store, run.id).delivery?.status === "reported");
      rt.scheduler!.closeFinished(); assert.equal(rt.sched.getRun(scheduled.id)!.closedAt, null);
    }
    branch.release();
    await waitFor("全部运行终态收尾", () => listWorkflowRuns(rt.store).every(item => item.delivery?.status === (cancel ? "undelivered" : "reported")));
    rt.scheduler!.closeFinished(); await rt.scheduler!.tick(); await rt.scheduler!.idle();
    assert.equal(rt.sched.getRun(scheduled.id)!.resultStatus, cancel ? "canceled" : "completed");
    if (mode === "retry") assert.equal(listWorkflowRuns(rt.store).find(workflow => workflow.requestKey === "branch")!.attempts, 2);
    assert.equal(finalReports().length, cancel ? 0 : 1);
    assert.equal(rt.sched.listOps({ limit: 100 }).items.filter(op => op.sourceKind === "owner_reply").length, 0);
    if (!cancel) assert.match(finalReports()[0], /SCHEDULE-FINAL/);
  } finally { branch.release(); await t.shutdown(); }
});

test("真实工作流步骤取消自身计划：工具返回后核实停止，不等待自己的 SDK abort", async () => {
  const target = { channel: "telegram", account: "1", chatId: "42", configVersion: 1 }, clock = { now: Date.parse("2026-10-12T00:00:00Z") };
  let rt!: Runtime, scheduleId = "";
  const t = await startTestRuntime("workflow-self-cancel", req => {
    const text = lastUserText(req);
    if (text.includes('"request":"取消自身计划"')) {
      if (afterTool(req)) return { kind: "text", text: "取消已记录" };
      const schedule = rt.sched.getSchedule(scheduleId)!;
      return { kind: "tool_calls", calls: [{ id: "cancel-self", name: "schedule_cancel",
        arguments: { schedule_id: scheduleId, expected_version: schedule.version, reason: "取消所属计划" } }] };
    }
    const task = rt.store.listTasksByStatus(["running"]).find(item => rt.store.getSessionIdentity(item.sessionId)?.kind === "scheduled")!;
    rt.workflows!.start({ sourceTaskId: task.id, requestKey: "self", input: null,
      script: 'return await agent("self",{request:"取消自身计划",tools:["schedule_cancel"]});' });
    return { kind: "text", text: "已启动" };
  }, { config: { ...realTools(), qqDisabled: true, scheduler: { now: () => clock.now, tickMs: 0,
    channel: { target: () => target, send: async () => ({ platformMessageId: "sent" }) } } } });
  rt = t.runtime;
  try {
    const main = rt.store.getAgentRole("main")!, rule = parseRule({ kind: "once", at: "2026-10-12T00:00:01Z", time_zone: "UTC" });
    const schedule = rt.store.withTx(() => rt.sched.insertSchedule({ createKey: "self", paramsDigest: "self", createTaskId: null, createOpId: null,
      projectId: main.projectId, createPermissionVersion: 1, accessMode: "full_access", rule, instruction: "取消工作流计划", sourceRefs: [], target,
      nextDueAt: firstDue(rule, clock.now), tzData: "test", reason: "test" }, "test"));
    scheduleId = schedule.id; clock.now += 1000; await rt.scheduler!.tick();
    await waitFor("自身取消工具已返回并完成停止", () => {
      const workflow = listWorkflowRuns(rt.store)[0];
      return workflow?.status === "canceled" && listWorkflowExecutions(rt.store, workflow.id).every(execution => execution.stopVerified === true && execution.status === "finished");
    });
    const workflow = listWorkflowRuns(rt.store)[0], execution = listWorkflowExecutions(rt.store, workflow.id)[0];
    assert.equal(rt.sched.getSchedule(scheduleId)!.status, "canceled");
    assert.equal(rt.store.listToolOpsByTask(execution.taskId).find(op => op.toolName === "schedule_cancel")!.resultSummary !== null, true);
    assert.ok(["canceled", "interrupted"].includes(rt.store.getTask(execution.taskId)!.status));
    assert.equal(rt.store.getTask(execution.taskId)!.cancelRequested, true);
    assert.equal(t.server.calls.length, 2, "根任务与步骤首次调用；取消后无新模型请求");
    assert.equal(rt.store.listAllOccupancy().length, 0);
    await waitFor("脚本与任务结果收尾后关闭调度", () => { rt.scheduler!.closeFinished(); return rt.sched.listRuns(scheduleId, 1)[0].resultStatus === "canceled"; });
    assert.equal(rt.sched.listRuns(scheduleId, 1)[0].resultStatus, "canceled");
  } finally { await t.shutdown(); }
});
