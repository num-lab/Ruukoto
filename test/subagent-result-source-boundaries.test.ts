import assert from "node:assert/strict";
import { test } from "node:test";
import { agentReportKey, getAgentReport, registerAgentReport } from "@ruukoto/core/agent-wait.ts";
import { requireSubAgentExecutionScope } from "@ruukoto/core/subagent-execution.ts";
import { randomId, type Session, type Task } from "@ruukoto/core/types.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import { afterTool, inputText, lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

function sourceTask(rt: Runtime, session: Session): Task {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const id = randomId("source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: id, input: "来源", accessMode: "full_access", modelSelection: rt.defaultSelection, submissionDigest: id }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}
function release(rt: Runtime, source: Task): void {
  rt.store.withTx(() => { rt.store.endTask(source.id, ["running"], "completed"); rt.store.setSessionQueueState(source.sessionId, "active", null); });
}
async function childDone(rt: Runtime, id: string): Promise<Task> {
  await waitFor("子任务实际模型结果已登记", () => rt.store.getTask(id)?.status === "completed" && rt.store.getTask(id)?.resultSummary !== null);
  return rt.store.getTask(id)!;
}

for (const damage of ["execution", "definition", "binding", "source"] as const) test(`真实普通父模型不注入或消费缺损的子任务结果和消息：${damage}`, async () => {
  let childId = "", childCalls = 0;
  const parentInputs: string[] = [];
  const kit = await startTestRuntime("result-source", req => {
    if (lastUserText(req) === "WAIT_CHILD") {
      parentInputs.push(inputText(req));
      if (afterTool(req)) return { kind: "text", text: "父轮结束" };
      return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "task", task_id: childId }] } }] };
    }
    childCalls++;
    return { kind: "text", text: "RESULT_SOURCE_SENTINEL" };
  });
  try {
    const rt = kit.runtime, session = await rt.createSession({ projectName: "source", cwd: kit.work[0] });
    const source = sourceTask(rt, session);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "child", request: "完成", paramsDigest: "child" }); childId = child.task.id;
    const before = await childDone(rt, childId);
    const messageId = randomId("smsg");
    rt.store.withTx(() => rt.store.insertSubAgentMessage({ id: messageId, workId: child.work.id, parentSessionId: session.id, fromSubAgentId: child.agent.id,
      fromTaskId: childId, accessMode: before.accessMode, sourcePermissionVersion: before.permissionVersion, toSubAgentId: null, requestKey: "message", paramsDigest: "message",
      body: "MESSAGE_SOURCE_SENTINEL", createdAt: new Date().toISOString(), deliveredTaskId: null, deliveredAt: null, undeliveredReason: null }));
    if (damage === "execution") rt.store.db.prepare("UPDATE tasks SET read_scope = json_remove(read_scope, '$.execution') WHERE id = ?").run(childId);
    else if (damage === "definition") rt.store.db.prepare("UPDATE sub_agents SET definition = '{}' WHERE id = ?").run(child.agent.id);
    else if (damage === "binding") rt.store.db.prepare("UPDATE tasks SET access_mode = 'confirm' WHERE id = ?").run(childId);
    else rt.store.db.prepare("UPDATE tasks SET permission_version = permission_version + 1 WHERE id = ?").run(source.id);
    release(rt, source);
    const parent = await rt.submit({ sessionId: session.id, requestId: "wait", input: "WAIT_CHILD", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父任务完成错误说明", () => ["completed", "failed"].includes(rt.store.getTask(parent.id)!.status));
    const op = rt.store.listToolOpsByTask(parent.id).find(op => op.toolName === "agent_wait")!;
    assert.ok(op); assert.equal(op.isError, true, op.resultSummary!);
    assert.ok(parentInputs.every(input => !input.includes("RESULT_SOURCE_SENTINEL") && !input.includes("MESSAGE_SOURCE_SENTINEL")), "坏记录的正文不能先由自动注入泄漏");
    assert.equal(rt.store.getSubAgentMessage(messageId)?.deliveredAt, null);
    assert.ok(rt.store.getSubAgentMessage(messageId)?.undeliveredReason);
    const report = getAgentReport(rt.store, agentReportKey({ kind: "task", taskId: childId }));
    assert.equal(report?.consumption ?? null, null);
    const after = rt.store.getTask(childId)!;
    assert.equal(after.status, before.status); assert.equal(after.resultSummary, before.resultSummary); assert.equal(after.endedAt, before.endedAt);
    assert.equal(rt.store.listTasksBySession(child.agent.sessionId).length, 1); assert.equal(childCalls, 1, "拒绝消费不重放子任务");
  } finally { await kit.shutdown(); }
});

