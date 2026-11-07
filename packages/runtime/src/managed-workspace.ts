// Note: See .agents/notes/implemented/feature/2026-11-07-managed-coding-workspaces.md
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import type { DirIdentity } from "@ruukoto/core/dir-identity.ts";
import { saveManagedWorkspaceRequest, type ManagedWorkspaceRequest } from "@ruukoto/core/managed-workspaces.ts";
import type { Store } from "@ruukoto/core/store.ts";

const helper = fileURLToPath(new URL("./managed-workspace.py", import.meta.url));

function directoryIdentity(directory: string): DirIdentity | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new RuntimeApiError("cwd_changed", "自动工作区目录已被替换或指向其他位置，请核实原目录。");
  }
  return { cwd: directory, cwdReal: directory, dev: stat.dev, ino: stat.ino };
}

function sameInode(actual: DirIdentity | null, saved: DirIdentity): boolean {
  return actual !== null && actual.dev === saved.dev && actual.ino === saved.ino;
}

/** The persisted staging inode witnesses installation; target existence alone grants no ownership. */
export function prepareManagedWorkspace(store: Store, request: ManagedWorkspaceRequest): DirIdentity {
  const parentPath = path.dirname(request.root);
  let parent = directoryIdentity(parentPath);
  if (!parent) {
    if (request.parent) throw new RuntimeApiError("cwd_changed", "自动工作区父目录已丢失，请恢复原目录后重试。");
    fs.mkdirSync(parentPath, { mode: 0o700 });
    parent = directoryIdentity(parentPath)!;
  }
  if (request.parent && (!sameInode(parent, request.parent) || request.parent.cwdReal !== parentPath)) {
    throw new RuntimeApiError("cwd_changed", "自动工作区父目录身份已变化，请恢复原目录后重试。");
  }
  const parentFd = fs.openSync(parentPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(parentFd);
    if (opened.ino !== parent.ino || opened.dev !== parent.dev) throw new RuntimeApiError("cwd_changed", "自动工作区父目录已被替换，请核实原目录。");
    if (!request.parent) {
      request.parent = parent;
      store.withTx(() => saveManagedWorkspaceRequest(store, request));
    }
    const existing = directoryIdentity(request.root);
    if (existing && (!request.stage || !sameInode(existing, request.stage))) {
      throw new RuntimeApiError("cwd_changed", "自动工作区路径已被其他目录占用，请保留该目录并核实创建记录。");
    }
    if (!request.stage) {
      const stagePath = path.join(parentPath, `.${request.projectId}.prepare-${randomUUID()}`);
      const result = execFileSync("python3", [helper, "stage", path.basename(stagePath)], { stdio: ["ignore", "pipe", "pipe", parentFd], encoding: "utf8", timeout: 5000 });
      const inode = JSON.parse(result) as { dev: number; ino: number };
      const stage = directoryIdentity(stagePath);
      if (!stage || !sameInode(stage, { ...stage, ...inode }) || !sameInode(directoryIdentity(parentPath), parent)) {
        throw new RuntimeApiError("cwd_changed", "自动工作区准备目录无法核实，请按原请求重试。");
      }
      request.stage = stage;
      store.withTx(() => saveManagedWorkspaceRequest(store, request));
    }
    const stage = request.stage;
    if (stage.cwdReal !== path.join(parentPath, path.basename(stage.cwdReal)) || !path.basename(stage.cwdReal).startsWith(`.${request.projectId}.prepare-`)) {
      throw new RuntimeApiError("managed_workspace_corrupt", "工作区准备目录记录损坏，请保留原数据并核实记录。");
    }
    if (!existing) {
      if (!sameInode(directoryIdentity(stage.cwdReal), stage)) throw new RuntimeApiError("cwd_changed", "已登记的工作区准备目录丢失或被替换，请恢复原目录后重试。");
      try { execFileSync("python3", [helper, "install", path.basename(stage.cwdReal), request.projectId, String(stage.dev), String(stage.ino)], { stdio: ["ignore", "pipe", "pipe", parentFd], timeout: 5000 }); }
      catch (error) {
        // A lost helper response may follow installation; its original inode proves the result.
        if (!sameInode(directoryIdentity(request.root), stage)) throw error;
      }
    }
    fs.fsyncSync(parentFd);
    const root = directoryIdentity(request.root);
    if (!sameInode(root, stage) || !sameInode(directoryIdentity(parentPath), parent)) throw new RuntimeApiError("cwd_changed", "自动工作区安装后的目录身份已变化，请核实原目录。");
    return root!;
  } finally { fs.closeSync(parentFd); }
}

export function verifyManagedWorkspace(request: ManagedWorkspaceRequest, root: DirIdentity): void {
  const currentRoot = directoryIdentity(request.root), parent = directoryIdentity(path.dirname(request.root));
  if (!request.parent || !request.stage || root.cwdReal !== request.root || root.ino !== request.stage.ino ||
      currentRoot?.ino !== root.ino || parent?.ino !== request.parent.ino) {
    throw new RuntimeApiError("cwd_changed", "自动工作区目录已丢失或被替换，请核实原目录后再使用。");
  }
}
