import { fixtureSubAgentDefinition, fixtureSubAgentRoleCatalog } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { agentReportKey, bindAgentReportFallback, claimAgentReports, consumeAgentReport, endAgentWait, getAgentReport,
  isAgentReportParked, registerAgentReport, registerAgentWait, startAgentReportFallback, transferAgentReportFallbacks, type AgentReport } from "@ruukoto/core/agent-wait.ts";
import { createWorkflowRun, getWorkflowDeliveryRun, requireWorkflowRun, saveWorkflowDefinition, updateWorkflowRun, workflowDeliveryKey, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import { type Task, type TaskStatus } from "@ruukoto/core/types.ts";
import { getAgentTaskReport, ParentDelivery, type ParentDeliveryDeps } from "@ruukoto/runtime/parent-delivery.ts";
import { Orchestrator } from "@ruukoto/runtime/orchestrator.ts";
import { QqStore } from "@ruukoto/channels/qq/store.ts";

const SELECTION = { provider: "mock", modelId: "mock", thinkingLevel: "off" as const };

function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wait-report-")), db = new Db(root), store = new Store(db);
  const project = store.createProject("wait"), stat = fs.statSync(root);
  let counter = 0;
  const session = () => store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino,
    piSessionId: `pi-${++counter}`, confirmTools: [] });
  const parentSession = session(), main = session();
  store.insertAgentRole({ id: "main", projectId: project.id, sessionId: main.id, workDir: root, modelSelection: SELECTION,
    tools: [], createdAt: main.createdAt });
  const task = (sessionId: string, status: TaskStatus, params: { requestId?: string; parentTaskId?: string; workId?: string; subAgentId?: string } = {}) => {
    const registered = store.insertQueuedTask({ sessionId, requestId: params.requestId ?? `request-${++counter}`, input: "任务",
      modelSelection: SELECTION, submissionDigest: `digest-${counter}`, ...params }).task;
    if (status !== "queued") store.transitionTask(registered.id, ["queued"], status);
    return store.getTask(registered.id)!;
  };
  const parent = task(parentSession.id, "running");
  const source: WorkflowSource = { product: "ruukoto-code", projectId: project.id, sessionId: parentSession.id, taskId: parent.id,
    permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [], capabilities: [], references: [],
    replyTarget: null, scheduledRunId: null };
  const child = (status: TaskStatus = "completed") => {
    const subSession = session(), subAgentId = `agent-${++counter}`, workId = `work-${counter}`;
    store.insertSubAgent({ definition: fixtureSubAgentDefinition(), id: subAgentId, parentSessionId: parentSession.id, sessionId: subSession.id, workDir: root,
      activeWorkId: workId, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: subSession.createdAt });
    store.insertWorkDelegation({ id: workId, parentSessionId: parentSession.id, originTaskId: parent.id, subAgentId, requestKey: `work-key-${counter}`,
      paramsDigest: "work", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: subSession.createdAt });
    const execution = task(subSession.id, status, { parentTaskId: parent.id, workId, subAgentId });
    if (status === "completed") store.setTaskResult(execution.id, "子结果", "{}");
    return store.getTask(execution.id)!;
  };
  const wait = (target: Task) => store.withTx(() => registerAgentWait(store, { id: `wait-${++counter}`, taskId: parent.id,
    sdkCallId: `call-${counter}`, deadline: null,
    sessionId: parentSession.id, targets: [{ kind: "task", taskId: target.id }], source,
    snapshot: { taskId: parent.id, permissionVersion: parent.permissionVersion, selectionRecordId: null, promptArtifactId: null,
      instructions: null, skills: null } }));
  const report = (target: Task) => store.withTx(() => registerAgentReport(store, { target: { kind: "task", taskId: target.id }, source,
    parentSessionId: parentSession.id }));
  const submissions: Parameters<ParentDeliveryDeps["submit"]>[0][] = [], replies = new Map<string, string>(), reports: AgentReport[][] = [];
  const deps: ParentDeliveryDeps = { store, defaultModelSelection: () => SELECTION, readReply: id => replies.get(id) ?? null,
    isReviewEvent: () => false, resultNotice: () => null, sendWorkReport: () => { throw new Error("dev 不外发"); },
    submit: async input => {
      submissions.push(input);
      return store.withTx(() => {
        const queued = store.insertQueuedTask({ ...input, submissionDigest: input.requestId }).task;
        if (input.reportKey && !getAgentReport(store, input.reportKey)?.fallbackTaskId) bindAgentReportFallback(store, input.reportKey, queued.id);
        return queued;
      });
    },
    recordClaimedReport: (_task, _outcome, claims) => {
      reports.push(claims);
      return { status: "reported", entryId: "final-entry", outboxOpId: "single-outbox" };
    },
  };
  const delivery = new ParentDelivery(deps);
  const cleanup = () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, db, store, parent, parentSession, child, wait, report, task, source, deps, delivery, submissions, replies, reports, cleanup };
}

