import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { agentReportKey, bindAgentReportFallback, getAgentReport, registerAgentReport, startAgentReportFallback } from "@ruukoto/core/agent-wait.ts";
import type { TaskStatus } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { snapshotWorkspace, WorkspaceSnapshotError } from "@ruukoto/core/workspace-snapshot.ts";
import { QqStore } from "@ruukoto/channels/qq/store.ts";
import { Orchestrator, type OrchestratorDeps } from "@ruukoto/runtime/orchestrator.ts";
import { ParentDelivery, type ParentDeliveryDeps } from "@ruukoto/runtime/parent-delivery.ts";
import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";

const SELECTION = { provider: "mock", modelId: "mock", thinkingLevel: "off" as const };

function kit() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-terminal-"))), db = new Db(root), store = new Store(db);
  const project = store.createProject("snapshot");
  let counter = 0;
  const directory = () => {
    const real = path.join(root, `directory-${++counter}`);
    fs.mkdirSync(real);
    const stat = fs.statSync(real);
    return { path: real, dev: stat.dev, ino: stat.ino };
  };
  const session = () => {
    const identity = directory();
    return store.createSession({ projectId: project.id, cwd: identity.path, cwdReal: identity.path, cwdDev: identity.dev,
      cwdIno: identity.ino, piSessionId: `pi-${counter}`, confirmTools: [] });
  };
  const main = session(), dev = session();
  store.insertAgentRole({ id: "main", projectId: project.id, sessionId: main.id, workDir: main.cwdReal, modelSelection: SELECTION,
    tools: [], createdAt: main.createdAt });
  const task = (sessionId: string, status: TaskStatus, params: { parentTaskId?: string; workId?: string; subAgentId?: string; requestId?: string } = {}) => {
    const value = store.insertQueuedTask({ sessionId, requestId: `request-${++counter}`, input: "任务", modelSelection: SELECTION,
      submissionDigest: `digest-${counter}`, ...params }).task;
    if (status !== "queued") store.transitionTask(value.id, ["queued"], status, { endedAt: new Date().toISOString() });
    return store.getTask(value.id)!;
  };
  const child = (parentSessionId = main.id, status: TaskStatus = "completed", withResult = false) => {
    const parent = task(parentSessionId, "completed"), sub = session(), commonGit = directory(), repository = directory();
    store.setTaskResult(parent.id, "父任务已完成", "{}");
    const subAgentId = `agent-${++counter}`, workId = `work-${counter}`, parentSession = store.getSession(parentSessionId)!;
    const source = { path: parentSession.cwdReal, dev: parentSession.cwdDev, ino: parentSession.cwdIno };
    const head = "0".repeat(40), snapshot = snapshotWorkspace({ version: 1, source, commonGit, repository, head, tree: "1".repeat(40), indexDigest: "2".repeat(64) });
    const target = { kind: "worktree" as const, path: sub.cwdReal, dev: sub.cwdDev, ino: sub.cwdIno, repoRoot: source.path,
      commonGitDir: commonGit.path, gitdir: path.join(commonGit.path, "worktrees", workId), branch: `ruukoto/${workId}`, baseCommit: head, snapshot };
    store.insertSubAgent({ definition: fixtureSubAgentDefinition(), id: subAgentId, parentSessionId, sessionId: sub.id, workDir: sub.cwdReal,
      activeWorkId: workId, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
    store.insertWorkDelegation({ id: workId, parentSessionId, originTaskId: parent.id, subAgentId, requestKey: `key-${counter}`, paramsDigest: "work",
      canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: target, createdAt: sub.createdAt });
    const execution = task(sub.id, status, { workId, subAgentId, parentTaskId: parent.id });
    if (withResult) store.setTaskResult(execution.id, "真实执行结果", JSON.stringify({ outcome: "completed", workId }));
    fs.writeFileSync(path.join(target.path, "preserved.txt"), "保留成果\n");
    const reportSource: WorkflowSource = { product: "ruukoto-code", projectId: project.id, sessionId: parentSessionId, taskId: parent.id,
      permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null };
    const report = () => store.withTx(() => registerAgentReport(store, { target: { kind: "task", taskId: execution.id }, source: reportSource, parentSessionId }));
    const corrupt = (code: "snapshot_missing" | "snapshot_corrupt" | "target_corrupt") => {
      const { snapshot: _snapshot, ...withoutSnapshot } = target;
      const bytes = code === "target_corrupt" ? "{" : JSON.stringify(code === "snapshot_missing" ? withoutSnapshot : { ...target, snapshot: { ...snapshot, digest: "tampered" } });
      store.db.prepare("UPDATE work_delegations SET write_target = ? WHERE id = ?").run(bytes, workId);
      assert.throws(() => store.getWorkDelegation(workId), { code });
      return bytes;
    };
    return { task: store.getTask(execution.id)!, parent, subAgentId, workId, target, report, corrupt };
  };
  const submissions: Parameters<ParentDeliveryDeps["submit"]>[0][] = [];
  const deliveryDeps: ParentDeliveryDeps = { verifyWork: () => {}, verifyTask: () => null, store, defaultModelSelection: () => SELECTION, readReply: () => "汇报正文", isReviewEvent: () => false,
    resultNotice: () => null, sendWorkReport: () => { throw new Error("未取得外发资格"); },
    submit: async input => { submissions.push(input); return store.insertQueuedTask({ ...input, submissionDigest: input.requestId }).task; } };
  const delivery = new ParentDelivery(deliveryDeps);
  const finalized: string[] = [];
  const deps: OrchestratorDeps = { store, qqStore: new QqStore(db), dataDir: root, parentDelivery: delivery,
    resultData: value => { finalized.push(value.id); return {}; },
    bridge: { submit: deliveryDeps.submit, cancelTask: async id => store.getTask(id)!, findProjectByName: name => store.findProjectByName(name),
      createProject: name => store.createProject(name), createSession: async () => session(), readTaskReply: () => null,
      resumeQueue: async () => undefined, kickSession: () => {}, defaultModelSelection: () => SELECTION } };
  const rawWork = (workId: string) => (store.db.prepare("SELECT write_target FROM work_delegations WHERE id = ?").get(workId) as { write_target: string }).write_target;
  return { root, db, store, main, dev, task, child, deps, deliveryDeps, delivery, finalized, submissions, rawWork,
    cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const [code, status] of [["snapshot_missing", "interrupted"], ["snapshot_corrupt", "completed"], ["target_corrupt", "failed"]] as const) {
  test(`冷启动补记 ${code} 的结果失败，保留 ${status} 执行史与副本，其他结果继续送达`, async () => {
    const k = kit();
    let orchestrator: Orchestrator | null = null;
    try {
      const broken = k.child(k.main.id, status), healthy = k.child(), bytes = broken.corrupt(code);
      orchestrator = new Orchestrator(k.deps);
      await orchestrator.start();
      const result = k.store.getTask(broken.task.id)!;
      assert.equal(result.status, status);
      assert.match(result.resultSummary!, new RegExp(code));
      assert.match(result.resultSummary!, /请向拥有者报告并停止该项工作/);
      assert.deepEqual(JSON.parse(result.resultRef!).failure, code);
      assert.equal(JSON.parse(result.resultRef!).outcome, "failed");
      assert.equal(k.rawWork(broken.workId), bytes);
      assert.equal(fs.readFileSync(path.join(broken.target.path, "preserved.txt"), "utf8"), "保留成果\n");
      assert.ok(!k.finalized.includes(broken.task.id), "坏基线不制作交付产物");
      assert.ok(k.finalized.includes(healthy.task.id));
      assert.equal(k.store.findTaskByRequest(k.main.id, `wake:${broken.task.id}`), null);
      assert.ok(k.store.findTaskByRequest(k.main.id, `wake:${healthy.task.id}`));
      const failures = () => k.store.getEventsAfter(0).filter(event => event.body.type === "subagent_task.failed" && event.body.taskId === broken.task.id);
      assert.equal(failures().length, 1);
      const failure = failures()[0].body;
      assert.equal(failure.type === "subagent_task.failed" && failure.errorMessage, code);
      await orchestrator.stop();
      orchestrator = new Orchestrator(k.deps);
      await orchestrator.start();
      assert.equal(failures().length, 1);
      assert.equal(k.submissions.filter(input => input.requestId === `wake:${healthy.task.id}`).length, 1);
      assert.equal(k.store.getTask(broken.task.id)!.resultDeliveredAt, null);
    } finally { await orchestrator?.stop(); k.cleanup(); }
  });
}

test("已登记结果的坏基线只使既有补报不可送达，扫尾与普通注入继续处理其他工作", async () => {
  const k = kit();
  try {
    const broken = k.child(k.dev.id, "completed", true), report = broken.report(), healthy = k.child(k.dev.id, "completed", true);
    const fallback = k.task(k.dev.id, "queued", { requestId: `wake:${broken.task.id}`, parentTaskId: broken.task.id });
    k.store.withTx(() => bindAgentReportFallback(k.store, report.key, fallback.id));
    const reference = broken.task.resultRef, bytes = broken.corrupt("snapshot_corrupt");
    const rejected = k.store.withTx(() => k.delivery.reserveResult(broken.task));
    assert.equal(rejected?.status, "undelivered");
    assert.equal(rejected?.reason, "snapshot_corrupt");
    assert.equal(rejected?.fallbackState, "parked");
    await k.delivery.resultRecorded(broken.task, "completed", broken.task.resultSummary!);
    await k.delivery.sweep();
    assert.deepEqual(k.delivery.takeInjection(k.dev.id).results.map(value => value.id), [healthy.task.id]);
    assert.equal(k.delivery.wakeAdmitted(fallback), false);
    k.store.withTx(() => k.delivery.wakeTerminal(k.store.getTask(fallback.id)!, "unknown"));
    assert.equal(k.submissions.length, 0);
    assert.equal(k.rawWork(broken.workId), bytes);
    assert.equal(k.store.getTask(broken.task.id)!.resultRef, reference, "已登记的执行结果不覆写");
    assert.equal(k.store.getTask(broken.task.id)!.resultDeliveredAt, null);
    assert.equal(k.store.getTask(fallback.id)!.status, "queued");
    assert.equal(getAgentReport(k.store, report.key)!.reason, "snapshot_corrupt");
  } finally { k.cleanup(); }
});

test("最终汇报的来源回调读到坏基线时明确不可送达，不外发、不覆写真实子结果", () => {
  const k = kit();
  try {
    const child = k.child(k.dev.id, "completed", true), report = child.report();
    const fallback = k.task(k.dev.id, "queued", { parentTaskId: child.task.id });
    k.store.withTx(() => {
      bindAgentReportFallback(k.store, report.key, fallback.id);
      startAgentReportFallback(k.store, fallback.id);
      k.store.transitionTask(fallback.id, ["queued"], "completed");
    });
    k.deliveryDeps.verifyAgentReport = () => Boolean(k.store.getWorkDelegation(child.workId));
    child.corrupt("snapshot_missing");
    k.store.withTx(() => k.delivery.wakeTerminal(k.store.getTask(fallback.id)!, "completed"));
    assert.equal(getAgentReport(k.store, report.key)!.status, "undelivered");
    assert.equal(getAgentReport(k.store, report.key)!.reason, "snapshot_missing");
    assert.equal(k.store.getTask(child.task.id)!.resultRef, child.task.resultRef);
    assert.equal(k.submissions.length, 0);
  } finally { k.cleanup(); }
});

for (const error of [new Error("unexpected_store_failure"), new WorkspaceSnapshotError("unexpected_snapshot_failure")]) {
  test(`快照失败处理不吞未知异常：${error.message}`, async context => {
    const k = kit();
    const orchestrator = new Orchestrator(k.deps);
    try {
      const child = k.child(k.main.id, "completed", true), unrecorded = k.child();
      context.mock.method(k.store, "getWorkDelegation", () => { throw error; });
      assert.throws(() => k.delivery.reserveResult(child.task), value => value === error);
      await assert.rejects(k.delivery.resultRecorded(child.task, "completed", "结果"), value => value === error);
      await assert.rejects(k.delivery.sweep(), value => value === error);
      await assert.rejects(orchestrator.start(), value => value === error);
      assert.equal(k.store.getTask(unrecorded.task.id)!.resultSummary, null);
      assert.equal(k.store.getTask(unrecorded.task.id)!.resultRef, null);
      assert.equal(getAgentReport(k.store, agentReportKey({ kind: "task", taskId: child.task.id })), null);
    } finally { context.mock.restoreAll(); await orchestrator.stop(); k.cleanup(); }
  });
}
