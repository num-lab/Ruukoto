import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { Session } from "@ruukoto/core/types.ts";
import { getWorkflowStep, listWorkflowExecutions, listWorkflowSteps, requireWorkflowRun, workflowTerminal } from "@ruukoto/core/workflow.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product as codeProduct } from "../apps/ruukoto-code/src/product.ts";
import { initGitRepo } from "./helpers/git-fixture.ts";
import { afterTool, lastToolText, lastUserText, realTools, startTestRuntime, toolNamesOf, waitFor } from "./helpers/testkit.ts";
import { controlledWorkCopy } from "./helpers/controlled-work-copy.ts";

function source(rt: Runtime, session: Session, requestId = "owner") {
  return rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "test_source");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId, input: "拥有者授权批量任务", modelSelection: rt.defaultSelection,
      submissionDigest: requestId, accessMode: "full_access" }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
}
const SCRIPT = 'await agent("change",{request:"修改",mode:"modify",target:"."}); await agent("validate",{request:"独立验证",mode:"verify",verify:"change",dependsOn:["change"]}); return await integrate("merge",{steps:["validate"],dependsOn:["validate"],check:"test \\"$(cat value.txt)\\" = changed"});';

for (const product of [undefined, codeProduct.runtime]) test(`真实 ${product?.type ?? "ruukoto"} Driver：原任务结束后修改、冻结、独立验证及汇总，验证写入留在独立副本`, async () => {
  const t = await startTestRuntime("workflow-real", req => {
    const verify = lastUserText(req).includes('"mode":"verify"');
    if (afterTool(req)) return { kind: "text", text: verify ? '{"passed":true,"reason":"真实文件正确"}' : "修改完成" };
    assert.ok(toolNamesOf(req).includes("write"));
    assert.ok(!toolNamesOf(req).some(name => name.startsWith("subagent_")));
    return { kind: "tool_calls", calls: [{ id: verify ? "verify" : "modify", name: verify ? "bash" : "write",
      arguments: verify ? { command: "test \"$(cat value.txt)\" = changed && printf proof > verification.txt" } : { path: "value.txt", content: "changed\n" } }] };
  }, { config: { ...realTools(), ...(product ? { product } : {}) }, workDirs: 1 });
  try {
    fs.writeFileSync(path.join(t.work[0], "value.txt"), "base\n");
    initGitRepo(t.work[0]);
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "batch", script: SCRIPT, input: null });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("真实工作流结束", () => workflowTerminal(requireWorkflowRun(rt.store, run.id).status) || requireWorkflowRun(rt.store, run.id).status === "paused", 60_000);
    const final = requireWorkflowRun(rt.store, run.id);
    assert.equal(final.status, "succeeded", JSON.stringify({ reason: final.reason, steps: listWorkflowSteps(rt.store, run.id).map(item => ({ key: item.key, status: item.status })),
      ops: listWorkflowExecutions(rt.store, run.id).flatMap(item => rt.store.listToolOpsByTask(item.taskId).map(op => ({ tool: op.toolName, error: op.isError, result: op.resultSummary }))) }));
    assert.equal(final.attempts, 2);
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "changed\n");
    const changed = getWorkflowStep(rt.store, run.id, "change")!, verified = getWorkflowStep(rt.store, run.id, "validate")!;
    assert.equal(verified.verification!.digest, changed.frozen!.digest);
    const original = rt.store.getWorkDelegation(changed.frozen!.workId)!.writeTarget!;
    const validationTask = rt.store.getTask(verified.verification!.taskId)!;
    const validation = rt.store.getWorkDelegation(validationTask.workId!)!.writeTarget!;
    assert.notEqual(original.path, validation.path);
    assert.equal(fs.existsSync(path.join(original.path, "verification.txt")), false);
    assert.equal(fs.readFileSync(path.join(validation.path, "verification.txt"), "utf8"), "proof");
    assert.equal(fs.existsSync(path.join(t.work[0], "verification.txt")), false);
    assert.ok(listWorkflowExecutions(rt.store, run.id).every(item => item.stopVerified === true));
    assert.equal(rt.store.listAllOccupancy().length, 0);
    assert.equal(t.server.calls.length, 4);
  } finally { await t.shutdown(); }
});

