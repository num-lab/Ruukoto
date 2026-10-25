import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { getCodeSchedule, getCodeScheduleRun, getCodeScheduledTaskSource, listCodeScheduleRunTasks, listCodeScheduleRuns, type CodeScheduleConfig } from "@ruukoto/core/code-scheduler.ts";
import { getOwnerQuestion } from "@ruukoto/core/owner-questions.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";

const epoch = Date.parse("2026-10-26T00:00:00.000Z");
async function fixture(prefix: string, responder: Parameters<typeof startTestRuntime>[1], real = false) {
  let clock = epoch;
  const t = await startTestRuntime(prefix, responder, { config: { product: product.runtime, scheduler: { now: () => clock, tickMs: 60_000 }, ...(real ? realTools() : {}) } });
  const { session } = await t.runtime.openWorkspace({ cwd: t.work[0], createRequestId: "workspace" });
  const config: CodeScheduleConfig = { title: "定时校验", instructions: "EXECUTE", workspaceId: session.projectId, permission: "full_access", modelSelection: t.runtime.defaultSelection,
    rule: { kind: "once", at: new Date(clock + 60_000).toISOString(), timeZone: "Asia/Tokyo", disambiguation: "compatible" } };
  return { ...t, session, config, clock: (value: number) => { clock = value; } };
}

test("七项配置经实际运行固定，写入选定工作区；关闭后手工聊天不改旧轮", async () => {
  const t = await fixture("code-schedule-run", req => !afterTool(req) ? { kind: "tool_calls", calls: [{ id: "write", name: "write", arguments: { path: "scheduled.txt", content: "完成" } }] } : { kind: "text", text: "完成" }, true);
  try {
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    assert.deepEqual(saved.plan.config, t.config);
    assert.equal(t.runtime.scheduler, null);
    await t.runtime.setSessionDefaultMode({ sessionId: t.session.id, mode: "confirm", expectedVersion: t.session.defaultAccessModeVersion });
    t.clock(epoch + 60_000); await t.runtime.codeScheduler!.scan();
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    assert.ok(run);
    await waitFor("整项定时运行结束", () => getCodeScheduleRun(t.runtime.store, run.id)!.closedAt !== null);
    const task = t.runtime.store.getTask(run.rootTaskId)!;
    assert.equal(task.input, t.config.instructions); assert.equal(task.accessMode, "full_access"); assert.equal(task.planMode, false);
    assert.deepEqual(task.modelSelection, t.config.modelSelection);
    assert.notEqual(task.sessionId, t.session.id);
    assert.equal(t.runtime.getSession(task.sessionId).name, t.config.title);
    assert.equal(t.runtime.getSession(task.sessionId).cwdReal, fs.realpathSync(t.work[0]));
    assert.equal(fs.readFileSync(path.join(t.work[0], "scheduled.txt"), "utf8"), "完成");
    assert.equal(getCodeScheduleRun(t.runtime.store, run.id)!.status, "completed");
    assert.equal(getCodeSchedule(t.runtime.store, saved.plan.id)!.status, "completed");
    assert.equal(t.runtime.snapshot().tasks.find(item => item.id === task.id)!.codeScheduleRunId, run.id);
    const before = getCodeScheduleRun(t.runtime.store, run.id);
    const manual = await t.runtime.submit({ sessionId: task.sessionId, requestId: "manual", input: "MANUAL", modelSelection: t.config.modelSelection });
    await waitFor("旧运行会话手工聊天完成", () => t.runtime.store.getTask(manual.id)!.status === "completed");
    assert.equal(manual.codeScheduleRunId, undefined);
    assert.deepEqual(getCodeScheduleRun(t.runtime.store, run.id), before);
  } finally { await t.shutdown(); }
});

