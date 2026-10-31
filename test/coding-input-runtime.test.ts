import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listAgentReports } from "@ruukoto/core/agent-wait.ts";
import { requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { inputText, lastUserText, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

function latch() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

for (const sources of [1, 2]) test(`active Coding task receives ${sources} independent reports in N+1 without a second Driver`, async () => {
  const response = latch(), child = latch();
  const t = await startTestRuntime("coding-boundary-report", async request => {
    if (lastUserText(request) === "ACTIVE") { await response.promise; return { kind: "text", text: "first response" }; }
    assert.match(lastUserText(request), /后台报告/);
    return { kind: "text", text: "reported current facts" };
  }, { config: { product: product.runtime, workflowAgent: async () => { await child.promise; return { output: "REPORT_FACT" }; } } });
  try {
    const rt = t.runtime, session = (await rt.openWorkspace({ cwd: t.work[0] })).session;
    const origins = rt.store.withTx(() => {
      rt.store.setSessionQueueState(session.id, "paused", "fixture");
      return Array.from({ length: sources }, (_, index) => {
        const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: `origin-${index}`, input: "owner work", accessMode: "full_access", modelSelection: rt.defaultSelection, submissionDigest: `origin-${index}` }).task;
        rt.store.transitionTask(task.id, ["queued"], "running");
        return rt.store.getTask(task.id)!;
      });
    });
    const runs = origins.map((origin, index) => rt.workflows!.start({ sourceTaskId: origin.id, requestKey: `run-${index}`, input: null, script: 'return await agent("work", {request:"fact"});' }));
    rt.store.withTx(() => { for (const origin of origins) rt.store.endTask(origin.id, ["running"], "completed"); });
    await rt.resumeQueue(session.id);
    const active = await rt.submit({ sessionId: session.id, requestId: "active", input: "ACTIVE", modelSelection: rt.defaultSelection });
    await waitFor("active request N", () => t.server.calls.length === 1);
    child.release();
    await waitFor("fixed fallback receipts", () => runs.every(run => requireWorkflowRun(rt.store, run.id).delivery?.taskId));
    const fallbackIds = runs.map(run => requireWorkflowRun(rt.store, run.id).delivery!.taskId!);
    assert.equal(rt.store.getTaskQueue(session.id).tasks.length, 0);
    assert.ok(listAgentReports(rt.store).every(report => report.consumption === null));
    response.release();
    await waitFor("same active task completes reports", () => ["completed", "failed", "interrupted", "canceled"].includes(rt.store.getTask(active.id)!.status));
    assert.equal(rt.store.getTask(active.id)!.status, "completed", rt.store.getTask(active.id)!.errorMessage ?? "no error");
    await waitFor("reports finalized", () => listAgentReports(rt.store).every(report => report.status === "reported"));
    assert.equal(t.server.calls.length, 2);
    assert.equal(rt.store.getTask(active.id)!.requestId, "active");
    assert.equal(rt.getTaskDetail(active.id)!.task.inputPurpose, "user");
    assert.ok(listAgentReports(rt.store).every(report => report.claimTaskId === active.id && report.consumption?.taskId === active.id));
    assert.ok(fallbackIds.every(id => rt.store.getTask(id)!.startedAt === null));
    const entries = parseSessionFile(rt.store.getSession(session.id)!.sessionFile!);
    const reportInput = entries.find(entry => entry.type === "message" && Array.isArray((entry.message as { ruukotoReportKeys?: string[] })?.ruukotoReportKeys));
    assert.ok(reportInput, "actual report text is in authoritative JSONL");
    assert.equal(rt.readHistoryEntry({ sessionId: session.id, entryId: reportInput.id }).inputPurpose, "internal_report");
    assert.equal(rt.readHistory({ sessionId: session.id }).entries.find(entry => entry.role === "user" && entry.text === "ACTIVE")!.inputPurpose, "user");
    SessionManager.open(rt.store.getSession(session.id)!.sessionFile!).appendContextEdit(reportInput.id, null);
    assert.equal(rt["verifyAgentReportSources"](active.id, true), "agent_report_input_invalid", "a retained marker cannot prove consumption after report text is omitted");
  } finally { response.release(); child.release(); await t.shutdown(); }
});

