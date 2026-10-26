import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowFamily } from "@ruukoto/agent/workflow-tools.ts";
import type { HostToolRuntime } from "@ruukoto/agent/host-tool-families.ts";
import { createManagedProcessRegistry } from "@ruukoto/agent/managed-processes.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { bindWorkflowExecution, createWorkflowRun, getWorkflowDefinition, getWorkflowQuestion, listWorkflowRuns, registerWorkflowStep, rememberWorkflowDefinition, updateWorkflowExecution, updateWorkflowRun, requireWorkflowRun, saveWorkflowDefinition } from "@ruukoto/core/workflow.ts";
import type { Session } from "@ruukoto/core/types.ts";
import { product as codingProduct } from "../apps/ruukoto-code/src/product.ts";
import { afterTool, connectAuthedClient, lastToolText, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";

const WAIT_SCRIPT = 'await progress("state",{text:input.marker}); const a=await ask("pick",{prompt:input.marker,options:["yes","no"]}); return {marker:input.marker,answer:a};';

test("控制面定义历史独立分页，长最终回报不放大运行列表/详情，日志可续读完整正文", async () => {
  const t = await startTestRuntime("workflow-pages", async () => ({ kind: "text", text: "FINAL" }));
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "pages", cwd: t.work[0] });
    const saved = await rt.saveWorkflowDefinition({ name: "history", script: "return 1;", expectedDigest: null, requestKey: "history" });
    rt.store.withTx(() => {
      for (let i = 2; i <= 251; i++) rememberWorkflowDefinition(rt.store, "history", saveWorkflowDefinition(rt.store, "return " + i + ";"));
    });
    const ids = new Set<string>();
    for (let versionOffset = 0; ;) {
      const page = await t.client.request<OpResult<"workflow_definition">>("workflow_definition", { name: "history", length: 1, version_offset: versionOffset });
      assert.equal(page.text, "r"); assert.equal(page.id, saved.id);
      assert.ok(page.versions.length <= 100);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
      for (const version of page.versions) { assert.equal(ids.has(version.id), false); ids.add(version.id); }
      if (page.nextVersionOffset === null) break;
      versionOffset = page.nextVersionOffset;
    }
    assert.equal(ids.size, 251);
    const started = await rt.startWorkflowOwner({ sessionId: session.id, title: "分页运行", script: 'return await ask("q",{prompt:"等待"});', requestKey: "base", input: null });
    await waitFor("分页夹具运行等待", () => requireWorkflowRun(rt.store, started.run.id).status === "waiting");
    const base = requireWorkflowRun(rt.store, started.run.id), facts = "事实".repeat(20000), text = "回报".repeat(20000) + "REPORT-END";
    rt.store.withTx(() => {
      for (let i = 0; i < 50; i++) createWorkflowRun(rt.store, { ...base, id: base.id + "-" + i, requestKey: "report-" + i, status: "succeeded", clockStartedAt: null,
        endedAt: new Date().toISOString(), terminalVersion: base.version, delivery: { version: base.version, status: "reported", taskId: null, reason: null, facts, text } });
    });
    const list = await t.client.request<OpResult<"workflow_list">>("workflow_list", { session_id: session.id });
    assert.equal(list.runs.length, 50);
    assert.ok(Buffer.byteLength(JSON.stringify(list)) < 65536);
    const detail = await t.client.request<OpResult<"workflow_get">>("workflow_get", { run_id: list.runs[0].id });
    assert.deepEqual(detail.run.delivery, { version: base.version, taskId: null, status: "reported", reason: null });
    const first = await t.client.request<OpResult<"workflow_logs">>("workflow_logs", { run_id: detail.run.id, length: 65536 });
    assert.ok(first.totalBytes > Buffer.byteLength(first.text));
    const last = await t.client.request<OpResult<"workflow_logs">>("workflow_logs", { run_id: detail.run.id, offset: first.totalBytes - 128 });
    assert.match(last.text, /REPORT-END/);
  } finally { await t.shutdown(); }
});

