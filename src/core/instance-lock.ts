/**
 * 目录独占锁（实例锁与配置锁共用同一套机制）。
 *
 * 用 `mkdir`（原子操作）作为锁语义：锁目录存在即视为持有中。
 * 遇到已有锁时不能只凭 PID 文件缺失或 socket 不存在就删除锁——必须读取
 * owner.json 并核实记录的进程仍然存活且确为本后台实例（进程身份用
 * ps 的完整命令行核对，避免 PID 回收误判）：
 * - 进程存活且是本后台 → 拒绝启动；
 * - 进程已死（ESRCH）或 PID 已被无关进程回收 → 遗留锁，可接管；
 * - owner.json 缺失/损坏 → 无活跃实例证据，可接管；
 * - 无法核实进程身份（ps 失败等）→ 保留锁并要求人工处理，不做静默删除。
 *
 * 两种锁：
 * - 实例锁 `<dataDir>/runtime.lock/`：同一数据目录只允许一个后台；
 * - 配置锁 `<agentDir>/config.lock/`（issue 21）：同一配置目录只允许一个
 *   在线后台或离线配置写入方，覆盖不同 dataDir 指向同一 agentDir 的情况。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export class InstanceLockError extends Error {
  /** true = 锁被持有但无法核实持锁进程身份（保留锁、要求人工处理）；false = 已确认的活后台持锁竞争。 */
  readonly unverifiable: boolean;
  constructor(message: string, unverifiable = false) {
    super(message);
    this.unverifiable = unverifiable;
  }
}

/**
 * 服务进程因锁冲突退出的专用退出码——仅已确认的活后台竞争收这个码（无法核实持锁
 * 身份按普通失败处理，保留锁供人工处理）。TUI 按需拉起的失败分类用它按本进程归属
 * 判定锁竞争——共享 spawn.log 会混入其他终端的输出，不能解析日志文本判断当前子
 * 进程为何退出。
 */
export const INSTANCE_LOCK_EXIT_CODE = 42;

interface LockOwner {
  pid: number;
  command: string;
  startedAt: string;
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    return true; // EPERM 或未知错误按存活处理，宁可保守
  }
}

function processCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function looksLikeBackend(command: string): boolean {
  // dev 启动器（dev.ts）派生 cli.ts 子进程；命令行核对从宽，宁误拒不误放
  return command.includes("ruukoto") || command.includes("cli.ts") || command.includes("dev.ts");
}

export interface AcquiredLock {
  release(): void;
}

function acquireLock(lockDir: string, label: string): AcquiredLock {
  const takeover = () => {
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  };

  let created = false;
  try {
    fs.mkdirSync(lockDir);
    created = true;
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }

  if (!created) {
    const owner = readOwner(lockDir);
    if (owner && Number.isFinite(owner.pid)) {
      if (!isAlive(owner.pid)) {
        // 遗留锁：记录的进程已退出，可安全接管
        takeover();
      } else {
        const command = processCommand(owner.pid);
        if (command === null) {
          throw new InstanceLockError(
            `${label}被 pid ${owner.pid} 持有，但无法核实进程身份；请人工确认后删除 ${lockDir}`,
            true,
          );
        }
        if (looksLikeBackend(command)) {
          throw new InstanceLockError(`${label}冲突：另一个进程正在运行（pid ${owner.pid}）：${command}`);
        }
        // PID 被无关进程复用：遗留锁，可接管
        takeover();
      }
    } else {
      // owner.json 缺失或损坏：锁目录存在但无活跃实例证据，接管
      takeover();
    }
  }

  const owner: LockOwner = {
    pid: process.pid,
    command: `ruukoto-backend ${process.argv.join(" ")}`,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner, null, 2));
  return {
    release() {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // 释放失败不阻断退出；下个实例按遗留锁流程核实
      }
    },
  };
}

/** 数据目录实例锁：同一 dataDir 只允许一个后台进程。 */
export function acquireInstanceLock(dataDir: string): AcquiredLock {
  return acquireLock(path.join(dataDir, "runtime.lock"), "实例锁");
}

/**
 * 模型配置锁（issue 21）：同一 agentDir 只允许一个在线后台或离线配置写入方。
 * 与实例锁分离——两个 dataDir 不同的后台指向同一 agentDir 时由此互斥。
 */
export function acquireConfigLock(agentDir: string): AcquiredLock {
  return acquireLock(path.join(agentDir, "config.lock"), "配置锁");
}
