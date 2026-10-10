/**
 * 工作目录身份：realpath 规范化 + 设备号/inode。
 *
 * 任务开始前与占用检查都用它核对目录身份，覆盖：
 * - 符号链接：realpath 解析后指向同一真实路径；
 * - 同一目录的挂载别名：dev+ino 相同；
 * - 排队期间目录被替换或失效：realpath/stat 与登记值不一致时拒绝启动。
 *
 * 互斥保证只覆盖本后台管理的任务；外部编辑器写入不在此列。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface DirIdentity {
  /** 调用方传入的路径（原样记录）。 */
  cwd: string;
  /** realpath 规范化路径。 */
  cwdReal: string;
  dev: number;
  ino: number;
}

export class DirIdentityError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function resolveDirIdentity(cwd: string): Promise<DirIdentity> {
  let real: string;
  let stat: fs.Stats;
  try {
    real = await fs.promises.realpath(cwd);
    stat = await fs.promises.stat(real);
  } catch (err) {
    throw new DirIdentityError(`工作目录不可用：${cwd}（${(err as Error).message}）`);
  }
  if (!stat.isDirectory()) {
    throw new DirIdentityError(`工作目录不是目录：${cwd}`);
  }
  return { cwd: path.resolve(cwd), cwdReal: real, dev: stat.dev, ino: stat.ino };
}

/**
 * 目录身份相同判定：realpath 相同（覆盖符号链接别名）或 dev+ino 相同
 * （覆盖挂载别名）。两个目录因此不会因同名或别名被合并，也不会重复归属。
 */
export function sameDirIdentity(a: DirIdentity, b: DirIdentity): boolean {
  return a.cwdReal === b.cwdReal || (a.dev === b.dev && a.ino === b.ino);
}

/**
 * 登记的会话目录按真实身份去重（符号链接与挂载别名归并为一个组）。
 * 只比较登记值，不做文件系统核实；目录是否仍有效由调用方另行核查
 * （agent-direction issue 07：多目录判定与迁移预览共用同一分组规则）。
 */
export function distinctDirIdentities(
  sessions: Array<{ cwd: string; cwdReal: string; cwdDev: number; cwdIno: number }>,
): DirIdentity[] {
  const out: DirIdentity[] = [];
  for (const s of sessions) {
    const identity: DirIdentity = { cwd: s.cwd, cwdReal: s.cwdReal, dev: s.cwdDev, ino: s.cwdIno };
    if (!out.some((existing) => sameDirIdentity(existing, identity))) out.push(identity);
  }
  return out;
}

/**
 * 目录入口认领条件的共同形状（agent-direction issue 07 步骤 2 收紧）：
 * 项目的会话集合全部为普通 dev 且非角色绑定，且同属一个登记真实目录——
 * 不满足即不能在迁移流程之外经 open_workspace / 目录候选认领
 * （control/workspace.ts 的候选筛选与 runtime.openWorkspace 的后台防御共用）。
 * 安全组织认领（迁移流程的 claim_source）另有更严条件——目录仍有效、
 * 无其他项目占用、无已映射会话——见 runtime/workspace-migration.ts 的
 * computeSafeClaim；两处形状不同是刻意分层，不一致时以本函数为准收紧入口。
 */
export function legacyProjectClaimableFromDir(
  sessions: Array<{ id: string; kind: string; cwd: string; cwdReal: string; cwdDev: number; cwdIno: number }>,
  roleSessionIds: readonly string[],
): boolean {
  const roleIds = new Set(roleSessionIds);
  const dev = sessions.filter((s) => s.kind === "dev" && !roleIds.has(s.id));
  if (dev.length !== sessions.length) return false;
  return distinctDirIdentities(dev).length <= 1;
}

/**
 * resolveDirIdentity 的同步变体（agent-direction issue 07）：迁移预览/应用在
 * 校验与事务内同步解析目标目录。判定与异步入口一致：realpath + 目录检查 + dev/ino。
 */
export function resolveDirIdentitySync(cwd: string): DirIdentity {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(cwd);
    stat = fs.statSync(real);
  } catch (err) {
    throw new DirIdentityError(`工作目录不可用：${cwd}（${(err as Error).message}）`);
  }
  if (!stat.isDirectory()) {
    throw new DirIdentityError(`工作目录不是目录：${cwd}`);
  }
  return { cwd: path.resolve(cwd), cwdReal: real, dev: stat.dev, ino: stat.ino };
}

/** 目录身份比对：与登记值不一致抛 DirIdentityError（异步/同步核实共用）。 */
function assertIdentityUnchanged(identity: DirIdentity, current: DirIdentity): void {
  if (current.cwdReal !== identity.cwdReal || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new DirIdentityError(
      `工作目录身份已变化：${identity.cwdReal} (dev=${identity.dev},ino=${identity.ino}) → ` +
        `${current.cwdReal} (dev=${current.dev},ino=${current.ino})`,
    );
  }
}

/** 校验目录仍是登记时的身份；不一致抛 DirIdentityError。 */
export async function verifyDirIdentity(identity: DirIdentity): Promise<void> {
  const current = await resolveDirIdentity(identity.cwdReal).catch((err) => {
    throw new DirIdentityError(`工作目录已失效：${identity.cwdReal}（${(err as Error).message}）`);
  });
  assertIdentityUnchanged(identity, current);
}

/**
 * verifyDirIdentity 的同步变体（agent-direction issue 06）：上下文装配在构造期
 * 同步执行，不能用异步版本；判定规则相同（realpath + dev + ino）。
 */
export function verifyDirIdentitySync(identity: DirIdentity): void {
  let current: DirIdentity;
  try {
    const real = fs.realpathSync(identity.cwdReal);
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) throw new DirIdentityError(`工作目录不是目录：${identity.cwdReal}`);
    current = { cwd: identity.cwd, cwdReal: real, dev: stat.dev, ino: stat.ino };
  } catch (err) {
    throw new DirIdentityError(`工作目录已失效：${identity.cwdReal}（${(err as Error).message}）`);
  }
  assertIdentityUnchanged(identity, current);
}
