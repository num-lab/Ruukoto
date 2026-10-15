/** Git 工作区的原始字节基线；私有对象与 SQLite 引用不构成跨文件系统事务。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-15-current-workspace-snapshots.md
 */
import { canonicalJson, sha256 } from "./import-files.ts";

export interface SnapshotDirectory { path: string; dev: number; ino: number }

export interface WorkspaceSnapshot {
  version: 1;
  source: SnapshotDirectory;
  commonGit: SnapshotDirectory;
  repository: SnapshotDirectory;
  head: string;
  indexDigest: string;
  tree: string;
  digest: string;
}

export class WorkspaceSnapshotError extends Error {
  constructor(readonly code: string, message = "工作区基线记录缺失或损坏；保留副本并报告拥有者，不从 HEAD 重建") {
    super(message);
  }
}

export function snapshotWorkspace(value: Omit<WorkspaceSnapshot, "digest">): WorkspaceSnapshot {
  const { version, source, commonGit, repository, head, indexDigest, tree } = value;
  const content = { version, source, commonGit, repository, head, indexDigest, tree };
  return { ...content, digest: sha256(canonicalJson(content)) };
}

export function requireWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (!value) throw new WorkspaceSnapshotError("snapshot_missing");
  if (typeof value !== "object" || Array.isArray(value)) throw new WorkspaceSnapshotError("snapshot_corrupt");
  const row = value as Record<string, unknown>;
  const identity = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return Object.keys(item).length === 3 && typeof item.path === "string" && item.path.startsWith("/") &&
      Number.isSafeInteger(item.dev) && Number.isSafeInteger(item.ino);
  };
  if (Object.keys(row).length !== 8 || row.version !== 1 || !identity(row.source) || !identity(row.commonGit) || !identity(row.repository) ||
      typeof row.head !== "string" || !/^[0-9a-f]{40}$/.test(row.head) || typeof row.tree !== "string" || !/^[0-9a-f]{40}$/.test(row.tree) ||
      typeof row.indexDigest !== "string" || !/^[0-9a-f]{64}$/.test(row.indexDigest) || typeof row.digest !== "string") throw new WorkspaceSnapshotError("snapshot_corrupt");
  const snapshot = value as WorkspaceSnapshot;
  const { digest, ...content } = snapshot;
  if (digest !== sha256(canonicalJson(content))) throw new WorkspaceSnapshotError("snapshot_corrupt");
  return snapshot;
}