test("运行名称、说明和创建时刻固定，旧无名回退；当前列表先保留全部活动项再分页", async () => {
  const t = await startTestRuntime("workflow-titles", async () => ({ kind: "text", text: "FINAL" }));
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "titles", cwd: t.work[0] });
    await rt.saveWorkflowDefinition({ name: "batch", script: WAIT_SCRIPT, expectedDigest: null, requestKey: "save-title" });
    const params = { name: "batch", session_id: session.id, request_id: "named", description: "核对数据后等待确认", input: { marker: "PRIVATE-INPUT" } };
    const named = await t.client.request<OpResult<"workflow_start">>("workflow_start", params);
    assert.equal(named.run.displayName, "batch"); assert.equal(named.run.description, params.description);
    assert.equal(named.run.effectUnknown, false);
    assert.ok(Number.isSafeInteger(named.run.number) && named.run.number > 0);
    assert.equal(named.run.createdAt, requireWorkflowRun(rt.store, named.run.id).createdAt);
    assert.equal(Number.isNaN(Date.parse(named.run.createdAt)), false);
    assert.equal(JSON.stringify(rt.listWorkflows(session.id)).includes("PRIVATE-INPUT"), false);
    const sameName = await rt.startWorkflowOwner({ name: "batch", sessionId: session.id, requestKey: "same-name", input: { marker: "SECOND" } });
    assert.equal(sameName.run.displayName, named.run.displayName); assert.notEqual(sameName.run.id, named.run.id);
    assert.notEqual(sameName.run.number, named.run.number);
    assert.equal(rt.getWorkflowDetail(named.run.id).run.number, named.run.number);
    const temporary = { session_id: session.id, request_id: "temporary", script: 'return await ask("q",{prompt:"选择"});', title: "临时核对", input: null };
    const accepted = await t.client.request<OpResult<"workflow_start">>("workflow_start", temporary);
    assert.equal(accepted.run.displayName, "临时核对"); assert.equal(accepted.run.description, null);
    for (const patch of [{ title: undefined }, { title: "" }, { title: "两行\n名称" }, { title: "x".repeat(65) }, { description: "x".repeat(241) }, { description: "两行\n说明" }]) {
      await assert.rejects(t.client.request("workflow_start", { ...temporary, ...patch, request_id: "invalid" }), error => error instanceof Error && "code" in error && ["invalid_params", "invalid_title", "invalid_description"].includes(String(error.code)));
    }
    await assert.rejects(t.client.request("workflow_start", { ...params, title: "覆盖定义名", request_id: "override" }), { code: "invalid_title" });
    for (const patch of [{ title: "另一标题" }, { description: "新增说明" }]) await assert.rejects(t.client.request("workflow_start", { ...temporary, ...patch }), { code: "request_conflict" });
    assert.equal((await t.client.request<OpResult<"workflow_start">>("workflow_start", temporary)).run.id, accepted.run.id);
    assert.equal(listWorkflowRuns(rt.store).length, 3);
    await waitFor("标题夹具人工等待", () => listWorkflowRuns(rt.store).every(run => run.status === "waiting"));
    const base = requireWorkflowRun(rt.store, named.run.id);
    rt.store.withTx(() => {
      const { displayName: _displayName, description: _description, ...legacy } = base;
      createWorkflowRun(rt.store, { ...legacy, id: "legacy-unnamed", requestKey: "legacy-unnamed" });
      for (let i = 0; i < 12; i++) createWorkflowRun(rt.store, { ...base, id: "recent-" + i, requestKey: "recent-" + i, status: "succeeded", endedAt: base.createdAt });
    });
    const legacy = rt.getWorkflowDetail("legacy-unnamed").run;
    assert.equal(legacy.displayName, "未命名工作流 " + base.createdAt); assert.equal(legacy.description, null);
    const currentIds: string[] = [];
    for (let offset = 0; ;) {
      const page = await t.client.request<OpResult<"workflow_list">>("workflow_list", { session_id: session.id, scope: "current", offset, limit: 2 });
      assert.equal(page.total, 14);
      currentIds.push(...page.runs.map(run => run.id));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    assert.equal(new Set(currentIds).size, 14);
    assert.deepEqual(new Set(currentIds.slice(0, 4)), new Set([named.run.id, sameName.run.id, accepted.run.id, "legacy-unnamed"]));
    assert.equal(currentIds.includes("recent-0"), false); assert.equal(currentIds.includes("recent-11"), true);
    assert.equal((await t.client.request<OpResult<"workflow_list">>("workflow_list", { session_id: session.id, scope: "history" })).total, 16);
    assert.equal(rt.listWorkflows(session.id).total, 16);
    await assert.rejects(t.client.request("workflow_list", { scope: "invalid" }), { code: "invalid_params" });
    rt.store.withTx(() => {
      const child = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "unknown-effect", input: "操作", modelSelection: rt.defaultSelection, submissionDigest: "unknown-effect" }).task;
      rt.store.transitionTask(child.id, ["queued"], "running"); rt.store.setTaskResult(child.id, "已结束但效果未知", "{}"); rt.store.endTask(child.id, ["running"], "completed");
      rt.store.setEffectUnknown(child.id);
      bindWorkflowExecution(rt.store, { id: "unknown-execution", runId: accepted.run.id, stepKey: "q", taskId: child.id, kind: "host", number: 1, status: "finished", units: [], stopVerified: true });
      createWorkflowRun(rt.store, { ...base, id: "unknown-reason", requestKey: "unknown-reason", status: "paused", reason: "effect_unknown" });
    });
    const unknown = await t.client.request<OpResult<"workflow_get">>("workflow_get", { run_id: accepted.run.id });
    assert.equal(unknown.run.effectUnknown, true); assert.equal(unknown.executions[0].stopVerified, true);
    assert.equal(rt.getWorkflowDetail("unknown-reason").run.effectUnknown, true);
  } finally { await t.shutdown(); }
});

