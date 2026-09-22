/**
 * GitHub 发布（issue 06 §5）：草稿 → 拥有者发布意图 → 逐次审批（请求确认模式）→
 * 发送前复核修订 → POST → 结果落盘。
 *
 * 边界：
 * - 发布意图只能由拥有者经可信 CLI/TUI 建立（runtime 端点）；模型工具参数、
 *   PR 文本、full_access 都不能创建发布意图；
 * - 每个可发布正文都是可查看草稿；发布绑定具体草稿版本 + 正文哈希；
 * - 请求确认模式：复用 awaitApproval + 持久化审批记录（github_publish scope），
 *   批准单次消费；正文/目标变化 = 新请求；
 * - 批准后、发送前复核 head/base SHA、PR 状态或 run/attempt/检查状态；
 *   影响分析结论的变化 → 草稿标 stale、停止发布；
 * - POST 不重试；已发送但超时/断线/崩溃/结果未落盘 → effect_unknown，不自动重发；
 * - 同一草稿版本的重复发布请求复用已有 pending 操作（本地幂等）。
 */

import { createHash } from "node:crypto";
import { GitHubError, type GitHubClient } from "./client.ts";
import type { GitHubStore, GitHubDraft, GitHubPublishOp, GitHubRepoBinding } from "./store.ts";
import type { Store } from "../../core/store.ts";
import type { AccessMode, Task, ApprovalScope } from "../../core/types.ts";

/** GitHub 评论正文实际上限（65536 字符）；超限不静默截断/拆分。 */
export const GITHUB_BODY_LIMIT = 65536;

export function bodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export interface PublishDeps {
  store: Store;
  github: GitHubStore;
  /** 取任务当前状态（权限版本核对）。 */
  getTask(taskId: string): Task | null;
  /** 建立到绑定仓库的客户端（凭据从 CredentialStore 按范围注入）。 */
  clientFor(binding: GitHubRepoBinding, operation: "github_read" | "github_publish"): GitHubClient;
  /** 审批桥（请求确认模式逐次审批；full_access 由调用方跳过）。 */
  awaitApproval(input: {
    task: Task;
    hostOpId: string;
    toolName: string;
    params: Record<string, unknown>;
    scope: ApprovalScope;
  }): Promise<"approved" | "rejected" | "superseded">;
  /** 事件落盘。 */
  emit(body: import("../../core/types.ts").PersistentEventBody, refs: { taskId?: string | null; sessionId?: string | null }): void;
  sleep?: (ms: number) => Promise<void>;
}

