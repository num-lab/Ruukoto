import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareNativeLaunch, type PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";
import { ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "personal-command-")));
  const workspace = path.join(root, "work"), workerPath = path.join(root, "command.mjs");
  fs.mkdirSync(workspace);
  fs.copyFileSync(fileURLToPath(new URL("../worker/personal-command-worker.mjs", import.meta.url)), workerPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { dev, ino } = fs.statSync(workspace);
  const input = (command = "touch invoked") => ({ command, workspace: { path: workspace, dev, ino } });
  function start() {
    const child = spawn(process.execPath, [workerPath], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", data => stdout.push(data)); child.stderr.on("data", data => stderr.push(data));
    const result = new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("命令 worker 超时")); }, 10_000);
      child.once("error", reject);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // 超限拒绝可能先关闭输入管道，退出码及零执行仍由断言核实。
        if (error.code !== "EPIPE") reject(error);
      });
      child.once("close", code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
    });
    return { child, result };
  }
  async function run(payload: unknown) {
    const started = start(); started.child.stdin.end(Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    return started.result;
  }
  return { root, workspace, workerPath, input, start, run };
}

test("个人命令产物在无依赖目录运行，双流保留二进制及大输出", async t => {
  const f = fixture(t);
  const result = await f.run(f.input("printf '\\000\\377out'; printf '\\376err' >&2; head -c 5000000 /dev/zero"));
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.subarray(0, 5), Buffer.from([0, 255, 111, 117, 116]));
  assert.equal(result.stdout.length, 5_000_005);
  assert.ok(result.stdout.subarray(5).every(byte => byte === 0));
  assert.deepEqual(result.stderr, Buffer.from([254, 101, 114, 114]));
});

test("单次命令等待完整 EOF，Shell 无 stdin，非零与信号状态不报成功", async t => {
  const f = fixture(t), started = f.start();
  started.child.stdin.write(JSON.stringify(f.input()));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fs.existsSync(path.join(f.workspace, "invoked")), false);
  started.child.stdin.end(); assert.equal((await started.result).code, 0);
  assert.equal(fs.existsSync(path.join(f.workspace, "invoked")), true);
  assert.equal((await f.run(f.input("if read -r line; then exit 9; fi; exit 7"))).code, 7);
  assert.equal((await f.run(f.input("kill -TERM $$"))).code, 143);
});

test("坏编码、超限、重复 JSON 及错误参数全部在启动命令前拒绝", async t => {
  const f = fixture(t), valid = f.input();
  for (const payload of [null, [], {}, { ...valid, command: " " }, { ...valid, command: "touch invoked\0" },
    { ...valid, workspace: null }, { ...valid, workspace: { ...valid.workspace, path: "relative" } },
    { ...valid, workspace: { ...valid.workspace, dev: String(valid.workspace.dev) } },
    { ...valid, workspace: { ...valid.workspace, ino: -1 } }, Buffer.from([255]),
    Buffer.alloc(4 * 1024 * 1024 + 1, 32), Buffer.from(JSON.stringify(valid) + "\n" + JSON.stringify(valid))]) {
    const result = await f.run(payload);
    assert.equal(result.code, 125);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr.toString(), /\[ruukoto:command\] command_input_invalid:/);
    assert.equal(fs.existsSync(path.join(f.workspace, "invoked")), false);
  }
});

test("目录别名、错误身份与读取期间替换目录均不执行", async t => {
  const f = fixture(t), valid = f.input();
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.workspace, alias);
  for (const workspace of [{ ...valid.workspace, dev: 0, ino: 0 }, { ...valid.workspace, path: alias },
    { ...valid.workspace, path: path.join(f.root, "missing") }]) {
    assert.equal((await f.run({ ...valid, workspace })).code, 125);
    assert.equal(fs.existsSync(path.join(f.workspace, "invoked")), false);
  }
  const started = f.start();
  await new Promise<void>(resolve => started.child.stdin.write(JSON.stringify(valid) + " ".repeat(1024 * 1024), () => resolve()));
  // 等待 worker 已开始收件，覆盖 Node 缓存 cwd 后才替换目录的窗口。
  await new Promise(resolve => setTimeout(resolve, 400));
  const original = path.join(f.root, "original");
  fs.renameSync(f.workspace, original); fs.mkdirSync(f.workspace);
  started.child.stdin.end();
  const result = await started.result;
  assert.equal(result.code, 125);
  assert.match(result.stderr.toString(), /command_workspace_changed:/);
  for (const directory of [original, f.workspace]) assert.equal(fs.existsSync(path.join(directory, "invoked")), false);
});

test("显式空依赖不发现旧 Pi，显式依赖受保护根约束且缺省仍要求旧安装", async t => {
  const f = fixture(t), { dev, ino } = fs.statSync(f.workspace);
  const spec: LaunchSpec = { taskId: "personal-command", mode: "confirm", workspace: f.workspace, workspaceIdentity: { dev, ino }, grantedPaths: [] };
  const inputs: PreparedNativeLaunch[] = [];
  t.after(() => { for (const input of inputs) fs.rmSync(input.tempDir, { recursive: true, force: true }); });
  const input = await prepareNativeLaunch({ workerPath: f.workerPath, dependencyRoots: [] }, spec); inputs.push(input);
  assert.ok(input.runtimeReadRoots.includes(f.workerPath));
  assert.ok(!input.runtimeReadRoots.some(root => path.basename(root) === "node_modules"));
  const dependency = path.join(f.root, "dependency"); fs.mkdirSync(dependency);
  const explicit = await prepareNativeLaunch({ workerPath: f.workerPath, dependencyRoots: [dependency] }, spec); inputs.push(explicit);
  assert.ok(explicit.runtimeReadRoots.includes(dependency));
  const rejected = (error: unknown) => error instanceof ExecutionError && error.code === "execution_unavailable";
  await assert.rejects(prepareNativeLaunch({ workerPath: f.workerPath, dependencyRoots: [dependency], protectedRoots: [dependency] }, spec), rejected);
  await assert.rejects(prepareNativeLaunch({ workerPath: f.workerPath, dependencyRoots: [f.root], protectedRoots: [dependency] }, spec), rejected);
  await assert.rejects(prepareNativeLaunch({ workerPath: f.workerPath, dependencyRoots: [path.join(f.root, "missing")] }, spec), rejected);
  await assert.rejects(prepareNativeLaunch({ workerPath: f.workerPath }, spec), rejected);
  const codeRoot = fs.realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  await assert.rejects(prepareNativeLaunch({ workerPath: f.workerPath, dependencyRoots: [path.join(codeRoot, "node_modules")], protectedRoots: [codeRoot] }, spec), rejected);
});
