import { fixtureSubAgentDefinition, fixtureSubAgentRoleCatalog } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLocalLauncher } from "@ruukoto/agent/execution/launchers.ts";
import { Driver } from "@ruukoto/agent/driver.ts";
import { createHostDataFamily } from "@ruukoto/agent/host-tools.ts";
import { hostCallFor, type HostToolFamily } from "@ruukoto/agent/host-tool-families.ts";
import { parseSubAgentRole } from "@ruukoto/agent/subagent-roles.ts";
import { createSkillFamily } from "@ruukoto/agent/skills.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { createCodingTools } from "@ruukoto/agent/tool-router.ts";
import { executionProfile, sessionToolCategories, subAgentAllows, workflowAllows, type WorkflowExecutionProfile } from "@ruukoto/agent/tool-availability.ts";
import { HistoryIndex } from "@ruukoto/core/history-index.ts";
import { randomId, type SubAgent } from "@ruukoto/core/types.ts";
import { WORKFLOW_INTERFACE_VERSION, bindWorkflowExecution, createWorkflowRun, registerWorkflowStep, saveWorkflowDefinition, workflowDigest, type WorkflowSource } from "@ruukoto/core/workflow.ts";
import { afterTool, inputText, lastToolText, startAssemblyKit, toolNamesOf } from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";

const agent: SubAgent = { definition: fixtureSubAgentDefinition(), id: "agent", parentSessionId: "source", sessionId: "child", workDir: "/work", activeWorkId: null,
  currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: "" };
const profile = (sourceProjectId = "project"): WorkflowExecutionProfile => ({ toolClass: "main", sourceProjectId,
  categories: sessionToolCategories("main") });

test("宿主步骤画像按来源收窄，旧固定画像不获得额外能力", () => {
  const identity = { kind: "subagent", agent, workflow: { runId: "run", stepKey: "one", sourceSessionId: "source" } } as const;
  const step = executionProfile({ identity, workflow: profile(), writeTarget: false, review: false, planMode: true });
  assert.equal(step.toolClass, "main");
  assert.equal(step.restricted, true);
  assert.equal(step.subAgentTools, null);
  assert.equal(step.plan, false);
  assert.ok(step.workflow!.categories.includes("app_data"));
  assert.ok(!step.workflow!.categories.includes("subagent") && !step.workflow!.categories.includes("delegation"));
  assert.equal(workflowAllows(profile(), "subagent_delegate"), false);
  assert.equal(workflowAllows(profile(), "workflow_start"), false);
  assert.equal(workflowAllows(profile(), "browser"), false);
  assert.ok(!step.workflow!.categories.includes("browser"));
  for (const name of ["edit", "write", "bash", "request_file_access"]) assert.equal(workflowAllows(profile(), name), false, name);
  assert.equal(workflowAllows({ ...profile(), verifyTarget: true }, "write"), true);
  assert.equal(workflowAllows({ ...profile(), tools: ["app_data_query"] }, "app_data_insert"), false);
  assert.throws(() => executionProfile({ identity: { kind: "subagent", agent }, workflow: profile(), writeTarget: false,
    review: false, planMode: false }), { code: "workflow_binding_invalid" });
  const ordinary = executionProfile({ identity: { kind: "subagent", agent }, writeTarget: false, review: false, planMode: false });
  assert.equal(subAgentAllows(ordinary.subAgentTools!, "app_data_query"), false);
  assert.equal(subAgentAllows(ordinary.subAgentTools!, "skill"), false);
  assert.equal(subAgentAllows(ordinary.subAgentTools!, "read"), true);
});

