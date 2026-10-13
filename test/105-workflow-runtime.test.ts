import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { randomId, type Task } from "@ruukoto/core/types.ts";
import {
  bindWorkflowExecution, chargeWorkflow, controlWorkflow, getWorkflowDefinition, getWorkflowQuestion, getWorkflowStep,
  listWorkflowExecutions, listWorkflowSteps, registerWorkflowStep, requireWorkflowRun,
  saveWorkflowDefinition, setWorkflowState, updateWorkflowRun, workflowSlotsUsed,
  type WorkflowRun, type WorkflowSource,
} from "@ruukoto/core/workflow.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { compileWorkflowOutput } from "@ruukoto/agent/workflow-output.ts";
import { HOST_DATA_LEDGER } from "@ruukoto/agent/host-tools.ts";
import { WorkflowScriptHost } from "@ruukoto/agent/script-worker/host.ts";
import { ScriptExecutionError } from "@ruukoto/agent/script-worker/protocol.ts";
import { WorkflowCoordinator, type WorkflowAgentExecutor, type WorkflowDeps } from "@ruukoto/runtime/workflows.ts";

const selection = { provider: "fake", modelId: "fixed", thinkingLevel: "off" } as const;
test("结果 schema 支持对象、数组和标量，拒绝正则、引用及过深输入", () => {
  assert.equal(compileWorkflowOutput({ type: "array", items: { type: "number" } })([1, 2]), true);
  assert.equal(compileWorkflowOutput({ type: "string" })(1), false);
  assert.throws(() => compileWorkflowOutput({ type: "string", pattern: "(a+)+$" }), { code: "invalid_output_schema" });
  assert.throws(() => compileWorkflowOutput({ $ref: "https://example.test/schema" }), { code: "invalid_output_schema" });
  assert.throws(() => compileWorkflowOutput({ type: "string", minLength: "invalid" }), { code: "invalid_output_schema" });
  let schema: unknown = { type: "string" };
  for (let index = 0; index < 18; index++) schema = { type: "array", items: schema };
  assert.throws(() => compileWorkflowOutput(schema), { code: "invalid_output_schema" });
});
test("恶意结果正则在宿主校验前拒绝，实际子进程可及时返回", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval", `
    import {compileWorkflowOutput} from "@ruukoto/agent/workflow-output.ts";
    try {
      const check=compileWorkflowOutput({type:"object",properties:{text:{type:"string",pattern:"(a+)+$"}},required:["text"]});
      check({text:"a".repeat(32)+"!"}); process.exitCode=1;
    } catch(error) { if(error.code!=="invalid_output_schema") throw error; process.stdout.write(error.code); }
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 2000, killSignal: "SIGKILL" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "invalid_output_schema");
});
async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, agent: WorkflowAgentExecutor = async () => ({ output: "done" })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-runtime-"));
  const db = new Db(root);
  const store = new Store(db);
  const cwd = path.join(root, "source");
  fs.mkdirSync(cwd);
  const stat = fs.statSync(cwd);
  const { session, task } = store.withTx(() => {
    const project = store.createProject("workflow");
    const session = store.createSession({ projectId: project.id, cwd, cwdReal: cwd, cwdDev: stat.dev, cwdIno: stat.ino,
      piSessionId: randomId("pi"), confirmTools: [], modelSelection: selection });
    const task = store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "source", accessMode: "full_access",
      modelSelection: selection, submissionDigest: "source" }).task;
    store.transitionTask(task.id, ["queued"], "running");
    return { session, task };
  });
  const source: WorkflowSource = { product: "ruukoto-code", projectId: session.projectId, sessionId: session.id, taskId: task.id,
    permissionVersion: 1, accessMode: "full_access", grantedPaths: [], capabilities: ["read"], references: [], replyTarget: null, scheduledRunId: null };
  let now = 1_000;
  const deps: WorkflowDeps = { store, workRoot: path.join(root, "steps"), source: () => source, selection: () => selection,
    verifySource: () => true, agent, now: () => now };
  let coordinator = new WorkflowCoordinator(deps);
  store.onCommitted = events => coordinator.onEvents(events);
  const cleanups: (() => void)[] = [];
  t.after(async () => { for (const cleanup of cleanups) cleanup(); await coordinator.stop("test_end"); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, store, session, task, source, deps,
    get coordinator() { return coordinator; }, setNow(value: number) { now = value; }, cleanup(action: () => void) { cleanups.push(action); },
    start(script: string, input: unknown = null, extra: { maxAttempts?: number; durationMs?: number } = {}) {
      return coordinator.start({ sourceTaskId: task.id, requestKey: randomId("request"), script, input, ...extra });
    },
    async restart() { await coordinator.stop("test_restart"); coordinator = new WorkflowCoordinator(deps); coordinator.recover(); },
    run(id: string) { return requireWorkflowRun(store, id); },
    async terminal(id: string) { await until("运行结束", () => ["succeeded", "partial", "failed", "canceled"].includes(requireWorkflowRun(store, id).status)); },
  };
}
function ordinaryTask(f: ReturnType<typeof fixture>, status: "queued" | "running" = "running"): Task {
  const cwd = path.join(f.root, randomId("ordinary"));
  fs.mkdirSync(cwd);
  const stat = fs.statSync(cwd);
  return f.store.withTx(() => {
    const session = f.store.createSession({ projectId: f.session.projectId, cwd, cwdReal: cwd, cwdDev: stat.dev, cwdIno: stat.ino,
      piSessionId: randomId("pi"), confirmTools: [] });
    const id = randomId("sagent"), workId = randomId("work");
    f.store.insertSubAgent({ id, parentSessionId: f.session.id, sessionId: session.id, workDir: cwd, activeWorkId: workId,
      currentTaskId: null, state: "running", closedAt: null, closedBy: null, createdAt: new Date().toISOString() });
    f.store.insertWorkDelegation({ id: workId, parentSessionId: f.session.id, originTaskId: f.task.id, subAgentId: id,
      requestKey: randomId("workrequest"), paramsDigest: "ordinary", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: new Date().toISOString() });
    const task = f.store.insertQueuedTask({ sessionId: session.id, requestId: randomId("ordinary"), input: "ordinary", modelSelection: selection,
      submissionDigest: "ordinary", workId, subAgentId: id, parentTaskId: f.task.id }).task;
    if (status === "running") f.store.transitionTask(task.id, ["queued"], "running");
    return task;
  });
}

