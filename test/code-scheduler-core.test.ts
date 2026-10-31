import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import {
  bindCodeScheduleTask, closeCodeScheduleRun, codeScheduleRunStopped, coalesceCodeScheduleRun, controlCodeSchedule,
  findCodeScheduleReceipt, getCodeSchedule, getCodeScheduleRun, getCodeScheduleRunForTask, getCodeScheduledTaskSource,
  listCodeScheduleRuns, listCodeScheduleRunTasks, listCodeSchedules, listDueCodeSchedules,
  parseCodeScheduleConfig, pauseCodeSchedule, registerCodeScheduleRun, saveCodeSchedule, updateCodeScheduleRun,
  type CodeScheduleConfig, type CodeSchedulePlan, type CodeScheduleRun,
} from "@ruukoto/core/code-scheduler.ts";
import { consumeOwnerQuestion, createOwnerQuestion, getOwnerQuestion, ownerQuestionTaskEligible } from "@ruukoto/core/owner-questions.ts";
import { getBackgroundProcess, handoffBackgroundProcess, registerBackgroundProcess } from "@ruukoto/core/background-processes.ts";
import { sha256File } from "@ruukoto/core/import-support.ts";
import { previewLegacyImport } from "../apps/ruukoto-code/src/legacy-import.ts";

const NOW = "2026-10-26T00:00:00.000Z", DUE = "2026-10-26T00:01:00.000Z", NEXT = "2026-10-27T00:01:00.000Z";
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-scheduler-core-"))), data = path.join(root, "data");
  fs.mkdirSync(data);
  const db = new Db(data), store = new Store(db), stat = fs.statSync(root), workspace = { cwd: root, cwdReal: root, dev: stat.dev, ino: stat.ino };
  let closed = false;
  function close() { if (!closed) { db.close(); closed = true; } }
  t.after(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = store.withTx(() => store.createProject("scheduled", null, workspace));
  const config: CodeScheduleConfig = { title: "检查工作区", instructions: "检查测试并保存结果", workspaceId: project.id, permission: "full_access", modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "high" }, rule: { kind: "daily", time: "00:01", timeZone: "UTC", disambiguation: "compatible" } };
  let counter = 0;
  const save = (changes: Partial<CodeScheduleConfig> = {}) => store.withTx(() => saveCodeSchedule(store, { requestId: `save-${++counter}`, config: { ...config, ...changes }, workspace, nextDueAt: DUE, now: NOW }));
  function admit(plan: CodeSchedulePlan): CodeScheduleRun {
    return store.withTx(() => {
      const session = store.createSession({ projectId: plan.config.workspaceId, name: plan.config.title, cwd: root, cwdReal: root, cwdDev: workspace.dev, cwdIno: workspace.ino, piSessionId: `pi-${++counter}`, confirmTools: [], modelSelection: plan.config.modelSelection, defaultAccessMode: plan.config.permission });
      const task = store.insertQueuedTask({ sessionId: session.id, requestId: "scheduled-root", input: plan.config.instructions, accessMode: plan.config.permission, modelSelection: plan.config.modelSelection, submissionDigest: "root" }).task;
      return registerCodeScheduleRun(store, { scheduleId: plan.id, expectedVersion: plan.version, sessionId: session.id, rootTaskId: task.id, scheduledAt: DUE, coalescedFrom: DUE, coalescedThrough: DUE, nextDueAt: plan.config.rule.kind === "once" ? null : NEXT, now: DUE });
    });
  }
  function child(run: CodeScheduleRun, parentTaskId = run.rootTaskId) {
    return store.withTx(() => {
      const parent = store.getTask(parentTaskId)!;
      const task = store.insertQueuedTask({ sessionId: run.sessionId, requestId: `child-${++counter}`, input: "继续原工作", accessMode: run.snapshot.permission, parentTaskId, sourcePermissionVersion: parent.permissionVersion, modelSelection: run.snapshot.modelSelection, submissionDigest: "child" }).task;
      bindCodeScheduleTask(store, { runId: run.id, taskId: task.id, sourceTaskId: parentTaskId });
      return task;
    });
  }
  return { root, data, db, store, workspace, config, save, admit, child, close };
}

