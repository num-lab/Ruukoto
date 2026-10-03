/**
 * 通过 IM 管理 Linux 服务的产品级冒烟（agent-direction issue 09）之本地驱动。
 *
 * 结构（同 smoke-08 的自包含约定，差异在跨机）：
 *  1. 本机（mac）只做驱动：rsync 当前仓库（develop HEAD + 未提交改动）到
 *     tx:/tmp/ruukoto-smoke09-src，远端 npm ci，然后让
 *     .scratch/agent-direction/smoke09-remote.mts 在 tx 上自包含跑完全程——
 *     后台、mock 桩、模型、sudo/systemd 调用全部在 tx 本地回环，不转发开发机命令。
 *  2. 远端脚本输出即证据：安装演练、主链路（真实 restart）、账户边界、重复/越界、
 *     中断恢复、拒绝零执行、清理。
 *
 * 真实：Linux systemd / root helper / sudoers / 测试服务 / 隔离后台（Runtime/SQLite）。
 * 模拟：模型与 NapCat OneBot（QQ 私聊）；真实 QQ/Telegram 平台未实测。
 *
 * 结果约定：0 = 远端全部通过；非 0 = 驱动步骤失败或远端有 FAIL。
 * 运行：npx tsx .scratch/agent-direction/smoke-09-linux-service-management.mts
 */

import * as childProcess from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REMOTE = "tx";
const RDIR = "/tmp/ruukoto-smoke09-src";
const REMOTE_SCRIPT = ".scratch/agent-direction/smoke09-remote.mts";
const startedAt = Date.now();

function run(label: string, cmd: string, args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): { code: number; out: string } {
  console.log(`\n=== ${label} ===`);
  const r = childProcess.spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? 600_000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const code = r.status ?? (r.signal ? -1 : 1);
  if (code !== 0 && !opts.allowFail) {
    console.error(`驱动步骤失败（${label}，退出码 ${code}${r.signal ? `，信号 ${r.signal}` : ""}）`);
    process.exit(1);
  }
  return { code, out: r.stdout ?? "" };
}

// 0. 小步验证：ssh 通、账户存在、sudo -n、node 版本、systemd
run("探测 tx 环境", "ssh", [REMOTE, [
  "set -e",
  "echo user=$(whoami)",
  "sudo -n true && echo sudo-n-ok",
  "node --version",
  "id ruukoto-backend >/dev/null && echo backend-account-ok",
  "id ruukoto-exec >/dev/null && echo exec-account-ok",
  "systemctl --version | head -1",
  "systemctl is-active ruukoto-backend",
].join(" && ")], { timeoutMs: 60_000 });

// 1. 记录当前代码状态（HEAD + 未提交清单，证据的一部分）
run("记录代码状态", "bash", ["-lc", `git -C ${repoRoot} rev-parse --abbrev-ref HEAD; git -C ${repoRoot} rev-parse HEAD; git -C ${repoRoot} status --short`]);

// 2. rsync 源码（排除 node_modules/.git；含 .scratch 远端脚本）
run("rsync 仓库到 tx", "rsync", [
  "-az", "--delete",
  "--exclude", "node_modules",
  "--exclude", ".git",
  "--exclude", ".idea",
  "--exclude", "*.log",
  `${repoRoot}/`, `${REMOTE}:${RDIR}/`,
], { timeoutMs: 300_000 });

// 3. 远端依赖（幂等：npm ci 每次重建 node_modules；prefer-offline 加速复跑）
run("远端 npm ci", "ssh", [REMOTE, `cd ${RDIR} && npm ci --no-audit --no-fund --prefer-offline`], { timeoutMs: 600_000 });

// 4. 远端编排器（自包含；输出即证据）
const remote = run("远端编排器", "ssh", [REMOTE, `cd ${RDIR} && node_modules/.bin/tsx ${REMOTE_SCRIPT}`], { allowFail: true, timeoutMs: 600_000 });

console.log(`\n=== 驱动结束：远端退出码 ${remote.code}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s ===`);
if (remote.code !== 0) process.exit(1);
