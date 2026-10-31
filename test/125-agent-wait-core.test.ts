import { fixtureSubAgentDefinition, fixtureSubAgentRoleCatalog } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { agentWaitView, agentReportKey, agentWaitCovers, bindAgentReportFallback, claimAgentReports, completeAgentReports, consumeAgentReport, endAgentWait,
  finishAgentReportFallback, getAgentReport, getAgentWait, invalidateAgentReports, isAgentReportFallback, isAgentReportParked, latestAgentReferenceSnapshot, listAgentReports,
  recoverAgentWaits, registerAgentReport, registerAgentWait, releaseAgentReports, setAgentWaitPhase, startAgentReportFallback, transferAgentReportFallbacks,
  type AgentReferenceSnapshot } from "@ruukoto/core/agent-wait.ts";
import { WORKFLOW_INTERFACE_VERSION, createWorkflowRun, registerWorkflowStep, updateWorkflowStep, saveWorkflowDefinition, workflowDigest, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import type { PersistentEvent, TaskStatus } from "@ruukoto/core/types.ts";
import { RuntimeAgentWait } from "@ruukoto/runtime/agent-wait.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wait-core-"));
  const db = new Db(root), store = new Store(db), stat = fs.statSync(root);
  const project = store.withTx(() => store.createProject("wait"));
  let n = 0;
  const session = () => store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: `pi${++n}`, confirmTools: [] });
  const parentSession = store.withTx(session);
  const task = (sessionId = parentSession.id, status: TaskStatus = "running", extra: { workId?: string; subAgentId?: string; parentTaskId?: string; requestId?: string } = {}) => store.withTx(() => {
    const task = store.insertQueuedTask({ sessionId, requestId: extra.requestId ?? `task${++n}`, input: "工作", submissionDigest: `digest${++n}`, modelSelection: { provider: "fake", modelId: "fake", thinkingLevel: "off" }, ...extra }).task;
    if (status !== "queued") store.transitionTask(task.id, ["queued"], status);
    return store.getTask(task.id)!;
  });
  const parent = task();
  const source: WorkflowSource = { product: "ruukoto-code", projectId: project.id, sessionId: parentSession.id, taskId: parent.id,
    permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null };
  const child = (status: TaskStatus = "completed", originTaskId = parent.id) => {
    const sub = store.withTx(session), agentId = `sub${++n}`, workId = `work${++n}`;
    store.withTx(() => {
      store.insertSubAgent({ definition: fixtureSubAgentDefinition(), id: agentId, parentSessionId: parentSession.id, sessionId: sub.id, workDir: root, activeWorkId: workId, currentTaskId: null,
        state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
      store.insertWorkDelegation({ id: workId, parentSessionId: parentSession.id, originTaskId, subAgentId: agentId, requestKey: `work${n}`, paramsDigest: "d",
        canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: sub.createdAt });
    });
    const child = task(sub.id, status, { workId, subAgentId: agentId, parentTaskId: originTaskId });
    if (["completed", "failed", "interrupted", "canceled"].includes(status)) store.withTx(() => store.setTaskResult(child.id, "结果", JSON.stringify({ taskId: child.id })));
    return store.getTask(child.id)!;
  };
  const snapshot: AgentReferenceSnapshot = { taskId: parent.id, permissionVersion: 1, selectionRecordId: null, promptArtifactId: null,
    instructions: { text: "已钉版项目指令", version: "v1", problems: [] }, skills: { skills: [{ name: "skill", description: "技能", disableModelInvocation: false, dir: root, body: "已钉版正文", version: "v1" }], diagnostics: [], version: "v1" } };
  const wait = (childId: string, id = `wait${++n}`) => store.withTx(() => registerAgentWait(store, { id, sdkCallId: id, deadline: null, taskId: parent.id, sessionId: parentSession.id,
    targets: [{ kind: "task", taskId: childId }], source, snapshot }));
  const report = (childId: string) => store.withTx(() => registerAgentReport(store, { target: { kind: "task", taskId: childId }, source, parentSessionId: parentSession.id }));
  return { root, db, store, source, snapshot, parent, parentSession, task, child, wait, report, cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("等待视图使用工作流固定名称，旧无名运行按宿主创建时刻回退", () => {
  const f = fixture();
  try {
    const wait = f.store.withTx(() => {
      const definition = saveWorkflowDefinition(f.store, "return 1;");
      const run = { interfaceVersion: WORKFLOW_INTERFACE_VERSION, requestKey: "display", paramsDigest: "display", definitionId: definition.id, scriptDigest: definition.digest,
        input: null, inputDigest: workflowDigest(null), source: f.source, modelSelection: f.parent.modelSelection!, status: "running" as const, version: 1,
        reason: null, attempts: 0, maxAttempts: 100, durationMs: 1000, usedMs: 0, clockStartedAt: null, clockVerified: true,
        scriptUnits: [], scriptStopVerified: null, result: null, resultRecorded: false, createdAt: f.parent.createdAt, endedAt: null };
      createWorkflowRun(f.store, { ...run, id: "named", displayName: "固定名称" });
      createWorkflowRun(f.store, { ...run, id: "legacy", requestKey: "legacy" });
      return registerAgentWait(f.store, { id: "display-wait", sdkCallId: "display-call", taskId: f.parent.id, sessionId: f.parentSession.id, source: f.source, snapshot: f.snapshot,
        deadline: null, targets: [{ kind: "workflow", runId: "named" }, { kind: "workflow", runId: "legacy" }] });
    });
    const labels = agentWaitView(f.store, wait).targets.map(target => target.label);
    assert.match(labels[0], /^工作流 · 固定名称 · 第 \d+ 项 · /);
    assert.ok(labels[1].startsWith("工作流 · 未命名工作流 · 第 ") && labels[1].endsWith(f.parent.createdAt));
  } finally { f.cleanup(); }
});

test("等待结果引用有界：任务与工作流各给100条产物并保留总数，原产物不删除", () => {
  const f = fixture();
  try {
    const child = f.child();
    const engine = new RuntimeAgentWait({ store: f.store, source: () => f.source, verify: () => true, snapshot: () => f.snapshot,
      yieldWorkspace: async () => true, kick: () => {}, subscribe: () => {}, unsubscribe: () => {} });
    f.store.withTx(() => {
      const definition = saveWorkflowDefinition(f.store, "return 1;");
      createWorkflowRun(f.store, { interfaceVersion: WORKFLOW_INTERFACE_VERSION, roleCatalog: fixtureSubAgentRoleCatalog(), id: "many", requestKey: "many", paramsDigest: "many", definitionId: definition.id, scriptDigest: definition.digest,
        input: null, inputDigest: workflowDigest(null), source: f.source, modelSelection: f.parent.modelSelection!, status: "running", version: 1,
        reason: null, attempts: 0, maxAttempts: 100, durationMs: 1000, usedMs: 0, clockStartedAt: null, clockVerified: true,
        scriptUnits: [], scriptStopVerified: null, result: null, resultRecorded: false, createdAt: f.parent.createdAt, endedAt: null });
      for (let i = 0; i < 101; i++) {
        f.store.createArtifact({ id: `art${i}`, taskId: child.id, sessionId: child.sessionId, name: `结果${i}` });
        const step = registerWorkflowStep(f.store, { runId: "many", key: `step${i}`, ordinal: i + 1, kind: "agent", params: {}, dependsOn: [] });
        updateWorkflowStep(f.store, { ...step, outputArtifact: { id: `art${i}`, hash: "hash", bytes: 1 } });
      }
    });
    for (const target of [{ kind: "task" as const, taskId: child.id }, { kind: "workflow" as const, runId: "many" }]) {
      const state = engine["state"](target);
      assert.equal(state.artifactIds!.length, 100);
      assert.equal(state.artifactCount, 101);
    }
    assert.equal(f.store.listArtifactsByTask(child.id).length, 101);
  } finally { f.cleanup(); }
});

test("提交后事件等待：订阅前已完成直接返回，重复超时不取消后台，事件抵达后再次认领", async () => {
  const f = fixture();
  const listeners = new Set<(events: PersistentEvent[]) => void>();
  try {
    f.store.onCommitted = events => { for (const listener of listeners) listener(events); };
    const engine = new RuntimeAgentWait({ store: f.store, source: () => f.source, verify: () => true, snapshot: () => f.snapshot,
      yieldWorkspace: async () => true, kick: () => {}, subscribe: listener => listeners.add(listener), unsubscribe: listener => listeners.delete(listener) });
    const child = f.child("running"), target = { kind: "task" as const, taskId: child.id };
    const ctx = { taskId: f.parent.id, sessionId: f.parentSession.id, projectId: f.source.projectId, hostOpId: "first" };
    assert.equal((await engine.wait(ctx, "first", [target], 1)).reason, "timeout");
    assert.equal((await engine.wait({ ...ctx, hostOpId: "again" }, "again", [target], 1)).reason, "timeout");
    assert.equal(f.store.getTask(child.id)!.status, "running");
    assert.equal(f.store.getTask(child.id)!.cancelRequested, false);
    f.store.withTx(() => { f.store.endTask(child.id, ["running"], "completed"); f.store.setTaskResult(child.id, "已完成", "{}"); });
    const result = await engine.wait({ ...ctx, hostOpId: "completed" }, "completed", [target], 1000);
    assert.equal(result.reason, "result");
    assert.equal(result.targets[0].reportOwnerTaskId, f.parent.id);
    assert.equal(getAgentReport(f.store, agentReportKey(target))!.claimTaskId, f.parent.id);
    assert.equal(listeners.size, 0);
  } finally { f.cleanup(); }
});

for (const completionFirst of [false, true]) test(`新输入与完成同边界：${completionFirst ? "完成先提交" : "中断先提交"}均撤销旧等待且后台不取消`, async () => {
  const f = fixture();
  const listeners = new Set<(events: PersistentEvent[]) => void>();
  try {
    f.store.onCommitted = events => { for (const listener of listeners) listener(events); };
    const child = f.child("running"), target = { kind: "task" as const, taskId: child.id };
    const complete = () => f.store.withTx(() => { f.store.endTask(child.id, ["running"], "completed"); f.store.setTaskResult(child.id, "完成", "{}"); });
    const engine = new RuntimeAgentWait({ store: f.store, source: () => f.source, verify: () => true, snapshot: () => f.snapshot,
      yieldWorkspace: async () => {
        if (completionFirst) complete();
        assert.equal(engine.interrupt(f.parent.id, "owner_input"), true);
        if (!completionFirst) complete();
        return true;
      }, kick: () => {}, subscribe: listener => listeners.add(listener), unsubscribe: listener => listeners.delete(listener) });
    const result = await engine.wait({ taskId: f.parent.id, sessionId: f.parentSession.id, projectId: f.source.projectId, hostOpId: "race" }, "race", [target], 1000);
    assert.equal(result.reason, "interrupted");
    assert.equal(f.store.getTask(child.id)!.status, "completed");
    assert.equal(f.store.getTask(child.id)!.cancelRequested, false);
    assert.equal(getAgentWait(f.store, "race")!.reason, "owner_input");
    assert.equal(getAgentReport(f.store, agentReportKey(target)), null);
    assert.equal(listeners.size, 0);
  } finally { f.cleanup(); }
});

test("等待目标与参考正文落盘，阶段与事件提交后一起可见，回滚不广播", () => {
  const f = fixture();
  try {
    const child = f.child("running"), observed: string[] = [];
    f.store.onCommitted = events => {
      for (const event of events) if (event.body.type === "agent_wait.changed") observed.push(getAgentWait(f.store, event.body.waitId)!.phase);
    };
    const wait = f.wait(child.id);
    f.store.withTx(() => setAgentWaitPhase(f.store, wait.id, "waiting"));
    f.store.withTx(() => setAgentWaitPhase(f.store, wait.id, "conversation"));
    assert.deepEqual(observed, ["releasing", "waiting", "conversation"]);
    const seq = f.store.getMaxSeq();
    assert.throws(() => f.store.withTx(() => { setAgentWaitPhase(f.store, wait.id, "reacquiring"); throw new Error("rollback"); }));
    assert.equal(f.store.getMaxSeq(), seq);
    assert.equal(observed.length, 3);
    assert.equal(getAgentWait(f.store, wait.id)!.phase, "conversation");
    assert.deepEqual(latestAgentReferenceSnapshot(f.store, f.parentSession.id), f.snapshot);
    f.store.withTx(() => endAgentWait(f.store, wait.id, "new_input"));
    assert.equal(agentWaitCovers(f.store, { kind: "task", taskId: child.id }, f.parentSession.id), true);
    assert.throws(() => f.store.withTx(() => setAgentWaitPhase(f.store, wait.id, "waiting")), { code: "wait_ended" });
    const reopened = new Db(f.root);
    try { assert.equal(getAgentWait(new Store(reopened), wait.id)!.snapshot.skills!.skills[0].body, "已钉版正文"); }
    finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test("等待拒绝跨来源、缺目标、自己、空批次与重复目标，同轮后续等待保持来源", () => {
  const f = fixture();
  try {
    const first = f.child("running"), other = f.task(), second = f.child("running", other.id);
    const wait = f.wait(first.id);
    f.store.withTx(() => endAgentWait(f.store, wait.id, "timeout"));
    const input = { id: "next", sdkCallId: "next", deadline: null, taskId: f.parent.id, sessionId: f.parentSession.id, source: f.source, snapshot: f.snapshot };
    assert.throws(() => f.store.withTx(() => registerAgentWait(f.store, { ...input, targets: [{ kind: "task", taskId: second.id }], source: { ...f.source, taskId: other.id } })), { code: "source_mismatch" });
    for (const targets of [[], [{ kind: "task" as const, taskId: first.id }, { kind: "task" as const, taskId: first.id }], [{ kind: "task" as const, taskId: f.parent.id }]]) {
      assert.throws(() => f.store.withTx(() => registerAgentWait(f.store, { ...input, targets })), { code: "targets_invalid" });
    }
    assert.throws(() => f.store.withTx(() => registerAgentWait(f.store, { ...input, targets: [{ kind: "task", taskId: "missing" }] })), { code: "target_invalid" });
    assert.throws(() => f.store.withTx(() => registerAgentWait(f.store, { ...input, targets: Array.from({ length: 21 }, (_, i) => ({ kind: "task" as const, taskId: String(i) })) })), { code: "targets_invalid" });
    assert.equal(f.wait(first.id, "retry").source.taskId, f.source.taskId);
    assert.throws(() => f.report(first.id), { code: "result_pending" });
  } finally { f.cleanup(); }
});

test("父轮认领给已排队报告停车，消费只登记一次，失败后原任务原键继续", () => {
  const f = fixture();
  try {
    const child = f.child(), report = f.report(child.id), fallback = f.task(f.parentSession.id, "queued", { requestId: `wake:${child.id}`, parentTaskId: child.id });
    f.store.withTx(() => bindAgentReportFallback(f.store, report.key, fallback.id));
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [report.key] }));
    assert.equal(isAgentReportParked(f.store, fallback.id), true);
    assert.equal(f.store.getTask(fallback.id)!.status, "queued");
    assert.throws(() => f.store.withTx(() => startAgentReportFallback(f.store, fallback.id)), { code: "report_owned" });
    assert.equal(f.store.withTx(() => consumeAgentReport(f.store, report.key, { taskId: f.parent.id, entryId: "accepted-tool-result" })), true);
    const seq = f.store.getMaxSeq();
    assert.equal(f.store.withTx(() => consumeAgentReport(f.store, report.key, { taskId: f.parent.id, entryId: "accepted-tool-result" })), true);
    assert.equal(f.store.getMaxSeq(), seq);
    assert.equal(f.store.withTx(() => consumeAgentReport(f.store, report.key, { taskId: f.parent.id, entryId: "other" })), false);
    f.store.withTx(() => releaseAgentReports(f.store, f.parent.id, "interrupted"));
    assert.equal(isAgentReportParked(f.store, fallback.id), false);
    assert.equal(f.store.getTask(fallback.id)!.requestId, `wake:${child.id}`);
    f.store.withTx(() => startAgentReportFallback(f.store, fallback.id));
    assert.equal(f.store.withTx(() => consumeAgentReport(f.store, report.key, { taskId: fallback.id, entryId: "fallback" })), false);
    f.store.withTx(() => finishAgentReportFallback(f.store, fallback.id, { status: "reported", entryId: "fallback-final" }));
    assert.equal(getAgentReport(f.store, report.key)!.proof!.entryId, "fallback-final");
    assert.equal(getAgentReport(f.store, report.key)!.consumption!.taskId, f.parent.id);
    assert.throws(() => f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [report.key] })), { code: "report_owned" });
  } finally { f.cleanup(); }
});

