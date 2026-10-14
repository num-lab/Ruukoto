import { fixtureSubAgentRoleCatalog } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { randomId, type Session, type Task, type WorkDelegation } from "@ruukoto/core/types.ts";
import { bindWorkflowExecution, controlWorkflow, createWorkflowRun, getWorkflowExecution, getWorkflowRun, listWorkflowExecutions, registerWorkflowStep, saveWorkflowDefinition, startWorkflowExecution, workflowDigest, type WorkflowRun } from "@ruukoto/core/workflow.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { WorkCopyManager } from "@ruukoto/runtime/work-copy.ts";
import { controlledWorkCopy } from "./helpers/controlled-work-copy.ts";
import { initGitRepo, shellQuotePathForTest } from "./helpers/git-fixture.ts";
import { realTools, startTestRuntime, waitFor } from "./helpers/testkit.ts";

function seedRun(rt: Runtime, parent: Task, session: Session): WorkflowRun {
  return rt.store.withTx(() => {
    const definition = saveWorkflowDefinition(rt.store, "return 1;");
    return createWorkflowRun(rt.store, { roleCatalog: fixtureSubAgentRoleCatalog(),
      id: randomId("wfrun"), requestKey: "host-run", paramsDigest: "host-run", definitionId: definition.id,
      scriptDigest: definition.digest, input: null, inputDigest: workflowDigest(null),
      source: { product: "ruukoto", projectId: session.projectId, sessionId: session.id, taskId: parent.id,
        permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [],
        capabilities: [], references: [], replyTarget: null, scheduledRunId: null },
      modelSelection: rt.defaultSelection, status: "running", version: 1, reason: null,
      attempts: 0, maxAttempts: 100, durationMs: 3_600_000, usedMs: 0, clockStartedAt: null,
      scriptUnits: [], scriptStopVerified: null,
      clockVerified: true,
      result: null, resultRecorded: false, createdAt: new Date().toISOString(), endedAt: null,
    });
  });
}

function hostTask(rt: Runtime, run: WorkflowRun, session: Session, key: string, ordinal: number): Task {
  const task = rt.store.withTx(() => {
    registerWorkflowStep(rt.store, { runId: run.id, key, ordinal, kind: "integrate", params: {}, dependsOn: [] });
    const { task } = rt.store.insertQueuedTask({
      sessionId: session.id, requestId: `host:${key}`, input: "宿主工作副本操作", modelSelection: run.modelSelection,
      submissionDigest: key, parentTaskId: run.source.taskId, accessMode: run.source.accessMode,
      sourcePermissionVersion: run.source.permissionVersion,
    });
    bindWorkflowExecution(rt.store, { id: randomId("wfexec"), runId: run.id, stepKey: key, kind: "host",
      taskId: task.id, number: 1, status: "queued", units: [], stopVerified: null });
    assert.equal(startWorkflowExecution(rt.store, task.id), true);
    assert.equal(rt.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno,
      sessionId: session.id, taskId: task.id }), true);
    assert.equal(rt.store.transitionTask(task.id, ["queued"], "running"), true);
    return rt.store.getTask(task.id)!;
  });
  rt.hostExecutions.attach(task.id);
  return task;
}