export class PublishError extends Error {
  constructor(
    readonly code: "stale" | "rejected" | "superseded" | "send_failed" | "effect_unknown" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 发布一个草稿版本。返回最终落盘的发布操作。
 * mode = "full_access" 时在既有发布意图范围内跳过逐次审批；其余模式（confirm /
 * auto-review）逐次审批（auto-review 由审批桥自动审查，github_publish 范围按
 * 确定性策略转人工，审查轨迹照常落库）。
 */
export async function publishDraft(
  deps: PublishDeps,
  input: {
    draft: GitHubDraft;
    binding: GitHubRepoBinding;
    task: Task;
    kind: "pr_review_comment" | "issue_comment";
    target: Record<string, unknown>;
    mode: AccessMode;
  },
): Promise<GitHubPublishOp> {
  const { draft, binding, task } = input;
  if (draft.status !== "draft") {
    throw new PublishError("invalid", `草稿状态为 ${draft.status}（${draft.staleReason ?? "已处理"}），不能发布；请重新分析生成新草稿`);
  }
  if (draft.body.length > GITHUB_BODY_LIMIT) {
    throw new PublishError("invalid", `正文 ${draft.body.length} 字符超过平台限制 ${GITHUB_BODY_LIMIT}；请缩减后重新保存草稿（不静默截断）`);
  }
  if (draft.configVersion !== binding.configVersion) {
    deps.github.markDraftStale(draft.id, draft.version, `仓库绑定配置已变化（${draft.configVersion} → ${binding.configVersion}）`);
    throw new PublishError("stale", "仓库绑定配置已变化，草稿已标记过时；请重新分析");
  }

  // 本地幂等：同一草稿版本 + 相同发布意图（kind/target）的 pending 操作 → 复用；
  // 不同 kind/target = 新发布意图，新建操作（审计记录与实际发送一致）
  const existing = deps.github.findPendingPublishOp(draft.id, draft.version);
  const reused = existing && existing.kind === input.kind && JSON.stringify(existing.target) === JSON.stringify(input.target);
  const op =
    reused ? existing! :
    deps.github.createPublishOp({
      draftId: draft.id,
      draftVersion: draft.version,
      bindingId: binding.id,
      kind: input.kind,
      target: input.target,
      bodySha256: draft.bodySha256,
      revisions: draft.revisions,
      configVersion: binding.configVersion,
      permissionVersion: task.permissionVersion,
    });
  deps.emit(
    { type: "github.publish_requested", publishOpId: op.id, draftId: draft.id, draftVersion: draft.version, taskId: task.id, sessionId: task.sessionId },
    { taskId: task.id, sessionId: task.sessionId },
  );

  // 非完全访问模式：结构化审批（github_publish 范围；正文经审批记录可分段查看）
  if (input.mode !== "full_access") {
    const scope: ApprovalScope = {
      kind: "github_publish",
      publishOpId: op.id,
      draftId: draft.id,
      draftVersion: draft.version,
      apiHost: binding.apiHost,
      owner: binding.owner,
      repo: binding.repo,
      repoId: binding.repoId,
      publishKind: input.kind,
      target: input.target,
      bodySha256: draft.bodySha256,
      bodyBytes: Buffer.byteLength(draft.body, "utf8"),
      revisions: draft.revisions,
    };
    const decision = await deps.awaitApproval({
      task,
      hostOpId: op.id,
      toolName: "github_publish",
      params: { publishOpId: op.id, body: draft.body },
      scope,
    });
    if (decision !== "approved") {
      deps.github.settlePublishOp(op.id, { status: "canceled", errorMessage: decision === "rejected" ? "拥有者拒绝发布" : "审批已失效（模式切换/任务停止）" });
      deps.emit(
        { type: "github.publish_settled", publishOpId: op.id, draftId: draft.id, status: "canceled", remoteUrl: null, errorMessage: decision },
        { taskId: task.id, sessionId: task.sessionId },
      );
      throw new PublishError(decision === "rejected" ? "rejected" : "superseded", decision === "rejected" ? "拥有者拒绝发布" : "审批已失效");
    }
    // 单次消费（条件更新：批准未消费、权限版本匹配、任务仍活动含当前版本核对）；
    // 排除已消费记录：崩溃重试后旧批准可能仍挂在本操作上
    const confirmation = deps.store
      .listConfirmationsByTask(task.id)
      .filter((c) => c.toolOpId === op.id && c.status === "approved" && !c.consumedAt)
      .at(-1);
    if (!confirmation) {
      deps.github.settlePublishOp(op.id, { status: "canceled", errorMessage: "审批记录缺失" });
      throw new PublishError("superseded", "审批记录缺失或已失效，未发布");
    }
    const consumed = deps.store.consumeApproval({
      confirmationId: confirmation.id,
      expectedPermissionVersion: confirmation.permissionVersion,
      activeStatuses: ["running", "awaiting_confirmation"],
    });
    if (!consumed) {
      deps.github.settlePublishOp(op.id, { status: "canceled", errorMessage: "批准已失效（任务结束/权限版本变化/已消费）" });
      throw new PublishError("superseded", "批准已失效（任务结束、权限版本变化或已被消费），未发布");
    }
    deps.store.appendEvent(
      { type: "task.approval_consumed", taskId: task.id, confirmationId: confirmation.id, toolOpId: op.id, toolName: "github_publish" },
      { taskId: task.id, sessionId: task.sessionId },
    );
  }

  // 发送前复核：按草稿实际分析的修订重读（不依赖模型自报的草稿类型）；
  // 影响分析结论的变化 → 草稿标 stale，停止发布
  const client = deps.clientFor(binding, "github_publish");
  const config = `${binding.id}:${binding.configVersion}`;
  try {
    await recheckRevisions(client, binding, config, draft, input.target);
  } catch (err) {
    if (err instanceof PublishError && (err.code === "stale" || err.code === "invalid")) {
      deps.github.markDraftStale(draft.id, draft.version, err.message);
      deps.github.settlePublishOp(op.id, { status: "canceled", errorMessage: `发送前复核失败：${err.message}` });
      deps.emit({ type: "github.draft_stale", draftId: draft.id, version: draft.version, reason: err.message }, { taskId: task.id, sessionId: task.sessionId });
      deps.emit(
        { type: "github.publish_settled", publishOpId: op.id, draftId: draft.id, status: "canceled", remoteUrl: null, errorMessage: err.message },
        { taskId: task.id, sessionId: task.sessionId },
      );
    }
    throw err;
  }

  // 发送（不重试；超时/断线 → effect_unknown）
  const path =
    input.kind === "pr_review_comment"
      ? `/repos/${binding.owner}/${binding.repo}/pulls/${input.target["prNumber"]}/reviews`
      : `/repos/${binding.owner}/${binding.repo}/issues/${input.target["issueNumber"]}/comments`;
  const payload =
    input.kind === "pr_review_comment"
      ? { body: draft.body, event: "COMMENT", commit_id: String(draft.revisions["headSha"] ?? input.target["commitId"] ?? "") }
      : { body: draft.body };

  try {
    const { data } = await client.postJson(path, payload, config);
    const remoteId = typeof (data as any)?.id === "number" ? (data as any).id : null;
    const remoteUrl = typeof (data as any)?.html_url === "string" ? (data as any).html_url : null;
    deps.github.settlePublishOp(op.id, { status: "sent", remoteId, remoteUrl });
    deps.github.markDraftPublished(draft.id, draft.version);
    deps.emit(
      { type: "github.publish_settled", publishOpId: op.id, draftId: draft.id, status: "sent", remoteUrl, errorMessage: null },
      { taskId: task.id, sessionId: task.sessionId },
    );
  } catch (err) {
    // 发送后结果不确定（超时/断线/连接重置）→ effect_unknown，不自动重发；
    // 远端明确拒绝（4xx）→ failed
    const unknown = !(err instanceof GitHubError) || err.status === null || err.status >= 500;
    const status = unknown ? "effect_unknown" : "failed";
    const message = (err as Error).message;
    deps.github.settlePublishOp(op.id, { status, errorMessage: message });
    deps.emit(
      { type: "github.publish_settled", publishOpId: op.id, draftId: draft.id, status, remoteUrl: null, errorMessage: message },
      { taskId: task.id, sessionId: task.sessionId },
    );
    if (unknown) {
      throw new PublishError("effect_unknown", `发布请求已发出但结果未知（${message}）；已按 effect_unknown 记录，不会自动重发。请人工核实远端后决定`);
    }
    throw new PublishError("send_failed", `发布被远端拒绝：${message}`);
  }
  return deps.github.getPublishOp(op.id)!;
}

/** 已结束任务发布的复核入口（runtime 在建审计任务前调用）。 */
export async function precheckDraft(
  client: GitHubClient,
  binding: GitHubRepoBinding,
  config: string,
  draft: GitHubDraft,
  target: Record<string, unknown>,
): Promise<void> {
  await recheckRevisions(client, binding, config, draft, target);
}

/** 发送前复核修订（影响分析结论的变化即拒绝发布）。按草稿实际记录的修订复核，
 * 与发布形态无关：PR 修订（headSha+baseSha，发布目标为该 PR 时连同状态）与
 * run 修订（runId/runAttempt）各自独立核对。 */
async function recheckRevisions(
  client: GitHubClient,
  binding: GitHubRepoBinding,
  config: string,
  draft: GitHubDraft,
  target: Record<string, unknown>,
): Promise<void> {
  const base = `/repos/${binding.owner}/${binding.repo}`;
  const headSha = draft.revisions["headSha"];
  const baseSha = draft.revisions["baseSha"];
  if (typeof headSha === "string" && typeof baseSha === "string") {
    const prNumber = target["prNumber"];
    if (!Number.isInteger(prNumber) || (prNumber as number) < 1) {
      throw new PublishError("invalid", `草稿分析自一个 PR 修订，发布目标必须是该 PR（--pr <编号>）`);
    }
    const { data } = await client.getJson(`${base}/pulls/${prNumber}`, config);
    const p = data as any;
    if (p?.state !== "open") {
      throw new PublishError("stale", `PR #${prNumber} 状态已变为 ${p?.state}（分析时为 open）`);
    }
    if (p?.head?.sha !== headSha || p?.base?.sha !== baseSha) {
      throw new PublishError(
        "stale",
        `PR #${prNumber} 修订已变化（head ${headSha.slice(0, 8)}→${String(p?.head?.sha).slice(0, 8)}）；分析结论可能不再适用`,
      );
    }
    return;
  }
  const runId = draft.revisions["runId"];
  if (typeof runId === "number") {
    const { data } = await client.getJson(`${base}/actions/runs/${runId}`, config);
    const r = data as any;
    if (typeof headSha === "string" && r?.head_sha !== headSha) {
      throw new PublishError("stale", `run ${runId} 的 head_sha 已变化；分析结论可能不再适用`);
    }
    if (typeof draft.revisions["runAttempt"] === "number" && r?.run_attempt !== draft.revisions["runAttempt"]) {
      throw new PublishError("stale", `run ${runId} 已有新的 attempt（${draft.revisions["runAttempt"]} → ${r?.run_attempt}）；请分析最新运行`);
    }
    return;
  }
  if (typeof headSha === "string") {
    // 仅 headSha（未关联 run 的 CI 分析）：与目标 issue/PR 当前 head 核对；
    // 无法核对（无 prNumber 目标）则拒绝，不做无复核发布
    const prNumber = target["prNumber"];
    if (Number.isInteger(prNumber) && (prNumber as number) >= 1) {
      const { data } = await client.getJson(`${base}/pulls/${prNumber}`, config);
      const p = data as any;
      if (p?.head?.sha !== headSha) {
        throw new PublishError("stale", `PR #${prNumber} 的 head 已变化（${headSha.slice(0, 8)} → ${String(p?.head?.sha).slice(0, 8)}）；分析结论可能不再适用`);
      }
      return;
    }
  }
  throw new PublishError("invalid", "草稿缺少可复核的分析修订（headSha+baseSha 或 runId），不能安全发布；请重新分析");
}