test("停机只补最近周期；在途合并、编辑与暂停不改变本轮且恢复跳过暂停期间", async () => {
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const t = await fixture("code-schedule-coalesce", async () => { await hold; return { kind: "text", text: "完成" }; });
  try {
    t.config.rule = { kind: "daily", time: "00:01", timeZone: "UTC", disambiguation: "compatible" };
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    t.clock(epoch + 3 * 86_400_000 + 60_000); await t.runtime.codeScheduler!.scan();
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    assert.equal(run.scheduledAt, new Date(epoch + 3 * 86_400_000 + 60_000).toISOString());
    assert.equal(run.coalescedFrom, new Date(epoch + 60_000).toISOString());
    await waitFor("模型调用在途", () => t.server.calls.length === 1);
    t.clock(epoch + 5 * 86_400_000 + 60_000); await t.runtime.codeScheduler!.scan();
    assert.equal(listCodeScheduleRuns(t.runtime.store, { planId: saved.plan.id }).runs.length, 1);
    assert.equal(getCodeScheduleRun(t.runtime.store, run.id)!.coalescedThrough, new Date(epoch + 5 * 86_400_000 + 60_000).toISOString());
    const edited = await t.runtime.saveCodeSchedule({ requestId: "edit", planId: saved.plan.id, expectedVersion: saved.plan.version, config: { ...t.config, instructions: "NEXT", permission: "confirm" } });
    assert.deepEqual(getCodeScheduleRun(t.runtime.store, run.id)!.snapshot, t.config);
    const paused = await t.runtime.controlCodeSchedule({ requestId: "pause", planId: edited.plan.id, expectedVersion: edited.plan.version, control: "pause" });
    assert.equal(t.runtime.store.getTask(run.rootTaskId)!.status, "running");
    t.clock(epoch + 8 * 86_400_000 + 60_000); await t.runtime.codeScheduler!.scan();
    const resumed = await t.runtime.controlCodeSchedule({ requestId: "resume", planId: paused.plan.id, expectedVersion: paused.plan.version, control: "resume" });
    assert.equal(resumed.plan.nextDueAt, new Date(epoch + 9 * 86_400_000 + 60_000).toISOString());
    assert.equal(t.server.calls.length, 1);
    release(); await waitFor("原轮收尾", () => getCodeScheduleRun(t.runtime.store, run.id)!.closedAt !== null);
  } finally { release(); await t.shutdown(); }
});

test("定时根轮创建真实Git工作副本时，宿主Git任务也纳入同一运行", async () => {
  const t = await fixture("cs-git-host", req => lastUserText(req).includes("[SubAgent 委派") || afterTool(req) || lastUserText(req).startsWith("[编排器]") ? { kind: "text", text: "完成" } : { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { request: "检查工作副本", key: "git-child", target: "." } }] }, true);
  try {
    fs.writeFileSync(path.join(t.work[0], "source.txt"), "初始内容\n");
    initGitRepo(t.work[0]);
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    t.clock(epoch + 60_000); await t.runtime.codeScheduler!.scan();
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    await waitFor("Git定时整项结束", () => getCodeScheduleRun(t.runtime.store, run.id)!.closedAt !== null);
    const hosts = listCodeScheduleRunTasks(t.runtime.store, run.id).filter(task => task.requestId.startsWith("work-copy-host:"));
    assert.ok(hosts.length > 0);
    assert.ok(hosts.every(task => task.status === "completed" && task.modelSelection === null));
    assert.equal(getCodeScheduleRun(t.runtime.store, run.id)!.status, "completed");
  } finally { await t.shutdown(); }
});

test("接纳事务失败不留会话或任务、不调用模型，原到期时间重扫仅接纳一次", async () => {
  const t = await fixture("code-schedule-atomic", () => ({ kind: "text", text: "完成" }));
  try {
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    const count = t.runtime.store.listSessions().length;
    t.runtime.store.db.exec("CREATE TRIGGER code_schedule_fault BEFORE INSERT ON code_schedule_runs BEGIN SELECT RAISE(ABORT, 'schedule_fault'); END");
    t.clock(epoch + 60_000);
    await assert.rejects(t.runtime.codeScheduler!.scan());
    assert.equal(t.runtime.store.listSessions().length, count);
    assert.equal(t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs.length, 0);
    assert.equal(t.server.calls.length, 0);
    assert.equal(getCodeSchedule(t.runtime.store, saved.plan.id)!.nextDueAt, t.config.rule.kind === "once" ? t.config.rule.at : "");
    t.runtime.store.db.exec("DROP TRIGGER code_schedule_fault");
    await Promise.all([t.runtime.codeScheduler!.scan(), t.runtime.codeScheduler!.scan()]);
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    await waitFor("重扫后唯一执行", () => getCodeScheduleRun(t.runtime.store, run.id)!.closedAt !== null);
    assert.equal(t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs.length, 1);
    assert.equal(t.server.calls.length, 1);
  } finally { await t.shutdown(); }
});