test("运行固定定义、输入、模型与来源；发起任务结束后仍执行，创建键先去重", async t => {
  const seen: unknown[] = [];
  const f = fixture(t, async context => { seen.push(context.step.params, context.run.modelSelection, context.task.parentTaskId); return { output: "fixed" }; });
  const input = { request: "original" };
  const script = `return await agent("one", {request:input.request});`;
  const run = f.coordinator.start({ sourceTaskId: f.task.id, requestKey: "same", script, input });
  input.request = "changed";
  assert.equal(f.coordinator.start({ sourceTaskId: f.task.id, requestKey: "same", script, input: { request: "original" } }).id, run.id);
  assert.throws(() => f.coordinator.start({ sourceTaskId: f.task.id, requestKey: "same", script, input }), { code: "request_conflict" });
  f.store.withTx(() => f.store.endTask(f.task.id, ["running"], "completed"));
  const newer = f.store.withTx(() => saveWorkflowDefinition(f.store, `return "new";`));
  assert.notEqual(newer.id, run.definitionId);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "succeeded");
  assert.deepEqual(seen, [{ request: "original" }, selection, f.task.id]);
  const persisted = f.store.db.prepare("SELECT payload FROM workflow_runs WHERE id = ?").get(run.id) as { payload: string };
  assert.deepEqual(JSON.parse(persisted.payload).input, { request: "original" });
  assert.equal(getWorkflowDefinition(f.store, run.definitionId)!.script, script);
  const events = f.store.getEventsAfter(0).filter(event => event.body.type === "workflow.changed");
  assert.ok(events.some(event => event.body.type === "workflow.changed" && event.body.runId === run.id && event.body.status === "succeeded"));
});

test("四个工作流分支与普通委派共享三个名额，满额只排队", async t => {
  const releases = new Map<string, ReturnType<typeof deferred<{ output: string }>>>();
  let active = 0, maximum = 0;
  const f = fixture(t, async ({ step }) => {
    active++; maximum = Math.max(maximum, active);
    const gate = deferred<{ output: string }>(); releases.set(step.key, gate);
    const value = await gate.promise; active--; return value;
  });
  f.cleanup(() => { for (const gate of releases.values()) gate.resolve({ output: "cleanup" }); });
  const ordinary = ordinaryTask(f);
  const run = f.start(`return await Promise.all([0,1,2,3].map(i=>agent("p"+i,{request:"work"})));`);
  await until("两个工作流分支运行", () => releases.size === 2);
  assert.equal(workflowSlotsUsed(f.store, f.session.id), 3);
  assert.equal(listWorkflowSteps(f.store, run.id).length, 4);
  f.store.withTx(() => f.store.endTask(ordinary.id, ["running"], "completed"));
  await until("普通委派释放名额", () => releases.size === 3);
  assert.equal(workflowSlotsUsed(f.store, f.session.id), 3);
  releases.get("p0")!.resolve({ output: "p0" });
  await until("第四个分支从队列启动", () => releases.size === 4);
  for (const [key, gate] of releases) gate.resolve({ output: key });
  await f.terminal(run.id);
  assert.equal(maximum, 3);
  assert.equal(f.run(run.id).attempts, 4);
  assert.equal(workflowSlotsUsed(f.store, f.session.id), 0);
});

test("只读失败最多重试两次；无关分支完成，失败依赖不执行", async t => {
  const calls: string[] = [];
  const f = fixture(t, async ({ step, task }) => {
    calls.push(step.key);
    if (step.key === "bad") {
      f.store.withTx(() => f.store.recordToolIntent({ id: randomId("read"), taskId: task.id, sessionId: task.sessionId, toolName: "read", params: { path: "file" } }));
      throw new Error("read failed");
    }
    return { output: "good" };
  });
  const run = f.start(`const bad=agent("bad",{request:"read"}); const good=agent("good",{request:"read"}); const dependent=agent("dependent",{request:"later",dependsOn:["bad"]}); return await Promise.all([bad,good,dependent]);`);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "partial");
  assert.equal(calls.filter(key => key === "bad").length, 3);
  assert.equal(calls.filter(key => key === "good").length, 1);
  assert.equal(calls.includes("dependent"), false);
  assert.equal(f.run(run.id).attempts, 4);
  assert.equal(getWorkflowStep(f.store, run.id, "dependent")!.status, "skipped");
  assert.equal(listWorkflowExecutions(f.store, run.id).filter(item => item.stepKey === "bad").length, 3);
});

test("失败依赖同时阻止汇总、人工问题与进度原语，汇总不产生外部效果", async t => {
  let agents = 0, integrations = 0;
  const f = fixture(t, async () => { agents++; throw new Error("read failed"); });
  f.deps.integrate = async () => { integrations++; fs.appendFileSync(path.join(f.root, "integration-effects"), "merged\n"); return "merged"; };
  const run = f.start(`
    const failed=agent("bad",{request:"read"});
    const merged=integrate("merge",{dependsOn:["bad"]});
    const question=ask("question",{prompt:"continue?",dependsOn:["bad"]});
    const reported=progress("report",{text:"done",dependsOn:["bad"]});
    return await Promise.all([failed,merged,question,reported]);
  `);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "failed");
  assert.equal(agents, 3);
  assert.equal(integrations, 0);
  assert.equal(fs.existsSync(path.join(f.root, "integration-effects")), false);
  assert.equal(getWorkflowQuestion(f.store, run.id, "question"), null);
  for (const key of ["merge", "question", "report"]) {
    const step = getWorkflowStep(f.store, run.id, key)!;
    assert.equal(step.status, "skipped");
    assert.deepEqual(step.result, { status: "skipped", code: "dependency_failed" });
  }
});

