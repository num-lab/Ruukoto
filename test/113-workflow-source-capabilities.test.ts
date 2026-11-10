import { skillsDirFor } from "@ruukoto/agent/skills.ts";
import { isolateSkillHome } from "./helpers/skill-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { AccessScope } from "@ruukoto/core/access.ts";
import { registerCodeScheduleRun, saveCodeSchedule } from "@ruukoto/core/code-scheduler.ts";
import { randomId, type Session, type Task } from "@ruukoto/core/types.ts";
import { listWorkflowExecutions, requireWorkflowRun, type WorkflowRun } from "@ruukoto/core/workflow.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import { startMockMcp } from "./helpers/mock-mcp.ts";
import { afterTool, inputText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";
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

async function scheduledSource(rt: Runtime, cwd: string): Promise<Task> {
  const { session } = await rt.openWorkspace({ cwd });
  return rt.store.withTx(() => {
    const id = randomId("source"), at = "2030-01-02T00:00:00.000Z";
    const config = { title: "Workflow source", instructions: "Execute the authorized workflow", workspaceId: session.projectId,
      permission: "full_access" as const, modelSelection: rt.defaultSelection,
      rule: { kind: "once" as const, at, timeZone: "UTC", disambiguation: "compatible" as const } };
    const plan = saveCodeSchedule(rt.store, { requestId: id, config, workspace: rt.store.getProject(session.projectId)!.rootDir!,
      nextDueAt: at, now: "2030-01-01T00:00:00.000Z" }).plan;
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: id, input: config.instructions,
      modelSelection: config.modelSelection, submissionDigest: id, accessMode: config.permission }).task;
    registerCodeScheduleRun(rt.store, { scheduleId: plan.id, expectedVersion: plan.version, sessionId: session.id, rootTaskId: task.id,
      scheduledAt: at, coalescedFrom: at, coalescedThrough: at, nextDueAt: null, now: at });
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}

async function finished(rt: Runtime, run: WorkflowRun): Promise<WorkflowRun> {
  await waitFor("工作流收尾", () => ["succeeded", "partial", "failed", "paused", "canceled"].includes(requireWorkflowRun(rt.store, run.id).status));
  return requireWorkflowRun(rt.store, run.id);
}

test("工作流步骤从持久来源装配技能目录与真实 skill 调用", async tc => {
  isolateSkillHome(tc);
  const t = await startTestRuntime("workflow-skill-binding", req => {
    assert.match(inputText(req), /\[技能目录\]/);
    assert.deepEqual(toolNamesOf(req), ["skill"]);
    if (afterTool(req)) { assert.match(inputText(req), /WORKFLOW-SKILL-BODY/); return { kind: "text", text: "技能已读取" }; }
    return { kind: "tool_calls", calls: [{ id: "skill", name: "skill", arguments: { name: "proof" } }] };
  }, { config: realTools() });
  try {
    const folder = path.join(skillsDirFor(), "proof"); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), "---\nname: proof\ndescription: 工作流技能证据\n---\nWORKFLOW-SKILL-BODY\n");
    const rt = t.runtime, session = await rt.createSession({ projectName: "skill", cwd: t.work[0] }), source = ownerSource(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "skill", input: null, script: 'return await agent("read",{request:"读取来源技能",tools:["skill"]});' });
    assert.equal((await finished(rt, run)).status, "succeeded");
    assert.equal(t.server.calls.length, 2);
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
    rt.workflows!.answer(run.id, "hold", 1, "继续", run.source, { requestKey: "answer-hold", runVersion: rt.getWorkflowQuestion(run.id, "hold").runVersion });
    assert.equal((await finished(rt, run)).status, "paused");
    assert.equal(t.server.calls.length, calls);
  } finally { await t.shutdown(); }
});

test("运行后新增资料授权不扩大步骤范围，真实产物读取使用固定授权", async () => {
  let access!: AccessScope, from = "", to = "", artifactId = "";
  const t = await startTestRuntime("workflow-new-grant", req => {
    if (afterTool(req)) return { kind: "text", text: "范围核实完成" };
    access.createGrant({ fromProjectId: from, toProjectId: to, category: "artifact" });
    return { kind: "tool_calls", calls: [{ id: "direct", name: "read_artifact", arguments: { artifact_id: artifactId } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[1]), sourceSession = rt.store.getSession(source.sessionId)!;
    to = sourceSession.projectId;
    access = new AccessScope(rt.store.db);
    const foreign = await rt.createSession({ projectName: "foreign", cwd: t.work[0] });
    from = foreign.projectId;
    rt.store.setSessionQueueState(foreign.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: foreign.id, requestId: "foreign", input: "拥有者保存的资料",
      modelSelection: rt.defaultSelection, submissionDigest: "foreign" }).task;
    const artifacts = new ArtifactStore(rt.config.profile.dataDir, rt.store), text = "UNAUTHORIZED_FOREIGN_SCOPE_DATA";
    const artifact = artifacts.begin({ taskId: task.id, sessionId: foreign.id, name: "foreign-source" });
    artifacts.append(artifact.id, Buffer.from(text));
    artifacts.complete(artifact.id);
    artifactId = artifact.id;
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "fixed-grants",
      script: 'return await agent("scope",{request:"核实资料范围",tools:["read_artifact"]});', input: null });
    assert.deepEqual(run.source.authority!.grantIds, []);
    assert.equal((await finished(rt, run)).status, "succeeded");
    const textAfter = inputText(t.server.calls[1]);
    assert.match(textAfter, /产物不属于可读取范围/);
    assert.ok(!textAfter.includes(text));
    assert.equal(access.listGrants().length, 1);
  } finally { await t.shutdown(); }
});