test("同父轮多个结果一份报告证明，未消费认领释放；已开始报告不能被转交", () => {
  const f = fixture();
  try {
    const reports = [f.report(f.child().id), f.report(f.child().id), f.report(f.child().id)];
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: reports.map(report => report.key) }));
    for (const report of reports.slice(0, 2)) f.store.withTx(() => consumeAgentReport(f.store, report.key, { taskId: f.parent.id, entryId: "batch-result" }));
    const completed = f.store.withTx(() => completeAgentReports(f.store, f.parent.id, { status: "reported", entryId: "parent-final", outboxOpId: "one-send" }));
    assert.equal(completed.length, 2);
    assert.deepEqual(completed.map(report => report.proof), [{ taskId: f.parent.id, entryId: "parent-final", outboxOpId: "one-send" }, { taskId: f.parent.id, entryId: "parent-final", outboxOpId: "one-send" }]);
    const remaining = getAgentReport(f.store, reports[2].key)!;
    assert.equal(remaining.claimTaskId, null);
    assert.equal(remaining.status, "pending");
    const fallback = f.task(f.parentSession.id, "queued");
    f.store.withTx(() => bindAgentReportFallback(f.store, remaining.key, fallback.id));
    f.store.withTx(() => startAgentReportFallback(f.store, fallback.id));
    f.store.withTx(() => f.store.transitionTask(fallback.id, ["queued"], "running"));
    assert.equal(f.store.withTx(() => bindAgentReportFallback(f.store, remaining.key, fallback.id)).fallbackState, "running");
    assert.throws(() => f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [remaining.key] })), { code: "report_owned" });
  } finally { f.cleanup(); }
});

