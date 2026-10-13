/** 持久工作流协调器：脚本只登记步骤，实际执行、计费、重放和停止归宿主。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import { WorkflowScriptHost } from "@ruukoto/agent/script-worker/host.ts";
import { isRecord, ScriptExecutionError, type ScriptCall } from "@ruukoto/agent/script-worker/protocol.ts";
import { compileWorkflowOutput } from "@ruukoto/agent/workflow-output.ts";
import { ToolOpLedger } from "@ruukoto/agent/tool-op-ledger.ts";
import { WorkCopyError } from "./work-copy.ts";
import { createManagedProcessRegistry, type ManagedEntry, type ManagedProcessRegistry } from "@ruukoto/agent/managed-processes.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { randomId, isTerminalTaskStatus, type ModelSelection, type PersistentEvent, type Task } from "@ruukoto/core/types.ts";
import {
  WORKFLOW_LIMITS, WorkflowError, bindWorkflowExecution, chargeWorkflow, controlWorkflow, createWorkflowRun,
  deliverWorkflowStep, findWorkflowRun, finishWorkflowStep, getWorkflowDefinition, getWorkflowExecution, getWorkflowQuestion,
  getWorkflowStep, hasWorkflowControl, listWorkflowExecutions, listWorkflowRuns, listWorkflowSteps, recoverWorkflowRuns, registerWorkflowStep,
  requireWorkflowRun, saveWorkflowDefinition, saveWorkflowQuestion, setWorkflowState, startWorkflowExecution,
  updateWorkflowExecution, updateWorkflowRun, updateWorkflowStep, workflowDigest, workflowJson, workflowTerminal,
  type WorkflowControl, type WorkflowExecution, type WorkflowQuestion, type WorkflowRun, type WorkflowSource, type WorkflowStep,
} from "@ruukoto/core/workflow.ts";

export interface WorkflowAgentContext {
  run: WorkflowRun;
  step: WorkflowStep;
  task: Task;
  signal: AbortSignal;
  /** 启动实际单元前登记起始句柄；stop 须等待启动收尾，实际身份沿该句柄更新。 */
  register(entry: ManagedEntry): void;
  /** 更新已登记句柄；取消后也必须保存实际身份，不能登记新单元。 */
  updateIdentity(entry: ManagedEntry): void;
}
/** 仅宿主注入；所有实际工具效果须使用 task 的既有操作账本。 */
export type WorkflowAgentExecutor = (context: WorkflowAgentContext) => Promise<{ output: string; isError?: boolean }>;
export interface WorkflowDeps {
  store: Store;
  ledger?: ToolOpLedger;
  workRoot: string;
  source(taskId: string): WorkflowSource;
  selection(taskId: string): ModelSelection;
  verifySource(source: WorkflowSource): boolean;
  agent?: WorkflowAgentExecutor;
  verifyResultSources?: (run: WorkflowRun, step: WorkflowStep) => boolean;
  integrate?: (context: { run: WorkflowRun; step: WorkflowStep; signal: AbortSignal }) => Promise<unknown>;
  stopHost?: (taskId: string, reason: string) => Promise<unknown>;
  script?: (label: string) => WorkflowScriptHost;
  now?: () => number;
  onReleased?: () => void;
}
interface ScriptRun {
  host: WorkflowScriptHost;
  promise: Promise<void>;
  replies: Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>;
  delivered: Set<string>;
  replayDeliveries: string[];
  stopping: boolean;
  idle: boolean;
  controller: AbortController;
  integrations: Map<string, Promise<void>>;
}
interface AgentJob {
  controller: AbortController;
  registry: ManagedProcessRegistry;
  promise: Promise<void>;
  stop?: Promise<boolean>;
}
export interface WorkflowStart {
  sourceTaskId: string;
  requestKey: string;
  script: string;
  input: unknown;
  maxAttempts?: number;
  durationMs?: number;
  /** 宿主入口的原始请求摘要；命名文件后来更新不改变原键语义。 */
  requestDigest?: string;
}

export class WorkflowCoordinator {
  private readonly scripts = new Map<string, ScriptRun>();
  private readonly jobs = new Map<string, AgentJob>();
  private readonly flushPending = new Set<string>();
  private readonly hostSteps = new Set<Promise<void>>();
  private readonly ledger: ToolOpLedger;
  private readonly artifacts: ArtifactStore;
  private timer: ReturnType<typeof setInterval> | undefined;
  private queued = false;
  private stopped = false;
  private readonly now: () => number;
  constructor(private readonly deps: WorkflowDeps) {
    this.ledger = deps.ledger ?? new ToolOpLedger(deps.store);
    this.artifacts = new ArtifactStore(path.dirname(deps.store.db.file), deps.store);
    this.now = deps.now ?? Date.now;
  }
  private get store(): Store { return this.deps.store; }

  /** 已认证任务仅提供入口身份；固定快照不随发起任务结束或会话默认模式变化。 */
  start(input: WorkflowStart): WorkflowRun {
    const run = this.store.withTx(() => this.register(input));
    this.kick();
    return run;
  }

