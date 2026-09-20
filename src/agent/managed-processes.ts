/**
 * 受管执行单元登记表（每会话一份）。
 *
 * 工具执行环境在此登记可回收身份：POSIX 进程组（本地工作进程）、容器
 * （任务容器）或 systemd 单元（完全访问的执行账户，issue 03）。停止路径对
 * 执行单元先 TERM 后 KILL（或等价的整单元停止），只有确认整个单元（含其
 * 子进程/cgroup）已退出才允许释放目录占用。无法确认退出时保留占用并报错
 * ——仅杀主进程或等待主 PID 消失不足以证明后代已退出。
 */

import * as childProcess from "node:child_process";

export type ManagedUnitKind = "process_group" | "container" | "systemd_unit";

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
