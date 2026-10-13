/** 工作流真实步骤的来源权限、冻结成果与独立验证；普通委派保持自己的画像。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-step-capabilities.md
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { Store } from "@ruukoto/core/store.ts";
import type { AccessScope } from "@ruukoto/core/access.ts";
import type { Session, Task, WorkDelegation, WorkWriteTarget, ToolCategory, SubAgentReadScope } from "@ruukoto/core/types.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import { getWorkflowExecution, getWorkflowStep, getWorkflowRun, listWorkflowExecutions, requireWorkflowRun, updateWorkflowStep, WorkflowError,
  type WorkflowRun, type WorkflowSource, type WorkflowStep } from "@ruukoto/core/workflow.ts";
import type { Driver } from "@ruukoto/agent/driver.ts";
import type { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { ManagedEntry } from "@ruukoto/agent/managed-processes.ts";
import { isRecord } from "@ruukoto/agent/script-worker/protocol.ts";
import type { WorkflowAgentContext } from "./workflows.ts";
import type { WorkCopyExecution, WorkCopyManager, FrozenWorkCopyPatch } from "./work-copy.ts";

export interface WorkflowHostOperationInput {
  runId: string; stepKey: string; key: string; params: unknown;
  directories?: { path: string; dev: number; ino: number }[];
}
interface WorkflowStepsDeps {
  store: Store; artifacts: ArtifactStore; access: AccessScope; copies: WorkCopyManager;
  hostOperation<T>(input: WorkflowHostOperationInput, execute: (execution: WorkCopyExecution, task: Task) => Promise<T>): Promise<T>;
  getDriver(session: Session): Promise<Driver>;
  readReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  verifySource(source: WorkflowSource): boolean;
  verifySources(projectId: string, refs: SubAgentReadScope["sourceRefs"], taskId?: string): string | null;
}

export class WorkflowSteps {
  constructor(private readonly deps: WorkflowStepsDeps) {}
  private get store(): Store { return this.deps.store; }
  recordMemory(task: Task, memoryId: string): void {
    const bound = this.binding(task);
    if (!bound) throw new WorkflowError("binding_invalid");
    this.store.withTx(() => {
      const step = getWorkflowStep(this.store, bound.run.id, bound.step.key)!;
      if (!(step.readMemories ?? []).includes(memoryId)) updateWorkflowStep(this.store, { ...step, readMemories: [...(step.readMemories ?? []), memoryId] });
    });
  }
  private binding(task: Task): { run: WorkflowRun; step: WorkflowStep; work: WorkDelegation } | null {
    const execution = getWorkflowExecution(this.store, task.id);
    if (!execution || execution.kind !== "agent") return null;
    const run = getWorkflowRun(this.store, execution.runId);
    const step = getWorkflowStep(this.store, execution.runId, execution.stepKey);
    const work = task.workId ? this.store.getWorkDelegation(task.workId) : null;
    const identity = this.store.getSessionIdentity(task.sessionId);
    if (!run || !step || !work || identity?.kind !== "subagent" || identity.workflow?.runId !== run.id ||
        identity.workflow.stepKey !== step.key || identity.workflow.sourceSessionId !== run.source.sessionId ||
        work.parentSessionId !== run.source.sessionId || work.subAgentId !== task.subAgentId || identity.agent.id !== task.subAgentId ||
        this.store.getSession(task.sessionId)?.projectId !== run.source.projectId || task.parentTaskId !== run.source.taskId ||
        task.sourcePermissionVersion !== run.source.permissionVersion || task.accessMode !== run.source.accessMode) throw new WorkflowError("binding_invalid");
    return { run, step, work };
  }
  resolve(task: Task) {
    const bound = this.binding(task);
    if (!bound) return null;
    const { run, step, work } = bound;
    if (!run.source.authority) throw new WorkflowError("authority_missing");
    const source = this.store.getSessionIdentity(run.source.sessionId);
    if (!source || !["dev", "main", "scheduled"].includes(source.kind)) throw new WorkflowError("source_invalid");
    const categories = run.source.authority.categories.filter(category => !["subagent", "delegation", "workflow"].includes(category));
    // main 的编码能力来自已保存的受控修改委派，分析步骤只取得文件读取工具。
    if (work.writeTarget && !categories.includes("coding") && run.source.authority.categories.includes("subagent")) categories.push("coding");
    const params = step.params as Record<string, unknown>;
    const requested = params.tools as string[] | undefined;
    if (params.mode === "verify") return { toolClass: source.kind === "dev" ? "dev" as const : "main" as const,
      sourceProjectId: run.source.projectId, categories: ["coding"] as ToolCategory[], grantIds: run.source.authority.grantIds,
      tools: ["read", "edit", "write", "bash", "read_artifact"].filter(name => !requested || requested.includes(name)), verifyTarget: true };
    return { toolClass: source.kind === "dev" ? "dev" as const : "main" as const, sourceProjectId: run.source.projectId,
      categories: categories as ToolCategory[], tools: requested, verifyTarget: Boolean(work.writeTarget), grantIds: run.source.authority.grantIds };
  }
  verify(task: Task): string | null {
    let bound: ReturnType<WorkflowSteps["binding"]>;
    try { bound = this.binding(task); }
    catch (error) { return error instanceof WorkflowError ? error.code : "binding_invalid"; }
    if (!bound) return null;
    const { run, step, work } = bound;
    const current = this.store.getTask(task.id);
    if (!current || !["running", "awaiting_confirmation"].includes(current.status) || current.cancelRequested ||
        !["running", "waiting"].includes(run.status) || !run.source.authority || !this.deps.verifySource(run.source)) return "source_invalid";
    if (work.writeTarget?.kind === "worktree") {
      try { this.deps.copies.assertCopy(work, work.writeTarget, "停止步骤并保留成果"); }
      catch { return "worktree_gone"; }
    }
    if (!this.verifyResultSources(run, step)) return "task_sources_revoked";
    return null;
  }
  verifyResultSources(run: WorkflowRun, step: WorkflowStep, verifySource = this.deps.verifySource): boolean {
    if (!verifySource(run.source)) return false;
    const keys = new Set<string>();
    const pending = [step.key];
    while (pending.length) {
      const key = pending.pop()!;
      if (keys.has(key)) continue;
      const dependency = getWorkflowStep(this.store, run.id, key);
      if (!dependency) return false;
      keys.add(key);
      for (const memoryId of dependency.readMemories ?? []) {
        const row = this.store.db.prepare("SELECT status FROM memories WHERE id = ?").get(memoryId) as { status: string } | undefined;
        if (!row || row.status !== "active") return false;
      }
      pending.push(...dependency.dependsOn);
    }
    for (const execution of listWorkflowExecutions(this.store, run.id).filter(item => keys.has(item.stepKey))) {
      const task = this.store.getTask(execution.taskId);
      if (!task || this.deps.verifySources(run.source.projectId, task.readScope?.sourceRefs ?? [], task.id)) return false;
      for (const op of this.store.listToolOpsByTask(task.id)) {
        if (Array.isArray(op.params.source_refs) && this.deps.verifySources(run.source.projectId, op.params.source_refs as SubAgentReadScope["sourceRefs"], task.id)) return false;
      }
      for (const op of this.store.listToolOpsByTask(task.id)) {
        if (op.toolName === "memory_read" && typeof op.params.memory_id === "string") {
          const row = this.store.db.prepare("SELECT status FROM memories WHERE id = ?").get(op.params.memory_id) as { status: string } | undefined;
          if (!row || row.status !== "active") return false;
        }
      }
    }
    return true;
  }
  historyAccess(task: Task, sessionId: string): boolean {
    const bound = this.binding(task);
    const session = this.store.getSession(sessionId);
    if (!bound || !session || !this.deps.access.canAccess({ kind: "agent", projectId: bound.run.source.projectId, grantIds: bound.run.source.authority?.grantIds }, session.projectId, "history")) return false;
    const identity = this.store.getSessionIdentity(sessionId);
    return identity?.kind !== "subagent" || !identity.workflow ||
      (identity.workflow.runId === bound.run.id && [bound.step.key, ...bound.step.dependsOn].includes(identity.workflow.stepKey));
  }
  artifactAccess(task: Task, artifact: { taskId: string; sessionId: string; name: string }): boolean {
    if (artifact.name.startsWith("prompt-snapshot:")) return false;
    const bound = this.binding(task);
    if (!bound) return false;
    const execution = getWorkflowExecution(this.store, artifact.taskId);
    if (execution) return execution.runId === bound.run.id && [bound.step.key, ...bound.step.dependsOn].includes(execution.stepKey) &&
      this.verifyResultSources(bound.run, getWorkflowStep(this.store, execution.runId, execution.stepKey)!);
    const session = this.store.getSession(artifact.sessionId);
    return Boolean(session && this.deps.access.canAccess({ kind: "agent", projectId: bound.run.source.projectId, grantIds: bound.run.source.authority?.grantIds }, session.projectId, "artifact"));
  }
  private target(work: WorkDelegation): Extract<WorkWriteTarget, { kind: "worktree" }> {
    if (work.writeTarget?.kind !== "worktree") throw new WorkflowError("git_required");
    return work.writeTarget;
  }
  private frozen(step: WorkflowStep): FrozenWorkCopyPatch {
    const record = step.frozen;
    if (!record) throw new WorkflowError("frozen_missing");
    const artifact = this.store.getArtifact(record.artifactId);
    if (!artifact || artifact.status !== "complete" || artifact.byteCount !== record.bytes || this.deps.artifacts.byteLength(artifact.id) !== record.bytes) throw new WorkflowError("frozen_missing");
    const patch = this.deps.artifacts.read(artifact.id, 0, record.bytes);
    if (createHash("sha256").update(patch).digest("hex") !== record.digest) throw new WorkflowError("frozen_changed");
    return { workId: record.workId, baseCommit: record.baseCommit, digest: record.digest, bytes: record.bytes, patch };
  }
  async agent(context: WorkflowAgentContext): Promise<{ output: string; isError?: boolean }> {
    const { run, step, task, signal } = context;
    const params = step.params as Record<string, unknown>;
    let driver: Driver | null = null;
    let stopping = false;
    let started = false;
    let ready: Promise<void> = Promise.resolve();
    const entry: ManagedEntry = { kind: "starting", id: `driver:${task.id}`, label: `workflow:${run.id}:${step.key}`, stop: async () => {
      stopping = true;
      await ready;
      if (!driver || !started) return true;
      const canceled = requireWorkflowRun(this.store, run.id).status === "canceled";
      if (driver.busy) return driver.requestStop(task, { terminal: canceled ? "canceled" : "interrupted", reason: "workflow_stopped", cancelIntent: canceled });
      return driver.stopManagedProcesses(task.id);
    } };
    context.register(entry);
    const work = this.store.getWorkDelegation(task.workId!)!;
    const parentSession = this.store.getSession(run.source.sessionId)!;
    let verification: WorkflowStep | null = null;
    if (params.mode === "modify" || params.mode === "verify") {
      if (params.mode === "verify") {
        verification = getWorkflowStep(this.store, run.id, String(params.verify));
        if (!verification || verification.status !== "completed" || !verification.frozen || !step.dependsOn.includes(verification.key)) throw new WorkflowError("verification_invalid");
      }
      const writeTarget = await this.deps.hostOperation({ runId: run.id, stepKey: step.key, key: `prepare:${task.id}`, params: { mode: params.mode, target: params.target ?? null, verify: params.verify ?? null } }, async execution => {
        if (params.mode === "modify") return this.deps.copies.prepareWriteTarget(String(params.target), parentSession, work.id, run.source.taskId, execution, { gitOnly: true });
        const frozen = this.frozen(verification!);
        const original = this.store.getWorkDelegation(frozen.workId)!;
        return this.deps.copies.prepareVerificationTarget({ work: original, target: this.target(original), frozen, parentSession,
          parentTaskId: run.source.taskId, verificationWorkId: work.id, execution });
      });
      if (signal.aborted || stopping) throw new WorkflowError("task_ending");
      this.store.withTx(() => {
        if (!this.store.tryAcquireOccupancy({ cwdReal: writeTarget.path, cwdDev: writeTarget.dev, cwdIno: writeTarget.ino, sessionId: task.sessionId, taskId: task.id })) throw new WorkflowError("occupancy_conflict");
        this.store.db.prepare("UPDATE work_delegations SET write_target = ? WHERE id = ? AND write_target IS NULL").run(JSON.stringify(writeTarget), work.id);
        const input = JSON.stringify({ params, workspace: writeTarget.path, sourceReferences: run.source.references,
          dependsOn: step.dependsOn.map(key => ({ key, result: getWorkflowStep(this.store, run.id, key)!.result })),
          verification: verification?.frozen ?? null,
          instructions: params.mode === "verify" ? "在当前独立验证副本核实冻结成果。检查写入只留在本副本。最终返回 JSON 对象 {\"passed\":true|false}，说明在 reason 字段。" : "只修改当前独立工作副本，不提交或推送；结果由宿主冻结并交给独立验证者。" });
        this.store.db.prepare("UPDATE tasks SET input = ? WHERE id = ?").run(input, task.id);
      });
    }
    const registered = new Set<ManagedEntry>();
    ready = (async () => { driver = await this.deps.getDriver(this.store.getSession(task.sessionId)!); })();
    await ready;
    if (signal.aborted || stopping) throw new WorkflowError("task_ending");
    driver!.setWorkflowManagedUnits((entries) => {
      for (const unit of entries) {
        if (registered.has(unit)) context.updateIdentity(unit);
        else { context.register(unit); registered.add(unit); }
      }
    });
    started = true;
    await driver!.run(this.store.getTask(task.id)!);
    context.updateIdentity(entry);
    const current = this.store.getTask(task.id)!;
    if (current.status !== "completed") return { output: current.errorMessage ?? current.interruptReason ?? "步骤未完成", isError: true };
    let output = "";
    for (let offset = 0;;) {
      const page = this.deps.readReply(task.id, offset, 256 * 1024);
      if (!page) throw new WorkflowError("result_missing");
      output += page.text;
      offset += Buffer.byteLength(page.text);
      if (offset >= page.totalBytes) break;
      if (!page.text) throw new WorkflowError("result_missing");
    }
    if (params.mode === "modify") {
      const frozen = await this.deps.hostOperation({ runId: run.id, stepKey: step.key, key: `freeze:${task.id}`, params: { taskId: task.id, workId: work.id } }, async (execution, hostTask) => {
        const currentWork = this.store.getWorkDelegation(work.id)!;
        const target = this.target(currentWork);
        const frozen = await this.deps.copies.freeze({ work: currentWork, target, parentTaskId: run.source.taskId, execution });
        const artifact = this.store.withTx(() => {
          const artifact = this.deps.artifacts.begin({ taskId: hostTask.id, sessionId: hostTask.sessionId, name: `workflow-patch:${step.key}` });
          this.deps.artifacts.append(artifact.id, frozen.patch);
          this.deps.artifacts.complete(artifact.id);
          return artifact;
        });
        return { workId: work.id, taskId: task.id, baseCommit: frozen.baseCommit, artifactId: artifact.id, digest: frozen.digest, bytes: frozen.bytes };
      });
      this.store.withTx(() => updateWorkflowStep(this.store, { ...getWorkflowStep(this.store, run.id, step.key)!, frozen }));
    }
    if (verification) {
      let value: unknown;
      try { value = JSON.parse(output); }
      catch { return { output }; }
      if (!isRecord(value) || typeof value.passed !== "boolean") return { output };
      const passed = value.passed && this.store.listToolOpsByTask(task.id).every(op => op.resultSummary !== null && op.isError === false && !op.effectUnknown);
      const frozen = verification.frozen!;
      this.store.withTx(() => updateWorkflowStep(this.store, { ...getWorkflowStep(this.store, run.id, step.key)!, verification: { stepKey: verification!.key,
        taskId: task.id, artifactId: frozen.artifactId, digest: frozen.digest, baseCommit: frozen.baseCommit, passed } }));
    }
    return { output };
  }
  async integrate({ run, step }: { run: WorkflowRun; step: WorkflowStep; signal: AbortSignal }): Promise<unknown> {
    const params = step.params as Record<string, unknown>;
    if (!Array.isArray(params.steps) || params.steps.length === 0 || params.steps.some(key => typeof key !== "string" || !step.dependsOn.includes(key)) ||
        typeof params.check !== "string" || !params.check.trim()) throw new WorkflowError("invalid_integration");
    const checked = params.steps.map(key => {
      const verification = getWorkflowStep(this.store, run.id, String(key));
      const evidence = verification?.verification;
      const changed = evidence ? getWorkflowStep(this.store, run.id, evidence.stepKey) : null;
      const frozen = changed?.frozen;
      const execution = evidence ? getWorkflowExecution(this.store, evidence.taskId) : null;
      if (!verification || verification.status !== "completed" || !evidence?.passed || !frozen || !execution || execution.runId !== run.id || execution.stepKey !== verification.key ||
          execution.stopVerified !== true || execution.status !== "finished" || this.store.getTask(evidence.taskId)?.status !== "completed" ||
          evidence.taskId === frozen.taskId || evidence.artifactId !== frozen.artifactId || evidence.digest !== frozen.digest || evidence.baseCommit !== frozen.baseCommit) throw new WorkflowError("verification_required");
      const work = this.store.getWorkDelegation(frozen.workId);
      if (!work || work.parentSessionId !== run.source.sessionId) throw new WorkflowError("binding_invalid");
      return { work, target: this.target(work), frozen: this.frozen(changed!) };
    });
    const directories = checked.flatMap(({ target }) => [{ path: target.path, dev: target.dev, ino: target.ino }, this.directory(target.repoRoot)]);
    return this.deps.hostOperation({ runId: run.id, stepKey: step.key, key: `integrate:${step.key}`, params: step.params, directories }, async execution => {
      const parentSession = this.store.getSession(run.source.sessionId)!;
      const results = [];
      for (const item of checked) results.push(await this.deps.copies.integrateFrozen({ ...item, parentSession, parentTaskId: run.source.taskId, execution }));
      const check = await this.deps.copies.check({ work: checked[0].work, target: checked[0].target, parentTaskId: run.source.taskId, execution,
        workspace: run.source.authority!.workspace.path, command: String(params.check) });
      const unchanged = [];
      for (const item of checked) unchanged.push((await this.deps.copies.freeze({ work: item.work, target: item.target, parentTaskId: run.source.taskId, execution })).digest === item.frozen.digest);
      return { results, check, passed: !check.isError && unchanged.every(Boolean) && results.every(result => result.state !== "conflict") };
    });
  }
  private directory(directory: string): { path: string; dev: number; ino: number } {
    const real = fs.realpathSync(directory), stat = fs.statSync(real);
    return { path: real, dev: stat.dev, ino: stat.ino };
  }
}
