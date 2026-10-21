import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import type { ControlConnection } from "@ruukoto/control/connection.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import { OwnerQuestionCancelGuard } from "@ruukoto/control/owner-question-cancel.ts";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { getOwnerQuestion, getOwnerQuestionReceipt, ownerQuestionToView, type OwnerQuestionItem } from "@ruukoto/core/owner-questions.ts";
import { afterTool, connectAuthedClient, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

async function startQuestions(items: OwnerQuestionItem[] = [{ question: "选择发布范围？", options: ["本地", "共享"] }, { question: "备注？" }]) {
  const t = await startTestRuntime("owner-questions", req => lastUserText(req) === "ASK" && !afterTool(req)
    ? { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: items } },
      { id: "after-ask", name: "write", arguments: { path: "forbidden.txt", content: "不能依赖尚未回答的问题" } }] }
    : { kind: "text", text: "已记录" }, { config: { ...realTools(), product: product.runtime } });
  const session = await t.runtime.createSession({ projectName: "questions", cwd: t.work[0], mode: "full_access" });
  const task = await t.client.request<OpResult<"submit">>("submit", { session_id: session.id, request_id: "ask", input: "ASK", model_selection: t.runtime.defaultSelection });
  await waitFor("提问任务自然完成", () => t.runtime.store.getTask(task.id)!.status === "completed");
  const question = t.runtime.listOwnerQuestions(session.id).questions[0];
  assert.ok(question, t.runtime.store.getTask(task.id)!.errorMessage ?? "没有登记问题");
  const params: OpParams<"owner_question_answer"> = { session_id: session.id, question_id: question.id, question_version: question.version,
    request_id: "answer", answers: [{ text: "共享", option: 1 }, { text: "实际自由回答" }], model_selection: t.runtime.defaultSelection };
  return { t, session, task, question, params };
}

test("SDK 提问后工具三层收窄，普通聊天/存档保留问题，双客户端只有唯一当前权限续接", async () => {
  const { t, session, task, question, params } = await startQuestions();
  try {
    assert.ok(toolNamesOf(t.server.calls[0]).includes("ask_user"));
    const schemas = (t.server.calls[0].tools ?? []).map(tool => (tool.function as { parameters: { required?: string[] } }).parameters);
    assert.ok(schemas.every(schema => Array.isArray(schema.required)), "实际SDK请求的所有工具须显式携required数组，包含无必填字段工具");
    assert.ok(!toolNamesOf(t.server.calls[1]).includes("write"));
    assert.ok(!toolNamesOf(t.server.calls[1]).includes("ask_user"));
    assert.equal(fs.existsSync(path.join(t.work[0], "forbidden.txt")), false);
    assert.equal(t.runtime.store.listToolOpsByTask(task.id).some(op => op.toolName === "write"), false);
    assert.equal(t.runtime.store.listAllOccupancy().length, 0);
    const chat = await t.client.request<OpResult<"submit">>("submit", { session_id: session.id, request_id: "chat", input: "共享", model_selection: t.runtime.defaultSelection });
    await waitFor("普通聊天完成", () => t.runtime.store.getTask(chat.id)!.status === "completed");
    await t.client.request("set_session_archived", { session_id: session.id, archived: true });
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, "pending");
    const mode = t.runtime.getSession(session.id)!.defaultAccessModeVersion;
    await t.runtime.setSessionDefaultMode({ sessionId: session.id, mode: "plan", expectedVersion: mode });
    const other = await connectAuthedClient(t.runtime);
    try {
      const answers = await Promise.allSettled([t.client.request("owner_question_answer", params), other.request("owner_question_answer", { ...params, request_id: "other" })]);
      assert.equal(answers.filter(answer => answer.status === "fulfilled").length, 1);
      const receipt = getOwnerQuestionReceipt(t.runtime.store, session.id, answers[0].status === "fulfilled" ? "answer" : "other", "owner_question_answer")!;
      assert.ok(receipt.taskId);
      await waitFor("回答续接完成", () => t.runtime.store.getTask(receipt.taskId!)!.status === "completed");
      const continued = t.runtime.store.getTask(receipt.taskId!)!;
      assert.equal(continued.accessMode, "auto-review"); assert.equal(continued.planMode, true);
      assert.equal(continued.parentTaskId, null); assert.equal(continued.sourcePermissionVersion, null);
      assert.match(continued.input, /选择发布范围？/); assert.match(continued.input, /实际自由回答/);
      assert.deepEqual(getOwnerQuestion(t.runtime.store, question.id)!.answers, params.answers);
      const calls = t.runtime.listSelectionRecords({ taskId: continued.id });
      const snapshot = t.runtime.readPromptSnapshot({ recordId: calls[0].id, sessionId: session.id });
      const snapshotText = Buffer.from(snapshot.data, "base64").toString("utf8");
      assert.match(snapshotText, /选择发布范围？/); assert.match(snapshotText, /实际自由回答/);
      const state = new ViewState();
      state.applySnapshot(await t.client.handshake(), false);
      assert.equal(state.ownerQuestions.find(item => item.id === question.id)!.status, "answered");
      assert.equal(t.runtime.store.listTasksBySession(session.id).filter(item => item.id !== task.id && item.id !== chat.id).length, 1);
    } finally { other.close(); }
  } finally { await t.shutdown(); }
});

