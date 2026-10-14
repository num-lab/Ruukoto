import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { agentReportKey, bindAgentReportFallback, claimAgentReports, completeAgentReports, consumeAgentReport, endAgentWait, getAgentReport,
  listAgentReports, registerAgentReport, registerAgentWait, releaseAgentReports, startAgentReportFallback } from "@ruukoto/core/agent-wait.ts";
import { TASK_END_MARKER, TASK_START_MARKER, type ModelSelection, type Task } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { parseRule } from "@ruukoto/channels/scheduler/time.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { FakeBotApi } from "./helpers/fake-bot-api.ts";
import { afterTool, lastToolText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

function assistant(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "mock", model: "mock-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

function running(store: Store, sessionId: string, selection: ModelSelection, requestId: string, parentTaskId?: string): Task {
  const task = store.insertQueuedTask({ sessionId, requestId, parentTaskId, input: requestId, accessMode: "full_access",
    modelSelection: selection, submissionDigest: requestId }).task;
  store.transitionTask(task.id, ["queued"], "running");
  return store.getTask(task.id)!;
}

for (const window of ["parent", "parent-repeated", "fallback", "fallback-no-end"] as const) test(`冷恢复 ${window}：最终 JSONL 已落盘而 SQLite 未终态，保留原报告且不再生成`, async () => {
  const owner = window === "parent" || window === "parent-repeated" ? "parent" : "fallback", completed = window !== "fallback-no-end";
  const t = await startTestRuntime(`wait-recover-${owner}`, () => ({ kind: "text", text: "不应再次生成报告" }), { config: { product: codeProduct.runtime } });
  let restarted: Runtime | null = null;
  try {
    const session = await t.runtime.createSession({ projectName: "recover", cwd: t.work[0] }), selection = t.runtime.defaultSelection;
    const config = t.runtime.config;
    t.client.close();
    await t.runtime.stop("fixture_offline");
    const db = new Db(t.dirs.dataDir), store = new Store(db);
    let reportTaskId = "", reportKey = "", resultEntryId = "";
    try {
      const origin = store.withTx(() => running(store, session.id, selection, "原父轮"));
      const source: WorkflowSource = { product: "ruukoto-code", projectId: session.projectId, sessionId: session.id, taskId: origin.id,
        permissionVersion: origin.permissionVersion, accessMode: origin.accessMode, grantedPaths: [], capabilities: [], references: [],
        replyTarget: null, scheduledRunId: null };
      const childSession = store.createSession({ projectId: session.projectId, cwd: session.cwdReal, cwdReal: session.cwdReal,
        cwdDev: session.cwdDev, cwdIno: session.cwdIno, piSessionId: "recover-child", confirmTools: [] });
      store.insertSubAgent({ id: "recover-agent", parentSessionId: session.id, sessionId: childSession.id, workDir: session.cwdReal,
        activeWorkId: "recover-work", currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: childSession.createdAt });
      store.insertWorkDelegation({ id: "recover-work", parentSessionId: session.id, originTaskId: origin.id, subAgentId: "recover-agent",
        requestKey: "recover-work", paramsDigest: "recover-work", canceledAt: null, canceledBy: null, cancelReason: null,
        writeTarget: null, createdAt: childSession.createdAt });
      const child = store.insertQueuedTask({ sessionId: childSession.id, requestId: "child", input: "子任务", accessMode: "full_access",
        modelSelection: selection, submissionDigest: "child", parentTaskId: origin.id, workId: "recover-work", subAgentId: "recover-agent" }).task;
      store.endTask(child.id, ["queued"], "completed");
      store.setTaskResult(child.id, "已完成的真实持久结果", "{}");
      const target = { kind: "task" as const, taskId: child.id };
      const wait = (task: Task, id: string, reason: "result" | "timeout" = "result") => store.withTx(() => {
        registerAgentWait(store, { id, sdkCallId: "reused-wait-call", deadline: null, taskId: task.id, sessionId: session.id,
          targets: [target], source, snapshot: { taskId: task.id, permissionVersion: task.permissionVersion,
            selectionRecordId: null, promptArtifactId: null, instructions: null, skills: null } });
        endAgentWait(store, id, reason);
      });
      wait(origin, "first-wait");
      reportKey = store.withTx(() => registerAgentReport(store, { target, source, parentSessionId: session.id })).key;
      store.withTx(() => claimAgentReports(store, { taskId: origin.id, keys: [reportKey] }));
      const history = SessionManager.create(session.cwdReal, path.join(t.dirs.dataDir, "sessions"), { id: session.piSessionId });
      const result = (taskId: string) => ({ reason: "result", targets: [{ ...target, status: "completed", resultSummary: "持久结果", reportOwnerTaskId: taskId }] });
      history.appendCustomEntry(TASK_START_MARKER, { taskId: origin.id, requestId: origin.requestId });
      history.appendMessage({ role: "user", content: "旧父轮等待", timestamp: Date.now() });
      history.appendMessage({ role: "toolResult", toolName: "agent_wait", toolCallId: "reused-wait-call", isError: false,
        content: [{ type: "text", text: JSON.stringify(result(origin.id)) }], timestamp: Date.now() });
      history.appendMessage(assistant("旧父轮被打断", "aborted"));
      history.appendCustomEntry(TASK_END_MARKER, { taskId: origin.id, status: "interrupted" });
      store.withTx(() => {
        releaseAgentReports(store, origin.id, "owner_input");
        store.endTask(origin.id, ["running"], "interrupted", { interruptReason: "owner_input" });
      });
      let reportTask: Task;
      if (owner === "parent") {
        reportTask = store.withTx(() => running(store, session.id, selection, "新父轮"));
        if (window === "parent-repeated") wait(reportTask, "timed-out-wait", "timeout");
        wait(reportTask, "second-wait");
        store.withTx(() => claimAgentReports(store, { taskId: reportTask.id, keys: [reportKey] }));
      } else {
        reportTask = store.withTx(() => {
          const queued = store.insertQueuedTask({ sessionId: session.id, requestId: `agent-final:${origin.id}`, input: "后台工作最终回报",
            modelSelection: selection, submissionDigest: "fallback", parentTaskId: origin.id, sourcePermissionVersion: origin.permissionVersion }).task;
          bindAgentReportFallback(store, reportKey, queued.id);
          startAgentReportFallback(store, queued.id);
          store.transitionTask(queued.id, ["queued"], "running");
          return store.getTask(queued.id)!;
        });
      }
      reportTaskId = reportTask.id;
      history.appendCustomEntry(TASK_START_MARKER, { taskId: reportTask.id, requestId: reportTask.requestId });
      const inputId = history.appendMessage({ role: "user", content: "当前报告轮次", timestamp: Date.now() });
      if (window === "parent-repeated") history.appendMessage({ role: "toolResult", toolName: "agent_wait", toolCallId: "reused-wait-call", isError: false,
        content: [{ type: "text", text: JSON.stringify({ reason: "timeout", targets: [{ ...target, status: "running", resultSummary: null, reportOwnerTaskId: null }] }) }], timestamp: Date.now() });
      if (owner === "parent") resultEntryId = history.appendMessage({ role: "toolResult", toolName: "agent_wait", toolCallId: "reused-wait-call", isError: false,
        content: [{ type: "text", text: JSON.stringify(result(reportTask.id)) }], timestamp: Date.now() });
      else {
        resultEntryId = inputId;
      }
      history.appendMessage(assistant("原记录中的唯一最终总结"));
      if (completed) history.appendCustomEntry(TASK_END_MARKER, { taskId: reportTask.id, status: "completed" });
      const file = history.getSessionFile();
      assert.ok(file);
      store.withTx(() => store.setSessionFile(session.id, file));
      assert.equal(store.getTask(reportTaskId)!.status, "running");
      assert.equal(store.getTask(reportTaskId)!.resultSummary, null);
      assert.equal(reportKey, agentReportKey(target));
    } finally { db.close(); }
    restarted = await Runtime.start(config);
    const rt = restarted;
    await waitFor("恢复原报告结果", () => rt.store.getTask(reportTaskId)!.resultSummary !== null);
    const report = getAgentReport(rt.store, reportKey)!;
    assert.equal(rt.store.getTask(reportTaskId)!.status, completed ? "completed" : "interrupted");
    if (completed) assert.equal(rt.store.getTask(reportTaskId)!.resultSummary, "原记录中的唯一最终总结");
    assert.equal(report.status, completed ? "reported" : "undelivered");
    if (!completed) assert.equal(report.reason, "parent_report_unverified");
    assert.equal(report.proof!.taskId, reportTaskId);
    assert.equal(report.consumption!.entryId, resultEntryId);
    assert.equal(t.server.calls.length, 0, "已核实的最终回复只补关联，不能重新调用模型");
  } finally { await restarted?.stop("test_end"); await t.shutdown(); }
});

for (const mode of ["success", "send-revoked", "request-revoked"] as const) test(`可信 Telegram main 父轮消费两份结果：${mode}`, async () => {
  const revoke = mode === "send-revoked";
  const token = "123:main-wait", api = new FakeBotApi({ token, ownerId: 42 }), apiBase = await api.start();
  if (revoke) api.behavior = () => ({ status: 429, body: { ok: false, parameters: { retry_after: 3600 } } });
  let rt!: Runtime, memoryId = "", memoryVersion = 0, revokedForRequest = false, consumedBeforeRevoke = false;
  const t = await startTestRuntime(`wait-main-${revoke}`, req => {
    if (afterTool(req)) {
      const result = JSON.parse(lastToolText(req)) as { reason: string; targets: { resultSummary: string | null }[] };
      assert.equal(result.reason, "result"); assert.equal(result.targets.length, 2);
      assert.ok(result.targets.every(target => target.resultSummary !== null));
      if (mode === "request-revoked") return { kind: "tool_calls", calls: [{ id: "query-after-consume", name: "history_search", arguments: { query: "MAIN WAIT TWO" } }] };
      return { kind: "text", text: "MAIN-ONLY-FINAL 两份结果已经合并" };
    }
    const main = rt.store.getAgentRole("main")!, origin = rt.store.listTasksBySession(main.sessionId).find(task => task.status === "running")!;
    const session = rt.store.getSession(main.sessionId)!;
    const memory = rt.ownerSaveMemory({ projectId: session.projectId, category: "experience", content: "PRIVATE-MAIN-CHILD-MEMORY",
      sourceRefs: [{ kind: "owner_note", note: "拥有者提供" }] });
    memoryId = memory.id; memoryVersion = memory.currentVersion;
    const ids = rt.store.withTx(() => ["one", "two"].map(key => {
      const now = new Date().toISOString(), childSession = rt.store.createSession({ projectId: session.projectId, cwd: session.cwdReal, cwdReal: session.cwdReal,
        cwdDev: session.cwdDev, cwdIno: session.cwdIno, piSessionId: `main-child-${key}`, confirmTools: [] });
      const agentId = `main-agent-${key}`, workId = `main-work-${key}`;
      rt.store.insertSubAgent({ id: agentId, parentSessionId: session.id, sessionId: childSession.id, workDir: session.cwdReal,
        activeWorkId: workId, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: now });
      rt.store.insertWorkDelegation({ id: workId, parentSessionId: session.id, originTaskId: origin.id, subAgentId: agentId,
        requestKey: workId, paramsDigest: workId, canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: now });
      const child = rt.store.insertQueuedTask({ sessionId: childSession.id, requestId: key, input: "读取资料", accessMode: "full_access",
        modelSelection: rt.defaultSelection, submissionDigest: key, parentTaskId: origin.id, workId, subAgentId: agentId }).task;
      rt.store.recordToolIntent({ id: `main-memory-${key}`, taskId: child.id, sessionId: childSession.id, toolName: "memory_read", params: { memory_id: memory.id } });
      rt.store.recordToolResult(`main-memory-${key}`, "PRIVATE-MAIN-CHILD-MEMORY", false);
      rt.store.endTask(child.id, ["queued"], "completed"); rt.store.setTaskResult(child.id, "PRIVATE-MAIN-CHILD-MEMORY", "{}");
      return child.id;
    }));
    return { kind: "tool_calls", calls: [{ id: "main-wait", name: "agent_wait", arguments: { targets: ids.map(task_id => ({ kind: "task", task_id })) } }] };
  }, { config: { qqDisabled: true, scheduler: { tickMs: 20 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } } });
  rt = t.runtime;
  if (mode === "request-revoked") rt.addEventListener(events => {
    if (revokedForRequest || !events.some(event => event.body.type === "task.tool_result" && rt.store.getToolOp(event.body.toolOpId)?.toolName === "history_search")) return;
    consumedBeforeRevoke = listAgentReports(rt.store).length === 2 && listAgentReports(rt.store).every(report => report.consumption !== null);
    rt.ownerRevokeMemory({ memoryId, expectedVersion: memoryVersion });
    revokedForRequest = true;
  });
  try {
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: token });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" }); await rt.telegramSetEnabled(true);
    await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
    api.push({ text: "MAIN WAIT TWO" });
    if (mode === "request-revoked") {
      await waitFor("模型下一请求拒绝已撤销来源", () => listAgentReports(rt.store).length === 2 && listAgentReports(rt.store).every(report => report.status === "undelivered"));
      assert.ok(revokedForRequest); assert.ok(consumedBeforeRevoke);
      const reports = listAgentReports(rt.store), task = rt.store.getTask(reports[0].consumption!.taskId)!;
      assert.equal(rt.store.getSessionIdentity(task.sessionId)!.kind, "main"); assert.equal(task.status, "interrupted");
      assert.equal(t.server.calls.length, 2, "消费后的资料撤销必须阻断下一模型请求");
      assert.equal(api.sends.length, 0);
      assert.equal(rt.sched.listOps({ limit: 50 }).items.filter(op => op.sourceKind === "owner_reply").length, 0);
      return;
    }
    await waitFor("main 最终 owner_reply 已收尾", () => rt.sched.listOps({ limit: 50 }).items.some(op => op.sourceKind === "owner_reply" &&
      (revoke ? op.notBefore !== null : op.status === "sent")));
    const ops = rt.sched.listOps({ limit: 50 }).items.filter(op => op.sourceKind === "owner_reply");
    assert.equal(ops.length, 1, "普通回复和认领总结共用一份 outbox");
    const op = ops[0], task = rt.store.getTask(op.taskId!)!, reports = listAgentReports(rt.store, { taskId: task.id });
    assert.equal(rt.store.getSessionIdentity(task.sessionId)!.kind, "main"); assert.equal(task.status, "completed");
    assert.equal(op.sourceKey, task.sourceEventId);
    assert.equal(reports.length, 2); assert.ok(reports.every(report => report.status === "reported" && report.consumption?.taskId === task.id && report.proof?.outboxOpId === op.id));
    assert.equal(new Set(reports.map(report => report.consumption!.entryId)).size, 1);
    assert.match(op.text, /MAIN-ONLY-FINAL/);
    assert.equal(api.sends.length, 1); assert.equal(t.server.calls.length, 2);
    if (revoke) {
      rt.ownerRevokeMemory({ memoryId, expectedVersion: memoryVersion });
      rt.store.withTx(() => rt.store.db.prepare("UPDATE notification_ops SET not_before = NULL WHERE id = ?").run(op.id));
      await rt.scheduler!.tick(); await rt.scheduler!.idle();
      assert.equal(rt.sched.getOp(op.id)!.status, "canceled");
      assert.equal(api.sends.length, 1, "撤销后不能调用真实适配器重发旧正文");
    }
    await rt.scheduler!.tick(); await rt.scheduler!.idle();
    assert.equal(rt.sched.listOps({ limit: 50 }).items.filter(item => item.sourceKind === "owner_reply").length, 1);
    assert.equal(api.sends.length, 1);
  } finally { await t.shutdown(); await api.close(); }
});

