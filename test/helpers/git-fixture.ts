/**
 * git init 一次性完成且同步执行（离线临时仓库，无需隔离 mixin）：
 * 依赖本地 PATH 的原生 git（宿主在 macOS 与 Linux 均已安装）。
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";

/** shlex-lite：单引用导路径（测试夹具只用 ASCII 路径）。 */
export function shellQuotePathForTest(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** 在目标目录同步执行一条 git 命令（初始化夹具专用，失败立即抛错）。 */
export function runGitStep(cwd: string, command: string): void {
  execFileSync("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** 一次性完成 git init + 简单提交。 */
export function initGitRepo(root: string): void {
  runGitStep(root, "git init -q");
  runGitStep(root, "git config user.email test@example.com");
  runGitStep(root, "git config user.name test");
  runGitStep(root, "git add -A");
  runGitStep(root, "git commit -q -m init");
}
