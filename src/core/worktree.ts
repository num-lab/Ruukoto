/**
 * Git worktree 元数据：检测工作区是否为 worktree 并解析共享 Git 目录。
 *
 * worktree 的 `.git` 是一个文件（内容为 `gitdir: <path>`），其指向
 * <commonGitDir>/worktrees/<name>；仓库的真实元数据（refs、对象、索引规则等）
 * 在 commonGitDir，位于工作区之外。访问它必须由拥有者显式授予（任务级
 * grantedPaths），不能因为是 worktree 就自动挂载主仓库或父目录。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 若 cwdReal 是 Git worktree，返回其共享 Git 目录（common dir）的真实路径；否则 null。 */
export function resolveWorktreeCommonGitDir(cwdReal: string): string | null {
  const gitPath = path.join(cwdReal, ".git");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(gitPath);
  } catch {
    return null;
  }
  if (st.isDirectory()) return null; // 普通仓库：元数据在工作区内
  if (!st.isFile()) return null;
  let content: string;
  try {
    content = fs.readFileSync(gitPath, "utf8").trim();
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/.exec(content);
  if (!m) return null;
  let gitdir: string;
  try {
    gitdir = fs.realpathSync(path.resolve(cwdReal, m[1]!.trim()));
  } catch {
    return null;
  }
  // <common>/.git/worktrees/<name> → <common>/.git
  const mCommon = /^(.*\/\.git)\/worktrees\/[^/]+$/.exec(gitdir);
  return mCommon ? mCommon[1]! : gitdir;
}

/** grantedPath 是否覆盖目标目录（目标即授予路径或其子孙）。 */
export function grantCoversPath(grantedReal: string, targetReal: string): boolean {
  return targetReal === grantedReal || targetReal.startsWith(grantedReal + path.sep);
}
