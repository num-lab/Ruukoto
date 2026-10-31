import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { Db, SCHEMA_VERSION } from "@ruukoto/core/db.ts";
import { findMessageRecall, recallCandidate } from "@ruukoto/core/message-recall.ts";
import { cancelOwnerQuestion, consumeOwnerQuestion, createOwnerQuestion, getOwnerQuestion, getOwnerQuestionReceipt } from "@ruukoto/core/owner-questions.ts";
import { Store } from "@ruukoto/core/store.ts";
import type { Task } from "@ruukoto/core/types.ts";
import { MessageRecallRuntime } from "@ruukoto/runtime/message-recall.ts";
import { OwnerAttachments } from "@ruukoto/runtime/owner-attachments.ts";

function recallRuntime(root: string, store: Store) {
  const artifacts = new ArtifactStore(root, store), attachments = new OwnerAttachments(root, store, artifacts);
  const recall = new MessageRecallRuntime({ store, sessionsDir: root, driverFor: () => undefined,
    ensureDriver: async () => { throw new Error("Queue retrieval must not create a Driver"); }, disposeDriver: async () => {},
    hostExecutions: () => null, workflows: () => null, subagents: () => null, backgroundProcesses: { requestStop: () => {} },
    agentWait: { interrupt: () => false }, attachments, artifacts, kick: () => {} });
  return { artifacts, attachments, recall };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-input-store-"));
  const db = new Db(root), store = new Store(db), stat = fs.statSync(root);
  const project = store.withTx(() => store.createProject("input"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "input", confirmTools: [] }));
  const { artifacts, attachments, recall } = recallRuntime(root, store);
  let sequence = 0;
  const queued = () => store.withTx(() => store.insertQueuedTask({ sessionId: session.id, requestId: `input-${++sequence}`, input: `body-${sequence}`, modelSelection: null, submissionDigest: String(sequence) }).task);
  const running = () => {
    const task = queued();
    store.withTx(() => store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() }));
    return store.getTask(task.id)!;
  };
  const ask = (task: Task, suffix = "ask") => store.withTx(() => {
    const hostOpId = `${task.id}-${suffix}`, questions = [{ question: "Where?", options: ["Here", "There"] }];
    store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: session.id, toolName: "ask_user", params: { questions } });
    return createOwnerQuestion(store, { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId, questions });
  });
  return { root, db, store, session, project, artifacts, attachments, recall, queued, running, ask,
    cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const state of ["active", "paused"] as const) for (const index of [0, 1, 2]) test(`queued retrieval preserves ${state} dispatch and order at index ${index}`, async () => {
  const f = fixture();
  try {
    const current = f.running(), tasks = [f.queued(), f.queued(), f.queued()], target = tasks[index];
    const bytes = Buffer.from("original attachment\n"), attachmentId = `att_${randomUUID()}` as const;
    f.attachments.put({ attachment_id: attachmentId, session_id: f.session.id, name: "original.txt", offset: 0, total_bytes: bytes.length, content_hash: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") });
    const metadata = { id: attachmentId, name: "original.txt", size: bytes.length };
    f.store.withTx(() => f.attachments.bind(target.id, f.session.id, f.attachments.prepare(f.session.id, [metadata])));
    f.store.withTx(() => f.store.setSessionQueueState(f.session.id, state, state === "paused" ? "owner_pause" : null));
    const before = f.store.getTaskQueue(f.session.id), pause = f.store.getSession(f.session.id)!;
    const params = { sessionId: f.session.id, taskId: target.id, expectedRevision: before.revision, requestId: "retrieve", purpose: "queued" as const };
    const result = await f.recall.recallMessage(params);
    assert.equal(result.phase, "completed"); assert.equal(result.purpose, "queued");
    assert.deepEqual(f.store.getTaskQueue(f.session.id).tasks, before.tasks.filter(item => item.taskId !== target.id));
    assert.equal(f.store.getTaskQueue(f.session.id).revision, before.revision + 1);
    assert.equal(f.store.getSession(f.session.id)!.queueState, pause.queueState);
    assert.equal(f.store.getSession(f.session.id)!.queuePauseReason, pause.queuePauseReason);
    assert.equal(f.store.getTask(current.id)!.status, "running");
    assert.equal(f.store.getTask(target.id)!.status, "canceled");
    assert.equal(f.store.listTasksBySession(f.session.id).length, 4);
    const draft = f.recall.messageRecallState({ sessionId: f.session.id, requestId: params.requestId }).edit!;
    assert.equal(draft.input, target.input); assert.equal(draft.attachments.length, 1);
    assert.notEqual(draft.attachments[0].id, attachmentId);
    assert.deepEqual(f.attachments.prepare(f.session.id, draft.attachments)[0].bytes, bytes);
    assert.deepEqual(f.artifacts.read(attachmentId, 0, bytes.length), bytes);
    assert.equal(f.recall.messageRecallState({ sessionId: f.session.id }).edit!.input, "");
    assert.deepEqual(f.recall.messageRecallState({ sessionId: f.session.id, requestId: params.requestId }).edit, draft);
    assert.equal((await f.recall.recallMessage(params)).id, result.id, "same key verifies after queue revision changes");
    await assert.rejects(f.recall.recallMessage({ ...params, purpose: "historical" }), { code: "request_conflict" });
    await f.recall.recoverAll();
    assert.equal(findMessageRecall(f.store, f.session.id, params.requestId)!.phase, "completed", "queue-only recovery needs no history file or marker");
    assert.equal(f.store.getSession(f.session.id)!.queueState, pause.queueState);
    assert.equal(fs.readdirSync(f.root).some(name => name.endsWith(".jsonl")), false);
  } finally { f.cleanup(); }
});

test("queued retrieval rejects revision, dequeue, guidance and actual-history races without historical escalation", async () => {
  const f = fixture();
  try {
    const current = f.running(), first = f.queued();
    const params = { sessionId: f.session.id, taskId: first.id, expectedRevision: f.store.getTaskQueue(f.session.id).revision, requestId: "stale", purpose: "queued" as const };
    f.queued();
    assert.equal((await f.recall.recallMessage(params)).error!.code, "queue_conflict");
    f.store.withTx(() => f.store.transitionTask(first.id, ["queued"], "running", { startedAt: new Date().toISOString() }));
    assert.equal((await f.recall.recallMessage({ ...params, requestId: "started", expectedRevision: f.store.getTaskQueue(f.session.id).revision })).error!.code, "already_started");
    const guidance = f.queued();
    f.store.withTx(() => f.store.acceptTaskGuidance(guidance.id, current.id, true));
    assert.equal((await f.recall.recallMessage({ ...params, taskId: guidance.id, requestId: "guidance", expectedRevision: f.store.getTaskQueue(f.session.id).revision })).error!.code, "guidance_pending");
    const admitted = f.queued(), history = path.join(f.root, "history.jsonl");
    fs.writeFileSync(history, JSON.stringify({ id: "actual-input", type: "message", message: { role: "user", ruukotoTaskId: admitted.id, content: [] } }) + "\n");
    f.store.withTx(() => f.store.setSessionFile(f.session.id, history));
    const original = fs.readFileSync(history);
    assert.equal((await f.recall.recallMessage({ ...params, taskId: admitted.id, requestId: "admitted", expectedRevision: f.store.getTaskQueue(f.session.id).revision })).error!.code, "already_started");
    assert.deepEqual(fs.readFileSync(history), original);
    assert.equal(f.store.getSession(f.session.id)!.queueState, "active");
    assert.equal(f.store.getTask(current.id)!.status, "running");
    assert.equal(f.store.getTask(admitted.id)!.status, "queued");
    await assert.rejects(f.recall.recallMessage({ ...params, taskId: "missing", requestId: "missing" }), { code: "not_found" });
  } finally { f.cleanup(); }
});

test("same-Task answers and Skip block historical recall, survive later-input recall and do not block arbitrary queue retrieval", async () => {
  for (const text of ["Here", ""]) {
    const f = fixture();
    try {
      const task = f.running(), earlier = f.queued(), question = f.ask(task), count = f.store.listTasksBySession(f.session.id).length;
      const receipt = f.store.withTx(() => consumeOwnerQuestion(f.store, { questionId: question.id, sessionId: f.session.id, version: question.version, requestKey: "answer", requestDigest: "answer", answers: [{ text }] }));
      assert.equal(receipt.taskId, task.id); assert.equal(receipt.question.hostOpId, question.hostOpId);
      assert.equal(receipt.question.continuationTaskId, undefined);
      assert.equal(f.store.listTasksBySession(f.session.id).length, count);
      assert.deepEqual(f.store.getTaskQueue(f.session.id).tasks.map(item => item.taskId), [earlier.id]);
      const answer = recallCandidate(f.store, f.session.id)!;
      assert.equal(answer.kind, "answer"); assert.equal(answer.task.id, task.id);
      assert.equal(answer.inputSeq, f.store.getMaxSeq());
      assert.equal((await f.recall.recallMessage({ purpose: "historical", sessionId: f.session.id, taskId: task.id, expectedRevision: answer.inputSeq, requestId: "blocked-answer" })).error!.code, "unsupported_input");
      const later = f.queued(), candidate = recallCandidate(f.store, f.session.id)!;
      assert.equal(candidate.kind, "task"); assert.equal(candidate.task.id, later.id);
      await f.recall.recallMessage({ purpose: "historical", sessionId: f.session.id, taskId: later.id, expectedRevision: candidate.inputSeq, requestId: "later" });
      assert.equal(findMessageRecall(f.store, f.session.id, "later")!.phase, "completed");
      assert.equal(recallCandidate(f.store, f.session.id)!.kind, "answer");
      assert.equal((await f.recall.recallMessage({ purpose: "queued", sessionId: f.session.id, taskId: earlier.id, expectedRevision: f.store.getTaskQueue(f.session.id).revision, requestId: "earlier" })).phase, "completed");
      assert.equal(recallCandidate(f.store, f.session.id)!.kind, "answer");
      assert.equal(f.store.getTask(task.id)!.status, "running");
      const again = f.ask(task, "second");
      assert.equal(again.status, "pending", "same Task can ask another batch");
    } finally { f.cleanup(); }
  }
});

test("answer commit, receipt and event roll back together; committed receipts survive stopping and keys remain unique", () => {
  const f = fixture();
  try {
    const task = f.running(), question = f.ask(task);
    const params = { questionId: question.id, sessionId: f.session.id, version: question.version, requestKey: "answer", requestDigest: "answer", answers: [{ text: "Here" }] };
    const before = f.store.getMaxSeq();
    f.db.exec("CREATE TRIGGER fail_answer BEFORE INSERT ON owner_question_receipts BEGIN SELECT RAISE(ABORT, 'receipt_fault'); END");
    assert.throws(() => f.store.withTx(() => consumeOwnerQuestion(f.store, params)));
    assert.equal(getOwnerQuestion(f.store, question.id)!.status, "pending");
    assert.equal(f.store.getMaxSeq(), before); assert.equal(getOwnerQuestionReceipt(f.store, f.session.id, "answer"), null);
    f.db.exec("DROP TRIGGER fail_answer");
    const receipt = f.store.withTx(() => consumeOwnerQuestion(f.store, params));
    f.store.withTx(() => f.store.endTask(task.id, ["running"], "interrupted", { interruptReason: "owner_interrupt" }));
    assert.equal(getOwnerQuestion(f.store, question.id)!.status, "answered");
    assert.deepEqual(f.store.withTx(() => consumeOwnerQuestion(f.store, params)), receipt);
    assert.throws(() => f.store.withTx(() => consumeOwnerQuestion(f.store, { ...params, requestDigest: "different" })), { code: "request_conflict" });
    assert.throws(() => f.store.withTx(() => cancelOwnerQuestion(f.store, { questionId: question.id, sessionId: f.session.id, version: question.version })), { code: "question_version" });
    const record = getOwnerQuestion(f.store, question.id)!;
    f.db.prepare("UPDATE owner_questions SET payload = ? WHERE id = ?").run(JSON.stringify({ ...record, answerSeq: before }), record.id);
    assert.throws(() => getOwnerQuestion(f.store, question.id), { code: "question_corrupt" });
  } finally { f.cleanup(); }
});

for (const status of ["completed", "failed", "canceled", "interrupted"] as const) test(`every terminal Task transition invalidates an unanswered question: ${status}`, () => {
  const f = fixture();
  try {
    const task = f.running(), question = f.ask(task);
    f.store.withTx(() => f.store.transitionTask(task.id, ["running"], status));
    assert.equal(getOwnerQuestion(f.store, question.id)!.status, "stale");
    assert.throws(() => f.store.withTx(() => consumeOwnerQuestion(f.store, { questionId: question.id, sessionId: f.session.id, version: question.version + 1, requestKey: "late", requestDigest: "late", answers: [{ text: "" }] })), { code: "question_not_pending" });
  } finally { f.cleanup(); }
});

test("user queue and queued events use trusted classification before report binding", () => {
  const f = fixture();
  try {
    const user = f.queued();
    const report = f.store.withTx(() => f.store.insertQueuedTask({ sessionId: f.session.id, requestId: "report", input: "report", submissionDigest: "report", modelSelection: null, inputPurpose: "internal_report" }).task);
    const internal = f.store.withTx(() => f.store.insertQueuedTask({ sessionId: f.session.id, requestId: "internal", input: "internal", submissionDigest: "internal", modelSelection: null, parentTaskId: user.id }).task);
    assert.deepEqual(f.store.getTaskQueue(f.session.id).tasks.map(item => item.taskId), [user.id]);
    assert.deepEqual(f.store.getTaskQueue(f.session.id).retrievableTaskIds, [user.id]);
    assert.deepEqual(f.store.listQueuedTasksFifo(f.session.id).map(item => item.id), [user.id, report.id, internal.id]);
    const queued = f.store.getEventsAfter(0).filter(event => event.body.type === "task.queued");
    assert.deepEqual(queued.map(event => event.body.type === "task.queued" ? event.body.inputPurpose : null), ["user", "internal_report", undefined]);
  } finally { f.cleanup(); }
});

for (const version of [57, 59]) test(`schema 58 rejects schema ${version} without mutation`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-input-version-"));
  try {
    assert.equal(SCHEMA_VERSION, 58);
    const file = path.join(root, "ruukoto.db"), db = new DatabaseSync(file);
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '${version}');`); db.close();
    const before = fs.readFileSync(file);
    assert.throws(() => new Db(root), { code: "schema_version_unsupported" });
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("queued retrieval reopens from its persistent receipt and blocks inconsistent cancellation facts", async () => {
  const f = fixture();
  let reopened: Db | undefined;
  try {
    const task = f.queued();
    const result = await f.recall.recallMessage({ sessionId: f.session.id, taskId: task.id, purpose: "queued", requestId: "persisted", expectedRevision: f.store.getTaskQueue(f.session.id).revision });
    f.db.close();
    reopened = new Db(f.root);
    const store = new Store(reopened), { recall } = recallRuntime(f.root, store);
    await recall.recoverAll();
    assert.equal(findMessageRecall(store, f.session.id, "persisted")!.phase, "completed");
    assert.equal(recall.messageRecallState({ sessionId: f.session.id, requestId: "persisted" }).edit!.input, task.input);
    assert.equal(store.getSession(f.session.id)!.queueState, "active");
    store.db.prepare("UPDATE tasks SET error_message = NULL WHERE id = ?").run(task.id);
    await recall.recoverAll();
    const corrupt = findMessageRecall(store, f.session.id, "persisted")!;
    assert.equal(corrupt.id, result.id); assert.equal(corrupt.phase, "blocked");
    assert.equal(corrupt.editOpen, false); assert.equal(corrupt.error!.code, "history_unverified");
    assert.equal(store.getSession(f.session.id)!.queueState, "paused");
  } finally {
    reopened?.close();
    if (!reopened) f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
