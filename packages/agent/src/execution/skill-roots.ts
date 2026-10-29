/**
 * 技能根选择：把任务钉版技能目录并入受限执行的只读根（两个产品共用）。
 *
 * - 只处理新增技能根：原工作区、原授权与既有只读根的校验失败原样上抛，
 *   本函数不把它们折算成技能不可用；
 * - 逐候选 realpath 并按真实路径去重；钉版路径不再是其原真实路径时按
 *   目录身份变化处理（不跟随被替换的符号链接目标）；
 * - 已被最终授权集合完整覆盖的目录不追加根，保持原有权限；
 * - 零候选直接返回：不为无技能任务付整树 realpath 与别名核实；原挂载
 *   失效仍由启动前的原生挂载校验原样失败；
 * - 覆盖文件系统根或宿主 HOME、包含可写根、缺失、非目录、受保护或别名
 *   不安全的候选逐技能记入 unavailable（调用方决定进入工具结果或持久
 *   证据），不拖累其余命令；
 * - 文件别名核实用最终授权集合（原挂载 + 候选）：两棵已授权技能目录间
 *   的合法硬链接不会被误判；无法整体归因时按候选隔离，仍不能单点归因
 *   时退化为逐个接纳，拒绝方向始终保守。
 * Note: 见 .agents/notes/implemented/feature/2026-10-29-skill-script-execution.md
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertGrantNotProtected } from "./approved-ops.ts";
import { assertNativeFileLinks } from "./native.ts";

export interface SkillRootCandidate {
  name: string;
  /** 钉版时记录的技能目录 realpath。 */
  dir: string;
}

export interface SkillRootSelection {
  /** 追加的只读根（path 为 realpath，dev/ino 为目录身份）。 */
  roots: Array<{ path: string; dev: number; ino: number }>;
  /** 逐技能不可用诊断。 */
  unavailable: Array<{ name: string; reason: string }>;
}

const covers = (root: string, target: string): boolean => root === target || target.startsWith(root + path.sep);

export function selectSkillReadRoots(input: {
  candidates: readonly SkillRootCandidate[];
  /**
   * 最终授权集合（workspace 读写 + grantedPaths + 既有 readRoots）。
   * 覆盖判定与别名核实都以它为准；路径自身失效时抛错（原授权问题非技能问题）。
   */
  mounts: ReadonlyArray<{ path: string; access: "read" | "read_write" }>;
  protectedRoots: string[];
  /** 原生沙箱才需要文件别名核实（本地启动器不强制挂载边界）。 */
  checkAliases: boolean;
}): SkillRootSelection {
  if (!input.candidates.length) return { roots: [], unavailable: [] };
  const mounts = input.mounts.map(mount => ({ path: fs.realpathSync(mount.path), access: mount.access }));
  // 原授权集合自身的别名失败不是技能问题：原样上抛。
  if (input.checkAliases) assertNativeFileLinks([...mounts]);
  let home = os.homedir();
  try { home = fs.realpathSync(home); } catch { /* homedir 不可解析时按原值判定 */ }
  const unavailable: Array<{ name: string; reason: string }> = [];
  const surviving: Array<{ name: string; root: { path: string; dev: number; ino: number } }> = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    const fail = (reason: string) => unavailable.push({ name: candidate.name, reason });
    let real: string;
    try {
      real = fs.realpathSync(candidate.dir);
    } catch {
      fail("技能目录缺失");
      continue;
    }
    if (real !== candidate.dir) {
      // 钉版路径不再是原真实路径（被替换为符号链接等）：不跟随新目标，也不占用去重名额
      fail("技能目录真实路径已变化");
      continue;
    }
    // 去重名额只授予可挂载的目录：被拒的同路径候选各自保留诊断
    if (seen.has(real)) continue;
    if (real === path.parse(real).root || covers(real, home)) {
      fail("技能目录覆盖宿主 HOME 或文件系统根");
      continue;
    }
    if (mounts.some(mount => covers(mount.path, real))) continue;
    if (mounts.some(mount => mount.access === "read_write" && covers(real, mount.path))) {
      fail("技能目录包含可写根，无法整根只读");
      continue;
    }
    try {
      assertGrantNotProtected(real, input.protectedRoots);
    } catch {
      fail("技能目录属于受保护范围");
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      fail("技能目录缺失");
      continue;
    }
    if (!stat.isDirectory()) {
      fail("技能目录不是目录");
      continue;
    }
    seen.add(real);
    surviving.push({ name: candidate.name, root: { path: real, dev: stat.dev, ino: stat.ino } });
  }
  if (!surviving.length || !input.checkAliases) return { roots: surviving.map(entry => entry.root), unavailable };

  const mountsOf = (kept: typeof surviving) => [...mounts, ...kept.map(entry => ({ path: entry.root.path, access: "read" as const }))];
  try {
    assertNativeFileLinks(mountsOf(surviving));
    return { roots: surviving.map(entry => entry.root), unavailable };
  } catch {
    // 合并核实失败：先尝试单点归因，再退化为逐个接纳
  }
  let work = [...surviving];
  for (;;) {
    const culprit = work.find(candidate => {
      try {
        assertNativeFileLinks(mountsOf(work.filter(entry => entry !== candidate)));
        return true;
      } catch {
        return false;
      }
    });
    if (!culprit) break;
    unavailable.push({ name: culprit.name, reason: "技能目录文件别名不安全" });
    work = work.filter(entry => entry !== culprit);
  }
  // 消元收敛后整体复核：合法跨根链接对（两棵授权目录间条目齐全）在单点
  // 接纳时会互相等待而双双被拒，整体通过则全部采纳。
  try {
    assertNativeFileLinks(mountsOf(work));
    return { roots: work.map(entry => entry.root), unavailable };
  } catch {
    // 仍存在多候选合流的失败：逐个隔离，同伴未接纳的合法跨根链接最后再试。
  }
  const kept: typeof surviving = [];
  for (const candidate of work) {
    try {
      assertNativeFileLinks(mountsOf([...kept, candidate]));
      kept.push(candidate);
    } catch {
      unavailable.push({ name: candidate.name, reason: "技能目录文件别名不安全" });
    }
  }
  for (const candidate of work.filter(entry => !kept.includes(entry))) {
    try {
      assertNativeFileLinks(mountsOf([...kept, candidate]));
      kept.push(candidate);
      const index = unavailable.findIndex(entry => entry.name === candidate.name && entry.reason === "技能目录文件别名不安全");
      if (index >= 0) unavailable.splice(index, 1);
    } catch {
      // 保持不可用
    }
  }
  return { roots: kept.map(entry => entry.root), unavailable };
}
