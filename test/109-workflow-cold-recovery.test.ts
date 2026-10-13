import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { killProcessGroup, type ManagedEntry } from "@ruukoto/agent/managed-processes.ts";
import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { createWorkflowRun, getWorkflowRun, getWorkflowStep, listWorkflowExecutions, saveWorkflowDefinition, workflowDigest, type WorkflowRun } from "@ruukoto/core/workflow.ts";
import { randomId, type Session, type Task } from "@ruukoto/core/types.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { shellQuotePathForTest } from "./helpers/git-fixture.ts";
import { startTestRuntime, waitFor } from "./helpers/testkit.ts";

type UnitIdentity = Pick<ManagedEntry, "kind" | "id" | "label">;
interface ColdSnapshot { taskId: string; scriptUnits: UnitIdentity[]; units: UnitIdentity[] }
interface ColdProcess { child: ChildProcess; snapshot: Promise<ColdSnapshot>; exit: Promise<void> }

function seedRun(rt: Runtime, parent: Task, session: Session, script: string): WorkflowRun {
  return rt.store.withTx(() => {
    const definition = saveWorkflowDefinition(rt.store, script);
    return createWorkflowRun(rt.store, {
      id: randomId("wfrun"), requestKey: "cold-run", paramsDigest: workflowDigest({ script }), definitionId: definition.id,
      scriptDigest: definition.digest, input: null, inputDigest: workflowDigest(null),
      source: { product: "ruukoto", projectId: session.projectId, sessionId: session.id, taskId: parent.id,
        permissionVersion: parent.permissionVersion, accessMode: parent.accessMode, grantedPaths: [], capabilities: [],
        references: [], replyTarget: null, scheduledRunId: null },
      modelSelection: rt.defaultSelection, status: "queued", version: 1, reason: null, attempts: 0, maxAttempts: 100,
      durationMs: 3_600_000, usedMs: 0, clockStartedAt: null, clockVerified: true, scriptUnits: [], scriptStopVerified: null,
      result: null, resultRecorded: false, createdAt: new Date().toISOString(), endedAt: null,
    });
  });
}