test("停止未核实摘要覆盖百项之外的执行和冷崩溃空结论，正常执行不误报", async () => {
  const t = await startTestRuntime("workflow-stop-summary", async () => ({ kind: "text", text: "FINAL" }));
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "stop-summary", cwd: t.work[0] });
    const accepted = await rt.startWorkflowOwner({ sessionId: session.id, requestKey: "active", title: "正常运行", script: 'return await ask("q",{prompt:"等待"});', input: null });
    await waitFor("正常运行人工等待", () => requireWorkflowRun(rt.store, accepted.run.id).status === "waiting");
    const base = requireWorkflowRun(rt.store, accepted.run.id);
    assert.equal(base.scriptStopVerified, null); assert.ok(base.scriptUnits.length);
    assert.equal(rt.getWorkflowDetail(base.id).run.stopUnverified, false);
    const tasks: string[] = [], rollback = new Error("只读投影夹具回滚");
    assert.throws(() => rt.store.withTx(() => {
      const history = createWorkflowRun(rt.store, { ...base, id: "long-stop-history", requestKey: "long-stop-history", status: "running", scriptUnits: [], scriptStopVerified: true });
      registerWorkflowStep(rt.store, { runId: history.id, key: "old", ordinal: 1, kind: "agent", params: { request: "检查" }, dependsOn: [] });
      for (let i = 0; i < 101; i++) {
        const child = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "stop-child-" + i, input: "检查", modelSelection: rt.defaultSelection, submissionDigest: "stop-child-" + i }).task;
        rt.store.transitionTask(child.id, ["queued"], "running"); rt.store.setTaskResult(child.id, "检查结束", "{}"); rt.store.endTask(child.id, ["running"], "completed");
        tasks.push(child.id);
        bindWorkflowExecution(rt.store, { id: "stop-execution-" + i, runId: history.id, stepKey: "old", taskId: child.id, kind: "agent", number: i + 1, status: "finished", units: [], stopVerified: i !== 0 });
      }
      updateWorkflowRun(rt.store, { ...history, status: "paused", reason: "stop_unverified" });
      createWorkflowRun(rt.store, { ...base, id: "cold-stop", requestKey: "cold-stop", status: "paused", reason: "clock_unverified", scriptStopVerified: null });
      createWorkflowRun(rt.store, { ...base, id: "never-started", requestKey: "never-started", status: "canceled", scriptUnits: [], scriptStopVerified: null });
      const view = rt.getWorkflowDetail("long-stop-history");
      assert.equal(view.executions.length, 100); assert.equal(view.executions.some(execution => execution.stopVerified === false), false);
      assert.equal(view.run.stopUnverified, true);
      assert.equal(rt.getWorkflowDetail("cold-stop").run.stopUnverified, true);
      assert.equal(rt.getWorkflowDetail("never-started").run.stopUnverified, false);
      updateWorkflowExecution(rt.store, tasks[0], { stopVerified: true });
      updateWorkflowExecution(rt.store, tasks.at(-1)!, { status: "running", stopVerified: true });
      assert.equal(rt.getWorkflowDetail("long-stop-history").run.stopUnverified, true);
      updateWorkflowExecution(rt.store, tasks.at(-1)!, { status: "finished", stopVerified: null });
      assert.equal(rt.getWorkflowDetail("long-stop-history").run.stopUnverified, true);
      updateWorkflowExecution(rt.store, tasks.at(-1)!, { stopVerified: true });
      assert.equal(rt.getWorkflowDetail("long-stop-history").run.stopUnverified, false);
      throw rollback;
    }), error => error === rollback);
  } finally { await t.shutdown(); }
});

