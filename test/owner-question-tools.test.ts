import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { cancelOwnerQuestion, consumeOwnerQuestion, createOwnerQuestion, findOwnerQuestionByOp, getOwnerQuestion, getOwnerQuestionReceipt, invalidateOwnerQuestionsForTask, listOwnerQuestions, ownerQuestionCreatedByTask, ownerQuestionTaskEligible, ownerQuestionToView, parseOwnerAnswers, parseOwnerQuestions, type OwnerQuestionItem } from "@ruukoto/core/owner-questions.ts";
import { createOwnerQuestionFamily } from "@ruukoto/agent/owner-question-tools.ts";
import type { HostToolRuntime } from "@ruukoto/agent/host-tool-families.ts";
import { createManagedProcessRegistry } from "@ruukoto/agent/managed-processes.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { allowsCategory, sourceAllows, subAgentAllows, taskToolSet, workflowAllows } from "@ruukoto/agent/tool-availability.ts";

const questions: OwnerQuestionItem[] = [{ question: "选择发布目标", options: ["测试", "生产"] }, { question: "说明约束" }];
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-question-tools-")), db = new Db(root), store = new Store(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const stat = fs.statSync(root);
  const project = store.withTx(() => store.createProject("questions"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "question", confirmTools: [] }));
  let count = 0;
  const queued = (requestId = `task-${++count}`) => store.insertQueuedTask({ sessionId: session.id, requestId, input: "实际拥有者输入", modelSelection: { provider: "fake", modelId: "fake", thinkingLevel: "off" }, submissionDigest: requestId }).task;
  const task = store.withTx(() => { const task = queued(); store.transitionTask(task.id, ["queued"], "running"); return store.getTask(task.id)!; });
  const op = (items = questions) => store.withTx(() => {
    const hostOpId = `ask-${++count}`;
    store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: session.id, toolName: "ask_user", params: { questions: items } });
    return { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId, questions: items };
  });
  const create = () => { const input = op(); return store.withTx(() => createOwnerQuestion(store, input)); };
  return { root, db, store, project, session, task, op, queued, create };
}

test("题目与答案完整校验，选项没有默认补齐，额外字段不能变成授权", () => {
  assert.deepEqual(parseOwnerQuestions(questions), questions);
  for (const value of [[], Array(4).fill(questions[0]), [{ question: " " }], [{ question: "x".repeat(2001) }], [{ question: "q", options: ["重复", "重复"] }], [{ question: "q", options: ["x"] }], [{ question: "q", options: ["x", "y".repeat(201)] }], [{ question: "q", target: "外部用户" }]]) assert.throws(() => parseOwnerQuestions(value), { code: "invalid_params" });
  assert.deepEqual(parseOwnerAnswers([{ text: "生产", option: 1 }, { text: "自由答案" }], questions), [{ text: "生产", option: 1 }, { text: "自由答案" }]);
  assert.deepEqual(parseOwnerAnswers([{ text: "其他目标" }, { text: "自由答案" }], questions)[0], { text: "其他目标" });
  for (const answer of [[], [{ text: "生产" }], [{ text: "测试", option: 1 }, { text: "回答" }], [{ text: "生产", option: -1 }, { text: "回答" }], [{ text: "生产", option: 0.5 }, { text: "回答" }], [{ text: "生产", option: 2 }, { text: "回答" }], [{ text: "生产" }, { text: "回答", option: 0 }], [{ text: "生产", approved: true }, { text: "回答" }], [{ text: "生产" }, { text: "x".repeat(4097) }]]) assert.throws(() => parseOwnerAnswers(answer, questions), { code: "invalid_params" });
});

