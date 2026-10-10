/**
 * 真实子进程后台（崩溃恢复测试共用）：tsx 启动 packages/tui/src/cli.ts start，
 * 按进程组 SIGKILL；连接控制面并以拥有者令牌认证。
 */

import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { ControlClient } from "@ruukoto/control/client.ts";
import { authenticateClient } from "./testkit.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

/** 直接 spawn 后台进程（重复启动拒绝等进程级断言用；常规路径用 spawnBackend）。 */
export function spawnBackendRaw(args: string[]): childProcess.ChildProcess {
  return childProcess.spawn(tsxBin, args, { cwd: repoRoot, stdio: "ignore" });
}

export interface Backend {
  child: childProcess.ChildProcess;
  client: ControlClient;
}

export function killProcessTree(child: childProcess.ChildProcess): void {
  // tsx 包装器会再 spawn 内层 node 进程；终止必须按进程组，否则内层进程
  // 带走的管道会挂住测试进程
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    // 进程组已退出
  }
}

export async function spawnBackend(dataDir: string, agentDir: string): Promise<Backend> {
  const child = childProcess.spawn(
    tsxBin,
    ["apps/ruukoto/src/main.ts", "start", "--data-dir", dataDir, "--agent-dir", agentDir, "--tools", "mock"],
    { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });
  const controlDir = path.join(path.dirname(path.resolve(dataDir)), "control");
  const socketPath = path.join(controlDir, "control.sock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`后台进程提前退出（code=${child.exitCode ?? child.signalCode}）：${stderr.slice(0, 2000)}`);
    }
    try {
      const client = await ControlClient.connect(socketPath, 1500);
      await authenticateClient(client, controlDir);
      await client.handshake();
      return { child, client };
    } catch (err) {
      if (Date.now() > deadline) {
        killProcessTree(child);
        throw new Error(`连接后台超时：${(err as Error).message}\n${stderr.slice(0, 2000)}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export async function killBackend(backend: Backend): Promise<void> {
  backend.client.close();
  if (backend.child.exitCode === null && backend.child.signalCode === null) {
    killProcessTree(backend.child);
    await new Promise<void>((resolve) => {
      backend.child.once("exit", () => resolve());
      setTimeout(resolve, 5000);
    });
  }
}
