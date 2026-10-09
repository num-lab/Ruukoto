import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkEnvironment } from "./check-environment.mjs";

const PRE_COMMIT_DISPATCHER = String.raw`#!/bin/sh
set -eu
root="$(git rev-parse --show-toplevel)"
hook="$root/.githooks/pre-commit"
if [ -x "$hook" ]; then
  exec "$hook"
fi
if [ -e "$hook" ]; then
  printf '%s\n' '当前检出的提交钩子不可执行，请运行 chmod +x .githooks/pre-commit 后重试。' >&2
  exit 1
fi
printf '%s\n' '当前检出尚无提交钩子，跳过提交检查；采用开发基线后自动启用。' >&2
`;

function pendingHook(root, env) {
  const git = (args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let configured;
  try {
    configured = git(["config", "--get", "core.hooksPath"]);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (configured !== undefined) {
    if (path.resolve(root, configured) === path.join(root, ".githooks")) {
      fs.accessSync(path.join(root, ".githooks", "pre-commit"), fs.constants.R_OK | fs.constants.X_OK);
      return null;
    }
    throw new Error(`已有 core.hooksPath=${configured}，setup 未修改钩子。请用 git config --show-origin --get core.hooksPath 查看来源，保留原配置并自行接入 npm run check:static 后使用 npm run setup -- --skip-hooks，或备份后移除该配置再运行 setup。`);
  }
  const destination = path.resolve(root, git(["rev-parse", "--git-path", "hooks/pre-commit"]));
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isFile() && fs.readFileSync(destination, "utf8") === PRE_COMMIT_DISPATCHER) {
      fs.accessSync(destination, fs.constants.X_OK);
      return null;
    }
    throw new Error(`已有 ${destination}，setup 未覆盖它。请先备份并接入 npm run check:static 后使用 npm run setup -- --skip-hooks，或备份后移走该钩子再运行 setup。`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return destination;
}

export function installHook(root, env = process.env) {
  const destination = pendingHook(root, env);
  if (!destination) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, PRE_COMMIT_DISPATCHER, { flag: "wx", mode: 0o755 });
  fs.chmodSync(destination, 0o755);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--skip-hooks")) {
      throw new Error("用法：npm run setup [-- --skip-hooks]；--skip-hooks 用于 CI、隔离基线验证或已有钩子已自行接入 check:static 的环境");
    }
    const root = fileURLToPath(new URL("../", import.meta.url));
    checkEnvironment(root);
    const skipHooks = args.includes("--skip-hooks");
    if (!skipHooks) pendingHook(root, process.env);
    execFileSync("npm", ["ci"], { cwd: root, stdio: "inherit" });
    execFileSync("npm", ["ci"], { cwd: path.join(root, "verification", "foundation"), stdio: "inherit" });
    if (!skipHooks) installHook(root);
    console.log(skipHooks ? "开发环境就绪（CI/隔离验证或已有钩子已自行接入：未安装提交钩子）" : "开发环境就绪，pre-commit 已接入 npm run check:static");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