for (const queued of [false, true]) test(`owner pause commits before stop and remains until explicit resume (${queued ? "queued input" : "empty queue"})`, async () => {
  const response = latch();
  const t = await startTestRuntime("coding-owner-pause", async () => { await response.promise; return { kind: "text", text: "done" }; }, { config: { product: product.runtime } });
  try {
    const rt = t.runtime, session = (await rt.openWorkspace({ cwd: t.work[0] })).session;
    const active = await rt.submit({ sessionId: session.id, requestId: "active", input: "ACTIVE", modelSelection: rt.defaultSelection });
    await waitFor("active model request", () => t.server.calls.length === 1);
    const next = queued ? await rt.submit({ sessionId: session.id, requestId: "next", input: "NEXT", modelSelection: rt.defaultSelection }) : null;
    const stopping = rt.interruptTask(active.id);
    assert.equal(rt.store.getSession(session.id)!.queuePauseReason, "owner_pause");
    assert.equal(rt.store.getTask(active.id)!.interruptReason, "owner_interrupt");
    await stopping;
    response.release();
    if (next) assert.equal(rt.store.getTask(next.id)!.status, "queued");
    const later = await rt.submit({ sessionId: session.id, requestId: "later", input: "LATER", modelSelection: rt.defaultSelection });
    assert.equal(later.resumesTaskId, null);
    assert.equal(rt.store.getSession(session.id)!.queuePauseReason, "owner_pause");
    assert.equal(t.server.calls.length, 1);
    await rt.resumeQueue(session.id);
    await waitFor("new tasks execute after resume", () => rt.store.getTask(later.id)!.status === "completed");
    assert.equal(rt.store.getTask(active.id)!.status, "interrupted");
  } finally { response.release(); await t.shutdown(); }
});

test("queued retrieval after historical recall preserves the saved owner pause", async () => {
  const t = await startTestRuntime("coding-recall-pause", () => ({ kind: "text", text: "done" }), { config: { product: product.runtime } });
  try {
    const rt = t.runtime, session = (await rt.openWorkspace({ cwd: t.work[0] })).session;
    const tasks = rt.store.withTx(() => {
      rt.store.setSessionQueueState(session.id, "paused", "owner_pause");
      return ["first", "latest"].map(key => rt.store.insertQueuedTask({ sessionId: session.id, requestId: key, input: key,
        modelSelection: rt.defaultSelection, submissionDigest: key }).task);
    });
    const candidate = rt.messageRecall.messageRecallState({ sessionId: session.id }).candidate!;
    await rt.messageRecall.recallMessage({ sessionId: session.id, taskId: candidate.taskId, purpose: "historical", requestId: "historical", expectedRevision: candidate.inputSeq });
    await waitFor("historical edit window", () => rt.messageRecall.messageRecallState({ sessionId: session.id, requestId: "historical" }).receipt?.phase === "completed");
    await rt.messageRecall.recallMessage({ sessionId: session.id, taskId: tasks[0].id, purpose: "queued", requestId: "queued", expectedRevision: rt.store.getTaskQueue(session.id).revision });
    assert.equal(rt.store.getSession(session.id)!.queuePauseReason, "message_recall_edit");
    const later = await rt.submit({ sessionId: session.id, requestId: "later", input: "later", modelSelection: rt.defaultSelection });
    assert.equal(rt.store.getSession(session.id)!.queuePauseReason, "owner_pause");
    assert.equal(rt.store.getTask(later.id)!.status, "queued");
    assert.equal(t.server.calls.length, 0);
    await rt.resumeQueue(session.id);
    await waitFor("explicitly resumed input", () => rt.store.getTask(later.id)!.status === "completed");
  } finally { await t.shutdown(); }
});

test("a later owner pause overrides an earlier queued retrieval snapshot", async () => {
  const response = latch();
  const t = await startTestRuntime("coding-later-pause", async () => { await response.promise; return { kind: "text", text: "done" }; }, { config: { product: product.runtime } });
  try {
    const rt = t.runtime, session = (await rt.openWorkspace({ cwd: t.work[0] })).session;
    const active = await rt.submit({ sessionId: session.id, requestId: "active", input: "active", modelSelection: rt.defaultSelection });
    await waitFor("active request", () => t.server.calls.length === 1);
    const first = await rt.submit({ sessionId: session.id, requestId: "first", input: "first", modelSelection: rt.defaultSelection });
    const latest = await rt.submit({ sessionId: session.id, requestId: "latest", input: "latest", modelSelection: rt.defaultSelection });
    await rt.messageRecall.recallMessage({ sessionId: session.id, taskId: first.id, purpose: "queued", requestId: "queued", expectedRevision: rt.store.getTaskQueue(session.id).revision });
    await rt.interruptTask(active.id);
    const candidate = rt.messageRecall.messageRecallState({ sessionId: session.id }).candidate!;
    assert.equal(candidate.taskId, latest.id);
    await rt.messageRecall.recallMessage({ sessionId: session.id, taskId: latest.id, purpose: "historical", requestId: "historical", expectedRevision: candidate.inputSeq });
    await waitFor("historical recall", () => rt.messageRecall.messageRecallState({ sessionId: session.id, requestId: "historical" }).receipt?.phase === "completed");
    const later = await rt.submit({ sessionId: session.id, requestId: "later", input: "later", modelSelection: rt.defaultSelection });
    assert.equal(rt.store.getSession(session.id)!.queuePauseReason, "owner_pause");
    assert.equal(rt.store.getTask(later.id)!.status, "queued");
    assert.equal(t.server.calls.length, 1);
  } finally { response.release(); await t.shutdown(); }
});

