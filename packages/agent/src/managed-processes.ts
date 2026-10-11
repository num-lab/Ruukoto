/**
 * 受管执行单元登记表（每会话一份）。
 *
 * 工具执行环境在此登记可回收身份：POSIX 进程组（本地工作进程）、容器
 * （任务容器）或 systemd 单元（完全访问的执行账户，issue 03）；starting
 * 是启动中的占位——ready 之前的执行单元也在停止路径覆盖内，不存在
 * 「已落库的工具意图却找不到可回收身份」的窗口。停止路径对执行单元先
 * TERM 后 KILL（或等价的整单元停止），只有确认整个单元（含其子进程/
 * cgroup）已退出才允许释放目录占用。无法确认退出时保留占用并报错
 * ——仅杀主进程或等待主 PID 消失不足以证明后代已退出。
 */

import * as childProcess from "node:child_process";

export type ManagedUnitKind = "process_group" | "container" | "systemd_unit" | "starting";

export interface ManagedEntry {
  kind: ManagedUnitKind;
  /** 进程组 id（=主 pid）或容器名/容器 id。 */
  id: string;
  label: string;
  /** 停止并核实整个执行单元已退出；false = 无法确认。 */
  stop: () => Promise<boolean>;
}

export interface ManagedProcessRegistry {
  /** 登记一个可回收的执行单元（工具进程组或任务容器）。 */
  register(entry: ManagedEntry): void;
  /** 任务结束清扫：登记表内容（正常结束的执行单元应已自行退出）。 */
  list(): ManagedEntry[];
  clear(): void;
}

export function createManagedProcessRegistry(): ManagedProcessRegistry {
  const entries = new Map<string, ManagedEntry>();
  return {
    register(entry) {
      entries.set(`${entry.kind}:${entry.id}`, entry);
    },
    list() {
      return Array.from(entries.values());
    },
    clear() {
      entries.clear();
    },
  };
}

/** 原进程组只剩僵尸时已无可执行成员；查询或权限失败不能证明退出。 */
async function processGroupAlive(pgid: number): Promise<boolean | null> {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
  return new Promise(resolve => {
    childProcess.execFile("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", timeout: 2000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      for (const line of stdout.trim().split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
        if (!match) { resolve(null); return; }
        if (Number(match[1]) === pgid && !match[2].startsWith("Z")) { resolve(true); return; }
      }
      resolve(false);
    });
  });
}

/**
 * 停止并核实原进程组；false 表示无法确认，调用方须保留占用。
 * 不覆盖脱离原进程组的后代。
 * Note: 见 .agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md
 */
export async function killProcessGroup(
  pgid: number,
  opts: { termGraceMs?: number; killGraceMs?: number } = {},
): Promise<boolean> {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  const waitForExit = async (graceMs: number): Promise<boolean> => {
    const deadline = Date.now() + graceMs;
    for (;;) {
      const alive = await processGroupAlive(pgid);
      if (alive === false) return true;
      if (alive === null || Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const termSignaled = signalGroup("SIGTERM");
  if (termSignaled && await waitForExit(opts.termGraceMs ?? 3000)) return true;
  const killSignaled = signalGroup("SIGKILL");
  return killSignaled && await waitForExit(opts.killGraceMs ?? 3000);
}
