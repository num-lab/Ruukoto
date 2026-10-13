import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { ImWorkflows, parseImWorkflowCommand } from "@ruukoto/channels/im-workflows.ts";
import { telegramExternalId } from "@ruukoto/channels/telegram/adapter.ts";
import { getWorkflowControlDigest, getWorkflowQuestion, listWorkflowRuns, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import type { NotifyTarget } from "@ruukoto/core/types.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET, startMockOneBot } from "./helpers/mock-onebot.ts";
import { lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

const SCRIPT = 'await progress("state",{text:input.marker}); return await ask("question",{prompt:"选择",options:["yes","no"]});';

test("IM 控制只解析完整原文与精确定位，JSON 空白保留，非法预算和伪造确认拒绝", () => {
  assert.deepEqual(parseImWorkflowCommand('/workflow-run batch {"text":"a  b"}'), { kind: "run", name: "batch", input: { text: "a  b" } });
  assert.equal(parseImWorkflowCommand("> /workflow-cancel run 1"), null);
  assert.equal(parseImWorkflowCommand("引用正文 /workflow-cancel run 1"), null);
  assert.deepEqual(parseImWorkflowCommand('/workflow-cancel run 1 {"budget":1000}'), { kind: "usage" });
  assert.deepEqual(parseImWorkflowCommand('/workflow-resume run 1 {"authority":{}}'), { kind: "usage" });
  assert.deepEqual(parseImWorkflowCommand('/workflow-budget run 1 {"maxAttempts":0,"durationMs":1000}'), { kind: "usage" });
  assert.deepEqual(parseImWorkflowCommand('/workflow-resume run 1 {"clockConfirmed":true}'), { kind: "control", runId: "run", version: 1, control: { action: "resume", clockConfirmed: true } });
});

for (const platform of ["telegram", "qq_private"] as const) test(platform + " 完整显式启动/查看/暂停/恢复/回答，跨入口及引用不控制，最终只回报一次", async () => {
  const api = new FakeBotApi({ token: "123:workflow-controls", ownerId: 42 }), apiBase = await api.start();
  const qq = await startMockOneBot({});
  const t = await startTestRuntime("workflow-im-controls", req => ({ kind: "text", text: lastUserText(req).startsWith("[工作流最终回报]") ? "IM-FINAL" : "CHAT-OK" }), {
    config: { scheduler: { tickMs: 20 }, qq: { actionTimeoutMs: 400, probeIntervalMs: 100, reconnectMinMs: 30, reconnectMaxMs: 100 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } },
  });
  let seq = 1000;
  const push = (text: string, on = platform) => {
    if (on === "telegram") return api.push({ text });
    const messageId = seq++; qq.pushPrivateMessage({ userId: "880001", messageId, segments: [{ type: "text", data: { text } }] }); return messageId;
  };
  try {
    const rt = t.runtime;
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: "123:workflow-controls" });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await rt.addCredentialBinding({ name: "qq", host: qq.host, header: "authorization", purpose: "qq_onebot", secret: MOCK_QQ_SECRET });
    await rt.qqConfigure({ endpoint: qq.url, selfId: MOCK_QQ_ACCOUNT, credential: "qq", ownerUserId: "880001" }); await rt.qqSetEnabled(true);
    await waitFor("双平台在线", () => rt.telegramStatus().online === true && rt.qqStatus().online === true);
    await rt.saveWorkflowDefinition({ name: "batch", script: SCRIPT, expectedDigest: null, requestKey: "owner:save" });
    const original = push('/workflow-run batch {"marker":"PHASE"}');
    await waitFor("显式问题及控制回执", () => listWorkflowRuns(rt.store)[0]?.status === "waiting" && rt.sched.listOps({ limit: 100 }).items.some(op => op.text.startsWith("已启动工作流") && op.status === "sent"));
    const run = listWorkflowRuns(rt.store)[0];
    assert.equal(t.server.calls.length, 0, "显式发起没有普通 main 模型调用或普通任务回复");
    assert.equal(rt.sched.listOps({ limit: 100 }).items.filter(op => op.sourceKind === "owner_reply").length, 0);
    assert.equal(rt.store.getTask(run.source.taskId)!.resultSummary!.startsWith("已启动工作流"), true);
    push("/workflow-definitions"); push("/workflow-show " + run.id); push("/workflow-logs " + run.id);
    await waitFor("定义、状态及日志回执", () => rt.sched.listOps({ limit: 100 }).items.some(op => op.text.includes("PHASE") && op.sourceKind === "inbound_event"));
    const other = platform === "telegram" ? "qq_private" : "telegram";
    const beforeInputs = rt.store.getEventsAfter(0).filter(event => event.body.type === "workflow.input").length;
    push("/workflow-cancel " + run.id + " " + requireWorkflowRun(rt.store, run.id).version, other);
    await waitFor("跨入口拒绝", () => rt.store.getEventsAfter(0).filter(event => event.body.type === "workflow.input" && event.body.outcome === "not_found").length >= 1);
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "waiting");
    if (platform === "telegram") api.push({ text: "/workflow-cancel " + run.id + " 1", forwardOrigin: { type: "user", sender_user: { id: 42 }, date: 1 } });
    else qq.pushPrivateMessage({ userId: "880001", messageId: seq++, segments: [{ type: "reply", data: { id: "1" } }, { type: "text", data: { text: "引用中的命令" } }] });
    push("日常聊天");
    await waitFor("等待期间聊天", () => t.server.calls.length >= 1);
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "waiting");
    const pauseVersion = requireWorkflowRun(rt.store, run.id).version;
    push("/workflow-pause " + run.id + " " + pauseVersion);
    await waitFor("暂停并核实脚本停止", () => requireWorkflowRun(rt.store, run.id).status === "paused" && requireWorkflowRun(rt.store, run.id).scriptStopVerified === true);
    const resumeVersion = requireWorkflowRun(rt.store, run.id).version;
    push("/workflow-resume " + run.id + " " + resumeVersion);
    await waitFor("恢复原问题", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    const q = getWorkflowQuestion(rt.store, run.id, "question")!;
    push("/workflow-answer " + run.id + " question " + q.runVersion + " " + q.version + ' "yes"');
    await waitFor("最终沿原入口发送", () => rt.sched.listOps({ limit: 200 }).items.some(op => op.sourceKey.includes("#workflow-final:") && op.status === "sent"));
    if (platform === "telegram") api.push({ message: original });
    else qq.pushPrivateMessage({ userId: "880001", messageId: original as number, segments: [{ type: "text", data: { text: '/workflow-run batch {"marker":"PHASE"}' } }] });
    await waitFor("控制事件已登记", () => rt.store.getEventsAfter(0).filter(event => event.body.type === "workflow.input").length > beforeInputs);
    await rt.scheduler!.tick(); await rt.scheduler!.idle();
    assert.equal(listWorkflowRuns(rt.store).length, 1);
    const reports = rt.sched.listOps({ limit: 200 }).items.filter(op => op.sourceKey.includes("#workflow-final:"));
    assert.equal(reports.length, 1); assert.equal(reports[0].target.channel, platform);
    assert.match(reports[0].text, /IM-FINAL/);
    assert.equal(rt.store.listConfirmationsByStatus("approved").length, 0);
  } finally { await t.shutdown(); await api.close(); await qq.close(); }
});

