import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { requireSubAgentDefinition } from "@ruukoto/core/subagent-definition.ts";
import { requireSubAgentExecution } from "@ruukoto/core/subagent-execution.ts";
import type { Session, Task } from "@ruukoto/core/types.ts";
import { getWorkflowStep, listWorkflowExecutions, listWorkflowSteps, requireWorkflowRun, WORKFLOW_INTERFACE_VERSION, workflowTerminal } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product as personalProduct } from "../apps/ruukoto/src/product.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { delegateFromActiveTask } from "./helpers/active-subagent-source.ts";
import { holdParentResponse } from "./helpers/active-parent.ts";
import { initGitRepo, runGitStep, shellQuotePathForTest } from "./helpers/git-fixture.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import { afterTool, lastToolText, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor, type TestRuntime } from "./helpers/testkit.ts";

function source(rt: Runtime, session: Session): Task {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "owner", input: "拥有者授权工作流", modelSelection: rt.defaultSelection, submissionDigest: "owner", accessMode: "full_access" }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}

async function start(t: TestRuntime, script: string) {
  const rt = t.runtime;
  fs.writeFileSync(path.join(t.work[0], "value.txt"), "base\n");
  initGitRepo(t.work[0]);
  const session = await rt.createSession({ projectName: "workflow-roles", cwd: t.work[0] }), parent = source(rt, session);
  const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "work", script, input: null });
  rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
  return run;
}

async function finished(rt: Runtime, runId: string) {
  await waitFor("工作流结束或暂停", () => workflowTerminal(requireWorkflowRun(rt.store, runId).status) || requireWorkflowRun(rt.store, runId).status === "paused", 60_000);
  return requireWorkflowRun(rt.store, runId);
}

function agentTask(rt: Runtime, runId: string, key: string): Task {
  const execution = listWorkflowExecutions(rt.store, runId).find(item => item.kind === "agent" && item.stepKey === key)!;
  return rt.store.getTask(execution.taskId)!;
}

const changeAndVerify: Responder = req => {
  const verify = lastUserText(req).includes('"verify":"change"');
  if (afterTool(req)) return { kind: "text", text: verify ? '{"passed":true}' : "修改完成" };
  return { kind: "tool_calls", calls: [{ id: verify ? "verify" : "change", name: verify ? "bash" : "write", arguments: verify ? { command: 'test "$(cat value.txt)" = changed' } : { path: "value.txt", content: "changed\n" } }] };
};

const CHANGE = 'await agent("change",{request:"修改",target:"."});';
const VERIFY = 'await agent("validate",{request:"验证",verify:"change",dependsOn:["change"]});';
const HOLD = 'await ask("hold",{prompt:"继续汇入？"});';
const MERGE = 'return await integrate("merge",{steps:["validate"],dependsOn:["validate","hold"],check:"true"});';