test("非 Git 修改在真实 worker 与模型前拒绝；非 Git 分析仍取得来源业务工具", async () => {
  let document = "";
  const t = await startTestRuntime("workflow-nongit-real", req => {
    assert.ok(toolNamesOf(req).includes("web_search"));
    assert.ok(!toolNamesOf(req).includes("write"));
    if (!afterTool(req)) return { kind: "tool_calls", calls: [{ id: "read", name: "read", arguments: { path: document } }] };
    assert.match(lastToolText(req), /OWNER_SOURCE_DOCUMENT/);
    return { kind: "text", text: "分析完成" };
  }, { config: realTools(), workDirs: 1 });
  try {
    fs.writeFileSync(path.join(t.work[0], "input.txt"), "OWNER_SOURCE_DOCUMENT\n");
    document = fs.realpathSync(path.join(t.work[0], "input.txt"));
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "nongit", script: 'return await Promise.all([agent("write",{request:"修改",mode:"modify",target:"."}),agent("read",{request:"分析"})]);', input: null });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("非 Git 路径结束", () => workflowTerminal(requireWorkflowRun(rt.store, run.id).status) || requireWorkflowRun(rt.store, run.id).status === "paused");
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "partial");
    assert.equal(getWorkflowStep(rt.store, run.id, "write")!.status, "failed");
    assert.equal((getWorkflowStep(rt.store, run.id, "write")!.result as { code: string }).code, "git_required");
    assert.equal(getWorkflowStep(rt.store, run.id, "read")!.status, "completed");
    assert.equal(t.server.calls.length, 2);
    assert.deepEqual(fs.readdirSync(t.work[0]), ["input.txt"]);
    assert.equal(rt.store.listToolOpsByTask(listWorkflowExecutions(rt.store, run.id).find(item => item.kind === "host")!.taskId).length, 0);
  } finally { await t.shutdown(); }
});

test("完全访问来源的验证命令不能写回待审副本，工具失败不能伪称通过", async () => {
  let rt!: Runtime, runId = "";
  const t = await startTestRuntime("workflow-verifier-deny", req => {
    const verify = lastUserText(req).includes('"mode":"verify"');
    if (afterTool(req)) return { kind: "text", text: verify ? '{"passed":true}' : "修改完成" };
    if (verify) {
      const changed = getWorkflowStep(rt.store, runId, "change")!.frozen!;
      const target = rt.store.getWorkDelegation(changed.workId)!.writeTarget!;
      assert.ok(!toolNamesOf(req).includes("request_file_access"));
      return { kind: "tool_calls", calls: [{ id: "attack", name: "bash", arguments: { command: `printf tampered > '${target.path}/value.txt'` } }] };
    }
    return { kind: "tool_calls", calls: [{ id: "modify", name: "write", arguments: { path: "value.txt", content: "changed\n" } }] };
  }, { config: realTools(), workDirs: 1 });
  rt = t.runtime;
  try {
    fs.writeFileSync(path.join(t.work[0], "value.txt"), "base\n"); initGitRepo(t.work[0]);
    const session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "attack", script: SCRIPT, input: null }); runId = run.id;
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("验证拒绝写回", () => workflowTerminal(requireWorkflowRun(rt.store, run.id).status));
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "partial");
    const changed = getWorkflowStep(rt.store, run.id, "change")!.frozen!, verified = getWorkflowStep(rt.store, run.id, "validate")!;
    assert.equal(verified.status, "failed"); assert.equal(verified.verification!.passed, false);
    assert.equal(getWorkflowStep(rt.store, run.id, "merge")!.status, "skipped");
    assert.equal(fs.readFileSync(path.join(rt.store.getWorkDelegation(changed.workId)!.writeTarget!.path, "value.txt"), "utf8"), "changed\n");
    assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "base\n");
    assert.ok(rt.store.listToolOpsByTask(verified.verification!.taskId).some(op => op.toolName === "bash" && op.isError));
  } finally { await t.shutdown(); }
});

