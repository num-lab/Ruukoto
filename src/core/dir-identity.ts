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

/** 校验目录仍是登记时的身份；不一致抛 DirIdentityError。 */
export async function verifyDirIdentity(identity: DirIdentity): Promise<void> {
  const current = await resolveDirIdentity(identity.cwdReal).catch((err) => {
    throw new DirIdentityError(`工作目录已失效：${identity.cwdReal}（${(err as Error).message}）`);
  });
  if (current.cwdReal !== identity.cwdReal || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new DirIdentityError(
      `工作目录身份已变化：${identity.cwdReal} (dev=${identity.dev},ino=${identity.ino}) → ` +
        `${current.cwdReal} (dev=${current.dev},ino=${current.ino})`,
    );
  }
}
