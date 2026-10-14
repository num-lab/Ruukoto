import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@ruukoto/core/types.ts";
import { getWorkflowQuestion, getWorkflowStep, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { parseImWorkflowCommand } from "@ruukoto/channels/im-workflows.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import { afterTool, lastUserText, realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";

function source(rt: Runtime, session: Session) {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "拥有者请求", accessMode: "confirm",
      modelSelection: rt.defaultSelection, submissionDigest: "source" }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}

test("IM 业务回答只认完整原始命令与 JSON，引用和格式错误不变成批准", () => {
  assert.equal(parseImWorkflowCommand('正文 /workflow-answer r q 1 1 "yes"'), null);
  assert.equal(parseImWorkflowCommand('> /workflow-answer r q 1 1 "yes"'), null);
  assert.deepEqual(parseImWorkflowCommand('/workflow-answer r q 1 1 yes'), { kind: "usage" });
  assert.deepEqual(parseImWorkflowCommand('/workflow-answer r q 0 1 "yes"'), { kind: "usage" });
  assert.deepEqual(parseImWorkflowCommand('/workflow-answer r q 1 1 "yes"'), { kind: "answer", runId: "r", stepKey: "q", runVersion: 1, version: 1, answer: "yes" });
});

test("真实 MCP 步骤审批与业务回答独立；回答有约束、事务回滚与原键回执，整项审批等待停计", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "write", result: { content: [{ type: "text", text: "once" }] } }] });
  const t = await startTestRuntime("workflow-input", req => afterTool(req) || lastUserText(req).startsWith("[工作流最终回报]")
    ? { kind: "text", text: "完成" } : { kind: "tool_calls", calls: [{ id: "write", name: "mcp_probe_write", arguments: {} }] }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    await t.client.request("mcp_configure", { project_id: session.projectId, name: "probe", endpoint: mcp.url, tool_allowlist: [{ name: "write", effect: "write" }] });
    const parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "ask-approval", input: null,
      script: 'return await Promise.all([ask("question",{prompt:"选择",options:["yes","no"],schema:{type:"string"}}),agent("write",{request:"写",tools:["mcp_probe_write"]})]);' });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("人工问题和工具审批都已登记", () => getWorkflowQuestion(rt.store, run.id, "question") !== null && rt.store.listConfirmationsByStatus("pending").length === 1);
    await waitFor("整项等待停计", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    const usage = requireWorkflowRun(rt.store, run.id).usedMs;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(requireWorkflowRun(rt.store, run.id).usedMs, usage);
    const q = getWorkflowQuestion(rt.store, run.id, "question")!;
    const params = { run_id: run.id, step_key: "question", question_version: q.version, run_version: q.runVersion, request_id: "answer", answer: "yes" };
    await assert.rejects(t.client.request("workflow_answer", { ...params, answer: "bad" }), { code: "invalid_answer" });
    await assert.rejects(t.client.request("workflow_answer", { ...params, run_version: q.runVersion + 1 }), { code: "stale_answer" });
    await assert.rejects(t.client.request("workflow_answer", { ...params, step_key: "wrong" }), { code: "question_missing" });
    assert.throws(() => rt.workflows!.answer(run.id, "question", q.version, "yes", { ...q.source, sessionId: "foreign" },
      { requestKey: "foreign", runVersion: q.runVersion }), { code: "stale_answer" });
    assert.throws(() => rt.answerWorkflowQuestion({ runId: run.id, stepKey: "question", version: q.version, runVersion: q.runVersion,
      requestKey: "rollback", answer: "yes", txExtra: () => { throw new Error("回执写入故障"); } }), /回执写入故障/);
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.status, "pending");
    assert.equal(rt.store.db.prepare("SELECT 1 FROM workflow_controls WHERE run_id = ? AND request_key = 'rollback'").get(run.id), undefined);
    const accepted = await t.client.request("workflow_answer", params);
    assert.deepEqual(await t.client.request("workflow_answer", params), accepted);
    await assert.rejects(t.client.request("workflow_answer", { ...params, answer: "no" }), { code: "request_conflict" });
    await assert.rejects(t.client.request("workflow_answer", { ...params, request_id: "another" }), { code: "stale_answer" });
    const confirmation = rt.store.listConfirmationsByStatus("pending")[0];
    assert.equal(confirmation.consumedAt, null);
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    await waitFor("回答后只等待工具审批", () => requireWorkflowRun(rt.store, run.id).status === "waiting" && requireWorkflowRun(rt.store, run.id).reason === "tool_approval");
    const question = await t.client.request<{ text: string; status: string; choices?: string[]; schema?: unknown }>("workflow_question", { run_id: run.id, step_key: "question" });
    assert.equal(question.status, "answered"); assert.match(question.text, /yes/);
    assert.deepEqual(question.choices, ["yes", "no"]);
    assert.deepEqual(question.schema, { type: "string" });
    await t.client.request("respond_confirmation", { confirmation_id: confirmation.id, permission_version: confirmation.permissionVersion, decision: "approve" });
    await waitFor("整项成功", () => requireWorkflowRun(rt.store, run.id).status === "succeeded");
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
    assert.equal(getWorkflowStep(rt.store, run.id, "question")!.status, "completed");
    assert.equal(rt.store.getConfirmation(confirmation.id)!.consumedAt !== null, true);
    assert.equal(t.server.calls.length, 2, "步骤调用两轮；原会话人工暂停，汇总仍排队");
  } finally { await t.shutdown(); await mcp.close(); }
});

