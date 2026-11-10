import { fixtureSubAgentDefinition, fixtureSubAgentScope } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { agentReportKey, getAgentReport, isAgentReportFallback, listAgentReports, listAgentWaits } from "@ruukoto/core/agent-wait.ts";
import type { AgentWaitResult } from "@ruukoto/agent/agent-wait-tools.ts";
import { TASK_END_MARKER, type Task } from "@ruukoto/core/types.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { afterTool, lastToolText, lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

function attentionChildren(rt: Runtime, parent: Task): string[] {
  const session = rt.store.getSession(parent.sessionId)!;
  return rt.store.withTx(() => ["first", "second"].map(key => {
    const now = new Date().toISOString(), childSession = rt.store.createSession({ projectId: session.projectId, cwd: session.cwdReal,
      cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, piSessionId: `attention-${key}`, confirmTools: [] });
    const workId = `attention-work-${key}`, agentId = `attention-agent-${key}`;
    rt.store.insertSubAgent({ definition: fixtureSubAgentDefinition(), id: agentId, parentSessionId: session.id, sessionId: childSession.id, workDir: session.cwdReal,
      activeWorkId: workId, currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: now });
    rt.store.insertWorkDelegation({ id: workId, parentSessionId: session.id, originTaskId: parent.id, subAgentId: agentId,
      requestKey: workId, paramsDigest: workId, canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: now });
    const child = rt.store.insertQueuedTask({ readScope: fixtureSubAgentScope(rt["workflowSource"](parent.id)), sessionId: childSession.id, requestId: key, input: key, accessMode: parent.accessMode,
      modelSelection: rt.defaultSelection, submissionDigest: key, parentTaskId: parent.id, workId, subAgentId: agentId }).task;
    if (key === "first") {
      rt.store.endTask(child.id, ["queued"], "completed"); rt.store.setTaskResult(child.id, "FIRST-COMPLETED", "{}");
    } else {
      rt.store.transitionTask(child.id, ["queued"], "running");
      rt.store.transitionTask(child.id, ["running"], "awaiting_confirmation");
    }
    return child.id;
  }));
}

