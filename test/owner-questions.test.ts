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
import type { Responder } from "./helpers/mock-provider.ts";
import { afterTool, connectAuthedClient, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const defaultQuestions: OwnerQuestionItem[] = [{ question: "选择发布范围？", options: ["本地", "共享"] }, { question: "备注？" }];
async function startQuestions(items: OwnerQuestionItem[] = defaultQuestions, responder?: Responder) {
  const t = await startTestRuntime("owner-questions", responder ?? (req => lastUserText(req) === "ASK" && !afterTool(req)
    ? { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: items } },
      { id: "after-ask", name: "write", arguments: { path: "forbidden.txt", content: "Must read the answer before deciding" } }] }
    : { kind: "text", text: "已记录" }), { config: { ...realTools(), product: product.runtime } });
  const session = await t.runtime.createSession({ projectName: "questions", cwd: t.work[0], mode: "full_access" });
  const task = await t.client.request<OpResult<"submit">>("submit", { session_id: session.id, request_id: "ask", input: "ASK", model_selection: t.runtime.defaultSelection });
  await waitFor("original Task waiting for its question", () => t.runtime.listOwnerQuestions(session.id).questions.some(question => question.status === "pending"));
  const question = t.runtime.listOwnerQuestions(session.id).questions[0];
  const params: OpParams<"owner_question_answer"> = { session_id: session.id, question_id: question.id, question_version: question.version,
    request_id: "answer", answers: [{ text: "共享", option: 1 }, { text: "实际自由回答" }] };
  return { t, session, task, question, params };
}

async function completed(t: Awaited<ReturnType<typeof startQuestions>>["t"], taskId: string) {
  await waitFor("original Task completes", () => ["completed", "failed", "interrupted", "canceled"].includes(t.runtime.store.getTask(taskId)!.status));
  assert.equal(t.runtime.store.getTask(taskId)!.status, "completed", t.runtime.store.getTask(taskId)!.errorMessage ?? t.runtime.store.getTask(taskId)!.interruptReason ?? "Task did not complete");
}

test("SDK waits without another call; answers retain the original Task authority and block old-batch writes", async () => {
  const { t, session, task, question, params } = await startQuestions();
  try {
    assert.equal(t.runtime.store.getTask(task.id)!.status, "running");
    assert.equal(t.server.calls.length, 1);
    assert.ok(t.runtime.store.listAllOccupancy().some(item => item.taskId === task.id));
    assert.ok(toolNamesOf(t.server.calls[0]).includes("ask_user"));
    const schemas = (t.server.calls[0].tools ?? []).map(tool => (tool.function as { parameters: { required?: string[] } }).parameters);
    assert.ok(schemas.every(schema => Array.isArray(schema.required)));
    const version = t.runtime.getSession(session.id)!.defaultAccessModeVersion;
    await t.runtime.setSessionDefaultMode({ sessionId: session.id, mode: "plan", expectedVersion: version });
    const chat = await t.client.request<OpResult<"submit">>("submit", { session_id: session.id, request_id: "chat", input: "共享", model_selection: t.runtime.defaultSelection });
    assert.equal(t.runtime.store.getTask(chat.id)!.status, "queued");
    assert.equal(t.server.calls.length, 1);
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, "pending");
    const other = await connectAuthedClient(t.runtime);
    try {
      const answers = await Promise.allSettled([t.client.request("owner_question_answer", params), other.request("owner_question_answer", { ...params, request_id: "other" })]);
      assert.equal(answers.filter(answer => answer.status === "fulfilled").length, 1);
      const receipt = getOwnerQuestionReceipt(t.runtime.store, session.id, answers[0].status === "fulfilled" ? "answer" : "other", "owner_question_answer")!;
      assert.equal(receipt.taskId, task.id);
      await completed(t, task.id);
      const original = t.runtime.store.getTask(task.id)!;
      assert.equal(original.accessMode, "full_access"); assert.equal(original.planMode, false);
      assert.deepEqual(original.modelSelection, t.runtime.defaultSelection);
      assert.equal(original.input, "ASK");
      assert.equal(fs.existsSync(path.join(t.work[0], "forbidden.txt")), false);
      assert.equal(t.runtime.store.listToolOpsByTask(task.id).some(op => op.toolName === "write"), false);
      assert.ok(toolNamesOf(t.server.calls[1]).includes("write"));
      assert.ok(toolNamesOf(t.server.calls[1]).includes("ask_user"));
      assert.match(JSON.stringify(t.server.calls[1].messages), /实际自由回答/);
      assert.match(JSON.stringify(t.server.calls[1].messages), /本批调用未执行/);
      assert.equal(t.runtime.store.listTasksBySession(session.id).length, 2);
      assert.equal(t.runtime.findTaskByRequest({ sessionId: session.id, requestId: "answer" }).task, null);
      const state = new ViewState(); state.applySnapshot(await t.client.handshake(), false);
      assert.equal(state.ownerQuestions.find(item => item.id === question.id)!.status, "answered");
      assert.equal(state.ownerQuestions.find(item => item.id === question.id)!.continuationTaskId, undefined);
    } finally { other.close(); }
  } finally { await t.shutdown(); }
});