for (const product of [personalProduct, codeProduct]) test(`${product.runtime.type} 的普通与工作流 reviewer 使用同来源、当前内容及固定角色，真实 bash 不能改来源`, async () => {
  let origin = "";
  const parentGate = holdParentResponse(req => {
    if (lastUserText(req).startsWith("开始")) return { kind: "text", text: "父任务完成" };
    if (lastUserText(req).startsWith("[工作流最终回报]")) return { kind: "text", text: "审查完成" };
    assert.match(req.system!, /REVIEWER_PINNED/);
    assert.doesNotMatch(req.system!, /REVIEWER_LATEST/);
    assert.deepEqual(toolNamesOf(req).sort(), ["bash", "read", "read_artifact"]);
    if (afterTool(req)) {
      assert.match(lastToolText(req), /dirty-now\nstaged-now\nnew-now/);
      return { kind: "text", text: "已核实当前内容与来源保护" };
    }
    return { kind: "tool_calls", calls: [{ id: "check", name: "bash", arguments: {
      command: `cat dirty.txt staged.txt new.txt && if printf escaped > ${shellQuotePathForTest(path.join(origin, "dirty.txt"))}; then exit 91; fi; printf proof > review-proof.txt`,
    } }] };
  });
  const t = await startTestRuntime("workflow-reviewer-parity", parentGate.responder, { config: { ...realTools(), product: product.runtime, execution: { backend: "native" } }, workDirs: 1 });
  try {
    const rt = t.runtime;
    origin = t.work[0];
    fs.writeFileSync(path.join(origin, "dirty.txt"), "base-dirty\n");
    fs.writeFileSync(path.join(origin, "staged.txt"), "base-staged\n");
    initGitRepo(origin);
    fs.writeFileSync(path.join(origin, "dirty.txt"), "dirty-now\n");
    fs.writeFileSync(path.join(origin, "staged.txt"), "staged-now\n");
    runGitStep(origin, "git add staged.txt");
    fs.writeFileSync(path.join(origin, "new.txt"), "new-now\n");
    const roleFile = path.join(t.dirs.agentDir, "agents", "reviewer.md");
    fs.mkdirSync(path.dirname(roleFile), { recursive: true });
    fs.writeFileSync(roleFile, "---\ndescription: 审查当前代码\ntools: [read, bash, read_artifact]\npermissions:\n  mode: confirm\n  protect_source: true\n---\nREVIEWER_PINNED\n");
    const session = await rt.createSession({ projectName: "reviewer-parity", cwd: origin });
    const parent = await rt.submit({ sessionId: session.id, requestId: "owner", input: "开始审查", accessMode: "full_access", modelSelection: rt.defaultSelection });
    await waitFor("真实父任务持有来源目录", () => rt.store.getTask(parent.id)!.status === "running" && t.server.calls.length > 0);
    const ordinary = await delegateFromActiveTask(rt, { parentTaskId: parent.id, key: "ordinary", request: "核实当前代码", role: "reviewer", target: ".", paramsDigest: "ordinary" });
    await waitFor("普通审查完成", () => rt.store.getTask(ordinary.task.id)!.status === "completed", 60_000);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "review", script: 'await ask("hold",{prompt:"开始审查？"});return await agent("review",{request:"核实当前代码",role:"reviewer",target:".",dependsOn:["hold"]});', input: null });
    parentGate.release();
    await waitFor("父任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    await waitFor("运行已固定角色目录", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    fs.writeFileSync(roleFile, "---\ndescription: 后来的不同配置\ntools: [write]\npermissions:\n  mode: full_access\n---\nREVIEWER_LATEST\n");
    const question = rt.getWorkflowQuestion(run.id, "hold");
    rt.workflows!.answer(run.id, "hold", question.version, "继续", run.source, { requestKey: "answer", runVersion: question.runVersion });
    assert.equal((await finished(rt, run.id)).status, "succeeded");
    const workflow = agentTask(rt, run.id, "review"), first = rt.store.getTask(ordinary.task.id)!;
    const snapshots = [first, workflow].map(task => requireSubAgentExecution(task.readScope!.execution));
    assert.deepEqual(snapshots[0].source, snapshots[1].source);
    assert.equal(snapshots[0].roleDigest, snapshots[1].roleDigest);
    for (const task of [first, workflow]) {
      const execution = requireSubAgentExecution(task.readScope!.execution);
      assert.equal(task.accessMode, "confirm");
      assert.equal(execution.protectSource, true);
      assert.deepEqual(execution.tools.sort(), ["bash", "read", "read_artifact"]);
      assert.equal(requireSubAgentDefinition(rt.store.getSubAgent(task.subAgentId!)!).body, "REVIEWER_PINNED");
      const work = rt.store.getWorkDelegation(task.workId!)!;
      assert.equal(fs.readFileSync(path.join(work.writeTarget!.path, "review-proof.txt"), "utf8"), "proof");
      assert.ok(rt.store.listToolOpsByTask(task.id).every(op => op.isError === false));
    }
    assert.notEqual(ordinary.work.writeTarget!.path, rt.store.getWorkDelegation(workflow.workId!)!.writeTarget!.path);
    assert.equal(fs.readFileSync(path.join(origin, "dirty.txt"), "utf8"), "dirty-now\n");
    assert.equal(fs.readFileSync(path.join(origin, "staged.txt"), "utf8"), "staged-now\n");
    assert.equal(fs.readFileSync(path.join(origin, "new.txt"), "utf8"), "new-now\n");
    assert.equal(fs.existsSync(path.join(origin, "review-proof.txt")), false);
    assert.equal(t.server.calls.filter(call => call.system?.includes("REVIEWER_PINNED")).length, 4);
  } finally { parentGate.release(); await t.shutdown(); }
});

