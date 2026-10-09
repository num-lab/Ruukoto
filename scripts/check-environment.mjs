import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export function checkEnvironment(root, {
  nodeVersion = process.versions.node,
  platform = process.platform,
  uid = process.getuid?.(),
  probe = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
} = {}) {
  const issues = [];
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (!(major > 22 || (major === 22 && minor >= 19))) issues.push(`需要 Node >=22.19，当前为 ${nodeVersion}`);
  if (!["darwin", "linux"].includes(platform)) issues.push(`需要 macOS 或 Linux，当前为 ${platform}`);
  if (uid === 0) issues.push("请使用非 root 用户：权限拒绝测试不能以 root 身份运行");
  for (const [command, args, description] of [
    ["git", ["--version"], "Git"],
    ["bash", ["--version"], "Bash"],
    ["python3", ["-c", "import pty, fcntl, termios, os; master, slave = pty.openpty(); os.close(master); os.close(slave)"], "Python 3 与可用 PTY（含 pty/fcntl/termios）"],
  ]) {
    try {
      probe(command, args);
    } catch {
      issues.push(`${description} 不可用；请安装后重试`);
    }
  }
  try {
    const top = probe("git", ["rev-parse", "--show-toplevel"]).trim();
    if (fs.realpathSync(top) !== fs.realpathSync(root)) throw new Error("工作区根目录不符");
  } catch {
    issues.push("需要完整 Git 检出；请通过 git clone 获取仓库，并从仓库根运行 setup");
  }
  for (const file of ["package.json", "package-lock.json", "verification/foundation/package.json", "verification/foundation/package-lock.json"]) {
    if (!fs.existsSync(path.join(root, file))) issues.push(`检出缺少 ${file}；请恢复完整仓库`);
  }
  if (issues.length) throw new Error(`开发环境检查失败：\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    checkEnvironment(process.cwd());
    console.log("开发环境检查通过");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
