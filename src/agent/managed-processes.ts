/**
 * 受管工具进程登记表（每会话一份）。
 *
 * 工具执行期间产生的子进程在此登记 pid（POSIX 进程组，detached spawn）。
 * 中断/取消路径对进程组先发 SIGTERM，超时升级 SIGKILL；只有确认进程退出
 * 后才允许释放目录占用。无法确认退出时保留占用并报错。
 */

import * as childProcess from "node:child_process";

export interface ManagedProcessRegistry {
  /** 工具在 spawn 后登记 pid（已 detach 成独立进程组，pgid == pid）。 */
  register(pid: number, label: string): void;
  /** 任务结束清扫：登记表内容（正常结束的工具应已自行等待子进程退出）。 */
  list(): Array<{ pid: number; label: string }>;
  clear(): void;
}

export function createManagedProcessRegistry(): ManagedProcessRegistry {
  const entries = new Map<number, string>();
  return {
    register(pid, label) {
      entries.set(pid, label);
    },
    list() {
      return Array.from(entries, ([pid, label]) => ({ pid, label }));
    },
    clear() {
      entries.clear();
    },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    return true;
  }
}

/**
 * 终止一个进程组：SIGTERM → 等待退出 → SIGKILL → 等待退出。
 * 返回是否确认已退出（false = 无法确认，调用方必须保留目录占用）。
 */
export async function killProcessGroup(
  pid: number,
  opts: { termGraceMs?: number; killGraceMs?: number } = {},
): Promise<boolean> {
  const termGraceMs = opts.termGraceMs ?? 3000;
  const killGraceMs = opts.killGraceMs ?? 3000;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal); // 负 pid = 整个进程组
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        try {
          process.kill(pid, signal); // 兜底：只杀主进程
        } catch {
          // 已退出
        }
      }
    }
  };

  signalGroup("SIGTERM");
  const deadlineTerm = Date.now() + termGraceMs;
  while (pidAlive(pid) && Date.now() < deadlineTerm) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!pidAlive(pid)) return true;

  signalGroup("SIGKILL");
  const deadlineKill = Date.now() + killGraceMs;
  while (pidAlive(pid) && Date.now() < deadlineKill) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}