test("选项说明与推荐不改变答案，单选、多选、自由输入和跳题各自校验", () => {
  const items: OwnerQuestionItem[] = [
    { question: "选择范围", options: [{ label: "本地", description: "仅保存在当前工作区", recommended: true }, "共享"] },
    { question: "选择检查", options: [{ label: "静态", description: "x".repeat(500), recommended: false }, { label: "定向测试" }, "构建"], multiple: true },
    { question: "备注" },
  ];
  assert.deepEqual(parseOwnerQuestions(items), items);
  assert.deepEqual(parseOwnerAnswers([{ text: "本地", option: 0 }, { text: "静态\n构建", options: [0, 2] }, { text: "" }], items),
    [{ text: "本地", option: 0 }, { text: "静态\n构建", options: [0, 2] }, { text: "" }]);
  assert.deepEqual(parseOwnerAnswers([{ text: "自由目标" }, { text: "自由检查" }, { text: "自由备注" }], items),
    [{ text: "自由目标" }, { text: "自由检查" }, { text: "自由备注" }]);
  for (const options of [
    [{ label: "同名" }, "同名"], [{ label: "同名", description: "甲" }, { label: "同名", description: "乙" }],
    [{ label: " " }, "另一项"], [{ label: "x".repeat(201) }, "另一项"], [{ label: "选项", description: "x".repeat(501) }, "另一项"],
    [{ label: "选项", description: 1 }, "另一项"], [{ label: "选项", recommended: "true" }, "另一项"], [{ label: "选项", approved: true }, "另一项"],
  ]) assert.throws(() => parseOwnerQuestions([{ question: "题目", options }]), { code: "invalid_params" });
  for (const item of [{ question: "题目", multiple: true }, { question: "题目", multiple: "true", options: ["甲", "乙"] }])
    assert.throws(() => parseOwnerQuestions([item]), { code: "invalid_params" });
  const valid = [{ text: "本地", option: 0 }, { text: "静态\n构建", options: [0, 2] }, { text: "" }];
  for (const answer of [
    { text: "", option: 0 }, { text: "本地", option: 0, options: [0] }, { text: "本地", options: [0] }, { text: "本地", option: undefined },
  ]) assert.throws(() => parseOwnerAnswers([answer, ...valid.slice(1)], items), { code: "invalid_params" });
  for (const answer of [
    { text: "静态", option: 0 }, { text: "", options: [] }, { text: "", options: undefined }, { text: "静态", options: [0, 0] },
    { text: "构建\n静态", options: [2, 0] }, { text: "伪造", options: [0] }, { text: "静态", options: [-1] },
    { text: "静态", options: [0.5] }, { text: "静态", options: [3] }, { text: "静态", options: ["0"] }, { text: "静态", options: [0], option: 0 },
  ]) assert.throws(() => parseOwnerAnswers([valid[0], answer, valid[2]], items), { code: "invalid_params" });
  for (const answer of [{ text: " " }, { text: "", option: 0 }, { text: "", options: [] }, { text: "", skipped: true }])
    assert.throws(() => parseOwnerAnswers([...valid.slice(0, 2), answer], items), { code: "invalid_params" });
});

test("带说明的对象选项与旧字符串选项原样保存，跳题及多选回执可重读", t => {
  const f = fixture(t), items: OwnerQuestionItem[] = [
    { question: "检查范围", options: [{ label: "静态", description: "检查类型", recommended: true }, "测试"], multiple: true },
    { question: "备注" },
  ];
  const input = f.op(items), question = f.store.withTx(() => createOwnerQuestion(f.store, input));
  assert.deepEqual(getOwnerQuestion(f.store, question.id)!.questions, items);
  assert.deepEqual(f.store.withTx(() => createOwnerQuestion(f.store, input)).questions, items);
  const answers = [{ text: "静态\n测试", options: [0, 1] }, { text: "" }];
  const receipt = f.store.withTx(() => consumeOwnerQuestion(f.store, { questionId: question.id, sessionId: f.session.id, version: 1,
    requestKey: "answer", requestDigest: "answer-digest", answers }));
  assert.deepEqual(getOwnerQuestion(f.store, question.id)!.answers, answers);
  assert.deepEqual(getOwnerQuestionReceipt(f.store, f.session.id, "answer"), receipt);
  assert.deepEqual(receipt.question.questions, items);
});

test("提问与事件同事务，同操作去重，其他操作不能覆盖待答批次", t => {
  const f = fixture(t), input = f.op(), before = f.store.getEventsAfter(0).length;
  const question = f.store.withTx(() => createOwnerQuestion(f.store, input));
  assert.equal(f.store.getEventsAfter(0).length, before + 1);
  assert.equal(question.source.input, f.task.input);
  assert.equal(question.source.permissionVersion, f.task.permissionVersion);
  assert.equal(question.source.kind, "coding-owner");
  assert.deepEqual(f.store.withTx(() => createOwnerQuestion(f.store, input)), question);
  assert.equal(f.store.getEventsAfter(0).length, before + 1);
  const other = f.op();
  assert.throws(() => f.store.withTx(() => createOwnerQuestion(f.store, other)), { code: "question_pending" });
  assert.equal(listOwnerQuestions(f.store, f.session.id).length, 1);
  assert.throws(() => f.store.withTx(() => createOwnerQuestion(f.store, { ...input, questions: [{ question: "不同" }] })), { code: "request_conflict" });
  assert.equal("source" in ownerQuestionToView(question), false);
  assert.equal(ownerQuestionToView(question).hostOpId, input.hostOpId);
});