test("general 与 full_access 角色的 verify 均固定受限编码能力，零工具的通过文本不能汇入", async () => {
  const t = await startTestRuntime("workflow-verification-policy", req => {
    const text = lastUserText(req), verify = text.includes('"verify":"change"');
    if (verify) {
      assert.ok(toolNamesOf(req).length > 0);
      assert.ok(toolNamesOf(req).every(name => ["read", "edit", "write", "bash", "read_artifact"].includes(name)));
      if (text.includes("ZERO_EVIDENCE")) return { kind: "text", text: '{"passed":true}' };
    }
    return changeAndVerify(req, 0);
  }, { config: realTools(), workDirs: 1 });
  try {
    const roleFile = path.join(t.dirs.agentDir, "agents", "permissive.md");
    fs.mkdirSync(path.dirname(roleFile), { recursive: true });
    fs.writeFileSync(roleFile, "---\ndescription: 按来源执行检查\ntools: [bash]\npermissions:\n  mode: full_access\n---\nPERMISSIVE_ROLE\n");
    const rt = t.runtime;
    const run = await start(t, CHANGE + VERIFY + 'await agent("custom",{request:"验证",role:"permissive",verify:"change",dependsOn:["change"]});await agent("empty",{request:"ZERO_EVIDENCE",verify:"change",dependsOn:["change"]});return await integrate("merge",{steps:["empty"],dependsOn:["empty"],check:"true"});');
    assert.equal((await finished(rt, run.id)).status, "partial");
    for (const key of ["validate", "custom", "empty"]) {
      const task = agentTask(rt, run.id, key), execution = requireSubAgentExecution(task.readScope!.execution);
      assert.equal(task.accessMode, "confirm");
      assert.equal(execution.accessMode, "confirm");
      assert.equal(execution.protectSource, true);
      assert.ok(execution.tools.every(name => ["read", "edit", "write", "bash", "read_artifact"].includes(name)));
      assert.equal(getWorkflowStep(rt.store, run.id, key)!.verification!.passed, key !== "empty");
    }
    assert.equal(requireSubAgentDefinition(rt.store.getSubAgent(agentTask(rt, run.id, "validate").subAgentId!)!).name, "general");
    const custom = agentTask(rt, run.id, "custom");
    assert.equal(requireSubAgentDefinition(rt.store.getSubAgent(custom.subAgentId!)!).permissions.mode, "full_access");
    assert.deepEqual(requireSubAgentExecution(custom.readScope!.execution).tools, ["bash"]);
    assert.equal(rt.store.listToolOpsByTask(agentTask(rt, run.id, "empty").id).length, 0);
    assert.equal(getWorkflowStep(rt.store, run.id, "empty")!.status, "failed");
    assert.equal(getWorkflowStep(rt.store, run.id, "merge")!.status, "skipped");
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "base\n");
  } finally { await t.shutdown(); }
});

for (const damage of ["definition_missing", "execution_missing", "snapshot_missing", "interface_upgrade_required"] as const) test(`已完成验证在 ask 后冷恢复遇到 ${damage} 时暂停，旧 Task、尝试和字节不变`, async () => {
  const t = await startTestRuntime("workflow-completed-recovery", changeAndVerify, { config: realTools(), workDirs: 1 });
  let recovered: Runtime | undefined;
  try {
    const rt = t.runtime, run = await start(t, CHANGE + VERIFY + HOLD + MERGE);
    await waitFor("修改和验证已完成并等待拥有者", () => requireWorkflowRun(rt.store, run.id).status === "waiting", 60_000);
    const verified = getWorkflowStep(rt.store, run.id, "validate")!, verificationTask = agentTask(rt, run.id, "validate");
    const changed = agentTask(rt, run.id, "change"), work = rt.store.getWorkDelegation(changed.workId!)!, target = work.writeTarget!;
    assert.equal(verified.verification!.passed, true);
    assert.equal(changed.status, "completed");
    assert.equal(verificationTask.status, "completed");
    if (damage === "definition_missing") rt.store.db.prepare("UPDATE sub_agents SET definition = ? WHERE id = ?").run("null", verificationTask.subAgentId);
    else if (damage === "execution_missing") rt.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?").run(JSON.stringify({ ...verificationTask.readScope, execution: undefined }), verificationTask.id);
    else if (damage === "snapshot_missing") rt.store.db.prepare("UPDATE work_delegations SET write_target = ? WHERE id = ?").run(JSON.stringify({ ...target, snapshot: undefined }), work.id);
    else rt.store.db.prepare("UPDATE workflow_runs SET payload = ? WHERE id = ?").run(JSON.stringify({ ...requireWorkflowRun(rt.store, run.id), interfaceVersion: WORKFLOW_INTERFACE_VERSION - 1 }), run.id);
    const tasks = [changed.id, verificationTask.id].map(id => rt.store.getTask(id));
    const attempts = requireWorkflowRun(rt.store, run.id).attempts, executions = listWorkflowExecutions(rt.store, run.id);
    const sourceBytes = fs.readFileSync(path.join(t.work[0], "value.txt")), changedBytes = fs.readFileSync(path.join(target.path, "value.txt"));
    const verificationTarget = rt.store.getWorkDelegation(verificationTask.workId!)!.writeTarget!;
    const verificationBytes = fs.readFileSync(path.join(verificationTarget.path, "value.txt"));
    const calls = t.server.calls.length;
    t.client.close();
    await rt.stop("test_cold_recovery");
    recovered = await Runtime.start({ ...rt.config, socketPath: path.join(t.dirs.root, "r.sock") });
    const state = requireWorkflowRun(recovered.store, run.id);
    assert.equal(state.status, "paused");
    assert.equal(state.reason, damage);
    await assert.rejects(recovered.workflows!.control(run.id, "resume", state.version, { action: "resume", stopsConfirmed: true, clockConfirmed: true }), { code: damage });
    assert.deepEqual([changed.id, verificationTask.id].map(id => recovered!.store.getTask(id)), tasks);
    assert.deepEqual(listWorkflowExecutions(recovered.store, run.id), executions);
    assert.equal(requireWorkflowRun(recovered.store, run.id).attempts, attempts);
    assert.equal(t.server.calls.length, calls);
    assert.equal(getWorkflowStep(recovered.store, run.id, "merge"), null);
    assert.deepEqual(fs.readFileSync(path.join(t.work[0], "value.txt")), sourceBytes);
    assert.deepEqual(fs.readFileSync(path.join(target.path, "value.txt")), changedBytes);
    assert.deepEqual(fs.readFileSync(path.join(verificationTarget.path, "value.txt")), verificationBytes);
  } finally { await recovered?.stop("test_end"); await t.shutdown(); }
});