test("完整答案、旧版本、同键异参及事务故障均不能留下半个消费；回答不批准操作", async () => {
  const { t, session, question, params } = await startQuestions();
  try {
    await assert.rejects(t.client.request("owner_question_answer", { ...params, answers: [{ text: "共享", option: 1 }] }), { code: "invalid_params" });
    await assert.rejects(t.client.request("owner_question_answer", { ...params, question_version: question.version + 1 }), { code: "question_version" });
    await assert.rejects(t.client.request("owner_question_answer", { ...params, answers: [{ text: "本地", option: 1 }, { text: "备注" }] }), { code: "invalid_params" });
    t.runtime.store.db.exec("CREATE TRIGGER answer_fault BEFORE INSERT ON owner_question_receipts BEGIN SELECT RAISE(ABORT, 'receipt_fault'); END");
    await assert.rejects(t.client.request("owner_question_answer", { ...params, request_id: "rollback" }));
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, "pending");
    assert.equal(t.runtime.findTaskByRequest({ sessionId: session.id, requestId: "rollback" }).task, null);
    assert.equal(getOwnerQuestionReceipt(t.runtime.store, session.id, "rollback", "owner_question_answer"), null);
    t.runtime.store.db.exec("DROP TRIGGER answer_fault");
    const accepted = await t.client.request<OpResult<"owner_question_answer">>("owner_question_answer", params);
    assert.equal((await t.client.request<OpResult<"owner_question_answer">>("owner_question_answer", params)).id, accepted.id);
    await assert.rejects(t.client.request("owner_question_answer", { ...params, answers: [{ text: "本地", option: 0 }, { text: "不同答案" }] }), { code: "request_conflict" });
    assert.equal(t.runtime.store.listConfirmationsByStatus("approved").length, 0);
    const raw = await t.client.request<{ task: unknown }>("find_task", { session_id: session.id, request_id: "answer" });
    assert.ok(raw.task);
  } finally { await t.shutdown(); }
});