test("Terminal Tasks invalidate pending questions without deleting their history", t => {
  const f = fixture(t), question = f.create();
  f.store.withTx(() => {
    f.store.endTask(f.task.id, ["running"], "completed");
    f.db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), f.session.id);
  });
  assert.equal(getOwnerQuestion(f.store, question.id)?.status, "stale");
  f.store.withTx(() => invalidateOwnerQuestionsForTask(f.store, f.task.id));
  assert.equal(getOwnerQuestion(f.store, question.id)?.status, "stale");
  assert.equal(getOwnerQuestion(f.store, question.id)?.version, 2);
  assert.equal(ownerQuestionCreatedByTask(f.store, f.task.id), true);
});

test("事务失败回滚问题消费、答案、唯一续接 Task 与事件", t => {
  const f = fixture(t), question = f.create(), before = f.store.getEventsAfter(0).length, committed: unknown[] = [];
  f.store.onCommitted = events => committed.push(events);
  assert.throws(() => f.store.withTx(() => {
    consumeOwnerQuestion(f.store, { questionId: question.id, sessionId: f.session.id, version: 1, requestKey: "answer", requestDigest: "answer-digest", answers: [{ text: "生产", option: 1 }, { text: "真实回答" }] });
    throw new Error("事务故障");
  }), /事务故障/);
  assert.equal(getOwnerQuestion(f.store, question.id)?.status, "pending");
  assert.equal(getOwnerQuestionReceipt(f.store, f.session.id, "answer"), null);
  assert.equal(f.store.listTasksBySession(f.session.id).length, 1);
  assert.equal(f.store.getEventsAfter(0).length, before);
  assert.deepEqual(committed, []);
});

test("回答同键重连取原回执，同键异参及第二客户端不能二次消费", t => {
  const f = fixture(t), question = f.create();
  const input = { questionId: question.id, sessionId: f.session.id, version: 1, requestKey: "answer", requestDigest: "answer-digest", answers: [{ text: "生产", option: 1 }, { text: "真实回答" }] };
  const receipt = f.store.withTx(() => consumeOwnerQuestion(f.store, input)), count = f.store.getEventsAfter(0).length;
  assert.equal(receipt.question.status, "answered");
  assert.equal(receipt.question.version, 2);
  assert.equal(receipt.taskId, f.task.id);
  assert.deepEqual(getOwnerQuestionReceipt(f.store, f.session.id, "answer", "owner_question_answer"), receipt);
  assert.deepEqual(f.store.withTx(() => consumeOwnerQuestion(f.store, input)), receipt);
  assert.equal(f.store.getEventsAfter(0).length, count);
  assert.throws(() => f.store.withTx(() => consumeOwnerQuestion(f.store, { ...input, requestDigest: "other" })), { code: "request_conflict" });
  assert.throws(() => f.store.withTx(() => consumeOwnerQuestion(f.store, { ...input, requestKey: "client-two", requestDigest: "second" })), { code: "question_version" });
  assert.throws(() => f.store.withTx(() => cancelOwnerQuestion(f.store, { questionId: question.id, sessionId: f.session.id, version: 1, requestKey: "cancel", requestDigest: "cancel" })), { code: "question_version" });
  assert.equal(getOwnerQuestion(f.store, question.id)?.answerSource, undefined);
  assert.ok(getOwnerQuestion(f.store, question.id)?.answerSeq);
});

test("取消回执可重取，不能生成答案与续接；答案与取消同键冲突", t => {
  const f = fixture(t), question = f.create(), input = { questionId: question.id, sessionId: f.session.id, version: 1, requestKey: "cancel", requestDigest: "cancel" };
  const canceled = f.store.withTx(() => cancelOwnerQuestion(f.store, input));
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.answers, undefined);
  assert.equal(canceled.continuationTaskId, undefined);
  assert.equal(f.store.listTasksBySession(f.session.id).length, 1);
  assert.deepEqual(f.store.withTx(() => cancelOwnerQuestion(f.store, input)), canceled);
  assert.equal(getOwnerQuestionReceipt(f.store, f.session.id, "cancel", "owner_question_cancel")?.question.status, "canceled");
  assert.throws(() => f.store.withTx(() => consumeOwnerQuestion(f.store, { ...input, answers: [{ text: "生产", option: 1 }, { text: "回答" }] })), { code: "request_conflict" });
});

