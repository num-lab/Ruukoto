/**
 * GitHub 集成的持久化（issue 06 §1/§4/§5）：仓库绑定、草稿与发布操作。
 *
 * - 绑定与草稿都带可比较的版本：任何配置变化递增 config_version，远端调用
 *   前重新核对；撤销/修改后旧版本派生的待发布操作失效；
 * - 草稿正文哈希 + 分析修订（head/base SHA、run/attempt）随草稿保存；
 *   发布前核对发现影响分析的变化 → 草稿标 stale，旧批准不得消费；
 * - 发布操作（github_publish_ops）记录目标、正文哈希、修订与结果；
 *   已发送但结果未落盘 → effect_unknown，不自动重发。
 */

import type { Db } from "../../core/db.ts";
import { randomId } from "../../core/types.ts";

export type GitHubReadScope = "pulls" | "actions" | "checks";

export const GITHUB_READ_SCOPES: readonly GitHubReadScope[] = ["pulls", "actions", "checks"];

export interface GitHubRepoBinding {
  id: string;
  projectId: string;
  /** API 主机（小写 host[:port]；生产固定 api.github.com 或拥有者显式配置的 GHE 主机）。 */
  apiHost: string;
  /** 测试模拟服务显式允许 http（仅回环）；生产固定 https。 */
  scheme: "https" | "http";
  owner: string;
  repo: string;
  /** 核实后的 repository ID（改名/迁移核对依据；null = 尚未核实）。 */
  repoId: number | null;
  /** 读取凭据绑定名（CredentialStore；值不进入本表）。 */
  readCredential: string | null;
  /** 发布凭据绑定名（单独配置写权限；读取路径不得借用）。 */
  publishCredential: string | null;
  /** 拥有者开放的读取范围（pulls/actions/checks）。 */
  readScopes: GitHubReadScope[];
  /** 是否允许读取 fork PR 的源仓库内容（默认不允许）。 */
  allowForkContent: boolean;
  /** 可比较版本：任何字段变化递增；远端调用前核对。 */
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type GitHubDraftKind = "ci_analysis" | "pr_review";
export type GitHubDraftStatus = "draft" | "stale" | "published";

export interface GitHubDraft {
  id: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  bindingId: string;
  kind: GitHubDraftKind;
  /** 草稿版本（同一分析修订后递增；发布绑定具体版本）。 */
  version: number;
  status: GitHubDraftStatus;
  /** 正文（Markdown）。 */
  body: string;
  bodySha256: string;
  /** 分析修订：{ headSha, baseSha, runId, runAttempt, commitId }（按 kind 取用）。 */
  revisions: Record<string, unknown>;
  /** 证据产物 id 列表（JSON/diff/日志捕获）。 */
  evidenceArtifactIds: string[];
  /** 采集时的绑定配置版本。 */
  configVersion: number;
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GitHubPublishKind = "pr_review_comment" | "issue_comment";
export type GitHubPublishStatus = "pending" | "sent" | "failed" | "effect_unknown" | "canceled";

export interface GitHubPublishOp {
  id: string;
  draftId: string;
  draftVersion: number;
  bindingId: string;
  kind: GitHubPublishKind;
  /** 目标：{ prNumber, commitId } 或 { issueNumber }。 */
  target: Record<string, unknown>;
  bodySha256: string;
  revisions: Record<string, unknown>;
  /** 创建时的绑定配置版本与任务权限版本（消费前核对）。 */
  configVersion: number;
  permissionVersion: number;
  status: GitHubPublishStatus;
  /** 远端返回的 comment/review id 与 URL（sent 时）。 */
  remoteId: number | null;
  remoteUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class GitHubStore {
  constructor(private readonly db: Db) {}

  // ---------- 仓库绑定 ----------

  upsertBinding(input: {
    projectId: string;
    apiHost: string;
    scheme?: "https" | "http";
    owner: string;
    repo: string;
    repoId?: number | null;
    readCredential?: string | null;
    publishCredential?: string | null;
    readScopes: GitHubReadScope[];
    allowForkContent?: boolean;
  }): GitHubRepoBinding {
    const existing = this.getBindingByRepo(input.projectId, input.apiHost, input.owner, input.repo);
    const now = new Date().toISOString();
    if (existing) {
      const next: GitHubRepoBinding = {
        ...existing,
        scheme: input.scheme ?? existing.scheme,
        repoId: input.repoId !== undefined ? input.repoId : existing.repoId,
        readCredential: input.readCredential !== undefined ? input.readCredential : existing.readCredential,
        publishCredential: input.publishCredential !== undefined ? input.publishCredential : existing.publishCredential,
        readScopes: input.readScopes,
        allowForkContent: input.allowForkContent ?? existing.allowForkContent,
        configVersion: existing.configVersion + 1,
        updatedAt: now,
      };
      this.db
        .prepare(
          `UPDATE github_repo_bindings SET scheme = ?, repo_id = ?, read_credential = ?, publish_credential = ?,
             read_scopes = ?, allow_fork_content = ?, config_version = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.scheme,
          next.repoId,
          next.readCredential,
          next.publishCredential,
          JSON.stringify(next.readScopes),
          next.allowForkContent ? 1 : 0,
          next.configVersion,
          now,
          existing.id,
        );
      return next;
    }
    const binding: GitHubRepoBinding = {
      id: randomId("ghb"),
      projectId: input.projectId,
      apiHost: input.apiHost.toLowerCase(),
      scheme: input.scheme ?? "https",
      owner: input.owner,
      repo: input.repo,
      repoId: input.repoId ?? null,
      readCredential: input.readCredential ?? null,
      publishCredential: input.publishCredential ?? null,
      readScopes: input.readScopes,
      allowForkContent: input.allowForkContent ?? false,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO github_repo_bindings
         (id, project_id, api_host, scheme, owner, repo, repo_id, read_credential, publish_credential,
          read_scopes, allow_fork_content, config_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.id,
        binding.projectId,
        binding.apiHost,
        binding.scheme,
        binding.owner,
        binding.repo,
        binding.repoId,
        binding.readCredential,
        binding.publishCredential,
        JSON.stringify(binding.readScopes),
        binding.allowForkContent ? 1 : 0,
        binding.configVersion,
        binding.createdAt,
        binding.updatedAt,
      );
    return binding;
  }

  getBinding(id: string): GitHubRepoBinding | null {
    const row = this.db.prepare("SELECT * FROM github_repo_bindings WHERE id = ?").get(id) as any;
    return row ? rowToBinding(row) : null;
  }

  getBindingByRepo(projectId: string, apiHost: string, owner: string, repo: string): GitHubRepoBinding | null {
    const row = this.db
      .prepare("SELECT * FROM github_repo_bindings WHERE project_id = ? AND api_host = ? AND owner = ? AND repo = ?")
      .get(projectId, apiHost.toLowerCase(), owner, repo) as any;
    return row ? rowToBinding(row) : null;
  }

  listBindings(projectId?: string): GitHubRepoBinding[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM github_repo_bindings WHERE project_id = ? ORDER BY created_at, id").all(projectId)
        : this.db.prepare("SELECT * FROM github_repo_bindings ORDER BY created_at, id").all()
    ) as any[];
    return rows.map(rowToBinding);
  }

  /** 撤销绑定（删除行；进行中的调用在下一次版本核对时失败）。 */
  removeBinding(id: string): boolean {
    const info = this.db.prepare("DELETE FROM github_repo_bindings WHERE id = ?").run(id);
    return Number(info.changes) === 1;
  }

  /** 核实并固定 repository ID；已固定的 ID 不同即拒绝（改名/迁移需人工处理）。 */
  pinRepoId(bindingId: string, repoId: number): GitHubRepoBinding {
    const binding = this.getBinding(bindingId);
    if (!binding) throw new Error(`仓库绑定不存在：${bindingId}`);
    if (binding.repoId !== null && binding.repoId !== repoId) {
      throw new Error(
        `仓库 ID 不匹配：绑定记录 ${binding.repoId}，远端返回 ${repoId}（仓库可能已改名/迁移；请核实后重新配置）`,
      );
    }
    if (binding.repoId === repoId) return binding;
    this.db
      .prepare("UPDATE github_repo_bindings SET repo_id = ?, config_version = ?, updated_at = ? WHERE id = ?")
      .run(repoId, binding.configVersion + 1, new Date().toISOString(), bindingId);
    return this.getBinding(bindingId)!;
  }

  // ---------- 草稿 ----------

  createDraft(input: {
    projectId: string;
    taskId: string;
    sessionId: string;
    bindingId: string;
    kind: GitHubDraftKind;
    body: string;
    bodySha256: string;
    revisions: Record<string, unknown>;
    evidenceArtifactIds: string[];
    configVersion: number;
  }): GitHubDraft {
    const now = new Date().toISOString();
    const draft: GitHubDraft = {
      id: randomId("ghd"),
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      bindingId: input.bindingId,
      kind: input.kind,
      version: 1,
      status: "draft",
      body: input.body,
      bodySha256: input.bodySha256,
      revisions: input.revisions,
      evidenceArtifactIds: input.evidenceArtifactIds,
      configVersion: input.configVersion,
      staleReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO github_drafts
         (id, project_id, task_id, session_id, binding_id, kind, version, status, body, body_sha256,
          revisions, evidence_artifact_ids, config_version, stale_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        draft.id,
        draft.projectId,
        draft.taskId,
        draft.sessionId,
        draft.bindingId,
        draft.kind,
        draft.body,
        draft.bodySha256,
        JSON.stringify(draft.revisions),
        JSON.stringify(draft.evidenceArtifactIds),
        draft.configVersion,
        now,
        now,
      );
    return draft;
  }

  /** 修订草稿（新版本行；旧版本保留）。 */
  reviseDraft(
    draftId: string,
    input: {
      body: string;
      bodySha256: string;
      revisions: Record<string, unknown>;
      evidenceArtifactIds: string[];
      configVersion: number;
    },
  ): GitHubDraft {
    const latest = this.getDraft(draftId);
    if (!latest) throw new Error(`草稿不存在：${draftId}`);
    const now = new Date().toISOString();
    const next: GitHubDraft = {
      ...latest,
      version: latest.version + 1,
      status: "draft",
      body: input.body,
      bodySha256: input.bodySha256,
      revisions: input.revisions,
      evidenceArtifactIds: input.evidenceArtifactIds,
      configVersion: input.configVersion,
      staleReason: null,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO github_drafts
         (id, project_id, task_id, session_id, binding_id, kind, version, status, body, body_sha256,
          revisions, evidence_artifact_ids, config_version, stale_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        next.id,
        next.projectId,
        next.taskId,
        next.sessionId,
        next.bindingId,
        next.kind,
        next.version,
        next.body,
        next.bodySha256,
        JSON.stringify(next.revisions),
        JSON.stringify(next.evidenceArtifactIds),
        next.configVersion,
        next.createdAt,
        now,
      );
    return next;
  }

  /** 最新版本。 */
  getDraft(id: string): GitHubDraft | null {
    const row = this.db
      .prepare("SELECT * FROM github_drafts WHERE id = ? ORDER BY version DESC LIMIT 1")
      .get(id) as any;
    return row ? rowToDraft(row) : null;
  }

  getDraftVersion(id: string, version: number): GitHubDraft | null {
    const row = this.db.prepare("SELECT * FROM github_drafts WHERE id = ? AND version = ?").get(id, version) as any;
    return row ? rowToDraft(row) : null;
  }

  listDrafts(opts: { projectId?: string; taskId?: string; status?: GitHubDraftStatus } = {}): GitHubDraft[] {
    // 每个草稿只取最新版本
    const rows = this.db
      .prepare(
        `SELECT d.* FROM github_drafts d
         JOIN (SELECT id, MAX(version) AS v FROM github_drafts GROUP BY id) latest
           ON latest.id = d.id AND latest.v = d.version
         ORDER BY d.updated_at DESC, d.id`,
      )
      .all() as any[];
    return rows
      .map(rowToDraft)
      .filter(
        (d) =>
          (opts.projectId === undefined || d.projectId === opts.projectId) &&
          (opts.taskId === undefined || d.taskId === opts.taskId) &&
          (opts.status === undefined || d.status === opts.status),
      );
  }

  /** 标为过时（条件更新：仅 draft 状态生效）。 */
  markDraftStale(id: string, version: number, reason: string): boolean {
    const info = this.db
      .prepare("UPDATE github_drafts SET status = 'stale', stale_reason = ?, updated_at = ? WHERE id = ? AND version = ? AND status = 'draft'")
      .run(reason, new Date().toISOString(), id, version);
    return Number(info.changes) === 1;
  }

  markDraftPublished(id: string, version: number): boolean {
    const info = this.db
      .prepare("UPDATE github_drafts SET status = 'published', updated_at = ? WHERE id = ? AND version = ? AND status = 'draft'")
      .run(new Date().toISOString(), id, version);
    return Number(info.changes) === 1;
  }

  // ---------- 发布操作 ----------

  createPublishOp(input: {
    draftId: string;
    draftVersion: number;
    bindingId: string;
    kind: GitHubPublishKind;
    target: Record<string, unknown>;
    bodySha256: string;
    revisions: Record<string, unknown>;
    configVersion: number;
    permissionVersion: number;
  }): GitHubPublishOp {
    const now = new Date().toISOString();
    const op: GitHubPublishOp = {
      id: randomId("ghp"),
      draftId: input.draftId,
      draftVersion: input.draftVersion,
      bindingId: input.bindingId,
      kind: input.kind,
      target: input.target,
      bodySha256: input.bodySha256,
      revisions: input.revisions,
      configVersion: input.configVersion,
      permissionVersion: input.permissionVersion,
      status: "pending",
      remoteId: null,
      remoteUrl: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO github_publish_ops
         (id, draft_id, draft_version, binding_id, kind, target, body_sha256, revisions,
          config_version, permission_version, status, remote_id, remote_url, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        op.id,
        op.draftId,
        op.draftVersion,
        op.bindingId,
        op.kind,
        JSON.stringify(op.target),
        op.bodySha256,
        JSON.stringify(op.revisions),
        op.configVersion,
        op.permissionVersion,
        now,
        now,
      );
    return op;
  }

  getPublishOp(id: string): GitHubPublishOp | null {
    const row = this.db.prepare("SELECT * FROM github_publish_ops WHERE id = ?").get(id) as any;
    return row ? rowToPublishOp(row) : null;
  }

  /** 同一草稿版本的待发布操作（重复发布请求复用，不新建）。 */
  findPendingPublishOp(draftId: string, draftVersion: number): GitHubPublishOp | null {
    const row = this.db
      .prepare("SELECT * FROM github_publish_ops WHERE draft_id = ? AND draft_version = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get(draftId, draftVersion) as any;
    return row ? rowToPublishOp(row) : null;
  }

  listPublishOps(opts: { draftId?: string; status?: GitHubPublishStatus } = {}): GitHubPublishOp[] {
    const rows = this.db.prepare("SELECT * FROM github_publish_ops ORDER BY created_at, id").all() as any[];
    return rows
      .map(rowToPublishOp)
      .filter((o) => (opts.draftId === undefined || o.draftId === opts.draftId) && (opts.status === undefined || o.status === opts.status));
  }

  /** 条件更新发布结果（pending → 终态；重复记录返回 false）。 */
  settlePublishOp(
    id: string,
    outcome: { status: "sent" | "failed" | "effect_unknown" | "canceled"; remoteId?: number | null; remoteUrl?: string | null; errorMessage?: string | null },
  ): boolean {
    const info = this.db
      .prepare(
        "UPDATE github_publish_ops SET status = ?, remote_id = ?, remote_url = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(
        outcome.status,
        outcome.remoteId ?? null,
        outcome.remoteUrl ?? null,
        outcome.errorMessage ?? null,
        new Date().toISOString(),
        id,
      );
    return Number(info.changes) === 1;
  }
}

function rowToBinding(row: any): GitHubRepoBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    apiHost: row.api_host,
    scheme: row.scheme as "https" | "http",
    owner: row.owner,
    repo: row.repo,
    repoId: row.repo_id === null ? null : Number(row.repo_id),
    readCredential: row.read_credential,
    publishCredential: row.publish_credential,
    readScopes: JSON.parse(row.read_scopes) as GitHubReadScope[],
    allowForkContent: Number(row.allow_fork_content) === 1,
    configVersion: Number(row.config_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDraft(row: any): GitHubDraft {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    bindingId: row.binding_id,
    kind: row.kind as GitHubDraftKind,
    version: Number(row.version),
    status: row.status as GitHubDraftStatus,
    body: row.body,
    bodySha256: row.body_sha256,
    revisions: JSON.parse(row.revisions) as Record<string, unknown>,
    evidenceArtifactIds: JSON.parse(row.evidence_artifact_ids) as string[],
    configVersion: Number(row.config_version),
    staleReason: row.stale_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPublishOp(row: any): GitHubPublishOp {
  return {
    id: row.id,
    draftId: row.draft_id,
    draftVersion: Number(row.draft_version),
    bindingId: row.binding_id,
    kind: row.kind as GitHubPublishKind,
    target: JSON.parse(row.target) as Record<string, unknown>,
    bodySha256: row.body_sha256,
    revisions: JSON.parse(row.revisions) as Record<string, unknown>,
    configVersion: Number(row.config_version),
    permissionVersion: Number(row.permission_version),
    status: row.status as GitHubPublishStatus,
    remoteId: row.remote_id === null ? null : Number(row.remote_id),
    remoteUrl: row.remote_url,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