  /** 仅可信宿主在 Store.withTx 内调用；来源任务、运行与入口回执可同事务登记。 */
  register(input: WorkflowStart, sourceForTask = this.deps.source): WorkflowRun {
    const task = this.store.getTask(input.sourceTaskId);
    if (!task) throw new WorkflowError("source_missing");
    const maxAttempts = input.maxAttempts ?? WORKFLOW_LIMITS.attempts;
    const durationMs = input.durationMs ?? WORKFLOW_LIMITS.durationMs;
    const paramsDigest = input.requestDigest ?? workflowDigest({ script: input.script, input: input.input, maxAttempts, durationMs });
    const old = findWorkflowRun(this.store, task.sessionId, input.requestKey);
    if (old) {
      if (old.paramsDigest !== paramsDigest) throw new WorkflowError("request_conflict");
      return old;
    }
    if (this.stopped || !input.requestKey || !Number.isInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > WORKFLOW_LIMITS.attempts ||
        !Number.isInteger(durationMs) || durationMs <= 0 || durationMs > WORKFLOW_LIMITS.durationMs) throw new WorkflowError("invalid_budget");
    const source = sourceForTask(task.id);
    const modelSelection = this.deps.selection(task.id);
    const currentSource = sourceForTask(task.id);
    if (workflowDigest(currentSource) !== workflowDigest(source)) throw new WorkflowError("source_invalid");
    const definition = saveWorkflowDefinition(this.store, input.script);
    return createWorkflowRun(this.store, { id: randomId("wfrun"), requestKey: input.requestKey, paramsDigest, definitionId: definition.id,
        scriptDigest: definition.digest, input: JSON.parse(workflowJson(input.input)), inputDigest: workflowDigest(input.input), source,
        modelSelection, status: "queued", version: 1, reason: null, attempts: 0, maxAttempts, durationMs, usedMs: 0, clockStartedAt: null, clockVerified: true,
        scriptUnits: [], scriptStopVerified: null, result: null, resultRecorded: false, createdAt: new Date(this.now()).toISOString(), endedAt: null });
  }

  /** Runtime 已按既有账本收尾任务后调用；恢复从未执行的排队登记。 */
  recover(): void {
    this.store.withTx(() => {
      recoverWorkflowRuns(this.store, this.now());
      for (const run of listWorkflowRuns(this.store)) {
        for (const step of listWorkflowSteps(this.store, run.id)) {
          if (!this.verifyOutputArtifact(step) && !workflowTerminal(run.status)) setWorkflowState(this.store, run.id, "paused", "result_missing", this.now());
        }
        for (const execution of listWorkflowExecutions(this.store, run.id)) {
          const step = getWorkflowStep(this.store, run.id, execution.stepKey);
          const task = this.store.getTask(execution.taskId);
          if (!step || !task) { if (!workflowTerminal(run.status)) setWorkflowState(this.store, run.id, "paused", "result_missing", this.now()); continue; }
          if (execution.kind === "agent" && isTerminalTaskStatus(task.status) && task.resultSummary === null) this.store.setTaskResult(task.id, step.rawOutput ?? `执行已${task.status}，最终输出缺失；保留操作账本供核实`,
            JSON.stringify({ workflowRunId: run.id, stepKey: step.key, taskId: task.id, resultMissing: !step.resultRecorded }));
          if (execution.status === "queued" && task.status === "queued") {
            if (step.kind === "integrate" && this.reusableIntegration(run.id, step.key)) updateWorkflowStep(this.store, { ...step, status: "queued" });
            continue;
          }
          const hostResult = execution.kind === "host" && task.status === "completed" && task.resultSummary !== null && execution.stopVerified === true;
          const reason = this.unsafeReason(task, step.resultRecorded || hostResult);
          if (reason && !workflowTerminal(run.status)) setWorkflowState(this.store, run.id, "paused", reason, this.now());
          if (isTerminalTaskStatus(task.status) && execution.stopVerified === true && !step.resultRecorded && !reason && execution.kind === "agent") {
            if (step.attempts <= WORKFLOW_LIMITS.retries) updateWorkflowStep(this.store, { ...getWorkflowStep(this.store, run.id, step.key)!, status: "queued" });
            else finishWorkflowStep(this.store, run.id, step.key, "failed", { status: "failed", code: "retry_limit" });
          }
          if (step.kind === "integrate" && !step.resultRecorded && this.reusableIntegration(run.id, step.key)) updateWorkflowStep(this.store, { ...getWorkflowStep(this.store, run.id, step.key)!, status: "queued" });
        }
      }
    });
    this.timer ??= setInterval(() => this.kick(), 50);
    this.timer.unref();
    this.kick();
  }