test("普通工作取消：可信分组后备准入拒绝，未开始汇总的取消终态仍能登记未送达", () => {
  const k = kit();
  try {
    const child = k.child(), report = k.report(child);
    const fallback = k.task(k.parentSession.id, "queued", { requestId: `agent-final:${k.parent.id}`, parentTaskId: k.parent.id });
    k.store.withTx(() => bindAgentReportFallback(k.store, report.key, fallback.id));
    assert.equal(k.delivery.wakeAdmitted(fallback), true);
    k.store.withTx(() => k.store.cancelWorkDelegation(child.workId!, new Date().toISOString(), "owner", "取消"));
    assert.equal(k.delivery.wakeAdmitted(fallback), false);
    k.deps.verifyAgentReport = () => false;
    k.store.withTx(() => {
      k.store.endTask(fallback.id, ["queued"], "canceled");
      k.delivery.wakeTerminal(k.store.getTask(fallback.id)!, "unknown");
    });
    assert.equal(getAgentReport(k.store, report.key)!.status, "undelivered");
    assert.equal(getAgentReport(k.store, report.key)!.fallbackTaskId, fallback.id);
    assert.equal(getAgentReport(k.store, report.key)!.fallbackState, "completed");
    assert.equal(k.submissions.length, 0);
  } finally { k.cleanup(); }
});

test("排队补报转交父轮只停车；父轮失败沿同一任务和原键恢复，运行中补报不能二次认领", async () => {
  const k = kit();
  try {
    const child = k.child(), report = k.report(child);
    await k.delivery.resultRecorded(child, "completed", child.resultSummary!);
    const fallback = k.store.findTaskByRequest(k.parentSession.id, `wake:${child.id}`)!;
    assert.equal(getAgentTaskReport(k.store, fallback.id)!.key, report.key);
    k.store.withTx(() => claimAgentReports(k.store, { taskId: k.parent.id, keys: [report.key] }));
    assert.equal(isAgentReportParked(k.store, fallback.id), true);
    assert.equal(k.store.getTask(fallback.id)!.status, "queued");
    await k.delivery.resultRecorded(child, "completed", child.resultSummary!);
    assert.equal(k.submissions.length, 1);
    k.store.withTx(() => {
      k.store.endTask(k.parent.id, ["running"], "interrupted");
      k.delivery.wakeTerminal(k.store.getTask(k.parent.id)!, "unknown");
    });
    assert.equal(isAgentReportParked(k.store, fallback.id), false);
    await k.delivery.sweep();
    assert.equal(k.store.findTaskByRequest(k.parentSession.id, `wake:${child.id}`)!.id, fallback.id);
    k.store.withTx(() => {
      startAgentReportFallback(k.store, fallback.id);
      k.store.transitionTask(fallback.id, ["queued"], "running");
    });
    const other = k.task(k.parentSession.id, "running");
    assert.throws(() => k.store.withTx(() => claimAgentReports(k.store, { taskId: other.id, keys: [report.key] })), { code: "report_owned" });
  } finally { k.cleanup(); }
});