async function fixture(responder: Responder, opts: { ordinary?: boolean; tools?: string[]; families?: HostToolFamily[] } = {}) {
  const kit = await startAssemblyKit("workflow-capabilities", { responder, workDirs: 2 });
  const { session: source } = kit.project();
  const parent = kit.task(source, "主会话私有历史不复制给步骤");
  const authority: WorkflowSource = { product: "ruukoto", projectId: source.projectId, sessionId: source.id, taskId: parent.id,
    permissionVersion: parent.permissionVersion, accessMode: "full_access", grantedPaths: [], capabilities: profile().categories,
    references: [], replyTarget: null, scheduledRunId: null, authority: { toolClass: "main", categories: profile().categories,
      grantIds: [], configuration: "test", workspace: { path: source.cwdReal, dev: source.cwdDev, ino: source.cwdIno } } };
  const stat = fs.statSync(kit.work[1]);
  const child = kit.store.createSession({ projectId: source.projectId, cwd: kit.work[1], cwdReal: fs.realpathSync(kit.work[1]),
    cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: randomId("pi"), confirmTools: [] });
  const subAgentId = randomId("sagent"), workId = randomId("work");
  kit.store.insertSubAgent({ ...agent, id: subAgentId, parentSessionId: source.id, sessionId: child.id, workDir: child.cwdReal, activeWorkId: workId });
  kit.store.insertWorkDelegation({ id: workId, parentSessionId: source.id, originTaskId: parent.id, subAgentId, requestKey: "step",
    paramsDigest: "step", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: "" });
  const task = kit.store.insertQueuedTask({ sessionId: child.id, requestId: "step", input: "完成此步骤", submissionDigest: "step",
    accessMode: "full_access", modelSelection: parent.modelSelection, workId, subAgentId, parentTaskId: parent.id, sourcePermissionVersion: parent.permissionVersion }).task;
  if (!opts.ordinary) {
    const definition = saveWorkflowDefinition(kit.store, 'return await agent("one",{request:"完成此步骤"});');
    const run = createWorkflowRun(kit.store, { interfaceVersion: WORKFLOW_INTERFACE_VERSION, roleCatalog: fixtureSubAgentRoleCatalog(), id: randomId("wfrun"), requestKey: "run", paramsDigest: "run", definitionId: definition.id,
      scriptDigest: definition.digest, input: null, inputDigest: workflowDigest(null), source: authority, modelSelection: parent.modelSelection!,
      status: "running", version: 1, reason: null, attempts: 1, maxAttempts: 100, durationMs: 3600000, usedMs: 0,
      clockStartedAt: Date.now(), clockVerified: true, scriptUnits: [], scriptStopVerified: null, result: null, resultRecorded: false,
      createdAt: "", endedAt: null });
    registerWorkflowStep(kit.store, { runId: run.id, key: "one", ordinal: 1, kind: "agent", params: { request: "完成此步骤" }, dependsOn: [] });
    bindWorkflowExecution(kit.store, { id: randomId("wfexec"), runId: run.id, stepKey: "one", kind: "agent", taskId: task.id,
      number: 1, status: "running", units: [], stopVerified: null });
  }
  kit.store.transitionTask(parent.id, ["queued"], "running");
  kit.store.endTask(parent.id, ["running"], "completed");
  const historyIndex = new HistoryIndex(kit.store.db);
  const hostData = createHostDataFamily({ ...kit.deps, historyIndex, sessionFileFor: id => kit.store.getSession(id)?.sessionFile ?? null,
    projectOfSession: id => kit.store.getSession(id)?.projectId ?? null, syncSession: () => ({ unindexed: false }) });
  let authorized = true;
  const forbiddenSessions = new Set<string>();
  const readableArtifacts = new Set<string>();
  const driver = new Driver(child, { ...kit.deps, ledger: new ToolOpLedger(kit.store), historyIndex, sessionsDir: path.join(kit.dirs.dataDir, "sessions"),
    model: kit.model, thinkingLevel: "off", toolFactory: ({ router }) => createCodingTools(router),
    launcherFor: () => createLocalLauncher(), protectedRoots: [kit.dirs.dataDir], onOccupancyReleased: () => {},
    hostToolFamilies: [hostData, createSkillFamily(), ...(opts.families ?? [])],
    workflow: {
      resolve: () => opts.ordinary ? null : { ...profile(source.projectId), tools: opts.tools },
      verify: () => authorized ? null : "资料或来源配置已撤销",
      artifactAccess: (current, artifact) => artifact.taskId === current.id || readableArtifacts.has(artifact.id),
      historyAccess: (_current, sessionId) => !forbiddenSessions.has(sessionId),
    },
  });
  const execution = await driver.preflightSubAgent(authority, agent.definition!, { tools: opts.tools, workflow: !opts.ordinary });
  kit.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?").run(JSON.stringify({ paths: [], sourceRefs: [], execution }), task.id);
  const run = async () => {
    kit.store.transitionTask(task.id, ["queued"], "running");
    await driver.run(kit.store.getTask(task.id)!);
    return kit.store.getTask(task.id)!;
  };
  return { ...kit, source, child, task, driver, run, forbiddenSessions, readableArtifacts, revoke: () => { authorized = false; },
    execution, authority, async close() { await driver.dispose(); await kit.close(); } };
}

