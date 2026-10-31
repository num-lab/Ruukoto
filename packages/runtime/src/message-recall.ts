/**
 * Recall progression: accept, adjudicate, stop the execution closure, fix omissions, append JSONL context_edit records, then complete.
 * Historical recall freezes dispatch and establishes source barriers; queued retrieval atomically cancels only its unstarted input.
 * Recovery resumes from the persisted phase and fixed list without reconstructing request parameters.
 * Stopping follows trusted ownership across execution/host tasks, registered derived tasks, delegations, workflow runs/executions, backgrounds and pending messages.
 * Unknown ownership or unverified units remain blocked; verify-only continues verification.
 * edit_open authorizes restoring a completed draft until new input, explicit queue resumption or the next completed recall closes it.
 * Note: See .agents/notes/implemented/feature/2026-10-30-coding-user-queue.md
 */

import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AttachmentMetadata } from "@ruukoto/core/attachments.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import {
  effectiveProjection,
  isEditableContribution,
  MESSAGE_RECALL_MARKER,
} from "@ruukoto/core/history-effective.ts";
import { HistoryIndex } from "@ruukoto/core/history-index.ts";
import { HistoryReadError, parseSessionFileStrict } from "@ruukoto/core/history.ts";
import {
  closeEditWindows,
  findMessageRecall,
  getEditWindowRecall,
  getMessageRecall,
  getOpenMessageRecall,
  insertMessageRecall,
  isRecallSealedTask,
  latestCompletedRecall,
  listMessageRecalls,
  nextCompletionRevision,
  recallCandidate,
  recallInputSupported,
  recallParamsDigest,
  publicMessageRecall,
  updateMessageRecall,
} from "@ruukoto/core/message-recall.ts";
import { listActiveBackgroundProcesses } from "@ruukoto/core/background-processes.ts";
import { invalidateOwnerQuestionsForTask } from "@ruukoto/core/owner-questions.ts";
import { workCopyHostFor } from "@ruukoto/core/work-copy-host.ts";
import { isTerminalTaskStatus } from "@ruukoto/core/types.ts";
import type { MessageRecall, PublicMessageRecall, Session, Task } from "@ruukoto/core/types.ts";
import { getWorkflowExecution, requireWorkflowRun, updateWorkflowExecution, WorkflowError, workflowTerminal } from "@ruukoto/core/workflow.ts";
import { SubAgentDelegationError } from "./subagents.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { Driver } from "@ruukoto/agent/driver.ts";
import type { ArtifactStore } from "@ruukoto/agent/artifacts.ts";
import type { OwnerAttachments } from "./owner-attachments.ts";
import type { WorkflowCoordinator } from "./workflows.ts";
import type { SubAgentManager } from "./subagents.ts";

/** Queue pause reasons for recall processing and its edit window. */
export const RECALL_PAUSE_REASON = "message_recall";
export const RECALL_EDIT_PAUSE_REASON = "message_recall_edit";

const STOP_VERIFY_WAIT_MS = 15_000;
const STOP_VERIFY_POLL_MS = 200;

export interface MessageRecallStateView {
  /** Latest accepted real owner input not successfully recalled. */
  candidate: { kind: "task"; taskId: string; inputSeq: number } | { kind: "answer"; taskId: string; questionId: string; inputSeq: number } | null;
  /** Redacted pending request in accepted/stopping/blocked/applying phase. */
  open: PublicMessageRecall | null;
  /** Current edit window: completed with edit_open. */
  edit: { recallId: string; completionRevision: number; input: string; attachments: AttachmentMetadata[] } | null;
  /** Redacted receipt for the requested key, or the latest request when no key is supplied. */
  receipt: PublicMessageRecall | null;
}

export interface MessageRecallDeps {
  store: Store;
  sessionsDir: string;
  driverFor(sessionId: string): Driver | undefined;
  ensureDriver(session: Session): Promise<Driver>;
  disposeDriver(sessionId: string): Promise<void>;
  // Accessors resolve host execution, workflow and SubAgent managers initialized later in assembly.
  hostExecutions(): { has(taskId: string): boolean; stop(taskId: string, terminal: "completed" | "failed" | "canceled" | "interrupted", reason: string): Promise<boolean> } | null;
  workflows(): WorkflowCoordinator | null;
  subagents(): SubAgentManager | null;
  backgroundProcesses: { requestStop(processId: string, reason: string): void };
  agentWait: { interrupt(taskId: string, reason: string): boolean };
  attachments: OwnerAttachments;
  artifacts: ArtifactStore;
  kick(sessionId: string): void;
}

export class MessageRecallRuntime {
  constructor(private readonly deps: MessageRecallDeps) {}