test("问答沿固定快照续接，活动会话人工改配拒绝；取消后迟到回答不建任务", async () => {
  const t = await fixture("code-schedule-question", req => !afterTool(req) && lastUserText(req) === "EXECUTE" ? { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: "是否继续？", options: ["继续", "停止"] }] } }] } : { kind: "text", text: "已回答" }, true);
  try {
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    t.clock(epoch + 60_000); await t.runtime.codeScheduler!.scan();
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    await waitFor("定时问题可回答", () => t.runtime.listOwnerQuestions(run.sessionId).questions.length > 0 && t.runtime.store.getTask(run.rootTaskId)!.status === "completed");
    assert.equal(getCodeScheduleRun(t.runtime.store, run.id)!.closedAt, null);
    assert.equal(t.runtime.getSession(run.sessionId).codeScheduleActive, true);
    const session = t.runtime.getSession(run.sessionId), question = t.runtime.listOwnerQuestions(run.sessionId).questions[0];
    await assert.rejects(t.runtime.submit({ sessionId: session.id, requestId: "manual", input: "不能混入", modelSelection: t.config.modelSelection }), { code: "schedule_session_managed" });
    await assert.rejects(t.runtime.setSessionModel({ sessionId: session.id, expectedVersion: session.modelSelectionVersion, modelSelection: t.config.modelSelection }), { code: "schedule_session_managed" });
    await assert.rejects(t.runtime.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "confirm" }), { code: "schedule_session_managed" });
    await assert.rejects(t.runtime.switchTaskMode({ taskId: run.rootTaskId, mode: "confirm" }), { code: "schedule_session_managed" });
    const answer = { sessionId: session.id, questionId: question.id, version: question.version, requestId: "answer", answers: [{ text: "继续", option: 0 }], modelSelection: t.config.modelSelection };
    await assert.rejects(t.runtime.answerOwnerQuestion({ ...answer, accessMode: "confirm" }), { code: "schedule_configuration_fixed" });
    const continued = await t.runtime.answerOwnerQuestion(answer);
    assert.equal(continued.codeScheduleRunId, run.id);
    assert.equal(getCodeScheduledTaskSource(t.runtime.store, continued.id)!.runId, run.id);
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.answerSource!.kind, "coding-schedule");
    assert.equal(continued.accessMode, t.config.permission);
    await waitFor("回答后的整项收尾", () => getCodeScheduleRun(t.runtime.store, run.id)!.closedAt !== null);
    const next = await t.runtime.saveCodeSchedule({ requestId: "save-next", config: { ...t.config, rule: { ...t.config.rule, kind: "once", at: new Date(epoch + 120_000).toISOString() } } });
    t.clock(epoch + 120_000); await t.runtime.codeScheduler!.scan();
    const nextRun = t.runtime.getCodeSchedule({ planId: next.plan.id }).runs[0];
    await waitFor("第二轮提问", () => t.runtime.listOwnerQuestions(nextRun.sessionId).questions.length > 0);
    const late = t.runtime.listOwnerQuestions(nextRun.sessionId).questions[0];
    await t.runtime.controlCodeSchedule({ requestId: "cancel", planId: next.plan.id, expectedVersion: next.plan.version, control: "cancel" });
    const before = listCodeScheduleRunTasks(t.runtime.store, nextRun.id).length;
    await assert.rejects(t.runtime.answerOwnerQuestion({ ...answer, sessionId: nextRun.sessionId, questionId: late.id, version: late.version, requestId: "late" }));
    assert.equal(listCodeScheduleRunTasks(t.runtime.store, nextRun.id).length, before);
  } finally { await t.shutdown(); }
});

test("目录失效持久失败并暂停，模型零调用且不创建替代目录", async () => {
  const t = await fixture("cs-missing-dir", () => ({ kind: "text", text: "不应调用" }));
  try {
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    fs.renameSync(t.work[0], `${t.work[0]}-preserved`);
    t.clock(epoch + 60_000); await t.runtime.codeScheduler!.scan();
    const detail = t.runtime.getCodeSchedule({ planId: saved.plan.id });
    assert.equal(detail.plan.status, "paused"); assert.equal(detail.plan.reason, "schedule_workspace_invalid");
    assert.equal(detail.runs[0].status, "failed");
    assert.equal(t.server.calls.length, 0); assert.equal(fs.existsSync(t.work[0]), false);
    await assert.rejects(t.client.request("code_schedule_save", { request_id: "missing-save", config: t.config }), { code: "schedule_workspace_invalid" });
    await assert.rejects(t.client.request("code_schedule_control", { request_id: "missing-resume", plan_id: saved.plan.id, expected_version: detail.plan.version, control: "resume" }), { code: "schedule_workspace_invalid" });
  } finally { await t.shutdown(); }
});

