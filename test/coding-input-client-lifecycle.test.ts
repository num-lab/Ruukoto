import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Session, PublicMessageRecall } from "@ruukoto/core/types.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { SubmissionGuard } from "@ruukoto/control/submission.ts";
import type { OpParams } from "@ruukoto/control/ops.ts";
import { TaskQueuePanel } from "@ruukoto/tui/tui/task-queue.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { EventFlow } from "@ruukoto/view/event-flow.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import { CodeWrites } from "../apps/desktop/src/renderer/code-writes.ts";
import { ipcResult } from "../apps/desktop/src/main/ipc.ts";
import { FakeTransport, fakeSnapshot } from "./helpers/fake-control.ts";

const at = "2026-10-31T00:00:00.000Z";
const session: Session = { id: "session", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 1, defaultAccessMode: "confirm", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, queueRevision: 7, archivedAt: null, createdAt: at };
const taskIds = ["first", "middle", "last"];
function task(): TaskView {
  return { id: "middle", sessionId: session.id, requestId: "queued", input: "unstarted queued input", inputPurpose: "user", modelSelection: null, submissionDigest: null, status: "canceled", queueOrder: 2, accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: null, endedAt: at };
}
function receipt(params: OpParams<"message_recall">): PublicMessageRecall {
  return { id: `recall-${params.task_id}`, sessionId: params.session_id, requestId: params.request_id, purpose: params.purpose, paramsDigest: "digest", targetTaskId: params.task_id, inputSeq: 1, expectedRevision: params.expected_revision, execTaskId: null, phase: "completed", stopTaskIds: [], sealedTaskIds: [], omittedEntryIds: [], historyFingerprint: null, completionRevision: 1, nextCandidateTaskId: null, editOpen: true, savedQueueState: null, savedQueueReason: null, error: null, createdAt: at, updatedAt: at };
}

