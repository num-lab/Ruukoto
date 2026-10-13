/**
 * SubAgent 修改工作的写入目标：创建、身份复核和副本差异汇总。
 *
 * 该模块只知道工作副本的文件系统与受限执行边界；工作归属、任务状态和
 * integrated 事件仍由 SubAgentManager 管理。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AccessMode, Session, WorkDelegation, WorkWriteTarget } from "@ruukoto/core/types.ts";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { grantCoversPath, resolveWorktreeCommonGitDir } from "@ruukoto/core/worktree.ts";

export interface WorkCopyExecutor {
  (input: {
    parentTaskId: string;
    workId: string;
    operation: "create" | "integrate";
    workspace: string;
    copyDir: string;
    branch: string;
    command: string;
    extraGrants?: { path: string; access: "read" | "read_write"; purpose: string }[] | null;
  }): Promise<{ isError: boolean; errorMessage?: string; content: string }>;
}

export interface WorkCopyDeps {
  worktreeRoot: string;
  protectedRoots: () => string[];
  executionReaderIdentity?: () => { uid: number; gid: number } | null;
  execute?: WorkCopyExecutor;
}

export class WorkCopyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 汇总事件最多记录的文件名数。 */
export const INTEGRATE_FILE_LIST_CAP = 64;

export interface WorkCopyIntegration {
  state: "applied" | "already" | "empty" | "conflict";
  detail: string;
  parentHead: string | null;
  patchBytes: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function worktreeExtraGrants(
  repoRootReal: string,
  commonGitDir: string,
  purpose: string,
): { path: string; access: "read_write"; purpose: string }[] | null {
  return grantCoversPath(repoRootReal, commonGitDir) ? null : [{ path: commonGitDir, access: "read_write", purpose }];
}

/** 副本根内只允许宿主管理的修改目标，拒绝通过任务授权旁路写入。 */
export function assertWorktreeGrantAllowed(real: string, access: "read" | "read_write", worktreeRoot: string): void {
  if (access === "read_write" && (grantCoversPath(real, worktreeRoot) || grantCoversPath(worktreeRoot, real))) {
    throw new Error("读写授权不能覆盖宿主管理的工作副本根或其下位置（只读仍允许）");
  }
}

export class WorkCopyManager {
  constructor(private readonly deps: WorkCopyDeps) {}