test("定时问题回答在同一主会话完成，不把续接递归当作子结果唤醒", async () => {
  const t = await fixture("cs-own-answer", req => !afterTool(req) ? { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: "下一步？" }] } }] } : { kind: "text", text: "等待回答" }, true);
  try {
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    t.clock(epoch + 60_000); await t.runtime.codeScheduler!.scan();
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    await waitFor("首轮问题结束", () => t.runtime.listOwnerQuestions(run.sessionId).questions.length === 1 && t.runtime.store.getTask(run.rootTaskId)!.status === "completed");
    const question = t.runtime.listOwnerQuestions(run.sessionId).questions[0];
    const answer = await t.runtime.answerOwnerQuestion({ sessionId: run.sessionId, questionId: question.id, version: question.version, requestId: "answer", answers: [{ text: "继续提问" }], modelSelection: t.config.modelSelection });
    await waitFor("续接提问完成", () => t.runtime.listOwnerQuestions(run.sessionId).questions.length === 2 && t.runtime.store.getTask(answer.id)!.resultSummary !== null);
    assert.equal(t.runtime.store.findTaskByRequest(run.sessionId, `wake:${answer.id}`), null);
    assert.equal(t.runtime.store.listTasksBySession(run.sessionId).length, 2);
    assert.equal(getCodeScheduleRun(t.runtime.store, run.id)!.closedAt, null);
  } finally { await t.shutdown(); }
});