test("人工等待及其依赖中的 Agent 与汇总均不可执行，整项停计直到回答", async t => {
  let agents = 0, integrations = 0;
  const f = fixture(t, async () => { agents++; return { output: "done" }; });
  f.deps.integrate = async () => { integrations++; return "merged"; };
  const run = f.start(`
    const question=ask("question",{prompt:"continue?"});
    const work=agent("work",{request:"read",dependsOn:["question"]});
    const merged=integrate("merge",{dependsOn:["work"]});
    return await Promise.all([question,work,merged]);
  `, null, { durationMs: 1_000 });
  await until("问题与依赖步骤都已登记", () => listWorkflowSteps(f.store, run.id).length === 3 && getWorkflowQuestion(f.store, run.id, "question") !== null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run(run.id).status, "waiting");
  assert.equal(agents, 0);
  assert.equal(integrations, 0);
  assert.equal(listWorkflowExecutions(f.store, run.id).length, 0);
  assert.equal(getWorkflowStep(f.store, run.id, "work")!.status, "queued");
  assert.equal(getWorkflowStep(f.store, run.id, "merge")!.status, "queued");
  f.setNow(100_000);
  f.coordinator.kick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run(run.id).status, "waiting");
  assert.equal(chargeWorkflow(f.run(run.id), 100_000).usedMs, 0);
  f.coordinator.answer(run.id, "question", 1, "yes", f.source);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "succeeded");
  assert.equal(f.run(run.id).usedMs, 0);
  assert.equal(agents, 1);
  assert.equal(integrations, 1);
});

for (const variation of ["parameters", "order"] as const) {
  test(`重放检测稳定键${variation === "parameters" ? "异参" : "调用次序分歧"}并保留现场`, async t => {
    let calls = 0;
    const f = fixture(t, async () => { calls++; return { output: "unexpected" }; });
    const run = f.start(`return await agent("fixed",{request:"expected"});`);
    f.store.withTx(() => {
      setWorkflowState(f.store, run.id, "running", null, 1_000);
      registerWorkflowStep(f.store, { runId: run.id, ordinal: 1, key: variation === "order" ? "old-first" : "fixed", kind: "agent",
        params: { request: "previous" }, dependsOn: [] });
    });
    await until("恢复分歧暂停", () => f.run(run.id).status === "paused");
    assert.equal(f.run(run.id).reason, "replay_diverged");
    assert.equal(calls, 0);
    assert.equal(listWorkflowSteps(f.store, run.id).length, 1);
  });
}

test("Promise.race 按持久交付顺序恢复，完成步骤缓存不计尝试", async t => {
  const releases = new Map<string, ReturnType<typeof deferred<{ output: string }>>>();
  let calls = 0;
  const f = fixture(t, async ({ step }) => { calls++; const gate = deferred<{ output: string }>(); releases.set(step.key, gate); return gate.promise; });
  f.cleanup(() => { for (const gate of releases.values()) gate.resolve({ output: "cleanup" }); });
  const run = f.start(`const a=agent("first",{request:"first"}); const b=agent("second",{request:"second"}); const winner=await Promise.race([a,b]); await Promise.all([a,b]); return await ask("winner",{winner});`);
  await until("并发步骤启动", () => releases.size === 2);
  releases.get("second")!.resolve({ output: "second" });
  await until("第二步先交付", () => getWorkflowStep(f.store, run.id, "second")!.delivery !== null);
  releases.get("first")!.resolve({ output: "first" });
  await until("等待人工", () => f.run(run.id).status === "waiting");
  assert.equal(getWorkflowStep(f.store, run.id, "second")!.delivery, 1);
  assert.equal(getWorkflowStep(f.store, run.id, "first")!.delivery, 2);
  assert.deepEqual(getWorkflowQuestion(f.store, run.id, "winner")!.prompt, { winner: { status: "completed", value: "second" } });
  await f.restart();
  await f.coordinator.control(run.id, "resume", f.run(run.id).version, { action: "resume" });
  await until("恢复人工问题", () => f.run(run.id).status === "waiting");
  f.coordinator.answer(run.id, "winner", 1, "accepted", f.source);
  await until("恢复完成或暂停", () => ["succeeded", "paused"].includes(f.run(run.id).status));
  assert.deepEqual({status:f.run(run.id).status,reason:f.run(run.id).reason}, {status:"succeeded",reason:null});
  assert.equal(calls, 2);
  assert.equal(f.run(run.id).attempts, 2);
  assert.equal(listWorkflowExecutions(f.store, run.id).length, 2);
});

