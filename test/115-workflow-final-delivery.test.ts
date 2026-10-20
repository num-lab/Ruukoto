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
import { WORKFLOW_INTERFACE_VERSION, bindWorkflowExecution, createWorkflowRun, getWorkflowDeliveryRun, getWorkflowQuestion, listWorkflowExecutions, listWorkflowRuns, registerWorkflowStep, requireWorkflowRun, saveWorkflowDefinition, updateWorkflowRun, workflowDeliveryKey } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { parseRule, firstDue } from "@ruukoto/channels/scheduler/time.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot } from "./helpers/mock-onebot.ts";
import { inputText, lastUserText, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

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
    await rt.submit({ sessionId: session.id, requestId: "chat", input: "日常聊天", modelSelection: rt.defaultSelection });
    await waitFor("聊天已进入模型", () => t.server.calls.length === 1);
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
    chat.release();
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
    assert.doesNotMatch(inputText(req), /notification_enqueue|service_manage/);
    assert.doesNotMatch(req.system ?? "", /notification_enqueue|service_manage/);
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
