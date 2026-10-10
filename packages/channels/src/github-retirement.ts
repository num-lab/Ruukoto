/**
 * GitHub 专用模块退役迁移（issue 17）。
 * Note: 见 .agents/notes/implemented/simplification/2026-09-23-retire-github-module.md
 *
 * 旧模块（REST 采集/草稿/发布）已删除，GitHub 经通用 MCP 接入。本模块只在
 * 升级后首次启动时运行一次（meta 标记 + 表存在性双重判定），处理历史数据：
 *
 * - 旧 github_publish 审批（pending / approved 未消费）一律失效（stale）；
 *   批准已消费的记录原样保留（它是"可能已发送"的证据）；
 * - 未决发布操作按证据定终态：批准已消费或无审批记录（完全访问路径可能无
 *   审批）→ effect_unknown（是否已发送无法确认，绝不重发）；审批未消费 →
 *   canceled（可证明未发送）。每个被终结的操作落一条 github.publish_settled
 *   事件，error_message 记录原状态与核对依据；终态操作不改写；
 * - 草稿各版本正文、证据引用与本版本发布记录导出为原任务/会话的产物
 *   （复用 ArtifactStore 与权限归属）；旧绑定仅导出无秘密配置（凭据只出现
 *   绑定名）；导出清单写入 <dataDir>/github-archive-manifest.json；
 * - 可重复执行：已完整导出的草稿版本跳过（中断后恢复不重复产物）；全部
 *   完成才写 meta 完成标记；原表保留为只读归档，不 DROP、不删除；
 * - 旧凭据的 host/scope/秘密值不在此触碰（CredentialStore 的遗留限制继续
 *   生效）；旧操作绝不转换为 MCP 调用。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "@ruukoto/core/db.ts";
import type { Store } from "@ruukoto/core/store.ts";
import type { ArtifactStore } from "@ruukoto/agent/artifacts.ts";

export const GITHUB_ARCHIVE_MANIFEST_FILE = "github-archive-manifest.json";
const DONE_KEY = "github_retirement_done";

const REASON_CONSUMED = "退役迁移：批准已消费，是否已发送无法确认；按 effect_unknown 保留，绝不重发";
const REASON_UNCONSUMED = "退役迁移：审批未消费，可证明未发送；标记取消（不重发）";
const REASON_NO_APPROVAL = "退役迁移：无审批记录（完全访问发布可能无审批），是否已发送无法确认；按 effect_unknown 保留，绝不重发";

/** 升级后首次启动执行退役迁移；无旧表或已完成时直接返回。 */
export function retireGitHubModule(deps: { db: Db; store: Store; artifacts: ArtifactStore; dataDir: string }): void {
  const { db, store, artifacts, dataDir } = deps;
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'github_%'").all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (tables.size === 0) return;
  const done = db.prepare("SELECT value FROM meta WHERE key = ?").get(DONE_KEY) as { value: string } | undefined;
  if (done) return;

  const now = new Date().toISOString();

  // 1. 审批失效与未决操作定终态（单事务；重跑时无 pending 可改，幂等）
  const retiredConfirmations = store.withTx(() => {
    const confInfo = db
      .prepare(
        `UPDATE confirmations SET status = 'stale', responded_at = ?
         WHERE status IN ('pending','approved') AND consumed_at IS NULL
           AND json_extract(scope, '$.kind') = 'github_publish'`,
      )
      .run(now);
    const pendingOps = db.prepare("SELECT * FROM github_publish_ops WHERE status = 'pending' ORDER BY created_at, id").all() as any[];
    for (const op of pendingOps) {
      const confs = db.prepare("SELECT status, consumed_at FROM confirmations WHERE tool_name = 'github_publish' AND tool_op_id = ?").all(op.id) as any[];
      const consumed = confs.some((c) => c.status === "approved" && c.consumed_at !== null);
      const target = consumed || confs.length === 0 ? "effect_unknown" : "canceled";
      const reason = consumed ? REASON_CONSUMED : confs.length === 0 ? REASON_NO_APPROVAL : REASON_UNCONSUMED;
      const info = db
        .prepare("UPDATE github_publish_ops SET status = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(target, reason, now, op.id);
      if (Number(info.changes) !== 1) continue; // 并发/重跑下已被处理
      const draft = db
        .prepare("SELECT task_id, session_id FROM github_drafts WHERE id = ? AND version = ?")
        .get(op.draft_id, op.draft_version) as { task_id: string; session_id: string } | undefined;
      store.appendEvent(
        { type: "github.publish_settled", publishOpId: op.id, draftId: op.draft_id, status: target, remoteUrl: null, errorMessage: reason },
        { taskId: draft?.task_id ?? null, sessionId: draft?.session_id ?? null },
      );
    }
    return Number(confInfo.changes);
  });

  // 2. 草稿归档导出（不在事务内：产物正文在文件系统；按版本幂等，中断可恢复）
  const errors: string[] = [];
  const draftEntries: Array<Record<string, unknown>> = [];
  const drafts = db.prepare("SELECT * FROM github_drafts ORDER BY id, version").all() as any[];
  for (const d of drafts) {
    const name = `github-draft-archive-${d.id}-v${d.version}`;
    const existing = db
      .prepare("SELECT id, status FROM artifacts WHERE task_id = ? AND name = ?")
      .all(d.task_id, name) as Array<{ id: string; status: string }>;
    const complete = existing.find((a) => a.status === "complete");
    if (complete) {
      draftEntries.push(manifestDraftEntry(d, complete.id));
      continue;
    }
    try {
      const content = renderDraftArchive(db, d);
      const artifact = artifacts.begin({ taskId: d.task_id, sessionId: d.session_id, name });
      artifacts.append(artifact.id, Buffer.from(content, "utf8"));
      artifacts.complete(artifact.id);
      draftEntries.push(manifestDraftEntry(d, artifact.id));
    } catch (err) {
      errors.push(`草稿 ${d.id} v${d.version} 导出失败：${(err as Error).message}`);
    }
  }

  // 3. 导出清单（绑定仅无秘密配置；清单从最终库状态生成，重跑内容一致）
  const bindings = (db.prepare("SELECT * FROM github_repo_bindings ORDER BY created_at, id").all() as any[]).map((b) => ({
    id: b.id,
    projectId: b.project_id,
    apiHost: b.api_host,
    scheme: b.scheme,
    owner: b.owner,
    repo: b.repo,
    repoId: b.repo_id,
    readCredential: b.read_credential,
    publishCredential: b.publish_credential,
    readScopes: JSON.parse(b.read_scopes),
    allowForkContent: Number(b.allow_fork_content) === 1,
    configVersion: b.config_version,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  }));
  const publishOps = (db.prepare("SELECT * FROM github_publish_ops ORDER BY created_at, id").all() as any[]).map((o) => ({
    id: o.id,
    draftId: o.draft_id,
    draftVersion: o.draft_version,
    kind: o.kind,
    target: JSON.parse(o.target),
    status: o.status,
    remoteId: o.remote_id,
    remoteUrl: o.remote_url,
    errorMessage: o.error_message,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  }));
  const manifest = {
    retiredAt: now,
    reason: "GitHub 专用模块退役（issue 17）：草稿/发布记录导出为产物，旧表保留为只读归档；GitHub 操作改用通用 MCP 服务配置",
    drafts: draftEntries,
    bindings,
    publishOps,
    retiredConfirmations,
    errors,
  };
  fs.writeFileSync(path.join(dataDir, GITHUB_ARCHIVE_MANIFEST_FILE), JSON.stringify(manifest, null, 2));

  // 4. 全部导出成功才标记完成（未完成时下次启动继续，不重复产物）
  if (errors.length === 0) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DONE_KEY, now);
  }
}

