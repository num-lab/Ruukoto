/**
 * 审批闸门（架构工单 04）：审批请求的全程由这里负责——登记请求并把任务转入
 * 等待确认、auto-review 任务先经一次自动审查、等待拥有者决定、未批准时记录
 * 已知未执行、获批后在同一事务内复核并单次消费；等待表、计数与进行中的审查
 * 都只在这里。工具族只提供审批范围、获批后复核与（需要时）同事务提交的本地效果。
 *
 * Driver 只接线：控制面应答（含 IM 审批命令及同事务回执 txExtra）→ resolve()，
 * 工具边界模式切换 → supersedeAll()，IM 绑定失效 → supersedeConfirmations()，
 * 停止 → cancelAll()。IM 来源审批的创建通知与消费前固定身份复核经 deps 钩子接入
 * （agent-direction issue 08）。每个 Driver 一个实例。
 */

import type { ApprovalScope, ConfirmationRequest, Task } from "../core/types.ts";
import type { Store } from "../core/store.ts";
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
  /** 与消费同一事务提交的本地效果（通知登记）；抛错则整笔回滚。不得再开核心库事务。 */
  commit?: (approvalId: string) => T;
}

/** 批准：审批 id、审批记录保存的参数快照与 commit 的返回值；否则为已知未执行的文案。 */
export type ApprovalResult<T> =
  | { approved: true; approvalId: string; params: Record<string, unknown>; value: T }
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
    ? `审批已失效（模式切换或任务停止），${toolName} 未执行；如仍需要请重新申请`
    : `任务停止，确认等待解除（${toolName} 未执行）`;
}

export interface ApprovalGateDeps {
  store: Store;
  ledger: ToolOpLedger;
  /** 自动审查器（模型配置变化时由 Driver 替换，每次读取当前值）。 */
  reviewer(): ApprovalReviewer | undefined;
  /**
   * IM 审批通知（agent-direction issue 08）：审批登记事务内调用（宿主登记初始
   * IM 通知，与审批同事务提交）；不得再开核心库事务。抛错则整笔回滚。
   */
  notifyConfirmation?: (confirmation: ConfirmationRequest, task: Task) => void;
  /**
   * IM 固定身份的消费前复核（agent-direction issue 08）：在消费事务内、消费
   * 条件更新之前执行；返回原因即放弃消费并使批准失效。不得再开核心库事务。
   */
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
    const waited = await this.wait(input);
    if (!waited.approved) return waited;
    return this.consume(input, waited.confirmationId);
  }

  private async wait(input: ApprovalRequest<unknown>): Promise<{ approved: true; confirmationId: string } | { approved: false; text: string }> {
    const store = this.deps.store;
    // 自动审查只覆盖 auto-review 任务且需要任务固定的模型配置；缺任一条件退化为纯人工
    const reviewSelection =
      input.task.accessMode === "auto-review" && this.deps.reviewer() ? input.task.modelSelection : null;
    const confirmation = store.withTx(() => {
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
      store.transitionTask(input.task.id, ["running"], "awaiting_confirmation", {});
      // IM 审批通知与审批登记同事务：通知暂时发送失败不使操作获批，但登记失败
      // 整笔回滚（不留"审批已存在但绑定入口未获通知"的状态）
      this.deps.notifyConfirmation?.(c, input.task);
      return c;
    });

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
        // IM 固定身份复核（issue 08）：批准已接受、尚未消费期间的重新绑定/
        // 凭据变化在此拦截；失败即批准失效，操作按已知未执行
        const imReason = this.deps.consumeRecheck?.(confirmation, input.task) ?? null;
        if (imReason) {
          store.invalidateConfirmation(confirmationId);
          return { approved: false, text: imReason };
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
          { type: "task.approval_consumed", taskId: input.task.id, confirmationId, toolOpId: input.hostOpId, toolName: input.toolName },
          { taskId: input.task.id, sessionId: input.task.sessionId },
        );
        const value = input.commit ? input.commit(confirmationId) : (undefined as T);
        return { approved: true, approvalId: confirmationId, params: confirmation.params, value };
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

  /**
   * 控制面/IM 应答确认：条件更新 pending → approved/rejected；失效应答返回 false。
   * 决定与审计事件在同一事务提交（IM 控制事件登记与回执可经 txExtra 并入同一事务，
   * 不得再开核心库事务；抛错则整笔回滚）；提交成功后才唤醒等待者。
   */
  resolve(confirmationId: string, decision: "approved" | "rejected", opts?: { txExtra?: () => void }): boolean {
    const waiter = this.waiters.get(confirmationId);
    if (!waiter) return false;
    const store = this.deps.store;
    // 人工决定：记录来源；进行中的自动审查同事务标记 superseded
    const applied = store.withTx(() => {
      const ok = store.respondConfirmation(confirmationId, decision, { source: "owner" });
      if (!ok) return false;
      store.appendEvent(
        { type: "task.confirmation_resolved", taskId: waiter.task.id, confirmationId, decision, source: "owner" },
        { taskId: waiter.task.id, sessionId: waiter.task.sessionId },
      );
      opts?.txExtra?.();
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

  /** 定向解除指定审批的等待（IM 绑定失效，agent-direction issue 08）；其他审批照常。 */
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
