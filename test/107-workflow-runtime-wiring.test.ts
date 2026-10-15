import { fixtureSubAgentDefinition } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { randomId, type Session } from "@ruukoto/core/types.ts";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { getWorkflowExecution, listWorkflowExecutions, requireWorkflowRun, setWorkflowState, workflowSlotsUsed } from "@ruukoto/core/workflow.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";

function sourceTask(rt: Runtime, session: Session) {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "拥有者工作流请求",
      modelSelection: rt.defaultSelection, submissionDigest: "source" }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return task;
  });
}
test("Runtime 的运行授权独立于原任务，主会话可继续，步骤结果不逐个唤醒或注入", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const t = await startTestRuntime("workflow-runtime-binding", async () => ({ kind: "text", text: "新聊天" }), {
    config: { workflowAgent: async context => { await blocked; assert.equal(context.signal.aborted, false); return { output: "步骤完成" }; } },
  });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const parent = sourceTask(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "runtime", script: 'return await agent("one", {request:"步骤"});', input: null });
    await waitFor("步骤开始", () => requireWorkflowRun(rt.store, run.id).attempts === 1);
    const active = listWorkflowExecutions(rt.store, run.id)[0]!;
    await assert.rejects(rt.cancelTask(active.taskId), { code: "invalid_state" });
    await assert.rejects(rt.interruptTask(active.taskId), { code: "invalid_state" });
    await assert.rejects(rt.subagents!.cancelWork({ workId: rt.store.getTask(active.taskId)!.workId!, by: "owner" }), { code: "invalid_state" });
    assert.equal(rt.store.getTask(active.taskId)!.cancelRequested, false);
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await rt.resumeQueue(session.id);
    const chat = await rt.submit({ sessionId: session.id, requestId: "new-chat", input: "新聊天", modelSelection: rt.defaultSelection });
    await waitFor("日常聊天完成", () => rt.store.getTask(chat.id)!.status === "completed");
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "running");
    release();
    await waitFor("工作流完成", () => requireWorkflowRun(rt.store, run.id).status === "succeeded");
    await waitFor("整项最终汇总完成", () => requireWorkflowRun(rt.store, run.id).delivery?.status === "reported");
    const execution = listWorkflowExecutions(rt.store, run.id)[0]!;
    assert.equal(getWorkflowExecution(rt.store, execution.taskId)!.kind, "agent");
    const task = rt.store.getTask(execution.taskId)!;
    const identity = rt.store.getSessionIdentity(task.sessionId)!;
    assert.equal(identity.kind, "subagent");
    if (identity.kind !== "subagent") assert.fail("需要宿主步骤绑定");
    assert.equal(identity.workflow!.runId, run.id);
    assert.equal(identity.workflow!.sourceSessionId, session.id);
    assert.equal(rt.store.listUndeliveredSubAgentResults(session.id).length, 0);
    assert.equal(rt.store.listRoleTasksPendingWake().some(item => item.id === task.id), false);
    assert.equal(rt.store.listTasksBySession(session.id).some(item => item.requestId === `wake:${task.id}`), false);
    assert.equal(t.server.calls.length, 2);
    assert.equal(rt.store.listTasksBySession(session.id).filter(item => item.requestId.startsWith("workflow-final:")).length, 1);
    await assert.rejects(rt.continueTask({ taskId: task.id, requestId: "ordinary", input: "继续", modelSelection: rt.defaultSelection }), { code: "invalid_state" });
    await assert.rejects(rt.switchTaskMode({ taskId: task.id, mode: "full_access" }), { code: "invalid_state" });
  } finally { release(); await t.shutdown(); }
});

test("普通 SubAgent 在真实 Runtime 出队时与三个工作流步骤抢同一来源名额", async () => {
  const releases: (() => void)[] = [];
  const t = await startTestRuntime("workflow-runtime-slots", async () => ({ kind: "text", text: "普通委派结果" }), {
    config: { workflowAgent: async () => { await new Promise<void>(resolve => releases.push(resolve)); return { output: "fake" }; } },
  });
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const parent = sourceTask(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "slots", input: null,
      script: 'return await Promise.all(["a","b","c"].map(key=>agent(key,{request:key})));' });
    await waitFor("三项工作流尝试", () => releases.length === 3);
    const directory = path.join(t.dirs.root, "ordinary");
    fs.mkdirSync(directory);
    const cwd = fs.realpathSync(directory);
    const stat = fs.statSync(cwd);
    const definition = fixtureSubAgentDefinition();
    const execution = await (await rt["getDriver"](session)).preflightSubAgent(run.source, definition);
    const ordinary = rt.store.withTx(() => {
      const child = rt.store.createSession({ projectId: session.projectId, cwd, cwdReal: cwd, cwdDev: stat.dev, cwdIno: stat.ino,
        piSessionId: randomId("pi"), confirmTools: [], modelSelection: rt.defaultSelection });
      rt.store.setSessionQueueState(child.id, "paused", "test_slots");
      const id = randomId("sagent"), workId = randomId("work");
      rt.store.insertSubAgent({ definition, id, parentSessionId: session.id, sessionId: child.id, workDir: cwd, state: "running", currentTaskId: null,
        activeWorkId: workId, closedAt: null, closedBy: null, createdAt: new Date().toISOString() });
      rt.store.insertWorkDelegation({ id: workId, parentSessionId: session.id, originTaskId: parent.id, subAgentId: id, requestKey: "ordinary",
        paramsDigest: "ordinary", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: new Date().toISOString() });
      return rt.store.insertQueuedTask({ sessionId: child.id, requestId: "ordinary", input: "普通委派", modelSelection: rt.defaultSelection,
        submissionDigest: "ordinary", workId, subAgentId: id, parentTaskId: parent.id,
        sourcePermissionVersion: parent.permissionVersion, readScope: { paths: [], sourceRefs: [], readMemories: [], execution } }).task;
    });
    let peak = workflowSlotsUsed(rt.store, session.id);
    rt.addEventListener(() => { peak = Math.max(peak, workflowSlotsUsed(rt.store, session.id)); });
    await rt.resumeQueue(ordinary.sessionId);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(rt.store.getTask(ordinary.id)!.status, "queued");
    assert.equal(t.server.calls.length, 0);
    releases[0]!();
    await waitFor("普通委派获得名额", () => rt.store.getTask(ordinary.id)!.status === "completed");
    releases[1]!(); releases[2]!();
    await waitFor("工作流结束", () => requireWorkflowRun(rt.store, run.id).status === "succeeded");
    assert.equal(peak, 3);
  } finally { for (const release of releases) release(); await t.shutdown(); }
});