test("invalid answers and transaction failures leave the wait intact; identical keys return the original receipt", async () => {
  const { t, session, task, question, params } = await startQuestions();
  try {
    await assert.rejects(t.client.request("owner_question_answer", { ...params, answers: [{ text: "共享", option: 1 }] }), { code: "invalid_params" });
    await assert.rejects(t.client.request("owner_question_answer", { ...params, question_version: question.version + 1 }), { code: "question_version" });
    await assert.rejects(t.client.request("owner_question_answer", { ...params, answers: [{ text: "本地", option: 1 }, { text: "备注" }] }), { code: "invalid_params" });
    t.runtime.store.db.exec("CREATE TRIGGER answer_fault BEFORE INSERT ON owner_question_receipts BEGIN SELECT RAISE(ABORT, 'receipt_fault'); END");
    await assert.rejects(t.client.request("owner_question_answer", { ...params, request_id: "rollback" }));
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, "pending");
    assert.equal(getOwnerQuestionReceipt(t.runtime.store, session.id, "rollback", "owner_question_answer"), null);
    assert.equal(t.server.calls.length, 1);
    t.runtime.store.db.exec("DROP TRIGGER answer_fault");
    const accepted = await t.client.request<OpResult<"owner_question_answer">>("owner_question_answer", params);
    assert.deepEqual(await t.client.request<OpResult<"owner_question_answer">>("owner_question_answer", params), accepted);
    assert.equal(accepted.taskId, task.id);
    const verification = { session_id: params.session_id, request_id: params.request_id, operation: "owner_question_answer" as const, question_id: params.question_id, question_version: params.question_version, answers: params.answers };
    assert.deepEqual((await t.client.request<OpResult<"owner_question_receipt">>("owner_question_receipt", verification)).receipt, accepted);
    await assert.rejects(t.client.request("owner_question_receipt", { ...verification, answers: [{ text: "本地", option: 0 }, { text: "different" }] }), { code: "request_conflict" });
    await assert.rejects(t.client.request("owner_question_receipt", { ...verification, question_version: undefined }), { code: "invalid_params" });
    await assert.rejects(t.client.request("owner_question_answer", { ...params, answers: [{ text: "本地", option: 0 }, { text: "不同答案" }] }), { code: "request_conflict" });
    assert.equal(t.runtime.store.listConfirmationsByStatus("approved").length, 0);
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 1);
    await completed(t, task.id);
  } finally { await t.shutdown(); }
});