test("配置严格校验字段、周期与UTF8正文大小，中文上限保存后可分页回读", t => {
  const f = fixture(t), { config, store } = f;
  assert.throws(() => parseCodeScheduleConfig({ ...config, source: "coding-owner" }), { code: "invalid_params" });
  assert.throws(() => parseCodeScheduleConfig({ ...config, permission: "plan" }), { code: "invalid_params" });
  assert.throws(() => parseCodeScheduleConfig({ ...config, rule: { ...config.rule, at: DUE } }), { code: "invalid_schedule_rule" });
  assert.throws(() => parseCodeScheduleConfig({ ...config, rule: { kind: "weekly", time: "10:00", weekdays: [1, 1], timeZone: "UTC", disambiguation: "compatible" } }), { code: "invalid_schedule_rule" });
  assert.throws(() => parseCodeScheduleConfig({ ...config, instructions: "文".repeat(21846) }), { code: "invalid_params" });
  const instructions = "文".repeat(21845) + "a";
  assert.equal(Buffer.byteLength(instructions), 64 * 1024);
  const saved = f.save({ instructions });
  assert.equal(getCodeSchedule(store, saved.plan.id)!.config.instructions, instructions);
  const page = listCodeSchedules(store);
  assert.equal(page.plans[0].config.instructions, instructions);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
});

test("稳定请求键返回原回执，异参和版本竞争不改状态或事件", t => {
  const f = fixture(t), { store, config, workspace } = f;
  const input = { requestId: "stable", config, workspace, nextDueAt: DUE, now: NOW };
  const saved = store.withTx(() => saveCodeSchedule(store, input)), seq = store.getMaxSeq();
  assert.deepEqual(store.withTx(() => saveCodeSchedule(store, input)), saved);
  assert.deepEqual(findCodeScheduleReceipt(store, "stable"), saved);
  assert.throws(() => store.withTx(() => saveCodeSchedule(store, { ...input, config: { ...config, title: "不同" } })), { code: "request_conflict" });
  assert.throws(() => store.withTx(() => saveCodeSchedule(store, { ...input, requestId: "update", planId: saved.plan.id, expectedVersion: 7 })), { code: "schedule_version_conflict" });
  assert.equal(store.getMaxSeq(), seq);
  assert.equal(listCodeSchedules(store).plans.length, 1);
});

test("接纳事件失败回滚运行、会话、任务、反链与下一时间", t => {
  const f = fixture(t), { store, db } = f, plan = f.save().plan, seq = store.getMaxSeq();
  db.exec("CREATE TRIGGER reject_schedule_event BEFORE INSERT ON events WHEN json_extract(NEW.body, '$.type') = 'code_schedule.run_changed' BEGIN SELECT RAISE(ABORT, 'schedule event failed'); END");
  assert.throws(() => f.admit(plan), /schedule event failed/);
  for (const table of ["sessions", "tasks", "code_schedule_runs", "code_schedule_tasks"]) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  assert.equal(getCodeSchedule(store, plan.id)!.nextDueAt, DUE);
  assert.equal(store.getMaxSeq(), seq);
  db.exec("DROP TRIGGER reject_schedule_event");
  const run = f.admit(plan);
  assert.equal(store.getSession(run.sessionId)!.name, plan.config.title);
  assert.equal(getCodeSchedule(store, plan.id)!.nextDueAt, NEXT);
  assert.equal(listDueCodeSchedules(store, DUE).length, 0);
  assert.equal(getCodeScheduledTaskSource(store, run.rootTaskId)!.runId, run.id);
  assert.equal(listCodeScheduleRuns(store, { planId: plan.id }).runs.length, 1);
});

test("编辑保留创建时区，未知工具结果在扫描前也阻止迟到派生", t => {
  const f = fixture(t), plan = f.save().plan;
  assert.throws(() => f.store.withTx(() => saveCodeSchedule(f.store, { requestId: "timezone", planId: plan.id, expectedVersion: plan.version, config: { ...f.config, rule: { ...f.config.rule, timeZone: "Asia/Tokyo" } }, workspace: f.workspace, nextDueAt: NEXT, now: DUE })), { code: "schedule_timezone_fixed" });
  const run = f.admit(plan);
  f.store.withTx(() => {
    f.store.recordToolIntent({ id: "unknown-write", taskId: run.rootTaskId, sessionId: run.sessionId, toolName: "write", params: {} });
    f.store.markToolOpEffectUnknown("unknown-write");
  });
  assert.equal(f.store.getTask(run.rootTaskId)!.effectUnknown, false);
  assert.throws(() => f.child(run), { code: "schedule_recovery_required" });
  assert.equal(listCodeScheduleRunTasks(f.store, run.id).length, 1);
  assert.equal(f.store.listTasksBySession(run.sessionId).length, 1);
});

