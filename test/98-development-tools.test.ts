import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const { checkEnvironment } = await import(new URL("../scripts/check-environment.mjs", import.meta.url).href);
const { installHook } = await import(new URL("../scripts/setup.mjs", import.meta.url).href);

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto setup-")));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: path.join(root, "global-config"), GIT_CONFIG_NOSYSTEM: "1" });
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]);
  fs.mkdirSync(path.join(root, ".githooks"));
  fs.copyFileSync(new URL("../.githooks/pre-commit", import.meta.url), path.join(root, ".githooks", "pre-commit"));
  fs.chmodSync(path.join(root, ".githooks", "pre-commit"), 0o755);
  // 钩子调用的脚本随钩子一起复制；真实检出里两者同属一个提交。
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(new URL("../scripts/check-staged-eol.mjs", import.meta.url), path.join(root, "scripts", "check-staged-eol.mjs"));
  for (const file of ["package.json", "package-lock.json", "verification/foundation/package.json", "verification/foundation/package-lock.json"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file === "package.json" ? '{"scripts":{"check:static":"fixture"}}\n' : "{}\n");
  }
  return { root, env, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("setup 环境检查列出所有缺项，安装前拒绝旧 Node、非 Unix 平台、root 和不可用工具", () => {
  const f = fixture();
  try {
    assert.throws(() => checkEnvironment(f.root, {
      nodeVersion: "22.19.0", platform: "win32", uid: 0,
      probe: () => { throw new Error("工具不可用"); },
    }), (error: Error) => {
      for (const expected of [/Node >=24\.15/, /macOS 或 Linux/, /非 root/, /Git 不可用/, /ripgrep（rg）/, /Bash 不可用/, /Python 3/, /完整 Git 检出/]) assert.match(error.message, expected);
      return true;
    });
    const probe = (command: string, args: string[]) => command === "git" && args[0] === "rev-parse" ? f.root : "available";
    for (const nodeVersion of ["22.19.0", "22.99.0", "24.14.9"]) assert.throws(() => checkEnvironment(f.root, { nodeVersion, platform: "linux", uid: 1000, probe }), /Node >=24\.15/);
    for (const nodeVersion of ["24.15.0", "24.16.0", "25.0.0"]) assert.doesNotThrow(() => checkEnvironment(f.root, { nodeVersion, platform: "linux", uid: 1000, probe }));
    fs.rmSync(path.join(f.root, "verification/foundation/package-lock.json"));
    assert.throws(() => checkEnvironment(f.root, { platform: "darwin", uid: 1000, probe }), /verification\/foundation\/package-lock\.json/);
  } finally {
    f.cleanup();
  }
});

test("pre-commit 安装幂等，保留其它钩子；从子目录执行仍在仓库根运行 check:static", () => {
  const f = fixture();
  try {
    const prePush = path.join(f.root, ".git", "hooks", "pre-push");
    fs.writeFileSync(prePush, "existing pre-push\n");
    installHook(f.root, f.env);
    installHook(f.root, f.env);
    const hook = path.join(f.root, ".git", "hooks", "pre-commit");
    assert.equal(fs.lstatSync(hook).isFile(), true, "公共转发脚本不依赖工作区中的文件链接");
    assert.equal(fs.readFileSync(prePush, "utf8"), "existing pre-push\n", "不禁用其它钩子");
    assert.equal(f.git(["config", "--local", "--get-regexp", "^core\\."]).includes("hookspath"), false, "不修改 hooksPath");
    const bin = path.join(f.root, "fake-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o755 });
    const result = execFileSync(hook, [], { cwd: path.join(f.root, "verification"), env: { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}` }, encoding: "utf8" });
    // 钩子先跑行尾检查，再调用 check:static；两者都从仓库根执行。
    const lines = result.trim().split("\n");
    assert.deepEqual(lines.slice(-3), [f.root, "run", "check:static"]);
    assert.match(result, /check-staged-eol/, "钩子在 check:static 之前跑暂存行尾检查");
  } finally {
    f.cleanup();
  }
});

test("已有自定义 pre-commit 或 hooksPath 时明确失败，原文件和配置保持完整", () => {
  const f = fixture();
  try {
    const hook = path.join(f.root, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "custom hook\n");
    assert.throws(() => installHook(f.root, f.env), /未覆盖.*备份/);
    assert.equal(fs.readFileSync(hook, "utf8"), "custom hook\n");
    fs.rmSync(hook);
    f.git(["config", "core.hooksPath", "custom-hooks"]);
    assert.throws(() => installHook(f.root, f.env), /core\.hooksPath=custom-hooks.*show-origin/);
    assert.equal(f.git(["config", "--get", "core.hooksPath"]), "custom-hooks");
    assert.equal(fs.existsSync(hook), false);
    f.git(["config", "--local", "--unset", "core.hooksPath"]);
    const globalConfig = f.env.GIT_CONFIG_GLOBAL!;
    fs.writeFileSync(globalConfig, "[core]\n\thooksPath = global-hooks\n");
    assert.throws(() => installHook(f.root, f.env), /core\.hooksPath=global-hooks/);
    assert.equal(fs.readFileSync(globalConfig, "utf8"), "[core]\n\thooksPath = global-hooks\n", "用户全局配置不被覆盖");
    f.git(["config", "core.hooksPath", ".githooks"]);
    assert.doesNotThrow(() => installHook(f.root, f.env), "已显式接入仓库钩子可幂等运行");
  } finally {
    f.cleanup();
  }
});

test("公共钩子可由 linked worktree 安装；主检出切换旧提交和删除副本不影响当前检出的检查", () => {
  const f = fixture();
  const linked = `${f.root} linked`;
  try {
    const source = path.join(f.root, ".githooks", "pre-commit");
    const sourceBody = fs.readFileSync(source, "utf8");
    fs.rmSync(source);
    f.git(["add", "."]);
    f.git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "old fixture"]);
    const older = f.git(["rev-parse", "HEAD"]);
    fs.writeFileSync(source, sourceBody, { mode: 0o755 });
    f.git(["add", "."]);
    f.git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "current fixture"]);
    const newer = f.git(["rev-parse", "HEAD"]);
    f.git(["worktree", "add", "--detach", linked]);
    const hook = path.join(f.root, ".git", "hooks", "pre-commit");
    installHook(linked, f.env);
    const installed = fs.readFileSync(hook, "utf8");
    installHook(f.root, f.env);
    installHook(linked, f.env);
    assert.equal(fs.readFileSync(hook, "utf8"), installed, "main 与 linked 共用同一转发脚本");
    const bin = path.join(f.root, "fake-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o755 });
    const env = { ...f.env, PATH: `${bin}${path.delimiter}${f.env.PATH}` };
    f.git(["switch", "--detach", older]);
    assert.equal(fs.existsSync(source), false, "真实分支切换已删除主检出的源码钩子");
    const current = execFileSync(hook, [], { cwd: linked, env, encoding: "utf8" });
    assert.deepEqual(current.trim().split("\n").slice(-3), [linked, "run", "check:static"], "linked 运行自己的钩子，不依赖主检出源码");
    const old = spawnSync(hook, [], { cwd: f.root, env, encoding: "utf8" });
    assert.equal(old.status, 0, old.stderr);
    assert.match(old.stderr, /尚无提交钩子，跳过提交检查/);
    fs.chmodSync(path.join(linked, ".githooks", "pre-commit"), 0o644);
    const notExecutable = spawnSync(hook, [], { cwd: linked, env, encoding: "utf8" });
    assert.equal(notExecutable.status, 1, "已有钩子丢失执行权限不能当成旧分支跳过");
    assert.match(notExecutable.stderr, /不可执行/);
    fs.chmodSync(path.join(linked, ".githooks", "pre-commit"), 0o755);
    fs.writeFileSync(path.join(linked, "package.json"), "{}\n");
    for (const missingPackage of [false, true]) {
      if (missingPackage) fs.rmSync(path.join(linked, "package.json"));
      const result = spawnSync(hook, [], { cwd: linked, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "", "旧分支不调用 npm，避免 Missing script");
      assert.match(result.stderr, /尚无 check:static，跳过提交检查/);
    }
    fs.writeFileSync(path.join(linked, "package.json"), "{broken");
    const malformed = spawnSync(hook, [], { cwd: linked, env, encoding: "utf8" });
    assert.notEqual(malformed.status, 0, "配置损坏不能当成旧分支而跳过检查");
    assert.doesNotMatch(malformed.stderr, /跳过提交检查/);
    f.git(["worktree", "remove", "--force", linked]);
    f.git(["switch", "--detach", newer]);
    const result = execFileSync(hook, [], { cwd: f.root, env, encoding: "utf8" });
    assert.deepEqual(result.trim().split("\n").slice(-3), [f.root, "run", "check:static"], "删除 linked 后主检出仍正常检查");
  } finally {
    fs.rmSync(linked, { recursive: true, force: true });
    f.cleanup();
  }
});