test("真实 Driver 装配来源业务与技能，步骤自身的技能结果落盘且来源任务结束不影响执行", async () => {
  const k = await fixture(req => afterTool(req) ? { kind: "text", text: lastToolText(req) } :
    { kind: "tool_calls", calls: [{ id: "skill", name: "skill", arguments: { name: "step-skill" } }] });
  try {
    const directory = path.join(k.dirs.agentDir, "skills", "step-skill");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: step-skill\ndescription: 步骤验收说明\n---\n只返回此技能的验收说明。\n");
    const ended = await k.run();
    assert.equal(ended.status, "completed", ended.errorMessage ?? ended.interruptReason ?? "");
    const names = toolNamesOf(k.server.calls[0]);
    for (const name of ["history_search", "memory_save", "skill", "read", "read_artifact"]) assert.ok(names.includes(name), name);
    for (const name of ["edit", "write", "bash"]) assert.ok(names.includes(name), name);
    for (const name of ["subagent_delegate", "workflow_start", "subagent_message", "http_request", "request_file_access", "todo_write"]) assert.ok(!names.includes(name), name);
    assert.ok(!inputText(k.server.calls[0]).includes("主会话私有历史不复制给步骤"));
    const file = k.store.getSession(k.child.id)!.sessionFile!;
    assert.ok(fs.readFileSync(file, "utf8").includes("只返回此技能的验收说明。"));
    assert.equal(k.store.listToolOpsByTask(k.task.id).length, 1);
  } finally { await k.close(); }
});

test("步骤与普通 SubAgent 以独立身份通过同一来源的个人业务宿主重核", async () => {
  let effects = 0;
  const family: HostToolFamily = { category: "app_data", names: ["app_data_fixture"], build: runtime => [defineTool({
    name: "app_data_fixture", label: "app_data_fixture", description: "验证个人能力的执行归属", parameters: Type.Object({}),
    execute: async sdkCallId => {
      const call = hostCallFor(runtime.call.bindCall, runtime.call.taskContext, sdkCallId);
      try {
        assert.ok(call.context);
        const problem = runtime.identity.verifyMain(call.context);
        if (problem) throw new Error(problem);
        effects++;
        return { content: [{ type: "text" as const, text: "个人事务已执行" }], details: undefined };
      } finally { call.release(); }
    },
  })] };
  const k = await fixture(req => afterTool(req) ? { kind: "text", text: lastToolText(req) } :
    { kind: "tool_calls", calls: [{ id: "personal", name: "app_data_fixture", arguments: {} }] }, { families: [family] });
  try {
    assert.equal((await k.run()).status, "completed");
    assert.equal(effects, 1);
    assert.equal(k.store.getSessionIdentity(k.child.id)!.kind, "subagent");
    assert.match(inputText(k.server.calls[1]), /个人事务已执行/);
  } finally { await k.close(); }
  const ordinary = await fixture(req => afterTool(req) ? { kind: "text", text: lastToolText(req) } :
    { kind: "tool_calls", calls: [{ id: "ordinary", name: "app_data_fixture", arguments: {} }] }, { ordinary: true, families: [family] });
  try {
    assert.equal((await ordinary.run()).status, "completed");
    assert.ok(toolNamesOf(ordinary.server.calls[0]).includes("app_data_fixture"));
    assert.equal(effects, 2);
  } finally { await ordinary.close(); }
});