for (const product of [codingProduct.runtime]) test((product?.type ?? "ruukoto") + " 空闲会话显式启动、带参复用与多个运行不占聊天，原键拒绝授权字段", async () => {
  const t = await startTestRuntime("workflow-entries", async () => ({ kind: "text", text: "CHAT-OK" }), { config: product ? { product } : {} });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "entries", cwd: t.work[0] });
    await t.client.request("workflow_save", { name: "batch", script: WAIT_SCRIPT, expected_digest: null, request_id: "save" });
    const first = await t.client.request<OpResult<"workflow_start">>("workflow_start", { name: "batch", session_id: session.id, request_id: "first", input: { marker: "ONE" } });
    const second = await t.client.request<OpResult<"workflow_start">>("workflow_start", { name: "batch", session_id: session.id, request_id: "second", input: { marker: "TWO" } });
    await waitFor("两项人工等待", () => listWorkflowRuns(rt.store).every(run => run.status === "waiting"));
    assert.notEqual(first.run.id, second.run.id);
    for (const run of listWorkflowRuns(rt.store)) {
      const source = rt.store.getTask(run.source.taskId)!;
      assert.equal(source.status, "completed"); assert.match(source.resultRef!, /hostStart/);
      assert.equal(run.source.accessMode, session.defaultAccessMode);
      assert.equal(run.source.sessionId, session.id);
    }
    assert.equal(t.server.calls.length, 0, "显式启动只登记短期宿主任务，不调用模型");
    const logs = await t.client.request<OpResult<"workflow_logs">>("workflow_logs", { run_id: first.run.id });
    assert.match(logs.text, /ONE/);
    const detail = await t.client.request<OpResult<"workflow_get">>("workflow_get", { run_id: first.run.id });
    assert.equal(detail.steps.find(step => step.key === "pick")!.question, "pending");
    assert.equal("authority" in detail.run, false);
    const chat = await rt.submit({ sessionId: session.id, requestId: "chat", input: "日常聊天", modelSelection: rt.defaultSelection });
    await waitFor("等待中聊天完成", () => rt.store.getTask(chat.id)!.status === "completed");
    assert.equal(requireWorkflowRun(rt.store, first.run.id).status, "waiting");
    assert.equal(requireWorkflowRun(rt.store, second.run.id).status, "waiting");
    const q = getWorkflowQuestion(rt.store, first.run.id, "pick")!;
    const displayed = await t.client.request<OpResult<"workflow_question">>("workflow_question", { run_id: first.run.id, step_key: "pick", length: 1 });
    assert.deepEqual(displayed.choices, ["yes", "no"], "选择不依赖分页正文的完整性");
    assert.equal(await t.client.request("workflow_receipt", { run_id: first.run.id, request_id: "answer", operation: "workflow_answer" }), null);
    await t.client.request("workflow_answer", { run_id: first.run.id, step_key: "pick", run_version: q.runVersion, question_version: q.version, request_id: "answer", answer: "yes" });
    await waitFor("仅第一项结束", () => requireWorkflowRun(rt.store, first.run.id).status === "succeeded");
    assert.equal(requireWorkflowRun(rt.store, second.run.id).status, "waiting");
    const expectedReceipt = { operation: "workflow_answer", runId: first.run.id, stepKey: "pick", status: "answered", version: q.version + 1, runVersion: q.runVersion };
    const eventCount = rt.store.getMaxSeq();
    assert.deepEqual(rt.findWorkflowReceipt(first.run.id, "answer", "workflow_answer"), expectedReceipt);
    assert.equal(rt.store.getMaxSeq(), eventCount, "同步核实不发事件；网络等待期间的最终回报可独立推进");
    assert.deepEqual(await t.client.request("workflow_receipt", { run_id: first.run.id, request_id: "answer", operation: "workflow_answer" }), expectedReceipt);
    assert.equal(await t.client.request("workflow_receipt", { run_id: second.run.id, request_id: "answer", operation: "workflow_answer" }), null);
    await assert.rejects(t.client.request("workflow_receipt", { run_id: first.run.id, request_id: "answer", operation: "resume" }), { code: "invalid_params" });
    await assert.rejects(t.client.request("workflow_start", { name: "batch", session_id: session.id, request_id: "forge", input: {}, authority: { accessMode: "full_access" } }), { code: "invalid_params" });
    await assert.rejects(t.client.request("workflow_start", { name: "batch", session_id: session.id, request_id: "raise", input: {}, max_attempts: 101 }), { code: "invalid_params" });
    const before = requireWorkflowRun(rt.store, second.run.id);
    await t.client.request("workflow_control", { run_id: before.id, expected_version: before.version, request_id: "owner-budget", control: { action: "budget", maxAttempts: 150, durationMs: 7200000 } });
    assert.equal(requireWorkflowRun(rt.store, before.id).maxAttempts, 150);
    const current = requireWorkflowRun(rt.store, before.id);
    await t.client.request("workflow_control", { run_id: current.id, expected_version: current.version, request_id: "cancel", control: { action: "cancel" } });
    assert.equal(requireWorkflowRun(rt.store, current.id).status, "canceled");
    const receipt = await t.client.request<OpResult<"workflow_receipt">>("workflow_receipt", { run_id: current.id, request_id: "owner-budget", operation: "workflow_control" });
    assert.ok(receipt);
    assert.equal(receipt.status, "waiting", "回执保留原接受结果，不用已取消的当前状态替代");
    assert.equal(receipt.version, before.version + 1);
    assert.equal("source" in receipt, false);
    await t.client.request("workflow_control", { run_id: current.id, expected_version: current.version, request_id: "cancel", control: { action: "cancel" } });
    await assert.rejects(t.client.request("workflow_control", { run_id: current.id, expected_version: current.version + 1, request_id: "cancel", control: { action: "cancel" } }), { code: "request_conflict" });
    const count = listWorkflowRuns(rt.store).length;
    const latestSession = rt.store.getSession(session.id)!;
    await rt.setSessionDefaultMode({ sessionId: session.id, expectedVersion: latestSession.defaultAccessModeVersion, mode: "plan" });
    await assert.rejects(t.client.request("workflow_start", { session_id: session.id, name: "batch", input: {}, request_id: "plan" }), { code: "source_forbidden" });
    assert.equal(listWorkflowRuns(rt.store).length, count);
  } finally { await t.shutdown(); }
});

