import { fixtureSubAgentRoleCatalog } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { TASK_END_MARKER, TASK_START_MARKER, type Session } from "@ruukoto/core/types.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { ViewState } from "@ruukoto/tui/tui/state.ts";
import { WORKFLOW_INTERFACE_VERSION, bindWorkflowExecution, createWorkflowRun, getWorkflowDeliveryRun, registerWorkflowStep, requireWorkflowRun, saveWorkflowDefinition, updateWorkflowRun, workflowDeliveryKey } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { lastUserText, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

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

test("idle dev final delivery retains its fixed version, tool-free fallback and trusted classification", async () => {
  const child = latch(), chat = latch();
  const t = await startTestRuntime("workflow-final-dev", async req => {
    if (lastUserText(req) === "日常聊天") { await chat.promise; return { kind: "text", text: "聊天完成" }; }
    if (lastUserText(req).startsWith("[工作流最终回报]") && toolNamesOf(req).length === 0) {
      assert.deepEqual(toolNamesOf(req), []);
      assert.match(lastUserText(req), /停止：脚本已核实；已启动执行 1\/1 项已核实，未启动 0 项/);
      assert.match(lastUserText(req), /本轮终态事实取代启动和中途历史中的旧状态/);
      return { kind: "text", text: "最终汇总" };
    }
    return { kind: "text", text: "普通任务" };
  }, { config: { product: codeProduct.runtime, workflowAgent: async () => { await child.promise; return { output: "步骤资料" }; } } });
  try {
    const rt = t.runtime, session = (await rt.openWorkspace({ cwd: t.work[0] })).session, parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "final", input: null, script: 'return await agent("one",{request:"处理"});' });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await rt.resumeQueue(session.id);
    const chatTask = await rt.submit({ sessionId: session.id, requestId: "chat", input: "日常聊天", modelSelection: rt.defaultSelection });
    await waitFor("聊天已进入模型", () => t.server.calls.length === 1);
    chat.release();
    await waitFor("chat completes before report readiness", () => rt.store.getTask(chatTask.id)!.status === "completed");
    rt.store.withTx(() => rt.store.setSessionQueueState(session.id, "paused", "test_fallback"));
    child.release();
    await waitFor("最终汇总已排队", () => requireWorkflowRun(rt.store, run.id).delivery?.taskId != null);
    const finished = requireWorkflowRun(rt.store, run.id), wake = rt.store.getTask(finished.delivery!.taskId!)!;
    assert.match(finished.delivery!.facts, /停止：脚本已核实；已启动执行 1\/1 项已核实，未启动 0 项/);
    assert.equal(wake.status, "queued"); assert.equal(wake.agentId, null); assert.equal(wake.sourceEventId, null);
    assert.equal(getWorkflowDeliveryRun(rt.store, wake.id)!.id, run.id);
    assert.equal(rt.getTaskDetail(wake.id)!.task.inputPurpose, "internal_report");
    assert.equal(rt.findTaskByRequest({ sessionId: session.id, requestId: wake.requestId }).task!.inputPurpose, "internal_report");
    assert.equal(rt.listTasks({ sessionId: session.id }).tasks.find(task => task.id === wake.id)!.inputPurpose, "internal_report");
    assert.equal(rt.snapshot().tasks.find(task => task.id === wake.id)!.inputPurpose, "internal_report");
    const key = workflowDeliveryKey(finished);
    rt.store.withTx(() => updateWorkflowRun(rt.store, requireWorkflowRun(rt.store, run.id)));
    assert.equal(workflowDeliveryKey(requireWorkflowRun(rt.store, run.id)), key);
    await assert.rejects(rt.submit({ sessionId: session.id, requestId: key, input: wake.input, modelSelection: rt.defaultSelection }), { code: "request_conflict" });
    assert.equal(t.server.calls.length, 1);
    await rt.resumeQueue(session.id);
    await waitFor("最终汇总完成", () => requireWorkflowRun(rt.store, run.id).delivery?.status === "reported");
    assert.equal(rt.store.findTaskByRequest(session.id, key)!.id, wake.id);
    assert.equal(t.server.calls.length, 2);
    assert.equal(rt.store.listTasksBySession(session.id).some(task => task.requestId.startsWith("wake:")), false);
    const page = rt.readHistory({ sessionId: session.id });
    const internalInput = page.entries.find(entry => entry.taskId === wake.id && entry.role === "user")!;
    assert.equal(internalInput.inputPurpose, "internal_report");
    assert.equal(internalInput.text, wake.input);
    assert.equal(rt.readHistoryEntry({ sessionId: session.id, entryId: internalInput.entryId }).inputPurpose, "internal_report");
    assert.equal(lastUserText(t.server.calls[1]), wake.input, "实际模型请求保留完整内部输入");
    const originalFile = rt.store.getSession(session.id)!.sessionFile!;
    const originalBytes = fs.readFileSync(originalFile);
    assert.ok(parseSessionFile(originalFile).some(entry => entry.id === internalInput.entryId), "JSONL 保留原条目");
    const branch = await rt.branchSession({ sessionId: session.id, requestId: "visibility-branch" });
    const nested = await rt.branchSession({ sessionId: branch.id, requestId: "visibility-nested" });
    for (const inherited of [branch, nested]) {
      assert.ok(inherited.branchSource!.taskIds.includes(wake.id));
      const history = rt.readHistory({ sessionId: inherited.id });
      assert.equal(history.entries.find(entry => entry.entryId === internalInput.entryId)!.inputPurpose, "internal_report");
      assert.equal(rt.readHistoryEntry({ sessionId: inherited.id, entryId: internalInput.entryId }).inputPurpose, "internal_report");
      const state = new ViewState();
      state.applySnapshot({ snapshot: { ...rt.snapshot(), product: rt.productType }, seq: 0, replay: [] }, false);
      state.installHistoryPage(inherited.id, history, "replace");
      const visible = state.openSession(inherited.id).flow.items;
      assert.ok(!visible.some(entry => entry.kind === "message" && entry.role === "user" && entry.text === wake.input));
      assert.ok(visible.some(entry => entry.kind === "message" && entry.text === "最终汇总"));
    }
    assert.deepEqual(fs.readFileSync(originalFile), originalBytes, "分类和分支不改写来源 JSONL");
    const fake = await rt.submit({ sessionId: session.id, requestId: "workflow-final:fake:1", input: wake.input, modelSelection: rt.defaultSelection });
    await waitFor("普通请求完成", () => rt.store.getTask(fake.id)!.status === "completed");
    assert.equal(getWorkflowDeliveryRun(rt.store, fake.id), null);
    assert.equal(fake.inputPurpose, "user");
    assert.equal(rt.readHistory({ sessionId: session.id }).entries.find(entry => entry.taskId === fake.id && entry.role === "user")!.inputPurpose, "user");
    assert.ok(toolNamesOf(t.server.calls[2]).includes("mock_delay"));
    const diagnostic = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const file = path.join(t.dirs.dataDir, "visibility-diagnostic.jsonl");
    const marker = (id: string, customType: string, taskId: string) => ({ type: "custom", id, customType, data: { taskId } });
    const message = (id: string) => ({ type: "message", id, message: { role: "user", content: wake.input } });
    fs.writeFileSync(file, [marker("foreign-start", TASK_START_MARKER, wake.id), message("foreign"), marker("foreign-end", TASK_END_MARKER, wake.id),
      marker("missing-start", TASK_START_MARKER, "missing-task"), message("missing"), marker("missing-end", TASK_END_MARKER, "missing-task"),
      message("unmarked")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    rt.store.withTx(() => rt.store.setSessionFile(diagnostic.id, file));
    const broken = rt.readHistory({ sessionId: diagnostic.id });
    assert.deepEqual(broken.entries.map(entry => [entry.inputPurpose, entry.taskAssociationError]),
      [["user", "task_outside_session"], ["user", "task_missing"], ["user", undefined]]);
    rt.store.withTx(() => rt.store.addHistoryEntryIds(wake.id, ["unmarked"]));
    rt.store.withTx(() => rt.store.setSessionFile(branch.id, file));
    assert.equal(rt.readHistoryEntry({ sessionId: branch.id, entryId: "unmarked" }).taskAssociationError, "task_marker_missing");
  } finally { child.release(); chat.release(); await t.shutdown(); }
});

test("终态停止事实区分已核实、未知和未启动；登记脚本仍未收尾时不汇总", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-report-stop-")), db = new Db(root), store = new Store(db);
  try {
    const selection = { provider: "mock", modelId: "mock", thinkingLevel: "off" } as const;
    const project = store.createProject("workflow"), stat = fs.statSync(root);
    const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "report", confirmTools: [] });
    const parent = store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "source", modelSelection: selection, submissionDigest: "source" }).task;
    store.transitionTask(parent.id, ["queued"], "completed");
    const definition = saveWorkflowDefinition(store, "return 1;");
    const inputs: string[] = [];
    const delivery = new ParentDelivery({ verifyWork: () => {}, verifyTask: () => null, store, defaultModelSelection: () => selection, readReply: () => null, isReviewEvent: () => false,
      resultNotice: () => null, sendWorkReport: () => {}, verifyWorkflowReport: () => true,
      submit: async input => { inputs.push(input.input); return parent; } });
    const cases = [
      { script: true, registered: true, execution: true, expected: "脚本已核实；已启动执行 1/1 项已核实，未启动 1 项" },
      { script: false, registered: true, execution: false, expected: "脚本未核实；已启动执行 0/1 项已核实，未启动 1 项" },
      { script: true, registered: true, execution: null, expected: "脚本已核实；已启动执行 0/1 项已核实，未启动 1 项" },
      { script: null, registered: false, execution: null, expected: "脚本未启动实际单元；已启动执行 0/0 项已核实，未启动 1 项" },
      { script: null, registered: true, execution: null, expected: null },
    ];
    for (const [index, value] of cases.entries()) {
      const id = `report-${index}`;
      const run = createWorkflowRun(store, { interfaceVersion: WORKFLOW_INTERFACE_VERSION, roleCatalog: fixtureSubAgentRoleCatalog(), id, requestKey: id, paramsDigest: id, definitionId: definition.id, scriptDigest: definition.digest,
        input: null, inputDigest: id, source: { product: "ruukoto-code", projectId: project.id, sessionId: session.id, taskId: parent.id,
          permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null },
        modelSelection: selection, status: "running", version: 1, reason: "test", attempts: 1, maxAttempts: 100,
        durationMs: 3_600_000, usedMs: 1, clockStartedAt: null, clockVerified: true,
        scriptUnits: value.registered ? [{ kind: "process_group", id: "123", label: "fixture" }] : [], scriptStopVerified: value.script,
        result: null, resultRecorded: true, createdAt: new Date().toISOString(), endedAt: new Date().toISOString() });
      for (const [ordinal, status] of (value.registered ? ["finished", "queued"] as const : ["queued"] as const).entries()) {
        registerWorkflowStep(store, { runId: id, key: status, ordinal: ordinal + 1, kind: "agent", params: {}, dependsOn: [] });
        const worker = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: `${id}-${status}`, confirmTools: [] });
        const task = store.insertQueuedTask({ sessionId: worker.id, requestId: `${id}-${status}`, input: status, modelSelection: selection, submissionDigest: id }).task;
        if (status === "finished") store.transitionTask(task.id, ["queued"], "completed");
        if (index === 0 && status === "finished") store.db.prepare("UPDATE tasks SET effect_unknown = 1 WHERE id = ?").run(task.id);
        bindWorkflowExecution(store, { id: `${id}-${status}`, runId: id, stepKey: status, kind: "agent", taskId: task.id, number: 1,
          status, units: [], stopVerified: status === "finished" ? value.execution : null });
      }
      updateWorkflowRun(store, { ...requireWorkflowRun(store, id), status: "failed", terminalVersion: 1 });
      await delivery.sweepWorkflows();
      const facts = requireWorkflowRun(store, run.id).delivery?.facts;
      if (value.expected === null) assert.equal(facts, undefined);
      else {
        assert.ok(facts!.includes(value.expected));
        assert.ok(inputs.at(-1)!.includes(value.expected));
        if (index === 0) assert.match(facts!, /操作效果未知/);
        if (value.registered && value.execution !== true) assert.match(facts!, /执行 .*停止未核实/);
      }
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
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