test("编辑只改未来配置，活动运行合并后取消会截住迟到续接", t => {
  const f = fixture(t), { store } = f, plan = f.save().plan, run = f.admit(plan), child = f.child(run);
  const updated = store.withTx(() => saveCodeSchedule(store, { requestId: "edit", planId: plan.id, expectedVersion: plan.version, config: { ...f.config, instructions: "新版说明", permission: "confirm" }, workspace: f.workspace, nextDueAt: NEXT, now: DUE }));
  assert.equal(getCodeScheduleRun(store, run.id)!.snapshot.instructions, f.config.instructions);
  assert.equal(getCodeScheduleRun(store, run.id)!.snapshot.permission, "full_access");
  store.withTx(() => coalesceCodeScheduleRun(store, { runId: run.id, through: NEXT, nextDueAt: "2026-10-28T00:01:00.000Z", now: NEXT }));
  assert.equal(getCodeScheduleRun(store, run.id)!.coalescedThrough, NEXT);
  assert.equal(listCodeScheduleRunTasks(store, run.id).length, 2);
  const canceled = store.withTx(() => controlCodeSchedule(store, { requestId: "cancel", planId: plan.id, expectedVersion: updated.plan.version, control: "cancel", now: NEXT }));
  assert.equal(canceled.run!.cancelRequested, true);
  assert.throws(() => getCodeScheduledTaskSource(store, child.id), { code: "schedule_source_invalid" });
  const count = listCodeScheduleRunTasks(store, run.id).length;
  assert.throws(() => f.child(run, child.id), { code: "schedule_source_invalid" });
  assert.equal(listCodeScheduleRunTasks(store, run.id).length, count);
  assert.equal(getCodeScheduleRunForTask(store, child.id)!.id, run.id);
  assert.equal(ownerQuestionTaskEligible(store, store.getTask(run.rootTaskId)!), false);
});

test("伪造来源反链和无归属任务不获得定时会话资格", t => {
  const f = fixture(t), { store, db } = f, run = f.admit(f.save().plan), child = f.child(run);
  db.prepare("UPDATE code_schedule_tasks SET source_task_id = NULL WHERE task_id = ?").run(child.id);
  assert.throws(() => getCodeScheduledTaskSource(store, child.id), { code: "schedule_source_invalid" });
  const unbound = store.withTx(() => store.insertQueuedTask({ sessionId: run.sessionId, requestId: "unbound", input: "普通输入", accessMode: "full_access", modelSelection: f.config.modelSelection, submissionDigest: "unbound" }).task);
  assert.equal(ownerQuestionTaskEligible(store, unbound), false);
  assert.throws(() => getCodeScheduledTaskSource(store, unbound.id), { code: "schedule_source_invalid" });
  db.prepare("UPDATE code_schedule_runs SET payload = json_set(payload, '$.rootTaskId', ?) WHERE id = ?").run(unbound.id, run.id);
  assert.throws(() => getCodeScheduledTaskSource(store, run.rootTaskId), { code: "schedule_source_invalid" });
});

test("活动根任务反链缺失不能退回owner，关闭后新手工输入仍可用", t => {
  const f = fixture(t), { store, db } = f, run = f.admit(f.save().plan);
  db.prepare("DELETE FROM code_schedule_tasks WHERE task_id = ?").run(run.rootTaskId);
  assert.throws(() => getCodeScheduledTaskSource(store, run.rootTaskId), { code: "schedule_source_invalid" });
  store.withTx(() => { store.endTask(run.rootTaskId, ["queued"], "canceled"); closeCodeScheduleRun(store, { runId: run.id, status: "canceled", now: DUE }); });
  assert.throws(() => getCodeScheduledTaskSource(store, run.rootTaskId), { code: "schedule_source_invalid" });
  const manual = store.withTx(() => store.insertQueuedTask({ sessionId: run.sessionId, requestId: "new-manual", input: "新人工输入", accessMode: "confirm", modelSelection: f.config.modelSelection, submissionDigest: "new-manual" }).task);
  assert.equal(getCodeScheduledTaskSource(store, manual.id), null);
});