test("当前定义更新和删除不改变原键或重启恢复固定版本；拒绝异参及错误文件而不新建来源任务", async () => {
  const t = await startTestRuntime("workflow-entry-replay", async () => ({ kind: "text", text: "FINAL" }));
  let current = t.runtime;
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "fixed", cwd: t.work[0] });
    const saved = await t.client.request<OpResult<"workflow_save">>("workflow_save", { name: "batch", script: WAIT_SCRIPT, expected_digest: null, request_id: "old" });
    const params = { name: "batch", session_id: session.id, request_id: "fixed", input: { marker: "ORIGINAL" } };
    const accepted = await t.client.request<OpResult<"workflow_start">>("workflow_start", params);
    await waitFor("原问题", () => requireWorkflowRun(rt.store, accepted.run.id).status === "waiting");
    await t.client.request("workflow_save", { name: "batch", script: 'return "NEW";', expected_digest: saved.digest, request_id: "new" });
    assert.equal(getWorkflowDefinition(rt.store, accepted.run.definitionId)!.script, WAIT_SCRIPT);
    assert.equal(accepted.run.displayName, "batch");
    assert.equal(rt.getWorkflowDetail(accepted.run.id).run.displayName, "batch");
    fs.unlinkSync(path.join(t.dirs.agentDir, "workflows", "batch.js"));
    assert.equal((await t.client.request<OpResult<"workflow_start">>("workflow_start", params)).run.id, accepted.run.id);
    await assert.rejects(t.client.request("workflow_start", { ...params, input: { marker: "CHANGED" } }), { code: "request_conflict" });
    const taskCount = rt.store.listTasksBySession(session.id).length;
    await assert.rejects(t.client.request("workflow_start", { ...params, request_id: "missing" }), { code: "definition_missing" });
    assert.equal(rt.store.listTasksBySession(session.id).length, taskCount);
    const beforeRestart = requireWorkflowRun(rt.store, accepted.run.id);
    await t.client.request("workflow_control", { run_id: beforeRestart.id, expected_version: beforeRestart.version, request_id: "persisted-budget",
      control: { action: "budget", maxAttempts: 101, durationMs: 3600000 } });
    t.client.close(); await rt.stop("restart");
    current = await Runtime.start(rt.config); await ControlServer.start(current);
    const client = await connectAuthedClient(current);
    try {
      assert.deepEqual(await client.request("workflow_receipt", { run_id: accepted.run.id, request_id: "persisted-budget", operation: "workflow_control" }),
        { operation: "workflow_control", runId: accepted.run.id, status: "waiting", version: beforeRestart.version + 1 });
      assert.equal((await client.request<OpResult<"workflow_start">>("workflow_start", params)).run.id, accepted.run.id);
      const run = requireWorkflowRun(current.store, accepted.run.id);
      await client.request("workflow_control", { run_id: run.id, expected_version: run.version, request_id: "resume", control: { action: "resume" } });
      assert.equal((await client.request<OpResult<"workflow_receipt">>("workflow_receipt", { run_id: run.id, request_id: "resume", operation: "workflow_control" }))?.status, "running");
      await waitFor("恢复原问题", () => requireWorkflowRun(current.store, run.id).status === "waiting");
      const q = getWorkflowQuestion(current.store, run.id, "pick")!;
      await client.request("workflow_answer", { run_id: run.id, step_key: "pick", run_version: q.runVersion, question_version: q.version, request_id: "answer", answer: "yes" });
      await waitFor("恢复完成", () => requireWorkflowRun(current.store, run.id).status === "succeeded");
      assert.match(JSON.stringify(requireWorkflowRun(current.store, run.id).result), /ORIGINAL/);
      assert.equal(requireWorkflowRun(current.store, run.id).scriptDigest, saved.digest);
      assert.equal(requireWorkflowRun(current.store, run.id).attempts, 0);
    } finally { client.close(); }
  } finally { await current.stop("test_end"); await t.shutdown(); }
});