test("临时脚本先真实写入再调用旧 mode 时明确拒绝，恢复请求不能重放已完成写入", async () => {
  const t = await startTestRuntime("workflow-late-upgrade", changeAndVerify, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime, run = await start(t, CHANGE + 'return await agent("legacy",{request:"旧调用",mode:"analyze"});');
    const paused = await finished(rt, run.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "interface_upgrade_required");
    const step = getWorkflowStep(rt.store, run.id, "change")!, task = agentTask(rt, run.id, "change");
    const target = rt.store.getWorkDelegation(task.workId!)!.writeTarget!;
    assert.equal(step.status, "completed");
    assert.equal(step.attempts, 1);
    assert.ok(step.frozen);
    assert.equal(getWorkflowStep(rt.store, run.id, "legacy"), null);
    const operations = rt.store.listToolOpsByTask(task.id), calls = t.server.calls.length;
    assert.ok(operations.some(op => op.toolName === "write" && op.isError === false));
    assert.equal(fs.readFileSync(path.join(target.path, "value.txt"), "utf8"), "changed\n");
    await assert.rejects(rt.workflows!.control(run.id, "resume", paused.version, { action: "resume", stopsConfirmed: true, clockConfirmed: true }), { code: "verification_required" });
    assert.equal(requireWorkflowRun(rt.store, run.id).reason, "interface_upgrade_required");
    assert.equal(requireWorkflowRun(rt.store, run.id).attempts, paused.attempts);
    assert.equal(listWorkflowSteps(rt.store, run.id).length, 1);
    assert.deepEqual(rt.store.getTask(task.id), task);
    assert.deepEqual(rt.store.listToolOpsByTask(task.id), operations);
    assert.equal(t.server.calls.length, calls);
    assert.equal(fs.readFileSync(path.join(target.path, "value.txt"), "utf8"), "changed\n");
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "base\n");
  } finally { await t.shutdown(); }
});

test("角色与步骤 tools 不匹配在子任务和模型启动前拒绝", async () => {
  const t = await startTestRuntime("workflow-role-tools-mismatch", () => assert.fail("缺少角色工具时不能请求模型"), { config: realTools(), workDirs: 1 });
  try {
    const roleFile = path.join(t.dirs.agentDir, "agents", "reader.md");
    fs.mkdirSync(path.dirname(roleFile), { recursive: true });
    fs.writeFileSync(roleFile, "---\ndescription: 阅读资料\ntools: [read]\n---\n只阅读资料。\n");
    const rt = t.runtime, run = await start(t, 'return await agent("mismatch",{request:"检查资料",role:"reader",tools:["bash"]});');
    const final = await finished(rt, run.id);
    assert.equal(final.status, "paused");
    assert.match(final.reason!, /^tools_unavailable：/);
    assert.equal(final.attempts, 0);
    assert.equal(listWorkflowExecutions(rt.store, run.id).length, 0);
    assert.equal(rt.store.listSubAgents().length, 0);
    assert.equal(t.server.calls.length, 0);
  } finally { await t.shutdown(); }
});