test("定时父轮已消费普通子结果：实际发送前撤销子任务记忆，原汇报取消且不外发", async () => {
  const token = "123:wait-source", api = new FakeBotApi({ token, ownerId: 42 }), apiBase = await api.start();
  const t = await startTestRuntime("wait-schedule-source", () => ({ kind: "text", text: "不应调用模型" }), {
    config: { qqDisabled: true, scheduler: { tickMs: 0 }, telegram: { pollTimeoutSec: 1, backoffMs: 30 } },
  });
  const rt = t.runtime;
  try {
    await rt.addCredentialBinding({ name: "tg", host: new URL(apiBase).host, header: "none", purpose: "telegram_bot", secret: token });
    await rt.telegramConfigure({ apiBase, credential: "tg", ownerUserId: "42" });
    const config = await rt.telegramSetEnabled(true);
    await waitFor("Telegram 在线", () => rt.telegramStatus().online === true);
    const session = await rt.createSession({ projectName: "scheduled-source", cwd: t.work[0] });
    const memory = rt.ownerSaveMemory({ projectId: session.projectId, category: "experience", content: "PRIVATE-CHILD-MEMORY",
      sourceRefs: [{ kind: "owner_note", note: "拥有者提供" }] });
    const target = { channel: "telegram", account: "123", chatId: config.ownerChatId, configVersion: config.configVersion };
    const runId = "scheduled-report-source", now = new Date().toISOString();
    const fixture = rt.store.withTx(() => {
      const origin = running(rt.store, session.id, rt.defaultSelection, "定时父轮");
      const schedule = rt.sched.insertSchedule({ createKey: "wait-source", paramsDigest: "wait-source", createTaskId: null, createOpId: null,
        projectId: session.projectId, createPermissionVersion: 1, accessMode: "full_access", rule: parseRule({ kind: "once", at: "2099-01-01T00:00:00Z", time_zone: "UTC" }),
        instruction: "读取子任务记忆并汇报", sourceRefs: [], target, nextDueAt: null, tzData: "test", reason: "test" }, "test");
      rt.sched.insertRun({ id: runId, scheduleId: schedule.id, scheduleVersion: schedule.version, scheduledFor: now, localTime: now,
        registeredAt: now, delayMs: 0, coalescedFrom: null, coalescedTo: null, inboundEventId: null, notificationOpId: null,
        sessionId: session.id, rootTaskId: origin.id, resultStatus: null, resultText: null });
      const childSession = rt.store.createSession({ projectId: session.projectId, cwd: session.cwdReal, cwdReal: session.cwdReal,
        cwdDev: session.cwdDev, cwdIno: session.cwdIno, piSessionId: "scheduled-child", confirmTools: [] });
      rt.store.insertSubAgent({ id: "scheduled-agent", parentSessionId: session.id, sessionId: childSession.id, workDir: session.cwdReal,
        activeWorkId: "scheduled-work", currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: now });
      rt.store.insertWorkDelegation({ id: "scheduled-work", parentSessionId: session.id, originTaskId: origin.id, subAgentId: "scheduled-agent",
        requestKey: "scheduled-work", paramsDigest: "scheduled-work", canceledAt: null, canceledBy: null, cancelReason: null,
        writeTarget: null, createdAt: now });
      const child = rt.store.insertQueuedTask({ sessionId: childSession.id, requestId: "memory-child", input: "读取记忆", accessMode: "full_access",
        modelSelection: rt.defaultSelection, submissionDigest: "memory-child", parentTaskId: origin.id, workId: "scheduled-work", subAgentId: "scheduled-agent" }).task;
      rt.store.recordToolIntent({ id: "scheduled-memory-read", taskId: child.id, sessionId: childSession.id, toolName: "memory_read", params: { memory_id: memory.id } });
      rt.store.recordToolResult("scheduled-memory-read", "PRIVATE-CHILD-MEMORY", false);
      rt.store.endTask(child.id, ["queued"], "completed"); rt.store.setTaskResult(child.id, "PRIVATE-CHILD-MEMORY", "{}");
      const source: WorkflowSource = { product: "ruukoto", projectId: session.projectId, sessionId: session.id, taskId: origin.id,
        permissionVersion: origin.permissionVersion, accessMode: origin.accessMode, grantedPaths: [], capabilities: [], references: [],
        replyTarget: target, scheduledRunId: runId };
      const waitTarget = { kind: "task" as const, taskId: child.id };
      registerAgentWait(rt.store, { id: "scheduled-wait", sdkCallId: "scheduled-wait", deadline: null, taskId: origin.id, sessionId: session.id,
        targets: [waitTarget], source, snapshot: { taskId: origin.id, permissionVersion: origin.permissionVersion,
          selectionRecordId: null, promptArtifactId: null, instructions: null, skills: null } });
      endAgentWait(rt.store, "scheduled-wait", "result");
      const report = registerAgentReport(rt.store, { target: waitTarget, source, parentSessionId: session.id });
      claimAgentReports(rt.store, { taskId: origin.id, keys: [report.key] });
      const history = SessionManager.create(session.cwdReal, path.join(t.dirs.dataDir, "sessions"), { id: session.piSessionId });
      history.appendCustomEntry(TASK_START_MARKER, { taskId: origin.id, requestId: origin.requestId });
      history.appendMessage({ role: "user", content: "定时任务", timestamp: Date.now() });
      const resultId = history.appendMessage({ role: "toolResult", toolName: "agent_wait", toolCallId: "scheduled-wait", isError: false,
        content: [{ type: "text", text: "PRIVATE-CHILD-MEMORY" }], timestamp: Date.now() });
      consumeAgentReport(rt.store, report.key, { taskId: origin.id, entryId: resultId });
      const finalId = history.appendMessage(assistant("PRIVATE-CHILD-MEMORY"));
      history.appendCustomEntry(TASK_END_MARKER, { taskId: origin.id, status: "completed" });
      rt.store.setSessionFile(session.id, history.getSessionFile()!);
      rt.store.endTask(origin.id, ["running"], "completed"); rt.store.setTaskResult(origin.id, "PRIVATE-CHILD-MEMORY", "{}");
      completeAgentReports(rt.store, origin.id, { status: "reported", entryId: finalId });
      const { op } = rt.sched.insertOp({ sourceKind: "schedule_run", sourceKey: runId, taskId: origin.id, hostOpId: null,
        target, text: "PRIVATE-CHILD-MEMORY", sourceRefs: [] });
      rt.store.db.prepare("UPDATE notification_ops SET not_before = ? WHERE id = ?").run("2099-01-01T00:00:00Z", op.id);
      rt.sched.finishRun(runId, "completed", "PRIVATE-CHILD-MEMORY", op.id);
      return { opId: op.id, reportKey: report.key };
    });
    assert.equal(getAgentReport(rt.store, fixture.reportKey)!.status, "reported");
    rt.ownerRevokeMemory({ memoryId: memory.id, expectedVersion: memory.currentVersion });
    rt.store.withTx(() => rt.store.db.prepare("UPDATE notification_ops SET not_before = NULL WHERE id = ?").run(fixture.opId));
    await rt.scheduler!.tick(); await rt.scheduler!.idle();
    const op = rt.sched.getOp(fixture.opId)!;
    assert.equal(op.status, "canceled");
    assert.equal(op.sourceKey, runId); assert.deepEqual(op.target, target);
    assert.equal(api.sends.length, 0, "取消必须发生在真实适配器发请求之前");
    assert.equal(t.server.calls.length, 0);
  } finally { await t.shutdown(); await api.close(); }
});