test("悬空运行反链报损坏而不退回普通owner来源", t => {
  const f = fixture(t), run = f.admit(f.save().plan);
  f.db.exec("PRAGMA foreign_keys = OFF");
  f.db.prepare("UPDATE code_schedule_tasks SET run_id = 'missing' WHERE task_id = ?").run(run.rootTaskId);
  assert.throws(() => getCodeScheduleRunForTask(f.store, run.rootTaskId), { code: "schedule_corrupt" });
  assert.throws(() => getCodeScheduledTaskSource(f.store, run.rootTaskId), { code: "schedule_corrupt" });
});

test("定时问题回答沿原Task保存来源，不创建回答任务且拒绝伪造owner来源", t => {
  const f = fixture(t), { store, db } = f, run = f.admit(f.save().plan);
  const questions = [{ question: "需要检查哪些目录？" }];
  const question = store.withTx(() => {
    store.transitionTask(run.rootTaskId, ["queued"], "running");
    store.recordToolIntent({ id: "scheduled-question", taskId: run.rootTaskId, sessionId: run.sessionId, toolName: "ask_user", params: { questions } });
    return createOwnerQuestion(store, { taskId: run.rootTaskId, sessionId: run.sessionId, projectId: f.config.workspaceId, hostOpId: "scheduled-question", questions });
  });
  assert.equal(question.source.kind, "coding-schedule");
  const input = { questionId: question.id, sessionId: run.sessionId, version: question.version, requestKey: "answer", requestDigest: "answer", answers: [{ text: "检查 src" }] };
  db.prepare("UPDATE owner_questions SET payload = ? WHERE id = ?").run(JSON.stringify({ ...question, source: { ...question.source, kind: "coding-owner" } }), question.id);
  assert.throws(() => store.withTx(() => consumeOwnerQuestion(store, input)), { code: "question_source_invalid" });
  db.prepare("UPDATE owner_questions SET payload = ? WHERE id = ?").run(JSON.stringify(question), question.id);
  const receipt = store.withTx(() => consumeOwnerQuestion(store, input));
  const answered = getOwnerQuestion(store, question.id)!;
  assert.equal(receipt.taskId, run.rootTaskId);
  assert.equal(answered.source.kind, "coding-schedule");
  assert.equal(answered.answerSource, undefined);
  assert.equal(answered.continuationTaskId, undefined);
  assert.ok(answered.answerSeq);
  assert.equal(listCodeScheduleRunTasks(store, run.id).length, 1);
  assert.equal(getCodeScheduleRunForTask(store, receipt.taskId!)!.id, run.id);
});

test("后台进程持久来源区分调度授权，伪造owner来源不能交接占用", t => {
  const f = fixture(t), { store, db } = f, run = f.admit(f.save().plan), command = "node server.mjs";
  const process = store.withTx(() => {
    store.transitionTask(run.rootTaskId, ["queued"], "running");
    store.tryAcquireOccupancy({ cwdReal: f.workspace.cwdReal, cwdDev: f.workspace.dev, cwdIno: f.workspace.ino, sessionId: run.sessionId, taskId: run.rootTaskId });
    store.recordToolIntent({ id: "scheduled-process", taskId: run.rootTaskId, sessionId: run.sessionId, toolName: "process_start", params: { command } });
    return registerBackgroundProcess(store, { taskId: run.rootTaskId, sessionId: run.sessionId, hostOpId: "scheduled-process", workspace: { path: f.workspace.cwdReal, dev: f.workspace.dev, ino: f.workspace.ino }, ref: { platform: "darwin", executionId: "scheduled" } });
  });
  assert.equal(process.source.kind, "coding-schedule");
  assert.equal(getBackgroundProcess(store, process.id)!.source.kind, "coding-schedule");
  db.prepare("UPDATE background_processes SET payload = json_set(payload, '$.source.kind', 'coding-owner') WHERE id = ?").run(process.id);
  assert.throws(() => store.withTx(() => handoffBackgroundProcess(store, { processId: process.id, workspace: process.workspace, snapshot: { taskId: run.rootTaskId, permissionVersion: 1, selectionRecordId: null, promptArtifactId: null, instructions: null, skills: null } })), { code: "background_source_invalid" });
  assert.equal(store.getOccupancyByDir(f.workspace.cwdReal)!.taskId, run.rootTaskId);
});

