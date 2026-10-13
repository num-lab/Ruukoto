import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AccessScope } from "@ruukoto/core/access.ts";
import { randomId, type Artifact, type Session, type Task } from "@ruukoto/core/types.ts";
import { listWorkflowExecutions, requireWorkflowRun, type WorkflowRun } from "@ruukoto/core/workflow.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { SourceRef } from "@ruukoto/channels/scheduler/store.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";
import { afterTool, inputText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { getWorkflowStep } from "@ruukoto/core/workflow.ts";

function ownerSource(rt: Runtime, session: Session, accessMode: "full_access" | "confirm" = "full_access"): Task {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const id = randomId("source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: id, input: "拥有者授权工作流",
      modelSelection: rt.defaultSelection, submissionDigest: id, accessMode }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}

/** 定时来源复用 main 的业务授权，无平台连接或伪造 IM 身份。 */
function personalSource(rt: Runtime): Task {
  const main = rt.store.getAgentRole("main")!, parent = rt.store.getSession(main.sessionId)!;
  return rt.store.withTx(() => {
    const id = randomId("source");
    const creator = rt.store.insertQueuedTask({ sessionId: main.sessionId, requestId: `${id}:creator`, input: "建立计划",
      modelSelection: rt.defaultSelection, submissionDigest: id, accessMode: "full_access" }).task;
    rt.store.endTask(creator.id, ["queued"], "completed");
    const schedule = rt.sched.insertSchedule({ createKey: id, paramsDigest: id, createTaskId: creator.id, createOpId: null,
      createPermissionVersion: creator.permissionVersion, projectId: main.projectId, accessMode: "full_access", instruction: "独立个人事务",
      sourceRefs: [], target: null, rule: { kind: "once", at: "2030-01-01T00:00:00Z", timeZone: "UTC", disambiguation: "compatible" },
      nextDueAt: "2030-01-01T00:00:00Z", tzData: "test", reason: "离线验收" }, "test");
    const event = rt.store.registerInboundEvent({ source: "scheduler", externalId: id, actor: null, targetRole: "main", body: "计划到期" }).event;
    const session = rt.store.createSession({ projectId: main.projectId, cwd: parent.cwdReal, cwdReal: parent.cwdReal,
      cwdDev: parent.cwdDev, cwdIno: parent.cwdIno, piSessionId: id, confirmTools: [] });
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: id, input: "独立个人事务", modelSelection: rt.defaultSelection,
      submissionDigest: id, accessMode: "full_access", sourceEventId: event.id }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    rt.sched.insertRun({ id, scheduleId: schedule.id, scheduleVersion: schedule.version, scheduledFor: "2030-01-01T00:00:00Z",
      localTime: "2030-01-01T00:00:00", registeredAt: new Date().toISOString(), delayMs: 0, coalescedFrom: null, coalescedTo: null,
      inboundEventId: event.id, notificationOpId: null, sessionId: session.id, rootTaskId: task.id, resultStatus: null, resultText: null });
    return rt.store.getTask(task.id)!;
  });
}

async function finished(rt: Runtime, run: WorkflowRun): Promise<WorkflowRun> {
  await waitFor("工作流收尾", () => ["succeeded", "partial", "failed", "paused", "canceled"].includes(requireWorkflowRun(rt.store, run.id).status));
  return requireWorkflowRun(rt.store, run.id);
}

function seedNotice(rt: Runtime, source: Task, artifact: Artifact, text: string): string {
  const ref: SourceRef = { kind: "artifact", ref: `artifact:${artifact.id}@0+${Buffer.byteLength(text)}`,
    version: String(artifact.byteCount), sha256: createHash("sha256").update(text).digest("hex") };
  return rt.sched.insertOp({ sourceKind: "tool", sourceKey: randomId("notice"), taskId: source.id, hostOpId: null,
    target: { channel: "mock", account: "mock", chatId: "mock", configVersion: 1 }, text, sourceRefs: [ref] }).op.id;
}