for (const failure of ["result_missing", "format", "unknown"] as const) {
  test(`已生效写操作${failure === "result_missing" ? "缺少结果" : failure === "format" ? "输出格式失败" : "效果未知"}不会重复外部效果`, async t => {
    let effects = 0;
    const f = fixture(t, async ({ task }) => {
      effects++;
      fs.appendFileSync(path.join(f.root, "external-effects"), "write\n");
      f.store.withTx(() => {
        const id = randomId("write");
        f.store.recordToolIntent({ id, taskId: task.id, sessionId: task.sessionId, toolName: "write", params: { path: "outside" } });
        if (failure !== "unknown") new ToolOpLedger(f.store).recordResult(task, id, "已写入", false);
      });
      if (failure === "format") return { output: "not-json" };
      throw new Error("response lost");
    });
    const output = failure === "format" ? `,output:{format:"json",schema:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"]}}` : "";
    const run = f.start(`return await agent("write",{request:"write"${output}});`);
    await until("写入恢复暂停", () => f.run(run.id).status === "paused");
    assert.equal(f.run(run.id).reason, failure === "unknown" ? "effect_unknown" : "write_result_missing");
    await f.restart();
    await assert.rejects(f.coordinator.control(run.id, "unsafe-resume", f.run(run.id).version, { action: "resume", clockConfirmed: true }), { code: "verification_required" });
    await f.coordinator.control(run.id, "pause-again", f.run(run.id).version, { action: "pause" });
    await assert.rejects(f.coordinator.control(run.id, "unsafe-resume-after-pause", f.run(run.id).version,
      { action: "resume", clockConfirmed: true, stopsConfirmed: true }), { code: "verification_required" });
    assert.equal(effects, 1);
    assert.equal(fs.readFileSync(path.join(f.root, "external-effects"), "utf8"), "write\n");
    assert.equal(listWorkflowExecutions(f.store, run.id).length, 1);
    const taskId = listWorkflowExecutions(f.store, run.id)[0].taskId;
    assert.equal(f.store.getTask(taskId)!.effectUnknown, failure === "unknown");
  });
}

test("仅格式失败不自动重跑只读 Agent，保留原始输出", async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { output: "invalid json" }; });
  const run = f.start(`return await agent("json",{request:"read",output:{format:"json",schema:{type:"object"}}});`);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "failed");
  assert.equal(calls, 1);
  assert.equal(getWorkflowStep(f.store, run.id, "json")!.rawOutput, "invalid json");
});

test("已完成写步骤在等待人工时重启，复用结果并保留一次真实外部效果", async t => {
  let effects = 0;
  const f = fixture(t, async ({ task }) => {
    effects++;
    fs.appendFileSync(path.join(f.root, "external-effects"), "committed\n");
    f.store.withTx(() => {
      const id = randomId("write");
      f.store.recordToolIntent({ id, taskId: task.id, sessionId: task.sessionId, toolName: "write", params: { path: "external-effects" } });
      new ToolOpLedger(f.store).recordResult(task, id, "已写入", false);
    });
    return { output: "committed" };
  });
  const run = f.start(`const written=await agent("write",{request:"write"}); return await ask("question",{written});`);
  await until("写入后等待人工", () => f.run(run.id).status === "waiting");
  await f.restart();
  await f.coordinator.control(run.id, "resume", f.run(run.id).version, { action: "resume" });
  await until("重放完成后的人工等待", () => f.run(run.id).status === "waiting");
  f.coordinator.answer(run.id, "question", 1, "yes", f.source);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "succeeded");
  assert.equal(effects, 1);
  assert.equal(f.run(run.id).attempts, 1);
  assert.equal(fs.readFileSync(path.join(f.root, "external-effects"), "utf8"), "committed\n");
});

for (const [encoding, raw] of [["UTF-8", "原始输出".repeat(100_000)], ["JSON 转义", "\u0001".repeat(100 * 1024)]] as const) {
  test(`${encoding} 超大 Agent 输出保留完整产物、摘要与字节数，格式失败不触发重试`, async t => {
    let calls = 0;
    const f = fixture(t, async () => { calls++; return { output: raw }; });
    const run = f.start(`return await agent("large",{request:"read"});`);
    await f.terminal(run.id);
    assert.equal(f.run(run.id).status, "failed");
    assert.equal(calls, 1);
    const step = getWorkflowStep(f.store, run.id, "large")!;
    assert.deepEqual(step.result, { status: "failed", code: "output_limit" });
    assert.equal(step.rawOutput, null);
    assert.ok(step.outputArtifact);
    const saved = fs.readFileSync(path.join(f.root, "artifacts", `${step.outputArtifact.id}.bin`));
    assert.equal(saved.toString("utf8"), raw);
    assert.equal(step.outputArtifact.hash, createHash("sha256").update(saved).digest("hex"));
    assert.equal(step.outputArtifact.bytes, saved.length);
    assert.equal(f.store.getArtifact(step.outputArtifact.id)!.status, "complete");
  });
}

for (const damage of ["missing", "corrupt"] as const) {
  test(`大输出产物${damage === "missing" ? "丢失" : "摘要损坏"}时恢复暂停，保留成果且不重跑`, async t => {
    let calls = 0;
    const f = fixture(t, async () => { calls++; return { output: "x".repeat(600_000) }; });
    const run = f.start(`await agent("large",{request:"read"}); return await ask("question",{prompt:"continue?"});`);
    await until("输出已保存后等待人工", () => f.run(run.id).status === "waiting");
    const ref = getWorkflowStep(f.store, run.id, "large")!.outputArtifact!;
    const file = path.join(f.root, "artifacts", `${ref.id}.bin`);
    if (damage === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, "y".repeat(ref.bytes));
    await f.restart();
    assert.equal(f.run(run.id).status, "paused");
    assert.equal(f.run(run.id).reason, "result_missing");
    await assert.rejects(f.coordinator.control(run.id, "resume", f.run(run.id).version, { action: "resume" }), { code: "verification_required" });
    assert.equal(calls, 1);
    assert.deepEqual(getWorkflowStep(f.store, run.id, "large")!.outputArtifact, ref);
  });
}