test("原任务结束后宿主任务真实创建和汇总 Git 副本，不创建模型会话或计 Agent 尝试", async () => {
  const t = await startTestRuntime("workflow-host-git", async () => ({ kind: "text", text: "原任务完成" }), { config: { ...realTools(), workflowAgent: null }, workDirs: 1 });
  try {
    const rt = t.runtime;
    const sourceFile = path.join(t.work[0], "source.txt");
    fs.writeFileSync(sourceFile, "source\n");
    initGitRepo(t.work[0]);
    const session = await rt.createSession({ projectName: "workflow-host-git", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
    await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const modelCalls = t.server.calls.length;
    const sessions = rt.store.listSessions().length;
    const run = seedRun(rt, parent, session);
    const copies = new WorkCopyManager({ worktreeRoot: path.join(t.dirs.root, "copies"), protectedRoots: () => rt.protectedRoots(), execute: input => rt.executeWorkCopy(input) });
    const workId = randomId("work");
    const create = hostTask(rt, run, session, "create", 1);
    const target = await copies.prepareWriteTarget(".", session, workId, parent.id, { kind: "workflow-host", taskId: create.id });
    assert.equal(target.kind, "worktree");
    assert.equal(await rt.hostExecutions.stop(create.id, "completed", ""), true);
    assert.equal(getWorkflowExecution(rt.store, create.id)!.stopVerified, true);
    assert.ok(getWorkflowExecution(rt.store, create.id)!.units.some(unit => unit.kind === "process_group"));
    if (target.kind !== "worktree") assert.fail("需要真实 Git 副本");
    fs.writeFileSync(path.join(target.path, "source.txt"), "result\n");
    const work: WorkDelegation = { id: workId, parentSessionId: session.id, originTaskId: parent.id,
      subAgentId: "fixture-only", requestKey: "copy", paramsDigest: "copy", canceledAt: null,
      canceledBy: null, cancelReason: null, writeTarget: target, createdAt: new Date().toISOString() };
    const integrate = hostTask(rt, run, session, "integrate", 2);
    const result = await copies.integrate({ work, target, parentSession: session, parentTaskId: parent.id,
      execution: { kind: "workflow-host", taskId: integrate.id } });
    assert.equal(result.state, "applied");
    assert.equal(await rt.hostExecutions.stop(integrate.id, "completed", ""), true);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "result\n");
    assert.equal(fs.readFileSync(path.join(target.path, "source.txt"), "utf8"), "result\n");
    assert.equal(rt.store.getTask(parent.id)!.status, "completed");
    assert.equal(rt.store.listSessions().length, sessions);
    assert.equal(t.server.calls.length, modelCalls);
    assert.equal(getWorkflowRun(rt.store, run.id)!.attempts, 0);
    assert.equal(rt.store.listAllOccupancy().length, 0);
    assert.ok(rt.store.listToolOpsByTask(create.id).some(op => op.toolName === "worktree_create" && op.resultSummary !== null));
    assert.ok(rt.store.listToolOpsByTask(integrate.id).some(op => op.toolName === "worktree_integrate" && op.resultSummary !== null));
  } finally { await t.shutdown(); }
});

for (const phase of ["ready", "call"] as const) {
  test(`宿主任务 ${phase} 阶段取消且停止未核实，身份和双方占用保留，后续操作不重入`, async () => {
    const t = await startTestRuntime(`workflow-host-stop-${phase}`, async () => ({ kind: "text", text: "原任务完成" }), { config: { workflowAgent: null }, workDirs: 1 });
    let stops = 0;
    const controlled = controlledWorkCopy(async () => { stops++; return false; }, "", phase === "call", false);
    try {
      const rt = t.runtime;
      const session = await rt.createSession({ projectName: "workflow-host-stop", cwd: t.work[0] });
      const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
      await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
      const modelCalls = t.server.calls.length;
      const run = seedRun(rt, parent, session);
      const task = hostTask(rt, run, session, "create", 1);
      const copyDir = path.join(t.dirs.root, "copy");
      fs.mkdirSync(copyDir);
      rt.launcherFor = () => controlled.launcher;
      const input = { parentTaskId: parent.id, execution: { kind: "workflow-host" as const, taskId: task.id },
        workId: "host-copy", operation: "create" as const, workspace: session.cwdReal, copyDir, branch: "host-copy", command: "write" };
      const rejected = assert.rejects(rt.executeWorkCopy(input), { code: "worker_stop_unverified" });
      await waitFor("宿主单元启动", () => phase === "call" ? controlled.requests.some(request => request.type === "tool_call") : controlled.specs.length > 0);
      if (phase === "call") fs.writeFileSync(path.join(copyDir, "result.txt"), "已执行的写入\n");
      await rt.cancelTask(task.id);
      await rejected;
      const execution = getWorkflowExecution(rt.store, task.id)!;
      const persisted = rt.store.db.prepare("SELECT payload FROM workflow_executions WHERE task_id = ?").get(task.id) as { payload: string };
      assert.equal(JSON.parse(persisted.payload).stopVerified, false);
      assert.equal(execution.stopVerified, false);
      assert.equal(execution.status, "finished");
      assert.ok(execution.units.some(unit => unit.kind === "systemd_unit" && unit.id === "controlled-work-copy"));
      assert.equal(rt.store.getTask(task.id)!.status, "canceled");
      assert.equal(rt.store.getTask(parent.id)!.status, "completed");
      assert.equal(rt.store.getOccupancyByDir(session.cwdReal)!.taskId, task.id);
      assert.equal(rt.store.getOccupancyByDir(fs.realpathSync(copyDir))!.taskId, task.id);
      assert.equal(rt.store.getTask(task.id)!.effectUnknown, phase === "call");
      assert.ok(rt.store.getTaskEventsAfter(task.id, 0, 100).some(event => event.body.type === "task.tool_process_unreaped"));
      assert.equal(await rt.hostExecutions.stop(task.id, "interrupted", "repeat"), false);
      await assert.rejects(rt.executeWorkCopy(input), { code: "task_ending" });
      assert.equal(stops, 1);
      assert.equal(controlled.specs.length, 1);
      assert.equal(t.server.calls.length, modelCalls);
      if (phase === "call") assert.equal(fs.readFileSync(path.join(copyDir, "result.txt"), "utf8"), "已执行的写入\n");
      const next = await rt.submit({ sessionId: session.id, requestId: "next", input: "后续任务", modelSelection: rt.defaultSelection });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(rt.store.getTask(next.id)!.status, "queued");
    } finally { controlled.finish(); await t.shutdown(); }
  });
}

test("宿主操作入口在原任务结束后创建和汇总真实副本，同键缓存不再运行 Git", async () => {
  const t = await startTestRuntime("workflow-host-entry", async () => ({ kind: "text", text: "原任务完成" }), { config: { ...realTools(), workflowAgent: null }, workDirs: 1 });
  try {
    const rt = t.runtime;
    const sourceFile = path.join(t.work[0], "source.txt");
    fs.writeFileSync(sourceFile, "source\n");
    initGitRepo(t.work[0]);
    const session = await rt.createSession({ projectName: "workflow-host-entry", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
    await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const sessions = rt.store.listSessions().length;
    const modelCalls = t.server.calls.length;
    const run = seedRun(rt, parent, session);
    const copies = new WorkCopyManager({ worktreeRoot: path.join(t.dirs.root, "copies"), protectedRoots: () => rt.protectedRoots(), execute: input => rt.executeWorkCopy(input) });
    const workId = randomId("work");
    rt.store.withTx(() => registerWorkflowStep(rt.store, { runId: run.id, key: "create", ordinal: 1, kind: "integrate", params: {}, dependsOn: [] }));
    const createInput = { runId: run.id, stepKey: "create", key: "prepare", params: { target: ".", workId } };
    let creates = 0;
    const create = () => rt.workflowHostOperation(createInput, execution => {
      creates++;
      return copies.prepareWriteTarget(".", session, workId, parent.id, execution);
    });
    const target = await create();
    assert.deepEqual(await create(), target);
    assert.equal(creates, 1);
    if (target.kind !== "worktree") assert.fail("需要真实 Git 副本");
    fs.writeFileSync(path.join(target.path, "source.txt"), "result\n");
    const work: WorkDelegation = { id: workId, parentSessionId: session.id, originTaskId: parent.id,
      subAgentId: "fixture-only", requestKey: "copy", paramsDigest: "copy", canceledAt: null,
      canceledBy: null, cancelReason: null, writeTarget: target, createdAt: new Date().toISOString() };
    rt.store.withTx(() => registerWorkflowStep(rt.store, { runId: run.id, key: "integrate", ordinal: 2, kind: "integrate", params: {}, dependsOn: [] }));
    const integrateInput = { runId: run.id, stepKey: "integrate", key: "apply", params: { workId } };
    let integrations = 0;
    const integrate = () => rt.workflowHostOperation(integrateInput, execution => {
      integrations++;
      return copies.integrate({ work, target, parentSession: session, parentTaskId: parent.id, execution });
    });
    const integrated = await integrate();
    assert.equal(integrated.state, "applied");
    assert.deepEqual(await integrate(), integrated);
    assert.equal(integrations, 1);
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "result\n");
    assert.equal(fs.readFileSync(path.join(target.path, "source.txt"), "utf8"), "result\n");
    const executions = listWorkflowExecutions(rt.store, run.id);
    assert.equal(executions.length, 2);
    for (const execution of executions) {
      const task = rt.store.getTask(execution.taskId)!;
      assert.equal(task.status, "completed");
      assert.equal(task.modelSelection, null);
      assert.deepEqual(task.historyEntryIds, []);
      assert.equal(execution.stopVerified, true);
      assert.equal(rt.store.listToolOpsByTask(task.id).length, 2);
    }
    assert.equal(rt.store.listSessions().length, sessions);
    assert.equal(t.server.calls.length, modelCalls);
    assert.equal(getWorkflowRun(rt.store, run.id)!.attempts, 0);
    assert.ok(getWorkflowRun(rt.store, run.id)!.usedMs > 0);
    assert.equal(rt.store.listAllOccupancy().length, 0);
  } finally { await t.shutdown(); }
});

function holdSourceDirectory(rt: Runtime, session: Session): Task {
  return rt.store.withTx(() => {
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "directory-blocker", input: "占用夹具",
      modelSelection: rt.defaultSelection, submissionDigest: "directory-blocker" }).task;
    rt.store.endTask(task.id, ["queued"], "completed");
    assert.equal(rt.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno,
      sessionId: session.id, taskId: task.id }), true);
    return task;
  });
}