test("同来源多个结果父轮只报告一次，消费后的普通注入和独立补报都不再重复", async () => {
  const k = kit();
  try {
    const children = [k.child(), k.child()], reports = children.map(child => k.report(child));
    k.store.withTx(() => {
      claimAgentReports(k.store, { taskId: k.parent.id, keys: reports.map(report => report.key) });
      for (const report of reports) consumeAgentReport(k.store, report.key, { taskId: k.parent.id, entryId: "wait-tool-result" });
    });
    for (const child of children) await k.delivery.resultRecorded(child, "completed", child.resultSummary!);
    assert.equal(k.submissions.length, 0);
    assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results, []);
    k.replies.set(k.parent.id, "两个结果的唯一总结");
    k.store.withTx(() => {
      k.store.endTask(k.parent.id, ["running"], "completed");
      k.delivery.wakeTerminal(k.store.getTask(k.parent.id)!, "completed");
      k.delivery.wakeTerminal(k.store.getTask(k.parent.id)!, "completed");
    });
    assert.equal(k.reports.length, 1);
    assert.equal(k.reports[0].length, 2);
    for (const report of reports) assert.deepEqual(getAgentReport(k.store, report.key)!.proof,
      { taskId: k.parent.id, entryId: "final-entry", outboxOpId: "single-outbox" });
    await k.delivery.sweep();
    assert.equal(k.submissions.length, 0);
  } finally { k.cleanup(); }
});

test("dev 普通子结果装配不算消费；模型接受钩子后才从下轮候选移除", () => {
  const k = kit();
  try {
    const child = k.child();
    assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results.map(task => task.id), [child.id]);
    assert.equal(k.store.getTask(child.id)!.resultDeliveredAt, null);
    assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results.map(task => task.id), [child.id]);
    k.delivery.acceptInjection(k.parent.id, [child.id], "accepted-input");
    assert.ok(k.store.getTask(child.id)!.resultDeliveredAt);
    assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results, []);
  } finally { k.cleanup(); }
});

test("同来源补报批次共享一个可信任务及最终报告；伪造同名任务不取得补报身份", () => {
  const k = kit();
  try {
    const reports = [k.report(k.child()), k.report(k.child())];
    const fake = k.task(k.parentSession.id, "queued", { requestId: "agent-final:fake" });
    assert.equal(getAgentTaskReport(k.store, fake.id), null);
    const fallback = k.task(k.parentSession.id, "queued", { requestId: `agent-final:${k.parent.id}` });
    k.store.withTx(() => {
      for (const report of reports) bindAgentReportFallback(k.store, report.key, fallback.id);
      startAgentReportFallback(k.store, fallback.id);
      k.store.transitionTask(fallback.id, ["queued"], "running");
      k.store.endTask(fallback.id, ["running"], "completed");
    });
    k.replies.set(fallback.id, "整批唯一总结");
    k.store.withTx(() => k.delivery.wakeTerminal(k.store.getTask(fallback.id)!, "completed"));
    assert.equal(k.reports.length, 1);
    assert.equal(k.reports[0].length, 2);
    for (const report of reports) assert.deepEqual(getAgentReport(k.store, report.key)!.proof,
      { taskId: fallback.id, entryId: "final-entry", outboxOpId: "single-outbox" });
  } finally { k.cleanup(); }
});