for (const inputCase of ["completed", "no-end", "missing-reference", "invalid-json", "null-root", "null-target", "missing-start", "missing-tool-entry", "missing-group", "empty-group", "subset-group", "falsy-group", "own-missing-tool-entry", "own-subset-group"] as const) test(`续接整组冷恢复 ${inputCase}：保留消费归属与实际输入证明，0 模型`, async () => {
  const completed = inputCase !== "no-end", own = inputCase.startsWith("own-");
  const t = await startTestRuntime("e8-takeover-recovery", () => ({ kind: "text", text: "不应重新总结" }), { config: { product: codeProduct.runtime } });
  let restarted: Runtime | null = null;
  try {
    const session = await t.runtime.createSession({ projectName: "e8", cwd: t.work[0] });
    const config = t.runtime.config, selection = t.runtime.defaultSelection;
    t.client.close(); await t.runtime.stop("fixture_offline");
    const db = new Db(t.dirs.dataDir), store = new Store(db);
    let parentId = "", qId = "", canonicalId = "", inputId = "", finalId = "";
    const keys: string[] = [];
    try {
      const p = store.withTx(() => running(store, session.id, selection, "P介入")); parentId = p.id;
      const source: WorkflowSource = { product: "ruukoto-code", projectId: session.projectId, sessionId: session.id, taskId: p.id, permissionVersion: p.permissionVersion,
        accessMode: p.accessMode, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null };
      const children = [0, 1].map(i => store.withTx(() => {
        const sub = store.createSession({ projectId: session.projectId, cwd: session.cwdReal, cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, piSessionId: `sub-${i}`, confirmTools: [] });
        const agentId = `sub${i}`, workId = `work${i}`;
        store.insertSubAgent({ id: agentId, parentSessionId: session.id, sessionId: sub.id, workDir: sub.cwdReal, activeWorkId: workId, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
        store.insertWorkDelegation({ id: workId, parentSessionId: session.id, originTaskId: p.id, subAgentId: agentId, requestKey: workId, paramsDigest: workId, canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: sub.createdAt });
        const child = store.insertQueuedTask({ sessionId: sub.id, requestId: `child${i}`, input: `child${i}`, accessMode: "full_access", modelSelection: selection, submissionDigest: `child${i}`, parentTaskId: p.id, subAgentId: agentId, workId }).task;
        store.endTask(child.id, ["queued"], "completed"); store.setTaskResult(child.id, `结果${i}`, "{}"); return store.getTask(child.id)!;
      }));
      const targets = children.map(child => ({ kind: "task" as const, taskId: child.id }));
      const wait = (task: Task, id: string, items: typeof targets) => {
        registerAgentWait(store, { id, sdkCallId: "reused-call", taskId: task.id, sessionId: session.id, deadline: null, targets: items, source,
          snapshot: { taskId: task.id, permissionVersion: task.permissionVersion, selectionRecordId: null, promptArtifactId: null, instructions: null, skills: null } });
        endAgentWait(store, id, "result");
      };
      const history = SessionManager.create(session.cwdReal, path.join(t.dirs.dataDir, "sessions"), { id: session.piSessionId });
      history.appendCustomEntry(TASK_START_MARKER, { taskId: p.id, requestId: p.requestId });
      history.appendMessage({ role: "user", content: "原先等待两项", timestamp: Date.now() });
      const oldInput = history.appendMessage({ role: "toolResult", toolName: "agent_wait", toolCallId: "reused-call", isError: false, timestamp: Date.now(),
        content: [{ type: "text", text: JSON.stringify({ reason: "result", targets: [{ ...targets[0], status: "completed", resultSummary: "结果0", reportOwnerTaskId: p.id }, { ...targets[1], status: "running", resultSummary: null }] }) }] });
      history.appendMessage(assistant("first已经完成，second需要yes")); history.appendCustomEntry(TASK_END_MARKER, { taskId: p.id, status: "completed" });
      store.withTx(() => {
        wait(p, "p-both", targets);
        for (const target of targets) keys.push(registerAgentReport(store, { target, source, parentSessionId: session.id }).key);
        claimAgentReports(store, { taskId: p.id, keys: [keys[0]] });
        if (!own) consumeAgentReport(store, keys[0], { taskId: p.id, entryId: oldInput });
        releaseAgentReports(store, p.id, "wait_group_pending"); store.endTask(p.id, ["running"], "completed"); store.setTaskResult(p.id, "请回答yes", "{}");
        const canonical = store.insertQueuedTask({ sessionId: session.id, requestId: `agent-final:${p.id}`, input: "原canonical输入", parentTaskId: p.id, modelSelection: selection, submissionDigest: "canonical" }).task;
        canonicalId = canonical.id; for (const key of keys) bindAgentReportFallback(store, key, canonical.id);
      });
      const q = store.withTx(() => running(store, session.id, selection, "Q续接")); qId = q.id;
      store.withTx(() => { wait(q, "q-second", [targets[1]]); claimAgentReports(store, { taskId: q.id, keys }); });
      history.appendCustomEntry(TASK_START_MARKER, { taskId: q.id, requestId: q.requestId });
      history.appendMessage({ role: "user", content: "yes，然后只等second", timestamp: Date.now() });
      const states = targets.map((target, i) => ({ ...target, status: "completed", resultSummary: `结果${i}`, stopVerified: true, effectUnknown: false, artifactIds: [], artifactCount: 0, reportOwnerTaskId: q.id }));
      inputId = history.appendMessage({ role: "toolResult", toolName: "agent_wait", toolCallId: "reused-call", isError: false, timestamp: Date.now(),
        content: [{ type: "text", text: JSON.stringify({ reason: "result", targets: [states[1]], reportTargets: states }) }] });
      finalId = history.appendMessage(assistant("唯一完整总结first和second"));
      if (completed) history.appendCustomEntry(TASK_END_MARKER, { taskId: q.id, status: "completed" });
      store.withTx(() => {
        store.setSessionFile(session.id, history.getSessionFile()!);
        if (own) for (const key of keys) consumeAgentReport(store, key, { taskId: q.id, entryId: inputId });
      });
      assert.equal(getAgentReport(store, keys[0])!.consumption!.entryId, own ? inputId : oldInput);
      assert.equal(getAgentReport(store, keys[1])!.consumption?.taskId ?? null, own ? qId : null);
    } finally { db.close(); }
    restarted = await Runtime.start(config);
    await waitFor("续接冷恢复原结果", () => restarted!.store.getTask(qId)!.resultSummary !== null);
    const reports = keys.map(key => getAgentReport(restarted!.store, key)!);
    assert.equal(restarted.store.getTask(qId)!.status, completed ? "completed" : "interrupted");
    assert.ok(reports.every(report => report.status === (completed ? "reported" : "undelivered")));
    assert.ok(reports.every(report => report.proof!.taskId === qId && report.proof!.entryId === finalId));
    assert.equal(reports[0].consumption!.taskId, own ? qId : parentId); assert.equal(reports[1].consumption!.taskId, qId); assert.equal(reports[1].consumption!.entryId, inputId);
    assert.ok(reports.every(report => report.fallbackTaskId === canonicalId && report.fallbackState === "parked"));
    assert.equal(restarted.store.getTask(canonicalId)!.status, "queued");
    if (inputCase !== "completed" && inputCase !== "no-end") {
      const file = restarted.store.getSession(session.id)!.sessionFile!;
      let entries = fs.readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as { id: string; type: string; customType?: string; data?: { taskId?: string }; message?: { content: { type: string; text: string }[] } });
      const input = entries.find(entry => entry.id === inputId)!.message!;
      const result = JSON.parse(input.content[0].text) as { reportTargets?: unknown };
      restarted.store.withTx(() => {
        for (const key of keys) restarted!.store.db.prepare("UPDATE agent_reports SET payload = json_set(payload, '$.claimTaskId', NULL, '$.proof', NULL, '$.status', 'undelivered', '$.reason', 'source_invalid') WHERE report_key = ?").run(key);
        if (inputCase === "missing-reference") restarted!.store.db.prepare("DELETE FROM agent_reports WHERE report_key = ?").run(keys[0]);
      });
      if (inputCase === "invalid-json") input.content = [{ type: "text", text: "not-json" }];
      else if (inputCase === "null-root") input.content = [{ type: "text", text: "null" }];
      else if (inputCase === "null-target") result.reportTargets = [null];
      else if (inputCase === "missing-start") entries.find(entry => entry.type === "custom" && entry.customType === TASK_START_MARKER && entry.data?.taskId === qId)!.data!.taskId = "missing-current-start";
      else if (inputCase === "missing-tool-entry" || inputCase === "own-missing-tool-entry") entries = entries.filter(entry => entry.id !== inputId);
      else if (inputCase === "missing-group") delete result.reportTargets;
      else if (inputCase === "empty-group") result.reportTargets = [];
      else if (inputCase === "subset-group" || inputCase === "own-subset-group") result.reportTargets = [(result.reportTargets as unknown[])[1]];
      else if (inputCase === "falsy-group") result.reportTargets = false;
      if (!["invalid-json", "null-root"].includes(inputCase)) input.content[0].text = JSON.stringify(result);
      fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      assert.equal(restarted["verifyAgentReportSources"](qId, true), "agent_report_input_invalid", "合法来源不能掩盖缺失或损坏的实际输入证明");
    }
    assert.equal(t.server.calls.length, 0);
  } finally { await restarted?.stop("test_end"); await t.shutdown(); }
});