function controls(rt: Runtime, target: NotifyTarget): ImWorkflows {
  return new ImWorkflows({
    store: rt.store, sched: rt.sched,
    entry: () => ({ target: () => target, expectedActor: () => "telegram:42", replyCapChars: () => 4000, externalIdPrefix: value => telegramExternalId(value.account, value.chatId, "") }),
    start: (input, origin) => rt.startWorkflowOwner({ ...input, sessionId: rt.store.getAgentRole("main")!.sessionId }, origin),
    answer: input => rt.answerWorkflowQuestion(input), control: input => rt.controlWorkflow(input),
    detail: (...args) => rt.getWorkflowDetail(...args), logs: (...args) => rt.getWorkflowLogs(...args), step: (...args) => rt.getWorkflowStep(...args),
    definitions: (...args) => rt.workflowLibrary.list(...args), definition: input => rt.getWorkflowDefinition(input), kickSender: () => rt.scheduler?.kickSender(),
  });
}

test("IM 异步启动期间同外部键异参只允许首项提交；回执故障整笔回滚来源事件/任务/运行", async () => {
  const api = new FakeBotApi({ token: "123:workflow-race", ownerId: 42 }), apiBase = await api.start();
  const t = await startTestRuntime("workflow-im-race", async () => ({ kind: "text", text: "FINAL" }), { config: { qqDisabled: true, scheduler: { tickMs: 20 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } } });
  try {
    const rt = t.runtime;
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: "123:workflow-race" });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
    const target: NotifyTarget = { channel: "telegram", account: "123", chatId: "42", configVersion: rt.telegramStore.getConfig()!.configVersion };
    const im = controls(rt, target);
    const input = (id: number, commandText: string) => ({ source: "telegram", externalId: telegramExternalId("123", "42", id), actor: "telegram:42", replyTarget: target, commandText });
    await rt.saveWorkflowDefinition({ name: "batch", script: SCRIPT, expectedDigest: null, requestKey: "owner:save" });
    await im.handleCommand(input(1000, '/workflow-run batch {"marker":"FIRST"}'));
    await waitFor("首项等待", () => listWorkflowRuns(rt.store)[0]?.status === "waiting");
    const existing = listWorkflowRuns(rt.store)[0], load = rt.workflowLibrary.load.bind(rt.workflowLibrary);
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    rt.workflowLibrary.load = async name => { entered(); await barrier; return load(name); };
    const delayed = im.handleCommand(input(1001, '/workflow-run batch {"marker":"SECOND"}'));
    await ready;
    const canceled = await im.handleCommand(input(1001, "/workflow-cancel " + existing.id + " " + requireWorkflowRun(rt.store, existing.id).version));
    release();
    assert.equal(canceled!.outcome, "cancel"); assert.equal((await delayed)!.outcome, "request_conflict");
    assert.equal(listWorkflowRuns(rt.store).length, 1);
    assert.equal(requireWorkflowRun(rt.store, existing.id).status, "canceled");
    assert.match(rt.store.findInboundEvent("telegram", telegramExternalId("123", "42", 1001))!.body, /workflow-cancel/);
    assert.equal(rt.store.listTasksBySession(existing.source.sessionId).filter(task => task.requestId.includes(":1001")).length, 0);
    rt.workflowLibrary.load = load;
    const taskCount = rt.store.listTasksBySession(existing.source.sessionId).length;
    await assert.rejects(rt.startWorkflowOwner({ sessionId: existing.source.sessionId, name: "batch", requestKey: "rollback", input: { marker: "ROLLBACK" } }, {
      sourceEvent: () => rt.store.registerInboundEvent({ source: "telegram", externalId: telegramExternalId("123", "42", 1002), actor: "telegram:42", body: "启动", targetRole: "main", replyTarget: target, eventKind: "im_workflow", terminal: "done" }).event.id,
      txExtra: () => { throw new Error("回执故障"); },
    }), /回执故障/);
    assert.equal(listWorkflowRuns(rt.store).length, 1);
    assert.equal(rt.store.listTasksBySession(existing.source.sessionId).length, taskCount);
    assert.equal(rt.store.findInboundEvent("telegram", telegramExternalId("123", "42", 1002)), null);
    const started = await im.handleCommand(input(2000, '/workflow-run batch {"marker":"COMMIT"}'));
    assert.equal(started!.outcome, "started");
    const fresh = listWorkflowRuns(rt.store).find(run => run.id !== existing.id)!;
    await waitFor("提交故障前等待", () => requireWorkflowRun(rt.store, fresh.id).status === "waiting");
    const command = input(2001, "/workflow-cancel " + fresh.id + " " + requireWorkflowRun(rt.store, fresh.id).version);
    const db = rt.store.db, tx = db.tx.bind(db);
    let injected = false;
    db.tx = <T>(fn: () => T): T => tx(() => {
      const result = fn();
      if (rt.store.findInboundEvent(command.source, command.externalId)) {
        assert.notEqual(getWorkflowControlDigest(rt.store, fresh.id, "im:telegram:" + command.externalId), null);
        injected = true;
        throw new Error("提交前故障");
      }
      return result;
    });
    try { await assert.rejects(im.handleCommand(command), /提交前故障/); }
    finally { db.tx = tx; }
    assert.equal(injected, true);
    assert.equal(rt.store.findInboundEvent(command.source, command.externalId), null);
    assert.equal(getWorkflowControlDigest(rt.store, fresh.id, "im:telegram:" + command.externalId), null);
    assert.equal(requireWorkflowRun(rt.store, fresh.id).status, "waiting");
    assert.equal((await im.handleCommand(command))!.outcome, "cancel");
    assert.equal(requireWorkflowRun(rt.store, fresh.id).status, "canceled");
  } finally { await t.shutdown(); await api.close(); }
});

