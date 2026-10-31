/**
 * Recall and edit/resend regressions.
 * Effective history accepts only null edits of earlier editable contributions; copies omit recalled contributions and edit controls.
 * Recalling unadopted queued input cancels it without JSONL edits. Completed input is restored only to the original key holder and omitted from default history/search.
 * Stale targets, later input and structured answers must reject with their specific semantics.
 */

import test from "node:test";
import assert from "node:assert";
import { effectiveProjection, materializeEffectiveHistory } from "@ruukoto/core/history-effective.ts";
import { HistoryReadError } from "@ruukoto/core/history.ts";
import {
  createProjectSession,
  routeResponder,
  startTestRuntime,
  taskStatus,
  waitFor,
} from "./helpers/testkit.ts";

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

const routes = routeResponder([
  {
    match: /SLOW:/,
    respond: async () => {
      await new Promise((r) => setTimeout(r, 4000));
      return { kind: "text", text: "slow-done" };
    },
  },
  { match: /.*/, respond: () => ({ kind: "text", text: "done" }) },
]);

type AnyEntry = Record<string, unknown> & { id: string; type: string };

/** Recall advances asynchronously while verifying the stop closure; poll until settled or timed out. */
async function recallDone(client: { request(op: string, params: Record<string, unknown>): Promise<unknown> }, sessionId: string, requestId: string, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const state = (await client.request("message_recall_state", { session_id: sessionId, request_id: requestId })) as { receipt?: { phase: string; error?: { code?: string } | null } & Record<string, unknown> | null };
    const receipt = state.receipt;
    if (receipt && ["completed", "rejected", "blocked"].includes(receipt.phase)) return receipt;
    if (Date.now() - start > timeoutMs) throw new Error(`撤回未收束（当前 ${receipt?.phase ?? "无回执"}）`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

const msg = (id: string, role: string, text: string): AnyEntry => ({
  id,
  type: "message",
  parentId: null,
  message: { role, content: [{ type: "text", text }] },
});
const edit = (id: string, targetId: string, replacement: unknown = null): AnyEntry => ({
  id,
  type: "context_edit",
  parentId: null,
  targetId,
  replacement,
});

test("有效投影：null 编辑省略目标；物化副本不含省略与编辑条目", () => {
  const entries = [msg("e1", "user", "first"), msg("e2", "assistant", "reply"), msg("e3", "user", "second"), edit("x1", "e3")];
  const { omitted, contributions } = effectiveProjection(entries as never);
  assert.deepEqual([...omitted], ["e3"]);
  assert.deepEqual(contributions.map((e) => e.id), ["e1", "e2"]);

  const raw = Buffer.from(`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  const materialized = materializeEffectiveHistory(raw).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as AnyEntry);
  assert.deepEqual(materialized.map((e) => e.id), ["e1", "e2"]);
  assert.equal(materialized[1]!.parentId, "e1", "物化副本的 parent 链须重接到前一有效条目");
});

test("有效投影：非法编辑一律 history_corrupt", () => {
  const bad = [
    [msg("e1", "user", "a"), edit("x1", "later")], // Unknown target
    [msg("e1", "user", "a"), msg("e2", "user", "b"), edit("x1", "e2", "替换")], // Non-null replacement
    [msg("e1", "user", "a"), { id: "c1", type: "custom", parentId: null, customType: "ruukoto_x" }, edit("x1", "c1")], // Non-editable target
  ];
  for (const entries of bad) {
    assert.throws(() => effectiveProjection(entries as never), HistoryReadError);
  }
});

test("排队未采纳的输入撤回即取消并恢复草稿", async () => {
  const t = await startTestRuntime("recall-queued", routes);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "rq-1", input: "SLOW:先跑",
    });
    await waitFor("首个任务运行中", async () => (await taskStatus(t.client, first.id)).task.status === "running");

    const second = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "rq-2", input: "second-draft",
    });
    const state0 = await t.client.request<any>("message_recall_state", { session_id: sessionId });
    assert.equal(state0.candidate?.taskId, second.id, "候选应为最近接纳的拥有者输入");

    await t.client.request<any>("message_recall", {
      session_id: sessionId, task_id: second.id, request_id: "rc-1", expected_revision: state0.candidate.inputSeq,
    });
    const receipt = await recallDone(t.client, sessionId, "rc-1");
    assert.equal(receipt.phase, "completed");
    const task = await taskStatus(t.client, second.id);
    assert.equal(task.task.status, "canceled", "未采纳的排队输入撤回即取消");

    const state = await t.client.request<any>("message_recall_state", { session_id: sessionId, request_id: "rc-1" });
    assert.equal(state.edit?.input, "second-draft", "原输入正文应进入发起端草稿视图");

    // A client without the request key sees edit-window identity, not draft text.
    const other = await t.client.request<any>("message_recall_state", { session_id: sessionId });
    assert.equal(other.edit?.input ?? "", "", "非发起端不得获得草稿正文");
    // Broadcast/query receipts are redacted: they omit original text and staged attachments.
    assert.ok(!("originalInput" in (state.receipt ?? {})), "回执不得携带原正文");
    assert.ok(!("originalAttachments" in (state.receipt ?? {})), "回执不得携带原附件");
    assert.ok(!("draftAttachments" in (state.receipt ?? {})), "回执不得携带新暂存附件");

    // After the original task completes, the first input remains eligible for the next recall.
    await waitFor("首个任务完成", async () => (await taskStatus(t.client, first.id)).task.status === "completed", 30_000);
  } finally {
    await t.shutdown();
  }
});

test("已完成任务撤回：草稿恢复、历史省略、可编辑后重发", async () => {
  const t = await startTestRuntime("recall-completed", routes);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const task = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "rc-done-1", input: "原输入-需撤回",
    });
    await waitFor("任务完成", async () => (await taskStatus(t.client, task.id)).task.status === "completed", 30_000);

    const state0 = await t.client.request<any>("message_recall_state", { session_id: sessionId });
    assert.equal(state0.candidate?.taskId, task.id);
    await t.client.request<any>("message_recall", {
      session_id: sessionId, task_id: task.id, request_id: "rc-2", expected_revision: state0.candidate.inputSeq,
    });
    const receipt = await recallDone(t.client, sessionId, "rc-2");
    assert.equal(receipt.phase, "completed");
    assert.ok((receipt.omittedEntryIds as unknown[])?.length, "完成回执应登记省略条目");

    const state = await t.client.request<any>("message_recall_state", { session_id: sessionId, request_id: "rc-2" });
    assert.equal(state.edit?.input, "原输入-需撤回");

    // Search and default history no longer expose recalled input text.
    await waitFor("索引重建", async () => {
      const hits = await t.client.request<any>("search_history", { session_id: sessionId, query: "原输入-需撤回", limit: 10 });
      return hits.hits.length === 0;
    });

    // The edit window pauses the queue; accepting new input closes it and restores the queue.
    const session = await t.client.request<any>("get_session", { session_id: sessionId });
    assert.equal(session.queueState, "paused");
    assert.equal(session.queuePauseReason, "message_recall_edit");

    const resent = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "rc-done-2", input: "编辑后的输入",
    });
    await waitFor("重发任务完成", async () => (await taskStatus(t.client, resent.id)).task.status === "completed", 30_000);
    const after = await t.client.request<any>("message_recall_state", { session_id: sessionId });
    assert.equal(after.edit, null, "新输入接纳后编辑窗应关闭");
    assert.equal(after.candidate?.taskId, resent.id, "候选应滚动到最新输入（可再次撤回）");
  } finally {
    await t.shutdown();
  }
});

test("陈旧目标、冲突请求键与更晚输入存在时拒绝", async () => {
  const t = await startTestRuntime("recall-reject", routes);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const first = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "rj-1", input: "SLOW:先跑",
    });
    await waitFor("首个任务运行中", async () => (await taskStatus(t.client, first.id)).task.status === "running");
    const second = await t.client.request<any>("submit", {
      model_selection: MODEL, session_id: sessionId, request_id: "rj-2", input: "更晚的输入",
    });

    const state = await t.client.request<any>("message_recall_state", { session_id: sessionId });
    assert.equal(state.candidate?.taskId, second.id);

    // An older task is no longer the latest recall candidate.
    const stale = await t.client.request<any>("message_recall", {
      session_id: sessionId, task_id: first.id, request_id: "rj-r1", expected_revision: 1,
    });
    const staleDone = await recallDone(t.client, sessionId, "rj-r1");
    assert.equal(staleDone.phase, "rejected");
    assert.equal(staleDone.error?.code, "stale_target");

    // An incorrect revision is a stale target.
    const wrongRev = await t.client.request<any>("message_recall", {
      session_id: sessionId, task_id: second.id, request_id: "rj-r2", expected_revision: 0,
    });
    const wrongDone = await recallDone(t.client, sessionId, "rj-r2");
    assert.equal(wrongDone.phase, "rejected");

    // Changed parameters under the same idempotency key must reject.
    await t.client.request<any>("message_recall", {
      session_id: sessionId, task_id: second.id, request_id: "rj-r3", expected_revision: state.candidate.inputSeq,
    });
    await assert.rejects(
      () => t.client.request<any>("message_recall", {
        session_id: sessionId, task_id: second.id, request_id: "rj-r3", expected_revision: state.candidate.inputSeq + 99,
      }),
      (err: Error) => (err as { code?: string }).code === "request_conflict",
    );
    // Identical keyed parameters return the original receipt idempotently.
    const idem = await recallDone(t.client, sessionId, "rj-r3");
    assert.equal(idem.phase, "completed");
  } finally {
    await t.shutdown();
  }
});
