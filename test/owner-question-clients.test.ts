import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import type { OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import type { Session } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PendingRequestStore } from "@ruukoto/control/pending-requests.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { OwnerQuestions } from "@ruukoto/tui/tui/owner-questions.ts";
import { DesktopSubmissions } from "../apps/desktop/src/main/submissions.ts";
import { DesktopQuestions } from "../apps/desktop/src/renderer/owner-questions.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { CodeWrites } from "../apps/desktop/src/renderer/code-writes.ts";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { ipcResult } from "../apps/desktop/src/main/ipc.ts";
import { FakeTransport, fakeSnapshot } from "./helpers/fake-control.ts";

const at = "2026-10-21T00:00:00.000Z";
const session: Session = { id: "session", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: { provider: "mock", modelId: "model", thinkingLevel: "off" }, modelSelectionVersion: 1, defaultAccessMode: "confirm", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: at };
function task(): TaskView { return { id: "task", sessionId: "session", requestId: "request", input: "拥有者回答", inputPurpose: "user", modelSelection: session.modelSelection, submissionDigest: null, status: "queued", accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: null, endedAt: null }; }
async function settle(): Promise<void> { for (let index = 0; index < 3; index++) await new Promise<void>(resolve => setImmediate(resolve)); }
function harness(options: { lose?: boolean; lostOutcome?: "unknown" | "disconnected"; holdCancel?: Promise<void>; pending?: PendingRequestStore } = {}) {
  const pending = options.pending ?? new PendingRequestStore(fs.mkdtempSync(path.join(os.tmpdir(), "owner-question-client-")));
  let question: OwnerQuestionView = { id: "question", sessionId: session.id, taskId: "source", version: 1, status: "pending", questions: [{ question: "选择做法", options: ["甲", "乙"] }, { question: "补充说明" }], createdAt: at };
  let receipt: ReturnType<typeof receiptFor> | null = null;
  let committedParams: unknown;
  let consumed = 0;
  function receiptFor(operation: "owner_question_answer" | "owner_question_cancel", requestKey: string) { return { operation, questionId: question.id, sessionId: session.id, requestKey, digest: "digest", question, ...(operation === "owner_question_answer" ? { taskId: "task" } : {}) }; }
  const transport = new FakeTransport({ handlers: {
    owner_questions: () => ({ questions: [question], nextOffset: null }),
    owner_question_answer: params => {
      const saved = pending.list().records.find(record => record.requestId === params.request_id);
      assert.ok(saved, "发送前完整原请求已落盘"); assert.deepEqual(saved.params, params);
      if (receipt?.requestKey === params.request_id && receipt.operation === "owner_question_answer") {
        if (!isDeepStrictEqual(params, committedParams)) throw new ControlClientError("request_conflict", "同键异参", "rejected");
        return { ...task(), requestId: params.request_id };
      }
      if (question.status !== "pending") throw new ControlClientError("stale_answer", "已被另一客户端消费", "rejected");
      committedParams = structuredClone(params); consumed++;
      question = { ...question, status: "answered", version: question.version + 1, answers: params.answers, continuationTaskId: "task" };
      receipt = receiptFor("owner_question_answer", params.request_id);
      if (options.lose) throw new ControlClientError("timeout", "应答丢失", options.lostOutcome ?? "unknown");
      return { ...task(), requestId: params.request_id };
    },
    owner_question_cancel: async params => {
      const saved = pending.list().records.find(record => record.requestId === params.request_id); assert.ok(saved); assert.deepEqual(saved.params, params);
      if (receipt?.requestKey === params.request_id && receipt.operation === "owner_question_cancel") {
        if (!isDeepStrictEqual(params, committedParams)) throw new ControlClientError("request_conflict", "同键异参", "rejected");
        return receipt.question;
      }
      await options.holdCancel;
      committedParams = structuredClone(params); consumed++;
      question = { ...question, status: "canceled", version: question.version + 1 }; receipt = receiptFor("owner_question_cancel", params.request_id);
      if (options.lose) throw new ControlClientError("timeout", "应答丢失", options.lostOutcome ?? "unknown");
      return question;
    },
    owner_question_receipt: params => ({ receipt: receipt?.requestKey === params.request_id && receipt.operation === params.operation ? receipt : null }),
    find_task: () => ({ task: task() }),
  } });
  const view = new ViewState();
  view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [session], ownerQuestions: [question] }), replay: [], seq: 0 }, false);
  const updates: DesktopUpdate[] = [];
  const connection = { instanceId: "inst-1", request: transport.request.bind(transport) };
  const submissions = new DesktopSubmissions(pending, () => connection, update => updates.push(update), connection.request);
  const bridge: Pick<DesktopBridge, "request"> = { request: async (_target, op, params) => {
    if (op === "owner_question_answer") return ipcResult(() => submissions.submit(op, params));
    if (op === "owner_question_cancel") return ipcResult(() => submissions.cancelQuestion(params));
    return ipcResult(() => connection.request(op as "owner_questions", params as { session_id: string }));
  } };
  const questions = new DesktopQuestions(bridge, view, () => true, () => {});
  const panel = new OwnerQuestions({ request: connection.request, pending, known: () => view.ownerQuestions, install: (sessionId, questions) => { view.ownerQuestions = [...view.ownerQuestions.filter(question => question.sessionId !== sessionId), ...questions]; }, beforeSend: () => Promise.resolve(), session: () => session, instanceId: () => "inst-1", online: () => true, render: () => {}, close: () => {} });
  const draw = () => stripVTControlCharacters(panel.render(90).join("\n"));
  const press = async (key: string) => { panel.handleInput(key); await settle(); };
  return { pending, transport, view, panel, draw, press, questions, submissions, bridge, updates, get question() { return question; }, get consumed() { return consumed; } };
}