test("尝试限额暂停保留成果，可信预算调整后恢复且不重做缓存", async t => {
  const calls: string[] = [];
  const f = fixture(t, async ({ step }) => { calls.push(step.key); return { output: step.key }; });
  const run = f.start(`await agent("first",{request:"one"}); return await agent("second",{request:"two"});`, null, { maxAttempts: 1 });
  await until("达到尝试预算", () => f.run(run.id).status === "paused");
  await until("脚本停止核实", () => f.run(run.id).scriptStopVerified === true);
  assert.equal(f.run(run.id).reason, "attempt_limit");
  assert.deepEqual(calls, ["first"]);
  await f.coordinator.control(run.id, "budget", f.run(run.id).version, { action: "budget", maxAttempts: 2, durationMs: 3_600_000 });
  await f.coordinator.control(run.id, "resume", f.run(run.id).version, { action: "resume" });
  await f.terminal(run.id);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(f.run(run.id).attempts, 2);
  assert.equal(f.run(run.id).status, "succeeded");
});

test("暂停后恢复再重发旧暂停请求，只去重且不停止新脚本或新 Agent", async t => {
  const gate = deferred<void>();
  let signal: AbortSignal | undefined;
  let effects = 0;
  const f = fixture(t, async context => {
    signal = context.signal;
    await gate.promise;
    if (!signal.aborted) {
      const op = randomId("write");
      f.store.withTx(() => f.store.recordToolIntent({ id: op, taskId: context.task.id, sessionId: context.task.sessionId,
        toolName: "write", params: { path: "new-effects" } }));
      effects++;
      fs.appendFileSync(path.join(f.root, "new-effects"), "written\n");
      f.store.withTx(() => new ToolOpLedger(f.store).recordResult(context.task, op, "已写入", false));
    }
    return { output: "done" };
  });
  f.cleanup(() => gate.resolve());
  const run = f.start(`await ask("question",{prompt:"continue?"}); return await agent("work",{request:"write"});`);
  await until("初次等待人工", () => f.run(run.id).status === "waiting");
  const pauseVersion = f.run(run.id).version;
  await f.coordinator.control(run.id, "pause-P", pauseVersion, { action: "pause" });
  await until("首次暂停已停止脚本", () => f.run(run.id).scriptStopVerified === true);
  await f.coordinator.control(run.id, "resume-R", f.run(run.id).version, { action: "resume" });
  await until("恢复人工等待", () => f.run(run.id).status === "waiting");
  f.coordinator.answer(run.id, "question", 1, "yes", f.source);
  await until("恢复后新的 Agent 正在执行", () => signal !== undefined);
  const taskId = listWorkflowExecutions(f.store, run.id)[0].taskId;
  await f.coordinator.control(run.id, "pause-P", pauseVersion, { action: "pause" });
  assert.equal(f.run(run.id).status, "running");
  assert.equal(signal!.aborted, false);
  assert.equal(f.store.getTask(taskId)!.status, "running");
  gate.resolve();
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "succeeded");
  assert.equal(effects, 1);
  assert.equal(fs.readFileSync(path.join(f.root, "new-effects"), "utf8"), "written\n");
  assert.equal(f.run(run.id).attempts, 1);
});

test("人工问题旁的脚本收到进度回复后继续计算仍计费，到限前不启动后续 Agent", async t => {
  let starts = 0;
  const f = fixture(t, async () => { starts++; return { output: "done" }; });
  const run = f.start(`
    const question = ask("question", {prompt:"continue?"});
    await progress("tick", {});
    let sum=0; for(let i=0;i<10000000;i++) sum+=i;
    await agent("after", {request:"after compute"});
    return await question;
  `, null, { durationMs: 250 });
  await until("进度回复已登记", () => getWorkflowStep(f.store, run.id, "tick")?.delivery !== null && getWorkflowStep(f.store, run.id, "tick")?.delivery !== undefined);
  f.setNow(1_300);
  f.coordinator.kick();
  await until("计算超时或旧行为启动 Agent", () => f.run(run.id).status === "paused" || starts > 0);
  assert.equal(f.run(run.id).status, "paused");
  assert.equal(f.run(run.id).reason, "duration_limit");
  assert.equal(f.run(run.id).usedMs, 300);
  assert.equal(starts, 0);
  assert.equal(f.run(run.id).attempts, 0);
  await until("计算脚本已停止", () => f.run(run.id).scriptStopVerified === true);
});

test("人工等待整项停计，另有分支运行时继续按墙钟计费", async t => {
  const gate = deferred<{ output: string }>();
  const f = fixture(t, async () => gate.promise);
  f.cleanup(() => gate.resolve({ output: "cleanup" }));
  const run = f.start(`const question=ask("question",{prompt:"continue?"}); const work=agent("work",{request:"read"}); return await Promise.all([question,work]);`);
  await until("问题与执行登记", () => getWorkflowQuestion(f.store, run.id, "question") !== null && listWorkflowExecutions(f.store, run.id).length === 1);
  f.setNow(6_000);
  f.coordinator.kick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run(run.id).status, "running");
  assert.equal(chargeWorkflow(f.run(run.id), 6_000).usedMs, 5_000);
  gate.resolve({ output: "done" });
  await until("仅人工等待", () => f.run(run.id).status === "waiting");
  assert.equal(f.run(run.id).usedMs, 5_000);
  f.setNow(106_000);
  assert.equal(chargeWorkflow(f.run(run.id), 106_000).usedMs, 5_000);
  assert.throws(() => f.coordinator.answer(run.id, "question", 1, "wrong-source", { ...f.source, sessionId: "other" }), { code: "stale_answer" });
  assert.throws(() => f.coordinator.answer(run.id, "question", 2, "wrong-version", f.source), { code: "stale_answer" });
  f.coordinator.answer(run.id, "question", 1, "yes", f.source);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).usedMs, 5_000);
  assert.throws(() => f.coordinator.answer(run.id, "question", 1, "late", f.source), { code: "stale_answer" });
});