test("legacy continue and answer pending records remain verification-only in their original instance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "old-coding-input-"));
  try {
    const store = new PendingRequestStore(dir);
    const transport = new FakeTransport({ handlers: { find_task: () => ({ task: null }), owner_question_receipt: () => ({ receipt: null }) } });
    const guard = new SubmissionGuard(store, { instanceId: "original", request: transport.request.bind(transport) });
    for (const op of ["continue", "owner_question_answer"] as const) {
      const record: PendingRequest = { op, requestId: op, instanceId: "original", createdAt: at, params: { session_id: session.id, request_id: op, model_selection: { provider: "mock", modelId: "model", thinkingLevel: "off" }, ...(op === "continue" ? { task_id: "old", input: "original input" } : { question_id: "q", question_version: 1, answers: [{ text: "answer" }] }) } };
      store.save(record);
      assert.equal(store.read(record.requestId).kind, "record");
      assert.equal((await guard.reconcile(record)).kind, "kept");
      assert.equal(store.read(record.requestId).kind, "record");
      assert.equal((await new SubmissionGuard(store, { instanceId: "fresh", request: transport.request.bind(transport) }).reconcile(record)).kind, "foreign_instance");
    }
    assert.deepEqual(transport.requests.map(request => request.op), ["find_task", "owner_question_receipt"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pending input reconciliation stops when its backend instance changes during a query", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-instance-query-"));
  try {
    const store = new PendingRequestStore(dir);
    for (const op of ["continue", "owner_question_answer", "submit"] as const) {
      const record: PendingRequest = { op, requestId: op, instanceId: "original", createdAt: at, params: { request_id: op, ...(op === "continue" ? { task_id: "old" } : { session_id: session.id, ...(op === "owner_question_answer" ? { question_id: "q", question_version: 1, answers: [{ text: "answer" }] } : { input: "original input", model_selection: { provider: "mock", modelId: "model", thinkingLevel: "off" } }) }) } };
      store.save(record);
      const transport = new FakeTransport({ handlers: {
        get_task: () => { connection.instanceId = "replacement"; return { task: task(), seq: 0, toolOps: [], confirmations: [], artifacts: [], outputPreview: null }; },
        find_task: () => { connection.instanceId = "replacement"; return { task: null }; },
        owner_question_receipt: () => { connection.instanceId = "replacement"; return { receipt: { operation: "owner_question_answer", questionId: "q", sessionId: session.id, requestKey: op, digest: "digest", taskId: "source", question: { id: "q", sessionId: session.id, taskId: "source", hostOpId: "host-op", version: 2, status: "answered", questions: [{ question: "question" }], answers: [{ text: "answer" }], createdAt: at } } }; },
      } });
      const connection = { instanceId: "original", request: transport.request.bind(transport) };
      const result = await new SubmissionGuard(store, connection).reconcile(record);
      assert.equal(result.kind, "foreign_instance", op);
      assert.equal(store.read(record.requestId).kind, "record", "keep the original record for its backend");
      assert.equal(transport.requests.length, 1, "do not query or replay the old input on the replacement backend");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("queued retrieval saves the original key before sending and restores any item without changing pause or order", async context => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  context.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, configurable: true });
  for (const queueState of ["active", "paused"] as const) for (const taskId of taskIds) {
    let accepted: PublicMessageRecall | null = null;
    let draft = "";
    let reconnected = taskId !== "middle";
    const attachments = [{ id: `attachment-${taskId}`, name: "original.bin", size: 4 }];
    const queue = { revision: 7, tasks: taskIds.map((id, index) => ({ taskId: id, queueOrder: index + 1 })), retrievableTaskIds: [...taskIds] };
    const transport = new FakeTransport({ handlers: {
      task_queue: () => ({ queue, reorderableTaskIds: [...taskIds], steerableTaskIds: [], guidance: [] }),
      message_recall: params => {
        const persisted = [...storage.values()].map(value => JSON.parse(value) as { requestId: string; params: OpParams<"message_recall"> }).find(value => value.requestId === params.request_id);
        assert.deepEqual(persisted?.params, params, "the complete original parameters are durable before mutation");
        assert.equal(params.purpose, "queued"); assert.equal(params.expected_revision, 7); assert.equal(params.task_id, taskId);
        accepted = receipt(params); draft = `${taskId} original body`;
        queue.tasks = queue.tasks.filter(item => item.taskId !== taskId);
        queue.retrievableTaskIds = queue.retrievableTaskIds.filter(id => id !== taskId);
        throw new ControlClientError("timeout", "response lost", "unknown");
      },
      message_recall_state: () => { if (!reconnected) throw new ControlClientError("disconnected", "state unavailable", "disconnected"); return { candidate: null, open: null, receipt: accepted, edit: accepted ? { recallId: accepted.id, completionRevision: 1, input: draft, attachments } : null }; },
    } });
    const view = new ViewState(); view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [{ ...session, queueState }] }), replay: [], seq: 0 }, false);
    const writes = new CodeWrites({ request: (_target, op, params) => ipcResult(() => transport.request(op as "message_recall", params as OpParams<"message_recall">)) }, view, () => true, () => {}, "code");
    await writes.loadQueue(session.id);
    await writes.recall(session.id, taskId, "queued");
    let receiver = writes;
    if (!reconnected) {
      assert.equal(writes.draft(session.id).text, ""); assert.equal(storage.size, 1);
      reconnected = true;
      receiver = new CodeWrites({ request: (_target, op, params) => ipcResult(() => transport.request(op as "message_recall", params as OpParams<"message_recall">)) }, view, () => true, () => {}, "code");
      receiver.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [{ ...session, queueState }] }), replay: [], seq: 0 }, instanceChanged: false });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(receiver.draft(session.id).text, `${taskId} original body`);
    assert.deepEqual(receiver.draft(session.id).attachments, attachments);
    assert.equal(view.sessions[0].queueState, queueState);
    assert.deepEqual(queue.tasks.map(item => item.taskId), taskIds.filter(id => id !== taskId));
    assert.equal(transport.requests.filter(request => request.op === "message_recall").length, 1);
    assert.equal(storage.size, 1, "retain the recovery key until the owner edits or submits the installed draft");
    receiver.edit(session.id, `${taskId} edited body`);
    assert.equal(storage.size, 0);
  }
});

