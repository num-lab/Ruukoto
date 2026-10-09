/**
 * CLI 入口分发测试（issue 21）。
 *
 * - 单元：resolveEntry 纯函数覆盖全部入口形态（无参/--session/--demo/路径/
 *   `-- 路径`/config/server/start 别名/旧拼法 tui/各管理命令/错误情形）；
 * - 进程级：tsx 与 bin 入口冒烟（非 TTY 拒绝、迁移指引、server 参数快速失败），
 *   均不需要后台。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { resolveEntry } from "../src/cli-entry.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

// ---- 单元：resolveEntry ----

test("无参 → 默认任务界面", () => {
  const e = resolveEntry([]);
  assert.equal(e.kind, "tui");
  if (e.kind === "tui") {
    assert.equal(e.sessionId, undefined);
    assert.equal(e.demo, undefined);
  }
});

test("--session / --demo → 任务界面入口", () => {
  const s = resolveEntry(["--session", "s1"]);
  assert.equal(s.kind, "tui");
  if (s.kind === "tui") {
    assert.equal(s.sessionId, "s1");
    assert.equal(s.demo, undefined);
  }
  const d = resolveEntry(["--demo"]);
  assert.equal(d.kind, "tui");
  if (d.kind === "tui") {
    assert.equal(d.sessionId, undefined);
    assert.equal(d.demo, true);
  }
});

test("--demo 为布尔标志，不吞下一 token", () => {
  const e = resolveEntry(["--demo", "--session", "s1"]);
  assert.equal(e.kind, "tui");
  if (e.kind === "tui") {
    assert.equal(e.demo, true);
    assert.equal(e.sessionId, "s1");
  }
});

test("路径入口：普通路径、./config、`-- config`", () => {
  assert.deepStrictEqual(resolveEntry(["some/dir"]), { kind: "workspace", path: "some/dir" });
  assert.deepStrictEqual(resolveEntry(["./config"]), { kind: "workspace", path: "./config" });
  assert.deepStrictEqual(resolveEntry(["--", "config"]), { kind: "workspace", path: "config" });
  assert.deepStrictEqual(resolveEntry(["--", "with space/目录"]), { kind: "workspace", path: "with space/目录" });
});

test("命令名优先于路径：config / status 不按路径处理", () => {
  assert.deepStrictEqual(resolveEntry(["config"]), { kind: "config", offline: false });
  assert.deepStrictEqual(resolveEntry(["config", "--offline"]), { kind: "config", offline: true });
  assert.deepStrictEqual(resolveEntry(["status"]), { kind: "legacy", command: "status", argv: [] });
});

test("server 与兼容别名 start 同一路径", () => {
  assert.deepStrictEqual(resolveEntry(["server", "--data-dir", "x"]), { kind: "server", argv: ["--data-dir", "x"] });
  assert.deepStrictEqual(resolveEntry(["start", "--data-dir", "x"]), { kind: "server", argv: ["--data-dir", "x"] });
  assert.deepStrictEqual(resolveEntry(["server"]), { kind: "server", argv: [] });
});

test("旧拼法 tui 与全部管理命令保持 legacy 分发", () => {
  const legacy = [
    "create-project", "project", "create-session", "models", "set-model",
    "submit", "continue", "switch-mode", "set-session-mode", "status", "events",
    "interrupt", "cancel", "resume-queue", "confirm", "read-artifact",
    "credentials", "github", "mcp", "stop", "qq", "grant", "history-search",
    "memory", "selection-records", "legacy-import", "tui",
  ];
  for (const cmd of legacy) {
    assert.deepStrictEqual(resolveEntry([cmd, "--x", "1"]), { kind: "legacy", command: cmd, argv: ["--x", "1"] }, cmd);
  }
});

test("错误情形 → help + error", () => {
  const cases: Array<{ argv: string[]; match: RegExp }> = [
    { argv: ["--bogus"], match: /参数错误/ }, // 未知标志
    { argv: ["--session"], match: /参数错误/ }, // 缺值
    { argv: ["path1", "path2"], match: /只接受一个路径/ }, // 多余位置参数
    { argv: ["/p", "--demo"], match: /不能与路径同用/ }, // 路径 + 标志
    { argv: ["--demo", "/p"], match: /不能与路径同用/ },
    { argv: ["--session", "s1", "/p"], match: /不能与路径同用/ },
    { argv: ["config", "--bogus"], match: /参数错误/ },
    { argv: ["config", "extra"], match: /不接受位置参数/ },
    { argv: ["--"], match: /需跟一个工作区路径/ },
    { argv: ["--", "a", "b"], match: /只接受一个路径/ },
  ];
  for (const { argv, match } of cases) {
    const e = resolveEntry(argv);
    assert.equal(e.kind, "help", JSON.stringify(argv));
    if (e.kind === "help") assert.match(e.error ?? "", match, JSON.stringify(argv));
  }
});

// ---- 进程级冒烟（不需要后台） ----

function runCli(args: string[], opts: { bin?: boolean } = {}): { status: number | null; stdout: string; stderr: string } {
  const cmd = opts.bin ? process.execPath : tsxBin;
  const argv = opts.bin ? [path.join(repoRoot, "bin", "ruukoto.mjs"), ...args] : ["src/cli.ts", ...args];
  const r = childProcess.spawnSync(cmd, argv, { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("进程：未知名字按工作区路径处理，非 TTY 下退出 1 并提示", () => {
  const r = runCli(["definitely-not-a-command-or-dir"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：tui 旧拼法打印迁移指引，且非 TTY 拒绝", () => {
  const r = runCli(["tui", "--demo"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /旧拼法/);
  assert.match(r.stderr, /TTY/);
});

test("进程：bin 入口引导 TS，未知名字退出 1", () => {
  const r = runCli(["bogus"], { bin: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});

test("进程：server --execution 非法值在启动前快速失败", () => {
  const r = runCli(["server", "--execution", "bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--execution 取值无效/);
});

test("进程：config 非 TTY 拒绝", () => {
  const r = runCli(["config"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TTY/);
});