  async prepareWriteTarget(
    raw: string | null | undefined,
    parentSession: Session,
    workId: string,
    parentTaskId: string,
    accessMode: AccessMode = "confirm",
  ): Promise<WorkWriteTarget> {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new WorkCopyError("invalid_params", "mode=modify 需要非空 target");
    }
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(parentSession.cwdReal, raw));
    } catch {
      throw new WorkCopyError("invalid_params", `修改目标不存在：${raw}`);
    }
    if (!grantCoversPath(parentSession.cwdReal, real)) {
      throw new WorkCopyError("forbidden", `修改目标必须位于父工作区内：${raw}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      throw new WorkCopyError("invalid_params", `修改目标不可读：${raw}`);
    }
    if (!stat.isDirectory()) throw new WorkCopyError("invalid_params", `修改目标必须是目录：${raw}`);
    try {
      assertGrantNotProtected(real, this.deps.protectedRoots());
    } catch (err) {
      throw new WorkCopyError("forbidden", (err as Error).message);
    }
    const copyRoot = path.resolve(this.deps.worktreeRoot);
    if (grantCoversPath(copyRoot, real) || grantCoversPath(real, copyRoot)) {
      throw new WorkCopyError("forbidden", "修改目标不能位于宿主 worktree 副本根内");
    }

    const repoRoot = this.findRepoRoot(real, parentSession.cwdReal);
    if (!repoRoot) {
      if (!this.canWrite(real, stat, accessMode)) {
        throw new WorkCopyError("forbidden", `实际执行身份不可写：${raw}`);
      }
      return { kind: "direct", path: real, dev: stat.dev, ino: stat.ino };
    }

    const commonGitDir = this.resolveCommonGitDir(repoRoot);
    if (!commonGitDir) throw new WorkCopyError("invalid_params", `无法定位仓库的共享 Git 目录：${raw}`);
    if (!grantCoversPath(parentSession.cwdReal, commonGitDir)) {
      throw new WorkCopyError("forbidden", `共享 Git 目录不在父工作区内：${commonGitDir}（只允许父工作区持有其元数据）`);
    }
    if (!this.canRead(real, stat, accessMode)) {
      throw new WorkCopyError("forbidden", `实际执行身份不可读仓库目录：${raw}`);
    }
    if (!this.canWrite(commonGitDir, fs.statSync(commonGitDir), accessMode)) {
      throw new WorkCopyError("forbidden", `实际执行身份不可写共享 Git 目录：${commonGitDir}`);
    }

    const branch = `ruukoto/work-${workId}`;
    const copyDir = path.join(this.deps.worktreeRoot, workId);
    fs.mkdirSync(copyRoot, { recursive: true, mode: 0o700 });
    assertGrantNotProtected(copyDir, this.deps.protectedRoots());
    if (fs.existsSync(copyDir)) {
      if (fs.readdirSync(copyDir).length > 0) {
        throw new WorkCopyError("invalid_state", `副本目录已存在：${copyDir}（不自动认领/覆盖残留副本）`);
      }
    } else {
      fs.mkdirSync(copyDir, { mode: 0o700 });
    }
    if (!this.deps.execute) {
      throw new WorkCopyError("execution_unavailable", "宿主缺少 worktree 受限创建入口（执行边界不可用，不回退）");
    }
    const copyDirReal = fs.realpathSync(copyDir);
    const command =
      `set -eu; ` +
      `base=$(git -c core.fsmonitor=false rev-parse --verify HEAD); ` +
      `git -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree add -q -b ${shq(branch)} ${shq(copyDirReal)} "$base"; ` +
      `printf '%s' "$base"`;
    const repoRootReal = fs.realpathSync(repoRoot);
    const extraGrants = worktreeExtraGrants(repoRootReal, commonGitDir, "父仓库本身是 worktree：创建副本需要共享 Git 目录读写（issue 17）");
    const result = await this.deps.execute({ parentTaskId, workId, operation: "create", workspace: repoRootReal, copyDir: copyDirReal, branch, command, extraGrants });
    if (result.isError) {
      const label = result.errorMessage ?? result.content;
      throw new WorkCopyError("worktree_failed", `副本创建失败（路径 ${copyDir}，分支 ${branch}）：${label}；宿主保留现场供核查，不自动重建`);
    }
    const baseCommit = /[0-9a-f]{40}/.exec(result.content)?.[0];
    if (!baseCommit) {
      throw new WorkCopyError("worktree_failed", `副本创建失败（路径 ${copyDir}，分支 ${branch}）：无法从工作进程输出核实基线提交（${result.content.trim() || "(empty)"}）`);
    }
    let copyStat: fs.Stats;
    try {
      copyStat = fs.statSync(copyDir);
    } catch {
      throw new WorkCopyError("worktree_failed", `副本创建后目录不可达（路径 ${copyDir}，分支 ${branch}）：创建失败，现场保留供核查`);
    }
    return {
      kind: "worktree",
      repoRoot: repoRootReal,
      commonGitDir,
      gitdir: path.join(commonGitDir, "worktrees", workId),
      path: copyDirReal,
      dev: copyStat.dev,
      ino: copyStat.ino,
      branch,
      baseCommit,
    };
  }

  assertCopy(work: WorkDelegation, target: Extract<WorkWriteTarget, { kind: "worktree" }>, hint: string): void {
    try {
      const tReal = fs.realpathSync(target.path);
      const tStat = fs.statSync(tReal);
      if (tReal !== target.path || tStat.dev !== target.dev || tStat.ino !== target.ino) {
        throw new WorkCopyError("worktree_gone", `工作 ${work.id} 的 worktree 已被替换，${hint}（路径 ${target.path}）`);
      }
      const content = fs.readFileSync(path.join(tReal, ".git"), "utf8");
      const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
      const resolved = match ? path.resolve(tReal, match[1]!.trim()) : null;
      if (!resolved || !this.sameRealpath(resolved, target.gitdir)) {
        throw new WorkCopyError("worktree_gone", `工作 ${work.id} 的 .git 指向已变化，${hint}（路径 ${target.path}）`);
      }
    } catch (err) {
      if (err instanceof WorkCopyError) throw err;
      throw new WorkCopyError("worktree_gone", `工作 ${work.id} 的 worktree 已不存在，${hint}（路径 ${target.path}）`);
    }
  }

  async integrate(input: {
    work: WorkDelegation;
    target: Extract<WorkWriteTarget, { kind: "worktree" }>;
    parentSession: Session;
    parentTaskId: string;
  }): Promise<WorkCopyIntegration> {
    const { work, target, parentSession } = input;
    this.assertCopy(work, target, "无法汇总");
    let repoRootReal: string;
    try {
      repoRootReal = fs.realpathSync(target.repoRoot);
      fs.lstatSync(path.join(repoRootReal, ".git"));
    } catch {
      throw new WorkCopyError("worktree_gone", `原工作区仓库根已不存在或不可读，无法汇总（路径 ${target.repoRoot}）`);
    }
    if (repoRootReal !== target.repoRoot || !grantCoversPath(parentSession.cwdReal, repoRootReal)) {
      throw new WorkCopyError("forbidden", `原工作区仓库根已不在父会话工作区内，无法汇总（路径 ${target.repoRoot}）`);
    }
    if (!this.deps.execute) throw new WorkCopyError("execution_unavailable", "宿主缺少 worktree 受限入口（执行边界不可用，不回退）");
    const copyDirReal = fs.realpathSync(target.path);
    const repo = repoRootReal;
    // 临时资料由执行单元回收；退出未核实时随专用 TMPDIR 保留，不能用 EXIT trap 删除。
    // Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
    const command =
      "set -eu\n" +
      'temp=$(mktemp -d "${TMPDIR:-/tmp}/ruukoto-integrate.XXXXXX")\n' +
      `git -C ${shq(copyDirReal)} -c core.fsmonitor=false -c core.hooksPath=/dev/null add -N --all\n` +
      `git -C ${shq(copyDirReal)} -c core.fsmonitor=false diff --binary --no-ext-diff -M ${shq(target.baseCommit)} > "$temp/patch"\n` +
      `git -C ${shq(copyDirReal)} -c core.fsmonitor=false diff --numstat --no-ext-diff -M ${shq(target.baseCommit)} > "$temp/numstat"\n` +
      `if [ ! -s "$temp/patch" ]; then echo RUUKOTO_STATE=empty; exit 0; fi\n` +
      `head=$(git -C ${shq(repo)} rev-parse HEAD 2>/dev/null | head -n1 || true)\n` +
      `if git -C ${shq(repo)} apply --check "$temp/patch" 2>"$temp/err"; then\n` +
      `  git -C ${shq(repo)} apply "$temp/patch"\n` +
      `  echo RUUKOTO_STATE=applied\n` +
      `elif git -C ${shq(repo)} apply --check --reverse "$temp/patch" 2>/dev/null; then\n` +
      `  echo RUUKOTO_STATE=already\n` +
      `else\n` +
      `  echo RUUKOTO_STATE=conflict\n` +
      `  cat "$temp/err"\n` +
      `fi\n` +
      `echo "RUUKOTO_HEAD=$head"\n` +
      `echo "RUUKOTO_PATCH_BYTES=$(wc -c < "$temp/patch" | tr -d ' ')"\n` +
      `cat "$temp/numstat"\n`;
    const extraGrants = worktreeExtraGrants(repo, target.commonGitDir, "worktree 副本汇总的共享 Git 目录（issue 17）");
    const result = await this.deps.execute({ parentTaskId: input.parentTaskId, workId: work.id, operation: "integrate", workspace: repo, copyDir: copyDirReal, branch: target.branch, command, extraGrants });
    if (result.isError) {
      const label = (result.errorMessage ?? result.content).slice(0, 1000);
      throw new WorkCopyError("integrate_failed", `改动汇总失败（工作 ${work.id}，副本 ${target.path}）：${label}；父工作区与副本现场保留供核查`);
    }
    return this.parseIntegrationOutput(result.content);
  }

  canRead(real: string, stat: fs.Stats, accessMode: AccessMode = "confirm"): boolean {
    const id = accessMode === "full_access" ? null : this.deps.executionReaderIdentity?.() ?? null;
    if (!id || process.platform === "darwin") {
      try {
        fs.accessSync(real, fs.constants.R_OK | (stat.isDirectory() ? fs.constants.X_OK : 0));
        return true;
      } catch {
        return false;
      }
    }
    const need = stat.isDirectory() ? 0o5 : 0o4;
    const bits = stat.uid === id.uid ? (stat.mode >> 6) & 0o7 : stat.gid === id.gid ? (stat.mode >> 3) & 0o7 : stat.mode & 0o7;
    return (bits & need) === need;
  }

  canWrite(real: string, stat: fs.Stats, accessMode: AccessMode = "confirm"): boolean {
    const id = accessMode === "full_access" ? null : this.deps.executionReaderIdentity?.() ?? null;
    if (!id || process.platform === "darwin") {
      try {
        fs.accessSync(real, fs.constants.W_OK | (stat.isDirectory() ? fs.constants.X_OK : 0));
        return true;
      } catch {
        return false;
      }
    }
    const need = stat.isDirectory() ? 0o3 : 0o2;
    const bits = stat.uid === id.uid ? (stat.mode >> 6) & 0o7 : stat.gid === id.gid ? (stat.mode >> 3) & 0o7 : stat.mode & 0o7;
    return (bits & need) === need;
  }

  private parseIntegrationOutput(content: string): WorkCopyIntegration {
    const stateM = /^RUUKOTO_STATE=(applied|already|empty|conflict)$/m.exec(content);
    const state = (stateM?.[1] ?? "conflict") as WorkCopyIntegration["state"];
    const headM = /^RUUKOTO_HEAD=([0-9a-f]{40})$/m.exec(content);
    const bytesM = /^RUUKOTO_PATCH_BYTES=(\d+)$/m.exec(content);
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    const files: string[] = [];
    for (const line of content.split("\n")) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!match) continue;
      filesChanged += 1;
      if (match[1] !== "-") insertions += Number(match[1]);
      if (match[2] !== "-") deletions += Number(match[2]);
      files.push(match[3]!.trim());
    }
    let detail = "";
    if (state === "conflict" && stateM) {
      const rest = content.slice(stateM.index + stateM[0].length);
      const cut = rest.search(/^RUUKOTO_HEAD=/m);
      detail = (cut >= 0 ? rest.slice(0, cut) : rest).trim().slice(0, 2000);
    }
    return {
      state,
      detail,
      parentHead: headM?.[1] ?? null,
      patchBytes: bytesM ? Number(bytesM[1]) : 0,
      filesChanged,
      insertions,
      deletions,
      files,
    };
  }

  private sameRealpath(a: string, b: string): boolean {
    try { return fs.realpathSync(a) === fs.realpathSync(b); }
    catch { return false; }
  }

  private findRepoRoot(startReal: string, workspaceReal: string): string | null {
    let dir = startReal;
    for (;;) {
      try {
        const stat = fs.lstatSync(path.join(dir, ".git"));
        if (stat.isDirectory() || stat.isFile()) return dir;
      } catch {
        // 继续向父目录查找
      }
      if (dir === workspaceReal) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private resolveCommonGitDir(repoRoot: string): string | null {
    const gitPath = path.join(repoRoot, ".git");
    let stat: fs.Stats;
    try { stat = fs.lstatSync(gitPath); }
    catch { return null; }
    if (stat.isDirectory()) {
      try { return fs.realpathSync(gitPath); }
      catch { return null; }
    }
    if (!stat.isFile()) return null;
    return resolveWorktreeCommonGitDir(repoRoot);
  }
}