test("the same Task can ask a second batch after reading the first actual tool result", async () => {
  const secondItems = [{ question: "Second question" }];
  const { t, session, task, question, params } = await startQuestions(defaultQuestions, (_req, index) => index < 2
    ? { kind: "tool_calls", calls: [{ id: `ask-${index}`, name: "ask_user", arguments: { questions: index === 0 ? defaultQuestions : secondItems } }] }
    : { kind: "text", text: "both answered" });
  try {
    await t.client.request("owner_question_answer", params);
    await waitFor("second batch in original Task", () => t.runtime.listOwnerQuestions(session.id).questions.some(item => item.id !== question.id && item.status === "pending"));
    const second = t.runtime.listOwnerQuestions(session.id).questions.find(item => item.id !== question.id && item.status === "pending")!;
    assert.equal(second.taskId, task.id); assert.notEqual(second.hostOpId, question.hostOpId);
    await t.client.request("owner_question_answer", { session_id: session.id, question_id: second.id, question_version: second.version,
      request_id: "second-answer", answers: [{ text: "SECOND" }] });
    await completed(t, task.id);
    assert.equal(t.server.calls.length, 3);
    assert.match(JSON.stringify(t.server.calls[2].messages), /实际自由回答/);
    assert.match(JSON.stringify(t.server.calls[2].messages), /SECOND/);
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 1);
    assert.equal(t.runtime.store.getTask(task.id)!.input, "ASK");
  } finally { await t.shutdown(); }
});

test("explicit guidance atomically cancels a question and the next request contains both facts", async () => {
  const { t, session, task, question } = await startQuestions();
  try {
    const guidance = await t.runtime.submit({ sessionId: session.id, requestId: "guidance", input: "GUIDANCE_CANCEL", guidance: true, modelSelection: t.runtime.defaultSelection });
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, "canceled");
    await completed(t, task.id);
    assert.equal(t.runtime.store.getTask(guidance.id)!.status, "canceled");
    assert.match(JSON.stringify(t.server.calls[1].messages), /canceled/);
    assert.match(JSON.stringify(t.server.calls[1].messages), /GUIDANCE_CANCEL/);
    assert.equal(t.server.calls.length, 2);
    assert.equal(fs.existsSync(path.join(t.work[0], "forbidden.txt")), false);
  } finally { await t.shutdown(); }
});

for (const first of ["answer", "cancel"] as const) test(`${first} wins answer/cancel arbitration; lost responses verify the original receipt`, async () => {
  const { t, session, task, question, params } = await startQuestions();
  try {
    const pending = new PendingRequestStore(path.join(t.dirs.root, "pending"));
    let loseReply = true;
    const request: ControlConnection["request"] = async (op, values) => {
      const result = await t.client.request<OpResult<typeof op>>(op, values);
      if (loseReply && (op === "owner_question_answer" || op === "owner_question_cancel")) {
        loseReply = false;
        throw new ControlClientError("request_timeout", "response lost", "unknown");
      }
      return result;
    };
    const connection = { instanceId: t.runtime.store.db.getInstanceId(), request };
    if (first === "answer") {
      const guard = new SubmissionGuard(pending, connection);
      assert.equal((await guard.submit("owner_question_answer", params, { requestId: params.request_id })).kind, "pending_verification");
      await assert.rejects(t.client.request("owner_question_cancel", { session_id: session.id, question_id: question.id, question_version: question.version, request_id: "cancel" }), { code: "question_version" });
      const outcome = await guard.reconcile(pending.list().records[0]);
      assert.equal(outcome.kind, "linked");
      if (outcome.kind === "linked") assert.equal(outcome.taskId, task.id);
    } else {
      const guard = new OwnerQuestionCancelGuard(pending, connection);
      assert.equal((await guard.cancel({ session_id: session.id, question_id: question.id, question_version: question.version, request_id: "cancel" })).kind, "pending_verification");
      await assert.rejects(t.client.request("owner_question_answer", params), { code: "question_version" });
      assert.equal((await guard.reconcile(pending.list().records[0])).kind, "linked");
    }
    await completed(t, task.id);
    assert.equal(pending.list().records.length, 0);
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, first === "answer" ? "answered" : "canceled");
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 1);
  } finally { await t.shutdown(); }
});