test("真实拥有者来源才能提问，Plan保留资格，当前轮只开放宿主状态查询", t => {
  const f = fixture(t);
  assert.equal(ownerQuestionTaskEligible(f.store, f.task), true);
  for (const task of [{ ...f.task, parentTaskId: f.task.id }, { ...f.task, sourceEventId: "event" }, { ...f.task, sourcePermissionVersion: 1 }, { ...f.task, workId: "work" }, { ...f.task, subAgentId: "sub" }]) assert.equal(ownerQuestionTaskEligible(f.store, task), false);
  assert.equal(allowsCategory("dev", "owner_question"), true);
  assert.equal(allowsCategory("main", "owner_question"), false);
  assert.equal(subAgentAllows({ write: true, review: false }, "ask_user"), false);
  const profile = { toolClass: "dev" as const, sourceProjectId: f.project.id, categories: ["owner_question" as const], tools: ["ask_user"] };
  assert.equal(sourceAllows(profile, "ask_user"), false);
  assert.equal(workflowAllows(profile, "ask_user"), false);
  const registered = ["ask_user", "read", "write", "bash", "browser", "subagent_result", "workflow_query", "workflow_instructions", "memory_read", "read_artifact", "mcp_read"];
  const input = { registered, plan: true, webSearchEnabled: true, browserEnabled: true, ownerQuestionsEnabled: true, mcpEffect: (name: string) => name === "mcp_read" ? "read" as const : undefined };
  assert.equal(taskToolSet(input).allowed.has("ask_user"), true);
  f.create();
  assert.deepEqual([...taskToolSet({ ...input, plan: false, ownerQuestionPending: ownerQuestionCreatedByTask(f.store, f.task.id) }).allowed], registered.slice(5, 8));
  const next = f.store.withTx(() => f.queued());
  assert.equal(ownerQuestionCreatedByTask(f.store, next.id), false);
  assert.equal(taskToolSet(input).allowed.has("read"), true);
});

test("ask_user waits for its original question result and releases the host handle after cancellation", async t => {
  const f = fixture(t), input = f.op(), family = createOwnerQuestionFamily(f.store);
  let released = 0, resolve!: (question: ReturnType<typeof createOwnerQuestion>) => void;
  const waiting = new Promise<ReturnType<typeof createOwnerQuestion>>(done => { resolve = done; });
  const runtime: HostToolRuntime = {
    registry: createManagedProcessRegistry(), toolClass: "dev",
    call: { taskContext: () => input, bindCall: () => ({ context: input, release: () => { released++; } }) },
    identity: { verifyMain: () => null, verifyHost: () => null },
    approval: { request: () => assert.fail("Business questions do not approve operations"), requestStanding: () => assert.fail() },
    effects: { recordArtifact: () => assert.fail(), markEffectUnknown: () => assert.fail() }, skills: () => null,
    ownerQuestions: {
      create: (ctx, items) => f.store.withTx(() => createOwnerQuestion(f.store, { ...ctx, questions: items })),
      wait: async () => waiting,
    },
  };
  const tool = family.build(runtime)[0], sdkContext = {} as Parameters<typeof tool.execute>[4];
  let finished = false;
  const running = tool.execute("ask", { questions }, undefined, undefined, sdkContext).then(result => { finished = true; return result; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(released, 0);
  const question = findOwnerQuestionByOp(f.store, input.hostOpId)!;
  assert.deepEqual(question.questions, questions);
  resolve(f.store.withTx(() => cancelOwnerQuestion(f.store, { questionId: question.id, sessionId: f.session.id,
    version: question.version, requestKey: "cancel-wait", requestDigest: "cancel-wait" })));
  const result = await running;
  assert.match(JSON.stringify(result.content), /canceled/);
  assert.doesNotMatch(JSON.stringify(result.content), /"answers"/);
  assert.equal(released, 1);
  const uncommitted = f.op(), ledger = new ToolOpLedger(f.store, {}, [family.ledger!]);
  f.store.withTx(() => ledger.settleAll());
  assert.equal(f.store.getToolOp(input.hostOpId)?.isError, false);
  assert.match(f.store.getToolOp(input.hostOpId)?.resultSummary ?? "", /不证明回答已交给模型/);
  assert.equal(f.store.getToolOp(uncommitted.hostOpId)?.isError, true);
  assert.equal(f.store.getTask(f.task.id)?.effectUnknown, false);
});

test("持久答案缺失不能被恢复成已回答，问题查询有界且待答优先", t => {
  const f = fixture(t), question = f.create();
  assert.equal(listOwnerQuestions(f.store, f.session.id, 1)[0].id, question.id);
  assert.throws(() => listOwnerQuestions(f.store, f.session.id, 101), { code: "invalid_params" });
  f.db.prepare("UPDATE owner_questions SET status = 'answered', payload = ? WHERE id = ?").run(JSON.stringify({ ...question, status: "answered", version: 2 }), question.id);
  assert.throws(() => getOwnerQuestion(f.store, question.id), { code: "question_corrupt" });
});