for (const interruption of ["pause", "restart"] as const) {
  test(`宿主操作排队后 ${interruption}，同键恢复原登记且真实写入只有一次`, async () => {
    const t = await startTestRuntime(`workflow-host-queued-${interruption}`, async () => ({ kind: "text", text: "原任务完成" }), { config: { workflowAgent: null }, workDirs: 1 });
    let recovered: Runtime | null = null;
    try {
      let rt = t.runtime;
      const session = await rt.createSession({ projectName: "workflow-host-queued", cwd: t.work[0] });
      const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
      await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
      const modelCalls = t.server.calls.length;
      const sessions = rt.store.listSessions().length;
      const run = seedRun(rt, parent, session);
      rt.store.withTx(() => registerWorkflowStep(rt.store, { runId: run.id, key: "write", ordinal: 1, kind: "integrate", params: {}, dependsOn: [] }));
      const blocker = holdSourceDirectory(rt, session);
      const marker = path.join(session.cwdReal, "effect.txt");
      const copyDir = path.join(t.dirs.root, "copy");
      fs.mkdirSync(copyDir);
      const input = { runId: run.id, stepKey: "write", key: "fixed-write", params: { marker, copyDir } };
      let effects = 0;
      const execute = (execution: Parameters<Runtime["executeWorkCopy"]>[0]["execution"]) => {
        effects++;
        return rt.executeWorkCopy({ parentTaskId: parent.id, execution, workId: "marker", operation: "integrate",
          workspace: session.cwdReal, copyDir, branch: "marker",
          command: `printf 'host effect\\n' >> ${shellQuotePathForTest(marker)}; printf done` });
      };
      const pending = rt.workflowHostOperation(input, execute);
      const rejected = assert.rejects(pending, { code: "run_inactive" });
      const requestId = `workflow-host:${run.id}:${input.key}`;
      await waitFor("宿主操作已排队", () => rt.store.findTaskByRequest(session.id, requestId)?.status === "queued");
      const queued = rt.store.findTaskByRequest(session.id, requestId)!;
      assert.equal(effects, 0);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(rt.store.getOccupancyByDir(session.cwdReal)!.taskId, blocker.id);
      if (interruption === "pause") {
        rt.store.withTx(() => controlWorkflow(rt.store, run.id, "pause", getWorkflowRun(rt.store, run.id)!.version, { action: "pause" }));
        await rejected;
        assert.equal(rt.store.getTask(queued.id)!.status, "queued");
        await rt.resumeQueue(session.id);
        rt.store.withTx(() => controlWorkflow(rt.store, run.id, "resume", getWorkflowRun(rt.store, run.id)!.version, { action: "resume" }));
      } else {
        await rt.stop("test_restart");
        await rejected;
        recovered = await Runtime.start(t.runtime.config);
        rt = recovered;
        assert.equal(rt.store.getTask(queued.id)!.status, "queued");
        assert.equal(getWorkflowExecution(rt.store, queued.id)!.status, "queued");
        assert.equal(rt.store.getTask(queued.id)!.modelSelection, null);
        assert.equal(rt.store.getSession(session.id)!.queuePauseReason, "occupancy_unverified");
        await rt.resumeQueue(session.id);
      }
      const result = await rt.workflowHostOperation(input, execute);
      assert.deepEqual(await rt.workflowHostOperation(input, execute), result);
      assert.equal(result.isError, false);
      assert.equal(effects, 1);
      assert.equal(fs.readFileSync(marker, "utf8"), "host effect\n");
      assert.equal(rt.store.findTaskByRequest(session.id, requestId)!.id, queued.id);
      assert.equal(listWorkflowExecutions(rt.store, run.id).length, 1);
      assert.equal(rt.store.getTask(queued.id)!.status, "completed");
      assert.equal(rt.store.getTask(queued.id)!.modelSelection, null);
      assert.equal(rt.store.listToolOpsByTask(queued.id).filter(op => op.toolName === "worktree_integrate").length, 1);
      assert.equal(rt.store.listSessions().length, sessions);
      assert.equal(t.server.calls.length, modelCalls);
      assert.equal(getWorkflowRun(rt.store, run.id)!.attempts, 0);
    } finally { await recovered?.stop("end"); await t.shutdown(); }
  });
}