test("main 已排队结果唤醒在坏来源后被截住，保留原任务与唯一唤醒键", async () => {
  let wakeCalls = 0;
  const kit = await startTestRuntime("result-main-source", req => {
    if (lastUserText(req).startsWith("[编排器]")) wakeCalls++;
    return { kind: "text", text: "MAIN_CHILD_SENTINEL" };
  });
  try {
    const rt = kit.runtime, session = rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!;
    const source = sourceTask(rt, session);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "child", request: "完成", paramsDigest: "child" });
    const before = await childDone(rt, child.task.id);
    await waitFor("main 唯一唤醒已排队", () => !!rt.store.findTaskByRequest(session.id, `wake:${child.task.id}`));
    const wake = rt.store.findTaskByRequest(session.id, `wake:${child.task.id}`)!;
    rt.store.db.prepare("UPDATE tasks SET read_scope = json_remove(read_scope, '$.execution') WHERE id = ?").run(child.task.id);
    release(rt, source); await rt.resumeQueue(session.id);
    await waitFor("坏来源唤醒终态", () => ["completed", "failed", "canceled"].includes(rt.store.getTask(wake.id)!.status));
    assert.equal(wakeCalls, 0); assert.equal(rt.store.getTask(wake.id)!.status, "canceled");
    assert.equal(rt.store.getTask(wake.id)!.errorMessage, "execution_missing"); assert.equal(rt.store.getWorkDelegation(child.work.id)!.canceledAt, null);
    assert.equal(rt.store.findTaskByRequest(session.id, `wake:${child.task.id}`)!.id, wake.id);
    assert.equal(rt.store.getTask(child.task.id)!.resultSummary, before.resultSummary);
    assert.equal(rt.store.listTasksBySession(child.agent.sessionId).length, 1);
  } finally { await kit.shutdown(); }
});