for (const product of [codingProduct.runtime]) test((product?.type ?? "ruukoto") + " 真实 Driver 自主发起工具与说明进入历史；步骤没有嵌套工具", async () => {
  const t = await startTestRuntime("workflow-tool-entry", req => {
    if (lastUserText(req).startsWith("[工作流最终回报]")) return { kind: "text", text: "FINAL" };
    if (lastUserText(req).includes("WORKFLOW-STEP")) {
      assert.equal(toolNamesOf(req).some(name => name.startsWith("workflow_")), false);
      return { kind: "text", text: "STEP" };
    }
    if (!afterTool(req)) {
      assert.ok(toolNamesOf(req).includes("workflow_start"));
      return { kind: "tool_calls", calls: [{ id: "instructions", name: "workflow_instructions", arguments: {} }] };
    }
    if (lastToolText(req).startsWith("工作流是固定脚本")) return { kind: "tool_calls", calls: [{ id: "launch", name: "workflow_start", arguments: {
      title: "自主处理", description: "后台处理并等待选择", script: 'await agent("one",{request:"WORKFLOW-STEP"}); return await ask("owner",{prompt:input.prompt,dependsOn:["one"]});', input: { prompt: "AUTONOMOUS" }, key: "auto", max_attempts: 2,
    } }] };
    return { kind: "text", text: "后台已启动" };
  }, { config: { ...realTools(), ...(product ? { product } : {}) } });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "model", cwd: t.work[0] });
    const task = await rt.submit({ sessionId: session.id, requestId: "model", input: "自主安排这个工作", modelSelection: rt.defaultSelection });
    await waitFor("来源任务结束且工作流等待", () => rt.store.getTask(task.id)!.status === "completed" && listWorkflowRuns(rt.store)[0]?.status === "waiting");
    const run = listWorkflowRuns(rt.store)[0];
    assert.equal(run.source.taskId, task.id); assert.equal(run.maxAttempts, 2);
    assert.equal(run.displayName, "自主处理"); assert.equal(run.description, "后台处理并等待选择");
    const history = fs.readFileSync(rt.store.getSession(session.id)!.sessionFile!, "utf8");
    assert.match(history, /workflow_instructions/); assert.match(history, /没有 Node/); assert.match(history, /AUTONOMOUS/);
    assert.equal(t.server.calls.length, 4);
    await rt.controlWorkflow({ runId: run.id, version: run.version, requestKey: "owner-cancel", control: { action: "cancel" } });
  } finally { await t.shutdown(); }
});

