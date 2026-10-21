/** 持久认领只恢复原执行的停止核实，不恢复执行权。 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { launchLinuxExecution, stopLinuxExecution, type LinuxExecutionRef } from "@ruukoto/agent/execution/native-linux-identity.ts";
import { ExecutionError, type LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import type { PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";

const machineId = "a".repeat(32), bootId = "12345678-1234-1234-1234-123456789abc";
const ref: LinuxExecutionRef = { executionId: `native_${"b".repeat(24)}`, machineId };
const scope = `ruukoto-${ref.executionId}.scope`, token = "c".repeat(32), invocationId = "d".repeat(32);

function fixture(context: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-identity-")));
  const directory = path.join(root, "claims"), workspace = path.join(root, "work"), tempDir = path.join(root, "temp");
  for (const dir of [directory, workspace, tempDir]) fs.mkdirSync(dir, { mode: 0o700 });
  const spec: LaunchSpec = { taskId: "identity-test", mode: "confirm", workspace, grantedPaths: [] };
  const input: PreparedNativeLaunch = { workspace, tempDir, env: {}, mounts: [{ path: workspace, access: "read_write" }],
    runtimeReadRoots: [], toolAliases: [], nodePath: process.execPath, workerPath: path.join(root, "worker.mjs") };
  const readFile = nodeFs.readFileSync;
  context.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (target === "/etc/machine-id") return machineId + "\n";
    if (target === "/proc/sys/kernel/random/boot_id") return bootId + "\n";
    return readFile(target, options);
  });
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, input, spec, claimDir: path.join(directory, ref.executionId) };
}

function saveClaim(claimDir: string, extra: object = {}): void {
  fs.mkdirSync(claimDir, { mode: 0o700 });
  fs.writeFileSync(path.join(claimDir, "claim.json"), JSON.stringify({ version: 1, ref, bootId, scope, token,
    fingerprint: "0".repeat(64), claimedBy: "launch", ...extra }), { mode: 0o600 });
}

test("停止先手持久认领，跨调用同键不再启动且零平台外调", async context => {
  const f = fixture(context);
  const execute = context.mock.method(childProcess, "execFile", () => { assert.fail("停止先手不查询平台"); });
  const spawn = context.mock.method(childProcess, "spawn", () => { assert.fail("已认领不能启动"); });
  syncBuiltinESMExports();
  assert.deepEqual(await stopLinuxExecution(f.directory, ref), { ref, exited: true });
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, true);
  await assert.rejects(launchLinuxExecution(f.directory, ref, f.input, f.spec), error => error instanceof ExecutionError && error.code === "execution_claim_failed");
  assert.equal(execute.mock.callCount(), 0); assert.equal(spawn.mock.callCount(), 0);
});

test("异机器、非保护目录及 worker 可见证据目录在认领前拒绝", async context => {
  const f = fixture(context);
  const spawn = context.mock.method(childProcess, "spawn", () => { assert.fail("无效输入不能启动"); });
  syncBuiltinESMExports();
  await assert.rejects(launchLinuxExecution(f.directory, { ...ref, machineId: "e".repeat(32) }, f.input, f.spec), ExecutionError);
  fs.chmodSync(f.directory, 0o750);
  await assert.rejects(stopLinuxExecution(f.directory, ref), ExecutionError);
  fs.chmodSync(f.directory, 0o700);
  for (const input of [{ ...f.input, tempDir: f.root }, { ...f.input, runtimeReadRoots: [f.directory] },
    { ...f.input, toolAliases: [{ path: "/virtual", target: f.directory }] }]) {
    await assert.rejects(launchLinuxExecution(f.directory, ref, input, f.spec), ExecutionError);
  }
  assert.equal(fs.existsSync(f.claimDir), false);
  assert.equal(spawn.mock.callCount(), 0);
});

test("认领缺失字段、坏 JSON 与原单元未观察不能形成停止证明", async context => {
  const f = fixture(context);
  saveClaim(f.claimDir);
  const execute = context.mock.method(childProcess, "execFile", () => { assert.fail("无原单元证据不查询或停止平台"); });
  syncBuiltinESMExports();
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, false);
  fs.writeFileSync(path.join(f.claimDir, "claim.json"), JSON.stringify({ version: 1, bootId: "bad" }));
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, false);
  fs.writeFileSync(path.join(f.claimDir, "claim.json"), "{");
  await assert.rejects(stopLinuxExecution(f.directory, ref), ExecutionError);
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(fs.existsSync(path.join(f.claimDir, "stop-requested")), true);
});

test("完整认领跨 boot 可证明退出，未派发证明必须匹配本次 token", async context => {
  const f = fixture(context);
  saveClaim(f.claimDir);
  fs.writeFileSync(path.join(f.claimDir, "not-dispatched.json"), JSON.stringify({ token: "e".repeat(32) }), { mode: 0o600 });
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, false);
  fs.writeFileSync(path.join(f.claimDir, "not-dispatched.json"), JSON.stringify({ token }));
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, true);
  fs.rmSync(path.join(f.claimDir, "not-dispatched.json"));
  const claim = JSON.parse(fs.readFileSync(path.join(f.claimDir, "claim.json"), "utf8"));
  fs.writeFileSync(path.join(f.claimDir, "claim.json"), JSON.stringify({ ...claim, bootId: "00000000-1234-1234-1234-123456789abc" }));
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, true);
});

for (const mismatch of ["invocation", "description", "inode", "query", "kill", "missing-events"] as const) {
  test(`停止拒绝 ${mismatch}，保留认领且不按单元名发信号`, async context => {
    const f = fixture(context);
    saveClaim(f.claimDir);
    const group = `/sys/fs/cgroup/user.slice/${scope}`;
    const actual = path.join(f.root, "group"); fs.mkdirSync(actual);
    const stat = fs.statSync(actual);
    fs.writeFileSync(path.join(actual, "cgroup.kill"), "");
    fs.writeFileSync(path.join(f.claimDir, "observation.json"), JSON.stringify({ group, invocationId, dev: stat.dev,
      ino: mismatch === "inode" ? stat.ino + 1 : stat.ino }), { mode: 0o600 });
    const open = nodeFs.openSync;
    let signals = 0;
    context.mock.method(nodeFs, "openSync", (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(target) === group) return open(actual, flags, mode);
      if (/^\/proc\/self\/fd\/\d+\/cgroup.kill$/.test(String(target))) {
        assert.equal(flags, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
        if (mismatch === "kill") throw Object.assign(new Error("denied"), { code: "EACCES" });
        signals++;
        return open(path.join(actual, "cgroup.kill"), flags, mode);
      }
      return open(target, flags, mode);
    });
    const execute = context.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
      assert.equal(_file, "/usr/bin/systemctl"); assert.equal(args[1], "show");
      callback(mismatch === "query" ? new Error("unavailable") : null,
        `LoadState=loaded\nActiveState=active\nControlGroup=/user.slice/${scope}\nInvocationID=${mismatch === "invocation" ? "e".repeat(32) : invocationId}\nDescription=ruukoto-execution-${mismatch === "description" ? "e".repeat(32) : token}\n`, "");
      return new childProcess.ChildProcess();
    });
    if (mismatch === "missing-events") {
      let ticks = 0;
      context.mock.method(Date, "now", () => ticks++ * 10_000);
    }
    syncBuiltinESMExports();
    assert.equal((await stopLinuxExecution(f.directory, ref)).exited, false);
    assert.equal(signals, mismatch === "missing-events" ? 1 : 0);
    assert.ok(execute.mock.callCount() >= 1);
    assert.equal(fs.existsSync(path.join(f.claimDir, "claim.json")), true);
  });
}

test("仅经原组 FD 停止，后续独立重核可证明原 launcher 与空组均退出", async context => {
  const f = fixture(context);
  saveClaim(f.claimDir);
  const group = `/sys/fs/cgroup/user.slice/${scope}`, actual = path.join(f.root, "group");
  fs.mkdirSync(actual);
  const stat = fs.statSync(actual);
  fs.writeFileSync(path.join(actual, "cgroup.kill"), "");
  fs.writeFileSync(path.join(actual, "cgroup.events"), "populated 0\n");
  fs.writeFileSync(path.join(f.claimDir, "observation.json"), JSON.stringify({ group, invocationId, dev: stat.dev, ino: stat.ino }), { mode: 0o600 });
  fs.writeFileSync(path.join(f.claimDir, "launcher.json"), JSON.stringify({ pid: 999999, processGroup: 999999, startTime: "123" }), { mode: 0o600 });
  const open = nodeFs.openSync, readFile = nodeFs.readFileSync;
  let signals = 0, queries = 0;
  context.mock.method(nodeFs, "openSync", (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (String(target) === group) return open(actual, flags, mode);
    if (/^\/proc\/self\/fd\/\d+\/cgroup.kill$/.test(String(target))) { signals++; return open(path.join(actual, "cgroup.kill"), flags, mode); }
    return open(target, flags, mode);
  });
  context.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (/^\/proc\/self\/fd\/\d+\/cgroup.events$/.test(String(target))) return "populated 0\n";
    if (target === "/proc/999999/stat") throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return readFile(target, options);
  });
  context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, -999999); assert.equal(signal, 0);
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  context.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    assert.equal(args[1], "show");
    callback(null, `LoadState=loaded\nActiveState=${queries++ ? "inactive" : "active"}\nControlGroup=/user.slice/${scope}\nInvocationID=${invocationId}\nDescription=ruukoto-execution-${token}\n`, "");
    return new childProcess.ChildProcess();
  });
  syncBuiltinESMExports();
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, true);
  assert.equal(signals, 1);
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, true);
  assert.equal(signals, 1, "重核已退出的原组不再发信号");
});

for (const launcher of ["original", "group-alive", "unverifiable", "exited"] as const) {
  test(`原组已删除仍核实启动器及进程组：${launcher}`, async context => {
    const f = fixture(context);
    saveClaim(f.claimDir);
    const group = `/sys/fs/cgroup/user.slice/${scope}`, readFile = nodeFs.readFileSync;
    fs.writeFileSync(path.join(f.claimDir, "observation.json"), JSON.stringify({ group, invocationId, dev: 1, ino: 1 }), { mode: 0o600 });
    fs.writeFileSync(path.join(f.claimDir, "launcher.json"), JSON.stringify({ pid: 999999, processGroup: 999999, startTime: "123" }), { mode: 0o600 });
    context.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (target === "/proc/999999/stat") {
        if (launcher === "original") return `999999 (launcher) ${["S", "1", "999999", ...Array(16).fill("0"), "123"].join(" ")}`;
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return readFile(target, options);
    });
    context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, -999999); assert.equal(signal, 0);
      if (launcher === "group-alive") return true;
      throw Object.assign(new Error("process state"), { code: launcher === "unverifiable" ? "EPERM" : "ESRCH" });
    });
    context.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
      assert.equal(args[1], "show"); callback(null, "LoadState=not-found\nActiveState=inactive\nControlGroup=\n", ""); return new childProcess.ChildProcess();
    });
    syncBuiltinESMExports();
    assert.equal((await stopLinuxExecution(f.directory, ref)).exited, launcher === "exited");
  });
}

for (const failure of ["process", "launcher-write", "observation-write", "description", "membership"] as const) {
  test(`启动后 ${failure} 失败交出持久停止句柄，同键不能再次派发`, async context => {
    const f = fixture(context);
    const marker = new PassThrough();
    const child = Object.assign(new childProcess.ChildProcess(), { pid: 999999, stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), stdio: [null, null, null, null, marker] });
    const access = nodeFs.accessSync, exists = nodeFs.existsSync, readFile = nodeFs.readFileSync, writeFile = nodeFs.writeFileSync, stat = nodeFs.statSync;
    const group = `/user.slice/${scope}`;
    context.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
      if (target === "/proc/999999/stat" && failure !== "process") return `999999 (launcher) ${["S", "1", "999999", ...Array(16).fill("0"), "123"].join(" ")}`;
      if (target === "/proc/999999/cgroup") return `0::${failure === "membership" ? "/wrong" : group}\n`;
      return readFile(target, options);
    });
    context.mock.method(nodeFs, "writeFileSync", (target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if ((failure === "launcher-write" && String(target).endsWith("/launcher.json")) ||
          (failure === "observation-write" && String(target).endsWith("/observation.json"))) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      return writeFile(target, data, options);
    });
    context.mock.method(nodeFs, "statSync", (target: fs.PathLike) => String(target) === `/sys/fs/cgroup${group}` ? stat(f.input.tempDir) : stat(target));
    context.mock.method(nodeFs, "accessSync", (target: fs.PathLike, mode?: number) => {
      if (["/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl"].includes(String(target))) return;
      if (String(target).endsWith("/cgroup.kill")) return;
      return access(target, mode);
    });
    context.mock.method(nodeFs, "existsSync", (target: fs.PathLike) => {
      if (String(target) === "/sys/fs/cgroup/cgroup.controllers") return true;
      if (String(target) === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns") return false;
      return exists(target);
    });
    context.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
      const saved = JSON.parse(fs.readFileSync(path.join(f.claimDir, "claim.json"), "utf8"));
      callback(null, args.includes("is-system-running") ? "running\n" :
        `LoadState=loaded\nActiveState=active\nControlGroup=${group}\nInvocationID=${invocationId}\nDescription=ruukoto-execution-${failure === "description" ? "e".repeat(32) : saved.token}\n`, "");
      return new childProcess.ChildProcess();
    });
    const spawn = context.mock.method(childProcess, "spawn", (_file: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      assert.equal(options.detached, true); assert.ok(args.includes(scope)); setImmediate(() => marker.end("started\n")); return child;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(launchLinuxExecution(f.directory, ref, f.input, f.spec), asyncError => {
        assert.ok(asyncError instanceof ExecutionError && asyncError.unit);
        assert.equal(asyncError.unit.entry.id, scope);
        return true;
      });
      await assert.rejects(launchLinuxExecution(f.directory, ref, f.input, f.spec), ExecutionError);
      assert.equal(spawn.mock.callCount(), 1);
      assert.equal((await stopLinuxExecution(f.directory, ref)).exited, false);
      assert.equal(fs.existsSync(path.join(f.claimDir, "observation.json")), false);
    } finally { child.emit("exit", 0, null); marker.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  });
}

test("认领写入失败零平台外调，半写认领不授予第二次执行权", async context => {
  const f = fixture(context), writeFile = nodeFs.writeFileSync;
  context.mock.method(nodeFs, "writeFileSync", (target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (String(target).endsWith("/claim.json")) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return writeFile(target, data, options);
  });
  const execute = context.mock.method(childProcess, "execFile", () => { assert.fail("半写认领不能外调"); });
  const spawn = context.mock.method(childProcess, "spawn", () => { assert.fail("半写认领不能启动"); });
  syncBuiltinESMExports();
  await assert.rejects(launchLinuxExecution(f.directory, ref, f.input, f.spec), ExecutionError);
  await assert.rejects(launchLinuxExecution(f.directory, ref, f.input, f.spec), ExecutionError);
  assert.equal(execute.mock.callCount(), 0); assert.equal(spawn.mock.callCount(), 0);
});

test("前置拒绝后未派发证据写入再失败，保留两次失败并以具名错误报告", async context => {
  const f = fixture(context), writeFile = nodeFs.writeFileSync, access = nodeFs.accessSync;
  context.mock.method(nodeFs, "accessSync", (target: fs.PathLike, mode?: number) => {
    if (target === "/usr/bin/bwrap") throw Object.assign(new Error("binary missing"), { code: "ENOENT" });
    return access(target, mode);
  });
  context.mock.method(nodeFs, "writeFileSync", (target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (String(target).endsWith("/not-dispatched.json")) throw Object.assign(new Error("receipt EIO"), { code: "EIO" });
    return writeFile(target, data, options);
  });
  syncBuiltinESMExports();
  await assert.rejects(launchLinuxExecution(f.directory, ref, f.input, f.spec), error => {
    assert.ok(error instanceof ExecutionError && error.code === "execution_identity_invalid");
    assert.ok(error.cause instanceof AggregateError);
    assert.ok(error.cause.errors[0] instanceof ExecutionError && error.cause.errors[0].reason === "binary_missing");
    assert.equal(error.cause.errors[1].code, "EIO");
    return true;
  });
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, false);
});

test("认领后派发前停止阻止迟到启动，完成未派发证明后可释放", async context => {
  const f = fixture(context), access = nodeFs.accessSync, exists = nodeFs.existsSync;
  context.mock.method(nodeFs, "accessSync", (target: fs.PathLike, mode?: number) => {
    if (["/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl"].includes(String(target))) return;
    return access(target, mode);
  });
  context.mock.method(nodeFs, "existsSync", (target: fs.PathLike) => {
    if (String(target) === "/sys/fs/cgroup/cgroup.controllers") return true;
    if (String(target) === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns") return false;
    return exists(target);
  });
  let release!: () => void;
  context.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    assert.ok(args.includes("is-system-running")); release = () => callback(null, "running\n", ""); return new childProcess.ChildProcess();
  });
  const spawn = context.mock.method(childProcess, "spawn", () => { assert.fail("取消后不得启动"); });
  syncBuiltinESMExports();
  const pending = launchLinuxExecution(f.directory, ref, f.input, f.spec);
  const rejected = assert.rejects(pending, ExecutionError);
  await assert.rejects(launchLinuxExecution(f.directory, ref, f.input, f.spec), ExecutionError);
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, false);
  release(); await rejected;
  assert.equal((await stopLinuxExecution(f.directory, ref)).exited, true);
  assert.equal(spawn.mock.callCount(), 0);
});
