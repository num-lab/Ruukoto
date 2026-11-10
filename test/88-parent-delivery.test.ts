import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { agentReportKey, getAgentReport, registerAgentReport } from "@ruukoto/core/agent-wait.ts";
import type { SubAgentMessage, Task } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";

const SELECTION = { provider: "mock", modelId: "source-model", thinkingLevel: "off" as const };

function kit() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-parent-delivery-")));
  const db = new Db(root), store = new Store(db), stat = fs.statSync(root), project = store.createProject("delivery");
  let sequence = 0;
  const session = () => store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: stat.dev,
    cwdIno: stat.ino, piSessionId: `pi-${++sequence}`, confirmTools: [] });
  const parentSession = session(), childSession = session();
  const createTask = (sessionId: string, input: Partial<Parameters<Store["insertQueuedTask"]>[0]> = {}) => store.insertQueuedTask({
    sessionId, requestId: `request-${++sequence}`, input: "work", modelSelection: SELECTION, submissionDigest: `digest-${sequence}`, ...input,
  }).task;
  const parent = createTask(parentSession.id, { accessMode: "full_access" });
  store.transitionTask(parent.id, ["queued"], "completed");
  const agent = { definition: fixtureSubAgentDefinition(), id: "child-agent", parentSessionId: parentSession.id,
    sessionId: childSession.id, workDir: root, activeWorkId: "work", currentTaskId: null, state: "idle" as const,
    closedAt: null, closedBy: null, createdAt: childSession.createdAt };
  store.insertSubAgent(agent);
  const work = { id: "work", parentSessionId: parentSession.id, originTaskId: parent.id, subAgentId: agent.id,
    requestKey: "work", paramsDigest: "work", canceledAt: null, canceledBy: null, cancelReason: null,
    writeTarget: null, createdAt: childSession.createdAt };
  store.insertWorkDelegation(work);
  const child = createTask(childSession.id, { parentTaskId: parent.id, workId: work.id, subAgentId: agent.id, accessMode: "full_access" });
  const source: WorkflowSource = { product: "ruukoto", projectId: project.id, sessionId: parentSession.id, taskId: parent.id,
    permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [], capabilities: [], references: [] };
  const delivery = new ParentDelivery({ store, verifyWork: () => {}, verifyTask: () => null,
    defaultModelSelection: () => ({ ...SELECTION, modelId: "later-default" }), readReply: () => null,
    submit: async input => store.withTx(() => store.insertQueuedTask({ ...input, submissionDigest: input.requestId }).task) });
  const finish = (status: "completed" | "failed" | "canceled" | "interrupted" = "completed"): Task => {
    store.transitionTask(child.id, ["queued"], status, { endedAt: new Date().toISOString(), errorMessage: status === "canceled" ? "deadline_exceeded" : null });
    store.setTaskResult(child.id, "retained result", JSON.stringify({ taskId: child.id }));
    return store.getTask(child.id)!;
  };
  const message = (): SubAgentMessage => {
    const message: SubAgentMessage = { id: `message-${++sequence}`, workId: work.id, parentSessionId: parentSession.id,
      fromSubAgentId: agent.id, fromTaskId: child.id, accessMode: child.accessMode, sourcePermissionVersion: child.permissionVersion,
      toSubAgentId: null, requestKey: `message-${sequence}`, paramsDigest: `message-${sequence}`, body: "collaboration",
      createdAt: new Date().toISOString(), deliveredAt: null, deliveredTaskId: null, undeliveredReason: null };
    store.insertSubAgentMessage(message);
    return message;
  };
  const cancel = () => store.cancelWorkDelegation(work.id, new Date().toISOString(), "owner", null);
  return { store, parentSession, childSession, parent, child, work, source, delivery, createTask, finish, message, cancel,
    cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("Ordinary results remain pending until a parent request accepts them, without creating a wake task", async t => {
  const k = kit(); t.after(k.cleanup);
  const child = k.finish("failed");
  await k.delivery.resultRecorded(child, "failed", child.resultSummary!);
  assert.equal(k.store.findTaskByRequest(k.parentSession.id, `wake:${child.id}`), null);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results.map(task => task.id), [child.id]);
    assert.equal(k.store.getTask(child.id)!.resultDeliveredAt, null);
  }
  assert.deepEqual(k.delivery.takeInjection(k.childSession.id), { results: [], messages: [] });
  const receiver = k.createTask(k.parentSession.id);
  k.delivery.acceptInjection(receiver.id, [child.id], "accepted-request");
  assert.ok(k.store.getTask(child.id)!.resultDeliveredAt);
  assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results, []);
  assert.equal(k.store.getTask(child.id)!.resultSummary, "retained result");
});

