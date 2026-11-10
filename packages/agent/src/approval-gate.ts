/** Approval registration, owner or auto-review decisions, and atomic single-use consumption. */

import type { ApprovalScope, ConfirmationRequest, Task, ToolAuthorization } from "@ruukoto/core/types.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import type { ToolOpLedger } from "./tool-op-ledger.ts";
import { classifyForReview, ReviewAbortedError, REVIEW_POLICY_VERSION, type ApprovalReviewer } from "./review.ts";

type ConfirmationDecision = "approved" | "rejected" | "canceled" | "superseded";

export interface ApprovalRequest<T> {
  task: Task;
  hostOpId: string;
  toolName: string;
  params: Record<string, unknown>;
  scope: ApprovalScope;
  signal?: AbortSignal;
  /** 获批后复核：同步，在消费事务内、条件更新之前执行；返回原因即放弃消费。不得再开核心库事务。 */
  recheck?: () => string | null;
  /** Local effects committed in the consumption transaction; throws roll back the transaction. */
  commit?: (approvalId: string | null, authorization: ToolAuthorization) => T;
}

/** 批准：审批 id、审批记录保存的参数快照与 commit 的返回值；否则为已知未执行的文案。 */
export type ApprovalResult<T> =
  | { approved: true; approvalId: string | null; authorization: ToolAuthorization; params: Record<string, unknown>; value: T }
  | { approved: false; text: string };

/** 未批准的已知未执行文案（落库与返回给模型的是同一句；自动拒绝不得显示成"拥有者拒绝"）。 */
function notExecutedText(
  toolName: string,
  decision: "rejected" | "canceled" | "superseded",
  source: string | null,
  reviewReason: string | null,
): string {
  if (decision === "rejected") {
    return source === "auto_review" ? `自动审查拒绝执行 ${toolName}：${reviewReason ?? "未给出理由"}` : `拥有者拒绝执行 ${toolName}`;
  }
  return decision === "superseded"
    ? `审批已失效（输入引导、模式切换或任务停止），${toolName} 未执行；如仍需要请重新申请`
    : `任务停止，确认等待解除（${toolName} 未执行）`;
}

export interface ApprovalGateDeps {
  store: Store;
  ledger: ToolOpLedger;
  /** 自动审查器（模型配置变化时由 Driver 替换，每次读取当前值）。 */
  reviewer(): ApprovalReviewer | undefined;
  /** Recheck source authority inside the consumption transaction; a reason invalidates approval. */
  consumeRecheck?: (confirmation: ConfirmationRequest, task: Task) => string | null;
}

export class ApprovalGate {
  private readonly deps: ApprovalGateDeps;
  private waiters = new Map<string, { task: Task; resolve: (decision: ConfirmationDecision) => void }>();
  private pendingCount = 0;
  /** 进行中的自动审查（按审批 id）；人工接管/停止时中止，迟到结果忽略。 */
  private reviewAborters = new Map<string, AbortController>();

  constructor(deps: ApprovalGateDeps) {
    this.deps = deps;
  }

  /**
   * 审批请求全程：登记并等待决定（auto-review 任务先经自动审查）；获批后在同一
   * 事务内复核、单次消费并提交本地效果。未批准、复核失败与消费失败都交回
   * 「已知未执行」文案（未批准的由闸门记入工具结果，其余由调用方原样返回）。
   */
  async request<T = void>(input: ApprovalRequest<T>): Promise<ApprovalResult<T>> {
    if (input.task.accessMode === "full_access") return this.authorizeFullAccess(input);
    const waited = await this.wait(input);
    if (!waited.approved) return waited;
    return this.consume(input, waited.confirmationId);
  }

  /** 等待决定但保留未消费状态；stdio 在实际写管道前调用 consumeDeferred，并同事务保存原请求。 */
  async defer<T>(input: ApprovalRequest<T>): Promise<{ approved: true; confirmationId: string | null; params: Record<string, unknown> } | { approved: false; text: string }> {
    if (input.task.accessMode === "full_access") return { approved: true, confirmationId: null, params: structuredClone(input.params) };
    const waited = await this.wait(input);
    return waited.approved ? { ...waited, params: this.deps.store.getConfirmation(waited.confirmationId)!.params } : waited;
  }