test("实际后台进程登记排队宿主操作后崩溃，接管同键仍只产生一次写入", async () => {
  const t = await startTestRuntime("workflow-host-process-restart", async () => ({ kind: "text", text: "原任务完成" }), { config: { workflowAgent: null }, workDirs: 1 });
  let child: ReturnType<typeof spawn> | undefined;
  let recovered: Runtime | undefined;
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "workflow-host-process-restart", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
    await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const run = seedRun(rt, parent, session);
    rt.store.withTx(() => registerWorkflowStep(rt.store, { runId: run.id, key: "write", ordinal: 1, kind: "integrate", params: {}, dependsOn: [] }));
    holdSourceDirectory(rt, session);
    const modelCalls = t.server.calls.length;
    const marker = path.join(session.cwdReal, "effect.txt");
    const copyDir = path.join(t.dirs.root, "copy");
    fs.mkdirSync(copyDir);
    const input = { runId: run.id, stepKey: "write", key: "process-write", params: { marker, copyDir } };
    await rt.stop("prepare_process_fixture");
    const productPath = pathToFileURL(path.resolve("apps/ruukoto/src/product.ts")).href;
    const config = { dataDir: rt.config.dataDir, agentDir: rt.config.agentDir, socketPath: rt.config.socketPath,
      modelProvider: "mock", modelId: "mock-model", execution: { backend: "local" } };
    const program = `
      import { Runtime } from "@ruukoto/runtime/runtime.ts";
      import { product } from ${JSON.stringify(productPath)};
      const runtime = await Runtime.start({ product: product.runtime, workflowAgent: null, ...${JSON.stringify(config)} });
      const input = ${JSON.stringify(input)};
      const pending = runtime.workflowHostOperation(input, async () => { throw new Error("queued operation executed unexpectedly"); });
      const task = runtime.store.findTaskByRequest(${JSON.stringify(session.id)}, "workflow-host:" + input.runId + ":" + input.key);
      process.stdout.write(JSON.stringify({ taskId: task.id, status: task.status }) + "\\n");
      await pending;
    `;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], { stdio: ["ignore", "pipe", "pipe"] });
    const output = createInterface({ input: child.stdout! });
    const exit = new Promise<void>(resolve => child!.once("exit", () => resolve()));
    const queued = await new Promise<{ taskId: string; status: string }>((resolve, reject) => {
      output.once("line", line => { resolve(JSON.parse(line) as { taskId: string; status: string }); });
      child!.once("error", reject);
      child!.once("exit", () => reject(new Error("后台未登记宿主排队操作")));
      setTimeout(() => reject(new Error("后台排队登记超时")), 10_000).unref();
    });
    assert.equal(queued.status, "queued");
    assert.equal(fs.existsSync(marker), false);
    child.kill("SIGKILL");
    await exit;
    output.close();
    recovered = await Runtime.start(rt.config);
    assert.equal(recovered.store.getTask(queued.taskId)!.status, "queued");
    assert.equal(getWorkflowExecution(recovered.store, queued.taskId)!.status, "queued");
    await recovered.resumeQueue(session.id);
    let effects = 0;
    const resumed = recovered;
    const execute = (execution: Parameters<Runtime["executeWorkCopy"]>[0]["execution"]) => {
      effects++;
      return resumed.executeWorkCopy({ parentTaskId: parent.id, execution, workId: "marker", operation: "integrate",
        workspace: session.cwdReal, copyDir, branch: "marker",
        command: `printf 'host effect\\n' >> ${shellQuotePathForTest(marker)}; printf done` });
    };
    const result = await recovered.workflowHostOperation(input, execute);
    assert.deepEqual(await recovered.workflowHostOperation(input, execute), result);
    assert.equal(effects, 1);
    assert.equal(fs.readFileSync(marker, "utf8"), "host effect\n");
    assert.equal(listWorkflowExecutions(recovered.store, run.id).length, 1);
    assert.equal(recovered.store.findTaskByRequest(session.id, `workflow-host:${run.id}:${input.key}`)!.id, queued.taskId);
    assert.equal(getWorkflowRun(recovered.store, run.id)!.attempts, 0);
    assert.equal(t.server.calls.length, modelCalls);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>(resolve => child!.once("exit", () => resolve()));
    }
    await recovered?.stop("end");
    await t.shutdown();
  }
});
