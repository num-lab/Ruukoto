import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowFamily } from "@ruukoto/agent/workflow-tools.ts";
import type { HostToolRuntime } from "@ruukoto/agent/host-tool-families.ts";
import { createManagedProcessRegistry } from "@ruukoto/agent/managed-processes.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { createWorkflowRun, getWorkflowDefinition, getWorkflowQuestion, listWorkflowRuns, rememberWorkflowDefinition, requireWorkflowRun, saveWorkflowDefinition } from "@ruukoto/core/workflow.ts";
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
    const started = await rt.startWorkflowOwner({ sessionId: session.id, script: 'return await ask("q",{prompt:"等待"});', requestKey: "base", input: null });
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

for (const product of [undefined, codingProduct.runtime]) test((product?.type ?? "ruukoto") + " 空闲会话显式启动、带参复用与多个运行不占聊天，原键拒绝授权字段", async () => {
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
    await t.client.request("workflow_answer", { run_id: first.run.id, step_key: "pick", run_version: q.runVersion, question_version: q.version, request_id: "answer", answer: "yes" });
    await waitFor("仅第一项结束", () => requireWorkflowRun(rt.store, first.run.id).status === "succeeded");
    assert.equal(requireWorkflowRun(rt.store, second.run.id).status, "waiting");
    await assert.rejects(t.client.request("workflow_start", { name: "batch", session_id: session.id, request_id: "forge", input: {}, authority: { accessMode: "full_access" } }), { code: "invalid_params" });
    await assert.rejects(t.client.request("workflow_start", { name: "batch", session_id: session.id, request_id: "raise", input: {}, max_attempts: 101 }), { code: "invalid_params" });
    const before = requireWorkflowRun(rt.store, second.run.id);
    await t.client.request("workflow_control", { run_id: before.id, expected_version: before.version, request_id: "owner-budget", control: { action: "budget", maxAttempts: 150, durationMs: 7200000 } });
    assert.equal(requireWorkflowRun(rt.store, before.id).maxAttempts, 150);
    const current = requireWorkflowRun(rt.store, before.id);
    await t.client.request("workflow_control", { run_id: current.id, expected_version: current.version, request_id: "cancel", control: { action: "cancel" } });
    assert.equal(requireWorkflowRun(rt.store, current.id).status, "canceled");
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
    fs.unlinkSync(path.join(t.dirs.agentDir, "workflows", "batch.js"));
    assert.equal((await t.client.request<OpResult<"workflow_start">>("workflow_start", params)).run.id, accepted.run.id);
    await assert.rejects(t.client.request("workflow_start", { ...params, input: { marker: "CHANGED" } }), { code: "request_conflict" });
    const taskCount = rt.store.listTasksBySession(session.id).length;
    await assert.rejects(t.client.request("workflow_start", { ...params, request_id: "missing" }), { code: "definition_missing" });
    assert.equal(rt.store.listTasksBySession(session.id).length, taskCount);
    t.client.close(); await rt.stop("restart");
    current = await Runtime.start(rt.config); await ControlServer.start(current);
    const client = await connectAuthedClient(current);
    try {
      assert.equal((await client.request<OpResult<"workflow_start">>("workflow_start", params)).run.id, accepted.run.id);
      const run = requireWorkflowRun(current.store, accepted.run.id);
      await client.request("workflow_control", { run_id: run.id, expected_version: run.version, request_id: "resume", control: { action: "resume" } });
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

for (const product of [undefined, codingProduct.runtime]) test((product?.type ?? "ruukoto") + " 真实 Driver 自主发起工具与说明进入历史；步骤没有嵌套工具", async () => {
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
      script: 'await agent("one",{request:"WORKFLOW-STEP"}); return await ask("owner",{prompt:input.prompt,dependsOn:["one"]});', input: { prompt: "AUTONOMOUS" }, key: "auto", max_attempts: 2,
    } }] };
    return { kind: "text", text: "后台已启动" };
  }, { config: { ...realTools(), ...(product ? { product } : {}) } });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "model", cwd: t.work[0] });
    const task = await rt.submit({ sessionId: session.id, requestId: "model", input: "自主安排这个工作", modelSelection: rt.defaultSelection });
    await waitFor("来源任务结束且工作流等待", () => rt.store.getTask(task.id)!.status === "completed" && listWorkflowRuns(rt.store)[0]?.status === "waiting");
    const run = listWorkflowRuns(rt.store)[0];
    assert.equal(run.source.taskId, task.id); assert.equal(run.maxAttempts, 2);
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

test("个人 main 控制面拥有者任务可自主发起，无来源的内部 main 任务不能借身份启动", async () => {
  const t = await startTestRuntime("workflow-main-source", req => {
    if (afterTool(req) || lastUserText(req).startsWith("[工作流最终回报]")) return { kind: "text", text: "已处理" };
    const key = lastUserText(req) === "拥有者请求" ? "owner" : "internal";
    return { kind: "tool_calls", calls: [{ id: key, name: "workflow_start", arguments: { key, input: null, script: 'return await ask("q",{prompt:"选择"});' } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, main = rt.store.getAgentRole("main")!;
    const task = await rt.submit({ sessionId: main.sessionId, requestId: "owner", input: "拥有者请求", modelSelection: rt.defaultSelection });
    await waitFor("拥有者 main 请求结束并留下后台运行", () => rt.store.getTask(task.id)!.status === "completed" && listWorkflowRuns(rt.store)[0]?.status === "waiting");
    const run = listWorkflowRuns(rt.store)[0];
    assert.equal(run.source.replyTarget, null); assert.equal(run.source.taskId, task.id);
    const internal = rt.store.withTx(() => {
      const task = rt.store.insertQueuedTask({ sessionId: main.sessionId, agentId: "main", requestId: "internal", input: "内部来源", submissionDigest: "internal", modelSelection: rt.defaultSelection }).task;
      rt.store.transitionTask(task.id, ["queued"], "running");
      return task;
    });
    await assert.rejects(rt.startWorkflowTask({ taskId: internal.id, requestKey: "internal", input: null, script: 'return await ask("q",{prompt:"选择"});' }), { code: "source_forbidden" });
    assert.equal(listWorkflowRuns(rt.store).length, 1);
    rt.store.withTx(() => { rt.store.setTaskResult(internal.id, "内部来源已拒绝", "{}"); rt.store.endTask(internal.id, ["running"], "completed"); });
  } finally { await t.shutdown(); }
});
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
    const invoke = (name: string, params: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute("call", params, undefined, undefined, {} as ExtensionContext);
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
    const launch = { script: 'return await ask("q",{prompt:"wait"});', input: null, key: "start" };
    await invoke("workflow_start", launch);
    const run = listWorkflowRuns(rt.store)[0];
    await waitFor("等待来源问题", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    assert.equal(verdict("workflow_start", launch), "committed");
    assert.equal(verdict("workflow_start", { ...launch, input: "different" }), "not_committed");
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