  consumeDeferred<T>(input: ApprovalRequest<T>, confirmationId: string | null): ApprovalResult<T> {
    return confirmationId === null ? this.authorizeFullAccess(input) : this.consume(input, confirmationId);
  }

  // Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md
  private authorizeFullAccess<T>(input: ApprovalRequest<T>): ApprovalResult<T> {
    const store = this.deps.store;
    const params = structuredClone(input.params);
    return store.withTx(() => {
      const task = store.getTask(input.task.id);
      const reason = !task || task.status !== "running" || task.cancelRequested || input.signal?.aborted ||
        task.accessMode !== "full_access" || task.permissionVersion !== input.task.permissionVersion
        ? `任务已停止或权限已变化，${input.toolName} 未执行`
        : input.recheck?.() ?? null;
      if (reason) {
        this.recordNotExecuted(input, reason);
        return { approved: false, text: reason };
      }
      const authorization: ToolAuthorization = {
        source: "full_access", taskId: input.task.id, permissionVersion: input.task.permissionVersion, scope: structuredClone(input.scope),
      };
      if (!store.authorizeToolOp(input.hostOpId, input.task.sessionId, authorization)) {
        return { approved: false, text: `操作已被认领或没有本任务的执行意图，${input.toolName} 未执行` };
      }
      const value = input.commit ? input.commit(null, authorization) : (undefined as T);
      return { approved: true, approvalId: null, authorization, params, value };
    });
  }