test("重启结束等待且保留正文、消费和报告认领，宿主核实历史后才释放", () => {
  const f = fixture();
  try {
    const child = f.child(), wait = f.wait(child.id), report = f.report(child.id);
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [report.key] }));
    f.store.withTx(() => consumeAgentReport(f.store, report.key, { taskId: f.parent.id, entryId: "accepted" }));
    f.store.withTx(() => recoverAgentWaits(f.store));
    assert.equal(getAgentWait(f.store, wait.id)!.reason, "backend_restart");
    assert.equal(getAgentReport(f.store, report.key)!.claimTaskId, f.parent.id);
    assert.equal(getAgentReport(f.store, report.key)!.consumption!.entryId, "accepted");
    assert.equal(agentWaitCovers(f.store, { kind: "task", taskId: child.id }, f.parentSession.id), true);
    f.store.withTx(() => completeAgentReports(f.store, f.parent.id, { status: "reported", entryId: "recovered-final" }));
    const seq = f.store.getMaxSeq();
    f.store.withTx(() => recoverAgentWaits(f.store));
    assert.equal(f.store.getMaxSeq(), seq);
    assert.equal(listAgentReports(f.store)[0].proof!.entryId, "recovered-final");
  } finally { f.cleanup(); }
});

test("既有普通结果唤醒按真实来源采用，已运行或终态均拒绝第二报告认领", () => {
  const f = fixture();
  try {
    for (const status of ["running", "completed"] as const) {
      const child = f.child(), report = f.report(child.id);
      const fake = f.task(f.parentSession.id, status, { requestId: `wake:${child.id}`, parentTaskId: f.parent.id });
      assert.throws(() => f.store.withTx(() => bindAgentReportFallback(f.store, report.key, fake.id)), { code: "fallback_invalid" });
      const fallback = f.task(f.parentSession.id, status, { requestId: `wake:${child.id}:real`, parentTaskId: child.id });
      assert.throws(() => f.store.withTx(() => bindAgentReportFallback(f.store, report.key, fallback.id)), { code: "fallback_invalid" });
      f.store.withTx(() => f.store.db.prepare("UPDATE tasks SET request_id = ? WHERE id = ?").run(`wake:${child.id}:fake`, fake.id));
      f.store.withTx(() => f.store.db.prepare("UPDATE tasks SET request_id = ? WHERE id = ?").run(`wake:${child.id}`, fallback.id));
      const adopted = f.store.withTx(() => bindAgentReportFallback(f.store, report.key, fallback.id));
      assert.equal(adopted.fallbackState, status === "running" ? "running" : "completed");
      assert.throws(() => f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [report.key] })), { code: "report_owned" });
      assert.equal(getAgentReport(f.store, report.key)!.fallbackTaskId, fallback.id);
    }
  } finally { f.cleanup(); }
});

