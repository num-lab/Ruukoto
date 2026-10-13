import assert from "node:assert/strict";
import { test } from "node:test";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { getWorkflowQuestion, listWorkflowRuns, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

for (const changed of [false, true]) test(`Telegram 工作流 ${changed ? "入口换代" : "未知发送与恢复"}：问题失败不代答，最终不改发、不重发`, async () => {
  const api = new FakeBotApi({ token: "123:workflow-recovery", ownerId: 42 }), apiBase = await api.start();
  api.behavior = body => String(body.text).startsWith("【工作流需要回答】") || String(body.text).includes("IM-FINAL")
    ? { status: 500, body: { ok: false, description: "效果未知" } }
    : { status: 200, body: { ok: true, result: { message_id: api.sends.length } } };
  let rt!: Runtime;
  const t = await startTestRuntime("workflow-notice-recovery", req => {
    const text = lastUserText(req);
    if (text.includes("START-WORKFLOW") && !text.startsWith("[工作流最终回报]")) {
      const main = rt.store.getAgentRole("main")!;
      const source = rt.store.listTasksBySession(main.sessionId).find(task => task.status === "running")!;
      rt.workflows!.start({ sourceTaskId: source.id, requestKey: "notice", input: null, script: 'return await ask("question",{prompt:"需要回答",options:["yes","no"]});' });
      return { kind: "text", text: "已受理" };
    }
    return { kind: "text", text: text.startsWith("[工作流最终回报]") ? "IM-FINAL" : "CHAT-OK" };
  }, { config: { qqDisabled: true, scheduler: { tickMs: 20 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } } });
  rt = t.runtime;
  let current = rt;
  try {
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: "123:workflow-recovery" });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
    api.push({ text: "START-WORKFLOW" });
    await waitFor("问题通知效果未知", () => rt.sched.listOps({ limit: 50 }).items.some(op => op.sourceKind === "workflow_question" && op.status === "effect_unknown"));
    const run = listWorkflowRuns(rt.store)[0], q = getWorkflowQuestion(rt.store, run.id, "question")!;
    assert.equal(q.status, "pending"); assert.equal(requireWorkflowRun(rt.store, run.id).status, "waiting");
    assert.equal(rt.store.listConfirmationsByStatus("approved").length, 0);
    const command = `/workflow-answer ${run.id} question ${q.runVersion} ${q.version} "yes"`;
    api.push({ text: command, forwardOrigin: { type: "user", sender_user: { id: 42 }, date: 1 } });
    await waitFor("转发正文按普通聊天处理", () => t.server.calls.length === 2);
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.status, "pending");
    t.client.close(); await rt.stop("test_restart");
    current = await Runtime.start(rt.config); rt = current;
    const beforeResume = requireWorkflowRun(rt.store, run.id);
    await rt.workflows!.control(run.id, "resume", beforeResume.version, { action: "resume" });
    await waitFor("恢复同一待答问题", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.runVersion, q.runVersion);
    assert.equal(api.sends.filter(body => String(body.text).startsWith("【工作流需要回答】")).length, 1);
    if (changed) rt.store.withTx(() => rt.store.setSessionQueueState(run.source.sessionId, "paused", "test_generation"));
    api.push({ text: command });
    await waitFor("最终汇总绑定已登记", () => requireWorkflowRun(rt.store, run.id).delivery?.taskId != null);
    const taskId = requireWorkflowRun(rt.store, run.id).delivery!.taskId!;
    if (changed) {
      await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "43" });
      await rt.resumeQueue(run.source.sessionId);
      await waitFor("原来源失效不进入模型", () => requireWorkflowRun(rt.store, run.id).delivery?.status === "undelivered");
      assert.equal(rt.store.getTask(taskId)!.status, "canceled");
      assert.equal(api.sends.filter(body => String(body.text).includes("IM-FINAL")).length, 0);
      assert.equal(t.server.calls.length, 2);
    } else {
      await waitFor("最终回报效果未知", () => rt.sched.listOps({ limit: 100 }).items.some(op => op.sourceKind === "owner_reply" && op.sourceKey.includes("#workflow-final:") && op.status === "effect_unknown"));
      const op = rt.sched.listOps({ limit: 100 }).items.find(item => item.sourceKey.includes("#workflow-final:"))!;
      await rt.stop("test_restart"); current = await Runtime.start(rt.config); rt = current;
      await rt.scheduler!.tick(); await rt.scheduler!.idle();
      assert.equal(rt.sched.getOp(op.id)!.status, "effect_unknown");
      assert.equal(requireWorkflowRun(rt.store, run.id).delivery!.taskId, taskId);
      assert.equal(rt.sched.listOps({ limit: 100 }).items.filter(item => item.sourceKey.includes("#workflow-final:")).length, 1);
      assert.equal(api.sends.filter(body => String(body.text).includes("IM-FINAL")).length, 1);
      assert.equal(t.server.calls.length, 3);
    }
  } finally { await current.stop("test_end"); await t.shutdown(); await api.close(); }
});