function active(rt: Runtime, session: Session, key: string) {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: key, input: "拥有者来源", modelSelection: rt.defaultSelection, submissionDigest: key }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}

test("模型保存异步期间取消不落文件；查询/取消只限来源，账本核对完整请求", async () => {
  const t = await startTestRuntime("workflow-tool-guards", async () => ({ kind: "text", text: "unused" }));
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "guards", cwd: t.work[0] }), task = active(rt, session, "source");
    const family = createWorkflowFamily(rt);
    const ctx = { taskId: task.id, sessionId: session.id, projectId: session.projectId, hostOpId: "call" };
    const host: HostToolRuntime = {
      registry: createManagedProcessRegistry(), toolClass: "dev", call: { taskContext: () => ctx, bindCall: () => ({ context: ctx, release() {} }) },
      identity: { verifyHost: () => null, verifyMain: () => null }, skills: () => null,
      effects: { recordArtifact() {}, markEffectUnknown() {} },
      approval: { request: async () => { throw new Error("unused"); }, requestStanding: () => { throw new Error("unused"); } },
    };
    const tools = family.build(host);
    const invoke = (name: string, params: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute("call", params, undefined, undefined, {} as ExtensionToolContext);
    const pending = invoke("workflow_save", { name: "late", script: "return 1;", key: "late", expected_digest: null });
    rt.store.withTx(() => rt.store.endTask(task.id, ["running"], "canceled"));
    await assert.rejects(pending, { code: "source_invalid" });
    assert.equal(rt.workflowLibrary.saved("agent:" + session.id + ":late"), null);
    assert.equal(fs.existsSync(path.join(t.dirs.agentDir, "workflows", "late.js")), false);
    const next = active(rt, session, "next"); ctx.taskId = next.id;
    await invoke("workflow_save", { name: "old", script: "return 1;", key: "same", expected_digest: null });
    await assert.rejects(invoke("workflow_save", { name: "new", script: "return 2;", key: "same", expected_digest: null }), { code: "request_conflict" });
    let n = 0;
    const verdict = (name: string, params: Record<string, unknown>) => {
      const id = "op" + (++n);
      rt.store.withTx(() => rt.store.recordToolIntent({ id, taskId: next.id, sessionId: session.id, toolName: name, params }));
      return family.ledger!.familyCheck!.verify(rt.store.getToolOp(id)!);
    };
    assert.equal(verdict("workflow_save", { name: "old", script: "return 1;", key: "same", expected_digest: null }), "committed");
    assert.equal(verdict("workflow_save", { name: "new", script: "return 2;", key: "same", expected_digest: null }), "not_committed");
    const launch = { title: "账本核实", description: "等待业务答复", script: 'return await ask("q",{prompt:"wait"});', input: null, key: "start" };
    await invoke("workflow_start", launch);
    const run = listWorkflowRuns(rt.store)[0];
    await waitFor("等待来源问题", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    assert.equal(verdict("workflow_start", launch), "committed");
    assert.equal(verdict("workflow_start", { ...launch, input: "different" }), "not_committed");
    assert.equal(verdict("workflow_start", { ...launch, title: "另一项" }), "not_committed");
    assert.equal(verdict("workflow_start", { ...launch, description: "另一说明" }), "not_committed");
    const foreign = await rt.createSession({ projectName: "foreign", cwd: t.work[1] });
    const foreignTask = active(rt, foreign, "foreign");
    ctx.sessionId = foreign.id; ctx.projectId = foreign.projectId; ctx.taskId = foreignTask.id;
    await assert.rejects(invoke("workflow_query", { part: "run", run_id: run.id }), { code: "run_forbidden" });
    await assert.rejects(invoke("workflow_cancel", { run_id: run.id, version: requireWorkflowRun(rt.store, run.id).version, key: "foreign" }), { code: "run_forbidden" });
    ctx.sessionId = session.id; ctx.projectId = session.projectId; ctx.taskId = next.id;
    const cancel = { run_id: run.id, version: requireWorkflowRun(rt.store, run.id).version, key: "cancel" };
    await invoke("workflow_cancel", cancel);
    assert.equal(verdict("workflow_cancel", cancel), "committed");
    assert.equal(verdict("workflow_cancel", { ...cancel, version: cancel.version + 1 }), "not_committed");
  } finally { await t.shutdown(); }
});