test("来源失效使未消费和已消费报告停止送达，保留原证明并停车而不重新生成", () => {
  const f = fixture();
  try {
    const reports = [f.report(f.child().id), f.report(f.child().id)];
    const fallback = f.task(f.parentSession.id, "queued");
    f.store.withTx(() => bindAgentReportFallback(f.store, reports[0].key, fallback.id));
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: reports.map(report => report.key) }));
    f.store.withTx(() => consumeAgentReport(f.store, reports[1].key, { taskId: f.parent.id, entryId: "accepted-before-revocation" }));
    const consumed = getAgentReport(f.store, reports[1].key)!.consumption;
    const invalid = f.store.withTx(() => invalidateAgentReports(f.store, reports.map(report => report.key), "source_revoked"));
    assert.equal(invalid.every(report => report.status === "undelivered" && report.claimTaskId === null), true);
    assert.equal(invalid[0].consumption, null);
    assert.deepEqual(invalid[1].consumption, consumed);
    assert.equal(invalid.every(report => report.proof === null), true);
    assert.equal(f.store.getTask(fallback.id)!.status, "queued");
    assert.equal(isAgentReportParked(f.store, fallback.id), true);
    assert.throws(() => f.store.withTx(() => startAgentReportFallback(f.store, fallback.id)), { code: "report_owned" });
    const seq = f.store.getMaxSeq();
    f.store.withTx(() => invalidateAgentReports(f.store, reports.map(report => report.key), "source_revoked"));
    assert.equal(f.store.getMaxSeq(), seq);
  } finally { f.cleanup(); }
});