test("问题通知限流后撤销依赖记忆：发送前取消旧正文，回答消费也拒绝", async () => {
  const api = new FakeBotApi({ token: "123:workflow-source", ownerId: 42 }), apiBase = await api.start();
  api.behavior = body => String(body.text).startsWith("【工作流需要回答】")
    ? { status: 429, body: { ok: false, parameters: { retry_after: 3600 } } }
    : { status: 200, body: { ok: true, result: { message_id: api.sends.length } } };
  let rt!: Runtime;
  const t = await startTestRuntime("workflow-notice-source", req => {
    const text = lastUserText(req);
    if (text.includes("START-MEMORY") && !text.startsWith("[工作流最终回报]")) {
      const main = rt.store.getAgentRole("main")!, task = rt.store.listTasksBySession(main.sessionId).find(item => item.status === "running")!;
      rt.workflows!.start({ sourceTaskId: task.id, requestKey: "source", input: null,
        script: 'const value=await agent("read",{request:"列出记忆",tools:["memory_list"]}); return await ask("question",{prompt:value,dependsOn:["read"]});' });
      return { kind: "text", text: "已受理" };
    }
    if (req.messages.at(-1)?.role === "tool") return { kind: "text", text: "PRIVATE-DERIVED-MEMORY" };
    return { kind: "tool_calls", calls: [{ id: "memory", name: "memory_list", arguments: {} }] };
  }, { config: { qqDisabled: true, scheduler: { tickMs: 20 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } } });
  rt = t.runtime;
  try {
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: "123:workflow-source" });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
    const main = rt.store.getAgentRole("main")!;
    const memory = rt.ownerSaveMemory({ projectId: main.projectId, category: "experience", content: "PRIVATE-DERIVED-MEMORY",
      sourceRefs: [{ kind: "owner_note", note: "拥有者提供" }] });
    api.push({ text: "START-MEMORY" });
    await waitFor("问题通知按原键限流等待", () => rt.sched.listOps({ limit: 100 }).items.some(op => op.sourceKind === "workflow_question" && op.notBefore !== null));
    const run = listWorkflowRuns(rt.store)[0], q = getWorkflowQuestion(rt.store, run.id, "question")!;
    const notice = rt.sched.listOps({ limit: 100 }).items.find(op => op.sourceKind === "workflow_question")!;
    const calls = t.server.calls.length;
    rt.ownerRevokeMemory({ memoryId: memory.id, expectedVersion: memory.currentVersion });
    assert.throws(() => rt.answerWorkflowQuestion({ runId: run.id, stepKey: q.stepKey, version: q.version, runVersion: q.runVersion, requestKey: "answer", answer: "yes" }), { code: "stale_answer" });
    rt.store.withTx(() => rt.store.db.prepare("UPDATE notification_ops SET not_before = NULL WHERE id = ?").run(notice.id));
    await rt.scheduler!.tick(); await rt.scheduler!.idle();
    assert.equal(rt.sched.getOp(notice.id)!.status, "canceled");
    assert.equal(api.sends.filter(body => String(body.text).startsWith("【工作流需要回答】")).length, 1);
    assert.equal(getWorkflowQuestion(rt.store, run.id, "question")!.status, "pending");
    assert.equal(t.server.calls.length, calls);
  } finally { await t.shutdown(); await api.close(); }
});
