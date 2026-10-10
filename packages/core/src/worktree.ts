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

/**
 * 容器内 git 的 dubious ownership 豁免（agent-direction issue 16）：容器 uid 与
 * 仓库属主不一致时 git 拒绝在挂载的宿主路径下工作。宿主只在 worktree 副本的创建
 * 与挂载任务注入这组环境（其余任务容器环境不变）；不落宿主、不被模型读取。
 */
export const GIT_SAFE_DIRECTORY_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
};

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

/**
 * 任务的工作区目录身份（agent-direction issue 16）：有写入目标的任务用工
 * 作钉定的 path/dev/ino（worktree 副本或直接写入根）；否则用会话目录身份
 * （占用键与 LaunchSpec 的 workspace 统一由它取）。
 */
export function taskWorkspaceFor(input: {
  session: { cwdReal: string; cwdDev: number; cwdIno: number };
  work?: { writeTarget?: { kind: string; path: string; dev: number; ino: number; commonGitDir?: string } | null } | null;
}): { path: string; dev: number; ino: number; isWriteTarget: boolean; commonGitDir?: string } {
  const target = input.work?.writeTarget ?? null;
  if (target !== null && target !== undefined) {
    return {
      path: target.path,
      dev: target.dev,
      ino: target.ino,
      isWriteTarget: true,
      commonGitDir: target.kind === "worktree" ? target.commonGitDir : undefined,
    };
  }
  return { path: input.session.cwdReal, dev: input.session.cwdDev, ino: input.session.cwdIno, isWriteTarget: false };
}