test("已有工作流专属汇总接管子任务和其他排队汇总，只登记一份报告且保留各原任务与输入", () => {
  const k = kit();
  try {
    const definition = saveWorkflowDefinition(k.store, "return null;"), childReport = k.report(k.child());
    const runs = ["first", "second"].map(id => k.store.withTx(() => createWorkflowRun(k.store, { roleCatalog: fixtureSubAgentRoleCatalog(), id, requestKey: id, paramsDigest: id,
      definitionId: definition.id, scriptDigest: definition.digest, input: null, inputDigest: id, source: k.source, modelSelection: SELECTION,
      status: "succeeded", version: 2, terminalVersion: 2, reason: null, attempts: 0, maxAttempts: 1, durationMs: 60_000,
      usedMs: 1, clockStartedAt: null, clockVerified: true, scriptUnits: [], scriptStopVerified: true, result: id, resultRecorded: true,
      createdAt: new Date().toISOString(), endedAt: new Date().toISOString() })));
    const reports = [childReport, ...runs.map(run => k.store.withTx(() => registerAgentReport(k.store, {
      target: { kind: "workflow", runId: run.id, terminalVersion: run.terminalVersion! }, source: k.source, parentSessionId: k.parentSession.id })))];
    const summaries = runs.map(run => k.task(k.parentSession.id, "queued", { requestId: workflowDeliveryKey(run), parentTaskId: k.parent.id }));
    const fallback = summaries[0], original = { id: fallback.id, requestId: fallback.requestId, input: fallback.input };
    k.store.withTx(() => {
      for (const [index, run] of runs.entries()) {
        updateWorkflowRun(k.store, { ...requireWorkflowRun(k.store, run.id), delivery: { version: run.terminalVersion!, taskId: summaries[index].id,
          facts: run.id, text: run.id, status: "queued", reason: null } });
        bindAgentReportFallback(k.store, reports[index + 1].key, summaries[index].id);
      }
      transferAgentReportFallbacks(k.store, reports.map(report => report.key), fallback.id);
      assert.equal(isAgentReportParked(k.store, summaries[1].id), true);
      assert.equal(getAgentTaskReport(k.store, summaries[1].id)!.target.kind, "workflow");
      assert.equal(getWorkflowDeliveryRun(k.store, fallback.id)!.id, runs[0].id);
      startAgentReportFallback(k.store, fallback.id);
      k.store.transitionTask(fallback.id, ["queued"], "running");
      k.store.endTask(fallback.id, ["running"], "completed");
    });
    k.replies.set(fallback.id, "共同总结");
    k.store.withTx(() => k.delivery.wakeTerminal(k.store.getTask(fallback.id)!, "completed"));
    assert.equal(k.reports.length, 1);
    assert.equal(k.reports[0].length, 3);
    for (const [index, run] of runs.entries()) {
      const delivery = requireWorkflowRun(k.store, run.id).delivery!;
      assert.equal(delivery.status, "reported");
      assert.equal(delivery.taskId, summaries[index].id);
      assert.equal(delivery.version, 2);
    }
    const retained = k.store.getTask(original.id)!;
    assert.deepEqual({ id: retained.id, requestId: retained.requestId, input: retained.input }, original);
    assert.equal(k.store.getTask(summaries[1].id)!.status, "queued");
    for (const report of reports) assert.equal(getAgentReport(k.store, report.key)!.proof!.outboxOpId, "single-outbox");
    k.store.withTx(() => k.delivery.wakeTerminal(k.store.getTask(summaries[1].id)!, "failed"));
    assert.equal(k.reports.length, 1);
  } finally { k.cleanup(); }
});

test("父轮消费后终态前撤销来源，拒绝登记最终外发并持久记录未送达", () => {
  const k = kit();
  try {
    const report = k.report(k.child());
    k.store.withTx(() => {
      claimAgentReports(k.store, { taskId: k.parent.id, keys: [report.key] });
      consumeAgentReport(k.store, report.key, { taskId: k.parent.id, entryId: "accepted-result" });
      k.store.endTask(k.parent.id, ["running"], "completed");
    });
    k.replies.set(k.parent.id, "已生成但来源被撤销的总结");
    const delivery = new ParentDelivery({ ...k.deps, verifyAgentReport: () => false });
    k.store.withTx(() => delivery.wakeTerminal(k.store.getTask(k.parent.id)!, "completed"));
    assert.equal(k.reports.length, 0);
    assert.equal(getAgentReport(k.store, report.key)!.status, "undelivered");
    assert.equal(getAgentReport(k.store, report.key)!.reason, "source_invalid");
  } finally { k.cleanup(); }
});

