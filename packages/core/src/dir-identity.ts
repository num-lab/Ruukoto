/**
 * 工作目录身份：realpath 规范化 + 设备号/inode。
 *
 * 任务开始前与占用检查都用它核对目录身份，覆盖：
 * - 符号链接：realpath 解析后指向同一真实路径；
 * - 同一目录的挂载别名：dev+ino 相同；
 * - 排队期间目录被替换或失效：真实路径或 inode 与登记值不一致时拒绝启动。
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
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-18-directory-device-number.md
function assertIdentityUnchanged(identity: DirIdentity, current: DirIdentity): void {
  if (current.cwdReal !== identity.cwdReal || current.ino !== identity.ino) {
    throw new DirIdentityError(
      `工作目录身份已变化：${identity.cwdReal} (ino=${identity.ino}) → ` +
        `${current.cwdReal} (ino=${current.ino})`,
    );
  }
}

/** 核实登记的真实路径与 inode，返回本次身份；失效或不一致抛 DirIdentityError。 */
export async function verifyDirIdentity(identity: DirIdentity): Promise<DirIdentity> {
  const current = await resolveDirIdentity(identity.cwdReal).catch((err) => {
    throw new DirIdentityError(`工作目录已失效：${identity.cwdReal}（${(err as Error).message}）`);
  });
  assertIdentityUnchanged(identity, current);
  return current;
}

/**
 * verifyDirIdentity 的同步变体（agent-direction issue 06）：上下文装配在构造期
 * 同步执行，不能用异步版本；同样核实真实路径与 inode，返回本次身份。
 */
export function verifyDirIdentitySync(identity: DirIdentity): DirIdentity {
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
  return current;
}