test("TUI 逐题选择与自由文本保留 q；完整回答一次提交并显示终态", async () => {
  const h = harness();
  try {
    await h.panel.refresh(); await h.press("\r");
    await h.press("\x1b[B"); await h.press("\x1b[B"); await h.press("\r");
    await h.press("custom q answer"); await h.press("\r");
    assert.match(h.draw(), /补充说明/);
    await h.press("\r"); await h.press("\r"); assert.match(h.draw(), /请填写非空回答/);
    await h.press("说明"); await h.press("\r"); assert.match(h.draw(), /custom q answer/);
    await h.press("\r");
    assert.deepEqual(h.question.answers, [{ text: "custom q answer" }, { text: "说明" }]);
    assert.equal(h.pending.list().records.length, 0); assert.match(h.draw(), /已回答/);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("TUI 取消整批不发送答案，应答丢失按原键回执恢复", async () => {
  const h = harness({ lose: true });
  try {
    await h.panel.refresh(); await h.press("\r");
    for (let index = 0; index < 3; index++) await h.press("\x1b[B");
    await h.press("\r"); await h.press("\r");
    assert.equal(h.question.status, "canceled"); assert.equal(h.pending.list().records.length, 1);
    const original = h.pending.list().records[0].requestId;
    await h.panel.reconnect(); assert.equal(h.pending.list().records.length, 0);
    assert.equal(h.transport.requests.filter(request => request.op === "owner_question_cancel").length, 2);
    assert.ok(h.transport.requests.some(request => request.op === "owner_question_receipt" && (request.params as { request_id: string }).request_id === original));
    assert.equal(h.transport.requests.some(request => request.op === "owner_question_answer"), false);
    assert.equal(h.consumed, 1);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("TUI 窄窗口完整换行显示长选项，尾部差异可读且选择对应原选项", async () => {
  const h = harness();
  const options = ["共同前缀".repeat(22) + "甲范围", "共同前缀".repeat(22) + "乙范围"];
  h.question.questions[0].options = options;
  try {
    await h.panel.refresh(); await h.press("\r");
    const text = stripVTControlCharacters(h.panel.render(72).join("\n"));
    assert.match(text, /甲范围/); assert.match(text, /乙范围/);
    await h.press("\x1b[B"); await h.press("\r");
    await h.press("\r"); await h.press("备注"); await h.press("\r"); await h.press("\r");
    assert.deepEqual(h.question.answers, [{ text: options[1], option: 1 }, { text: "备注" }]);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("TUI Skip 清除已有回答，末题跳过进入核对，空答案丢答后沿原键恢复", async () => {
  const h = harness({ lose: true });
  try {
    await h.panel.refresh(); await h.press("\r");
    await h.press("\r");
    await h.press("\x1b[B"); await h.press("\x1b[B"); await h.press("\r");
    await h.press("\x1b[A"); await h.press("\r");
    assert.match(h.draw(), /补充说明/);
    await h.press("\x1b[A"); await h.press("\r");
    assert.equal((h.draw().match(/已跳过/g) ?? []).length, 2);
    await h.press("\r");
    assert.deepEqual(h.question.answers, [{ text: "" }, { text: "" }]);
    assert.equal(h.pending.list().records.length, 1);
    const original = h.pending.list().records[0];
    assert.deepEqual(original.params.answers, [{ text: "" }, { text: "" }]);
    await h.panel.reconnect();
    assert.equal(h.pending.list().records.length, 0); assert.equal(h.consumed, 1);
    const requests = h.transport.requests.filter(request => request.op === "owner_question_answer");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => (request.params as { request_id: string }).request_id === original.requestId));
    assert.equal((h.draw().match(/已跳过/g) ?? []).length, 2);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("TUI 多选 Enter 切换并保留光标，说明完整可读，推荐不默认选择，答案按题目顺序提交", async () => {
  const h = harness();
  const description = "长说明".repeat(30) + "说明尾部";
  h.question.questions[0] = { question: "选择多个目标", multiple: true, options: [{ label: "甲", description, recommended: true }, "乙", { label: "丙", description: "第三个目标" }] };
  try {
    await h.panel.refresh(); await h.press("\r");
    assert.match(h.draw(), /Recommended/); assert.match(h.draw(), /说明尾部/);
    assert.doesNotMatch(h.draw(), /\[x\]/);
    assert.doesNotMatch(h.draw(), /[123]\. \[ \]/, "多选以复选框替代编号");
    await h.press("\x1b[B"); await h.press("\x1b[B"); await h.press("\r");
    assert.match(h.draw(), /\[x\] 丙/); assert.match(h.draw(), /第 1 \/ 2 题/);
    await h.press("\r"); assert.doesNotMatch(h.draw(), /\[x\]/, "重复 Enter 取消刚选的第三项");
    await h.press("\r");
    await h.press("\x1b[A"); await h.press("\x1b[A"); await h.press("\r");
    for (let index = 0; index < 3; index++) await h.press("\x1b[B");
    await h.press("\r"); assert.match(h.draw(), /补充说明/);
    await h.press("\x1b[B"); await h.press("\x1b[B"); await h.press("\r");
    assert.match(h.draw(), /\[x\] 甲/); assert.match(h.draw(), /\[x\] 丙/);
    for (let index = 0; index < 3; index++) await h.press("\x1b[B");
    await h.press("\r"); await h.press("\r"); await h.press("备注"); await h.press("\r");
    assert.match(h.draw(), /甲\s*\n丙/);
    await h.press("\r");
    assert.deepEqual(h.question.answers, [{ text: "甲\n丙", options: [0, 2] }, { text: "备注" }]);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("TUI 多选与自由输入互斥，清空选择后须重选或 Skip", async () => {
  const h = harness();
  h.question.questions = [{ question: "选择目标", multiple: true, options: ["甲", "乙"] }];
  try {
    await h.panel.refresh(); await h.press("\r"); await h.press("\r");
    for (let index = 0; index < 3; index++) await h.press("\x1b[B");
    await h.press("\r"); assert.doesNotMatch(h.draw(), /甲|乙/, "选择文字不回填自由输入");
    await h.press("自由回答"); await h.press("\r"); await h.press("\x1b");
    await h.press("\r"); assert.match(h.draw(), /\[x\] 甲/);
    await h.press("\r"); assert.doesNotMatch(h.draw(), /\[x\]/);
    await h.press("\x1b[B"); await h.press("\x1b[B"); await h.press("\r");
    assert.match(h.draw(), /请选择至少一项，或跳过当前问题/);
    await h.press("\x1b[B"); await h.press("\r");
    assert.doesNotMatch(h.draw(), /自由回答|甲|乙/);
    await h.press("自定义 q 答案"); await h.press("\r"); await h.press("\r");
    assert.deepEqual(h.question.answers, [{ text: "自定义 q 答案" }]);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("Desktop 未回答的选项不自动补齐，问题回答独立于普通聊天草稿", async () => {
  const h = harness();
  try {
    h.questions.next(h.question); assert.equal(h.questions.draft(h.question).index, 0);
    h.questions.choose(h.question, 1); h.questions.next(h.question);
    h.questions.edit(h.question, "实际自由文本"); h.questions.next(h.question); await h.questions.send(h.question);
    assert.deepEqual(h.question.answers, [{ text: "乙", option: 1 }, { text: "实际自由文本" }]);
    const writes = new CodeWrites(h.bridge, h.view, () => true, () => {}, "code");
    writes.edit(session.id, "普通聊天");
    for (const update of h.updates) { writes.update(update); h.questions.update(update); }
    assert.equal(writes.draft(session.id).text, "普通聊天"); assert.equal(writes.entries.size, 0);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("Desktop 回答应答丢失后恢复原回执，双窗口只有一份续接", async () => {
  const h = harness({ lose: true });
  try {
    h.questions.edit(h.question, "回答一"); h.questions.next(h.question); h.questions.edit(h.question, "回答二"); h.questions.next(h.question);
    await h.questions.send(h.question); await h.submissions.reconcile();
    for (const update of h.updates) h.questions.update(update);
    assert.equal(h.pending.list().records.length, 0);
    assert.equal(h.transport.requests.filter(request => request.op === "owner_question_answer").length, 2);
    const second = new DesktopQuestions(h.bridge, h.view, () => true, () => {});
    second.edit(h.view.ownerQuestions[0], "另一窗口一"); second.next(h.view.ownerQuestions[0]); second.edit(h.view.ownerQuestions[0], "另一窗口二"); second.next(h.view.ownerQuestions[0]);
    await second.send(h.view.ownerQuestions[0]);
    assert.match(second.message!, /已被另一客户端消费/);
    assert.deepEqual(h.question.answers, [{ text: "回答一" }, { text: "回答二" }]);
    assert.equal(h.consumed, 1);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("Desktop 取消丢答按原取消回执核实，重复点击不入队", async () => {
  const h = harness({ lose: true });
  try {
    await Promise.all([h.questions.send(h.question, true), h.questions.send(h.question, true)]);
    await h.submissions.reconcile();
    for (const update of h.updates) h.questions.update(update);
    assert.equal(h.question.status, "canceled"); assert.equal(h.question.continuationTaskId, undefined);
    assert.equal(h.pending.list().records.length, 0);
    assert.equal(h.transport.requests.filter(request => request.op === "owner_question_cancel").length, 2);
    assert.equal(h.transport.requests.some(request => request.op === "owner_question_answer"), false);
    assert.equal(h.consumed, 1);
    assert.match(h.questions.message!, /已恢复取消结果/);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("Desktop 多选与 Skip 的完整原回答在丢答后恢复，只有一次续接", async () => {
  const h = harness({ lose: true });
  h.question.questions = [{ question: "交付内容", multiple: true, options: [{ label: "页面", description: "可见页面", recommended: true }, "接口", "文档"] }, { question: "补充说明" }, { question: "发布位置", options: ["本地", "共享"] }];
  try {
    h.questions.choose(h.question, [2, 0]); h.questions.next(h.question);
    h.questions.edit(h.question, "将被跳过"); h.questions.next(h.question, true);
    h.questions.choose(h.question, 1); h.questions.next(h.question, true);
    await h.questions.send(h.question);
    const expected = [{ text: "页面\n文档", options: [0, 2] }, { text: "" }, { text: "" }];
    assert.deepEqual(h.question.answers, expected);
    const saved = h.pending.list();
    assert.deepEqual(saved.corrupt, []); assert.equal(saved.records.length, 1);
    assert.deepEqual(saved.records[0].params.answers, expected);
    const restored = new DesktopQuestions(h.bridge, h.view, () => true, () => {});
    for (const update of h.updates) restored.update(update);
    assert.deepEqual(restored.draft(h.view.ownerQuestions[0]).answers, expected);
    assert.equal(restored.draft(h.view.ownerQuestions[0]).review, true);
    await h.submissions.reconcile();
    for (const update of h.updates) restored.update(update);
    assert.equal(h.pending.list().records.length, 0); assert.equal(h.consumed, 1);
    const requests = h.transport.requests.filter(request => request.op === "owner_question_answer");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => (request.params as { request_id: string }).request_id === saved.records[0].requestId));
    assert.deepEqual(h.question.answers, expected);
  } finally { fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

function maximalQuestion(sessionId: string, id: string, status: "pending" | "answered"): OwnerQuestionView {
  return { id, sessionId, taskId: "source", version: status === "pending" ? 1 : 2, status,
    questions: Array.from({ length: 3 }, (_, index) => ({ question: `完整题目${index}：` + "题".repeat(1990), options: Array.from({ length: 5 }, (_, option) => `${option}` + "选".repeat(199)) })),
    ...(status === "answered" ? { answers: Array.from({ length: 3 }, () => ({ text: "答".repeat(4096) })) } : {}), createdAt: at };
}

test("跨会话最大终态挤掉快照中的待答，TUI 查询恢复完整题目并安装顶部状态", async () => {
  const pending = new PendingRequestStore(fs.mkdtempSync(path.join(os.tmpdir(), "question-page-")));
  const later = { ...session, id: "later" }, question = maximalQuestion(later.id, "later-question", "pending");
  const old = [maximalQuestion(session.id, "old-1", "answered"), maximalQuestion(session.id, "old-2", "answered")];
  assert.ok(Buffer.byteLength(JSON.stringify(old)) <= 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify([...old, question])) > 128 * 1024);
  const view = new ViewState(); view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [session, later], ownerQuestions: old }), replay: [], seq: 0 }, false);
  const transport = new FakeTransport({ handlers: { owner_questions: params => ({ questions: params.session_id === later.id ? [question] : old, nextOffset: 1 }) } });
  const panel = new OwnerQuestions({ request: transport.request.bind(transport), pending, session: () => later, instanceId: () => view.instanceId,
    known: () => view.ownerQuestions, install: (sessionId, questions) => { view.ownerQuestions = [...view.ownerQuestions.filter(item => item.sessionId !== sessionId), ...questions]; }, beforeSend: () => Promise.resolve(), online: () => true, render: () => {}, close: () => {} });
  try {
    assert.equal(view.ownerQuestions.some(item => item.sessionId === later.id), false);
    await panel.refresh();
    assert.deepEqual(view.ownerQuestions.find(item => item.id === question.id), question);
    assert.ok(view.ownerQuestions.some(item => item.sessionId === later.id && item.status === "pending"));
    panel.handleInput("\r"); assert.ok(panel.render(100).join("\n").includes("完整题目0："));
  } finally { fs.rmSync(pending.dir, { recursive: true, force: true }); }
});

test("Desktop 选择及同实例快照主动恢复省略的完整待答卡片", async () => {
  const later = { ...session, id: "later" }, question = maximalQuestion(later.id, "later-question", "pending");
  const old = [maximalQuestion(session.id, "old-1", "answered"), maximalQuestion(session.id, "old-2", "answered")];
  const queried: string[] = [];
  const bridge: Pick<DesktopBridge, "request"> = { request: async (_target, op, params) => {
    if (op === "owner_questions") { queried.push(String(params.session_id)); return { ok: true, value: { questions: params.session_id === later.id ? [question] : old, nextOffset: 1 } }; }
    return { ok: false, error: { code: "unknown_op", outcome: "rejected", message: "未设定" } };
  } };
  const model = new CodeState(bridge, () => {});
  const snapshot: Extract<DesktopUpdate, { type: "snapshot" }> = { type: "snapshot", instanceChanged: false, result: { snapshot: fakeSnapshot({ sessions: [session, later], ownerQuestions: old }), replay: [], seq: 0 } };
  model.update(snapshot); model.view.openSession(later.id).historyLoaded = true;
  model.openSession(later.id); await settle();
  assert.deepEqual(model.view.ownerQuestions.find(item => item.id === question.id), question);
  model.update(snapshot); assert.equal(model.view.ownerQuestions.some(item => item.id === question.id), false);
  await settle(); assert.deepEqual(model.view.ownerQuestions.find(item => item.id === question.id), question);
  assert.equal(queried.filter(id => id === later.id).length, 2);
});

for (const phase of ["sending", "disconnected"] as const) test(`Desktop main 在取消 ${phase} 时拒绝另一窗口换新键回答`, async () => {
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const h = harness(phase === "sending" ? { holdCancel: hold } : { lose: true, lostOutcome: "disconnected" });
  try {
    const cancel = h.submissions.cancelQuestion({ session_id: session.id, question_id: h.question.id, question_version: 1, request_id: "original-cancel" });
    await settle();
    const second = await h.submissions.submit("owner_question_answer", { session_id: session.id, question_id: h.question.id, question_version: 1, request_id: "other-answer", answers: [{ text: "甲", option: 0 }, { text: "说明" }], model_selection: session.modelSelection });
    assert.equal(second.kind, "pending_existing"); if (second.kind === "pending_existing") assert.equal(second.record.op, "owner_question_cancel");
    assert.equal(h.transport.requests.some(request => request.op === "owner_question_answer"), false);
    assert.deepEqual(h.pending.list().records.map(record => record.requestId), ["original-cancel"]);
    release(); await cancel; await h.submissions.reconcile();
    assert.equal(h.consumed, 1); assert.equal(h.pending.list().records.length, 0);
  } finally { release(); fs.rmSync(h.pending.dir, { recursive: true, force: true }); }
});

test("Desktop 问题查询丢弃跨会话迟到页，实时终态不被旧待答页覆盖", async () => {
  const later = { ...session, id: "later" }, pending = maximalQuestion(session.id, "first-question", "pending"), other = maximalQuestion(later.id, "other-question", "pending");
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const bridge: Pick<DesktopBridge, "request"> = { request: async (_target, op, params) => {
    if (op !== "owner_questions") return { ok: false, error: { code: "unknown_op", outcome: "rejected", message: "未设定" } };
    if (++calls === 1) await hold;
    return { ok: true, value: { questions: [params.session_id === later.id ? other : pending], nextOffset: null } };
  } };
  const model = new CodeState(bridge, () => {});
  model.view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [session, later], ownerQuestions: [] }), replay: [], seq: 0 }, false);
  model.view.openSession(session.id).historyLoaded = true; model.view.openSession(later.id).historyLoaded = true;
  model.openSession(session.id); model.openSession(later.id); await settle();
  release(); await settle();
  assert.equal(model.view.ownerQuestions.some(question => question.id === pending.id), false);
  assert.deepEqual(model.view.ownerQuestions.find(question => question.id === other.id), other);
  model.openSession(session.id);
  const answered = { ...pending, version: 2, status: "answered" as const, answers: [{ text: "已答" }, { text: "已答" }, { text: "已答" }] };
  model.update({ type: "event", kind: "live", event: { seq: 1, sessionId: session.id, taskId: "source", createdAt: at, body: { type: "owner_question.changed", question: answered } } });
  await settle();
  assert.deepEqual(model.view.ownerQuestions.find(question => question.id === answered.id), answered);
});

test("TUI 问题查询丢弃跨会话迟到页，并保留实时较新版本", async () => {
  const pendingStore = new PendingRequestStore(fs.mkdtempSync(path.join(os.tmpdir(), "question-query-")));
  const later = { ...session, id: "later" }, first = maximalQuestion(session.id, "first-question", "pending"), other = maximalQuestion(later.id, "other-question", "pending");
  let current = session, release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  let queries = 0, known: OwnerQuestionView[] = [];
  const transport = new FakeTransport({ handlers: { owner_questions: async params => { if (++queries === 1) await hold; return { questions: [params.session_id === later.id ? other : first], nextOffset: null }; } } });
  const panel = new OwnerQuestions({ request: transport.request.bind(transport), pending: pendingStore, session: () => current, instanceId: () => "inst-1", known: () => known,
    install: (sessionId, questions) => { known = [...known.filter(question => question.sessionId !== sessionId), ...questions]; }, beforeSend: () => Promise.resolve(), online: () => true, render: () => {}, close: () => {} });
  try {
    const initial = panel.refresh(); current = later; await panel.refresh(); release(); await initial;
    assert.deepEqual(known, [other]);
    const answered = { ...other, version: 2, status: "answered" as const, answers: [{ text: "已答" }, { text: "已答" }, { text: "已答" }] };
    known = [answered]; await panel.refresh(); assert.deepEqual(known, [answered]);
  } finally { release(); fs.rmSync(pendingStore.dir, { recursive: true, force: true }); }
});