test("多选与跳题经真实控制面丢答重启后仍按原键唯一续接", async () => {
  const items: OwnerQuestionItem[] = [
    { question: "选择检查", options: [{ label: "静态", description: "检查类型", recommended: true }, { label: "测试", description: "验证行为" }, "构建"], multiple: true },
    { question: "可跳过的备注" },
    { question: "其他要求" },
  ];
  const { t, session, question, params } = await startQuestions(items);
  const answers = [{ text: "静态\n构建", options: [0, 2] }, { text: "" }, { text: "保留自由输入" }];
  const values: OpParams<"owner_question_answer"> = { ...params, answers };
  const pending = new PendingRequestStore(path.join(t.dirs.root, "pending-multiple"));
  let restarted: Runtime | null = null;
  try {
    assert.deepEqual(question.questions, items);
    const schemas = JSON.stringify(t.server.calls[0].tools);
    for (const field of ["description", "recommended", "multiple"]) assert.ok(schemas.includes(`"${field}"`));
    t.runtime.store.withTx(() => t.runtime.store.setSessionQueueState(session.id, "paused", "test"));
    const request: ControlConnection["request"] = async (op, input) => {
      const result = await t.client.request<OpResult<typeof op>>(op, input);
      if (op === "owner_question_answer") throw new ControlClientError("request_timeout", "应答丢失", "unknown");
      return result;
    };
    const outcome = await new SubmissionGuard(pending, { instanceId: t.runtime.store.db.getInstanceId(), request }).submit("owner_question_answer", values, { requestId: values.request_id });
    assert.equal(outcome.kind, "pending_verification");
    const saved = pending.list();
    assert.deepEqual(saved.corrupt, []); assert.equal(saved.records.length, 1);
    assert.deepEqual(saved.records[0].params.answers, answers);
    const receipt = getOwnerQuestionReceipt(t.runtime.store, session.id, values.request_id)!;
    assert.deepEqual(receipt.question.answers, answers);
    const continued = t.runtime.store.getTask(receipt.taskId!)!;
    assert.equal(continued.status, "queued");
    assert.ok(continued.input.includes("（多选）")); assert.ok(continued.input.includes('"recommended":true'));
    assert.ok(continued.input.includes("静态\n构建")); assert.ok(continued.input.includes("可跳过的备注\n回答：\n\n3."));
    const config = { product: product.runtime, dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir, socketPath: t.runtime.socketPath(),
      modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off" as const, ...realTools() };
    await t.runtime.stop("restart_multiple_answers");
    restarted = await Runtime.start(config); await ControlServer.start(restarted);
    const client = await connectAuthedClient(restarted);
    try {
      const requestAfterRestart: ControlConnection["request"] = (op, input) => client.request<OpResult<typeof op>>(op, input);
      const connection = { instanceId: restarted.store.db.getInstanceId(), request: requestAfterRestart };
      const restored = await new SubmissionGuard(pending, connection).reconcile(saved.records[0]);
      assert.equal(restored.kind, "linked"); assert.deepEqual(pending.list(), { records: [], corrupt: [] });
      assert.deepEqual(getOwnerQuestion(restarted.store, question.id)!.questions, items);
      assert.deepEqual(getOwnerQuestion(restarted.store, question.id)!.answers, answers);
      assert.equal(restarted.store.listTasksBySession(session.id).filter(task => task.requestId === values.request_id).length, 1);
      await assert.rejects(client.request("owner_question_answer", { ...values, answers: [{ text: "静态", options: [0] }, ...answers.slice(1)] }), { code: "request_conflict" });
      await restarted.resumeQueue(session.id);
      await waitFor("多选跳题原续接完成", () => restarted!.store.getTask(continued.id)!.status === "completed");
      const state = new ViewState(); state.applySnapshot(await client.handshake(), false);
      assert.deepEqual(state.ownerQuestions.find(item => item.id === question.id)!.answers, answers);
      assert.equal(restarted.store.listTasksBySession(session.id).filter(task => task.requestId === values.request_id).length, 1);
    } finally { client.close(); }
  } finally { if (restarted) await restarted.stop("end_multiple_answers"); await t.shutdown(); }
});

test("控制面取消正在提问的原任务使问题失效，不接纳答案或续接", async () => {
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const t = await startTestRuntime("question-source-cancel", async (_request, index) => {
    if (index === 0) return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: "交付到哪里？" }] } }] };
    await hold;
    return { kind: "text", text: "等待拥有者回答" };
  }, { config: { ...realTools(), product: product.runtime } });
  try {
    const session = await t.runtime.createSession({ projectName: "cancel-question", cwd: t.work[0], mode: "full_access" });
    const task = await t.client.request<OpResult<"submit">>("submit", { session_id: session.id, request_id: "ask", input: "ASK", model_selection: t.runtime.defaultSelection });
    await waitFor("问题已登记且原任务仍在调用模型", () => t.server.calls.length === 2 && t.runtime.listOwnerQuestions(session.id).questions.length === 1);
    assert.equal(t.runtime.store.getTask(task.id)!.status, "running");
    await t.client.request("cancel", { task_id: task.id });
    const question = t.runtime.listOwnerQuestions(session.id).questions[0];
    assert.equal(question.status, "stale");
    await assert.rejects(t.client.request("owner_question_answer", { session_id: session.id, question_id: question.id, question_version: question.version,
      request_id: "answer-canceled", answers: [{ text: "本地" }], model_selection: t.runtime.defaultSelection }), { code: "question_not_pending" });
    assert.equal(getOwnerQuestionReceipt(t.runtime.store, session.id, "answer-canceled", "owner_question_answer"), null);
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 1);
    assert.equal(question.continuationTaskId, undefined);
  } finally { release(); await t.shutdown(); }
});