test("结果依赖冻结同SubAgent截至本次任务的历史，后续复用不扩大已登记报告", () => {
  const f = fixture();
  try {
    const earlier = f.child();
    const current = f.task(earlier.sessionId, "completed", { workId: earlier.workId!, subAgentId: earlier.subAgentId!, parentTaskId: f.parent.id });
    f.store.withTx(() => f.store.setTaskResult(current.id, "继承旧资料的结果", "{}"));
    const report = f.report(current.id);
    assert.deepEqual(report.dependencyTaskIds, [earlier.id, current.id]);
    const later = f.task(earlier.sessionId, "completed", { workId: earlier.workId!, subAgentId: earlier.subAgentId!, parentTaskId: f.parent.id });
    f.store.withTx(() => f.store.setTaskResult(later.id, "新的工作", "{}"));
    assert.deepEqual(f.report(current.id).dependencyTaskIds, [earlier.id, current.id]);
    assert.equal(f.report(current.id).dependencyTaskIds.includes(later.id), false);
    const reopened = new Db(f.root);
    try { assert.deepEqual(getAgentReport(new Store(reopened), report.key)!.dependencyTaskIds, [earlier.id, current.id]); }
    finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test("多个排队后备合到一个原任务，旧键与输入保留，开始后整批拒绝转交", () => {
  const f = fixture();
  try {
    const reports = [f.report(f.child().id), f.report(f.child().id), f.report(f.child().id)];
    const canonical = f.task(f.parentSession.id, "queued", { requestId: "original-key-a" }), replaced = f.task(f.parentSession.id, "queued", { requestId: "original-key-b" });
    f.store.withTx(() => { bindAgentReportFallback(f.store, reports[0].key, canonical.id); bindAgentReportFallback(f.store, reports[1].key, replaced.id); });
    const grouped = f.store.withTx(() => transferAgentReportFallbacks(f.store, reports.map(report => report.key), canonical.id));
    assert.equal(grouped.every(report => report.fallbackTaskId === canonical.id), true);
    assert.equal(isAgentReportParked(f.store, replaced.id), true);
    assert.equal(isAgentReportFallback(f.store, replaced.id), true);
    assert.equal(listAgentReports(f.store, { taskId: replaced.id }).length, 1);
    assert.equal(f.store.getTask(replaced.id)!.requestId, "original-key-b");
    assert.equal(f.store.getTask(replaced.id)!.input, replaced.input);
    assert.equal(f.store.getTask(replaced.id)!.status, "queued");
    assert.equal(f.store.getTask(canonical.id)!.requestId, "original-key-a");
    assert.equal(f.store.getTask(canonical.id)!.input, canonical.input);
    const seqBeforePartial = f.store.getMaxSeq();
    assert.throws(() => f.store.withTx(() => transferAgentReportFallbacks(f.store, [reports[0].key], canonical.id)), { code: "report_group_partial" });
    assert.equal(f.store.getMaxSeq(), seqBeforePartial);
    f.store.withTx(() => startAgentReportFallback(f.store, canonical.id));
    const seq = f.store.getMaxSeq();
    assert.throws(() => f.store.withTx(() => transferAgentReportFallbacks(f.store, reports.map(report => report.key), canonical.id)), { code: "report_owned" });
    assert.equal(f.store.getMaxSeq(), seq);
    const extra = f.report(f.child().id);
    assert.throws(() => f.store.withTx(() => transferAgentReportFallbacks(f.store, [extra.key], replaced.id)), { code: "fallback_invalid" });
  } finally { f.cleanup(); }
});

test("共享后备来源失效：一个依赖失效整组停止送达，别名与原始消费不丢失", () => {
  const f = fixture();
  try {
    const reports = [f.report(f.child().id), f.report(f.child().id)];
    const canonical = f.task(f.parentSession.id, "queued"), alias = f.task(f.parentSession.id, "queued");
    f.store.withTx(() => { bindAgentReportFallback(f.store, reports[0].key, canonical.id); bindAgentReportFallback(f.store, reports[1].key, alias.id); });
    f.store.withTx(() => transferAgentReportFallbacks(f.store, reports.map(report => report.key), canonical.id));
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: reports.map(report => report.key) }));
    f.store.withTx(() => consumeAgentReport(f.store, reports[0].key, { taskId: f.parent.id, entryId: "accepted" }));
    assert.equal(f.store.withTx(() => invalidateAgentReports(f.store, [reports[0].key], "source_invalid")).length, 2);
    assert.ok(reports.every(report => getAgentReport(f.store, report.key)!.status === "undelivered"));
    assert.equal(getAgentReport(f.store, reports[0].key)!.consumption!.entryId, "accepted");
    assert.equal(isAgentReportParked(f.store, canonical.id), true);
    assert.equal(isAgentReportParked(f.store, alias.id), true);
    assert.throws(() => f.store.withTx(() => startAgentReportFallback(f.store, canonical.id)), { code: "report_owned" });
  } finally { f.cleanup(); }
});