function launchColdProcess(rt: Runtime, body: string): ColdProcess {
  const productPath = pathToFileURL(path.resolve("apps/ruukoto/src/product.ts")).href;
  const config = { dataDir: rt.config.dataDir, agentDir: rt.config.agentDir, socketPath: rt.config.socketPath,
    modelProvider: "mock", modelId: "mock-model", execution: { backend: "local" } };
  const program = `
    import { Runtime } from "@ruukoto/runtime/runtime.ts";
    import { getWorkflowRun, listWorkflowExecutions } from "@ruukoto/core/workflow.ts";
    import { randomId } from "@ruukoto/core/types.ts";
    import { ToolWorkerHost } from "@ruukoto/agent/tool-worker/host.ts";
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { product } from ${JSON.stringify(productPath)};
    const config = { product: product.runtime, ...${JSON.stringify(config)} };
    let runtime;
    let available;
    const runtimeReady = new Promise(resolve => { available = resolve; });
    ${body}
    available();
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const snapshot = new Promise<ColdSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`后台未到达崩溃窗口：${stderr}`)), 10_000);
    child.once("message", value => { clearTimeout(timer); resolve(value as ColdSnapshot); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`后台在崩溃窗口前退出：${stderr}`)); });
  });
  return { child, snapshot, exit };
}

async function killBackend(process: ColdProcess | undefined): Promise<void> {
  if (!process) return;
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL");
  await process.exit;
}

async function verifyUnitsStopped(units: UnitIdentity[]): Promise<void> {
  for (const id of new Set(units.filter(unit => unit.kind === "process_group").map(unit => unit.id))) {
    assert.equal(await killProcessGroup(Number(id), { termGraceMs: 100, killGraceMs: 1000 }), true, `执行单元 ${id} 须核实停止`);
  }
}

test("宿主结果已提交但步骤未收尾时真实崩溃，核实后脚本复用同键缓存，不重复写入", async () => {
  const t = await startTestRuntime("workflow-cold-host", async () => ({ kind: "text", text: "原任务完成" }), { config: { workflowAgent: null }, workDirs: 1 });
  let cold: ColdProcess | undefined;
  let identities: UnitIdentity[] = [];
  let recovered: Runtime | undefined;
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "workflow-cold-host", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
    await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const run = seedRun(rt, parent, session, `return await integrate("merge", {});`);
    const sessions = rt.store.listSessions().length;
    const modelCalls = t.server.calls.length;
    const marker = path.join(session.cwdReal, "effect.txt");
    const copyDir = path.join(t.dirs.root, "copy");
    fs.mkdirSync(copyDir);
    const command = `printf 'host effect\\n' >> ${shellQuotePathForTest(marker)}; printf done`;
    await rt.stop("prepare_cold_host");
    cold = launchColdProcess(rt, `
      runtime = await Runtime.start({ ...config, workflowAgent: async () => ({ output: "unused" }),
        workflowIntegrate: async ({ run, step }) => {
          await runtimeReady;
          await runtime.workflowHostOperation({ runId: run.id, stepKey: step.key, key: "apply", params: {} }, execution => runtime.executeWorkCopy({
            parentTaskId: run.source.taskId, execution, workId: "cold-copy", operation: "integrate",
            workspace: ${JSON.stringify(session.cwdReal)}, copyDir: ${JSON.stringify(copyDir)}, branch: "cold-copy", command: ${JSON.stringify(command)}
          }));
          const execution = listWorkflowExecutions(runtime.store, run.id).find(execution => execution.kind === "host");
          process.send({ taskId: execution.taskId, scriptUnits: getWorkflowRun(runtime.store, run.id).scriptUnits, units: execution.units });
          await new Promise(() => {});
        }
      });
    `);
    const snapshot = await cold.snapshot;
    identities = [...snapshot.scriptUnits, ...snapshot.units];
    assert.ok(snapshot.scriptUnits.some(unit => unit.kind === "process_group"));
    assert.equal(fs.readFileSync(marker, "utf8"), "host effect\n");
    await killBackend(cold);
    await verifyUnitsStopped(identities);
    identities = [];
    let available!: () => void;
    const runtimeReady = new Promise<void>(resolve => { available = resolve; });
    let effects = 0;
    let callbacks = 0;
    recovered = await Runtime.start({ ...rt.config, workflowAgent: async () => ({ output: "unused" }),
      workflowIntegrate: async ({ run, step }) => {
        await runtimeReady;
        callbacks++;
        return recovered!.workflowHostOperation({ runId: run.id, stepKey: step.key, key: "apply", params: {} }, execution => {
          effects++;
          return recovered!.executeWorkCopy({ parentTaskId: run.source.taskId, execution, workId: "cold-copy", operation: "integrate",
            workspace: session.cwdReal, copyDir, branch: "cold-copy", command });
        });
      }
    });
    available();
    const paused = getWorkflowRun(recovered.store, run.id)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "clock_unverified");
    assert.equal(getWorkflowStep(recovered.store, run.id, "merge")!.resultRecorded, false);
    assert.equal(getWorkflowStep(recovered.store, run.id, "merge")!.status, "queued");
    const task = recovered.store.getTask(snapshot.taskId)!;
    assert.equal(task.status, "completed");
    assert.notEqual(task.resultSummary, null);
    assert.equal(listWorkflowExecutions(recovered.store, run.id)[0].stopVerified, true);
    await recovered.workflows!.control(run.id, "resume", paused.version, { action: "resume", stopsConfirmed: true, clockConfirmed: true });
    await waitFor("缓存结果收尾成功", () => getWorkflowRun(recovered!.store, run.id)!.status === "succeeded");
    assert.equal(callbacks, 1);
    assert.equal(effects, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), "host effect\n");
    assert.equal(listWorkflowExecutions(recovered.store, run.id).length, 1);
    assert.equal(listWorkflowExecutions(recovered.store, run.id)[0].taskId, snapshot.taskId);
    assert.equal(recovered.store.getTask(parent.id)!.status, "completed");
    assert.equal(recovered.store.getTask(snapshot.taskId)!.modelSelection, null);
    assert.deepEqual(recovered.store.getTask(snapshot.taskId)!.historyEntryIds, []);
    assert.equal(recovered.store.listSessions().length, sessions);
    assert.equal(t.server.calls.length, modelCalls);
    assert.equal(getWorkflowRun(recovered.store, run.id)!.attempts, 0);
    assert.equal(getWorkflowStep(recovered.store, run.id, "merge")!.status, "completed");
    assert.equal(getWorkflowStep(recovered.store, run.id, "merge")!.delivery, 1);
  } finally {
    await killBackend(cold);
    await verifyUnitsStopped(identities);
    await recovered?.stop("end");
    await t.shutdown();
  }
});

test("只读 Agent 真实崩溃后先核实占用与脚本，再恢复为一次新的执行尝试", async () => {
  const t = await startTestRuntime("workflow-cold-read", async () => ({ kind: "text", text: "原任务完成" }), { config: { workflowAgent: null }, workDirs: 1 });
  let cold: ColdProcess | undefined;
  let identities: UnitIdentity[] = [];
  let recovered: Runtime | undefined;
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "workflow-cold-read", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
    await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const run = seedRun(rt, parent, session, `return await agent("analysis", { request: "读取输入" });`);
    const modelCalls = t.server.calls.length;
    await rt.stop("prepare_cold_read");
    cold = launchColdProcess(rt, `
      runtime = await Runtime.start({ ...config, workflowAgent: async ({ run, task, register }) => {
        await runtimeReady;
        const session = runtime.store.getSession(task.sessionId);
        fs.writeFileSync(path.join(session.cwdReal, "analysis.txt"), "source input\\n");
        const host = await ToolWorkerHost.start(runtime.launcherFor(task.accessMode), { taskId: task.id,
          mode: task.accessMode, workspace: session.cwdReal, grantedPaths: [],
          workspaceIdentity: { dev: session.cwdDev, ino: session.cwdIno } });
        register({ ...host.identity(), stop: () => host.stop() });
        const opId = randomId("op");
        runtime.store.withTx(() => runtime.store.recordToolIntent({ id: opId, taskId: task.id, sessionId: task.sessionId,
          toolName: "read", params: { path: "analysis.txt" } }));
        await host.call({ opId, sdkCallId: randomId("call"), name: "read", params: { path: "analysis.txt" } });
        const execution = listWorkflowExecutions(runtime.store, run.id).find(execution => execution.taskId === task.id);
        process.send({ taskId: task.id, scriptUnits: getWorkflowRun(runtime.store, run.id).scriptUnits, units: execution.units });
        await new Promise(() => {});
      } });
    `);
    const snapshot = await cold.snapshot;
    identities = [...snapshot.scriptUnits, ...snapshot.units];
    assert.ok(snapshot.units.some(unit => unit.kind === "process_group"));
    await killBackend(cold);
    await verifyUnitsStopped(identities);
    identities = [];
    let available!: () => void;
    const runtimeReady = new Promise<void>(resolve => { available = resolve; });
    let attempts = 0;
    recovered = await Runtime.start({ ...rt.config, workflowAgent: async ({ task, register }) => {
      await runtimeReady;
      attempts++;
      const current = recovered!;
      const session = current.store.getSession(task.sessionId)!;
      fs.writeFileSync(path.join(session.cwdReal, "analysis.txt"), "source input\n");
      const host = await ToolWorkerHost.start(current.launcherFor(task.accessMode), { taskId: task.id,
        mode: task.accessMode, workspace: session.cwdReal, grantedPaths: [], workspaceIdentity: { dev: session.cwdDev, ino: session.cwdIno } });
      register({ ...host.identity()!, stop: () => host.stop() });
      const opId = randomId("op");
      current.store.withTx(() => current.store.recordToolIntent({ id: opId, taskId: task.id, sessionId: task.sessionId,
        toolName: "read", params: { path: "analysis.txt" } }));
      const reply = await host.call({ opId, sdkCallId: randomId("call"), name: "read", params: { path: "analysis.txt" } });
      assert.equal(reply.isError, false);
      current.store.withTx(() => new ToolOpLedger(current.store).recordResult(task, opId, "source input", false));
      return { output: "analysis done" };
    } });
    available();
    const old = recovered.store.getTask(snapshot.taskId)!;
    assert.equal(old.status, "interrupted");
    assert.equal(old.effectUnknown, false);
    assert.equal(getWorkflowRun(recovered.store, run.id)!.status, "paused");
    assert.equal(recovered.store.getOccupancyByDir(recovered.store.getSession(old.sessionId)!.cwdReal)!.taskId, old.id);
    assert.equal(attempts, 0);
    await recovered.resumeQueue(old.sessionId);
    const paused = getWorkflowRun(recovered.store, run.id)!;
    await recovered.workflows!.control(run.id, "resume", paused.version, { action: "resume", clockConfirmed: true, stopsConfirmed: true });
    await waitFor("只读步骤恢复完成", () => getWorkflowRun(recovered!.store, run.id)!.status === "succeeded");
    const executions = listWorkflowExecutions(recovered.store, run.id);
    assert.equal(executions.length, 2);
    assert.equal(executions[0].taskId, old.id);
    assert.notEqual(executions[1].taskId, old.id);
    assert.equal(getWorkflowRun(recovered.store, run.id)!.attempts, 2);
    assert.equal(attempts, 1);
    assert.equal(recovered.store.getTask(old.id)!.status, "interrupted");
    assert.equal(recovered.store.getTask(parent.id)!.status, "completed");
    for (const execution of executions) assert.equal(recovered.store.getSession(recovered.store.getTask(execution.taskId)!.sessionId)!.sessionFile, null);
    assert.equal(t.server.calls.length, modelCalls);
  } finally {
    await killBackend(cold);
    await verifyUnitsStopped(identities);
    await recovered?.stop("end");
    await t.shutdown();
  }
});

test("协调器登记宿主排队操作后真实崩溃，释放旧占用并核实后同任务只执行一次", async () => {
  const t = await startTestRuntime("workflow-cold-queued-host", async () => ({ kind: "text", text: "原任务完成" }), { config: { workflowAgent: null }, workDirs: 1 });
  let cold: ColdProcess | undefined;
  let identities: UnitIdentity[] = [];
  let recovered: Runtime | undefined;
  try {
    const rt = t.runtime;
    const session = await rt.createSession({ projectName: "workflow-cold-queued-host", cwd: t.work[0] });
    const parent = await rt.submit({ sessionId: session.id, requestId: "origin", input: "原任务", modelSelection: rt.defaultSelection });
    await waitFor("原任务完成", () => rt.store.getTask(parent.id)!.status === "completed");
    const run = seedRun(rt, parent, session, `return await integrate("merge", {});`);
    const blocker = rt.store.withTx(() => {
      const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "blocker", input: "遗留占用夹具",
        modelSelection: rt.defaultSelection, submissionDigest: "blocker" }).task;
      rt.store.endTask(task.id, ["queued"], "completed");
      assert.equal(rt.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno,
        sessionId: session.id, taskId: task.id }), true);
      return task;
    });
    const sessions = rt.store.listSessions().length;
    const modelCalls = t.server.calls.length;
    const marker = path.join(session.cwdReal, "effect.txt");
    const copyDir = path.join(t.dirs.root, "copy");
    fs.mkdirSync(copyDir);
    const command = `printf 'host effect\\n' >> ${shellQuotePathForTest(marker)}; printf done`;
    await rt.stop("prepare_cold_queued_host");
    cold = launchColdProcess(rt, `
      runtime = await Runtime.start({ ...config, workflowAgent: async () => ({ output: "unused" }),
        workflowIntegrate: async ({ run, step }) => {
          await runtimeReady;
          const pending = runtime.workflowHostOperation({ runId: run.id, stepKey: step.key, key: "apply", params: {} }, execution => runtime.executeWorkCopy({
            parentTaskId: run.source.taskId, execution, workId: "cold-copy", operation: "integrate",
            workspace: ${JSON.stringify(session.cwdReal)}, copyDir: ${JSON.stringify(copyDir)}, branch: "cold-copy", command: ${JSON.stringify(command)}
          }));
          const execution = listWorkflowExecutions(runtime.store, run.id).find(execution => execution.kind === "host");
          process.send({ taskId: execution.taskId, scriptUnits: getWorkflowRun(runtime.store, run.id).scriptUnits, units: execution.units });
          return await pending;
        }
      });
    `);
    const snapshot = await cold.snapshot;
    identities = snapshot.scriptUnits;
    assert.ok(identities.some(unit => unit.kind === "process_group"));
    assert.deepEqual(snapshot.units, []);
    assert.equal(fs.existsSync(marker), false);
    await killBackend(cold);
    await verifyUnitsStopped(identities);
    identities = [];
    let available!: () => void;
    const runtimeReady = new Promise<void>(resolve => { available = resolve; });
    let effects = 0;
    recovered = await Runtime.start({ ...rt.config, workflowAgent: async () => ({ output: "unused" }),
      workflowIntegrate: async ({ run, step }) => {
        await runtimeReady;
        return recovered!.workflowHostOperation({ runId: run.id, stepKey: step.key, key: "apply", params: {} }, execution => {
          effects++;
          return recovered!.executeWorkCopy({ parentTaskId: run.source.taskId, execution, workId: "cold-copy", operation: "integrate",
            workspace: session.cwdReal, copyDir, branch: "cold-copy", command });
        });
      }
    });
    available();
    const paused = getWorkflowRun(recovered.store, run.id)!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "clock_unverified");
    assert.equal(getWorkflowStep(recovered.store, run.id, "merge")!.status, "queued");
    assert.equal(recovered.store.getTask(snapshot.taskId)!.status, "queued");
    assert.equal(recovered.store.listToolOpsByTask(snapshot.taskId).length, 0);
    assert.equal(recovered.store.getOccupancyByDir(session.cwdReal)!.taskId, blocker.id);
    assert.equal(effects, 0);
    await recovered.resumeQueue(session.id);
    await recovered.workflows!.control(run.id, "resume", paused.version, { action: "resume", clockConfirmed: true, stopsConfirmed: true });
    await waitFor("原排队宿主操作收尾成功", () => getWorkflowRun(recovered!.store, run.id)!.status === "succeeded");
    assert.equal(effects, 1);
    assert.equal(fs.readFileSync(marker, "utf8"), "host effect\n");
    const executions = listWorkflowExecutions(recovered.store, run.id);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].taskId, snapshot.taskId);
    assert.equal(executions[0].stopVerified, true);
    assert.equal(recovered.store.getTask(snapshot.taskId)!.status, "completed");
    assert.equal(recovered.store.getTask(snapshot.taskId)!.modelSelection, null);
    assert.equal(recovered.store.getTask(parent.id)!.status, "completed");
    assert.equal(recovered.store.getTaskEventsAfter(snapshot.taskId, 0, 100).filter(event => event.body.type === "task.started").length, 1);
    assert.equal(recovered.store.listSessions().length, sessions);
    assert.equal(t.server.calls.length, modelCalls);
    assert.equal(getWorkflowRun(recovered.store, run.id)!.attempts, 0);
    assert.equal(recovered.store.listAllOccupancy().length, 0);
  } finally {
    await killBackend(cold);
    await verifyUnitsStopped(identities);
    await recovered?.stop("end");
    await t.shutdown();
  }
});