test("脚本汇总等目录占用时暂停，恢复重放原宿主操作，实际写入一次", async () => {
  let rt!: Runtime;
  let effects = 0;
  const t = await startTestRuntime("workflow-integrate-replay", async () => ({ kind: "text", text: "普通任务" }), {
    config: {
      workflowAgent: async () => ({ output: "unused" }),
      workflowIntegrate: ({ run, step }) => rt.workflowHostOperation({ runId: run.id, stepKey: step.key, key: "integrate", params: { file: "effect" } },
        async () => { effects++; fs.writeFileSync(path.join(t.work[0], "effect"), "写入一次"); return { applied: true }; }),
    },
  });
  rt = t.runtime;
  try {
    const session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const parent = sourceTask(rt, session);
    const blocker = rt.store.withTx(() => {
      rt.store.endTask(parent.id, ["running"], "completed");
      const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "blocker", input: "目录占用替身", modelSelection: rt.defaultSelection, submissionDigest: "blocker" }).task;
      rt.store.transitionTask(task.id, ["queued"], "running");
      rt.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, sessionId: session.id, taskId: task.id });
      rt.store.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(parent.id);
      return task;
    });
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "integrate", script: 'return await integrate("merge", {});', input: null });
    rt.store.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(parent.id);
    await waitFor("宿主操作排队", () => listWorkflowExecutions(rt.store, run.id).length === 1);
    const queued = listWorkflowExecutions(rt.store, run.id)[0]!;
    await rt.workflows!.control(run.id, "pause", requireWorkflowRun(rt.store, run.id).version, { action: "pause" });
    await waitFor("汇总准备可重放", () => rt.store.getTask(queued.taskId)!.status === "queued" &&
      (rt.store.db.prepare("SELECT payload FROM workflow_steps WHERE run_id = ? AND key = 'merge'").get(run.id) as { payload: string }).payload.includes('"status":"queued"'));
    rt.store.withTx(() => rt.store.endTask(blocker.id, ["running"], "completed"));
    await rt.workflows!.control(run.id, "resume", requireWorkflowRun(rt.store, run.id).version, { action: "resume" });
    await waitFor("汇总恢复完成", () => requireWorkflowRun(rt.store, run.id).status === "succeeded");
    assert.equal(listWorkflowExecutions(rt.store, run.id).length, 1);
    assert.equal(listWorkflowExecutions(rt.store, run.id)[0]!.taskId, queued.taskId);
    assert.equal(effects, 1);
    assert.equal(fs.readFileSync(path.join(t.work[0], "effect"), "utf8"), "写入一次");
    assert.equal(requireWorkflowRun(rt.store, run.id).attempts, 0);
    assert.equal(t.server.calls.length, 0);
  } finally { await t.shutdown(); }
});

for (const paused of [false, true]) test(`重启使用真实步骤执行器时，${paused ? "保留已有暂停原因" : "恢复持久人工等待"}`, async () => {
  const t = await startTestRuntime("workflow-adapter-missing", async () => ({ kind: "text", text: "ordinary" }), {
    config: { workflowAgent: async () => ({ output: "fake" }) },
  });
  let recovered: Runtime | undefined;
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const parent = sourceTask(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "waiting", script: 'return await ask("question",{prompt:"wait"});', input: null });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("持久等待", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    if (paused) await rt.workflows!.control(run.id, "pause", requireWorkflowRun(rt.store, run.id).version, { action: "pause" });
    await rt.stop("test_restart");
    if (!paused) {
      const db = new Db(rt.config.dataDir);
      const store = new Store(db);
      try { store.withTx(() => setWorkflowState(store, run.id, "queued", null)); }
      finally { db.close(); }
    }
    recovered = await Runtime.start({ ...rt.config, workflowAgent: undefined });
    await waitFor("工作流恢复", () => requireWorkflowRun(recovered!.store, run.id).status === (paused ? "paused" : "waiting"));
    assert.equal(requireWorkflowRun(recovered.store, run.id).reason, paused ? "owner_pause" : "owner_input");
    assert.ok(recovered.workflows);
    assert.equal(t.server.calls.length, 0);
  } finally { await recovered?.stop("test_end"); await t.shutdown(); }
});