test("client disconnection leaves the backend waiting and reconnect sees the same pending question", async () => {
  const { t, session, task, question, params } = await startQuestions();
  try {
    t.client.close();
    const other = await connectAuthedClient(t.runtime);
    try {
      const snapshot = await other.handshake();
      assert.equal((snapshot.snapshot.ownerQuestions ?? []).find(item => item.id === question.id)?.status, "pending");
      assert.equal(t.runtime.store.getTask(task.id)!.status, "running");
      assert.equal(t.server.calls.length, 1);
      await other.request("owner_question_answer", params);
      await completed(t, task.id);
    } finally { other.close(); }
  } finally { await t.shutdown(); }
});

for (const stop of ["interrupt", "cancel"] as const) test(`${stop} aborts the original tool wait and makes unanswered cards stale`, async () => {
  const { t, session, task, question, params } = await startQuestions();
  try {
    await t.client.request(stop, { task_id: task.id });
    assert.equal(t.runtime.store.getTask(task.id)!.status, stop === "interrupt" ? "interrupted" : "canceled");
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, "stale");
    assert.equal(t.server.calls.length, 1);
    await assert.rejects(t.client.request("owner_question_answer", { ...params, question_version: getOwnerQuestion(t.runtime.store, question.id)!.version }), { code: "question_not_pending" });
    assert.equal(getOwnerQuestionReceipt(t.runtime.store, session.id, "answer"), null);
    assert.equal(t.runtime.store.listTasksBySession(session.id).length, 1);
    if (stop === "interrupt") assert.equal(t.runtime.store.getSession(session.id)!.queuePauseReason, "owner_pause");
  } finally { await t.shutdown(); }
});

test("an accepted answer racing pause keeps its receipt without issuing another model request", async () => {
  const { t, session, task, question, params } = await startQuestions();
  try {
    const accepted = t.runtime.answerOwnerQuestion({ sessionId: session.id, questionId: question.id, version: question.version,
      requestId: "race-answer", answers: params.answers });
    const stopping = t.runtime.interruptTask(task.id);
    const receipt = await accepted;
    await stopping;
    assert.equal(receipt.taskId, task.id);
    assert.equal(getOwnerQuestion(t.runtime.store, question.id)!.status, "answered");
    assert.equal(t.server.calls.length, 1);
    assert.equal(t.runtime.store.getTask(task.id)!.status, "interrupted");
    assert.equal(getOwnerQuestionReceipt(t.runtime.store, session.id, "race-answer")!.taskId, task.id);
  } finally { await t.shutdown(); }
});

test("backend restart invalidates waiting questions and never resumes the old Task", async () => {
  const { t, session, task, question, params } = await startQuestions();
  let restarted: Runtime | null = null;
  try {
    const config = { product: product.runtime, dataDir: t.dirs.dataDir, agentDir: t.dirs.agentDir, socketPath: t.runtime.socketPath(),
      modelProvider: "mock", modelId: "mock-model", thinkingLevel: "off" as const, ...realTools() };
    await t.runtime.stop("restart_questions");
    restarted = await Runtime.start(config); await ControlServer.start(restarted);
    assert.equal(getOwnerQuestion(restarted.store, question.id)!.status, "stale");
    assert.equal(restarted.store.getTask(task.id)!.status, "interrupted");
    await assert.rejects(restarted.answerOwnerQuestion({ sessionId: session.id, questionId: question.id,
      version: getOwnerQuestion(restarted.store, question.id)!.version, requestId: "after-restart", answers: params.answers }), { code: "question_not_pending" });
    assert.equal(restarted.store.listTasksBySession(session.id).length, 1);
    assert.equal(t.server.calls.length, 1);
  } finally { if (restarted) await restarted.stop("end_restart"); await t.shutdown(); }
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