test("派生记忆的来源产物仍受步骤范围限制，直接工具和记忆入口都拒绝 prompt 快照", async () => {
  let artifactId = "";
  const k = await fixture(req => afterTool(req) ? { kind: "text", text: lastToolText(req) } :
    { kind: "tool_calls", calls: [{ id: "read", name: "read_artifact", arguments: { artifact_id: artifactId } },
      { id: "memories", name: "memory_list", arguments: {} }] });
  try {
    const artifact = k.deps.artifacts.begin({ taskId: k.task.id, sessionId: k.child.id, name: "prompt-snapshot:test" });
    k.deps.artifacts.append(artifact.id, Buffer.from("不可透传的请求快照"));
    k.deps.artifacts.complete(artifact.id);
    artifactId = artifact.id;
    k.deps.memories.create({ projectId: k.source.projectId, category: "decision", content: "不可暴露的派生记忆",
      sourceRefs: [{ kind: "artifact", artifactId }], author: "agent" });
    const ended = await k.run();
    assert.equal(ended.status, "completed");
    const text = inputText(k.server.calls[1]);
    assert.match(text, /产物不属于可读取范围/);
    assert.ok(!text.includes("不可透传的请求快照"));
    assert.ok(!text.includes("不可暴露的派生记忆"));
  } finally { await k.close(); }
});

test("发送后资料撤销在工具意图前阻断，后续模型请求也不会发送", async () => {
  let revoke = () => {};
  const k = await fixture(() => {
    revoke();
    return { kind: "tool_calls", calls: [{ id: "save", name: "memory_save", arguments: { category: "decision", content: "不应写入", source_refs: [] } }] };
  });
  revoke = k.revoke;
  try {
    const ended = await k.run();
    assert.equal(ended.status, "interrupted");
    assert.match(ended.interruptReason!, /workflow_source_invalid/);
    assert.equal(k.server.calls.length, 1);
    assert.equal(k.store.listToolOpsByTask(k.task.id).length, 0);
    assert.equal(k.deps.memories.listByProject(k.source.projectId).length, 0);
  } finally { await k.close(); }
});

test("登记意图后、真实宿主 execute 取得绑定前再次撤销，个人能力没有产生效果", async () => {
  let revoke = () => {}, effects = 0;
  const family: HostToolFamily = { category: "app_data", names: ["app_data_fixture"], build: runtime => [defineTool({
    name: "app_data_fixture", label: "app_data_fixture", description: "验证真实调用入口", parameters: Type.Object({}),
    execute: async sdkCallId => {
      revoke();
      const call = hostCallFor(runtime.call.bindCall, runtime.call.taskContext, sdkCallId);
      try {
        assert.ok(call.context);
        const problem = runtime.identity.verifyMain(call.context);
        if (problem) throw new Error(problem);
        effects++;
        return { content: [{ type: "text" as const, text: "已写入" }], details: undefined };
      } finally { call.release(); }
    },
  })] };
  const k = await fixture(() => ({ kind: "tool_calls", calls: [{ id: "personal", name: "app_data_fixture", arguments: {} }] }), { families: [family] });
  revoke = k.revoke;
  try {
    const ended = await k.run();
    assert.equal(ended.status, "interrupted");
    assert.equal(effects, 0);
    assert.equal(k.server.calls.length, 1);
    assert.equal(k.store.listToolOpsByTask(k.task.id).length, 1);
  } finally { await k.close(); }
});

test("步骤宿主资料工具拒绝宿主排除的会话历史，显式收窄不扩大来源工具", async () => {
  let sessionId = "";
  const k = await fixture(req => afterTool(req) ? { kind: "text", text: lastToolText(req) } :
    { kind: "tool_calls", calls: [{ id: "history", name: "history_read", arguments: { session_id: sessionId, entry_id: "private" } }] },
  { tools: ["history_read"] });
  try {
    sessionId = k.source.id;
    k.forbiddenSessions.add(sessionId);
    const ended = await k.run();
    assert.equal(ended.status, "completed");
    assert.deepEqual(toolNamesOf(k.server.calls[0]), ["history_read"]);
    assert.match(inputText(k.server.calls[1]), /不在本步骤的资料范围/);
  } finally { await k.close(); }
});