for (const phase of ["stale", "check_failure", "ordinary_bypass"] as const) test(`冻结成果 ${phase}：旧结论不能放行新字节或绕过验证，已套用成果保留`, async () => {
  const t = await startTestRuntime("workflow-freeze-control", req => afterTool(req)
    ? { kind: "text", text: lastUserText(req).includes('"mode":"verify"') ? '{"passed":true}' : "修改完成" }
    : { kind: "tool_calls", calls: [{ id: "tool", name: lastUserText(req).includes('"mode":"verify"') ? "read" : "write", arguments:
      lastUserText(req).includes('"mode":"verify"') ? { path: "value.txt" } : { path: "value.txt", content: "changed\n" } }] }, { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime; fs.writeFileSync(path.join(t.work[0], "value.txt"), "base\n"); initGitRepo(t.work[0]);
    const session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const script = 'await agent("change",{request:"修改",mode:"modify",target:"."});' +
      (phase === "ordinary_bypass" ? '' : 'await agent("validate",{request:"独立验证",mode:"verify",verify:"change",dependsOn:["change"]});') +
      'await ask("hold",{prompt:"等待"});' + (phase === "ordinary_bypass" ? 'return 1;' :
      `return await integrate("merge",{steps:["validate"],dependsOn:["validate","hold"],check:${JSON.stringify(phase === "check_failure" ? "false" : "true")}});`);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "control", script, input: null });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("冻结/验证后等待", () => requireWorkflowRun(rt.store, run.id).status === "waiting");
    const frozen = getWorkflowStep(rt.store, run.id, "change")!.frozen!, target = rt.store.getWorkDelegation(frozen.workId)!.writeTarget!;
    if (phase === "ordinary_bypass") {
      await assert.rejects(rt.subagents!.integrate({ workId: frozen.workId, parentTaskId: parent.id, parentSessionId: session.id }), { code: "invalid_state" });
      assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "base\n");
      await rt.workflows!.control(run.id, "cancel", requireWorkflowRun(rt.store, run.id).version, { action: "cancel" });
      return;
    }
    if (phase === "stale") fs.writeFileSync(path.join(target.path, "value.txt"), "new bytes\n");
    const question = rt.store.db.prepare("SELECT payload FROM workflow_questions WHERE run_id = ? AND step_key = 'hold'").get(run.id) as { payload: string };
    rt.workflows!.answer(run.id, "hold", (JSON.parse(question.payload) as { version: number }).version, "继续", run.source);
    await waitFor("汇总收尾", () => workflowTerminal(requireWorkflowRun(rt.store, run.id).status) || requireWorkflowRun(rt.store, run.id).status === "paused", 60_000);
    if (phase === "stale") {
      assert.equal(requireWorkflowRun(rt.store, run.id).reason, "frozen_changed");
      assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "base\n");
    } else {
      assert.equal(getWorkflowStep(rt.store, run.id, "merge")!.status, "failed");
      assert.equal(requireWorkflowRun(rt.store, run.id).status, "partial");
      assert.equal(fs.readFileSync(path.join(t.work[0], "value.txt"), "utf8"), "changed\n");
    }
  } finally { await t.shutdown(); }
});

test("脚本伪造通过值不能生成验证记录或汇入任何字节", async () => {
  const t = await startTestRuntime("workflow-fake-pass", () => ({ kind: "text", text: "unused" }), { config: realTools(), workDirs: 1 });
  try {
    const rt = t.runtime, session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "fake", script: 'await progress("fake",{passed:true}); return await integrate("merge",{steps:["fake"],dependsOn:["fake"],check:"true"});', input: null });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("伪造记录拒绝", () => requireWorkflowRun(rt.store, run.id).status === "paused");
    assert.equal(requireWorkflowRun(rt.store, run.id).reason, "verification_required");
    assert.equal(listWorkflowExecutions(rt.store, run.id).length, 0);
    assert.equal(t.server.calls.length, 0);
    assert.deepEqual(fs.readdirSync(t.work[0]), []);
  } finally { await t.shutdown(); }
});

for (const mode of ["analyze", "modify"] as const) test(`真实 Driver ${mode} 启动中取消，迟到实际身份和停止 false 沿原 Task 保留`, async () => {
  const t = await startTestRuntime("workflow-driver-start-stop", () => ({ kind: "tool_calls", calls: [{ id: "read", name: "read", arguments: { path: "missing" } }] }), { config: realTools(), workDirs: 1 });
  const controlled = controlledWorkCopy(async () => false, "", false, false);
  try {
    const rt = t.runtime;
    if (mode === "modify") { fs.writeFileSync(path.join(t.work[0], "value.txt"), "base\n"); initGitRepo(t.work[0]); }
    rt.launcherFor = () => controlled.launcher;
    const session = await rt.createSession({ projectName: "workflow", cwd: t.work[0] }), parent = source(rt, session);
    const run = rt.workflows!.start({ sourceTaskId: parent.id, requestKey: "cancel", script: `return await agent("step",{request:"读取",mode:${JSON.stringify(mode)}${mode === "modify" ? ',target:"."' : ''}});`, input: null });
    rt.store.withTx(() => rt.store.endTask(parent.id, ["running"], "completed"));
    await waitFor("worker 启动占位", () => controlled.specs.length === 1);
    await rt.workflows!.control(run.id, "cancel", requireWorkflowRun(rt.store, run.id).version, { action: "cancel" });
    await waitFor("执行收尾", () => listWorkflowExecutions(rt.store, run.id).every(item => item.status === "finished"));
    assert.equal(requireWorkflowRun(rt.store, run.id).status, "canceled");
    assert.equal(requireWorkflowRun(rt.store, run.id).attempts, 1);
    const execution = listWorkflowExecutions(rt.store, run.id).find(item => item.stopVerified === false)!;
    assert.ok(execution.units.some(unit => unit.id === "controlled-work-copy"));
    assert.ok(rt.store.listAllOccupancy().some(held => held.taskId === execution.taskId));
    assert.equal(rt.store.getTask(listWorkflowExecutions(rt.store, run.id).find(item => item.kind === "agent")!.taskId)!.status, "canceled");
    assert.equal(controlled.requests.some(request => request.type === "tool_call"), false);
  } finally { controlled.finish(); await t.shutdown(); }
});