test("真实个人步骤修改应用 schema 后仍可继续，main 业务来源没有 HTTP 或额外编码工具", async () => {
  const t = await startTestRuntime("workflow-personal-schema", req => afterTool(req) ? { kind: "text", text: "建表完成" } :
    { kind: "tool_calls", calls: [{ id: "define", name: "app_data_define_table", arguments: { table: "workflow_rows",
      fields: [{ name: "value", type: "text" }], expected_schema_version: 0, reason: "拥有者授权步骤建表" } }] }, { config: realTools() });
  try {
    const rt = t.runtime, source = personalSource(rt);
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "schema", script: 'return await agent("business",{request:"建一张表"});', input: null });
    assert.equal((await finished(rt, run)).status, "succeeded");
    assert.equal(t.server.calls.length, 2);
    const names = toolNamesOf(t.server.calls[0]);
    for (const name of ["app_data_define_table", "app_data_query", "schedule_query", "read", "read_artifact"]) assert.ok(names.includes(name), name);
    for (const name of ["http_request", "request_file_access", "todo_write", "edit", "write", "bash"]) assert.ok(!names.includes(name), name);
    const taskId = listWorkflowExecutions(rt.store, run.id).find(execution => execution.kind === "agent")!.taskId;
    const ops = rt.store.listToolOpsByTask(taskId);
    assert.equal(ops.length, 1);
    assert.match(ops[0].resultSummary!, /已创建表 workflow_rows.*schema v1/);
    assert.match(inputText(t.server.calls[1]), /已创建表 workflow_rows/);
  } finally { await t.shutdown(); }
});

test("个人来源的修改步骤只增加已有委派的五个编码工具", async () => {
  const t = await startTestRuntime("workflow-personal-modify", req => {
    if (afterTool(req)) return { kind: "text", text: "修改完成" };
    const names = toolNamesOf(req);
    for (const name of ["read", "edit", "write", "bash", "read_artifact", "app_data_query", "schedule_query"]) assert.ok(names.includes(name), name);
    for (const name of ["http_request", "request_file_access", "todo_write"]) assert.ok(!names.includes(name), name);
    return { kind: "tool_calls", calls: [{ id: "write", name: "write", arguments: { path: "value.txt", content: "changed\n" } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, source = personalSource(rt), session = rt.store.getSession(source.sessionId)!;
    fs.writeFileSync(path.join(session.cwdReal, "value.txt"), "base\n"); initGitRepo(session.cwdReal);
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "modify", script: 'return await agent("modify",{request:"修改",mode:"modify",target:"."});', input: null });
    assert.equal((await finished(rt, run)).status, "succeeded");
    assert.ok(getWorkflowStep(rt.store, run.id, "modify")!.frozen);
    assert.equal(fs.readFileSync(path.join(session.cwdReal, "value.txt"), "utf8"), "base\n");
  } finally { await t.shutdown(); }
});

test("memory_list 的预览来源落盘，祖先记忆撤销阻止间接缓存进入后续模型", async () => {
  const t = await startTestRuntime("workflow-memory-closure", req => {
    const text = inputText(req);
    if (text.includes('"request":"列出记忆"') && !afterTool(req)) return { kind: "tool_calls", calls: [{ id: "memory", name: "memory_list", arguments: {} }] };
    return { kind: "text", text: "MEMORY_PREVIEW_DERIVED_RESULT" };
  }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), source = ownerSource(rt, session);
    const memory = rt.ownerSaveMemory({ projectId: session.projectId, category: "experience", content: "MEMORY_PREVIEW_DERIVED_RESULT",
      sourceRefs: [{ kind: "owner_note", note: "拥有者提供" }] });
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "memory", script: 'await agent("a",{request:"列出记忆"}); await agent("b",{request:"中间摘要",dependsOn:["a"]}); await ask("hold",{prompt:"等待"}); return await agent("c",{request:"最后处理",dependsOn:["b","hold"]});', input: null });
    await waitFor("祖先结果缓存完成", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    assert.deepEqual(getWorkflowStep(rt.store, run.id, "a")!.readMemories, [memory.id]);
    const calls = t.server.calls.length;
    rt.ownerRevokeMemory({ memoryId: memory.id, expectedVersion: memory.currentVersion });
    rt.workflows!.answer(run.id, "hold", 1, "继续", run.source);
    assert.equal((await finished(rt, run)).status, "paused");
    assert.equal(t.server.calls.length, calls);
  } finally { await t.shutdown(); }
});