for (const ordinary of [true, false]) test(`真实 Driver 的${ordinary ? "普通委派" : "工作流步骤"}默认执行 bash，预检不改变执行状态`, async () => {
  const k = await fixture(req => afterTool(req) ? { kind: "text", text: lastToolText(req) } :
    { kind: "tool_calls", calls: [{ id: "shell", name: "bash", arguments: { command: "printf SUBAGENT-SHELL-PROOF" } }] }, { ordinary });
  try {
    assert.equal(k.driver.busy, false);
    assert.equal(k.driver.currentTaskId, null);
    assert.equal(k.server.calls.length, 0);
    assert.equal(k.store.listToolOpsByTask(k.task.id).length, 0);
    assert.ok(k.execution.tools.includes("bash"));
    assert.equal((await k.run()).status, "completed");
    assert.match(inputText(k.server.calls[1]), /SUBAGENT-SHELL-PROOF/);
    const operations = k.store.listToolOpsByTask(k.task.id);
    assert.deepEqual(operations.map(operation => operation.toolName), ["bash"]);
    assert.equal(operations[0].taskId, k.task.id);
    assert.ok(!inputText(k.server.calls[0]).includes("主会话私有历史不复制给步骤"));
  } finally { await k.close(); }
});

test("预检缺少显式工具或步骤削减角色要求时拒绝，操作账本为空", async () => {
  const k = await fixture(() => ({ kind: "text", text: "不应调用" }), { ordinary: true });
  try {
    const required = parseSubAgentRole("shell", "---\ndescription: 运行检查\ntools: [bash]\n---\n执行要求。\n");
    const unknown = parseSubAgentRole("unknown", "---\ndescription: 核实能力\ntools: [missing-tool]\n---\n执行要求。\n");
    await assert.rejects(k.driver.preflightSubAgent(k.authority, unknown), { code: "tools_unavailable" });
    await assert.rejects(k.driver.preflightSubAgent(k.authority, required, { tools: ["read"] }), { code: "tools_unavailable" });
    await assert.rejects(k.driver.preflightSubAgent(k.authority, agent.definition!, { tools: ["missing-tool"] }), { code: "tools_unavailable" });
    assert.equal(k.server.calls.length, 0);
    assert.equal(k.store.listToolOpsByTask(k.task.id).length, 0);
  } finally { await k.close(); }
});

for (const ordinary of [true, false]) test(`真实 Driver 的${ordinary ? "普通委派" : "工作流步骤"}注入来源项目指令和技能，正文进入请求快照`, async () => {
  const k = await fixture(() => ({ kind: "text", text: "上下文已核实" }), { ordinary });
  try {
    fs.writeFileSync(path.join(k.source.cwdReal, "TEAM.md"), "SOURCE-PROJECT-INSTRUCTION");
    k.store.updateProjectSettings({ projectId: k.source.projectId, instructionFiles: ["TEAM.md"] });
    const directory = path.join(k.dirs.agentDir, "skills", "source-skill");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: source-skill\ndescription: SOURCE-SKILL-CATALOG\n---\n技能正文。\n");
    k.deps.memories.create({ projectId: k.source.projectId, category: "preference", content: "PERSONAL-MEMORY-NOT-INJECTED", sourceRefs: [{ kind: "owner_note", note: "拥有者提供" }], author: "owner" });
    assert.equal((await k.run()).status, "completed");
    const input = inputText(k.server.calls[0]);
    assert.match(input, /SOURCE-PROJECT-INSTRUCTION/);
    assert.match(input, /SOURCE-SKILL-CATALOG/);
    assert.ok(!input.includes("PERSONAL-MEMORY-NOT-INJECTED"));
    const record = k.store.listSelectionRecordsByTask(k.task.id).at(-1)!;
    assert.ok(record.promptArtifactId);
    assert.match(k.deps.artifacts.read(record.promptArtifactId!).toString("utf8"), /SOURCE-PROJECT-INSTRUCTION/);
    assert.ok(k.store.listArtifactsByTask(k.task.id).some(item => item.name.startsWith("project-instructions")));
  } finally { await k.close(); }
});

test("来源执行快照缺失时真实 Driver 不发送请求、不登记工具操作", async () => {
  const k = await fixture(() => ({ kind: "text", text: "不应发送" }), { ordinary: true });
  try {
    k.store.db.prepare("UPDATE tasks SET read_scope = NULL WHERE id = ?").run(k.task.id);
    await assert.rejects(k.run(), { code: "execution_missing" });
    assert.equal(k.server.calls.length, 0);
    assert.equal(k.store.listToolOpsByTask(k.task.id).length, 0);
  } finally { await k.close(); }
});