for (const first of ["answer", "cancel"] as const) test(`回答/取消 ${first} 先提交时终态唯一，丢答按原键核实`, async () => {
  const { t, session, question, params } = await startQuestions();
  try {
    const store = new PendingRequestStore(path.join(t.dirs.root, "pending"));
    let loseReply = true;
    const request: ControlConnection["request"] = async (op, values) => {
      const result = await t.client.request<OpResult<typeof op>>(op, values);
      if (loseReply && (op === "owner_question_answer" || op === "owner_question_cancel")) {
        loseReply = false;
        throw new ControlClientError("request_timeout", "应答丢失", "unknown");
      }
      return result;
    };
    const connection = { instanceId: t.runtime.store.db.getInstanceId(), request };
    if (first === "answer") {
      const guard = new SubmissionGuard(store, connection);
      assert.equal((await guard.submit("owner_question_answer", params, { requestId: params.request_id })).kind, "pending_verification");
      await assert.rejects(t.client.request("owner_question_cancel", { session_id: session.id, question_id: question.id, question_version: question.version, request_id: "cancel" }), { code: "question_version" });
      const outcome = await guard.reconcile(store.list().records[0]);
      assert.equal(outcome.kind, "linked");
    } else {
      const guard = new OwnerQuestionCancelGuard(store, connection);
      assert.equal((await guard.cancel({ session_id: session.id, question_id: question.id, question_version: question.version, request_id: "cancel" })).kind, "pending_verification");
      await assert.rejects(t.client.request("owner_question_answer", params), { code: "question_version" });
      const outcome = await guard.reconcile(store.list().records[0]);
      assert.equal(outcome.kind, "linked");
      assert.equal(t.runtime.findTaskByRequest({ sessionId: session.id, requestId: "answer" }).task, null);
    }
    assert.equal(store.list().records.length, 0);
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, first === "answer" ? "answered" : "canceled");
  } finally { await t.shutdown(); }
});

