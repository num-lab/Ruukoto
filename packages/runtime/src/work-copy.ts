/**
 * SubAgent 修改工作的写入目标：创建、身份复核和副本差异汇总。
 *
 * 该模块只知道工作副本的文件系统与受限执行边界；工作归属、任务状态和
 * integrated 事件仍由 SubAgentManager 管理。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-12-personal-native-sandbox.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Session, WorkDelegation, WorkWriteTarget } from "@ruukoto/core/types.ts";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { grantCoversPath, resolveWorktreeCommonGitDir } from "@ruukoto/core/worktree.ts";

export interface WorkCopyExecution { kind: "task" | "workflow-host"; taskId: string }

export interface WorkCopyExecutor {
  (input: {
    parentTaskId: string;
    execution?: WorkCopyExecution;
    workId: string;
    operation: "create" | "freeze" | "verify" | "integrate";
    workspace: string;
    copyDir: string;
    branch: string;
    command: string;
    copyAccess?: "read" | "read_write";
    extraGrants?: { path: string; access: "read" | "read_write"; purpose: string }[] | null;
  }): Promise<{ isError: boolean; errorMessage?: string; content: string }>;
}

export interface WorkCopyDeps {
  worktreeRoot: string;
  protectedRoots: () => string[];
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

export interface FrozenWorkCopyPatch {
  workId: string;
  baseCommit: string;
  patch: Buffer;
  digest: string;
  bytes: number;
}

type GitWriteTarget = Extract<WorkWriteTarget, { kind: "worktree" }>;
interface FrozenWorkCopyInput {
  work: WorkDelegation;
  target: GitWriteTarget;
  parentTaskId: string;
  execution?: WorkCopyExecution;
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
    execution?: WorkCopyExecution,
    options: { gitOnly?: boolean; baseCommit?: string } = {},
  ): Promise<WorkWriteTarget> {
    if (options.baseCommit && !/^[0-9a-f]{40}$/.test(options.baseCommit)) throw new WorkCopyError("invalid_params", "验证副本的基线提交无效");
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
      if (options.gitOnly || options.baseCommit) throw new WorkCopyError("git_required", "工作流修改需要 Git 工作区：未创建副本或写入目标，请改为分析步骤");
      if (!this.canWrite(real, stat)) {
        throw new WorkCopyError("forbidden", `实际执行身份不可写：${raw}`);
      }
      return { kind: "direct", path: real, dev: stat.dev, ino: stat.ino };
    }

    const commonGitDir = this.resolveCommonGitDir(repoRoot);
    if (!commonGitDir) throw new WorkCopyError("invalid_params", `无法定位仓库的共享 Git 目录：${raw}`);
    if (!grantCoversPath(parentSession.cwdReal, commonGitDir)) {
      throw new WorkCopyError("forbidden", `共享 Git 目录不在父工作区内：${commonGitDir}（只允许父工作区持有其元数据）`);
    }
    if (!this.canRead(real, stat)) {
      throw new WorkCopyError("forbidden", `实际执行身份不可读仓库目录：${raw}`);
    }
    if (!this.canWrite(commonGitDir, fs.statSync(commonGitDir))) {
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
    const base = options.baseCommit ? shq(options.baseCommit) : "HEAD";
    const command =
      `set -eu; ` +
      `base=$(git -c core.fsmonitor=false rev-parse --verify ${base}); ` +
      `git -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree add -q -b ${shq(branch)} ${shq(copyDirReal)} "$base"; ` +
      `printf '%s' "$base"`;
    const repoRootReal = fs.realpathSync(repoRoot);
    const extraGrants = worktreeExtraGrants(repoRootReal, commonGitDir, "父仓库本身是 worktree：创建副本需要共享 Git 目录读写（issue 17）");
    const result = await this.deps.execute({ parentTaskId, execution, workId, operation: "create", workspace: repoRootReal, copyDir: copyDirReal, branch, command, extraGrants });
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

  /** 调用方须先核实修改执行停止，并在冻结与登记期间持续持有副本占用；返回原始补丁字节供产物存储。 */
  async freeze(input: FrozenWorkCopyInput): Promise<FrozenWorkCopyPatch> {
    this.assertCopy(input.work, input.target, "无法冻结成果");
    const temp = this.patchDirectory();
    const patchFile = path.join(temp, "patch");
    await this.executeFrozen(input, "freeze", input.target.path, this.diffCommand(input.target, patchFile), temp);
    const patch = fs.readFileSync(patchFile);
    fs.rmSync(temp, { recursive: true });
    return { workId: input.work.id, baseCommit: input.target.baseCommit, patch, bytes: patch.length,
      digest: createHash("sha256").update(patch).digest("hex") };
  }

  /** 验证写入只落独立副本；固定基线与冻结字节不随原仓库 HEAD 或修改副本变化。 */
  async prepareVerificationTarget(input: FrozenWorkCopyInput & {
    frozen: FrozenWorkCopyPatch;
    parentSession: Session;
    verificationWorkId: string;
  }): Promise<GitWriteTarget> {
    this.assertFrozen(input);
    this.assertCopy(input.work, input.target, "无法建立验证副本");
    const target = await this.prepareWriteTarget(input.target.repoRoot, input.parentSession, input.verificationWorkId,
      input.parentTaskId, input.execution, { gitOnly: true, baseCommit: input.frozen.baseCommit });
    if (target.kind !== "worktree") throw new WorkCopyError("git_required", "验证需要独立 Git 副本");
    const temp = this.patchDirectory();
    const patchFile = path.join(temp, "patch");
    fs.writeFileSync(patchFile, input.frozen.patch, { mode: 0o600 });
    const command = input.frozen.bytes === 0 ? "true" : "set -eu\n" +
      `git -C ${shq(target.path)} -c core.fsmonitor=false -c core.hooksPath=/dev/null apply --check ${shq(patchFile)}\n` +
      `git -C ${shq(target.path)} -c core.fsmonitor=false -c core.hooksPath=/dev/null apply ${shq(patchFile)}\n`;
    await this.executeFrozen({ ...input, target }, "verify", target.path, command, temp);
    fs.rmSync(temp, { recursive: true });
    return target;
  }

  /** 调用方持续占用副本与目标直至组合检查结束；当前成果字节不匹配时零套用，只套用已冻结补丁。 */
  async integrateFrozen(input: FrozenWorkCopyInput & { frozen: FrozenWorkCopyPatch; parentSession: Session }): Promise<WorkCopyIntegration> {
    this.assertFrozen(input);
    this.assertCopy(input.work, input.target, "无法汇总冻结成果");
    const repo = fs.realpathSync(input.target.repoRoot);
    if (repo !== input.target.repoRoot || !grantCoversPath(input.parentSession.cwdReal, repo)) {
      throw new WorkCopyError("forbidden", "原仓库已不在来源工作区内，保留成果，请核实目标后重新验证");
    }
    const temp = this.patchDirectory();
    const frozenFile = path.join(temp, "frozen");
    const currentFile = path.join(temp, "current");
    const numstatFile = path.join(temp, "numstat");
    fs.writeFileSync(frozenFile, input.frozen.patch, { mode: 0o600 });
    const command = this.diffCommand(input.target, currentFile) +
      `if ! cmp -s ${shq(frozenFile)} ${shq(currentFile)}; then echo RUUKOTO_STATE=stale; exit 0; fi\n` +
      `if [ ! -s ${shq(frozenFile)} ]; then echo RUUKOTO_STATE=empty; exit 0; fi\n` +
      `git -C ${shq(input.target.path)} -c core.fsmonitor=false diff --numstat --no-ext-diff --no-textconv -M ${shq(input.target.baseCommit)} > ${shq(numstatFile)}\n` +
      `head=$(git -C ${shq(repo)} rev-parse HEAD)\n` +
      `if git -C ${shq(repo)} -c core.hooksPath=/dev/null apply --check ${shq(frozenFile)} 2>${shq(path.join(temp, "err"))}; then\n` +
      `  git -C ${shq(repo)} -c core.hooksPath=/dev/null apply ${shq(frozenFile)}\n` +
      `  echo RUUKOTO_STATE=applied\n` +
      `elif git -C ${shq(repo)} apply --check --reverse ${shq(frozenFile)} 2>/dev/null; then\n` +
      `  echo RUUKOTO_STATE=already\n` +
      `else\n  echo RUUKOTO_STATE=conflict\n  cat ${shq(path.join(temp, "err"))}\nfi\n` +
      `echo "RUUKOTO_HEAD=$head"\necho RUUKOTO_PATCH_BYTES=${input.frozen.bytes}\ncat ${shq(numstatFile)}\n`;
    const result = await this.executeFrozen(input, "integrate", repo, command, temp);
    fs.rmSync(temp, { recursive: true });
    if (/^RUUKOTO_STATE=stale$/m.test(result.content)) throw new WorkCopyError("frozen_changed", "副本成果已变化，未套用任何补丁；请重新冻结并由独立验证者验证");
    return this.parseIntegrationOutput(result.content);
  }

  /** 组合检查沿同一宿主任务执行，目录占用由调用方保持到整体收尾。 */
  async check(input: FrozenWorkCopyInput & { command: string; workspace?: string }): ReturnType<WorkCopyExecutor> {
    this.assertCopy(input.work, input.target, "无法检查组合成果");
    if (!this.deps.execute) throw new WorkCopyError("execution_unavailable", "宿主缺少工作副本执行入口，请保留成果并恢复执行环境");
    return this.deps.execute({ parentTaskId: input.parentTaskId, execution: input.execution, workId: input.work.id,
      operation: "integrate", workspace: input.workspace ?? input.target.repoRoot, copyDir: input.target.path, copyAccess: "read", branch: input.target.branch,
      command: input.command, extraGrants: worktreeExtraGrants(input.target.repoRoot, input.target.commonGitDir, "组合检查的共享 Git 元数据") });
  }

  private assertFrozen(input: FrozenWorkCopyInput & { frozen: FrozenWorkCopyPatch }): void {
    const frozen = input.frozen;
    if (frozen.workId !== input.work.id || frozen.baseCommit !== input.target.baseCommit ||
        frozen.bytes !== frozen.patch.length || createHash("sha256").update(frozen.patch).digest("hex") !== frozen.digest) {
      throw new WorkCopyError("frozen_invalid", "冻结补丁的工作、基线或字节摘要不一致，保留现场，请重新验证成果");
    }
  }

  private patchDirectory(): string {
    fs.mkdirSync(this.deps.worktreeRoot, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(this.deps.worktreeRoot, ".workflow-patch-"));
  }

  private diffCommand(target: GitWriteTarget, destination: string): string {
    return `set -eu\ngit -C ${shq(target.path)} -c core.fsmonitor=false -c core.hooksPath=/dev/null add -N --all\n` +
      `git -C ${shq(target.path)} -c core.fsmonitor=false diff --binary --no-ext-diff --no-textconv -M ${shq(target.baseCommit)} > ${shq(destination)}\n`;
  }

  private async executeFrozen(input: FrozenWorkCopyInput, operation: "freeze" | "verify" | "integrate",
    workspace: string, command: string, temp: string): ReturnType<WorkCopyExecutor> {
    if (!this.deps.execute) throw new WorkCopyError("execution_unavailable", "宿主缺少工作副本执行入口，请保留成果并恢复执行环境");
    const result = await this.deps.execute({ parentTaskId: input.parentTaskId, execution: input.execution, workId: input.work.id,
      operation, workspace, copyDir: input.target.path, branch: input.target.branch, command,
      extraGrants: [{ path: temp, access: "read_write", purpose: "冻结补丁的临时传输目录" },
        ...(worktreeExtraGrants(workspace, input.target.commonGitDir, "工作流成果的共享 Git 元数据") ?? [])] });
    if (result.isError) throw new WorkCopyError(`${operation}_failed`, `工作流成果操作失败，副本与临时补丁保留供核实：${result.errorMessage ?? result.content}`);
    return result;
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
    execution?: WorkCopyExecution;
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
    const result = await this.deps.execute({ parentTaskId: input.parentTaskId, execution: input.execution, workId: work.id, operation: "integrate", workspace: repo, copyDir: copyDirReal, branch: target.branch, command, extraGrants });
    if (result.isError) {
      const label = (result.errorMessage ?? result.content).slice(0, 1000);
      throw new WorkCopyError("integrate_failed", `改动汇总失败（工作 ${work.id}，副本 ${target.path}）：${label}；父工作区与副本现场保留供核查`);
    }
    return this.parseIntegrationOutput(result.content);
  }

  canRead(real: string, stat: fs.Stats): boolean {
    try {
      fs.accessSync(real, fs.constants.R_OK | (stat.isDirectory() ? fs.constants.X_OK : 0));
      return true;
    } catch {
      return false;
    }
  }

  canWrite(real: string, stat: fs.Stats): boolean {
    try {
      fs.accessSync(real, fs.constants.W_OK | (stat.isDirectory() ? fs.constants.X_OK : 0));
      return true;
    } catch {
      return false;
    }
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