test("等待被新轮中断且新轮先结束，晚到普通子结果按持久资格自动补报；未等待委派仍只注入", async () => {
  const k = kit();
  try {
    const child = k.child("running"), wait = k.wait(child);
    k.store.withTx(() => {
      endAgentWait(k.store, wait.id, "owner_input");
      k.store.endTask(k.parent.id, ["running"], "interrupted");
    });
    k.task(k.parentSession.id, "completed");
    k.store.withTx(() => {
      k.store.endTask(child.id, ["running"], "completed");
      k.store.setTaskResult(child.id, "迟到真实结果", "{}");
    });
    await k.delivery.resultRecorded(k.store.getTask(child.id)!, "completed", "迟到真实结果");
    const fallback = k.store.findTaskByRequest(k.parentSession.id, `wake:${child.id}`)!;
    assert.ok(fallback);
    assert.equal(getAgentTaskReport(k.store, fallback.id)!.source.taskId, k.parent.id);
    await new ParentDelivery(k.deps).sweep();
    assert.equal(k.store.findTaskByRequest(k.parentSession.id, `wake:${child.id}`)!.id, fallback.id);
    assert.equal(k.store.listTasksBySession(k.parentSession.id).filter(task => task.requestId === fallback.requestId).length, 1);
    const ordinary = k.child();
    await k.delivery.resultRecorded(ordinary, "completed", ordinary.resultSummary!);
    assert.equal(k.store.findTaskByRequest(k.parentSession.id, `wake:${ordinary.id}`), null);
    assert.ok(k.delivery.takeInjection(k.parentSession.id).results.some(task => task.id === ordinary.id));
  } finally { k.cleanup(); }
});

test("编排器启动巡检以等待认领覆盖普通 dev 父轮，补记终态结果和报告而不重生总结", async () => {
  const k = kit();
  let orchestrator: Orchestrator | null = null;
  try {
    const child = k.child(), report = k.report(child);
    k.store.withTx(() => {
      claimAgentReports(k.store, { taskId: k.parent.id, keys: [report.key] });
      consumeAgentReport(k.store, report.key, { taskId: k.parent.id, entryId: "result-entry" });
      k.store.endTask(k.parent.id, ["running"], "completed");
    });
    k.replies.set(k.parent.id, "已落盘最终总结");
    orchestrator = new Orchestrator({ store: k.store, qqStore: new QqStore(k.db), dataDir: k.root, parentDelivery: k.delivery,
      bridge: { submit: k.deps.submit, defaultModelSelection: () => SELECTION, findProjectByName: name => k.store.findProjectByName(name),
        createProject: name => k.store.createProject(name), createSession: async () => { throw new Error("main 已存在"); },
        readTaskReply: id => {
          const text = k.replies.get(id);
          return text ? { entryId: "final-entry", taskId: id, inputPurpose: "user", parentId: null, role: "assistant", timestamp: new Date().toISOString(),
            text, offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: null, toolName: null,
            isError: null, hasNonTextContent: false } : null;
        }, cancelTask: async id => k.store.getTask(id)!, resumeQueue: async () => {}, kickSession: () => {} } });
    await orchestrator.start();
    assert.equal(k.store.getTask(k.parent.id)!.resultSummary, "已落盘最终总结");
    assert.equal(getAgentReport(k.store, agentReportKey({ kind: "task", taskId: child.id }))!.status, "reported");
    assert.equal(k.reports.length, 1);
    assert.equal(k.submissions.length, 0);
  } finally { await orchestrator?.stop(); k.cleanup(); }
});