test("重启保留未执行原任务并暂停队列，显式恢复按原键执行", async () => {
  const t = await fixture("code-schedule-restart", () => ({ kind: "text", text: "完成" }));
  let restarted: Runtime | null = null;
  try {
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    const holder = t.runtime.store.withTx(() => {
      const task = t.runtime.store.insertQueuedTask({ sessionId: t.session.id, requestId: "holder", input: "hold", modelSelection: t.config.modelSelection, submissionDigest: "holder" }).task;
      t.runtime.store.transitionTask(task.id, ["queued"], "running");
      t.runtime.store.tryAcquireOccupancy({ cwdReal: t.work[0], cwdDev: t.session.cwdDev, cwdIno: t.session.cwdIno, sessionId: t.session.id, taskId: task.id });
      return task;
    });
    t.clock(epoch + 60_000); await t.runtime.codeScheduler!.scan();
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    await waitFor("等待工作区", () => t.runtime.store.getTask(run.rootTaskId)!.status === "queued");
    await t.runtime.stop("restart");
    restarted = await Runtime.start({ product: product.runtime, dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir, socketPath: t.runtime.socketPath(), modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off", scheduler: { now: () => epoch + 60_000, tickMs: 60_000 } });
    assert.equal(restarted.store.getTask(run.rootTaskId)!.status, "queued");
    assert.equal(restarted.getSession(run.sessionId).queueState, "paused");
    assert.equal(restarted.getCodeSchedule({ planId: saved.plan.id }).runs.length, 1);
    assert.equal(t.server.calls.length, 0);
    await restarted.resumeQueue(holder.sessionId);
    await restarted.resumeQueue(run.sessionId);
    await waitFor("原定时任务执行", () => restarted!.store.getTask(run.rootTaskId)!.status === "completed");
    assert.equal(t.server.calls.length, 1);
    assert.equal(restarted.getCodeSchedule({ planId: saved.plan.id }).runs[0].rootTaskId, run.rootTaskId);
  } finally { if (restarted) await restarted.stop("end"); await t.shutdown(); }
});

test("未知效果先核实遗留占用，再按运行版本确认仅开放未来周期", async () => {
  const t = await fixture("cs-unknown", () => ({ kind: "text", text: "未来周期" }));
  try {
    t.config.rule = { kind: "daily", time: "00:01", timeZone: "UTC", disambiguation: "compatible" };
    const saved = await t.runtime.saveCodeSchedule({ requestId: "save", config: t.config });
    const holder = t.runtime.store.withTx(() => {
      const task = t.runtime.store.insertQueuedTask({ sessionId: t.session.id, requestId: "holder", input: "hold", modelSelection: t.config.modelSelection, submissionDigest: "hold" }).task;
      t.runtime.store.transitionTask(task.id, ["queued"], "running");
      t.runtime.store.tryAcquireOccupancy({ cwdReal: t.work[0], cwdDev: t.session.cwdDev, cwdIno: t.session.cwdIno, sessionId: t.session.id, taskId: task.id });
      return task;
    });
    t.clock(epoch + 60_000); await t.runtime.codeScheduler!.scan();
    const run = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    // 用持久中断事实模拟执行边界的未知回执，不声称这个夹具核实了真实进程。
    t.runtime.store.withTx(() => {
      t.runtime.store.setSessionQueueState(run.sessionId, "paused", "test_unknown");
      t.runtime.store.endTask(holder.id, ["running"], "completed");
      t.runtime.store.tryAcquireOccupancy({ cwdReal: t.work[0], cwdDev: t.session.cwdDev, cwdIno: t.session.cwdIno, sessionId: run.sessionId, taskId: run.rootTaskId });
      t.runtime.store.transitionTask(run.rootTaskId, ["queued"], "running");
      t.runtime.store.setEffectUnknown(run.rootTaskId);
      t.runtime.store.endTask(run.rootTaskId, ["running"], "interrupted", { keepOccupancy: true });
    });
    await t.runtime.codeScheduler!.scan();
    let detail = t.runtime.getCodeSchedule({ planId: saved.plan.id });
    assert.equal(detail.activeRun!.reason, "stop_unverified");
    await assert.rejects(t.runtime.controlCodeSchedule({ requestId: "unsafe", planId: saved.plan.id, expectedVersion: detail.plan.version, control: "resume", acknowledgeRunId: run.id, expectedRunVersion: detail.activeRun!.version }), { code: "schedule_stop_unverified" });
    assert.equal(t.server.calls.length, 0);
    const view = new ViewState(); view.applySnapshot(await t.client.handshake(), false);
    const projection = (events: import("@ruukoto/core/types.ts").PersistentEvent[]) => { for (const event of events) view.applyEvent(event, "live"); };
    t.runtime.addEventListener(projection);
    await t.runtime.resumeQueue(run.sessionId);
    assert.equal(view.sessions.find(session => session.id === run.sessionId)!.queueState, "paused");
    assert.equal(view.sessions.find(session => session.id === run.sessionId)!.queuePauseReason, "schedule_recovery_required");
    t.runtime.removeEventListener(projection);
    await t.runtime.codeScheduler!.scan();
    detail = t.runtime.getCodeSchedule({ planId: saved.plan.id });
    assert.equal(detail.activeRun!.reason, "effect_unknown");
    assert.equal(t.runtime.store.getTask(run.rootTaskId)!.effectUnknown, true);
    await assert.rejects(t.runtime.controlCodeSchedule({ requestId: "stale", planId: saved.plan.id, expectedVersion: detail.plan.version, control: "resume", acknowledgeRunId: run.id, expectedRunVersion: detail.activeRun!.version - 1 }), { code: "schedule_source_invalid" });
    const confirmed = await t.runtime.controlCodeSchedule({ requestId: "ack", planId: saved.plan.id, expectedVersion: detail.plan.version, control: "resume", acknowledgeRunId: run.id, expectedRunVersion: detail.activeRun!.version });
    assert.equal(confirmed.run!.status, "interrupted");
    assert.equal(confirmed.plan.nextDueAt, new Date(epoch + 86_400_000 + 60_000).toISOString());
    assert.equal(t.runtime.store.getTask(run.rootTaskId)!.effectUnknown, true);
    assert.equal(t.server.calls.length, 0);
    t.clock(epoch + 86_400_000 + 60_000); await t.runtime.codeScheduler!.scan();
    const future = t.runtime.getCodeSchedule({ planId: saved.plan.id }).runs[0];
    assert.notEqual(future.rootTaskId, run.rootTaskId);
    await waitFor("只执行未来新周期", () => getCodeScheduleRun(t.runtime.store, future.id)!.closedAt !== null);
    assert.equal(t.server.calls.length, 1);
  } finally { await t.shutdown(); }
});