test("时限暂停停止只读在途尝试，预算调整后恢复且已计时间不归零", async t => {
  let calls = 0;
  const f = fixture(t, async ({ signal }) => {
    calls++;
    if (calls === 1) return await new Promise(resolve => signal.addEventListener("abort", () => resolve({ output: "stopped" }), { once: true }));
    return { output: "resumed" };
  });
  const run = f.start(`return await agent("work",{request:"read"});`, null, { durationMs: 1_000 });
  await until("步骤实际开始", () => calls === 1);
  f.setNow(2_100);
  f.coordinator.kick();
  await until("时限暂停并完成停止", () => f.run(run.id).status === "paused" && f.run(run.id).scriptStopVerified === true &&
    listWorkflowExecutions(f.store, run.id).every(item => item.status === "finished"));
  assert.equal(f.run(run.id).reason, "duration_limit");
  assert.equal(f.run(run.id).usedMs, 1_100);
  await f.coordinator.control(run.id, "budget", f.run(run.id).version, { action: "budget", maxAttempts: 100, durationMs: 2_000 });
  await f.coordinator.control(run.id, "resume", f.run(run.id).version, { action: "resume" });
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "succeeded");
  assert.equal(f.run(run.id).usedMs, 1_100);
  assert.equal(f.run(run.id).attempts, 2);
  assert.equal(calls, 2);
});

test("崩溃时未核实时钟先暂停，可信确认后保留已有消耗", async t => {
  const f = fixture(t);
  const run = f.start(`return await ask("question",{prompt:"wait"});`);
  await until("等待人工", () => f.run(run.id).status === "waiting");
  await f.coordinator.stop("prepare_crash");
  f.store.withTx(() => setWorkflowState(f.store, run.id, "running", null, 1_000));
  f.setNow(6_000);
  await f.restart();
  assert.equal(f.run(run.id).status, "paused");
  assert.equal(f.run(run.id).reason, "clock_unverified");
  assert.equal(f.run(run.id).usedMs, 5_000);
  await assert.rejects(f.coordinator.control(run.id, "unconfirmed", f.run(run.id).version, { action: "resume" }), { code: "verification_required" });
  await f.coordinator.control(run.id, "confirmed", f.run(run.id).version, { action: "resume", clockConfirmed: true });
  await until("恢复人工等待", () => f.run(run.id).status === "waiting");
  f.coordinator.answer(run.id, "question", 1, "yes", f.source);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).usedMs, 5_000);
});

test("人工等待重启保留脚本进程身份，停止未核实先暂停并拒绝回答", async t => {
  const f = fixture(t);
  const run = f.start(`return await ask("question",{prompt:"wait"});`);
  await until("等待人工", () => f.run(run.id).status === "waiting");
  const units = f.run(run.id).scriptUnits;
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, "process_group");
  assert.match(units[0].id, /^\d+$/);
  await f.coordinator.stop("prepare_crash");
  f.store.withTx(() => {
    setWorkflowState(f.store, run.id, "waiting", "owner_input", 1_000);
    updateWorkflowRun(f.store, { ...f.run(run.id), scriptStopVerified: null });
  });
  await f.restart();
  assert.equal(f.run(run.id).status, "paused");
  assert.equal(f.run(run.id).reason, "stop_unverified");
  assert.deepEqual(f.run(run.id).scriptUnits, units);
  assert.throws(() => f.coordinator.answer(run.id, "question", 1, "early", f.source), { code: "stale_answer" });
  await assert.rejects(f.coordinator.control(run.id, "unconfirmed", f.run(run.id).version, { action: "resume" }), { code: "verification_required" });
  await f.coordinator.control(run.id, "confirmed", f.run(run.id).version, { action: "resume", stopsConfirmed: true });
  await until("核实停止后恢复人工等待", () => f.run(run.id).status === "waiting");
  f.coordinator.answer(run.id, "question", 1, "yes", f.source);
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "succeeded");
});

test("取消先登记意图，迟到结果、回答与未核实停止不能释放占用或继续", async t => {
  const gate = deferred<{ output: string }>();
  const f = fixture(t, async ({ register }) => {
    register({ kind: "process_group", id: "unverified-unit", label: "unverified", stop: async () => false });
    return gate.promise;
  });
  f.cleanup(() => gate.resolve({ output: "cleanup" }));
  const run = f.start(`const question=ask("question",{prompt:"continue?"}); const work=agent("work",{request:"write"}); await Promise.all([question,work]); return await agent("late",{request:"later"});`);
  await until("有活动执行", () => listWorkflowExecutions(f.store, run.id).some(item => item.status === "running" && item.units.length === 1));
  await f.coordinator.control(run.id, "cancel", f.run(run.id).version, { action: "cancel" });
  assert.equal(f.run(run.id).status, "canceled");
  assert.throws(() => f.coordinator.answer(run.id, "question", 1, "late", f.source), { code: "stale_answer" });
  gate.resolve({ output: "late-success" });
  await until("迟到执行收尾", () => listWorkflowExecutions(f.store, run.id)[0].status === "finished");
  assert.equal(f.run(run.id).status, "canceled");
  assert.equal(getWorkflowStep(f.store, run.id, "work")!.status, "canceled");
  assert.equal(getWorkflowStep(f.store, run.id, "late"), null);
  const execution = listWorkflowExecutions(f.store, run.id)[0];
  assert.equal(execution.stopVerified, false);
  assert.ok(f.store.listAllOccupancy().some(item => item.taskId === execution.taskId));
  const events = f.store.getEventsAfter(0);
  const canceled = events.findIndex(event => event.body.type === "workflow.changed" && event.body.runId === run.id && event.body.status === "canceled");
  const interrupted = events.findIndex(event => event.body.type === "task.canceled" && event.body.taskId === execution.taskId);
  assert.ok(canceled >= 0 && interrupted > canceled);
});