test("子代理内部对话只使用持久参考快照，不读取当前项目指令或技能", async () => {
  const k = await fixture(() => ({ kind: "text", text: "继续内部对话" }), { ordinary: true });
  try {
    fs.writeFileSync(path.join(k.source.cwdReal, "TEAM.md"), "CURRENT-INSTRUCTION-MUST-NOT-LOAD");
    k.store.updateProjectSettings({ projectId: k.source.projectId, instructionFiles: ["TEAM.md"] });
    const directory = path.join(k.dirs.agentDir, "skills", "current-skill");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: current-skill\ndescription: CURRENT-SKILL-MUST-NOT-LOAD\n---\n当前正文。\n");
    k.driver["deps"].agentWait = { initialPhase: () => "conversation", snapshot: () => ({ taskId: k.task.id, permissionVersion: k.task.permissionVersion,
      selectionRecordId: null, promptArtifactId: null, instructions: { text: "SAVED-INSTRUCTION-SNAPSHOT", version: "saved", problems: [] },
      skills: { skills: [{ name: "saved-skill", description: "SAVED-SKILL-SNAPSHOT", disableModelInvocation: false, dir: "/unavailable", body: "已保存正文", version: "saved" }], diagnostics: [], version: "saved" } }),
      acquireResources: async () => false, wait: async () => { throw new Error("本用例不等待"); } };
    assert.equal((await k.run()).status, "completed");
    const input = inputText(k.server.calls[0]);
    assert.match(input, /SAVED-INSTRUCTION-SNAPSHOT/);
    assert.match(input, /SAVED-SKILL-SNAPSHOT/);
    assert.ok(!input.includes("CURRENT-INSTRUCTION-MUST-NOT-LOAD") && !input.includes("CURRENT-SKILL-MUST-NOT-LOAD"));
    assert.ok(!toolNamesOf(k.server.calls[0]).includes("bash"));
    assert.equal(k.store.listArtifactsByTask(k.task.id).filter(item => item.name === "project-instructions").length, 0);
  } finally { await k.close(); }
});

test("同一 Driver 的来源工具不变、工作目录切换时重建 SDK 并保留历史", async () => {
  const k = await fixture(() => ({ kind: "text", text: "目录已核实" }), { ordinary: true });
  try {
    const originalDirectory = k.child.cwdReal;
    assert.equal((await k.run()).status, "completed");
    const signature = k.driver["toolSignature"];
    const file = k.store.getSession(k.child.id)!.sessionFile;
    assert.ok(k.server.calls[0].system?.includes(originalDirectory));
    const directory = path.join(k.work[1], "next-directory");
    fs.mkdirSync(directory);
    const real = fs.realpathSync(directory), stat = fs.statSync(real);
    k.store.setSubAgentCwd(k.task.subAgentId!, directory, real, stat.dev, stat.ino);
    k.driver.syncSessionRecord(k.store.getSession(k.child.id)!);
    const task = k.store.insertQueuedTask({ sessionId: k.child.id, requestId: "next-directory", input: "继续在新目录核实", accessMode: "full_access",
      modelSelection: k.task.modelSelection, submissionDigest: "next-directory", workId: k.task.workId, subAgentId: k.task.subAgentId,
      parentTaskId: k.task.parentTaskId, sourcePermissionVersion: k.task.sourcePermissionVersion,
      readScope: { paths: [], sourceRefs: [], execution: k.execution } }).task;
    k.store.transitionTask(task.id, ["queued"], "running");
    await k.driver.run(k.store.getTask(task.id)!);
    assert.equal(k.store.getTask(task.id)!.status, "completed");
    assert.equal(k.driver["toolSignature"], signature);
    assert.ok(k.server.calls[1].system?.includes(real));
    assert.ok(!k.server.calls[1].system?.includes(`Current working directory: ${originalDirectory}\n`));
    assert.equal(k.store.getSession(k.child.id)!.sessionFile, file);
    assert.match(inputText(k.server.calls[1]), /完成此步骤/);
  } finally { await k.close(); }
});