  private get store(): Store {
    return this.deps.store;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private publish(recall: MessageRecall): void {
    this.store.appendEvent({ type: "message_recall.changed", sessionId: recall.sessionId, recall: publicMessageRecall(recall) }, { sessionId: recall.sessionId });
  }

  // Shared operation guards

  /** Reject new input and conflicting history changes in this conversation while recall is pending. */
  assertNoOpenRecall(sessionId: string): void {
    if (getOpenMessageRecall(this.store, sessionId)) {
      throw new RuntimeApiError("recall_pending", "本会话有撤回请求尚未收束，请等待或查询其状态后再操作");
    }
  }

  /** Check the source barrier before derived registration, delivery, consumption or start. */
  assertSourceNotSealed(taskId: string): void {
    if (isRecallSealedTask(this.store, taskId)) {
      throw new RuntimeApiError("recall_source_sealed", "该来源已随撤回封闭，不能登记新的派生工作");
    }
  }

  /** Accepting new input closes the edit window and restores the queue state preceding recall. */
  closeEditWindowForNewInput(sessionId: string): void {
    const edit = getEditWindowRecall(this.store, sessionId);
    if (!edit) return;
    closeEditWindows(this.store, sessionId, this.now());
    const session = this.store.getSession(sessionId);
    if (session?.queuePauseReason === RECALL_EDIT_PAUSE_REASON) {
      this.restoreQueueState(sessionId, edit.savedQueueState, edit.savedQueueReason);
    }
  }

  /** Restore the saved queue state and broadcast it, including pause-reason changes. */
  private restoreQueueState(sessionId: string, savedState: "active" | "paused" | null, savedReason: string | null): void {
    const state = savedState ?? "active";
    this.store.setSessionQueueState(sessionId, state, state === "paused" ? savedReason : null);
    this.store.appendEvent(
      state === "paused"
        ? { type: "session.queue_paused", sessionId, reason: savedReason ?? "" }
        : { type: "session.queue_resumed", sessionId },
      { sessionId },
    );
  }

  // Control operations

  /**
   * Fix and accept the recall target. Identical keyed requests return the existing receipt; changed parameters reject.
   * Reject new requests while one is pending, rather than treating them as recalls of earlier input.
   */
  async recallMessage(input: { sessionId: string; taskId: string; requestId: string; expectedRevision: number; purpose: MessageRecall["purpose"] }): Promise<MessageRecall> {
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId || !["queued", "historical"].includes(input.purpose) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new RuntimeApiError("invalid_params", "撤回用途、请求键或修订无效，请刷新后重试");
    const digest = recallParamsDigest(input);
    const now = this.now();
    const recall = this.store.withTx(() => {
      const existing = findMessageRecall(this.store, session.id, input.requestId);
      if (existing) {
        if (existing.paramsDigest !== digest) throw new RuntimeApiError("request_conflict", "该请求键已用于其他参数，请换用新请求键");
        return existing;
      }
      if (this.store.getSessionIdentity(session.id)?.kind !== "dev") throw new RuntimeApiError("recall_unsupported", "仅普通 Coding 会话支持撤回输入");
      if (!this.store.getTask(input.taskId)) throw new RuntimeApiError("not_found", "撤回目标不存在，请刷新会话");
      const open = getOpenMessageRecall(this.store, session.id);
      if (open) throw new RuntimeApiError("recall_pending", "本会话有撤回请求尚未收束，请等待其完成或先核实停止");
      const candidate = input.purpose === "historical" ? recallCandidate(this.store, session.id) : null;
      const task = input.purpose === "queued" ? this.store.getTask(input.taskId) : candidate && candidate.task.id === input.taskId ? candidate.task : null;
      const reject = (code: string, message: string): MessageRecall => {
        const rejected: MessageRecall = {
          id: randomUUID(), purpose: input.purpose, sessionId: session.id, requestId: input.requestId, paramsDigest: digest,
          targetTaskId: input.taskId, inputSeq: candidate?.inputSeq ?? 0, expectedRevision: input.expectedRevision,
          execTaskId: null, phase: "rejected", stopTaskIds: [], sealedTaskIds: [], omittedEntryIds: null,
          historyFingerprint: null, originalInput: task?.input ?? "", originalAttachments: [], draftAttachments: null,
          completionRevision: null, nextCandidateTaskId: null, editOpen: false,
          savedQueueState: null, savedQueueReason: null,
          error: { code, message }, createdAt: now, updatedAt: now,
        };
        insertMessageRecall(this.store, rejected);
        this.publish(rejected);
        return rejected;
      };
      if (input.purpose === "queued") {
        if (this.store.getTaskQueue(session.id).revision !== input.expectedRevision) return reject("queue_conflict", "队列已改变，请刷新后重新选择");
        if (!task || task.sessionId !== session.id || !recallInputSupported(this.store, task) || this.store.taskInputPurpose(task.id) !== "user") return reject("unsupported_input", "该输入不支持从用户队列取回，请刷新队列");
        if (task.status !== "queued" || task.startedAt !== null || task.historyEntryIds.length > 0 || this.inputEnteredHistory({ sessionId: session.id }, task.id)) return reject("already_started", "输入已开始执行或已进入历史，不能从队列取回；请刷新队列");
        if (this.store.getTaskGuidance(task.id)?.state === "pending") return reject("guidance_pending", "输入正在接入引导，不能从用户队列取回");
      } else if (!task || candidate!.inputSeq !== input.expectedRevision) {
        return reject("stale_target", "目标已不再是最近可撤回输入；请刷新会话后重试");
      }
      if (candidate?.kind === "answer" || !recallInputSupported(this.store, task!)) {
        return reject("unsupported_input", "结构化提问卡片的回答暂不支持撤回，请手动重发更正");
      }
      // Only completion replaces edit-window ownership. If the previous window is still open, inherit
      // its saved queue state rather than treating the recall edit pause as the original state.
      const priorEdit = getEditWindowRecall(this.store, session.id);
      const savedQueueState = priorEdit && session.queuePauseReason === RECALL_EDIT_PAUSE_REASON ? priorEdit.savedQueueState : session.queueState;
      const savedQueueReason = priorEdit && session.queuePauseReason === RECALL_EDIT_PAUSE_REASON ? priorEdit.savedQueueReason : session.queuePauseReason;
      const attachments = this.store.taskAttachments(task.id).map(({ id, name, size }) => ({ id, name, size }));
      const accepted: MessageRecall = {
        id: randomUUID(), purpose: input.purpose, sessionId: session.id, requestId: input.requestId, paramsDigest: digest,
        targetTaskId: task!.id, inputSeq: candidate?.inputSeq ?? this.store.getTaskInputSeq(task!) ?? 0, expectedRevision: input.expectedRevision,
        execTaskId: null, phase: "accepted", stopTaskIds: [], sealedTaskIds: [], omittedEntryIds: null,
        historyFingerprint: null, originalInput: task.input, originalAttachments: attachments, draftAttachments: null,
        completionRevision: null, nextCandidateTaskId: null, editOpen: false,
        savedQueueState, savedQueueReason,
        error: null, createdAt: now, updatedAt: now,
      };
      insertMessageRecall(this.store, accepted);
      if (input.purpose === "queued") {
        this.completeQueued(accepted);
        return getMessageRecall(this.store, accepted.id)!;
      }
      this.store.setSessionQueueState(session.id, "paused", RECALL_PAUSE_REASON);
      this.store.appendEvent({ type: "session.queue_paused", sessionId: session.id, reason: RECALL_PAUSE_REASON }, { sessionId: session.id });
      this.publish(accepted);
      return accepted;
    });
    if (recall.phase === "accepted") void this.progressRecall(recall.id);
    return recall;
  }

  /**
   * Verify-only resumes stop verification under the original request key without changing its parameters, target or business work.
   * The owner explicitly confirms old execution has stopped; retained occupancy of terminal tasks and
   * stop_unverified backgrounds use the same release/re-stop verification semantics as resumeQueue.
   */
  async verifyMessageRecallStop(input: { sessionId: string; requestId: string }): Promise<MessageRecall> {
    const recall = findMessageRecall(this.store, input.sessionId, input.requestId);
    if (!recall) throw new RuntimeApiError("not_found", "撤回请求不存在，请核实原请求键");
    if (recall.phase === "completed" || recall.phase === "rejected") return recall;
    if (recall.purpose === "queued") throw new RuntimeApiError("invalid_state", "队列取回无需停止核实；请检查原取回回执和存储记录");
    this.store.withTx(() => {
      const current = getMessageRecall(this.store, recall.id)!;
      if (current.phase !== "blocked" && current.phase !== "stopping") return;
      const occupancy = new Set(this.store.listAllOccupancy().map(held => held.taskId));
      for (const taskId of current.stopTaskIds) {
        const task = this.store.getTask(taskId);
        if (!task || !isTerminalTaskStatus(task.status)) continue;
        if (occupancy.has(taskId)) {
          this.store.releaseOccupancy(taskId);
          const copy = workCopyHostFor(task);
          if (copy) this.store.db.prepare("UPDATE tasks SET read_scope = ? WHERE id = ?")
            .run(JSON.stringify({ ...task.readScope, workCopyHost: { ...copy, stopVerified: true } }), taskId);
        }
        // The owner confirms old execution stopped. Verify workflow executions of terminal tasks;
        // canceled runs have no live job, so this is their only path to advance verification.
        const execution = getWorkflowExecution(this.store, taskId);
        if (execution && execution.status !== "queued" && execution.stopVerified !== true && !occupancy.has(taskId)) {
          updateWorkflowExecution(this.store, taskId, { stopVerified: true });
        }
      }
      for (const process of listActiveBackgroundProcesses(this.store)) {
        if (current.stopTaskIds.includes(process.taskId)) this.deps.backgroundProcesses.requestStop(process.id, "message_recall");
      }
      if (current.phase === "blocked") {
        current.phase = "stopping";
        current.error = null;
        current.updatedAt = this.now();
        updateMessageRecall(this.store, current);
        this.publish(current);
      }
    });
    await this.progressRecall(recall.id);
    return this.store.withTx(() => getMessageRecall(this.store, recall.id)!);
  }

  messageRecallState(input: { sessionId: string; requestId?: string }): MessageRecallStateView {
    const candidate = recallCandidate(this.store, input.sessionId);
    const open = getOpenMessageRecall(this.store, input.sessionId);
    const edit = getEditWindowRecall(this.store, input.sessionId);
    const receipt = input.requestId
      ? findMessageRecall(this.store, input.sessionId, input.requestId)
      : (open ?? latestCompletedRecall(this.store, input.sessionId) ?? listMessageRecalls(this.store, input.sessionId).at(-1) ?? null);
    // Only the initiating key holder can lazily rebuild staged attachments from immutable bytes after completion.
    // Persist the result on the request so reconnecting queries return the same references.
    // Only the matching request key receives draft text and staged attachments.
    // Other clients see edit-window identity and revision, never its contents.
    const isInitiator = edit !== null && input.requestId !== undefined && edit.requestId === input.requestId;
    let draftAttachments: AttachmentMetadata[] = [];
    if (isInitiator && edit!.originalAttachments.length) {
      if (edit.draftAttachments === null) {
        draftAttachments = this.deps.attachments.restoreForRecall(edit);
        this.store.withTx(() => {
          const current = getMessageRecall(this.store, edit.id)!;
          if (current.phase === "completed" && current.draftAttachments === null) {
            current.draftAttachments = draftAttachments;
            current.updatedAt = this.now();
            updateMessageRecall(this.store, current);
          } else {
            draftAttachments = current.draftAttachments ?? [];
          }
        });
      } else {
        draftAttachments = edit.draftAttachments;
      }
    }
    return {
      candidate: candidate ? { kind: candidate.kind, taskId: candidate.task.id, inputSeq: candidate.inputSeq, ...(candidate.kind === "answer" ? { questionId: candidate.questionId } : {}) } as MessageRecallStateView["candidate"] : null,
      open: open ? publicMessageRecall(open) : null,
      edit: edit ? { recallId: edit.id, completionRevision: edit.completionRevision ?? 0, input: isInitiator ? edit.originalInput : "", attachments: draftAttachments } : null,
      receipt: receipt ? publicMessageRecall(receipt) : null,
    };
  }

  // Recall progression

  /** Advance a pending request; each phase is reentrant from persisted state. */
  async progressRecall(recallId: string): Promise<void> {
    const recall = getMessageRecall(this.store, recallId);
    if (!recall || recall.phase === "completed" || recall.phase === "rejected") return;
    try {
      if (recall.purpose === "queued") {
        this.verifyQueuedCompletion(recall);
        return;
      }
      if (recall.phase === "accepted") await this.adjudicate(recall);
      const current = getMessageRecall(this.store, recallId);
      if (!current || current.phase === "completed" || current.phase === "rejected") return;
      if (current.phase === "stopping" || current.phase === "blocked") await this.stopClosure(current);
      const afterStop = getMessageRecall(this.store, recallId);
      if (!afterStop || afterStop.phase === "completed" || afterStop.phase === "rejected") return;
      if (afterStop.phase === "applying") await this.applyAndComplete(afterStop);
    } catch (err) {
      this.block(recallId, err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "stop_unverified", (err as Error).message);
    }
  }

  /** On startup, advance pending requests and verify JSONL completion markers for completed receipts. */
  async recoverAll(): Promise<void> {
    const all = this.store.db.prepare("SELECT id FROM message_recalls").all() as Array<{ id: string }>;
    for (const row of all) {
      const recall = getMessageRecall(this.store, String(row.id));
      if (!recall) continue;
      if (recall.phase === "completed") {
        try {
          if (recall.purpose === "queued" || recall.execTaskId === null && recall.omittedEntryIds?.length === 0) this.verifyQueuedCompletion(recall);
          else this.verifyCompletionMarker(recall);
        } catch (err) {
          this.store.withTx(() => {
            const current = getMessageRecall(this.store, recall.id)!;
            current.phase = "blocked";
            current.editOpen = false;
            current.error = { code: "history_unverified", message: `重启后未能核实撤回标记：${(err as Error).message}` };
            current.updatedAt = this.now();
            updateMessageRecall(this.store, current);
            this.store.setSessionQueueState(current.sessionId, "paused", RECALL_PAUSE_REASON);
            this.store.appendEvent({ type: "session.queue_paused", sessionId: current.sessionId, reason: RECALL_PAUSE_REASON }, { sessionId: current.sessionId });
            this.publish(current);
          });
        }
        continue;
      }
      if (recall.phase === "rejected") continue;
      // Keep the queue paused while recovering pending requests.
      this.store.withTx(() => {
        const session = this.store.getSession(recall.sessionId);
        if (session && session.queueState !== "paused") {
          this.store.setSessionQueueState(recall.sessionId, "paused", RECALL_PAUSE_REASON);
          this.store.appendEvent({ type: "session.queue_paused", sessionId: recall.sessionId, reason: RECALL_PAUSE_REASON }, { sessionId: recall.sessionId });
        }
      });
      await this.progressRecall(recall.id);
    }
  }

  // Target adjudication

  /** Determine whether the target remains outside effective history (fast path) or requires stopping its execution. */
  private async adjudicate(recall: MessageRecall): Promise<void> {
    const task = this.store.getTask(recall.targetTaskId);
    if (!task) return this.block(recall.id, "target_missing", "撤回目标已不存在，请核实会话记录");
    // Wait for pending guidance to settle in JSONL: adopted input requires stopping; unadopted input takes the fast path.
    let guidance = this.store.getTaskGuidance(task.id);
    if (guidance?.state === "pending") {
      await this.deps.driverFor(recall.sessionId)?.waitGuidanceSource(task.id);
      guidance = this.store.getTaskGuidance(task.id);
    }
    if (guidance?.state === "joined") {
      this.fixClosure(recall, guidance.targetTaskId);
      return;
    }
    const entered = this.inputEnteredHistory(recall, task.id);
    if (task.status === "queued" && !entered) {
      this.store.withTx(() => this.completeQueued(recall));
      return;
    }
    this.fixClosure(recall, task.id);
  }

  /** Whether authoritative JSONL contains the target's own input or adopted guidance entry. */
  private inputEnteredHistory(recall: Pick<MessageRecall, "sessionId">, taskId: string): boolean {
    const session = this.store.getSession(recall.sessionId);
    const file = session?.sessionFile;
    if (!file) return false;
    if (!fs.existsSync(file)) throw new HistoryReadError("history_missing", "会话历史文件缺失，无法核实输入是否已经接入");
    const { entries } = parseSessionFileStrict(fs.readFileSync(file, "utf8"));
    return entries.some(entry => entry.type === "message"
      && ((entry.message as { ruukotoTaskId?: unknown; ruukotoSourceTaskId?: unknown } | undefined)?.ruukotoTaskId === taskId
        || (entry.message as { ruukotoTaskId?: unknown; ruukotoSourceTaskId?: unknown } | undefined)?.ruukotoSourceTaskId === taskId));
  }

  /** The caller holds a Store transaction; cancel unadmitted input without JSONL edits. */
  private completeQueued(recall: MessageRecall): void {
    const task = this.store.getTask(recall.targetTaskId);
    if (task?.status === "queued") {
      this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: "message_recall", endedAt: this.now() });
      invalidateOwnerQuestionsForTask(this.store, task.id);
    }
    this.finishRecall(recall, null);
  }

  /** Queue retrieval commits cancellation and completion together, so recovery never needs a JSONL marker. */
  private verifyQueuedCompletion(recall: MessageRecall): void {
    const task = this.store.getTask(recall.targetTaskId);
    if (recall.phase !== "completed" || recall.execTaskId !== null || recall.stopTaskIds.length || recall.sealedTaskIds.length || recall.omittedEntryIds?.length !== 0 || !task || task.sessionId !== recall.sessionId || task.status !== "canceled" || task.errorMessage !== "message_recall" || task.startedAt !== null || task.historyEntryIds.length || this.inputEnteredHistory(recall, task.id)) throw new HistoryReadError("history_corrupt", "队列取回的取消记录无法核实，请保留档案并检查存储");
  }

  // Execution closure and stopping

  /**
   * Fix the execution closure and seal its sources transactionally before stopping members, preventing new derived work.
   * Include the execution task, derived host-task tree, delegations and their tasks, workflow runs/executions, and background-owning tasks.
   * Reject untrusted ownership discovered later rather than silently omitting a stop.
   */
  private fixClosure(recall: MessageRecall, execTaskId: string): void {
    this.store.withTx(() => {
      const current = getMessageRecall(this.store, recall.id)!;
      const closure = this.discoverClosure(execTaskId);
      current.execTaskId = execTaskId;
      current.stopTaskIds = closure;
      current.sealedTaskIds = closure;
      current.phase = "stopping";
      current.updatedAt = this.now();
      updateMessageRecall(this.store, current);
      this.publish(current);
    });
  }

  /** Build the ownership closure; retain derived links with unresolved sources for stopping and verification. */
  private discoverClosure(execTaskId: string): string[] {
    const closure = new Set<string>([execTaskId]);
    const grow = () => {
      let added = false;
      for (const task of this.store.listTasksBySession(this.store.getTask(execTaskId)!.sessionId)) {
        if (closure.has(task.id)) continue;
        if (task.parentTaskId && closure.has(task.parentTaskId)) { closure.add(task.id); added = true; }
      }
      // Include derived tasks in SubAgent work contexts and workflow execution conversations.
      for (const task of this.store.listTasksByStatus(["queued", "running", "awaiting_confirmation", "completed", "failed", "canceled", "interrupted"])) {
        if (closure.has(task.id)) continue;
        if (task.parentTaskId && closure.has(task.parentTaskId)) { closure.add(task.id); added = true; continue; }
        if (task.workId) {
          const work = this.store.getWorkDelegation(task.workId);
          if (work && closure.has(work.originTaskId)) { closure.add(task.id); added = true; continue; }
        }
        // Include delivery tasks derived from SubAgent messages sent by closure members.
        const message = this.store.db.prepare("SELECT from_task_id FROM subagent_messages WHERE delivered_task_id = ?").get(task.id) as { from_task_id: string } | undefined;
        if (message && closure.has(message.from_task_id)) { closure.add(task.id); added = true; continue; }
        const execution = getWorkflowExecution(this.store, task.id);
        if (execution) {
          const run = this.store.db.prepare("SELECT payload FROM workflow_runs WHERE id = ?").get(execution.runId) as { payload: string } | undefined;
          const source = run ? (JSON.parse(run.payload) as { source?: { taskId?: string } }).source?.taskId : null;
          if (source && closure.has(source)) { closure.add(task.id); added = true; }
        }
        const delivery = this.store.db.prepare("SELECT payload FROM workflow_runs WHERE json_extract(payload, '$.delivery.taskId') = ?").get(task.id) as { payload: string } | undefined;
        if (delivery) {
          const run = JSON.parse(delivery.payload) as { source?: { taskId?: string } };
          if (run.source?.taskId && closure.has(run.source.taskId)) { closure.add(task.id); added = true; }
        }
      }
      return added;
    };
    while (grow()) { /* Expand to the transitive closure. */ }
    return [...closure];
  }

  /** Stop and verify the entire closure; unverified members leave it blocked for verify-only retries. */
  private async stopClosure(recall: MessageRecall): Promise<void> {
    const stopping: string[] = [];
    // Stop workflow runs first because they own their executions, then stop remaining tasks and backgrounds.
    const runs = new Set<string>();
    for (const taskId of recall.stopTaskIds) {
      const execution = getWorkflowExecution(this.store, taskId);
      if (execution) runs.add(execution.runId);
    }
    for (const runId of runs) {
      const run = requireWorkflowRun(this.store, runId);
      if (workflowTerminal(run.status)) continue;
      try {
        // Run-level stopping cancels queued executions and reaps/verifies running ones through the workflow stop path.
        const workflows = this.deps.workflows();
        if (!workflows) throw new RuntimeApiError("stop_unverified", "工作流运行未收束且当前装配无法核实其停止");
        await workflows.control(runId, `recall:${recall.id}:${runId}`, run.version, { action: "cancel" });
      } catch (err) {
        const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "";
        // Stop is best-effort: subsequent verification handles terminal-state or version-conflict WorkflowErrors.
        if (!(err instanceof WorkflowError) && !["verification_required", "run_terminal", "version_conflict"].includes(code)) throw err;
      }
    }
    // Cancel derived work delegations; their active tasks use the host stop path.
    const subagents = this.deps.subagents();
    if (subagents) {
      for (const work of this.store.listWorkDelegations()) {
        if (!recall.stopTaskIds.includes(work.originTaskId)) continue;
        if (work.canceledAt) continue;
        try {
          await subagents.cancelWork({ workId: work.id, by: "owner", reason: "message_recall", parentSessionId: work.parentSessionId });
        } catch (err) {
          if (!(err instanceof SubAgentDelegationError)) throw err;
        }
      }
    }
    for (const taskId of recall.stopTaskIds) {
      const task = this.store.getTask(taskId);
      if (task) await this.stopTask(task);
    }
    for (const process of listActiveBackgroundProcesses(this.store)) {
      if (!recall.stopTaskIds.includes(process.taskId)) continue;
      this.deps.backgroundProcesses.requestStop(process.id, "message_recall");
    }
    for (const taskId of recall.stopTaskIds) {
      this.deps.agentWait.interrupt(taskId, "message_recall");
      this.store.withTx(() => {
        invalidateOwnerQuestionsForTask(this.store, taskId);
        this.store.stalePendingConfirmations(taskId);
      });
    }
    // Retain pending messages in the ledger but prevent injection into recalled parent turns.
    for (const message of this.store.db.prepare(
      "SELECT id, from_task_id FROM subagent_messages WHERE delivered_at IS NULL AND undelivered_reason IS NULL",
    ).all() as Array<{ id: string; from_task_id: string }>) {
      if (recall.stopTaskIds.includes(message.from_task_id)) {
        this.store.markSubAgentMessageUndelivered(message.id, "message_recall");
      }
    }
    // Verify terminal tasks, released occupancy, verified workflow executions and stopped backgrounds.
    const deadline = Date.now() + STOP_VERIFY_WAIT_MS;
    for (;;) {
      const problems = this.unverifiedUnits(recall);
      if (!problems.length) break;
      if (Date.now() > deadline) {
        return this.block(recall.id, "stop_unverified", `停止未核实：${problems.join("；")}`);
      }
      await new Promise(r => setTimeout(r, STOP_VERIFY_POLL_MS));
    }
    this.store.withTx(() => {
      const current = getMessageRecall(this.store, recall.id)!;
      if (current.phase !== "stopping" && current.phase !== "blocked") return;
      current.phase = "applying";
      current.updatedAt = this.now();
      updateMessageRecall(this.store, current);
      this.publish(current);
    });
  }

  private async stopTask(task: Task): Promise<void> {
    if (task.status === "queued") {
      this.store.withTx(() => {
        this.store.endTask(task.id, ["queued"], "canceled", { errorMessage: "message_recall", endedAt: this.now() });
        invalidateOwnerQuestionsForTask(this.store, task.id);
      });
      return;
    }
    if (isTerminalTaskStatus(task.status)) return;
    const hostExecutions = this.deps.hostExecutions();
    if (hostExecutions?.has(task.id)) {
      await hostExecutions.stop(task.id, "canceled", "message_recall");
      return;
    }
    const driver = this.deps.driverFor(task.sessionId) ?? await this.deps.ensureDriver(this.store.getSession(task.sessionId)!);
    this.store.withTx(() => {
      this.store.setCancelRequested(task.id, true);
      invalidateOwnerQuestionsForTask(this.store, task.id);
    });
    await driver.requestStop(task, { terminal: "canceled", reason: "message_recall", cancelIntent: true });
  }

  /** Human-readable unverified units; an empty list means stop verification succeeded. */
  private unverifiedUnits(recall: MessageRecall): string[] {
    const problems: string[] = [];
    const occupancy = new Set(this.store.listAllOccupancy().map(held => held.taskId));
    for (const taskId of recall.stopTaskIds) {
      const task = this.store.getTask(taskId);
      if (!task) continue;
      if (!isTerminalTaskStatus(task.status)) problems.push(`任务 ${taskId} 仍为 ${task.status}`);
      if (occupancy.has(taskId)) problems.push(`任务 ${taskId} 占用未释放`);
      const execution = getWorkflowExecution(this.store, taskId);
      if (execution) {
        const run = requireWorkflowRun(this.store, execution.runId);
        // Match runtime verification: non-queued executions require explicit verification; null is unverified.
        if (!workflowTerminal(run.status) || (execution.status !== "queued" && execution.stopVerified !== true)) {
          problems.push(`工作流执行 ${taskId} 未核实停止`);
        }
      }
    }
    for (const process of listActiveBackgroundProcesses(this.store)) {
      if (recall.stopTaskIds.includes(process.taskId)) problems.push(`后台进程 ${process.id} 状态 ${process.state} 未核实`);
    }
    return [...new Set(problems)];
  }

  private block(recallId: string, code: string, message: string): void {
    this.store.withTx(() => {
      const current = getMessageRecall(this.store, recallId);
      if (!current || current.phase === "completed" || current.phase === "rejected") return;
      current.phase = "blocked";
      current.error = { code, message };
      current.updatedAt = this.now();
      updateMessageRecall(this.store, current);
      this.store.setSessionQueueState(current.sessionId, "paused", RECALL_PAUSE_REASON);
      this.publish(current);
    });
  }

  // Omission list and JSONL edits

  /** Fix final contributions and append context_edit records; recovery idempotently skips already edited targets. */
  private async applyAndComplete(recall: MessageRecall): Promise<void> {
    const session = this.store.getSession(recall.sessionId);
    const file = session?.sessionFile;
    if (!file || !fs.existsSync(file)) {
      return this.block(recall.id, "history_missing", "撤回目标的历史文件缺失，无法核实省略范围");
    }
    if (recall.omittedEntryIds === null) {
      // Fix effective contributions from the target onward; a guidance target preserves the preceding request and tool pairs.
      const bytes = fs.readFileSync(file);
      const completeBytes = bytes.lastIndexOf(10) + 1;
      const { entries } = parseSessionFileStrict(bytes.subarray(0, completeBytes).toString("utf8"));
      const projection = effectiveProjection(entries);
      const targetIndex = this.targetEntryIndex(recall, entries);
      if (targetIndex === null) {
        // If the target never entered history despite requiring a full stop, complete through the fast path.
        return this.store.withTx(() => this.completeQueued(recall));
      }
      const manifest: string[] = [];
      for (let i = targetIndex; i < entries.length; i++) {
        const entry = entries[i]!;
        if (isEditableContribution(entry) && !projection.omitted.has(entry.id)) manifest.push(entry.id);
        // Recheck eligibility after freezing; reject if later effective owner input remains.
        if (i > targetIndex && entry.type === "message" && (entry.message as { role?: unknown })?.role === "user") {
          const message = entry.message as { ruukotoTaskId?: unknown; ruukotoSourceTaskId?: unknown };
          const ownerTask = typeof message.ruukotoSourceTaskId === "string" ? message.ruukotoSourceTaskId
            : typeof message.ruukotoTaskId === "string" ? message.ruukotoTaskId : null;
          if (ownerTask && ownerTask !== recall.targetTaskId) {
            const task = this.store.getTask(ownerTask);
            if (task && task.sessionId === recall.sessionId && !isRecallSealedTask(this.store, ownerTask)) {
              return this.rejectLate(recall, "later_input_exists", "目标输入之后仍有其他有效拥有者输入，不能撤回");
            }
          }
        }
      }
      const prefix = bytes.subarray(0, completeBytes);
      const stat = fs.statSync(file);
      const fingerprint = { dev: stat.dev, ino: stat.ino, byteLimit: completeBytes, fingerprint: createHash("sha256").update(prefix).digest("hex") };
      this.store.withTx(() => {
        const current = getMessageRecall(this.store, recall.id)!;
        if (current.phase !== "applying") return;
        // Finally verify the target is still the latest unrecalled input.
        const candidate = recallCandidate(this.store, recall.sessionId);
        if (!candidate || candidate.kind !== "task" || candidate.task.id !== recall.targetTaskId) {
          current.phase = "rejected";
          current.error = { code: "stale_target", message: "冻结点时目标已不再是最近可撤回输入" };
          current.updatedAt = this.now();
          updateMessageRecall(this.store, current);
          const session = this.store.getSession(current.sessionId);
          if (session?.queuePauseReason === RECALL_PAUSE_REASON) {
            this.restoreQueueState(current.sessionId, current.savedQueueState, current.savedQueueReason);
          }
          this.publish(current);
          return;
        }
        current.omittedEntryIds = manifest;
        current.historyFingerprint = fingerprint;
        current.updatedAt = this.now();
        updateMessageRecall(this.store, current);
        this.publish(current);
      });
    }
    const fixed = getMessageRecall(this.store, recall.id)!;
    if (fixed.phase !== "applying" || fixed.omittedEntryIds === null) return;
    const manifest = fixed.omittedEntryIds;
    const fingerprint = fixed.historyFingerprint!;
    // Verify the history prefix still matches the fixed fingerprint before applying edits.
    const stat = fs.statSync(file);
    if (stat.dev !== fingerprint.dev || stat.ino !== fingerprint.ino || stat.size < fingerprint.byteLimit) {
      return this.block(recall.id, "history_changed", "历史来源已替换，无法核实撤回范围");
    }
    const fd = fs.openSync(file, "r");
    let manager: SessionManager;
    try {
      const prefix = Buffer.alloc(fingerprint.byteLimit);
      let off = 0;
      while (off < fingerprint.byteLimit) {
        const count = fs.readSync(fd, prefix, off, fingerprint.byteLimit - off, off);
        if (!count) throw new HistoryReadError("history_changed", "历史前缀读取不完整");
        off += count;
      }
      if (createHash("sha256").update(prefix).digest("hex") !== fingerprint.fingerprint) {
        return this.block(recall.id, "history_changed", "历史前缀在撤回期间改变，保留原档案待核实");
      }
    } finally { fs.closeSync(fd); }
    manager = SessionManager.open(file, this.deps.sessionsDir);
    const already = new Set<string>();
    for (const entry of manager.getEntries()) {
      if (entry.type === "context_edit" && typeof (entry as { targetId?: unknown }).targetId === "string") {
        already.add(String((entry as { targetId?: unknown }).targetId));
      }
    }
    for (const entryId of manifest) {
      if (!already.has(entryId)) manager.appendContextEdit(entryId, null);
    }
    const markerExists = manager.getEntries().some(entry => entry.type === "custom" && entry.customType === MESSAGE_RECALL_MARKER
      && (entry.data as { recallId?: unknown } | undefined)?.recallId === recall.id);
    if (!markerExists) {
      manager.appendCustomEntry(MESSAGE_RECALL_MARKER, {
        recallId: recall.id, taskId: recall.targetTaskId, sessionId: recall.sessionId,
        completionRevision: nextCompletionRevision(this.store, recall.sessionId),
      });
    }
    const flush = fs.openSync(file, "r");
    try { fs.fsyncSync(flush); } finally { fs.closeSync(flush); }
    this.verifyCompletionMarker({ ...fixed, omittedEntryIds: manifest });
    // Discard the old SDK instance so the next run reopens effective history without reviving omissions.
    await this.deps.disposeDriver(recall.sessionId);
    new HistoryIndex(this.store.db).sync(recall.sessionId, file);
    this.store.withTx(() => this.finishRecall(getMessageRecall(this.store, recall.id)!, manifest));
    this.deps.kick(recall.sessionId);
  }

  /** Locate adopted guidance by its entry and ordinary input by its own entry. */
  private targetEntryIndex(recall: MessageRecall, entries: ReturnType<typeof parseSessionFileStrict>["entries"]): number | null {
    const guidance = this.store.getTaskGuidance(recall.targetTaskId);
    if (guidance?.state === "joined" && guidance.entryId) {
      const index = entries.findIndex(entry => entry.id === guidance.entryId);
      if (index >= 0) return index;
    }
    const index = entries.findIndex(entry => entry.type === "message"
      && ((entry.message as { ruukotoTaskId?: unknown; ruukotoSourceTaskId?: unknown } | undefined)?.ruukotoTaskId === recall.targetTaskId
        || (entry.message as { ruukotoTaskId?: unknown; ruukotoSourceTaskId?: unknown } | undefined)?.ruukotoSourceTaskId === recall.targetTaskId));
    return index >= 0 ? index : null;
  }

  /** Verify a completed receipt against JSONL: every omission has an edit and the completion marker exists. */
  private verifyCompletionMarker(recall: MessageRecall): void {
    const session = this.store.getSession(recall.sessionId);
    const file = session?.sessionFile;
    if (!file || !fs.existsSync(file)) throw new HistoryReadError("history_missing", "会话历史文件不存在");
    const { entries } = parseSessionFileStrict(fs.readFileSync(file, "utf8"));
    const edits = new Set<string>();
    let marker = false;
    for (const entry of entries) {
      if (entry.type === "context_edit" && typeof (entry as { targetId?: unknown }).targetId === "string") edits.add(String((entry as { targetId?: unknown }).targetId));
      if (entry.type === "custom" && entry.customType === MESSAGE_RECALL_MARKER && (entry.data as { recallId?: unknown } | undefined)?.recallId === recall.id) marker = true;
    }
    if (!marker) throw new HistoryReadError("history_corrupt", "撤回完成标记缺失");
    for (const id of recall.omittedEntryIds ?? []) {
      if (!edits.has(id)) throw new HistoryReadError("history_corrupt", `省略记录缺失：${id}`);
    }
  }

  /** Commit completion revision, next candidate, edit window, pause state and event in one transaction. */
  private finishRecall(recall: MessageRecall, manifest: string[] | null): void {
    const current = getMessageRecall(this.store, recall.id)!;
    if (current.phase === "completed" || current.phase === "rejected") return;
    closeEditWindows(this.store, current.sessionId, this.now());
    current.phase = "completed";
    current.completionRevision = nextCompletionRevision(this.store, current.sessionId);
    current.omittedEntryIds = manifest ?? current.omittedEntryIds ?? [];
    current.editOpen = true;
    current.error = null;
    current.updatedAt = this.now();
    updateMessageRecall(this.store, current);
    // Compute the next candidate after persisting completed, or recalledInputTaskIds would select this target again.
    current.nextCandidateTaskId = recallCandidate(this.store, current.sessionId)?.task.id ?? null;
    updateMessageRecall(this.store, current);
    if (current.purpose === "historical") {
      this.store.setSessionQueueState(current.sessionId, "paused", RECALL_EDIT_PAUSE_REASON);
      this.store.appendEvent({ type: "session.queue_paused", sessionId: current.sessionId, reason: RECALL_EDIT_PAUSE_REASON }, { sessionId: current.sessionId });
    }
    this.publish(current);
  }

  private rejectLate(recall: MessageRecall, code: string, message: string): void {
    this.store.withTx(() => {
      const current = getMessageRecall(this.store, recall.id)!;
      if (current.phase === "completed" || current.phase === "rejected") return;
      current.phase = "rejected";
      current.error = { code, message };
      current.editOpen = false;
      current.updatedAt = this.now();
      updateMessageRecall(this.store, current);
      // Rejection retains the previous successful identity and restores the queue state saved before acceptance.
      const session = this.store.getSession(current.sessionId);
      if (session?.queuePauseReason === RECALL_PAUSE_REASON) {
        this.restoreQueueState(current.sessionId, current.savedQueueState, current.savedQueueReason);
      }
      this.publish(current);
    });
  }
}