test("同一来源的不同运行隔离真实产物与子历史", async () => {
  let old = true, sourceFile = "", artifactId = "", previousSession = "";
  let active: Runtime | null = null;
  const t = await startTestRuntime("workflow-cross-run", req => {
    if (afterTool(req)) return { kind: "text", text: "步骤完成" };
    if (old) {
      const child = active!.store.listSubAgents().find(agent => agent.state === "running")!;
      sourceFile = path.join(active!.store.getSession(child.sessionId)!.cwdReal, "source.txt");
      fs.writeFileSync(sourceFile, "PRIOR_RUN_RESULT_BODY");
      return { kind: "tool_calls", calls: [{ id: "read", name: "read", arguments: { path: sourceFile } }] };
    }
    return { kind: "tool_calls", calls: [{ id: "artifact", name: "read_artifact", arguments: { artifact_id: artifactId } },
      { id: "history", name: "history_read", arguments: { session_id: previousSession, entry_id: "private" } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, source = await scheduledSource(rt, t.work[0]), text = "PRIOR_RUN_RESULT_BODY";
    active = rt;
    const first = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "first",
      script: 'return await agent("read",{request:"读取来源文件",tools:["read"]});', input: null });
    assert.equal((await finished(rt, first)).status, "succeeded");
    const previousTask = listWorkflowExecutions(rt.store, first.id).find(execution => execution.kind === "agent")!.taskId;
    previousSession = rt.store.getTask(previousTask)!.sessionId;
    const artifact = rt.store.listArtifactsByTask(previousTask).find(item => item.name === "read 文件正文")!;
    assert.ok(artifact);
    artifactId = artifact.id;
    assert.match(inputText(t.server.calls[1]), /PRIOR_RUN_RESULT_BODY/);
    old = false;
    const callIndex = t.server.calls.length;
    const second = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "second",
      script: 'return await agent("scope",{request:"核实本次运行资料",tools:["read_artifact","history_read"]});', input: null });
    assert.equal((await finished(rt, second)).status, "succeeded");
    const textAfter = inputText(t.server.calls[callIndex + 1]);
    assert.match(textAfter, /产物不属于可读取范围/);
    assert.match(textAfter, /该会话不在本步骤的资料范围/);
    assert.ok(!textAfter.includes(text));
  } finally { await t.shutdown(); }
});

for (const mode of ["full_access", "confirm", "configuration", "revoke"] as const) test(`真实工作流 MCP：${mode} 的调用、批准与来源失效`, async () => {
  const mcp = await startMockMcp({ tools: [{ name: "write", result: { content: [{ type: "text", text: "written-once" }] } }] });
  const t = await startTestRuntime(`workflow-mcp-${mode}`, req => {
    assert.deepEqual(toolNamesOf(req), ["mcp__probe__write"]);
    assert.doesNotMatch(req.system!, /<mcp_servers>/, "具名工具已直接声明，不引导调用未开放的搜索工具");
    return afterTool(req) ? { kind: "text", text: "调用完成" } :
      { kind: "tool_calls", calls: [{ id: "same-sdk-id", name: "mcp__probe__write", arguments: {} }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] });
    const service = await t.client.request<{ configVersion: number }>("mcp_configure", {
      name: "probe", endpoint: mcp.url, tool_allowlist: [{ name: "write", effect: "write" }] });
    const access = new AccessScope(rt.store.db), foreign = rt.store.createProject("foreign");
    const grant = access.createGrant({ fromProjectId: foreign.id, toProjectId: session.projectId, category: "history" });
    const source = ownerSource(rt, session, mode === "full_access" ? "full_access" : "confirm");
    const script = 'return await agent("write",{request:"调用获准 MCP 工具",tools:["mcp__probe__write"]});';
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "mcp", script, input: null });
    if (mode !== "full_access") {
      await waitFor("步骤审批登记", () => rt.store.listConfirmationsByStatus("pending").length === 1);
      const confirmation = rt.store.listConfirmationsByStatus("pending")[0];
      assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
      if (mode === "confirm") await t.client.request("respond_confirmation", { confirmation_id: confirmation.id, decision: "approve" });
      else {
        if (mode === "revoke") access.revokeGrant(grant.id);
        else await t.client.request("mcp_configure", { name: "probe", endpoint: mcp.url,
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