test("后台重启保留待答与已接纳回答，原键一次入队，恢复不新建续接", async () => {
  const { t, session, question, params } = await startQuestions();
  let restarted: Runtime | null = null;
  try {
    const socketPath = t.runtime.socketPath();
    await t.runtime.stop("restart_questions");
    const config = { product: product.runtime, dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir, socketPath,
      modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off" as const, ...realTools() };
    restarted = await Runtime.start(config); await ControlServer.start(restarted);
    assert.equal(getOwnerQuestion(restarted.store, question.id)!.status, "pending");
    restarted.store.withTx(() => restarted!.store.setSessionQueueState(session.id, "paused", "test"));
    const accepted = await restarted.answerOwnerQuestion({ sessionId: session.id, questionId: question.id, version: question.version,
      requestId: "answer", answers: params.answers, modelSelection: restarted.defaultSelection });
    await restarted.stop("restart_answer");
    restarted = await Runtime.start(config); await ControlServer.start(restarted);
    assert.equal(getOwnerQuestion(restarted.store, question.id)!.continuationTaskId, accepted.id);
    assert.equal(restarted.store.listTasksBySession(session.id).filter(task => task.requestId === "answer").length, 1);
    await restarted.resumeQueue(session.id);
    await waitFor("原续接完成", () => restarted!.store.getTask(accepted.id)!.status === "completed");
    assert.equal(restarted.store.listTasksBySession(session.id).filter(task => task.requestId === "answer").length, 1);
  } finally { if (restarted) await restarted.stop("end"); await t.shutdown(); }
});

test("旧专属回执不能把同键异参的回答或取消误认成成功", async () => {
  for (const operation of ["owner_question_answer", "owner_question_cancel"] as const) {
    const { t, session, question, params } = await startQuestions();
    try {
      const store = new PendingRequestStore(path.join(t.dirs.root, "pending"));
      const request: ControlConnection["request"] = (op, values) => t.client.request<OpResult<typeof op>>(op, values);
      const connection = { instanceId: t.runtime.store.db.getInstanceId(), request };
      if (operation === "owner_question_answer") {
        const guard = new SubmissionGuard(store, connection);
        assert.equal((await guard.submit(operation, params, { requestId: "same_key" })).kind, "accepted");
        const conflicting = { ...params, answers: [{ text: "本地", option: 0 }, { text: "异参答案" }] };
        assert.equal((await guard.submit(operation, conflicting, { requestId: "same_key" })).kind, "conflict");
        assert.equal((await guard.reconcile(store.list().records[0])).kind, "kept");
        assert.deepEqual(store.list().records[0].params.answers, conflicting.answers);
      } else {
        const guard = new OwnerQuestionCancelGuard(store, connection);
        const original = { session_id: session.id, question_id: question.id, question_version: question.version, request_id: "same_key" };
        assert.equal((await guard.cancel(original)).kind, "accepted");
        assert.equal((await guard.cancel({ ...original, question_version: question.version + 1 })).kind, "conflict");
        assert.equal((await guard.reconcile(store.list().records[0])).kind, "kept");
        assert.equal(store.list().records[0].params.question_version, question.version + 1);
      }
      assert.equal(store.list().records.length, 1);
    } finally { await t.shutdown(); }
  }
});

test("最长说明及需JSON转义的题目答案按256KiB分页，快照保留128KiB预览", async () => {
  const { t, session, question } = await startQuestions();
  try {
    const original = getOwnerQuestion(t.runtime.store, question.id)!;
    const questions = Array.from({ length: 3 }, () => ({ question: "\u0000".repeat(2000), options: Array.from({ length: 5 }, (_, i) => ({ label: String(i) + "\u0000".repeat(199), description: "\u0001".repeat(500), recommended: true })) }));
    const answers = Array.from({ length: 3 }, () => ({ text: "\u0002".repeat(4096) }));
    const since = t.runtime.store.getMaxSeq();
    t.runtime.store.withTx(() => {
      for (let i = 0; i < 20; i++) {
        const item = { ...original, id: `long_${i}`, hostOpId: `long_op_${i}`, status: "answered" as const, version: 2,
          questions, answers, continuationTaskId: original.taskId, answerSource: { kind: "coding-owner" as const, sessionId: session.id,
            accessMode: "full_access" as const, planMode: false, permissionVersion: 1, grantedPaths: [], modelSelection: t.runtime.defaultSelection } };
        t.runtime.store.recordToolIntent({ id: item.hostOpId, taskId: original.taskId, sessionId: session.id, toolName: "ask_user", params: { questions } });
        t.runtime.store.db.prepare("INSERT INTO owner_questions (id,session_id,task_id,host_op_id,status,payload) VALUES (?,?,?,?,?,?)")
          .run(item.id, session.id, original.taskId, item.hostOpId, item.status, JSON.stringify(item));
        t.runtime.store.appendEvent({ type: "owner_question.changed", question: ownerQuestionToView(item) }, { sessionId: session.id, taskId: original.taskId });
      }
    });
    await assert.rejects(t.client.handshake(since), { code: "cursor_too_old" });
    const snapshot = await t.client.handshake();
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.snapshot.ownerQuestions)) <= 128 * 1024);
    const loaded = [];
    let offset = 0;
    for (;;) {
      const page = await t.client.request<OpResult<"owner_questions">>("owner_questions", { session_id: session.id, offset, limit: 20 });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
      assert.ok(page.questions.length > 0);
      loaded.push(...page.questions);
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    }
    assert.equal(loaded.length, 21);
    assert.ok(Buffer.byteLength(JSON.stringify(loaded[1])) > 128 * 1024);
    assert.deepEqual(loaded[1].questions, questions);
    assert.deepEqual(loaded[1].answers, answers);
  } finally { await t.shutdown(); }
});