test("IM 模型失效与限额内深嵌套脚本有固定失败回执，推进偏移后仍处理聊天，不泄露凭据", async () => {
  const api = new FakeBotApi({ token: "123:workflow-error", ownerId: 42 }), apiBase = await api.start();
  const t = await startTestRuntime("workflow-im-error", async () => ({ kind: "text", text: "CHAT-OK" }), { config: { qqDisabled: true, scheduler: { tickMs: 20 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } } });
  try {
    const rt = t.runtime;
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: "123:workflow-error" });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
    await rt.saveWorkflowDefinition({ name: "batch", script: SCRIPT, expectedDigest: null, requestKey: "owner:save" });
    const main = rt.store.getAgentRole("main")!, selection = main.modelSelection;
    rt.store.withTx(() => rt.store.db.prepare("UPDATE agent_roles SET model_selection = ? WHERE id = 'main'").run(JSON.stringify({ provider: "missing", modelId: "missing", thinkingLevel: "off" })));
    api.push({ text: '/workflow-run batch {"marker":"ERROR"}' });
    await waitFor("已知模型失败回执", () => rt.sched.listOps({ limit: 100 }).items.some(op => op.text.includes("工作流请求被拒绝") && op.status === "sent"));
    assert.equal(listWorkflowRuns(rt.store).length, 0);
    const receipt = rt.sched.listOps({ limit: 100 }).items.find(op => op.text.includes("工作流请求被拒绝"))!;
    assert.doesNotMatch(receipt.text, /workflow-error|mock-key/);
    rt.store.withTx(() => rt.store.db.prepare("UPDATE agent_roles SET model_selection = ? WHERE id = 'main'").run(selection ? JSON.stringify(selection) : null));
    fs.writeFileSync(path.join(t.dirs.agentDir, "workflows", "batch.js"), "return " + "(".repeat(30000) + "1" + ")".repeat(30000) + ";");
    api.push({ text: '/workflow-run batch {"marker":"DEEP"}' });
    await waitFor("编译栈异常终态回执", () => rt.sched.listOps({ limit: 100 }).items.some(op => op.text.includes("invalid_script_syntax") && op.status === "sent"));
    assert.equal(listWorkflowRuns(rt.store).length, 0);
    api.push({ text: "日常聊天" });
    await waitFor("失败后聊天继续", () => t.server.calls.length === 1 && rt.sched.listOps({ limit: 100 }).items.some(op => op.text === "CHAT-OK" && op.status === "sent"));
    assert.ok(rt.telegramStore.getConfig()!.lastUpdateId >= 3);
  } finally { await t.shutdown(); await api.close(); }
});