test("same-Task questions, guidance and independent reports keep their identities through recall, branch and compaction", async () => {
  const response = latch(), child = latch();
  const facts = ["ORIGINAL_REQUIREMENT", "EXPLICIT_GUIDANCE", "FIRST_ANSWER", "SECOND_ANSWER", "REPORT_A", "REPORT_B"];
  const t = await startTestRuntime("coding-input-projections", async (request, index) => {
    if (!request.tools?.length) {
      for (const fact of facts) assert.ok(inputText(request).includes(fact), `summary input retains ${fact}`);
      assert.doesNotMatch(inputText(request), /RECALLED_LATER_INPUT/);
      return { kind: "text", text: `COMPACTED_FACTS ${facts.join(" ")}` };
    }
    if (index === 0) await response.promise;
    if (index < 2) return { kind: "tool_calls", calls: [{ id: `question-${index}`, name: "ask_user", arguments: { questions: [{ question: `Question ${index + 1}` }] } }] };
    return { kind: "text", text: "completed" };
  }, { config: { ...realTools(), product: product.runtime, workflowAgent: async ({ step }) => {
    await child.promise;
    return { output: JSON.stringify(step.params) };
  } } });
  try {
    const rt = t.runtime, session = (await rt.openWorkspace({ cwd: t.work[0] })).session;
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: session.defaultAccessModeVersion, mode: "full_access" });
    const origins = rt.store.withTx(() => {
      rt.store.setSessionQueueState(session.id, "paused", "fixture");
      return ["A", "B"].map(key => {
        const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: `origin-${key}`, input: "source work",
          modelSelection: rt.defaultSelection, submissionDigest: key, accessMode: "full_access" }).task;
        rt.store.transitionTask(task.id, ["queued"], "running");
        return rt.store.getTask(task.id)!;
      });
    });
    const runs = origins.map((origin, index) => rt.workflows!.start({ sourceTaskId: origin.id, requestKey: `run-${index}`, input: null,
      script: `return await agent("work", {request:"REPORT_${index === 0 ? "A" : "B"}"});` }));
    rt.store.withTx(() => { for (const origin of origins) rt.store.endTask(origin.id, ["running"], "completed"); });
    await rt.resumeQueue(session.id);
    const active = await rt.submit({ sessionId: session.id, requestId: "original", input: facts[0], modelSelection: rt.defaultSelection });
    await waitFor("original request N", () => t.server.calls.length === 1);
    const guidance = await rt.submit({ sessionId: session.id, requestId: "guidance", input: facts[1], guidance: true, modelSelection: rt.defaultSelection });
    child.release();
    await waitFor("both reports ready during N", () => runs.every(run => requireWorkflowRun(rt.store, run.id).delivery?.taskId));
    response.release();
    for (const index of [0, 1]) {
      await waitFor(`pending question ${index + 1}`, () => rt.listOwnerQuestions(session.id).questions.some(question => question.status === "pending"));
      const question = rt.listOwnerQuestions(session.id).questions.find(question => question.status === "pending")!;
      assert.equal(question.taskId, active.id);
      const receipt = await rt.answerOwnerQuestion({ sessionId: session.id, questionId: question.id, version: question.version,
        requestId: `answer-${index}`, answers: [{ text: facts[index + 2] }] });
      assert.equal(receipt.taskId, active.id);
    }
    await waitFor("original Task and reports complete", () => rt.store.getTask(active.id)!.status === "completed" && listAgentReports(rt.store).every(report => report.status === "reported"));
    assert.equal(t.server.calls.length, 3);
    for (const fact of facts) assert.ok(inputText(t.server.calls[2]).includes(fact), `actual request retains ${fact}`);
    assert.equal(rt.store.getTask(active.id)!.input, facts[0]);
    assert.equal(rt.store.getTaskGuidance(guidance.id)!.state, "joined");
    assert.ok(listAgentReports(rt.store).every(report => report.claimTaskId === active.id && report.consumption?.taskId === active.id));
    const questions = rt.listOwnerQuestions(session.id).questions;
    assert.equal(questions.length, 2);
    assert.equal(new Set(questions.map(question => question.hostOpId)).size, 2);
    assert.ok(questions.every(question => question.status === "answered" && question.continuationTaskId === undefined));
    const later = await rt.submit({ sessionId: session.id, requestId: "later", input: "RECALLED_LATER_INPUT", modelSelection: rt.defaultSelection });
    await waitFor("later Task completes", () => rt.store.getTask(later.id)!.status === "completed");
    const candidate = rt.messageRecall.messageRecallState({ sessionId: session.id }).candidate!;
    assert.equal(candidate.taskId, later.id);
    await rt.messageRecall.recallMessage({ sessionId: session.id, taskId: later.id, purpose: "historical", requestId: "recall-later", expectedRevision: candidate.inputSeq });
    await waitFor("later input omitted", () => rt.messageRecall.messageRecallState({ sessionId: session.id, requestId: "recall-later" }).receipt?.phase === "completed");
    assert.equal(rt.messageRecall.messageRecallState({ sessionId: session.id }).candidate!.kind, "answer");
    const originalHistory = rt.readHistory({ sessionId: session.id, limit: 100 }).entries;
    assert.ok(originalHistory.some(entry => entry.role === "user" && entry.text === facts[0] && entry.inputPurpose === "user"));
    assert.ok(originalHistory.some(entry => entry.entryId === rt.store.getTaskGuidance(guidance.id)!.entryId && entry.text.includes(facts[1])));
    const reportEntries = originalHistory.filter(entry => entry.reportKeys?.length);
    assert.equal(reportEntries.length, 1);
    assert.equal(reportEntries[0].inputPurpose, "internal_report");
    assert.equal(reportEntries[0].reportKeys!.length, 2);
    assert.ok(questions.every(question => originalHistory.some(entry => entry.hostToolOpId === question.hostOpId && entry.toolName === "ask_user")));
    const sourceFile = rt.store.getSession(session.id)!.sessionFile!, sourceBytes = fs.readFileSync(sourceFile);
    const branch = await rt.branchSession({ sessionId: session.id, taskId: active.id, requestId: "branch-inputs" });
    assert.deepEqual(fs.readFileSync(sourceFile), sourceBytes);
    const branchHistory = () => rt.readHistory({ sessionId: branch.id, limit: 100 }).entries;
    const identities = (entries: typeof originalHistory) => entries.map(entry => ({ id: entry.entryId, taskId: entry.taskId,
      purpose: entry.inputPurpose, hostOpId: entry.hostToolOpId, reportKeys: entry.reportKeys }));
    assert.deepEqual(identities(branchHistory()), identities(originalHistory));
    const branchBytes = fs.readFileSync(branch.sessionFile!);
    await rt.compactSession({ sessionId: branch.id, requestId: "compact-inputs" });
    await waitFor("combined history compacts", () => rt.getSessionCompaction({ sessionId: branch.id, requestId: "compact-inputs" })?.status !== "running");
    assert.equal(rt.getSessionCompaction({ sessionId: branch.id, requestId: "compact-inputs" })!.status, "succeeded");
    assert.deepEqual(fs.readFileSync(branch.sessionFile!), branchBytes);
    assert.deepEqual(identities(branchHistory()), identities(originalHistory));
    const followup = await rt.submit({ sessionId: branch.id, requestId: "after-compaction", input: "AFTER_COMPACTION", modelSelection: rt.defaultSelection });
    await waitFor("compacted branch request completes", () => rt.store.getTask(followup.id)!.status === "completed");
    assert.match(inputText(t.server.calls.at(-1)!), /COMPACTED_FACTS/);
    for (const fact of facts) assert.ok(inputText(t.server.calls.at(-1)!).includes(fact), `compacted request retains ${fact}`);
    assert.doesNotMatch(inputText(t.server.calls.at(-1)!), /RECALLED_LATER_INPUT/);
  } finally { response.release(); child.release(); await t.shutdown(); }
});
