/**
 * 数据目录的独占实例锁。
 *
 * 用 `mkdir`（原子操作）作为锁语义：`runtime.lock/` 目录存在即视为持有中。
 * 遇到已有锁时不能只凭 PID 文件缺失或 socket 不存在就删除锁——必须读取
 * owner.json 并核实记录的进程仍然存活且确为本后台实例（进程身份用
 * ps 的完整命令行核对，避免 PID 回收误判）：
 * - 进程存活且是本后台 → 拒绝启动；
 * - 进程已死（ESRCH）或 PID 已被无关进程回收 → 遗留锁，可接管；
 * - owner.json 缺失/损坏 → 无活跃实例证据，可接管；
 * - 无法核实进程身份（ps 失败等）→ 保留锁并要求人工处理，不做静默删除。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
  }
}

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
  return command.includes("ruukoto") || command.includes("cli.ts");
}

export interface AcquiredLock {
  release(): void;
}

export function acquireInstanceLock(dataDir: string): AcquiredLock {
  const lockDir = path.join(dataDir, "runtime.lock");
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
            `实例锁被 pid ${owner.pid} 持有，但无法核实进程身份；请人工确认后删除 ${lockDir}`,
          );
        }
        if (looksLikeBackend(command)) {
          throw new InstanceLockError(`另一个后台实例正在运行（pid ${owner.pid}）：${command}`);
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