  onEvents(events: PersistentEvent[]): void {
    if (events.some(event => event.body.type.startsWith("task.") || event.body.type.startsWith("workflow.") || event.body.type.startsWith("confirmation.") || event.body.type === "session.queue_resumed")) this.kick();
  }
  kick(): void {
    if (this.queued || this.stopped) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.stopped) return;
      try { this.pump(); }
      catch (error) { process.stderr.write(`[ruukoto:workflow] 调度失败：${error instanceof WorkflowError ? error.code : "store_failed"}；运行记录保留\n`); }
    });
  }

  private pump(): void {
    for (const snapshot of listWorkflowRuns(this.store)) {
      if (workflowTerminal(snapshot.status)) continue;
      if (snapshot.status === "paused") { void this.stopRun(snapshot.id, snapshot.reason ?? "paused"); continue; }
      if (!this.deps.verifySource(snapshot.source)) { this.pause(snapshot.id, "source_invalid"); continue; }
      if (chargeWorkflow(snapshot, this.now()).usedMs >= snapshot.durationMs) { this.pause(snapshot.id, "duration_limit"); continue; }
      if (!this.scripts.has(snapshot.id)) this.launch(snapshot.id);
      let run = requireWorkflowRun(this.store, snapshot.id);
      for (const step of listWorkflowSteps(this.store, run.id)) {
        if (step.resultRecorded || step.status !== "queued") continue;
        if (!this.scripts.get(run.id)?.replies.has(step.key)) continue;
        const deps = step.dependsOn.map(key => getWorkflowStep(this.store, run.id, key));
        if (deps.some(item => !item)) { this.pause(run.id, "replay_diverged"); break; }
        if (deps.some(item => item!.resultRecorded && item!.status !== "completed")) {
          this.store.withTx(() => finishWorkflowStep(this.store, run.id, step.key, "skipped", { status: "skipped", code: "dependency_failed" }));
          continue;
        }
        if (deps.some(item => !item!.resultRecorded)) continue;
        if (step.kind !== "agent") { this.dispatchHostStep(run, step); continue; }
        if (!this.deps.agent) { this.pause(run.id, "agent_unavailable"); break; }
        const old = listWorkflowExecutions(this.store, run.id).filter(item => item.kind === "agent" && item.stepKey === step.key).at(-1);
        let execution: WorkflowExecution;
        try { execution = old?.status === "queued" ? old : this.prepareAgent(run, step); }
        catch (error) { this.pause(run.id, error instanceof WorkflowError ? error.code : "step_preparation_failed"); break; }
        if (this.jobs.has(execution.taskId)) continue;
        const task = this.store.getTask(execution.taskId)!;
        const session = this.store.getSession(task.sessionId)!;
        const started = this.store.withTx(() => {
          if (!this.deps.verifySource(run.source)) { setWorkflowState(this.store, run.id, "paused", "source_invalid", this.now()); return false; }
          if (!startWorkflowExecution(this.store, task.id, this.now())) return false;
          if (!this.store.tryAcquireOccupancy({ cwdReal: session.cwdReal, cwdDev: session.cwdDev, cwdIno: session.cwdIno, sessionId: session.id, taskId: task.id })) throw new WorkflowError("occupancy_conflict");
          if (!this.store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date(this.now()).toISOString() })) throw new WorkflowError("task_ending");
          const current = getWorkflowStep(this.store, run.id, step.key)!;
          updateWorkflowStep(this.store, { ...current, status: "running", attempts: current.attempts + 1 });
          this.store.appendEvent({ type: "task.started", taskId: task.id, sessionId: session.id }, { taskId: task.id, sessionId: session.id });
          return true;
        });
        if (started) this.runAgent(execution);
        run = requireWorkflowRun(this.store, run.id);
        if (run.status === "paused") { void this.stopRun(run.id, run.reason ?? "paused"); break; }
      }
      this.flush(run.id);
      this.updateWaiting(run.id);
    }
  }

  private prepareAgent(run: WorkflowRun, step: WorkflowStep): WorkflowExecution {
    const input = workflowJson({ params: step.params, sourceWorkspace: run.source.authority?.workspace.path ?? null,
      sourceReferences: run.source.references, dependsOn: step.dependsOn.map(key => getWorkflowStep(this.store, run.id, key)?.result) });
    const id = randomId("sagent");
    const workId = randomId("work");
    const directory = path.join(this.deps.workRoot, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const real = fs.realpathSync(directory);
    const stat = fs.statSync(real);
    return this.store.withTx(() => {
      const session = this.store.createSession({ projectId: run.source.projectId, cwd: real, cwdReal: real, cwdDev: stat.dev, cwdIno: stat.ino,
        piSessionId: randomUUID(), confirmTools: [], modelSelection: run.modelSelection });
      this.store.insertSubAgent({ id, parentSessionId: run.source.sessionId, sessionId: session.id, workDir: real,
        activeWorkId: workId, currentTaskId: null, state: "running", closedAt: null, closedBy: null, createdAt: new Date(this.now()).toISOString() });
      this.store.insertWorkDelegation({ id: workId, parentSessionId: run.source.sessionId, originTaskId: run.source.taskId, subAgentId: id,
        requestKey: `workflow:${run.id}:${step.key}:${step.attempts + 1}`, paramsDigest: step.digest, canceledAt: null, canceledBy: null, cancelReason: null,
        writeTarget: null, createdAt: new Date(this.now()).toISOString() });
      const task = this.store.insertQueuedTask({ sessionId: session.id, requestId: `workflow:${run.id}:${step.key}:${step.attempts + 1}`,
        input,
        accessMode: run.source.accessMode, grantedPaths: run.source.grantedPaths, modelSelection: run.modelSelection, submissionDigest: step.digest,
        parentTaskId: run.source.taskId, sourcePermissionVersion: run.source.permissionVersion, workId, subAgentId: id,
        readScope: { paths: run.source.authority ? [{ ...run.source.authority.workspace, purpose: "工作流来源工作区只读资料" }] : [], sourceRefs: run.source.references } }).task;
      this.store.setSubAgentState(id, "running", { activeWorkId: workId, currentTaskId: task.id });
      const execution: WorkflowExecution = { id: randomId("wfexec"), runId: run.id, stepKey: step.key, kind: "agent", taskId: task.id,
        number: step.attempts + 1, status: "queued", units: [], stopVerified: null };
      bindWorkflowExecution(this.store, execution);
      this.store.appendEvent({ type: "work_delegation.created", workId, parentSessionId: run.source.sessionId, subAgentId: id, agentSessionId: session.id, taskId: task.id }, { taskId: task.id, sessionId: run.source.sessionId });
      return execution;
    });
  }

  private launch(id: string): void {
    const snapshot = requireWorkflowRun(this.store, id);
    const definition = getWorkflowDefinition(this.store, snapshot.definitionId);
    if (!definition || definition.digest !== snapshot.scriptDigest || workflowDigest(definition.script) !== snapshot.scriptDigest || workflowDigest(snapshot.input) !== snapshot.inputDigest) {
      this.pause(id, "definition_missing"); return;
    }
    const host = this.deps.script?.(`workflow:${id}`) ?? new WorkflowScriptHost(`workflow:${id}`);
    const state: ScriptRun = { host, promise: Promise.resolve(), replies: new Map(), delivered: new Set(), stopping: false, idle: false, controller: new AbortController(), integrations: new Map(),
      replayDeliveries: listWorkflowSteps(this.store, id).filter(step => step.delivery !== null).sort((a, b) => a.delivery! - b.delivery!).map(step => step.key) };
    this.scripts.set(id, state);
    this.store.withTx(() => {
      const run = setWorkflowState(this.store, id, "running", null, this.now());
      const { kind, id: unitId, label } = host.entry();
      updateWorkflowRun(this.store, { ...run, scriptUnits: [{ kind, id: unitId, label }], scriptStopVerified: null });
    });
    state.promise = (async () => {
      try {
        const output = await host.run(definition.script, snapshot.input, call => this.invoke(id, call), { onActivity: active => {
          state.idle = !active;
          this.updateWaiting(id);
          this.kick();
        }, onIdentity: identity => this.store.withTx(() => {
          const run = requireWorkflowRun(this.store, id);
          updateWorkflowRun(this.store, { ...run, scriptUnits: [{ kind: identity.kind, id: identity.id, label: identity.label }] });
        }) });
        this.store.withTx(() => {
          let run = requireWorkflowRun(this.store, id);
          const identity = host.identity();
          run = updateWorkflowRun(this.store, { ...run, scriptStopVerified: output.reaped, scriptUnits: identity ? [{ kind: identity.kind, id: identity.id, label: identity.label }] : run.scriptUnits });
          if (!this.admitted(run)) return;
          const steps = listWorkflowSteps(this.store, id);
          if (steps.some(step => !step.resultRecorded) || state.delivered.size !== steps.length) throw new WorkflowError("replay_diverged");
          const executions = listWorkflowExecutions(this.store, id);
          if (executions.some(execution => execution.stopVerified !== true || execution.status !== "finished")) throw new WorkflowError("stop_unverified");
          workflowJson(output.value);
          updateWorkflowRun(this.store, { ...run, result: { value: output.value, steps: steps.map(step => ({ key: step.key, status: step.status, delivery: step.delivery })) }, resultRecorded: true });
          const failures = steps.filter(step => step.status !== "completed");
          setWorkflowState(this.store, id, failures.length === 0 ? "succeeded" : failures.length === steps.length ? "failed" : "partial", null, this.now());
        });
      } catch (error) {
        const run = requireWorkflowRun(this.store, id);
        const failure = error instanceof ScriptExecutionError && error.cause instanceof WorkflowError ? error.cause : error;
        if (this.admitted(run)) this.pause(id, failure instanceof WorkflowError || failure instanceof ScriptExecutionError ? failure.code : "script_failed");
      } finally {
        const reaped = await host.stop();
        this.store.withTx(() => {
          const run = requireWorkflowRun(this.store, id);
          const identity = host.identity();
          const units = identity ? [{ kind: identity.kind, id: identity.id, label: identity.label }] : run.scriptUnits;
          if (run.scriptStopVerified !== reaped || JSON.stringify(run.scriptUnits) !== JSON.stringify(units)) updateWorkflowRun(this.store, { ...run, scriptStopVerified: reaped, scriptUnits: units });
          if (!reaped && !workflowTerminal(run.status)) setWorkflowState(this.store, id, "paused", "stop_unverified", this.now());
        });
        for (const waiter of state.replies.values()) waiter.reject(new WorkflowError("run_inactive"));
        if (this.scripts.get(id) === state) this.scripts.delete(id);
        this.kick();
      }
    })();
  }
  private admitted(run: WorkflowRun): boolean { return ["running", "waiting"].includes(run.status); }
  private async invoke(id: string, call: ScriptCall): Promise<unknown> {
    if (!isRecord(call.params)) throw new WorkflowError("invalid_step");
    const dependsOn = call.params.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some(key => typeof key !== "string") || new Set(dependsOn).size !== dependsOn.length) throw new WorkflowError("invalid_step");
    if (call.method === "agent" && (typeof call.params.request !== "string" || !call.params.request.trim())) throw new WorkflowError("invalid_step");
    if (call.method === "agent" && call.params.output !== undefined) this.outputCheck(call.params.output);
    if (call.method === "ask") {
      const options = call.params.options;
      if (options !== undefined && (!Array.isArray(options) || options.length === 0 || options.length > 20 ||
          options.some(option => typeof option !== "string" || !option.trim()) || new Set(options).size !== options.length)) throw new WorkflowError("invalid_question");
      if (call.params.schema !== undefined) compileWorkflowOutput(call.params.schema);
    }
    if (call.method === "agent") {
      const params = call.params;
      const { mode = "analyze", tools, target, verify } = call.params;
      if (!["analyze", "modify", "verify"].includes(String(mode)) ||
          (tools !== undefined && (!Array.isArray(tools) || tools.some(name => typeof name !== "string") || new Set(tools).size !== tools.length)) ||
          (mode === "modify" && (typeof target !== "string" || !target.trim())) ||
          (mode === "verify" && (typeof verify !== "string" || !dependsOn.includes(verify))) ||
          ["taskId", "sessionId", "projectId", "source", "authority", "credentials", "accessMode"].some(key => key in params)) throw new WorkflowError("invalid_step");
      if (mode === "verify") {
        params.output ??= { format: "json", schema: { type: "object", properties: { passed: { type: "boolean" }, reason: { type: "string" } }, required: ["passed"], additionalProperties: false } };
        if (!isRecord(params.output) || params.output.format !== "json") throw new WorkflowError("invalid_output_schema");
      }
    }
    const step = this.store.withTx(() => registerWorkflowStep(this.store, { runId: id, key: call.key, ordinal: call.id, kind: call.method, params: call.params, dependsOn }));
    if (!this.verifyOutputArtifact(step)) throw new WorkflowError("result_missing");
    const state = this.scripts.get(id);
    if (!state || state.stopping) throw new WorkflowError("run_inactive");
    const reply = new Promise<unknown>((resolve, reject) => state.replies.set(step.key, { resolve, reject }));
    this.flush(id);
    this.kick();
    return reply;
  }
  private dispatchHostStep(run: WorkflowRun, step: WorkflowStep): void {
    if (step.kind === "progress") {
      this.store.withTx(() => finishWorkflowStep(this.store, run.id, step.key, "completed", { status: "completed" }));
    } else if (step.kind === "ask") this.store.withTx(() => {
      if (!getWorkflowQuestion(this.store, run.id, step.key)) saveWorkflowQuestion(this.store, { runId: run.id, stepKey: step.key, version: 1, runVersion: run.version,
        prompt: step.params, source: run.source, status: "pending", answer: null });
      updateWorkflowStep(this.store, { ...step, status: "waiting" });
    });
    else {
      const state = this.scripts.get(run.id)!;
      if (state.integrations.has(step.key)) return;
      if (!this.deps.integrate) { this.pause(run.id, "integration_unavailable"); return; }
      this.store.withTx(() => updateWorkflowStep(this.store, { ...step, status: "running" }));
      let invoked = false;
      const operation = Promise.resolve().then(() => {
        if (!this.admitted(requireWorkflowRun(this.store, run.id)) || state.controller.signal.aborted) throw new WorkflowError("run_inactive");
        invoked = true;
        return this.deps.integrate!({ run: requireWorkflowRun(this.store, run.id), step, signal: state.controller.signal });
      }).then(value => {
        const failed = isRecord(value) && value.passed === false;
        if (this.admitted(requireWorkflowRun(this.store, run.id))) this.store.withTx(() => finishWorkflowStep(this.store, run.id, step.key, failed ? "failed" : "completed", { status: failed ? "failed" : "completed", value }));
      }).catch(error => {
        if (this.admitted(requireWorkflowRun(this.store, run.id))) this.pause(run.id, error instanceof WorkflowError || error instanceof WorkCopyError ? error.code : "integration_failed");
      }).finally(() => {
        const current = requireWorkflowRun(this.store, run.id);
        const reusable = !invoked || this.reusableIntegration(run.id, step.key);
        if (current.status === "paused" && reusable && !getWorkflowStep(this.store, run.id, step.key)!.resultRecorded) {
          this.store.withTx(() => updateWorkflowStep(this.store, { ...getWorkflowStep(this.store, run.id, step.key)!, status: "queued" }));
        }
        this.flush(run.id); this.kick();
      });
      state.integrations.set(step.key, operation);
      this.hostSteps.add(operation);
      void operation.then(() => this.hostSteps.delete(operation), () => this.hostSteps.delete(operation));
    }
  }
  private flush(id: string): void {
    if (this.flushPending.has(id) || this.stopped) return;
    this.flushPending.add(id);
    setImmediate(() => {
      this.flushPending.delete(id);
      try { this.flushNext(id); }
      catch (error) { this.pause(id, error instanceof WorkflowError ? error.code : "result_missing"); }
    });
  }
  private flushNext(id: string): void {
    const state = this.scripts.get(id);
    if (!state || state.stopping || !this.admitted(requireWorkflowRun(this.store, id))) return;
    const next = state.replayDeliveries.find(key => !state.delivered.has(key));
    const key = next ?? [...state.replies.keys()].find(key => getWorkflowStep(this.store, id, key)?.resultRecorded);
    if (!key || !state.replies.has(key)) return;
    const step = getWorkflowStep(this.store, id, key);
    if (!step?.resultRecorded) { this.pause(id, "result_missing"); return; }
    if (this.deps.verifyResultSources && !this.deps.verifyResultSources(requireWorkflowRun(this.store, id), step)) throw new WorkflowError("source_invalid");
    const delivered = this.store.withTx(() => deliverWorkflowStep(this.store, id, key));
    state.delivered.add(key);
    state.replies.get(key)!.resolve(delivered.result);
    state.replies.delete(key);
    // 让当前 invoke 的 Promise 采用与宿主 reply 入队完成后，再交付下一项。
    this.flush(id);
  }

  private runAgent(execution: WorkflowExecution): void {
    const job: AgentJob = { controller: new AbortController(), registry: createManagedProcessRegistry(), promise: Promise.resolve() };
    this.jobs.set(execution.taskId, job);
    const task = this.store.getTask(execution.taskId)!;
    const step = getWorkflowStep(this.store, execution.runId, execution.stepKey)!;
    job.promise = (async () => {
      let output: { output: string; isError?: boolean } | undefined;
      let failure: unknown;
      try {
        output = await this.deps.agent!({ run: requireWorkflowRun(this.store, execution.runId), step, task, signal: job.controller.signal,
          register: entry => {
            const current = this.store.getTask(task.id);
            if (job.stop || job.controller.signal.aborted || current?.status !== "running" || current.cancelRequested) throw new WorkflowError("task_ending");
            job.registry.register(entry);
            this.store.withTx(() => updateWorkflowExecution(this.store, task.id, { units: job.registry.list().map(({ kind, id, label }) => ({ kind, id, label })) }));
          },
          updateIdentity: entry => {
            if (!job.registry.list().includes(entry)) throw new WorkflowError("execution_missing");
            this.store.withTx(() => updateWorkflowExecution(this.store, task.id, { units: job.registry.list().map(({ kind, id, label }) => ({ kind, id, label })) }));
          } });
      } catch (error) { failure = error instanceof WorkCopyError ? new WorkflowError(error.code, { cause: error }) : error; }
      let rawOutput = output?.output ?? null;
      if (typeof rawOutput === "string" && Buffer.byteLength(JSON.stringify(rawOutput)) > WORKFLOW_LIMITS.valueBytes - 4096) {
        try {
          const bytes = Buffer.from(rawOutput);
          const artifact = this.store.withTx(() => {
            const artifact = this.artifacts.begin({ taskId: task.id, sessionId: task.sessionId, name: "workflow-output" });
            this.artifacts.append(artifact.id, bytes);
            this.artifacts.complete(artifact.id);
            updateWorkflowStep(this.store, { ...getWorkflowStep(this.store, execution.runId, step.key)!, outputArtifact: { id: artifact.id,
              hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } });
            return artifact;
          });
          failure = new WorkflowError("output_limit");
          rawOutput = null;
          this.store.withTx(() => this.store.setTaskResult(task.id, `原始输出保存在产物 ${artifact.id}，超过脚本结果上限`, JSON.stringify({ artifactId: artifact.id })));
        } catch (error) { failure = error; rawOutput = null; }
      }
      const reaped = await this.stopJob(task.id, false);
      this.store.withTx(() => {
        const current = this.store.getTask(task.id)!;
        updateWorkflowExecution(this.store, task.id, { status: "finished", stopVerified: reaped });
        if (!isTerminalTaskStatus(current.status)) this.store.endTask(task.id, ["running", "awaiting_confirmation"], output && !output.isError && !failure ? "completed" : "failed", {
          errorMessage: failure instanceof WorkflowError ? failure.code : failure ? "workflow_execution_failed" : output?.isError ? "workflow_agent_failed" : undefined,
          keepOccupancy: !reaped, occupancyIssueReason: !reaped ? "workflow_stop_unverified" : null });
        this.store.setSubAgentState(task.subAgentId!, reaped ? "idle" : "unverified", { activeWorkId: task.workId, currentTaskId: null });
        const run = requireWorkflowRun(this.store, execution.runId);
        if (rawOutput !== null) this.store.setTaskResult(task.id, rawOutput, JSON.stringify({ workflowRunId: run.id, stepKey: step.key, taskId: task.id }));
        const hostUnsafe = listWorkflowExecutions(this.store, execution.runId).filter(item => item.kind === "host" && item.stepKey === step.key).map(item => {
          const hostTask = this.store.getTask(item.taskId);
          return !hostTask ? "result_missing" : item.status === "finished" && item.stopVerified !== true ? "stop_unverified" : this.unsafeReason(hostTask, hostTask.resultSummary !== null);
        }).find(Boolean);
        const unsafe = hostUnsafe ?? this.unsafeReason(this.store.getTask(task.id)!, output !== undefined);
        if (unsafe) { if (!workflowTerminal(run.status)) setWorkflowState(this.store, run.id, "paused", unsafe, this.now()); return; }
        if (!this.admitted(run)) {
          if (run.status === "paused" && this.safeToRetry(task)) {
            if (step.attempts <= WORKFLOW_LIMITS.retries) updateWorkflowStep(this.store, { ...step, status: "queued" });
            else finishWorkflowStep(this.store, run.id, step.key, "failed", { status: "failed", code: "retry_limit" });
          }
          return;
        }
        if (failure || output?.isError) {
          if (!(failure instanceof WorkflowError && ["output_limit", "output_invalid", "git_required", "binding_invalid", "source_invalid", "verification_invalid", "verification_required"].includes(failure.code)) && this.safeToRetry(task) && step.attempts <= WORKFLOW_LIMITS.retries) updateWorkflowStep(this.store, { ...getWorkflowStep(this.store, run.id, step.key)!, status: "queued" });
          else finishWorkflowStep(this.store, run.id, step.key, "failed", { status: "failed", code: failure instanceof WorkflowError ? failure.code : "agent_failed" }, rawOutput);
          if (!this.safeToRetry(task)) setWorkflowState(this.store, run.id, "paused", "write_result_missing", this.now());
          return;
        }
        try {
          if (!output || typeof output.output !== "string") throw new WorkflowError("result_missing");
          const params = step.params as Record<string, unknown>;
          const check = this.outputCheck(params.output);
          const value: unknown = check ? JSON.parse(output.output) : output.output;
          if (check && !check(value)) throw new WorkflowError("output_invalid");
          if (params.mode === "verify" && (!isRecord(value) || typeof value.passed !== "boolean")) throw new WorkflowError("output_invalid");
          workflowJson(value);
          const evidence = getWorkflowStep(this.store, run.id, step.key)?.verification;
          const failed = params.mode === "verify" && (!evidence?.passed || (isRecord(value) && value.passed === false));
          finishWorkflowStep(this.store, run.id, step.key, failed ? "failed" : "completed", { status: failed ? "failed" : "completed", value }, output.output);
          this.store.setTaskResult(task.id, output.output, JSON.stringify({ workflowRunId: run.id, stepKey: step.key, taskId: task.id }));
        } catch (error) {
          finishWorkflowStep(this.store, run.id, step.key, "failed", { status: "failed", code: error instanceof WorkflowError ? error.code : "output_invalid" }, rawOutput);
          if (!this.safeToRetry(task)) setWorkflowState(this.store, run.id, "paused", "write_result_missing", this.now());
        }
      });
      this.jobs.delete(task.id);
      if (reaped) this.deps.onReleased?.();
      this.flush(execution.runId);
      this.kick();
    })().catch(error => {
      this.store.withTx(() => {
        const reaped = getWorkflowExecution(this.store, task.id)?.stopVerified === true;
        this.store.endTask(task.id, ["running", "awaiting_confirmation"], "interrupted", { interruptReason: "workflow_result_missing", keepOccupancy: !reaped,
          occupancyIssueReason: reaped ? null : "workflow_stop_unverified" });
        updateWorkflowExecution(this.store, task.id, { status: "finished" });
      });
      this.jobs.delete(task.id);
      this.deps.onReleased?.();
      this.pause(execution.runId, error instanceof WorkflowError ? error.code : "result_missing");
    });
  }
  private outputCheck(output: unknown): ((value: unknown) => boolean) | null {
    if (output === undefined || (isRecord(output) && output.format === "text")) return null;
    if (!isRecord(output) || output.format !== "json" || !isRecord(output.schema)) throw new WorkflowError("invalid_output_schema");
    return compileWorkflowOutput(output.schema);
  }
  private reusableIntegration(runId: string, key: string): boolean {
    const executions = listWorkflowExecutions(this.store, runId).filter(execution => execution.kind === "host" && execution.stepKey === key);
    return executions.length > 0 && executions.every(execution => {
      const task = this.store.getTask(execution.taskId);
      if (!task || task.effectUnknown || this.store.listAllOccupancy().some(held => held.taskId === task.id)) return false;
      return (execution.status === "queued" && task.status === "queued" && this.store.listToolOpsByTask(task.id).length === 0) ||
        (execution.status === "finished" && execution.stopVerified === true && task.status === "completed" && task.resultSummary !== null);
    });
  }
  private verifyOutputArtifact(step: WorkflowStep): boolean {
    const ref = step.outputArtifact;
    if (!ref) return true;
    const artifact = this.store.getArtifact(ref.id);
    if (!artifact || artifact.status !== "complete" || artifact.byteCount !== ref.bytes ||
        !listWorkflowExecutions(this.store, step.runId).some(execution => execution.stepKey === step.key && execution.taskId === artifact.taskId)) return false;
    try {
      if (this.artifacts.byteLength(ref.id) !== ref.bytes) return false;
      const hash = createHash("sha256");
      for (let offset = 0; offset < ref.bytes; offset += 256 * 1024) hash.update(this.artifacts.read(ref.id, offset, Math.min(256 * 1024, ref.bytes - offset)));
      return hash.digest("hex") === ref.hash;
    } catch { return false; }
  }
  private safeToRetry(task: Task): boolean {
    const confirmations = this.store.listConfirmationsByTask(task.id);
    return !task.effectUnknown && this.store.listToolOpsByTask(task.id).every(op => {
      const own = confirmations.filter(confirmation => confirmation.toolOpId === op.id);
      return this.ledger.hasNoWriteEffect(op) || (own.length > 0 && own.every(confirmation => confirmation.consumedAt === null));
    });
  }
  private unsafeReason(task: Task, hasOutput = false): string | null {
    if (this.store.listAllOccupancy().some(held => held.taskId === task.id) && isTerminalTaskStatus(task.status)) return "stop_unverified";
    if (task.effectUnknown || this.store.listToolOpsByTask(task.id).some(op => op.effectUnknown)) return "effect_unknown";
    if (!hasOutput && !this.safeToRetry(task)) return "write_result_missing";
    return null;
  }
  private async stopJob(taskId: string, abort: boolean): Promise<boolean> {
    const job = this.jobs.get(taskId);
    if (!job) return getWorkflowExecution(this.store, taskId)?.stopVerified === true;
    if (job.stop) return job.stop;
    const task = this.store.getTask(taskId)!;
    const unknown = abort ? this.ledger.beginStop(taskId) : [];
    if (abort) job.controller.abort();
    job.stop = (async () => {
      let reaped = true;
      for (const entry of job.registry.list()) {
        try { if (!await entry.stop()) reaped = false; }
        catch { reaped = false; }
      }
      this.store.withTx(() => {
        for (const opId of this.ledger.settleTask(task, unknown)) this.ledger.markEffectUnknown(task, opId);
        updateWorkflowExecution(this.store, taskId, { stopVerified: reaped });
        const canceled = requireWorkflowRun(this.store, getWorkflowExecution(this.store, taskId)!.runId).status === "canceled";
        if (abort) this.store.endTask(taskId, ["running", "awaiting_confirmation"], canceled ? "canceled" : "interrupted", { interruptReason: "workflow_stopped", keepOccupancy: !reaped,
          occupancyIssueReason: !reaped ? "workflow_stop_unverified" : null });
      });
      if (abort && reaped) this.deps.onReleased?.();
      return reaped;
    })();
    return job.stop;
  }
  private updateWaiting(id: string): void {
    const run = requireWorkflowRun(this.store, id);
    if (!this.admitted(run)) return;
    const steps = listWorkflowSteps(this.store, id);
    const pending = steps.filter(step => !step.resultRecorded);
    const executions = listWorkflowExecutions(this.store, id);
    const awaitingTask = (taskId: string): boolean => {
      if (this.store.getTask(taskId)?.status !== "awaiting_confirmation") return false;
      const confirmations = this.store.listConfirmationsByTask(taskId).filter(confirmation => confirmation.status === "pending");
      return confirmations.length > 0 && confirmations.every(confirmation => confirmation.reviewStatus !== "in_progress") &&
        this.store.listToolOpsByTask(taskId).filter(op => op.resultSummary === null).every(op => confirmations.some(confirmation => confirmation.toolOpId === op.id));
    };
    const awaitingApproval = (step: WorkflowStep): boolean => step.kind === "agent" && executions.some(execution =>
      execution.stepKey === step.key && execution.status === "running" && awaitingTask(execution.taskId));
    const humanWait = (step: WorkflowStep): boolean => (step.kind === "ask" && step.status === "waiting") || awaitingApproval(step);
    const script = this.scripts.get(id);
    const waiting = script?.idle && !steps.some(step => step.resultRecorded && script.replies.has(step.key) && !script.delivered.has(step.key)) &&
      pending.some(humanWait) && pending.every(step => humanWait(step) || (step.status === "queued" && step.dependsOn.some(key => !getWorkflowStep(this.store, id, key)?.resultRecorded))) &&
      !executions.some(execution => execution.status === "running" && !awaitingTask(execution.taskId));
    if (waiting && run.status !== "waiting") this.store.withTx(() => setWorkflowState(this.store, id, "waiting", pending.some(step => step.kind === "ask" && step.status === "waiting") ? "owner_input" : "tool_approval", this.now()));
    else if (!waiting && run.status === "waiting") this.store.withTx(() => setWorkflowState(this.store, id, "running", null, this.now()));
  }
  private pause(id: string, reason: string): void {
    this.store.withTx(() => setWorkflowState(this.store, id, "paused", reason, this.now()));
    void this.stopRun(id, reason);
  }
  private async stopRun(id: string, reason: string): Promise<void> {
    const script = this.scripts.get(id);
    if (script && !script.stopping) { script.stopping = true; script.controller.abort(); await script.host.stop(); }
    await Promise.all(listWorkflowExecutions(this.store, id).filter(execution => execution.status === "running").map(async execution => {
      if (execution.kind === "host") await this.deps.stopHost?.(execution.taskId, reason);
      else await this.stopJob(execution.taskId, true);
    }));
  }
  async control(id: string, key: string, version: number, control: WorkflowControl, initiatingTaskId?: string | null, txExtra?: () => void): Promise<WorkflowRun> {
    const { result, duplicate } = this.store.withTx(() => {
      const duplicate = hasWorkflowControl(this.store, id, key);
      if (!duplicate && control.action === "resume" && listWorkflowExecutions(this.store, id).some(execution => this.jobs.has(execution.taskId))) throw new WorkflowError("verification_required");
      const result = controlWorkflow(this.store, id, key, version, control, this.now());
      if (!duplicate && control.action === "resume") {
        for (const step of listWorkflowSteps(this.store, id)) {
          if (step.resultRecorded) continue;
          if (step.kind === "integrate" && step.status === "running") {
            if (!this.reusableIntegration(id, step.key)) throw new WorkflowError("verification_required");
            updateWorkflowStep(this.store, { ...step, status: "queued" });
          }
          if (step.kind !== "agent") continue;
          const executions = listWorkflowExecutions(this.store, id).filter(execution => execution.kind === "agent" && execution.stepKey === step.key);
          for (const execution of executions) {
            const task = this.store.getTask(execution.taskId);
            if (!task || this.unsafeReason(task)) throw new WorkflowError("verification_required");
          }
          if (step.status === "running" && executions.every(execution => execution.status === "finished" && execution.stopVerified === true)) {
            if (step.attempts <= WORKFLOW_LIMITS.retries) updateWorkflowStep(this.store, { ...step, status: "queued" });
            else finishWorkflowStep(this.store, id, step.key, "failed", { status: "failed", code: "retry_limit" });
          }
        }
      }
      txExtra?.();
      return { result, duplicate };
    });
    if (!duplicate && ["paused", "canceled"].includes(result.status)) {
      const stopping = this.stopRun(id, result.reason ?? "stopped");
      // 步骤取消所属计划时，SDK abort 要等当前工具返回；取消意图已提交，停止异步收尾。
      if (initiatingTaskId && getWorkflowExecution(this.store, initiatingTaskId)?.runId === id) {
        void stopping.catch(() => {
          process.stderr.write(`[ruukoto:workflow] ${id} 自身取消收尾失败；保留执行与占用供核实\n`);
        });
      } else await stopping;
    }
    this.kick();
    return requireWorkflowRun(this.store, id);
  }
  /** 可信回答与可选入口回执同事务提交；旧请求先查重，不重新推进运行或消费审批。 */
  answer(id: string, stepKey: string, version: number, answer: unknown, source: WorkflowSource,
    input: { requestKey: string; runVersion: number; txExtra?: () => void }): WorkflowQuestion {
    const digest = workflowDigest({ action: "answer", stepKey, version, answer, source, runVersion: input.runVersion });
    const result = this.store.withTx(() => {
      if (!input.requestKey) throw new WorkflowError("invalid_request");
      const old = this.store.db.prepare("SELECT digest, payload FROM workflow_controls WHERE run_id = ? AND request_key = ?").get(id, input.requestKey) as { digest: string; payload: string } | undefined;
      if (old) {
        if (old.digest !== digest) throw new WorkflowError("request_conflict");
        return JSON.parse(old.payload) as WorkflowQuestion;
      }
      const run = requireWorkflowRun(this.store, id);
      const question = getWorkflowQuestion(this.store, id, stepKey);
      if (!this.admitted(run) || !question || question.status !== "pending" || question.version !== version || question.runVersion !== input.runVersion ||
          workflowDigest(question.source) !== workflowDigest(source) || !this.deps.verifySource(source)) throw new WorkflowError("stale_answer");
      const step = getWorkflowStep(this.store, id, stepKey);
      if (!step || (this.deps.verifyResultSources && !this.deps.verifyResultSources(run, step))) throw new WorkflowError("stale_answer");
      workflowJson(answer);
      const params = question.prompt;
      if (!isRecord(params) || (Array.isArray(params.options) && !params.options.includes(answer)) ||
          (params.schema !== undefined && !compileWorkflowOutput(params.schema)(answer))) throw new WorkflowError("invalid_answer");
      const answered: WorkflowQuestion = { ...question, status: "answered", answer, version: version + 1 };
      saveWorkflowQuestion(this.store, answered);
      finishWorkflowStep(this.store, id, stepKey, "completed", { status: "completed", value: answer });
      setWorkflowState(this.store, id, "running", null, this.now());
      this.store.db.prepare("INSERT INTO workflow_controls (run_id, request_key, digest, payload) VALUES (?, ?, ?, ?)").run(id, input.requestKey, digest, JSON.stringify(answered));
      input.txExtra?.();
      return answered;
    });
    this.flush(id);
    this.kick();
    return result;
  }
  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    for (const run of listWorkflowRuns(this.store)) {
      if (!workflowTerminal(run.status) && run.status !== "paused") this.store.withTx(() => setWorkflowState(this.store, run.id, "paused", reason, this.now()));
      await this.stopRun(run.id, reason);
    }
    await Promise.all([...this.scripts.values()].map(script => script.promise));
    await Promise.all([...this.hostSteps]);
    await Promise.all([...this.jobs.values()].map(job => job.promise));
  }
}