const competingProcess = `
import {Db} from "@ruukoto/core/db.ts";
import {Store} from "@ruukoto/core/store.ts";
import {controlWorkflow,startWorkflowExecution} from "@ruukoto/core/workflow.ts";
const db=new Db(process.env.WORKFLOW_TEST_DATA); const store=new Store(db);
process.send({ready:true});
process.on("message", async command=>{
  for(;;){
    try {
      const value=store.withTx(()=>{
        if(command.action==="control") return controlWorkflow(store,command.runId,command.key,command.version,command.control,1000).status;
        if(!startWorkflowExecution(store,command.taskId,1000)) return false;
        store.transitionTask(command.taskId,["queued"],"running"); return true;
      });
      process.send({value}); break;
    } catch(error) {
      if(error.errcode===5) { await new Promise(resolve=>setTimeout(resolve,5)); continue; }
      process.send({error:error.code ?? error.message}); break;
    }
  }
  db.close(); process.disconnect();
});`;
async function compete(f: ReturnType<typeof fixture>, commands: Record<string, unknown>[]) {
  const peers: { child: ReturnType<typeof spawn>; result: Promise<{ value?: unknown; error?: string }> }[] = [];
  for (let index = 0; index < commands.length; index++) {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval", competingProcess], { cwd: process.cwd(), env: { ...process.env, WORKFLOW_TEST_DATA: f.root }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const ready = deferred<void>(), result = deferred<{ value?: unknown; error?: string }>();
    let diagnostics = "";
    child.stderr!.on("data", data => { diagnostics += data; });
    child.on("message", message => { const reply = message as { ready?: boolean; value?: unknown; error?: string }; if (reply.ready) ready.resolve(); else result.resolve(reply); });
    child.on("exit", code => { if (code !== 0) { ready.resolve(); result.resolve({ error: diagnostics }); } });
    await ready.promise;
    peers.push({ child, result: result.promise });
  }
  peers.forEach((peer, index) => peer.child.send(commands[index]));
  return Promise.all(peers.map(peer => peer.result));
}
function claimable(f: ReturnType<typeof fixture>, run: WorkflowRun, key: string) {
  const task = ordinaryTask(f, "queued");
  f.store.withTx(() => {
    registerWorkflowStep(f.store, { runId: run.id, key, ordinal: listWorkflowSteps(f.store, run.id).length + 1,
      kind: "agent", params: { request: key }, dependsOn: [] });
    bindWorkflowExecution(f.store, { id: randomId("execution"), runId: run.id, stepKey: key, taskId: task.id,
      kind: "agent", number: 1, status: "queued", units: [], stopVerified: null });
  });
  return task;
}

test("真实 SQLite 双连接竞争：同一版本控制只有一次提交且事件对应", async t => {
  const f = fixture(t);
  const run = f.start(`return await ask("wait",{prompt:"wait"});`);
  await until("等待人工", () => f.run(run.id).status === "waiting");
  const version = f.run(run.id).version;
  const replies = await compete(f, [
    { action: "control", runId: run.id, key: "pause", version, control: { action: "pause" } },
    { action: "control", runId: run.id, key: "budget", version, control: { action: "budget", maxAttempts: 120, durationMs: 3_600_000 } },
  ]);
  assert.equal(replies.filter(reply => reply.error === "version_conflict").length, 1);
  const rows = f.store.db.prepare("SELECT request_key FROM workflow_controls WHERE run_id = ?").all(run.id);
  assert.equal(rows.length, 1);
  const events = f.store.getEventsAfter(0).filter(event => event.body.type === "workflow.changed" && event.body.runId === run.id && event.body.version === version + 1);
  assert.equal(events.length, 1);
});

for (const limit of ["attempt", "slot"] as const) {
  test(`真实 SQLite 双连接竞争：${limit === "attempt" ? "最后一次尝试" : "最后一个共享名额"}只被领取一次`, async t => {
    const f = fixture(t);
    const run = f.start(`return await ask("wait",{prompt:"wait"});`, null, { maxAttempts: limit === "attempt" ? 1 : 100 });
    await until("等待人工", () => f.run(run.id).status === "waiting");
    await f.coordinator.stop("prepare_competition");
    f.store.withTx(() => setWorkflowState(f.store, run.id, "running", null, 1_000));
    if (limit === "slot") { ordinaryTask(f); ordinaryTask(f); }
    const a = claimable(f, run, "a"), b = claimable(f, run, "b");
    const replies = await compete(f, [{ action: "claim", taskId: a.id }, { action: "claim", taskId: b.id }]);
    assert.deepEqual(replies.map(reply => reply.value).sort(), [false, true]);
    assert.equal(f.run(run.id).attempts, 1);
    assert.equal([a, b].filter(task => f.store.getTask(task.id)!.status === "running").length, 1);
    assert.equal(workflowSlotsUsed(f.store, f.session.id), limit === "slot" ? 3 : 1);
  });
}

test("真实 SQLite 双连接竞争：取消与启动按运行版本仲裁，不会取消后重新领取", async t => {
  const f = fixture(t);
  const run = f.start(`return await ask("wait",{prompt:"wait"});`);
  await until("等待人工", () => f.run(run.id).status === "waiting");
  await f.coordinator.stop("prepare_competition");
  f.store.withTx(() => setWorkflowState(f.store, run.id, "running", null, 1_000));
  const task = claimable(f, run, "work");
  const version = f.run(run.id).version;
  const replies = await compete(f, [
    { action: "control", runId: run.id, key: "cancel", version, control: { action: "cancel" } },
    { action: "claim", taskId: task.id },
  ]);
  if (replies[0].error === "version_conflict") f.store.withTx(() => controlWorkflow(f.store, run.id, "cancel", f.run(run.id).version, { action: "cancel" }, 1_000));
  else assert.equal(replies[0].value, "canceled");
  assert.equal(f.run(run.id).status, "canceled");
  const current = f.store.getTask(task.id)!;
  if (replies[1].value === true) { assert.equal(current.status, "running"); assert.equal(current.cancelRequested, true); }
  else { assert.equal(replies[1].value, false); assert.equal(current.status, "canceled"); }
  const again = await compete(f, [{ action: "claim", taskId: task.id }]);
  assert.equal(again[0].value, false);
});