test("共享排队后备只允许整组认领，部分消费不停车未消费结果且原键仍可启动", () => {
  const f = fixture();
  try {
    const reports = [f.report(f.child().id), f.report(f.child().id)];
    const canonical = f.task(f.parentSession.id, "queued", { requestId: "canonical-original-key" });
    f.store.withTx(() => bindAgentReportFallback(f.store, reports[0].key, canonical.id));
    f.store.withTx(() => transferAgentReportFallbacks(f.store, reports.map(report => report.key), canonical.id));
    const seq = f.store.getMaxSeq();
    assert.throws(() => f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [reports[0].key] })), { code: "report_group_partial" });
    assert.equal(f.store.getMaxSeq(), seq);
    assert.equal(getAgentReport(f.store, reports[0].key)!.claimTaskId, null);
    assert.equal(isAgentReportParked(f.store, canonical.id), false);
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: reports.map(report => report.key) }));
    f.store.withTx(() => consumeAgentReport(f.store, reports[0].key, { taskId: f.parent.id, entryId: "only-first-result-accepted" }));
    const completed = f.store.withTx(() => completeAgentReports(f.store, f.parent.id, { status: "reported", entryId: "partial-final" }));
    assert.deepEqual(completed, []);
    const released = reports.map(report => getAgentReport(f.store, report.key)!);
    assert.equal(released.every(report => report.status === "pending" && report.claimTaskId === null && report.fallbackTaskId === canonical.id && report.fallbackState === "queued" && report.proof === null), true);
    assert.equal(released[0].consumption!.entryId, "only-first-result-accepted");
    assert.equal(released[1].consumption, null);
    assert.equal(isAgentReportParked(f.store, canonical.id), false);
    assert.equal(f.store.getTask(canonical.id)!.requestId, "canonical-original-key");
    assert.equal(f.store.getTask(canonical.id)!.input, canonical.input);
    assert.equal(f.store.withTx(() => startAgentReportFallback(f.store, canonical.id)).length, 2);
  } finally { f.cleanup(); }
});