for (const once of [false, true]) test(`未知效果确认绑定运行版本并保留事实，${once ? "一次性只结束旧轮" : "周期只开放未来"}`, t => {
  const f = fixture(t), { store } = f, plan = f.save(once ? { rule: { kind: "once", at: DUE, timeZone: "UTC", disambiguation: "compatible" } } : {}).plan, run = f.admit(plan);
  store.withTx(() => {
    store.transitionTask(run.rootTaskId, ["queued"], "running");
    store.setEffectUnknown(run.rootTaskId);
    store.endTask(run.rootTaskId, ["running"], "interrupted");
    updateCodeScheduleRun(store, { runId: run.id, reason: "effect_unknown" });
    pauseCodeSchedule(store, { planId: plan.id, reason: "effect_unknown", now: DUE });
  });
  const current = getCodeSchedule(store, plan.id)!, active = getCodeScheduleRun(store, run.id)!;
  const input = { requestId: "ack", planId: plan.id, expectedVersion: current.version, control: "resume" as const, acknowledgeRunId: run.id, expectedRunVersion: active.version, nextDueAt: once ? null : NEXT, now: DUE };
  assert.throws(() => store.withTx(() => controlCodeSchedule(store, { ...input, expectedRunVersion: 999 })), { code: "schedule_source_invalid" });
  store.withTx(() => store.tryAcquireOccupancy({ cwdReal: f.workspace.cwdReal, cwdDev: f.workspace.dev, cwdIno: f.workspace.ino, sessionId: run.sessionId, taskId: run.rootTaskId }));
  assert.equal(codeScheduleRunStopped(store, run.id), false);
  assert.throws(() => store.withTx(() => controlCodeSchedule(store, input)), { code: "schedule_stop_unverified" });
  store.withTx(() => store.releaseOccupancy(run.rootTaskId));
  const ack = store.withTx(() => controlCodeSchedule(store, input));
  assert.equal(ack.operation, "acknowledge");
  assert.equal(ack.plan.status, once ? "completed" : "active");
  assert.equal(ack.plan.nextDueAt, once ? null : NEXT);
  assert.equal(ack.run!.status, "interrupted");
  assert.equal(store.getTask(run.rootTaskId)!.effectUnknown, true);
  assert.deepEqual(store.withTx(() => controlCodeSchedule(store, input)), ack);
});

test("运行关闭后历史反链保留，新手工任务不归入旧运行", t => {
  const f = fixture(t), { store } = f, run = f.admit(f.save().plan);
  store.withTx(() => { store.endTask(run.rootTaskId, ["queued"], "canceled"); closeCodeScheduleRun(store, { runId: run.id, status: "canceled", now: DUE }); });
  assert.throws(() => getCodeScheduledTaskSource(store, run.rootTaskId), { code: "schedule_source_invalid" });
  const manual = store.withTx(() => store.insertQueuedTask({ sessionId: run.sessionId, requestId: "manual", input: "新任务", accessMode: "confirm", modelSelection: f.config.modelSelection, submissionDigest: "manual" }).task);
  assert.equal(getCodeScheduleRunForTask(store, manual.id), null);
  assert.equal(ownerQuestionTaskEligible(store, manual), true);
  assert.equal(getCodeScheduleRunForTask(store, run.rootTaskId)!.closedAt, DUE);
});

test("新schema使用新档案，较旧和较新库在写入前拒绝且原字节不变", t => {
  const f = fixture(t);
  for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
    const data = path.join(f.root, `version-${version}`); fs.mkdirSync(data);
    const db = new Db(data); db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version)); db.close();
    const file = path.join(data, "ruukoto.db"), before = sha256File(file);
    assert.throws(() => new Db(data), { code: "schema_version_unsupported" });
    assert.equal(sha256File(file), before);
  }
});

test("导入拒绝Code计划并保留原档案，不创建目标", t => {
  const f = fixture(t); f.save(); f.close();
  const file = path.join(f.data, "ruukoto.db"), before = sha256File(file), target = path.join(f.root, "target");
  assert.throws(() => previewLegacyImport({ targetDataDir: target, targetAgentDir: path.join(f.root, "agent") }, { from: f.data }), { code: "code_schedules_import_unavailable" });
  assert.equal(fs.existsSync(target), false);
  assert.equal(sha256File(file), before);
});