test("normal resume never confirms stopping and a separate confirmation sends the explicit parameter", async () => {
  const view = new ViewState(); view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [{ ...session, queueState: "paused" }] }), replay: [], seq: 0 }, false);
  const transport = new FakeTransport({ handlers: { resume_queue: params => { if (!params.stop_confirmed) throw new ControlClientError("stop_unverified", "verify old processes", "rejected"); return session; } } });
  const writes = new CodeWrites({ request: (_target, op, params) => ipcResult(() => transport.request(op as "resume_queue", params as OpParams<"resume_queue">)) }, view, () => true, () => {}, "code");
  await writes.resume(view.sessions[0]);
  assert.equal(writes.stopConfirmationNeeded(session.id), true);
  assert.deepEqual(transport.requests[0].params, { session_id: session.id });
  await writes.resume(view.sessions[0], true, true);
  assert.deepEqual(transport.requests[1].params, { session_id: session.id, stop_confirmed: true });
  assert.equal(writes.stopConfirmationNeeded(session.id), false);
});

test("TUI queue offers every eligible item retrieval using the authoritative queue revision", async () => {
  const selected: Array<[string, number]> = [];
  const queue = { revision: 7, tasks: taskIds.map((taskId, index) => ({ taskId, queueOrder: index + 1 })), retrievableTaskIds: taskIds };
  const transport = new FakeTransport({ handlers: { task_queue: () => ({ queue, reorderableTaskIds: [], steerableTaskIds: [], guidance: [] }) } });
  const panel = new TaskQueuePanel({ request: transport.request.bind(transport), sessionId: () => session.id, online: () => true, taskLabel: id => id, retrieve: async (id, revision) => { selected.push([id, revision]); }, render: () => {}, close: () => {} });
  await panel.refresh();
  panel.handleInput("\x1b[B"); panel.handleInput("\r"); panel.handleInput("\r");
  assert.deepEqual(selected, [["middle", 7]]);
});

test("internal report entries do not replace the receiving Task's original user input", () => {
  const entry = (id: string, inputPurpose: "user" | "internal_report"): HistoryEntryView => ({ entryId: id, taskId: "receiver", inputPurpose, parentId: null, role: "user", timestamp: at, text: id, offset: 0, totalBytes: id.length, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false });
  for (const reportFirst of [false, true]) {
    const flow = new EventFlow();
    const owner = entry("original requirement", "user"), report = entry("internal report", "internal_report");
    for (const item of reportFirst ? [report, owner] : [owner, report]) flow.addHistory(item);
    assert.deepEqual(flow.items.filter(item => item.kind === "message").map(item => item.entryId), [owner.entryId]);
  }
});

test("a retrieved queued Task remains absent from conversation history after terminal snapshot recovery", () => {
  const retrieved = task();
  const flow = new EventFlow();
  flow.applyRecall(receipt({ session_id: session.id, task_id: retrieved.id, request_id: "recall", purpose: "queued", expected_revision: 7 }));
  flow.task(retrieved);
  assert.deepEqual(flow.items, []);
});


test("unclassified queued events stay outside the user queue until trusted metadata arrives", () => {
  const state = new ViewState();
  state.applySnapshot({ snapshot: fakeSnapshot(), replay: [], seq: 0 }, false);
  const queued = { type: "task.queued" as const, taskId: "unknown", sessionId: "session", requestId: "host-key", accessMode: "confirm" as const, planMode: false, modelSelection: null, queueOrder: 1 };
  state.applyEvent({ seq: 1, taskId: queued.taskId, sessionId: queued.sessionId, createdAt: at, body: queued }, "live");
  assert.equal(state.queuedTasksFor("session").length, 0);
  state.applyEvent({ seq: 2, taskId: queued.taskId, sessionId: queued.sessionId, createdAt: at, body: { ...queued, inputPurpose: "internal_report" } }, "live");
  assert.equal(state.queuedTasksFor("session").length, 0);
});


