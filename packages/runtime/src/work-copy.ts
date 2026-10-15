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
import { inflateSync } from "node:zlib";
import { isUtf8 } from "node:buffer";
import type { Session, WorkDelegation, WorkWriteTarget } from "@ruukoto/core/types.ts";
import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import { grantCoversPath, resolveWorktreeCommonGitDir } from "@ruukoto/core/worktree.ts";
import { WORKSPACE_SNAPSHOT_SCRIPT } from "./workspace-snapshot-script.ts";
import { requireWorkspaceSnapshot, snapshotWorkspace, WorkspaceSnapshotError, type WorkspaceSnapshot } from "@ruukoto/core/workspace-snapshot.ts";

export interface WorkCopyExecution { kind: "task" | "workflow-host" | "work-copy-host"; taskId: string }

export interface WorkCopyExecutor {
  (input: {
    parentTaskId: string;
    execution?: WorkCopyExecution;
    workId: string;
    operation: "capture" | "create" | "freeze" | "verify" | "integrate";
    source?: { path: string; dev: number; ino: number };
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
  snapshotDigest: string;
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

/** 原索引、实际共享索引和阶段条目由同一摘要认证；恢复不现场读取来源索引。 */
function assertSnapshotIndex(snapshot: WorkspaceSnapshot): Buffer {
  const repository = snapshot.repository.path;
  const reject = (): never => { throw new WorkCopyError("snapshot_corrupt", "捕获的索引缺失或损坏；保留成果并报告拥有者"); };
  const read = (name: string): Buffer => {
    const file = path.join(repository, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) reject();
    return fs.readFileSync(file);
  };
  const files: unknown = JSON.parse(read("ruukoto-index-files").toString());
  if (!Array.isArray(files) || files.length < 2 || files.length > 3 || files[0] !== "ruukoto-source-index" || files[1] !== "ruukoto-source-stages" ||
      (files.length === 3 && (typeof files[2] !== "string" || !/^sharedindex\.[0-9a-f]{40}$/.test(files[2])))) reject();
  const digest = createHash("sha256");
  let stages: Buffer = Buffer.alloc(0);
  for (const name of files as string[]) {
    const bytes = read(name);
    digest.update(name + "\0" + bytes.length + "\0").update(bytes);
    if (name === "ruukoto-source-stages") stages = bytes;
  }
  if (digest.digest("hex") !== snapshot.indexDigest) reject();
  return stages;
}

/** 私有格式只含 loose 对象；检查不执行 Git，避免恢复预检取得仓库执行资格。 */
function assertSnapshotObjects(snapshot: WorkspaceSnapshot, stages: Buffer): void {
  const repository = snapshot.repository.path, objects = path.join(repository, "objects");
  function reject(): never { throw new WorkCopyError("snapshot_corrupt", "基线对象缺失、损坏或指向其他目录；保留副本并报告拥有者"); }
  for (const name of ["commondir", "gitdir", "objects/info/alternates"]) if (fs.existsSync(path.join(repository, name))) reject();
  const entries = new Map<string, { type: string; body?: Buffer }>();
  const walk = (directory: string): void => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject();
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { walk(file); continue; }
      const relative = path.relative(objects, file);
      if (!stat.isFile() || stat.nlink !== 1 || !/^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(relative)) reject();
      const oid = relative.replace("/", ""), raw = inflateSync(fs.readFileSync(file));
      if (createHash("sha1").update(raw).digest("hex") !== oid) reject();
      const end = raw.indexOf(0), header = raw.subarray(0, end).toString(), match = /^(blob|tree) (\d+)$/.exec(header);
      if (end < 0 || !match || raw.length - end - 1 !== Number(match[2])) reject();
      entries.set(oid, { type: match[1], ...(match[1] === "tree" ? { body: raw.subarray(end + 1) } : {}) });
    }
  };
  walk(objects);
  const visited = new Set<string>();
  const tree = (oid: string): void => {
    if (visited.has(oid)) return;
    visited.add(oid);
    const entry = entries.get(oid);
    if (!entry?.body || entry.type !== "tree") reject();
    const body = entry.body;
    for (let cursor = 0; cursor < body.length;) {
      const space = body.indexOf(32, cursor), end = body.indexOf(0, space + 1);
      if (space < cursor || end <= space + 1 || end + 21 > body.length) reject();
      const mode = body.subarray(cursor, space).toString(), name = body.subarray(space + 1, end);
      if (!isUtf8(name) || [".", "..", ".git"].includes(name.toString()) || name.includes(47)) reject();
      const child = body.subarray(end + 1, end + 21).toString("hex");
      if (mode === "40000") tree(child);
      else if (!["100644", "100755", "120000"].includes(mode) || entries.get(child)?.type !== "blob") reject();
      cursor = end + 21;
    }
  };
  tree(snapshot.tree);
  if (!isUtf8(stages)) reject();
  for (const record of stages.toString().split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) ([0-9a-f]{40}) [0-3]\t.+$/s.exec(record);
    if (!match || entries.get(match[2])?.type !== "blob") reject();
  }
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
    options: { gitOnly?: boolean; snapshot?: WorkspaceSnapshot } = {},
  ): Promise<WorkWriteTarget> {
    if (options.snapshot) this.assertSnapshot(options.snapshot);
    if (typeof raw !== "string" || !raw.trim()) {
      throw new WorkCopyError("invalid_params", "工作区准备需要非空 target");
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
      if (options.gitOnly || options.snapshot) throw new WorkCopyError("git_required", "受保护目标或工作流成果需要 Git 工作区；请提供 Git 目标，或使用无目标的独立目录处理资料");
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
    const repoRootReal = fs.realpathSync(repoRoot);
    const repoStat = fs.statSync(repoRootReal);
    const source = { path: repoRootReal, dev: repoStat.dev, ino: repoStat.ino };
    let snapshot = options.snapshot;
    if (!snapshot) {
      const snapshotRoot = path.join(copyRoot, ".snapshots");
      fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
      const repository = fs.realpathSync(fs.mkdtempSync(path.join(snapshotRoot, `${workId}-`)));
      const capture = this.scriptCommand("capture", { source: repoRootReal, gitdir: repository, index: path.join(repository, "capture-index") });
      const result = await this.deps.execute({ parentTaskId, execution, workId, operation: "capture", source,
        workspace: copyDirReal, copyDir: copyDirReal, branch, command: capture,
        extraGrants: [{ path: repository, access: "read_write", purpose: "当前工作区的独立基线对象" },
          { path: repoRootReal, access: "read", purpose: "捕获当前工作区，不写入来源" },
          ...(grantCoversPath(repoRootReal, commonGitDir) ? [] : [{ path: commonGitDir, access: "read" as const, purpose: "捕获来源 Git 索引与对象" }])] });
      this.assertExecutionResult(result, "snapshot_failed", `当前内容捕获失败（副本 ${copyDirReal}，分支 ${branch}）`);
      let captured: { head: string; tree: string; commonGitPath: string; indexDigest: string; dev: number; ino: number };
      try { captured = JSON.parse(fs.readFileSync(path.join(repository, "ruukoto-baseline"), "utf8")) as typeof captured; }
      catch { throw new WorkCopyError("snapshot_corrupt", `捕获基线未完整落盘（副本 ${copyDirReal}），现场保留，请报告拥有者`); }
      if (captured.dev !== source.dev || captured.ino !== source.ino || captured.commonGitPath !== commonGitDir) throw new WorkCopyError("snapshot_changed", "捕获期间目标目录已被替换；保留现场，请重新准备目标");
      const privateStat = fs.statSync(repository), commonStat = fs.statSync(commonGitDir);
      snapshot = snapshotWorkspace({ version: 1, source, commonGit: { path: commonGitDir, dev: commonStat.dev, ino: commonStat.ino },
        repository: { path: repository, dev: privateStat.dev, ino: privateStat.ino }, head: captured.head, tree: captured.tree, indexDigest: captured.indexDigest });
    }
    this.assertSnapshot(snapshot);
    if (snapshot.source.path !== repoRootReal || snapshot.commonGit.path !== commonGitDir) throw new WorkCopyError("snapshot_invalid", "基线不属于当前目标；保留副本并报告拥有者");
    // 登记不 checkout，避免仓库配置的 smudge/filter 写入来源；原始内容由私有对象物化。
    const command = "set -eu\n" +
      `git --git-dir=${shq(commonGitDir)} -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree add --no-checkout -q -b ${shq(branch)} ${shq(copyDirReal)} ${shq(snapshot.head)}\n` +
      `git -C ${shq(copyDirReal)} -c core.fsmonitor=false -c core.hooksPath=/dev/null read-tree ${shq(snapshot.head)}\n` +
      this.scriptCommand("materialize", { tree: snapshot.tree, gitdir: snapshot.repository.path, destination: copyDirReal });
    const result = await this.deps.execute({ parentTaskId, execution, workId, operation: "create", source,
      workspace: copyDirReal, copyDir: copyDirReal, branch, command,
      extraGrants: [{ path: commonGitDir, access: "read_write", purpose: "宿主登记专属分支与工作副本元数据" },
        { path: snapshot.repository.path, access: "read", purpose: "物化已捕获的原始基线" }] });
    this.assertExecutionResult(result, "worktree_failed", `副本创建失败（路径 ${copyDirReal}，分支 ${branch}）`);
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
      baseCommit: snapshot.head,
      snapshot,
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
    return { workId: input.work.id, baseCommit: input.target.baseCommit, snapshotDigest: input.target.snapshot.digest, patch, bytes: patch.length,
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
      input.parentTaskId, input.execution, { gitOnly: true, snapshot: input.target.snapshot });
    if (target.kind !== "worktree") throw new WorkCopyError("git_required", "验证需要独立 Git 副本");
    const temp = this.patchDirectory();
    const patchFile = path.join(temp, "patch");
    fs.writeFileSync(patchFile, input.frozen.patch, { mode: 0o600 });
    const command = input.frozen.bytes === 0 ? "true" : "set -eu\n" +
      `git -C ${shq(target.path)} -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.symlinks=true apply --check ${shq(patchFile)}\n` +
      `git -C ${shq(target.path)} -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.symlinks=true apply ${shq(patchFile)}\n`;
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
      this.integrationCommand(input.target, repo, frozenFile, numstatFile, temp);
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
      source: input.target.snapshot.source,
      operation: "integrate", workspace: input.workspace ?? input.target.repoRoot, copyDir: input.target.path, copyAccess: "read", branch: input.target.branch,
      command: input.command, extraGrants: [{ path: input.target.commonGitDir, access: "read", purpose: "组合检查的共享 Git 元数据" }] });
  }

  private assertFrozen(input: FrozenWorkCopyInput & { frozen: FrozenWorkCopyPatch }): void {
    const frozen = input.frozen;
    if (frozen.workId !== input.work.id || frozen.baseCommit !== input.target.baseCommit || frozen.snapshotDigest !== input.target.snapshot.digest ||
        frozen.bytes !== frozen.patch.length || createHash("sha256").update(frozen.patch).digest("hex") !== frozen.digest) {
      throw new WorkCopyError("frozen_invalid", "冻结补丁的工作、基线或字节摘要不一致，保留现场，请重新验证成果");
    }
  }

  private patchDirectory(): string {
    fs.mkdirSync(this.deps.worktreeRoot, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(this.deps.worktreeRoot, ".workflow-patch-"));
  }

  private scriptCommand(action: string, input: Record<string, unknown>): string {
    return `node -e ${shq(WORKSPACE_SNAPSHOT_SCRIPT)} ${shq(action)} ${shq(JSON.stringify(input))}\n`;
  }

  private snapshotGit(target: GitWriteTarget): string {
    return `git --no-replace-objects --git-dir=${shq(target.snapshot.repository.path)} -c core.fsmonitor=false -c core.hooksPath=/dev/null`;
  }

  private diffCommand(target: GitWriteTarget, destination: string): string {
    const temp = path.dirname(destination);
    return "set -eu\n" +
      `ruukoto_tree=$(${this.scriptCommand("tree", { source: target.path, gitdir: target.snapshot.repository.path, index: path.join(temp, "index"), seedTree: target.snapshot.tree }).trim()})\n` +
      `${this.snapshotGit(target)} diff --binary --no-ext-diff --no-textconv -M ${shq(target.snapshot.tree)} "$ruukoto_tree" > ${shq(destination)}\n`;
  }

  private integrationCommand(target: GitWriteTarget, repo: string, patch: string, numstat: string, temp: string): string {
    const report = path.join(temp, "baseline-check");
    return `if [ ! -s ${shq(patch)} ]; then echo RUUKOTO_STATE=empty; exit 0; fi\n` +
      `${this.snapshotGit(target)} diff --numstat --no-ext-diff --no-textconv -M ${shq(target.snapshot.tree)} "$ruukoto_tree" > ${shq(numstat)}\n` +
      `ruukoto_state=$(${this.scriptCommand("check", { source: repo, gitdir: target.snapshot.repository.path, baselineTree: target.snapshot.tree, report }).trim()} "$ruukoto_tree")\n` +
      `head=$(git -C ${shq(repo)} -c core.fsmonitor=false rev-parse --verify HEAD)\n` +
      `if [ "$ruukoto_state" = already ]; then echo RUUKOTO_STATE=already\n` +
      `elif [ "$ruukoto_state" = baseline ] && git -C ${shq(repo)} -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.symlinks=true apply --whitespace=nowarn --check ${shq(patch)} 2>${shq(path.join(temp, "err"))}; then\n` +
      `  git -C ${shq(repo)} -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.symlinks=true apply --whitespace=nowarn ${shq(patch)}\n` +
      `  echo RUUKOTO_STATE=applied\n` +
      `else\n  echo RUUKOTO_STATE=conflict\n  cat ${shq(report)}\n  if [ -f ${shq(path.join(temp, "err"))} ]; then cat ${shq(path.join(temp, "err"))}; fi\nfi\n` +
      `echo "RUUKOTO_HEAD=$head"\necho "RUUKOTO_PATCH_BYTES=$(wc -c < ${shq(patch)} | tr -d ' ')"\ncat ${shq(numstat)}\n`;
  }

  private assertExecutionResult(result: Awaited<ReturnType<WorkCopyExecutor>>, code: string, context = "工作副本操作失败"): void {
    const error = /^RUUKOTO_SNAPSHOT_ERROR=(.+)$/m.exec(result.content);
    if (error) {
      const detail = JSON.parse(error[1]) as { code: string; message: string };
      throw new WorkCopyError(detail.code, detail.message);
    }
    if (result.isError) throw new WorkCopyError(code, `${context}，副本与临时资料保留供核实：${result.errorMessage ?? result.content}`);
  }

  private assertSnapshot(value: WorkspaceSnapshot): void {
    let snapshot: WorkspaceSnapshot;
    try { snapshot = requireWorkspaceSnapshot(value); }
    catch (error) {
      if (error instanceof WorkspaceSnapshotError) throw new WorkCopyError(error.code, error.message);
      throw error;
    }
    try {
      for (const identity of [snapshot.source, snapshot.commonGit, snapshot.repository]) {
        const real = fs.realpathSync(identity.path), stat = fs.statSync(real);
        if (real !== identity.path || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new WorkCopyError("snapshot_changed", "基线的来源或对象目录已被替换；保留副本并报告拥有者");
      }
      if (this.resolveCommonGitDir(snapshot.source.path) !== snapshot.commonGit.path) throw new WorkCopyError("snapshot_changed", "来源的 Git 指向已变化；保留副本，请核实原工作区后重新准备目标");
      if (!grantCoversPath(fs.realpathSync(path.join(this.deps.worktreeRoot, ".snapshots")), snapshot.repository.path)) throw new WorkCopyError("snapshot_invalid", "基线对象不在宿主管理目录内；保留成果并报告拥有者");
      const baseline = JSON.parse(fs.readFileSync(path.join(snapshot.repository.path, "ruukoto-baseline"), "utf8")) as { head: string; tree: string; commonGitPath: string; indexDigest: string; dev: number; ino: number };
      if (baseline.commonGitPath !== snapshot.commonGit.path || baseline.head !== snapshot.head || baseline.tree !== snapshot.tree || baseline.indexDigest !== snapshot.indexDigest ||
          baseline.dev !== snapshot.source.dev || baseline.ino !== snapshot.source.ino) throw new WorkCopyError("snapshot_corrupt", "私有基线与已登记快照不符；保留成果并报告拥有者");
      assertSnapshotObjects(snapshot, assertSnapshotIndex(snapshot));
    } catch (error) {
      if (error instanceof WorkCopyError) throw error;
      throw new WorkCopyError("snapshot_corrupt", "私有基线缺失或损坏；保留成果并报告拥有者");
    }
  }

  private async executeFrozen(input: FrozenWorkCopyInput, operation: "freeze" | "verify" | "integrate",
    workspace: string, command: string, temp: string): ReturnType<WorkCopyExecutor> {
    if (!this.deps.execute) throw new WorkCopyError("execution_unavailable", "宿主缺少工作副本执行入口，请保留成果并恢复执行环境");
    const result = await this.deps.execute({ parentTaskId: input.parentTaskId, execution: input.execution, workId: input.work.id,
      operation, workspace, source: input.target.snapshot.source, copyDir: input.target.path, branch: input.target.branch, command,
      extraGrants: [{ path: temp, access: "read_write", purpose: "冻结补丁的临时传输目录" },
        { path: input.target.snapshot.repository.path, access: "read_write", purpose: "子增量的独立对象与索引" },
        { path: input.target.commonGitDir, access: "read", purpose: "工作副本的只读共享 Git 元数据" }] });
    this.assertExecutionResult(result, `${operation}_failed`);
    return result;
  }

  assertCopy(work: WorkDelegation, target: Extract<WorkWriteTarget, { kind: "worktree" }>, hint: string): void {
    this.assertSnapshot(target.snapshot);
    if (target.baseCommit !== target.snapshot.head || target.repoRoot !== target.snapshot.source.path || target.commonGitDir !== target.snapshot.commonGit.path) throw new WorkCopyError("snapshot_invalid", "副本与捕获基线的归属不符；保留成果并报告拥有者");
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
    const temp = this.patchDirectory();
    const patch = path.join(temp, "patch"), numstat = path.join(temp, "numstat");
    const command = this.diffCommand(target, patch) + this.integrationCommand(target, repoRootReal, patch, numstat, temp);
    const result = await this.executeFrozen({ work, target, parentTaskId: input.parentTaskId, execution: input.execution }, "integrate", repoRootReal, command, temp);
    fs.rmSync(temp, { recursive: true });
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