test("运行后新增资料授权不扩大步骤范围，直接产物与通知查询使用同一固定授权", async () => {
  let access!: AccessScope, from = "", to = "", artifactId = "", noticeId = "";
  const t = await startTestRuntime("workflow-new-grant", req => {
    if (afterTool(req)) return { kind: "text", text: "范围核实完成" };
    access.createGrant({ fromProjectId: from, toProjectId: to, category: "artifact" });
    return { kind: "tool_calls", calls: [{ id: "direct", name: "read_artifact", arguments: { artifact_id: artifactId } },
      { id: "notice", name: "notification_query", arguments: { op_id: noticeId } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, source = personalSource(rt), sourceSession = rt.store.getSession(source.sessionId)!;
    to = sourceSession.projectId;
    access = new AccessScope(rt.store.db);
    const foreign = await rt.createSession({ projectName: "foreign", cwd: t.work[0] });
    from = foreign.projectId;
    rt.store.setSessionQueueState(foreign.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: foreign.id, requestId: "foreign", input: "拥有者保存的资料",
      modelSelection: rt.defaultSelection, submissionDigest: "foreign" }).task;
    const artifacts = new ArtifactStore(rt.config.dataDir, rt.store), text = "UNAUTHORIZED_FOREIGN_SCOPE_DATA";
    const artifact = artifacts.begin({ taskId: task.id, sessionId: foreign.id, name: "foreign-source" });
    artifacts.append(artifact.id, Buffer.from(text));
    artifacts.complete(artifact.id);
    artifactId = artifact.id;
    noticeId = seedNotice(rt, source, rt.store.getArtifact(artifact.id)!, text);
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "fixed-grants",
      script: 'return await agent("scope",{request:"核实资料范围",tools:["read_artifact","notification_query"]});', input: null });
    assert.deepEqual(run.source.authority!.grantIds, []);
    assert.equal((await finished(rt, run)).status, "succeeded");
    const textAfter = inputText(t.server.calls[1]);
    assert.match(textAfter, /产物不属于可读取范围/);
    assert.match(textAfter, /发送资料不可读/);
    assert.ok(!textAfter.includes(text));
    assert.equal(access.listGrants().length, 1);
  } finally { await t.shutdown(); }
});

test("同一来源的不同运行隔离真实产物、子历史与引用产物的通知正文", async () => {
  let old = true, sourceFile = "", artifactId = "", previousSession = "", noticeId = "";
  const t = await startTestRuntime("workflow-cross-run", req => {
    if (afterTool(req)) return { kind: "text", text: "步骤完成" };
    if (old) return { kind: "tool_calls", calls: [{ id: "read", name: "read", arguments: { path: sourceFile } }] };
    return { kind: "tool_calls", calls: [{ id: "artifact", name: "read_artifact", arguments: { artifact_id: artifactId } },
      { id: "history", name: "history_read", arguments: { session_id: previousSession, entry_id: "private" } },
      { id: "notice", name: "notification_query", arguments: { op_id: noticeId } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, source = personalSource(rt), text = "PRIOR_RUN_RESULT_BODY";
    sourceFile = path.join(rt.store.getSession(source.sessionId)!.cwdReal, "source.txt");
    fs.writeFileSync(sourceFile, text);
    const first = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "first",
      script: 'return await agent("read",{request:"读取来源文件",tools:["read"]});', input: null });
    assert.equal((await finished(rt, first)).status, "succeeded");
    const previousTask = listWorkflowExecutions(rt.store, first.id).find(execution => execution.kind === "agent")!.taskId;
    previousSession = rt.store.getTask(previousTask)!.sessionId;
    const artifact = rt.store.listArtifactsByTask(previousTask).find(item => item.name === "read 文件正文")!;
    assert.ok(artifact);
    artifactId = artifact.id;
    noticeId = seedNotice(rt, source, artifact, text);
    assert.match(inputText(t.server.calls[1]), /PRIOR_RUN_RESULT_BODY/);
    old = false;
    const callIndex = t.server.calls.length;
    const second = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "second",
      script: 'return await agent("scope",{request:"核实本次运行资料",tools:["read_artifact","history_read","notification_query"]});', input: null });
    assert.equal((await finished(rt, second)).status, "succeeded");
    const textAfter = inputText(t.server.calls[callIndex + 1]);
    assert.match(textAfter, /产物不属于可读取范围/);
    assert.match(textAfter, /该会话不在本步骤的资料范围/);
    assert.match(textAfter, /发送资料不可读/);
    assert.ok(!textAfter.includes(text));
  } finally { await t.shutdown(); }
});

for (const mode of ["full_access", "confirm", "configuration", "revoke"] as const) test(`真实工作流 MCP：${mode} 的调用、批准与来源失效`, async () => {
  const mcp = await startMockMcp({ tools: [{ name: "write", result: { content: [{ type: "text", text: "written-once" }] } }] });
  const t = await startTestRuntime(`workflow-mcp-${mode}`, req => afterTool(req) ? { kind: "text", text: "调用完成" } :
    { kind: "tool_calls", calls: [{ id: "same-sdk-id", name: "mcp_probe_write", arguments: {} }] }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const service = await t.client.request<{ configVersion: number }>("mcp_configure", { project_id: session.projectId,
      name: "probe", endpoint: mcp.url, tool_allowlist: [{ name: "write", effect: "write" }] });
    const access = new AccessScope(rt.store.db), foreign = rt.store.createProject("foreign");
    const grant = access.createGrant({ fromProjectId: foreign.id, toProjectId: session.projectId, category: "history" });
    const source = ownerSource(rt, session, mode === "full_access" ? "full_access" : "confirm");
    const script = 'return await agent("write",{request:"调用获准 MCP 工具",tools:["mcp_probe_write"]});';
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "mcp", script, input: null });
    if (mode !== "full_access") {
      await waitFor("步骤审批登记", () => rt.store.listConfirmationsByStatus("pending").length === 1);
      const confirmation = rt.store.listConfirmationsByStatus("pending")[0];
      assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
      if (mode === "confirm") await t.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
      else {
        if (mode === "revoke") access.revokeGrant(grant.id);
        else await t.client.request("mcp_configure", { project_id: session.projectId, name: "probe", endpoint: mcp.url,
          tool_allowlist: [{ name: "write", effect: "write" }], expected_version: service.configVersion });
        await waitFor("来源失效与旧审批停止", () => requireWorkflowRun(rt.store, run.id).status === "paused" && rt.store.getConfirmation(confirmation.id)!.status === "stale");
        assert.equal(rt.store.getConfirmation(confirmation.id)!.consumedAt, null);
      }
    }
    const result = await finished(rt, run);
    assert.equal(result.attempts, 1);
    const confirmations = listWorkflowExecutions(rt.store, run.id).flatMap(execution => rt.store.listConfirmationsByTask(execution.taskId));
    if (mode === "configuration" || mode === "revoke") {
      assert.equal(result.status, "paused");
      assert.equal(result.reason, "source_invalid");
      assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
    } else {
      assert.equal(result.status, "succeeded");
      assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
      assert.equal(confirmations.length, mode === "confirm" ? 1 : 0);
      if (mode === "confirm") {
        assert.ok(confirmations[0].consumedAt);
        const next = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "next", script, input: null });
        await waitFor("同模型调用 ID 的新审批", () => rt.store.listConfirmationsByStatus("pending").length === 1);
        const own = rt.store.listConfirmationsByStatus("pending")[0];
        assert.notEqual(own.id, confirmations[0].id);
        assert.notEqual(own.taskId, confirmations[0].taskId);
        assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 1);
        await t.client.request("respond_confirmation", { confirmation_id: own.id, decision: "approve" });
        assert.equal((await finished(rt, next)).status, "succeeded");
        assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 2);
      }
    }
  } finally { await t.shutdown(); await mcp.close(); }
});