test("lost answers query their original receipt without replaying a write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answer-query-only-"));
  try {
    const store = new PendingRequestStore(dir);
    const record: PendingRequest = { op: "owner_question_answer", requestId: "answer", instanceId: "original", createdAt: at, params: { session_id: session.id, question_id: "q", question_version: 1, request_id: "answer", answers: [{ text: "answer" }] } };
    store.save(record);
    const transport = new FakeTransport({ handlers: { owner_question_receipt: () => ({ receipt: null }) } });
    const guard = new SubmissionGuard(store, { instanceId: "original", request: transport.request.bind(transport) });
    assert.equal((await guard.reconcile(record)).kind, "kept");
    assert.deepEqual(transport.requests.map(request => request.op), ["owner_question_receipt"]);
    assert.deepEqual(transport.requests[0].params, { session_id: session.id, request_id: "answer", operation: "owner_question_answer", question_id: "q", question_version: 1, answers: [{ text: "answer" }] });
    assert.equal(store.read(record.requestId).kind, "record");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("Desktop keeps one recall key through a delayed result and restores it after a cold client restart", async context => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  context.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, configurable: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let accepted: PublicMessageRecall | null = null;
  const queue = { revision: 7, tasks: taskIds.map((taskId, index) => ({ taskId, queueOrder: index + 1 })), retrievableTaskIds: taskIds };
  const transport = new FakeTransport({ handlers: {
    task_queue: () => ({ queue, reorderableTaskIds: taskIds, steerableTaskIds: [], guidance: [] }),
    message_recall: params => { accepted = receipt(params); return { ...accepted, originalInput: "retrieved body", originalAttachments: [], draftAttachments: [] }; },
    message_recall_state: async () => { await pending; return { candidate: null, open: null, receipt: accepted, edit: accepted ? { recallId: accepted.id, completionRevision: 1, input: "retrieved body", attachments: [] } : null }; },
  } });
  const view = new ViewState(); view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [session] }), replay: [], seq: 0 }, false);
  const bridge = { request: (_target: "code" | "personal", op: string, params: Record<string, unknown>) => ipcResult(() => transport.request(op as "message_recall", params as OpParams<"message_recall">)) };
  const writes = new CodeWrites(bridge, view, () => true, () => {}, "code");
  await writes.loadQueue(session.id);
  const retrieving = writes.recall(session.id, "first", "queued");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(writes.blocked(session.id), true);
  writes.edit(session.id, "later message");
  assert.equal(writes.draft(session.id).text, "");
  await writes.send(session.id);
  const retrying = writes.recall(session.id, "middle", "queued");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(transport.requests.filter(request => request.op === "message_recall").every(request => (request.params as OpParams<"message_recall">).task_id === "first"));
  release(); await Promise.all([retrieving, retrying]);
  assert.equal(writes.draft(session.id).text, "retrieved body");
  assert.equal(writes.blocked(session.id), false);
  const restarted = new CodeWrites(bridge, view, () => true, () => {}, "code");
  restarted.update({ type: "snapshot", result: { snapshot: fakeSnapshot({ sessions: [session] }), replay: [], seq: 0 }, instanceChanged: false });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(restarted.draft(session.id).text, "retrieved body");
  restarted.edit(session.id, "edited body");
  assert.equal(storage.size, 0);
});


test("Desktop discards recall completion from an instance that was replaced during the write", async context => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  context.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, configurable: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = { revision: 7, tasks: [{ taskId: "first", queueOrder: 1 }], retrievableTaskIds: ["first"] };
  const transport = new FakeTransport({ handlers: {
    task_queue: () => ({ queue, reorderableTaskIds: ["first"], steerableTaskIds: [], guidance: [] }),
    message_recall: async params => { await gate; return { ...receipt(params), originalInput: "old body", originalAttachments: [], draftAttachments: [] }; },
  } });
  const view = new ViewState(); view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [session] }), replay: [], seq: 0 }, false);
  const writes = new CodeWrites({ request: (_target, op, params) => ipcResult(() => transport.request(op as "message_recall", params as OpParams<"message_recall">)) }, view, () => true, () => {}, "code");
  await writes.loadQueue(session.id);
  const recall = writes.recall(session.id, "first", "queued");
  await new Promise<void>(resolve => setImmediate(resolve));
  view.instanceId = "fresh"; writes.edit(session.id, "fresh draft");
  release(); await recall;
  assert.equal(writes.draft(session.id).text, "fresh draft");
  assert.equal(transport.requests.some(request => request.op === "message_recall_state"), false);
  assert.equal(storage.size, 1, "old instance request remains available for its original backend");
});