function manifestDraftEntry(d: any, artifactId: string): Record<string, unknown> {
  return {
    draftId: d.id,
    version: d.version,
    artifactId,
    taskId: d.task_id,
    sessionId: d.session_id,
    kind: d.kind,
    status: d.status,
    bodySha256: d.body_sha256,
  };
}

/** 单个草稿版本的归档正文（自描述：来源 ID/版本、证据引用、本版本发布记录）。 */
function renderDraftArchive(db: Db, d: any): string {
  const binding = db.prepare("SELECT * FROM github_repo_bindings WHERE id = ?").get(d.binding_id) as any;
  const bindingLine = binding
    ? `${d.binding_id}（${binding.owner}/${binding.repo} @ ${binding.api_host}，配置版本 ${binding.config_version}）`
    : `${d.binding_id}（绑定记录已删除）`;
  const ops = db.prepare("SELECT * FROM github_publish_ops WHERE draft_id = ? AND draft_version = ? ORDER BY created_at, id").all(d.id, d.version) as any[];
  const opLines = ops.map(
    (o) =>
      `- ${o.id} ${o.kind} ${o.target} → ${o.status}` +
      `${o.remote_url ? `（${o.remote_url}）` : ""}${o.error_message ? `：${o.error_message}` : ""}（${o.created_at} → ${o.updated_at}）`,
  );
  const evidence = JSON.parse(d.evidence_artifact_ids) as string[];
  return [
    "# GitHub 草稿归档（专用模块已退役，issue 17；只读历史资料）",
    "",
    `- 来源：github_drafts ${d.id} v${d.version}`,
    `- 类型 / 状态：${d.kind} / ${d.status}${d.stale_reason ? `（${d.stale_reason}）` : ""}`,
    `- 任务 / 会话：${d.task_id} / ${d.session_id}`,
    `- 仓库绑定：${bindingLine}`,
    `- 正文 sha256：${d.body_sha256}（${Buffer.byteLength(d.body, "utf8")} 字节）`,
    `- 分析修订：${d.revisions}`,
    `- 证据产物：${evidence.length ? evidence.join(", ") : "无"}`,
    `- 创建 / 更新：${d.created_at} / ${d.updated_at}`,
    "",
    "## 正文",
    "",
    d.body,
    "",
    "## 本版本发布记录",
    "",
    ...(opLines.length ? opLines : ["（无发布记录）"]),
    "",
  ].join("\n");
}