for (const order of ["answer-first", "cancel-first"] as const) test(`回答与取消 ${order}：同步仲裁，取消后原回执可查且新回答不能续跑`, async () => {
  const t = await startTestRuntime("workflow-input-cancel", async () => ({ kind: "text", text: "unused" }));
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "cancel", input: null,
      script: 'await ask("question",{prompt:"继续?"}); return await ask("second",{prompt:"第二阶段"});' });
    await waitFor("等待问题", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    const q = getWorkflowQuestion(rt.store, run.id, "question")!;
    const input = { runId: run.id, stepKey: "question", version: q.version, runVersion: q.runVersion, requestKey: "answer", answer: "yes" };
    if (order === "answer-first") rt.answerWorkflowQuestion(input);
    await rt.workflows!.control(run.id, "cancel", requireWorkflowRun(rt.store, run.id).version, { action: "cancel" });
    if (order === "answer-first") assert.equal(rt.answerWorkflowQuestion(input).status, "answered");
    else assert.throws(() => rt.answerWorkflowQuestion(input), { code: "stale_answer" });
    assert.throws(() => rt.answerWorkflowQuestion({ ...input, requestKey: "late" }), { code: "stale_answer" });
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "canceled");
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.status, order === "answer-first" ? "answered" : "canceled");
    await waitFor("取消事实报告已保存", () => requireWorkflowRun(rt.store, run.id).delivery !== undefined);
    assert.doesNotMatch(requireWorkflowRun(rt.store, run.id).delivery!.text, /结果资料/);
    assert.equal(rt.store.listTasksBySession(session.id).filter(task => task.requestId.startsWith("workflow:")).length, 0);
  } finally { await t.shutdown(); }
});

for (const phase of ["answer", "final"] as const) test(`问题依赖记忆撤销在 ${phase} 前复核，旧正文不进入后续模型`, async () => {
  const t = await startTestRuntime("workflow-input-source", req => afterTool(req) ? { kind: "text", text: "DERIVED-MEMORY" }
    : { kind: "tool_calls", calls: [{ id: "memory", name: "memory_list", arguments: {} }] }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const memory = rt.ownerSaveMemory({ projectId: session.projectId, category: "experience", content: "DERIVED-MEMORY",
      sourceRefs: [{ kind: "owner_note", note: "拥有者提供" }] });
    const parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "memory", input: null,
      script: 'const value=await agent("read",{request:"列出记忆",tools:["memory_list"]}); return await ask("question",{prompt:value,dependsOn:["read"]});' });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("问题持有已读记忆的依赖", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    assert.deepEqual(getWorkflowStep(rt.store, run.id, "read")!.readMemories, [memory.id]);
    const q = getWorkflowQuestion(rt.store, run.id, "question")!;
    const input = { runId: run.id, stepKey: "question", version: q.version, runVersion: q.runVersion, requestKey: "answer", answer: "yes" };
    if (phase === "final") {
      rt.answerWorkflowQuestion(input);
      await waitFor("最终汇总已排队", () => requireWorkflowRun(rt.store, run.id).delivery?.taskId != null);
    }
    const calls = t.server.calls.length;
    rt.ownerRevokeMemory({ memoryId: memory.id, expectedVersion: memory.currentVersion });
    if (phase === "answer") {
      assert.throws(() => rt.answerWorkflowQuestion(input), { code: "stale_answer" });
      assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.status, "pending");
      assert.equal(getWorkflowStep(rt.store, run.id, "question")!.status, "waiting");
    } else {
      await rt.resumeQueue(session.id);
      await waitFor("缓存最终正文不进入模型", () => requireWorkflowRun(rt.store, run.id).delivery?.status === "undelivered");
      assert.equal(requireWorkflowRun(rt.store, run.id).delivery!.reason, "source_invalid");
    }
    assert.equal(t.server.calls.length, calls);
  } finally { await t.shutdown(); }
});