test("工作流结果按运行终态代次登记，不把父轮写进delivery.taskId", () => {
  const f = fixture();
  try {
    f.store.withTx(() => {
      const definition = saveWorkflowDefinition(f.store, "return 1;");
      createWorkflowRun(f.store, { interfaceVersion: WORKFLOW_INTERFACE_VERSION, roleCatalog: fixtureSubAgentRoleCatalog(), id: "run", requestKey: "run", paramsDigest: "run", definitionId: definition.id, scriptDigest: definition.digest,
        input: null, inputDigest: workflowDigest(null), source: f.source, modelSelection: f.parent.modelSelection!, status: "succeeded", version: 7,
        terminalVersion: 7, reason: null, attempts: 0, maxAttempts: 100, durationMs: 1000, usedMs: 0, clockStartedAt: null, clockVerified: true,
        scriptUnits: [], scriptStopVerified: null, result: 1, resultRecorded: true, createdAt: f.parent.createdAt, endedAt: f.parent.createdAt });
    });
    const target = { kind: "workflow" as const, runId: "run", terminalVersion: 7 };
    const report = f.store.withTx(() => registerAgentReport(f.store, { target, source: f.source, parentSessionId: f.parentSession.id }));
    assert.equal(report.key, agentReportKey(target));
    assert.equal(f.store.withTx(() => registerAgentReport(f.store, { target, source: f.source, parentSessionId: f.parentSession.id })).key, report.key);
    assert.throws(() => f.store.withTx(() => registerAgentReport(f.store, { target: { ...target, terminalVersion: 8 }, source: f.source, parentSessionId: f.parentSession.id })), { code: "result_pending" });
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [report.key] }));
    assert.equal(getAgentReport(f.store, report.key)!.claimTaskId, f.parent.id);
    assert.equal((f.store.db.prepare("SELECT json_extract(payload, '$.delivery.taskId') AS id FROM workflow_runs WHERE id = 'run'").get() as { id: null }).id, null);
    const other = f.task(), child = f.child("completed", other.id);
    const otherReport = f.store.withTx(() => registerAgentReport(f.store, { target: { kind: "task", taskId: child.id }, source: { ...f.source, taskId: other.id }, parentSessionId: f.parentSession.id }));
    f.store.withTx(() => claimAgentReports(f.store, { taskId: f.parent.id, keys: [report.key, otherReport.key] }));
    assert.equal(getAgentReport(f.store, otherReport.key)!.claimTaskId, f.parent.id);
    assert.equal(getAgentReport(f.store, otherReport.key)!.source.taskId, other.id);
    assert.equal(getAgentReport(f.store, report.key)!.source.taskId, f.parent.id);
  } finally { f.cleanup(); }
});

test("终态路由不拆旧组，wait 返回完整 reportTargets 并整组接管", () => {
  const f = fixture();
  try {
    const a = f.child(), b = f.child("running");
    f.store.withTx(() => {
      registerAgentWait(f.store, { id: "p-both", sdkCallId: "p-both", deadline: null, taskId: f.parent.id, sessionId: f.parentSession.id,
        targets: [{ kind: "task", taskId: a.id }, { kind: "task", taskId: b.id }], source: f.source, snapshot: f.snapshot });
      const r = registerAgentReport(f.store, { target: { kind: "task", taskId: a.id }, source: f.source, parentSessionId: f.parentSession.id });
      claimAgentReports(f.store, { taskId: f.parent.id, keys: [r.key] });
      consumeAgentReport(f.store, r.key, { taskId: f.parent.id, entryId: "p-first-entry" });
      endAgentWait(f.store, "p-both", "result"); releaseAgentReports(f.store, f.parent.id, "group_waiting");
      f.store.endTask(f.parent.id, ["running"], "completed");
    });
    const q = f.task();
    f.store.withTx(() => {
      registerAgentWait(f.store, { id: "q-second", sdkCallId: "q-second", deadline: null, taskId: q.id, sessionId: q.sessionId,
        targets: [{ kind: "task", taskId: b.id }], source: f.source, snapshot: { ...f.snapshot, taskId: q.id, permissionVersion: q.permissionVersion } });
      f.store.endTask(b.id, ["running"], "completed"); f.store.setTaskResult(b.id, "second 完整事实", "{}");
    });
    const engine = new RuntimeAgentWait({ store: f.store, source: () => f.source, verify: () => true, snapshot: () => f.snapshot,
      yieldWorkspace: async () => true, kick: () => {}, subscribe: () => {}, unsubscribe: () => {} });
    f.store.withTx(() => {
      const r = registerAgentReport(f.store, { target: { kind: "task", taskId: b.id }, source: f.source, parentSessionId: f.parentSession.id });
      assert.deepEqual(engine.reserve(r), [], "终态预留不拆旧组，也不提前转报告权");
    });
    const result = engine["result"](q, [{ kind: "task", taskId: b.id }], f.source)!;
    assert.deepEqual(result.targets.map(t => t.kind === "task" ? t.taskId : t.runId), [b.id]);
    assert.equal(result.reportTargets?.length, 2);
    assert.deepEqual(result.reportTargets!.map(t => t.kind === "task" ? t.taskId : t.runId).sort(), [a.id, b.id].sort());
    assert.equal(listAgentReports(f.store).filter(report => report.claimTaskId === q.id).length, 2);
    assert.ok(result.reportTargets?.every(t => t.resultSummary !== null && t.reportOwnerTaskId === q.id));
    assert.equal(getAgentReport(f.store, agentReportKey({ kind: "task", taskId: a.id }))!.consumption!.taskId, f.parent.id);
  } finally { f.cleanup(); }
});