test("Cancellation after assembly rejects consumption and preserves the original result", async t => {
  const k = kit(); t.after(k.cleanup);
  const child = k.finish(), receiver = k.createTask(k.parentSession.id);
  assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results.map(task => task.id), [child.id]);
  k.cancel();
  assert.throws(() => k.delivery.acceptInjection(receiver.id, [child.id], "late-request"), { code: "source_invalid" });
  assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results, []);
  await k.delivery.resultRecorded(child, "completed", child.resultSummary!);
  assert.equal(k.store.findTaskByRequest(k.parentSession.id, `wake:${child.id}`), null);
  assert.equal(k.store.getTask(child.id)!.resultDeliveredAt, null);
  assert.equal(k.store.getTask(child.id)!.resultRef, child.resultRef);
});

test("Parent messages inject once without a model preflight; cancellation excludes undelivered messages", t => {
  const k = kit(); t.after(k.cleanup);
  k.finish();
  const message = k.message();
  assert.equal(k.store.withTx(() => k.delivery.messageRecorded(message, k.work, null)), "inject");
  assert.equal(k.store.findTaskByRequest(k.parentSession.id, `smsg:${message.id}`), null);
  assert.equal(k.store.getSubAgentMessage(message.id)!.deliveredAt, null);
  assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).messages.map(item => item.id), [message.id]);
  assert.ok(k.store.getSubAgentMessage(message.id)!.deliveredAt);
  assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).messages, []);
  const late = k.message();
  k.cancel();
  assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).messages, []);
  assert.equal(k.store.getSubAgentMessage(late.id)!.deliveredAt, null);
  assert.equal(k.store.getSubAgentMessage(late.id)!.body, "collaboration");
});

test("owner request keys do not acquire canceled source authority from their prefixes", t => {
  const k = kit(); t.after(k.cleanup);
  const child = k.finish(), message = k.message();
  k.cancel();
  for (const requestId of ["wake:manual", "smsg:manual", `wake:${child.id}`, `smsg:${message.id}`]) {
    const owner = k.createTask(k.parentSession.id, { requestId });
    assert.equal(k.delivery.wakeUnavailable(owner), null);
  }
});

test("persisted fallback ownership rejects a source invalidated after host wake creation", async t => {
  const k = kit(); t.after(k.cleanup);
  const child = k.finish();
  const report = k.store.withTx(() => registerAgentReport(k.store, { target: { kind: "task", taskId: child.id },
    source: k.source, parentSessionId: k.parentSession.id }));
  await k.delivery.resultRecorded(child, "completed", child.resultSummary!);
  const wake = k.store.getTask(getAgentReport(k.store, report.key)!.fallbackTaskId!)!;
  assert.equal(k.delivery.wakeUnavailable(wake), null);
  const invalid = new ParentDelivery({ store: k.store, verifyWork: () => {}, verifyTask: () => "subagent_source_invalid",
    defaultModelSelection: () => SELECTION, readReply: () => null,
    submit: async () => { throw new Error("invalid sources must not submit another wake"); } });
  assert.equal(invalid.wakeUnavailable(wake), "subagent_source_invalid");
  assert.equal(getAgentReport(k.store, report.key)!.status, "undelivered");
  assert.equal(getAgentReport(k.store, report.key)!.reason, "subagent_source_invalid");
  assert.equal(k.store.getTask(child.id)!.resultRef, child.resultRef);
});

for (const [status, outcome] of [["completed", "completed"], ["failed", "failed"], ["canceled", "timeout"], ["interrupted", "unknown"]] as const) {
  test(`Waited ${outcome} results create one fallback with original authority and reject it after work cancellation`, async t => {
    const k = kit(); t.after(k.cleanup);
    const child = k.finish(status);
    const report = k.store.withTx(() => registerAgentReport(k.store, { target: { kind: "task", taskId: k.child.id },
      source: k.source, parentSessionId: k.parentSession.id }));
    const current = k.store.getSession(k.parentSession.id)!;
    k.store.setSessionDefaultMode(current.id, "confirm", current.defaultAccessModeVersion);
    await k.delivery.resultRecorded(child, outcome, child.resultSummary!);
    const wake = k.store.findTaskByRequest(k.parentSession.id, `wake:${child.id}`)!;
    assert.ok(wake);
    assert.equal(wake.accessMode, "full_access");
    assert.deepEqual(wake.modelSelection, SELECTION);
    assert.equal(wake.parentTaskId, child.id);
    assert.equal(wake.sourcePermissionVersion, child.permissionVersion);
    assert.equal(getAgentReport(k.store, report.key)!.fallbackTaskId, wake.id);
    assert.deepEqual(k.delivery.takeInjection(k.parentSession.id).results, []);
    await k.delivery.resultRecorded(child, outcome, child.resultSummary!);
    await k.delivery.sweep();
    assert.equal(k.store.listTasksBySession(k.parentSession.id).filter(task => task.requestId === `wake:${child.id}`).length, 1);
    assert.equal(k.delivery.wakeAdmitted(wake), true);
    k.cancel();
    assert.equal(k.delivery.wakeUnavailable(wake), "work_canceled");
    assert.equal(k.store.getTask(child.id)!.resultRef, child.resultRef);
    assert.equal(getAgentReport(k.store, agentReportKey({ kind: "task", taskId: child.id }))!.key, report.key);
  });
}