for (const layout of ["batch", "sequential"] as const) test(`owner ${layout} wait reports partial attention separately and produces one final group proof`, async () => {
  let rt!: Runtime, sessionId = "", parentTaskId = "", firstId = "", secondId = "";
  const t = await startTestRuntime("wait-attention-report", req => {
    const current = rt.store.listTasksBySession(sessionId).find(task => task.status === "running")!;
    if (isAgentReportFallback(rt.store, current.id)) return { kind: "text", text: "GROUP-ONLY-FINAL 两份结果共同完成" };
    if (afterTool(req)) {
      const result = JSON.parse(lastToolText(req)) as AgentWaitResult;
      if (layout === "sequential" && result.reason === "result") {
        assert.equal(result.targets.length, 1); assert.equal(result.targets[0].resultSummary, "FIRST-COMPLETED");
        return { kind: "tool_calls", calls: [{ id: "wait-attention", name: "wait", arguments: { targets: [{ kind: "task", task_id: secondId }] } }] };
      }
      if (layout === "batch") {
        assert.equal(result.reason, "result");
        assert.equal(result.targets.find(target => target.kind === "task" && target.taskId === firstId)!.resultSummary, "FIRST-COMPLETED");
      } else assert.equal(result.reason, "attention");
      assert.equal(result.targets.find(target => target.kind === "task" && target.taskId === secondId)!.attention, "tool_approval");
      return { kind: "text", text: "PARTIAL-QUESTION 第二项需要介入，请回复 yes" };
    }
    const parent = current;
    parentTaskId = parent.id;
    const ids = attentionChildren(rt, parent);
    [firstId, secondId] = ids;
    return { kind: "tool_calls", calls: [{ id: "wait-partial", name: "wait", arguments: { targets: (layout === "batch" ? ids : [firstId]).map(task_id => ({ kind: "task", task_id })) } }] };
  });
  rt = t.runtime;
  try {
    const session = await rt.createSession({ projectName: "attention-report", cwd: t.work[0] });
    sessionId = session.id;
    await rt.submit({ sessionId, requestId: "parent", input: "OWNER ATTENTION 两项结果一起处理", modelSelection: rt.defaultSelection });
    await waitFor("父轮介入回复完成且登记原结果", () => !!parentTaskId && rt.store.getTask(parentTaskId)!.status === "completed" && rt.store.getTask(parentTaskId)!.resultSummary !== null);
    const firstKey = agentReportKey({ kind: "task", taskId: firstId }), before = getAgentReport(rt.store, firstKey)!;
    assert.equal(before.status, "pending", "完成问答轮次不能把部分结果登记为整组最终报告");
    assert.equal(before.claimTaskId, null); assert.equal(before.proof, null);
    assert.equal(before.consumption!.taskId, parentTaskId);
    const originalConsumption = before.consumption;
    assert.match(rt.readTaskReply(parentTaskId)!.text, /PARTIAL-QUESTION/);
    assert.equal(listAgentReports(rt.store).filter(report => report.status === "reported").length, 0);
    assert.equal(t.server.calls.length, layout === "batch" ? 2 : 3);
    rt.store.withTx(() => rt.store.endTask(secondId, ["awaiting_confirmation"], "completed"));
    await waitFor("全部结果收尾后共享最终证明", () => listAgentReports(rt.store).length === 2 && listAgentReports(rt.store).every(report => report.status === "reported"));
    const reports = listAgentReports(rt.store), first = getAgentReport(rt.store, firstKey)!;
    assert.deepEqual(first.consumption, originalConsumption, "原父轮消费不迁给后备或重复注入");
    assert.deepEqual(reports[0].proof, reports[1].proof);
    const proof = reports[0].proof!;
    assert.notEqual(proof.taskId, parentTaskId); assert.ok(proof.entryId);
    assert.ok(isAgentReportFallback(rt.store, proof.taskId));
    assert.equal(rt.readTaskReply(proof.taskId)!.text, "GROUP-ONLY-FINAL 两份结果共同完成");
    const replies = rt.store.listTasksBySession(sessionId).map(task => rt.readTaskReply(task.id)?.text ?? "");
    assert.equal(replies.filter(text => text.includes("PARTIAL-QUESTION")).length, 1);
    assert.equal(replies.filter(text => text.includes("GROUP-ONLY-FINAL")).length, 1);
    assert.equal(t.server.calls.length, layout === "batch" ? 3 : 4, JSON.stringify(t.server.calls.map(call => ({ input: lastUserText(call).slice(0, 250), afterTool: afterTool(call) }))));
  } finally { await t.shutdown(); }
});