test("报告沿冻结的截止任务依赖复核，后续身份复用的坏执行不扩大旧结果依赖", async () => {
  let firstId = "";
  const kit = await startTestRuntime("result-frozen-source", req => {
    if (lastUserText(req) === "WAIT_OLD_CHILD") {
      if (afterTool(req)) return { kind: "text", text: "已消费旧结果" };
      return { kind: "tool_calls", calls: [{ id: "wait", name: "agent_wait", arguments: { targets: [{ kind: "task", task_id: firstId }] } }] };
    }
    return { kind: "text", text: "FROZEN_RESULT_SENTINEL" };
  });
  try {
    const rt = kit.runtime, session = await rt.createSession({ projectName: "source", cwd: kit.work[0] });
    const source = sourceTask(rt, session);
    const first = await rt.subagents!.delegate({ parentTaskId: source.id, key: "first", request: "旧工作", paramsDigest: "first" }); firstId = first.task.id;
    const before = await childDone(rt, firstId);
    const report = rt.store.withTx(() => registerAgentReport(rt.store, { target: { kind: "task", taskId: firstId }, source: requireSubAgentExecutionScope(before.readScope).execution.source, parentSessionId: session.id }));
    release(rt, source);
    const nextSource = sourceTask(rt, session);
    const next = await rt.subagents!.delegate({ parentTaskId: nextSource.id, key: "next", subAgentId: first.agent.id, request: "新工作", paramsDigest: "next" });
    await childDone(rt, next.task.id);
    rt.store.db.prepare("UPDATE tasks SET read_scope = json_remove(read_scope, '$.execution') WHERE id = ?").run(next.task.id);
    release(rt, nextSource);
    const parent = await rt.submit({ sessionId: session.id, requestId: "wait", input: "WAIT_OLD_CHILD", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("父轮消费旧结果", () => ["completed", "failed"].includes(rt.store.getTask(parent.id)!.status));
    const op = rt.store.listToolOpsByTask(parent.id).find(op => op.toolName === "agent_wait")!;
    assert.ok(op); assert.equal(op.isError, false, op.resultSummary!); assert.match(op.resultSummary!, /"reason":"result"/);
    const final = getAgentReport(rt.store, report.key)!;
    assert.deepEqual(final.dependencyTaskIds, [firstId]); assert.equal(final.consumption?.taskId, parent.id);
    assert.equal(rt.store.getTask(firstId)!.resultSummary, before.resultSummary);
    assert.equal(rt.store.listTasksBySession(first.agent.sessionId).length, 2);
  } finally { await kit.shutdown(); }
});


test("结果装配后来源损坏，真实模型响应不消费原结果且不重放", async () => {
  let active: Runtime | null = null, childId = "", parentCalls = 0;
  const kit = await startTestRuntime("result-consume-source", req => {
    if (lastUserText(req) === "CONSUME_CHILD") {
      parentCalls++;
      assert.match(inputText(req), /CONSUME_RESULT_SENTINEL/);
      active!.store.db.prepare("UPDATE tasks SET read_scope = json_remove(read_scope, '$.execution') WHERE id = ?").run(childId);
      return { kind: "text", text: "试图消费原结果" };
    }
    return { kind: "text", text: "CONSUME_RESULT_SENTINEL" };
  });
  try {
    const rt = kit.runtime; active = rt;
    const session = await rt.createSession({ projectName: "source", cwd: kit.work[0] }), source = sourceTask(rt, session);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "child", request: "完成", paramsDigest: "child" }); childId = child.task.id;
    const before = await childDone(rt, childId); release(rt, source);
    const parent = await rt.submit({ sessionId: session.id, requestId: "consume", input: "CONSUME_CHILD", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("响应消费被拒绝", () => ["failed", "interrupted", "completed"].includes(rt.store.getTask(parent.id)!.status));
    assert.notEqual(rt.store.getTask(parent.id)!.status, "completed");
    assert.equal(rt.store.getTask(childId)!.resultDeliveredAt, null); assert.equal(rt.store.getTask(childId)!.resultSummary, before.resultSummary);
    assert.equal(rt.store.listTasksBySession(child.agent.sessionId).length, 1); assert.equal(parentCalls, 1);
  } finally { await kit.shutdown(); }
});


test("main 结果唤醒响应期间来源损坏，不完成消费且保留子结果", async () => {
  let active: Runtime | null = null, childId = "", wakeCalls = 0;
  const kit = await startTestRuntime("result-main-consume", req => {
    if (lastUserText(req).startsWith("[编排器]")) {
      wakeCalls++;
      active!.store.db.prepare("UPDATE tasks SET read_scope = json_remove(read_scope, '$.execution') WHERE id = ?").run(childId);
      return { kind: "text", text: "来源已经损坏的唤醒响应" };
    }
    return { kind: "text", text: "MAIN_CONSUME_RESULT" };
  });
  try {
    const rt = kit.runtime; active = rt;
    const session = rt.store.getSession(rt.store.getAgentRole("main")!.sessionId)!, source = sourceTask(rt, session);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "child", request: "完成", paramsDigest: "child" }); childId = child.task.id;
    const before = await childDone(rt, childId);
    await waitFor("main 唤醒排队", () => !!rt.store.findTaskByRequest(session.id, `wake:${childId}`));
    const wake = rt.store.findTaskByRequest(session.id, `wake:${childId}`)!;
    release(rt, source); await rt.resumeQueue(session.id);
    await waitFor("main 响应消费终止", () => ["completed", "failed", "interrupted"].includes(rt.store.getTask(wake.id)!.status));
    assert.notEqual(rt.store.getTask(wake.id)!.status, "completed"); assert.equal(wakeCalls, 1);
    assert.equal(rt.store.getTask(childId)!.resultSummary, before.resultSummary); assert.equal(rt.store.listTasksBySession(child.agent.sessionId).length, 1);
    assert.equal(rt.store.getWorkDelegation(child.work.id)!.canceledAt, null);
  } finally { await kit.shutdown(); }
});