test("超限旧组不得让终态预留抛错并回滚原结果", () => {
  const f = fixture();
  try {
    const children = Array.from({ length: 21 }, () => f.child());
    f.store.withTx(() => {
      for (let i = 0; i < 2; i++) {
        const id = `p-batch${i}`;
        registerAgentWait(f.store, { id, sdkCallId: id, deadline: null, taskId: f.parent.id, sessionId: f.parentSession.id,
          targets: children.slice(i * 20, (i + 1) * 20).map(child => ({ kind: "task" as const, taskId: child.id })), source: f.source, snapshot: f.snapshot });
        endAgentWait(f.store, id, "result");
      }
      f.store.endTask(f.parent.id, ["running"], "completed");
    });
    const q = f.task(), last = children.at(-1)!;
    f.store.withTx(() => registerAgentWait(f.store, { id: "q-last", sdkCallId: "q-last", deadline: null, taskId: q.id, sessionId: q.sessionId,
      targets: [{ kind: "task", taskId: last.id }], source: f.source, snapshot: { ...f.snapshot, taskId: q.id, permissionVersion: q.permissionVersion } }));
    const engine = new RuntimeAgentWait({ store: f.store, source: () => f.source, verify: () => true, snapshot: () => f.snapshot,
      yieldWorkspace: async () => true, kick: () => {}, subscribe: () => {}, unsubscribe: () => {} });
    assert.doesNotThrow(() => f.store.withTx(() => {
      const r = registerAgentReport(f.store, { target: { kind: "task", taskId: last.id }, source: f.source, parentSessionId: f.parentSession.id });
      assert.deepEqual(engine.reserve(r), []);
    }));
    assert.equal(f.store.getTask(last.id)!.resultSummary, "结果");
  } finally { f.cleanup(); }
});

test("一次等待接管多个旧组时 reportTargets 总量仍有界，拒绝不损原结果", () => {
  const f = fixture();
  try {
    const groups = Array.from({ length: 11 }, () => ({ parent: f.task(), children: [f.child(), f.child()] }));
    f.store.withTx(() => {
      for (const [index, group] of groups.entries()) {
        const id = `prior-${index}`;
        registerAgentWait(f.store, { id, sdkCallId: id, deadline: null, taskId: group.parent.id, sessionId: group.parent.sessionId,
          targets: group.children.map(child => ({ kind: "task" as const, taskId: child.id })), source: f.source,
          snapshot: { ...f.snapshot, taskId: group.parent.id, permissionVersion: group.parent.permissionVersion } });
        endAgentWait(f.store, id, "result"); f.store.endTask(group.parent.id, ["running"], "completed");
      }
    });
    const q = f.task(), targets = groups.map(group => ({ kind: "task" as const, taskId: group.children[0].id }));
    f.store.withTx(() => registerAgentWait(f.store, { id: "q-eleven", sdkCallId: "q-eleven", deadline: null, taskId: q.id, sessionId: q.sessionId,
      targets, source: f.source, snapshot: { ...f.snapshot, taskId: q.id, permissionVersion: q.permissionVersion } }));
    const engine = new RuntimeAgentWait({ store: f.store, source: () => f.source, verify: () => true, snapshot: () => f.snapshot,
      yieldWorkspace: async () => true, kick: () => {}, subscribe: () => {}, unsubscribe: () => {} });
    assert.throws(() => engine["result"](q, targets, f.source), { code: "report_group_limit" });
    assert.equal(listAgentReports(f.store).filter(report => report.claimTaskId === q.id).length, 0);
    assert.ok(groups.flatMap(group => group.children).every(child => f.store.getTask(child.id)!.resultSummary === "结果"));
  } finally { f.cleanup(); }
});