test("真实 SQLite 双连接竞争：预算提高与排队领取按提交顺序生效", async t => {
  const f = fixture(t);
  const run = f.start('return await ask("wait",{prompt:"wait"});', null, { maxAttempts: 1 });
  await until("等待人工", () => f.run(run.id).status === "waiting");
  await f.coordinator.stop("prepare_competition");
  f.store.withTx(() => {
    const running = setWorkflowState(f.store, run.id, "running", null, 1_000);
    updateWorkflowRun(f.store, { ...running, attempts: 1 });
  });
  const queued = claimable(f, run, "next");
  const version = f.run(run.id).version;
  const replies = await compete(f, [
    { action: "control", runId: run.id, key: "raise", version, control: { action: "budget", maxAttempts: 2, durationMs: 3_600_000 } },
    { action: "claim", taskId: queued.id },
  ]);
  if (replies[0].error === "version_conflict") {
    assert.equal(replies[1].value, false);
    assert.equal(f.run(run.id).status, "paused");
    assert.equal(f.run(run.id).maxAttempts, 1);
    assert.equal(f.run(run.id).attempts, 1);
    assert.equal(f.store.getTask(queued.id)!.status, "queued");
  } else {
    assert.equal(replies[0].value, "running");
    assert.equal(replies[1].value, true);
    assert.equal(f.run(run.id).maxAttempts, 2);
    assert.equal(f.run(run.id).attempts, 2);
    assert.equal(f.store.getTask(queued.id)!.status, "running");
  }
});

test("已开始的只读尝试崩溃后，停止与计费经可信核实才重排，不重复旧尝试", async t => {
  let starts = 0;
  const f = fixture(t, async () => { starts++; return { output: "restored" }; });
  const run = f.start('return await agent("work",{request:"work"});');
  await f.coordinator.stop("prepare_crash");
  f.store.withTx(() => setWorkflowState(f.store, run.id, "running", null, 1_000));
  const task = claimable(f, run, "work");
  f.store.withTx(() => {
    f.store.transitionTask(task.id, ["queued"], "running");
    const session = f.store.getSession(task.sessionId)!;
    f.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, sessionId: session.id, taskId: task.id });
    f.store.db.prepare("UPDATE workflow_executions SET payload = json_set(payload, '$.status', 'running') WHERE task_id = ?").run(task.id);
    f.store.db.prepare("UPDATE workflow_steps SET payload = json_set(payload, '$.status', 'running', '$.attempts', 1) WHERE run_id = ? AND key = 'work'").run(run.id);
    const current = f.run(run.id);
    updateWorkflowRun(f.store, { ...current, attempts: 1 });
    f.store.endTask(task.id, ["running"], "interrupted", { interruptReason: "backend_restart", keepOccupancy: true });
  });
  await f.restart();
  assert.equal(f.run(run.id).status, "paused");
  await assert.rejects(f.coordinator.control(run.id, "early", f.run(run.id).version, { action: "resume", clockConfirmed: true, stopsConfirmed: true }), { code: "verification_required" });
  f.store.withTx(() => f.store.releaseOccupancy(task.id));
  await f.coordinator.control(run.id, "verified", f.run(run.id).version, { action: "resume", clockConfirmed: true, stopsConfirmed: true });
  await f.terminal(run.id);
  assert.equal(starts, 1);
  assert.equal(f.run(run.id).status, "succeeded");
  assert.equal(f.run(run.id).attempts, 2);
  assert.equal(f.store.getTask(task.id)!.status, "interrupted");
});

test("工作流沿 Runtime 的宿主族效果分类：中止 history_read 没有写入效果，可以有限重试", async t => {
  let starts = 0;
  const f = fixture(t, async context => {
    starts++;
    if (starts === 1) {
      f.store.withTx(() => f.store.recordToolIntent({ id: "host-read", taskId: context.task.id, sessionId: context.task.sessionId,
        toolName: "history_read", params: {} }));
      throw new Error("只读调用中止");
    }
    return { output: "read-restored" };
  });
  f.deps.ledger = new ToolOpLedger(f.store, {}, [HOST_DATA_LEDGER]);
  await f.restart();
  const run = f.start('return await agent("read",{request:"read history"});');
  await f.terminal(run.id);
  assert.equal(f.run(run.id).status, "succeeded");
  assert.equal(f.run(run.id).attempts, 2);
  assert.equal(starts, 2);
  assert.equal(f.store.getToolOp("host-read")!.effectUnknown, false);
  assert.match(f.store.getToolOp("host-read")!.resultSummary!, /无写入效果/);
});

test("脚本入口缺失保存稳定失败码，不发起 Agent", async t => {
  const f = fixture(t);
  f.deps.script = label => new WorkflowScriptHost(label, () => Promise.reject(new ScriptExecutionError("script_entry_missing")));
  const run = f.start('return await agent("work",{request:"work"});');
  await until("入口缺失暂停", () => f.run(run.id).status === "paused");
  assert.equal(f.run(run.id).reason, "script_entry_missing");
  assert.equal(f.run(run.id).attempts, 0);
  assert.equal(listWorkflowExecutions(f.store, run.id).length, 0);
});
