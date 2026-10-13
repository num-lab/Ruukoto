import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Driver } from "@ruukoto/agent/driver.ts";
import { createHostDataFamily } from "@ruukoto/agent/host-tools.ts";
import { hostCallFor, type HostToolFamily } from "@ruukoto/agent/host-tool-families.ts";
import { createSkillFamily } from "@ruukoto/agent/skills.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { createCodingTools } from "@ruukoto/agent/tool-router.ts";
import { executionProfile, sessionToolCategories, subAgentAllows, workflowAllows, type WorkflowExecutionProfile } from "@ruukoto/agent/tool-availability.ts";
import { HistoryIndex } from "@ruukoto/core/history-index.ts";
import { randomId, type SubAgent } from "@ruukoto/core/types.ts";
import { bindWorkflowExecution, createWorkflowRun, registerWorkflowStep, saveWorkflowDefinition, workflowDigest } from "@ruukoto/core/workflow.ts";
import { afterTool, inputText, lastToolText, startAssemblyKit, toolNamesOf } from "./helpers/testkit.ts";
import type { Responder } from "./helpers/mock-provider.ts";

const agent: SubAgent = { id: "agent", parentSessionId: "source", sessionId: "child", workDir: "/work", activeWorkId: null,
  currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: "" };
const profile = (sourceProjectId = "project"): WorkflowExecutionProfile => ({ toolClass: "main", sourceProjectId,
  categories: sessionToolCategories("main") });

test("宿主步骤画像按来源收窄，普通 SubAgent 不得到个人能力或嵌套委派", () => {
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
    const run = createWorkflowRun(kit.store, { id: randomId("wfrun"), requestKey: "run", paramsDigest: "run", definitionId: definition.id,
      scriptDigest: definition.digest, input: null, inputDigest: workflowDigest(null), source: { product: "ruukoto", projectId: source.projectId,
        sessionId: source.id, taskId: parent.id, permissionVersion: parent.permissionVersion, accessMode: "full_access", grantedPaths: [],
        capabilities: profile().categories, references: [], replyTarget: null, scheduledRunId: null }, modelSelection: parent.modelSelection!,
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
    launcherFor: () => { throw new Error("本用例不启动工具工作进程"); }, protectedRoots: [kit.dirs.dataDir], onOccupancyReleased: () => {},
    hostToolFamilies: [hostData, createSkillFamily(), ...(opts.families ?? [])],
    workflow: {
      resolve: () => opts.ordinary ? null : { ...profile(source.projectId), tools: opts.tools },
      verify: () => authorized ? null : "资料或来源配置已撤销",
      artifactAccess: (current, artifact) => artifact.taskId === current.id || readableArtifacts.has(artifact.id),
      historyAccess: (_current, sessionId) => !forbiddenSessions.has(sessionId),
    },
  });
  const run = async () => {
    kit.store.transitionTask(task.id, ["queued"], "running");
    await driver.run(kit.store.getTask(task.id)!);
    return kit.store.getTask(task.id)!;
  };
  return { ...kit, source, child, task, driver, run, forbiddenSessions, readableArtifacts, revoke: () => { authorized = false; },
    async close() { await driver.dispose(); await kit.close(); } };
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
    for (const name of ["edit", "write", "bash", "subagent_delegate", "workflow_start"]) assert.ok(!names.includes(name), name);
    assert.ok(!inputText(k.server.calls[0]).includes("主会话私有历史不复制给步骤"));
    const file = k.store.getSession(k.child.id)!.sessionFile!;
    assert.ok(fs.readFileSync(file, "utf8").includes("只返回此技能的验收说明。"));
    assert.equal(k.store.listToolOpsByTask(k.task.id).length, 1);
  } finally { await k.close(); }
});

test("步骤以独立 SubAgent 身份通过个人业务宿主重核，普通 SubAgent 的同族工具保持关闭", async () => {
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
  const ordinary = await fixture(() => ({ kind: "text", text: "普通只读分析" }), { ordinary: true, families: [family] });
  try {
    assert.equal((await ordinary.run()).status, "completed");
    assert.deepEqual(toolNamesOf(ordinary.server.calls[0]), ["read", "read_artifact"]);
    assert.equal(effects, 1);
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