  private async wait(input: ApprovalRequest<unknown>): Promise<{ approved: true; confirmationId: string } | { approved: false; text: string }> {
    const store = this.deps.store;
    // 自动审查只覆盖 auto-review 任务且需要任务固定的模型配置；缺任一条件退化为纯人工
    const reviewSelection =
      input.task.accessMode === "auto-review" && this.deps.reviewer() ? input.task.modelSelection : null;
    const created = store.withTx(() => {
      const c = store.createConfirmation({
        taskId: input.task.id,
        sessionId: input.task.sessionId,
        toolOpId: input.hostOpId,
        toolName: input.toolName,
        params: input.params,
        scope: input.scope,
        permissionVersion: input.task.permissionVersion,
        review: reviewSelection
          ? { model: `${reviewSelection.provider}/${reviewSelection.modelId}`, policyVersion: REVIEW_POLICY_VERSION }
          : undefined,
      });
      // 目标已受理引导：受理后迟到的审批同批失效——不进入等待、不通知拥有者，
      // 也不能挡住接入边界或被抢先消费（记录保留作证据）。
      const guided = store.listTaskGuidance(input.task.id).some(route => route.state === "pending");
      if (guided) return { confirmation: c, guided };
      store.transitionTask(input.task.id, ["running"], "awaiting_confirmation", {});
      return { confirmation: c, guided };
    });
    const confirmation = created.confirmation;
    if (created.guided) {
      store.invalidateConfirmation(confirmation.id);
      const text = notExecutedText(input.toolName, "superseded", null, null);
      store.withTx(() => this.recordNotExecuted(input, text));
      return { approved: false, text };
    }

    if (input.signal?.aborted) {
      // 只动本审批；其他仍在等待的审批照常计数
      const text = notExecutedText(input.toolName, "superseded", null, null);
      store.withTx(() => {
        store.invalidateConfirmation(confirmation.id);
        this.recordNotExecuted(input, text);
        if (this.pendingCount === 0) store.transitionTask(input.task.id, ["awaiting_confirmation"], "running", {});
      });
      return { approved: false, text };
    }

    this.pendingCount++;
    const onAbort = () => this.waiters.get(confirmation.id)?.resolve("superseded");
    try {
      const decisionPromise = new Promise<ConfirmationDecision>((resolve) => {
        this.waiters.set(confirmation.id, { task: input.task, resolve });
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
      // 等待者注册后再启动自动审查，避免审查同步完成时结果无处投递
      if (reviewSelection) {
        void this.runAutoReview(confirmation, input.task, input).catch(() => {
          // 审查失败不得打断审批等待；可落盘的失败已在 runAutoReview 内转人工
        });
      }
      const decision = await decisionPromise;
      if (decision === "approved") return { approved: true, confirmationId: confirmation.id };
      // 自动拒绝不能显示成"拥有者拒绝"：重读落库的来源与理由（与决定同事务写入）
      const resolved = store.getConfirmation(confirmation.id);
      const text = notExecutedText(input.toolName, decision, resolved?.decisionSource ?? null, resolved?.reviewReason ?? null);
      // 未批准 = 已知未执行（拒绝/取消/失效都不产生外部效果）
      store.withTx(() => this.recordNotExecuted(input, text));
      return { approved: false, text };
    } finally {
      this.waiters.delete(confirmation.id);
      input.signal?.removeEventListener("abort", onAbort);
      // 等待结束（含人工抢先/取消/模式切换）：中止仍在进行的审查，迟到结果忽略
      const aborter = this.reviewAborters.get(confirmation.id);
      if (aborter) {
        aborter.abort();
        this.reviewAborters.delete(confirmation.id);
      }
      this.pendingCount--;
      if (this.pendingCount === 0) {
        store.withTx(() => {
          store.transitionTask(input.task.id, ["awaiting_confirmation"], "running", {});
        });
      }
    }
  }

  /**
   * 获批后：同一事务内复核 → 单次消费（条件更新：批准未消费、权限版本匹配、
   * 任务仍活动；消费即执行开始）→ 事件 → 提交本地效果。复核或消费失败、
   * recheck/commit 抛错都使批准失效（stale），操作按已知未执行。
   */
  private consume<T>(input: ApprovalRequest<T>, confirmationId: string): ApprovalResult<T> {
    const store = this.deps.store;
    // 执行参数取自审批记录保存的快照
    const confirmation = store.getConfirmation(confirmationId)!;
    try {
      return store.withTx((): ApprovalResult<T> => {
        const reason = input.recheck?.() ?? null;
        if (reason) {
          store.invalidateConfirmation(confirmationId);
          return { approved: false, text: reason };
        }
        const sourceReason = this.deps.consumeRecheck?.(confirmation, input.task) ?? null;
        if (sourceReason) {
          store.invalidateConfirmation(confirmationId);
          return { approved: false, text: sourceReason };
        }
        const ok = store.consumeApproval({
          confirmationId,
          expectedPermissionVersion: confirmation.permissionVersion,
          activeStatuses: ["running", "awaiting_confirmation"],
        });
        if (!ok) {
          store.invalidateConfirmation(confirmationId);
          return { approved: false, text: `批准已失效（任务结束、权限版本变化或已被消费），${input.toolName} 未执行` };
        }
        store.appendEvent(
          {
            type: "task.approval_consumed",
            taskId: input.task.id,
            confirmationId,
            toolOpId: input.hostOpId,
            toolName: input.toolName,
          },
          { taskId: input.task.id, sessionId: input.task.sessionId },
        );
        const authorization: ToolAuthorization = {
          source: "approval", taskId: input.task.id, permissionVersion: confirmation.permissionVersion,
          confirmationId, scope: confirmation.scope,
        };
        if (!store.authorizeToolOp(input.hostOpId, input.task.sessionId, authorization)) {
          throw new RuntimeApiError("tool_authorization_conflict", "批准消费时工具操作未能单次认领");
        }
        const value = input.commit ? input.commit(confirmationId, authorization) : (undefined as T);
        return { approved: true, approvalId: confirmationId, authorization, params: confirmation.params, value };
      });
    } catch (err) {
      // 整笔回滚（未消费、未提交）：批准失效，错误原样交回调用方
      try {
        store.withTx(() => store.invalidateConfirmation(confirmationId));
      } catch {
        // 失效标记写不进去时批准保持未消费（仍是已知未执行），不遮住原始错误
      }
      throw err;
    }
  }

  private recordNotExecuted(input: { task: Task; hostOpId: string }, text: string): void {
    this.deps.ledger.recordResult(input.task, input.hostOpId, text, true);
  }

  /** Persist the owner decision and audit event together, then wake the waiter after commit. */
  resolve(confirmationId: string, decision: "approved" | "rejected"): boolean {
    const waiter = this.waiters.get(confirmationId);
    if (!waiter) return false;
    const store = this.deps.store;
    const applied = store.withTx(() => {
      const ok = store.respondConfirmation(confirmationId, decision, { source: "owner" });
      if (!ok) return false;
      store.appendEvent(
        {
          type: "task.confirmation_resolved",
          taskId: waiter.task.id,
          confirmationId,
          decision,
          source: "owner",
        },
        { taskId: waiter.task.id, sessionId: waiter.task.sessionId },
      );
      return true;
    });
    if (!applied) return false;
    waiter.resolve(decision);
    return true;
  }

  /** 模式切换应用前解除全部等待：审批失效，后续执行重新判定。 */
  supersedeAll(): void {
    for (const w of this.waiters.values()) w.resolve("superseded");
    this.waiters.clear();
  }

  /** Release only the specified approval waiters. */
  supersedeConfirmations(ids: ReadonlySet<string>): void {
    for (const id of ids) this.waiters.get(id)?.resolve("superseded");
  }

  /** 停止路径：解除全部等待（门以 block 结束，不执行该操作）；进行中的自动审查一并中止。 */
  cancelAll(): void {
    for (const w of this.waiters.values()) w.resolve("canceled");
    this.waiters.clear();
    for (const aborter of this.reviewAborters.values()) aborter.abort();
    this.reviewAborters.clear();
  }

  /**
   * 单次自动审查（issue 15）：确定性策略先行，可审查的交给无工具模型调用。
   * 决定、理由、来源与事件在同一事务落盘；与人工决定/取消/模式切换竞争时
   * 只有一方条件更新成功，失败方把审查标记为 superseded 并忽略结果。
   */
  private async runAutoReview(
    confirmation: ConfirmationRequest,
    task: Task,
    input: { toolName: string; params: Record<string, unknown>; scope: ApprovalScope },
  ): Promise<void> {
    const store = this.deps.store;
    const reviewer = this.deps.reviewer();
    const selection = task.modelSelection;
    if (!reviewer || !selection) return;

    // 确定性策略：不可审查的范围直接转人工，不发起模型调用
    if (classifyForReview(input.scope) === "ask_owner") {
      this.markReviewAskedOwner(task, confirmation.id, "该操作不属于自动批准范围，转拥有者确认");
      return;
    }

    const aborter = new AbortController();
    this.reviewAborters.set(confirmation.id, aborter);
    try {
      const outcome = await reviewer.review({
        selection,
        taskInput: task.input,
        toolName: input.toolName,
        params: input.params,
        scope: input.scope,
        signal: aborter.signal,
      });
      if (outcome.decision === "ask_owner") {
        // 上下文不足/模型失败/超时/输出非法：转人工并说明原因，等待者不动
        this.markReviewAskedOwner(task, confirmation.id, outcome.reason);
        return;
      }
      // approve/reject：条件更新要求仍 pending、权限版本匹配、任务仍活动
      const decision = outcome.decision === "approve" ? "approved" : "rejected";
      const applied = store.withTx(() =>
        store.respondConfirmation(confirmation.id, decision, {
          source: "auto_review",
          expectedPermissionVersion: confirmation.permissionVersion,
          reviewDecision: outcome.decision,
          reviewReason: outcome.reason,
        }),
      );
      if (!applied) {
        // 人工抢先/已失效：迟到结果不得落盘
        store.withTx(() => store.markConfirmationReviewSuperseded(confirmation.id));
        return;
      }
      store.withTx(() =>
        store.appendEvent(
          { type: "task.confirmation_resolved", taskId: task.id, confirmationId: confirmation.id, decision, source: "auto_review", reason: outcome.reason },
          { taskId: task.id, sessionId: task.sessionId },
        ),
      );
      this.waiters.get(confirmation.id)?.resolve(decision);
    } catch (err) {
      if (err instanceof ReviewAbortedError) {
        // 人工接管/停止：仅标记审查被取代，不动审批状态
        store.withTx(() => store.markConfirmationReviewSuperseded(confirmation.id));
        return;
      }
      // reviewer 约定只抛中止；防御性兜底：任何意外异常一律转人工
      this.markReviewAskedOwner(task, confirmation.id, `审查异常：${(err as Error).message}`);
    } finally {
      this.reviewAborters.delete(confirmation.id);
    }
  }

  /** 转人工（条件更新仍 pending；人工已抢先时不覆盖其决定、不发事件）。 */
  private markReviewAskedOwner(task: Task, confirmationId: string, reason: string): void {
    const store = this.deps.store;
    const marked = store.withTx(() => store.markConfirmationAskedOwner(confirmationId, reason));
    if (marked) {
      store.withTx(() =>
        store.appendEvent(
          { type: "task.confirmation_reviewed", taskId: task.id, confirmationId, decision: "ask_owner", reason },
          { taskId: task.id, sessionId: task.sessionId },
        ),
      );
    }
  }
}