test("owner continuation cold recovery invalidates the complete revoked report group without another model request", async () => {
  let rt!: Runtime, restarted: Runtime | null = null, sessionId = "", parentTaskId = "", followupTaskId = "", firstId = "", secondId = "", memoryId = "", inputAccepted = false;
  let resumeProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { resumeProvider = resolve; });
  const t = await startTestRuntime("wait-takeover-cold-source", async req => {
    const input = lastUserText(req);
    const current = rt.store.listTasksBySession(sessionId).find(task => task.status === "running")!;
    assert.ok(!isAgentReportFallback(rt.store, current.id), "恢复无需另生成总结");
    if (input.includes("OWNER CONTINUE SECOND")) {
      if (afterTool(req)) {
        const result = JSON.parse(lastToolText(req)) as AgentWaitResult;
        assert.equal(result.reason, "result"); assert.equal(result.targets.length, 1);
        assert.equal(result.targets[0].kind, "task");
        assert.deepEqual(result.reportTargets!.map(target => target.kind === "task" ? target.taskId : target.runId).sort(), [firstId, secondId].sort());
        assert.ok(result.reportTargets!.every(target => target.reportOwnerTaskId === followupTaskId));
        inputAccepted = true;
        await providerGate;
        return { kind: "text", text: "Q-COLD-ONLY-FINAL PRIVATE-FIRST-ONLY 和第二份结果" };
      }
      followupTaskId = current.id;
      return { kind: "tool_calls", calls: [{ id: "cold-followup-wait", name: "wait", arguments: { targets: [{ kind: "task", task_id: secondId }] } }] };
    }
    if (afterTool(req)) {
      const result = JSON.parse(lastToolText(req)) as AgentWaitResult;
      if (result.reason === "result") return { kind: "tool_calls", calls: [{ id: "cold-original-attention", name: "wait", arguments: { targets: [{ kind: "task", task_id: secondId }] } }] };
      assert.equal(result.reason, "attention");
      return { kind: "text", text: "PARTIAL-QUESTION 第二项需要介入，请回复 yes" };
    }
    parentTaskId = current.id; [firstId, secondId] = attentionChildren(rt, current);
    const session = rt.store.getSession(current.sessionId)!;
    const memory = rt.ownerSaveMemory({ projectId: session.projectId, category: "experience", content: "PRIVATE-FIRST-ONLY", sourceRefs: [{ kind: "owner_note", note: "拥有者提供" }] });
    memoryId = memory.id;
    const first = rt.store.getTask(firstId)!;
    rt.store.withTx(() => {
      rt.store.recordToolIntent({ id: "cold-first-memory", taskId: first.id, sessionId: first.sessionId, toolName: "memory_read", params: { memory_id: memory.id } });
      rt.store.recordToolResult("cold-first-memory", "PRIVATE-FIRST-ONLY", false);
      rt.store.db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run("PRIVATE-FIRST-ONLY", first.id);
    });
    return { kind: "tool_calls", calls: [{ id: "cold-original-result", name: "wait", arguments: { targets: [{ kind: "task", task_id: firstId }] } }] };
  });
  rt = t.runtime;
  try {
    const parentSession = await rt.createSession({ projectName: "attention-cold-recovery", cwd: t.work[0] });
    sessionId = parentSession.id;
    await rt.submit({ sessionId, requestId: "parent", input: "ORIGINAL WAIT THEN ATTENTION", modelSelection: rt.defaultSelection });
    await waitFor("原父轮完成介入回复", () => !!parentTaskId && rt.store.getTask(parentTaskId)!.status === "completed" && rt.store.getTask(parentTaskId)!.resultSummary !== null);
    assert.match(rt.readTaskReply(parentTaskId)!.text, /PARTIAL-QUESTION/);
    const firstKey = agentReportKey({ kind: "task", taskId: firstId }), originalConsumption = getAgentReport(rt.store, firstKey)!.consumption!;
    assert.equal(originalConsumption.taskId, parentTaskId);
    rt.store.withTx(() => rt.store.transitionTask(secondId, ["awaiting_confirmation"], "running"));
    await rt.submit({ sessionId, requestId: "followup", input: "OWNER CONTINUE SECOND yes，继续并汇总", modelSelection: rt.defaultSelection });
    await waitFor("Q 真实 SDK 等待第二项", () => !!followupTaskId && listAgentWaits(rt.store, { taskId: followupTaskId }).some(wait => wait.phase === "waiting"));
    rt.store.withTx(() => rt.store.endTask(secondId, ["running"], "completed"));
    await waitFor("provider 接受 Q 的完整报告输入", () => inputAccepted);
    assert.equal(rt.store.getTask(followupTaskId)!.status, "running");
    assert.deepEqual(getAgentReport(rt.store, firstKey)!.consumption, originalConsumption);

    // Snapshot the accepted request before stopping, then recover it under the same activated profile.
    const snapshot = path.join(t.dirs.root, "cold.db"), session = rt.store.getSession(sessionId)!;
    const coldHistory = path.join(t.dirs.root, "cold-history.jsonl");
    fs.copyFileSync(session.sessionFile!, coldHistory);
    rt.store.db.prepare("VACUUM INTO ?").run(snapshot);
    t.client.close(); await rt.stop("fixture_offline"); resumeProvider();
    fs.copyFileSync(snapshot, path.join(t.dirs.dataDir, "ruukoto.db"));
    const db = new Db(t.dirs.dataDir), store = new Store(db);
    try {
      const history = SessionManager.open(coldHistory);
      history.appendMessage({ role: "assistant", content: [{ type: "text", text: "Q-COLD-ONLY-FINAL PRIVATE-FIRST-ONLY 和第二份结果" }], api: "openai-completions", provider: "mock", model: "mock-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
      history.appendCustomEntry(TASK_END_MARKER, { taskId: followupTaskId, status: "completed" });
      store.withTx(() => {
        store.setSessionFile(session.id, coldHistory);
        store.db.prepare("UPDATE memories SET status = 'revoked' WHERE id = ?").run(memoryId);
      });
      assert.equal(store.getTask(followupTaskId)!.status, "running");
      assert.ok(listAgentReports(store).every(report => report.claimTaskId === followupTaskId));
    } finally { db.close(); }
    const callsBeforeRecovery = t.server.calls.length;
    restarted = await Runtime.start(rt.config);
    const recovered = restarted;
    await waitFor("cold recovery records the original final reply", () => recovered.store.getTask(followupTaskId)!.status === "completed" && recovered.store.getTask(followupTaskId)!.resultSummary !== null);
    const reports = listAgentReports(recovered.store);
    assert.ok(reports.every(report => report.status === "undelivered" && report.reason === "source_invalid" && report.claimTaskId === null));
    assert.deepEqual(getAgentReport(recovered.store, firstKey)!.consumption, originalConsumption);
    assert.match(recovered.readTaskReply(followupTaskId)!.text, /Q-COLD-ONLY-FINAL/);
    assert.ok(reports.every(report => report.proof === null));
    assert.equal(t.server.calls.length, callsBeforeRecovery, "冷恢复只补登记，不重新调用模型");
  } finally { resumeProvider(); await restarted?.stop("test_end"); await t.shutdown(); }
});

for (const providerError of [false, true]) test(`owner followup waits for the second target: ${providerError ? "failed input does not consume the original report" : "one final proof retains original consumption"}`, async () => {
  let rt!: Runtime, sessionId = "", parentTaskId = "", followupTaskId = "", firstId = "", secondId = "", fallbackCalls = 0, canonicalTaskId = "";
  const t = await startTestRuntime("wait-attention-followup", req => {
    const input = lastUserText(req);
    const running = rt.store.listTasksBySession(sessionId).find(task => task.status === "running")!;
    if (isAgentReportFallback(rt.store, running.id)) { fallbackCalls++; return { kind: "text", text: "FALLBACK-ONLY-FINAL 两份结果共同完成" }; }
    if (input.includes("OWNER CONTINUE SECOND")) {
      if (afterTool(req)) {
        const result = JSON.parse(lastToolText(req)) as AgentWaitResult & { reportTargets?: AgentWaitResult["targets"] };
        assert.equal(result.reason, "result"); assert.equal(result.targets.length, 1, "原等待目标仍只含第二项");
        assert.equal(result.targets[0].kind, "task");
        assert.equal(result.reportTargets!.length, 2, "报告接管输入必须保存完整原组事实");
        assert.deepEqual(result.reportTargets!.map(target => target.kind === "task" ? target.taskId : target.runId).sort(), [firstId, secondId].sort());
        assert.equal(result.reportTargets!.find(target => target.kind === "task" && target.taskId === firstId)!.resultSummary, "FIRST-COMPLETED");
        assert.ok(result.reportTargets!.every(target => target.reportOwnerTaskId === followupTaskId));
        if (providerError) throw new Error("provider_error_before_valid_assistant");
        return { kind: "text", text: "Q-ONLY-FINAL 两份结果共同完成" };
      }
      followupTaskId = running.id;
      return { kind: "tool_calls", calls: [{ id: "followup-wait", name: "wait", arguments: { targets: [{ kind: "task", task_id: secondId }] } }] };
    }
    if (afterTool(req)) {
      const result = JSON.parse(lastToolText(req)) as AgentWaitResult;
      if (result.reason === "result") return { kind: "tool_calls", calls: [{ id: "original-attention", name: "wait", arguments: { targets: [{ kind: "task", task_id: secondId }] } }] };
      assert.equal(result.reason, "attention");
      return { kind: "text", text: "PARTIAL-QUESTION 第二项需要介入，请回复 yes" };
    }
    const parent = running;
    parentTaskId = parent.id; [firstId, secondId] = attentionChildren(rt, parent);
    canonicalTaskId = rt.store.withTx(() => rt.store.insertQueuedTask({ sessionId: parent.sessionId, requestId: `wake:${firstId}`, parentTaskId: firstId,
      input: "原排队第一项回报输入", submissionDigest: "original-canonical",
      accessMode: parent.accessMode, grantedPaths: parent.grantedPaths, sourcePermissionVersion: parent.permissionVersion,
      modelSelection: parent.modelSelection ?? rt.defaultSelection }).task.id);
    return { kind: "tool_calls", calls: [{ id: "original-result", name: "wait", arguments: { targets: [{ kind: "task", task_id: firstId }] } }] };
  });
  rt = t.runtime;
  try {
    const session = await rt.createSession({ projectName: "attention-followup", cwd: t.work[0] });
    sessionId = session.id;
    await rt.submit({ sessionId, requestId: "parent", input: "ORIGINAL WAIT THEN ATTENTION", modelSelection: rt.defaultSelection });
    await waitFor("原父轮完成普通介入回复", () => !!parentTaskId && rt.store.getTask(parentTaskId)!.status === "completed" && rt.store.getTask(parentTaskId)!.resultSummary !== null);
    assert.match(rt.readTaskReply(parentTaskId)!.text, /PARTIAL-QUESTION/);
    const firstKey = agentReportKey({ kind: "task", taskId: firstId }), before = getAgentReport(rt.store, firstKey)!;
    assert.equal(before.status, "pending"); assert.equal(before.claimTaskId, null); assert.equal(before.proof, null);
    assert.equal(before.fallbackTaskId, canonicalTaskId); assert.equal(rt.store.getTask(canonicalTaskId)!.status, "queued");
    const originalConsumption = before.consumption!;
    assert.equal(originalConsumption.taskId, parentTaskId);
    rt.store.withTx(() => rt.store.transitionTask(secondId, ["awaiting_confirmation"], "running"));
    await rt.submit({ sessionId, requestId: "followup", input: "OWNER CONTINUE SECOND yes，继续第二项并汇总两份结果", modelSelection: rt.defaultSelection });
    await waitFor("后续父轮固定等待第二项", () => !!followupTaskId && listAgentWaits(rt.store, { taskId: followupTaskId }).some(wait => wait.phase === "waiting"));
    rt.store.withTx(() => rt.store.endTask(secondId, ["running"], "completed"));
    await waitFor("整组报告完成且仅一个最终证明", () => listAgentReports(rt.store).length === 2 && listAgentReports(rt.store).every(report => report.status === "reported"));
    const reports = listAgentReports(rt.store), proof = reports[0].proof!;
    assert.deepEqual(reports[0].proof, reports[1].proof);
    assert.deepEqual(getAgentReport(rt.store, firstKey)!.consumption, originalConsumption);
    assert.equal(getAgentReport(rt.store, firstKey)!.source.taskId, parentTaskId);
    assert.ok(proof.entryId);
    if (providerError) {
      assert.equal(rt.store.getTask(followupTaskId)!.status, "failed");
      assert.notEqual(proof.taskId, followupTaskId, "请求失败不能凭旧消费完成报告");
      assert.notEqual(reports.find(report => report.target.kind === "task" && report.target.taskId === secondId)!.consumption!.taskId, followupTaskId);
      assert.equal(proof.taskId, canonicalTaskId); assert.equal(fallbackCalls, 1); assert.equal(rt.readTaskReply(proof.taskId)!.text, "FALLBACK-ONLY-FINAL 两份结果共同完成");
    } else {
      assert.equal(proof.taskId, followupTaskId); assert.equal(fallbackCalls, 0);
      assert.equal(rt.store.getTask(followupTaskId)!.status, "completed");
      assert.equal(rt.readTaskReply(followupTaskId)!.text, "Q-ONLY-FINAL 两份结果共同完成");
      assert.equal(reports.find(report => report.target.kind === "task" && report.target.taskId === secondId)!.consumption!.taskId, followupTaskId);
      assert.equal(rt.store.getTask(canonicalTaskId)!.status, "queued");
    }
    assert.equal(rt.store.getTask(canonicalTaskId)!.requestId, `wake:${firstId}`);
    assert.equal(rt.store.getTask(canonicalTaskId)!.input, "原排队第一项回报输入");
    assert.equal(rt.store.listTasksBySession(sessionId).filter(task => rt.readTaskReply(task.id)?.text.includes("ONLY-FINAL")).length, 1);
    assert.equal(t.server.calls.length, providerError ? 6 : 5);
  } finally { await t.shutdown(); }
});
