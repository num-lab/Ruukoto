import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { product as codingProduct } from "../apps/ruukoto-code/src/product.ts";
import { randomId, type Session, type Task } from "@ruukoto/core/types.ts";
import { AccessScope } from "@ruukoto/core/access.ts";
import { requireSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import { listWorkflowExecutions, requireWorkflowRun } from "@ruukoto/core/workflow.ts";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { CredentialStore } from "@ruukoto/agent/execution/credentials.ts";
import { McpStore } from "@ruukoto/agent/mcp/store.ts";
import { planMcpTaskTools } from "@ruukoto/agent/mcp/tools.ts";
import { createSourceResolver } from "@ruukoto/channels/source-resolver.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { afterTool, inputText, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";
import { startMockMcp, withMcpDiscovery } from "./helpers/mock-mcp.ts";

function sourceTask(rt: Runtime, session: Session, accessMode: Task["accessMode"] = "full_access"): Task {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const id = randomId("source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: id, input: "PRIVATE-PARENT-HISTORY",
      modelSelection: rt.defaultSelection, submissionDigest: id, accessMode }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}

function roleFile(agentDir: string, name: string, fields: string): void {
  const directory = path.join(agentDir, "agents");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---\ndescription: 来源能力回归角色\n${fields}---\n完成当前工作并报告结果。\n`);
}

async function childDone(rt: Runtime, taskId: string): Promise<Task> {
  await waitFor("子任务终态", () => ["completed", "failed", "interrupted", "canceled"].includes(rt.store.getTask(taskId)!.status));
  return rt.store.getTask(taskId)!;
}

for (const product of [codingProduct]) test(`${product.runtime.type} 普通与工作流默认角色具有同源工具并在独立目录实际执行 bash`, async () => {
  const t = await startTestRuntime(`source-bash-${product.runtime.type}`, req => {
    if (lastUserText(req) === "RUN-DEFAULT-DELEGATE") {
      if (afterTool(req)) return { kind: "text", text: "默认委派已登记" };
      return { kind: "tool_calls", calls: [{ id: "delegate", name: "subagent_delegate", arguments: { request: "运行 shell", key: "ordinary" } }] };
    }
    if (afterTool(req)) { assert.match(inputText(req), /SOURCE-BASH-OK/); return { kind: "text", text: "实际 shell 已完成" }; }
    assert.ok(toolNamesOf(req).includes("bash"));
    assert.ok(!inputText(req).includes("PRIVATE-PARENT-HISTORY"));
    assert.ok(!inputText(req).includes("RUN-DEFAULT-DELEGATE"));
    return { kind: "tool_calls", calls: [{ id: "shell", name: "bash", arguments: {
      command: "test ! -e source-only.txt && printf SOURCE-BASH-OK > proof.txt && cat proof.txt",
    } }] };
  }, { config: { ...realTools(), product: product.runtime } });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "source", cwd: t.work[0] });
    fs.writeFileSync(path.join(session.cwdReal, "source-only.txt"), "源工作目录不自动复制\n");
    const parent = await rt.submit({ sessionId: session.id, requestId: "ordinary", input: "RUN-DEFAULT-DELEGATE", modelSelection: rt.defaultSelection, accessMode: "full_access" });
    assert.equal((await childDone(rt, parent.id)).status, "completed");
    const work = rt.store.listWorkDelegationsBySession(session.id)[0];
    assert.ok(work, "首次模型调用只传 request/key 必须建立普通委派");
    const ordinary = { task: rt.store.listTasksByWork(work.id)[0] };
    assert.equal((await childDone(rt, ordinary.task.id)).status, "completed");
    const source = sourceTask(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "workflow", input: null,
      script: 'return await agent("shell", { request: "运行 shell" });' });
    rt.store.withTx(() => rt.store.endTask(source.id, ["running"], "completed"));
    await waitFor("工作流终态", () => ["succeeded", "failed", "partial", "paused"].includes(requireWorkflowRun(rt.store, run.id).status));
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "succeeded");
    const stepTask = rt.store.getTask(listWorkflowExecutions(rt.store, run.id).find(execution => execution.kind === "agent")!.taskId)!;
    const ordinaryNames = requireSubAgentExecution(rt.store.getTask(ordinary.task.id)!.readScope?.execution).tools;
    const baseTools = (tools: string[]) => tools.filter(name => name !== "subagent_message").sort();
    assert.deepEqual(baseTools(ordinaryNames), baseTools(requireSubAgentExecution(stepTask.readScope?.execution).tools));
    for (const task of [ordinary.task, stepTask]) {
      const op = rt.store.listToolOpsByTask(task.id).find(operation => operation.toolName === "bash")!;
      assert.equal(op.isError, false);
      assert.match(op.resultSummary!, /SOURCE-BASH-OK/);
      const child = rt.store.getSession(task.sessionId)!;
      assert.notEqual(child.cwdReal, session.cwdReal);
      assert.equal(fs.readFileSync(path.join(child.cwdReal, "proof.txt"), "utf8"), "SOURCE-BASH-OK");
    }
    assert.ok(!fs.existsSync(path.join(session.cwdReal, "proof.txt")));
  } finally { await t.shutdown(); }
});

test("普通来源项目指令、技能与角色正文可从子任务模型快照重建，父聊天和个人记忆不自动复制", async () => {
  const t = await startTestRuntime("ordinary-source-context", req => {
    assert.match(inputText(req), /SOURCE-INSTRUCTIONS/);
    assert.match(inputText(req), /\[技能目录\]/);
    assert.match(req.system!, /SOURCE-ROLE-BODY/);
    assert.ok(!inputText(req).includes("PRIVATE-PARENT-HISTORY"));
    assert.ok(!inputText(req).includes("PERSONAL-MEMORY-SECRET"));
    if (afterTool(req)) { assert.match(inputText(req), /SOURCE-SKILL-BODY/); return { kind: "text", text: "指令技能已读取" }; }
    return { kind: "tool_calls", calls: [{ id: "skill", name: "skill", arguments: { name: "proof" } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "context", cwd: t.work[0] });
    fs.writeFileSync(path.join(session.cwdReal, "TEAM.md"), "SOURCE-INSTRUCTIONS\n");
    rt.setProjectInstructions({ projectId: session.projectId, files: ["TEAM.md"] });
    const folder = path.join(t.dirs.agentDir, "skills", "proof"); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), "---\nname: proof\ndescription: 来源技能证据\n---\nSOURCE-SKILL-BODY\n");
    roleFile(t.dirs.agentDir, "proof", "tools: [skill]\n");
    fs.appendFileSync(path.join(t.dirs.agentDir, "agents", "proof.md"), "SOURCE-ROLE-BODY\n");
    rt.ownerSaveMemory({ projectId: session.projectId, category: "preference", content: "PERSONAL-MEMORY-SECRET",
      sourceRefs: [{ kind: "owner_note", note: "上下文负例" }], reason: "回归" });
    const source = sourceTask(rt, session);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "context", role: "proof", request: "读取技能", paramsDigest: "context" });
    assert.equal((await childDone(rt, child.task.id)).status, "completed");
    const artifacts = new ArtifactStore(t.dirs.dataDir, rt.store);
    const records = rt.store.listSelectionRecordsByTask(child.task.id);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.ok(record.instructionVersion);
      assert.ok(record.skillVersion);
      const artifact = rt.store.getArtifact(record.promptArtifactId!)!;
      const prompt = artifacts.read(artifact.id, 0, artifact.byteCount).toString("utf8");
      assert.match(prompt, /SOURCE-INSTRUCTIONS/);
      assert.match(prompt, /SOURCE-ROLE-BODY/);
    }
    assert.ok(rt.store.listToolOpsByTask(child.task.id).some(operation => operation.toolName === "skill" && operation.isError === false));
  } finally { await t.shutdown(); }
});

test("普通个人来源执行 app_data，应用回执与账本归属真实子 Task", async () => {
  const t = await startTestRuntime("ordinary-source-app-data", req => afterTool(req) ? { kind: "text", text: "个人业务完成" } :
    { kind: "tool_calls", calls: [{ id: "define", name: "app_data_define_table", arguments: {
      table: "child_rows", fields: [{ name: "value", type: "text" }], expected_schema_version: 0, reason: "来源授权个人业务",
    } }] }, { config: realTools() });
  try {
    const rt = t.runtime, main = rt.store.getAgentRole("main")!, source = sourceTask(rt, rt.store.getSession(main.sessionId)!);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "business", request: "建表", paramsDigest: "business" });
    assert.equal((await childDone(rt, child.task.id)).status, "completed");
    const operation = rt.store.listToolOpsByTask(child.task.id).find(op => op.toolName === "app_data_define_table")!;
    assert.equal(operation.isError, false);
    assert.equal(rt.store.getSessionIdentity(child.task.sessionId)!.kind, "subagent");
    const app = new DatabaseSync(path.join(t.dirs.dataDir, "agent-data", "main.db"), { readOnly: true });
    try {
      const receipt = app.prepare("SELECT task_id, session_id, agent_id, op_id FROM app_audit WHERE op_id = ?").get(operation.id);
      assert.deepEqual({ ...receipt }, { task_id: child.task.id, session_id: child.task.sessionId, agent_id: child.agent.id, op_id: operation.id });
    } finally { app.close(); }
    assert.equal(rt.store.listToolOpsByTask(source.id).length, 0);
    for (const name of ["app_data_query", "bash"]) assert.ok(toolNamesOf(t.server.calls[0]).includes(name), name);
  } finally { await t.shutdown(); }
});

test("显式角色缺工具或 MCP 远端缺失在登记前失败，工具意图和模型请求为空", async () => {
  const mcp = await startMockMcp({ tools: [] });
  let mcpClosed = false;
  const t = await startTestRuntime("ordinary-required-tools", () => ({ kind: "text", text: "不应调用模型" }), { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "required", cwd: t.work[0] });
    await t.client.request("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: ["missing"] });
    const source = sourceTask(rt, session);
    for (const name of ["unknown_tool", "schedule_query", "mcp_probe_missing"]) {
      roleFile(t.dirs.agentDir, "required", `tools: [read, ${name}]\n`);
      await assert.rejects(() => rt.subagents!.delegate({ parentTaskId: source.id, key: name, role: "required", request: "必要工具", paramsDigest: name }),
        error => error instanceof Error && error.message.includes(name));
    }
    roleFile(t.dirs.agentDir, "elevated", "permissions:\n  mode: full_access\n");
    const limited = sourceTask(rt, session, "confirm");
    await assert.rejects(() => rt.subagents!.delegate({ parentTaskId: limited.id, key: "elevated", role: "elevated", request: "不能提高权限", paramsDigest: "elevated" }),
      /权限|模式|full_access/);
    await mcp.close(); mcpClosed = true;
    await assert.rejects(() => rt.subagents!.delegate({ parentTaskId: source.id, key: "discovery", role: "required", request: "必需 MCP", paramsDigest: "discovery" }), /MCP|发现|连接/);
    assert.equal(rt.store.listSubAgents().length, 0);
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 0);
    assert.equal(rt.store.listToolOpsByTask(source.id).length, 0);
    assert.equal(t.server.calls.length, 0);
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
  } finally { await t.shutdown(); if (!mcpClosed) await mcp.close(); }
});

test("MCP 未装配原因覆盖远端缺失与非法 schema，停用服务无需发现", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "bad", inputSchema: { type: "object", properties: { pad: { type: "string", description: "x".repeat(20000) } } } }, { name: "good" }] });
  const t = await startTestRuntime("mcp-rejected-reasons", () => ({ kind: "text", text: "未执行" }));
  try {
    const session = await t.runtime.createSession({ projectName: "reasons", cwd: t.work[0] });
    const service = await t.client.request<{ id: string }>("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: ["missing", "bad", "good"] });
    const deps = { mcpStore: new McpStore(t.runtime.store.db), credentials: new CredentialStore(t.dirs.agentDir),
      dispatch: async () => ({ content: [], isError: false }) };
    const plan = await planMcpTaskTools(deps);
    try {
      assert.match(plan.rejected!.get("mcp_probe_missing")!, /未发现.*missing/);
      assert.match(plan.rejected!.get("mcp_probe_bad")!, /inputSchema.*上限/);
      assert.ok(plan.tools.has("mcp_probe_good"));
    } finally { await Promise.all([...plan.connections.values()].map(connection => connection.close())); }
    await t.client.request("mcp_set_enabled", { service_id: service.id, enabled: false });
    const before = mcp.hits.length, disabled = await planMcpTaskTools(deps);
    assert.match(disabled.rejected!.get("mcp_probe_good")!, /停用/);
    assert.equal(mcp.hits.length, before);
  } finally { await t.shutdown(); await mcp.close(); }
});

test("普通子任务模型应答后 MCP 配置变化在工具意图前阻断，无远端副作用", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "write" }] });
  let changeConfiguration: (() => Promise<void>) | null = null;
  const t = await startTestRuntime("ordinary-mcp-change", async () => {
    await changeConfiguration!();
    return { kind: "tool_calls", calls: [{ id: "write", name: "mcp_probe_write", arguments: {} }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "mcp", cwd: t.work[0] });
    const service = await t.client.request<{ id: string }>("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: [{ name: "write", effect: "write" }] });
    changeConfiguration = async () => { await t.client.request("mcp_set_enabled", { service_id: service.id, enabled: false }); };
    roleFile(t.dirs.agentDir, "remote", "tools: [mcp_probe_write]\n");
    const source = sourceTask(rt, session);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "mcp", role: "remote", request: "调用 MCP", paramsDigest: "mcp" });
    assert.notEqual((await childDone(rt, child.task.id)).status, "completed");
    assert.equal(rt.store.listToolOpsByTask(child.task.id).length, 0);
    assert.equal(mcp.hits.filter(hit => hit.rpcMethod === "tools/call").length, 0);
  } finally { await t.shutdown(); await mcp.close(); }
});

test("普通个人通知解析使用保存的 grant IDs，后来新增的资料授权不能扩大范围", async () => {
  const t = await startTestRuntime("ordinary-source-grants", () => ({ kind: "text", text: "业务子任务完成" }), { config: realTools() });
  try {
    const rt = t.runtime, main = rt.store.getAgentRole("main")!, source = sourceTask(rt, rt.store.getSession(main.sessionId)!);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "grants", request: "业务", paramsDigest: "grants" });
    assert.equal((await childDone(rt, child.task.id)).status, "completed");
    const foreign = await rt.createSession({ projectName: "foreign", cwd: t.work[0] }), owner = sourceTask(rt, foreign);
    const access = new AccessScope(rt.store.db), artifacts = new ArtifactStore(t.dirs.dataDir, rt.store);
    const artifact = rt.store.withTx(() => {
      const record = artifacts.begin({ taskId: owner.id, sessionId: foreign.id, name: "foreign-note" });
      artifacts.append(record.id, Buffer.from("FOREIGN-SECRET")); artifacts.complete(record.id);
      return rt.store.getArtifact(record.id)!;
    });
    rt.store.withTx(() => access.createGrant({ fromProjectId: foreign.projectId, toProjectId: main.projectId, category: "artifact" }));
    const resolver = createSourceResolver({ store: rt.store, access, artifacts, appData: () => null });
    assert.throws(() => resolver.resolve(main.projectId, [{ kind: "artifact", artifact_id: artifact.id }], child.task.id), /可读范围/);
    const pinnedGrantIds = requireSubAgentExecution(rt.store.getTask(child.task.id)!.readScope?.execution).source.authority!.grantIds;
    assert.throws(() => resolver.resolve(main.projectId, [{ kind: "artifact", artifact_id: artifact.id }], source.id, pinnedGrantIds), /可读范围/);
    const allowed = resolver.resolve(main.projectId, [{ kind: "artifact", artifact_id: artifact.id }]);
    assert.equal(allowed.text, "FOREIGN-SECRET");
    assert.match(resolver.verify(main.projectId, allowed.refs, source.id, pinnedGrantIds)!, /授权已撤销|不可读/);
    assert.match(resolver.verify(main.projectId, JSON.parse(JSON.stringify([{ ...allowed.refs[0], kind: "unknown" }])))!, /记录损坏/);
  } finally { await t.shutdown(); }
});

test("工作流显式缺少一个工具在 Agent Task 登记前暂停，没有模型调用或工具操作", async () => {
  const t = await startTestRuntime("workflow-required-source-tools", () => ({ kind: "text", text: "不应发送" }), { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow-required", cwd: t.work[0] });
    const source = sourceTask(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: source.id, requestKey: "missing", input: null,
      script: 'return await agent("missing", { request: "必须使用全部工具", tools: ["read", "unknown_tool"] });' });
    await waitFor("缺工具运行暂停", () => requireWorkflowRun(rt.store, run.id).status === "paused");
    assert.match(requireWorkflowRun(rt.store, run.id).reason!, /tool|capabil|unavailable|缺/);
    assert.match(requireWorkflowRun(rt.store, run.id).reason!, /unknown_tool.*本会话不开放/);
    assert.equal(listWorkflowExecutions(rt.store, run.id).filter(execution => execution.kind === "agent").length, 0);
    assert.equal(rt.store.listSubAgents().length, 0);
    assert.equal(rt.store.listWorkDelegationsBySession(session.id).length, 0);
    assert.equal(t.server.calls.length, 0);
    assert.equal(rt.store.db.prepare("SELECT count(*) AS n FROM tool_ops").get()!.n, 0);
  } finally { await t.shutdown(); }
});

test("普通来源资料授权在模型应答后撤销，工具意图和下一次模型请求均被阻断", async () => {
  let revoke: (() => void) | null = null;
  const t = await startTestRuntime("ordinary-source-revoke", () => {
    revoke!();
    return { kind: "tool_calls", calls: [{ id: "blocked", name: "read", arguments: { path: "." } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "source-revoke", cwd: t.work[0] });
    const foreign = rt.store.createProject("foreign"), access = new AccessScope(rt.store.db);
    const grant = rt.store.withTx(() => access.createGrant({ fromProjectId: foreign.id, toProjectId: session.projectId, category: "artifact" }));
    const source = sourceTask(rt, session);
    revoke = () => { rt.store.withTx(() => access.revokeGrant(grant.id)); };
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "revoke", request: "先核实来源", paramsDigest: "revoke" });
    assert.notEqual((await childDone(rt, child.task.id)).status, "completed");
    assert.equal(rt.store.listToolOpsByTask(child.task.id).length, 0);
    assert.equal(t.server.calls.length, 1);
    assert.ok(access.getGrant(grant.id)!.revokedAt);
  } finally { await t.shutdown(); }
});

test("普通执行快照首次发送后损坏，真实工具与后续模型请求停止", async () => {
  let runtime: Runtime | null = null;
  const t = await startTestRuntime("ordinary-execution-corrupt", () => {
    const agent = runtime!.store.listSubAgents()[0], task = runtime!.store.listTasksBySession(agent.sessionId).at(-1)!;
    runtime!.store.db.prepare("UPDATE tasks SET read_scope = json_set(read_scope, '$.execution.tools[0]', 'forged_tool') WHERE id = ?").run(task.id);
    return { kind: "tool_calls", calls: [{ id: "blocked", name: "read", arguments: { path: "." } }] };
  }, { config: realTools() });
  try {
    runtime = t.runtime;
    const session = await runtime.createSession({ projectName: "execution-corrupt", cwd: t.work[0] }), source = sourceTask(runtime, session);
    const child = await runtime.subagents!.delegate({ parentTaskId: source.id, key: "corrupt", request: "核实能力", paramsDigest: "corrupt" });
    assert.notEqual((await childDone(runtime, child.task.id)).status, "completed");
    assert.equal(runtime.store.listToolOpsByTask(child.task.id).length, 0);
    assert.equal(t.server.calls.length, 1);
    assert.throws(() => requireSubAgentExecution(runtime!.store.getTask(child.task.id)!.readScope?.execution), { code: "execution_corrupt" });
  } finally { await t.shutdown(); }
});

test("消息按保存的角色与来源能力收紧，冷恢复不读新文件，缺失或损坏快照不创建消息任务", async () => {
  const t = await startTestRuntime("ordinary-message-snapshot", () => ({ kind: "text", text: "固定能力已核实" }), { config: realTools() });
  let recovered: Runtime | null = null;
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "message-source", cwd: t.work[0] });
    roleFile(t.dirs.agentDir, "stable", "tools: [read]\n");
    const source = sourceTask(rt, session);
    const child = await rt.subagents!.delegate({ parentTaskId: source.id, key: "first", role: "stable", request: "固定来源", paramsDigest: "first" });
    assert.equal((await childDone(rt, child.task.id)).status, "completed");
    const original = requireSubAgentExecution(rt.store.getTask(child.task.id)!.readScope?.execution);
    roleFile(t.dirs.agentDir, "stable", "tools: [bash]\npermissions:\n  mode: full_access\n");
    const limited = sourceTask(rt, session, "confirm");
    const sent = await rt.subagents!.message({ senderTaskId: limited.id, workId: child.work.id, toSubAgentId: child.agent.id,
      key: "limited", text: "按当前较窄模式继续", paramsDigest: "limited" });
    const messageTask = await childDone(rt, sent.message.deliveredTaskId!);
    assert.equal(messageTask.status, "completed");
    assert.equal(messageTask.accessMode, "confirm");
    const messageExecution = requireSubAgentExecution(messageTask.readScope?.execution);
    assert.deepEqual(messageExecution.tools, original.tools);
    assert.deepEqual(messageExecution.source, original.source);
    assert.equal(messageExecution.roleDigest, original.roleDigest);
    rt.store.withTx(() => {
      rt.store.endTask(source.id, ["running"], "completed");
      rt.store.endTask(limited.id, ["running"], "completed");
    });
    fs.unlinkSync(path.join(t.dirs.agentDir, "agents", "stable.md"));
    t.client.close(); await rt.stop("test_restart");
    recovered = await Runtime.start({ ...rt.config, socketPath: path.join(t.dirs.root, "recovered.sock") });
    const sender = sourceTask(recovered, recovered.store.getSession(session.id)!);
    const cold = await recovered.subagents!.message({ senderTaskId: sender.id, workId: child.work.id, toSubAgentId: child.agent.id,
      key: "cold", text: "恢复后仍不能提高", paramsDigest: "cold" });
    const coldTask = await childDone(recovered, cold.message.deliveredTaskId!);
    assert.equal(coldTask.status, "completed");
    assert.equal(coldTask.accessMode, "confirm");
    assert.deepEqual(requireSubAgentExecution(coldTask.readScope?.execution).tools, original.tools);
    const before = recovered.store.listTasksBySession(child.agent.sessionId).length, requests = t.server.calls.length;
    for (const corrupt of [null, { ...messageExecution, tools: ["bash"] }]) {
      recovered.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?").run(JSON.stringify({ ...coldTask.readScope, execution: corrupt }), coldTask.id);
      await assert.rejects(() => recovered!.subagents!.message({ senderTaskId: sender.id, workId: child.work.id, toSubAgentId: child.agent.id,
        key: corrupt ? "corrupt" : "missing", text: "缺失不能猜测", paramsDigest: corrupt ? "corrupt" : "missing" }),
        error => error instanceof Error && "code" in error && ["execution_missing", "execution_corrupt"].includes(String(error.code)));
      assert.equal(recovered.store.listTasksBySession(child.agent.sessionId).length, before);
      assert.equal(t.server.calls.length, requests);
    }
  } finally { await recovered?.stop("test_end"); await t.shutdown(); }
});

for (const tool of ["memory_list", "memory_read"]) test(`普通 ${tool} 的读取记录持久化，记忆撤销后复用不能发送旧正文`, async () => {
  let memoryId = "";
  const t = await startTestRuntime(`source-${tool}`, req => {
    if (afterTool(req)) { assert.match(inputText(req), /REVOKED-PREVIEW-SECRET/); return { kind: "text", text: "已读取" }; }
    return { kind: "tool_calls", calls: [{ id: "memory", name: tool, arguments: tool === "memory_list" ? {} : { memory_id: memoryId } }] };
  }, { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "memory", cwd: t.work[0] });
    const memory = rt.ownerSaveMemory({ projectId: session.projectId, category: "preference", content: "REVOKED-PREVIEW-SECRET", sourceRefs: [{ kind: "owner_note", note: "撤销回归" }], reason: "回归" });
    memoryId = memory.id;
    roleFile(t.dirs.agentDir, "reader", `tools: [${tool}]\n`);
    const source = sourceTask(rt, session);
    const first = await rt.subagents!.delegate({ parentTaskId: source.id, key: "first", role: "reader", request: "读取记忆", paramsDigest: "first" });
    assert.equal((await childDone(rt, first.task.id)).status, "completed");
    assert.deepEqual(rt.store.getTask(first.task.id)!.readScope!.readMemories, [memory.id]);
    rt.ownerRevokeMemory({ memoryId: memory.id, expectedVersion: memory.currentVersion, reason: "撤销读取来源" });
    const requests = t.server.calls.length;
    const second = await rt.subagents!.delegate({ parentTaskId: source.id, subAgentId: first.agent.id, key: "second", request: "复用", paramsDigest: "second" });
    assert.equal((await childDone(rt, second.task.id)).status, "failed");
    assert.equal(t.server.calls.length, requests);
    assert.equal(rt.store.listToolOpsByTask(second.task.id).length, 0);
  } finally { await t.shutdown(); }
});

test("普通 MCP 旧配置的结果不能通过身份复用洗成新来源上下文", async () => {
  const mcp = await startMockMcp({ tools: [{ name: "read", result: { content: [{ type: "text", text: "MCP-OLD-SECRET" }] } }] });
  const t = await startTestRuntime("mcp-history", withMcpDiscovery(req => afterTool(req) ? { kind: "text", text: "已读取" } :
    { kind: "tool_calls", calls: [{ id: "read", name: "mcp_probe_read", arguments: {} }] }), { config: realTools() });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "mcp-history", cwd: t.work[0] });
    const service = await t.client.request<{ id: string }>("mcp_configure", { name: "probe", endpoint: mcp.url, tool_allowlist: ["read"] });
    const source = sourceTask(rt, session);
    const first = await rt.subagents!.delegate({ parentTaskId: source.id, key: "first", request: "读取 MCP", paramsDigest: "first" });
    assert.equal((await childDone(rt, first.task.id)).status, "completed");
    assert.match(inputText(t.server.calls.at(-1)!), /MCP-OLD-SECRET/);
    await t.client.request("mcp_set_enabled", { service_id: service.id, enabled: false });
    const calls = t.server.calls.length;
    const second = await rt.subagents!.delegate({ parentTaskId: source.id, subAgentId: first.agent.id, key: "second", request: "复用历史", paramsDigest: "second" });
    assert.equal((await childDone(rt, second.task.id)).status, "failed");
    assert.equal(t.server.calls.length, calls);
    assert.equal(rt.store.listToolOpsByTask(second.task.id).length, 0);
  } finally { await t.shutdown(); await mcp.close(); }
});

test("完全访问消息不提升已受保护的继承角色，仍以原 confirm 执行", async () => {
  const t = await startTestRuntime("protected-message", () => ({ kind: "text", text: "保护策略保持" }), { config: { ...realTools(), execution: { backend: "native" } } });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "protected", cwd: t.work[0] });
    roleFile(t.dirs.agentDir, "guarded", "tools: [read]\npermissions:\n  protect_source: true\n");
    const parent = sourceTask(rt, session, "confirm");
    const child = await rt.subagents!.delegate({ parentTaskId: parent.id, key: "first", role: "guarded", request: "受保护执行", paramsDigest: "first" });
    assert.equal((await childDone(rt, child.task.id)).status, "completed");
    const sender = sourceTask(rt, session);
    const sent = await rt.subagents!.message({ senderTaskId: sender.id, workId: child.work.id, toSubAgentId: child.agent.id, key: "full-message", text: "继续", paramsDigest: "full-message" });
    const task = await childDone(rt, sent.message.deliveredTaskId!);
    assert.equal(task.status, "completed");
    assert.equal(task.accessMode, "confirm");
    assert.equal(requireSubAgentExecution(task.readScope?.execution).protectSource, true);
  } finally { await t.shutdown(); }
});
