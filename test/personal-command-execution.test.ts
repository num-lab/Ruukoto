import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { prepareNativeLaunch } from "@ruukoto/agent/execution/native.ts";
import { stopLinuxExecution, type LinuxExecutionRef } from "@ruukoto/agent/execution/native-linux-identity.ts";
import type { LaunchSpec } from "@ruukoto/agent/execution/launchers.ts";
import { personalCommandFingerprint, runPersonalCommand, readPersonalCommandReceipt, readPersonalCommandOutput, stopPersonalCommand } from "../apps/ruukoto/src/personal-command-execution.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

const machineId = "a".repeat(32), bootId = "12345678-1234-1234-1234-123456789abc";

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "command-host-")));
  const directory = path.join(root, "claims"), workspace = path.join(root, "work"), workerPath = path.join(root, "worker.mjs"), groupPath = path.join(root, "group");
  for (const dir of [directory, workspace, groupPath]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.copyFileSync(fileURLToPath(new URL("../worker/personal-command-worker.mjs", import.meta.url)), workerPath);
  const ref: LinuxExecutionRef = { executionId: `native_${"b".repeat(24)}`, machineId };
  const { dev, ino } = fs.statSync(workspace);
  const spec: LaunchSpec = { taskId: "command-test", mode: "confirm", workspace, workspaceIdentity: { dev, ino }, grantedPaths: [] };
  const input = await prepareNativeLaunch({ workerPath, dependencyRoots: [] }, spec);
  const record = path.join(directory, `command-${ref.executionId}`), scope = `ruukoto-${ref.executionId}.scope`, group = `/user.slice/${scope}`;
  let child: childProcess.ChildProcess | undefined, count = 0, stopFails = false, wrapperExit = false, beforeManager: (() => void) | undefined;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  const realSpawn = childProcess.spawn, readFile = nodeFs.readFileSync, exists = nodeFs.existsSync, access = nodeFs.accessSync, open = nodeFs.openSync, stat = nodeFs.statSync;
  const alive = () => !!child && child.exitCode === null && child.signalCode === null;
  t.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (target === "/etc/machine-id") return machineId + "\n";
    if (target === "/proc/sys/kernel/random/boot_id") return bootId + "\n";
    if (target === `/proc/${child?.pid}/stat`) {
      if (!alive()) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return `${child!.pid} (worker) ${["S", "1", String(child!.pid), ...Array(16).fill("0"), "123"].join(" ")}`;
    }
    if (target === `/proc/${child?.pid}/cgroup`) return `0::${group}\n`;
    if (/^\/proc\/self\/fd\/\d+\/cgroup.events$/.test(String(target))) return `populated ${alive() ? 1 : 0}\n`;
    return readFile(target, options);
  });
  t.mock.method(nodeFs, "existsSync", (target: fs.PathLike) => {
    if (target === "/sys/fs/cgroup/cgroup.controllers") return true;
    if (target === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns") return false;
    return exists(target);
  });
  t.mock.method(nodeFs, "accessSync", (target: fs.PathLike, mode?: number) => {
    if (["/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl", `/sys/fs/cgroup${group}/cgroup.kill`].includes(String(target))) return;
    return access(target, mode);
  });
  t.mock.method(nodeFs, "statSync", (target: fs.PathLike, options?: fs.StatOptions) => stat(target === `/sys/fs/cgroup${group}` ? groupPath : target, options));
  t.mock.method(nodeFs, "openSync", (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (target === `/sys/fs/cgroup${group}`) return open(groupPath, flags, mode);
    if (/^\/proc\/self\/fd\/\d+\/cgroup.kill$/.test(String(target))) {
      if (alive()) process.kill(-child!.pid!, "SIGKILL");
      return open(path.join(groupPath, "kill"), "w");
    }
    return open(target, flags, mode);
  });
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    if (args.includes("is-system-running")) { beforeManager?.(); callback(null, "running\n", ""); }
    else {
      const claim = JSON.parse(readFile(path.join(directory, ref.executionId, "claim.json"), "utf8"));
      callback(stopFails && !alive() ? new Error("query failed") : null,
        `LoadState=loaded\nActiveState=${alive() ? "active" : "inactive"}\nControlGroup=${group}\nInvocationID=${"c".repeat(32)}\nDescription=ruukoto-execution-${claim.token}\n`, "");
    }
    return new childProcess.ChildProcess();
  });
  t.mock.method(childProcess, "spawn", () => {
    count++;
    child = realSpawn(process.execPath, [workerPath], { cwd: workspace, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const emit = child.emit.bind(child);
    child.emit = (event: string | symbol, ...args: unknown[]) => wrapperExit && event === "exit" && args[1] === "SIGKILL" ? emit("exit", 137, null) : emit(event, ...args);
    const marker = new PassThrough(); child.stdio[4] = marker;
    setImmediate(() => marker.end("started\n"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    if (alive()) process.kill(-child!.pid!, "SIGKILL");
    t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", platform);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(input.tempDir, { recursive: true, force: true });
  });
  const options = { directory, ref, input, spec, timeoutMs: 10_000 };
  return { root, record, options, input, workspace, count: () => count, systemdExit: () => { wrapperExit = true; }, beforeLaunch: (callback: () => void) => { beforeManager = callback; }, failStop: (value = true) => { stopFails = value; }, run: (command: string) => runPersonalCommand({ ...options, command }) };
}

test("宿主先消费双流再提交 stdin，回执保留二进制/非零且同引用永不重跑", async t => {
  const f = await fixture(t);
  const result = await f.run("printf '\\000\\377out'; printf '\\376err' >&2; echo x >> count; exit 37");
  assert.equal(result.receipt.exit.code, 37); assert.equal(result.exited, true); assert.equal(result.cleaned, true);
  assert.deepEqual(fs.readFileSync(path.join(f.record, "stdout")), Buffer.from([0, 255, 111, 117, 116]));
  assert.deepEqual(fs.readFileSync(path.join(f.record, "stderr")), Buffer.from([254, 101, 114, 114]));
  assert.deepEqual(await readPersonalCommandReceipt(f.options.directory, f.options.ref), result.receipt);
  await assert.rejects(f.run("echo y >> count"), error => error instanceof PersonalError && error.code === "command_already_claimed");
  assert.equal(f.count(), 1); assert.equal(fs.readFileSync(path.join(f.workspace, "count"), "utf8"), "x\n");
});

test("大输出完整落盘，worker 的信号映射保持为原退出观察", async t => {
  const f = await fixture(t);
  const { receipt } = await f.run("head -c 3000000 /dev/zero; head -c 1000000 /dev/zero >&2; kill -TERM $$");
  assert.equal(receipt.stdout.bytes, 3_000_000); assert.equal(receipt.stderr.bytes, 1_000_000); assert.equal(receipt.exit.code, 143);
  assert.deepEqual(await readPersonalCommandReceipt(f.options.directory, f.options.ref), receipt);
});

test("双流分页核对原意图，原字节不截断，坏引用和损坏输出拒绝", async t => {
  const f = await fixture(t), result = await f.run("head -c 4000 /dev/zero; printf '\\377err' >&2");
  const fingerprint = result.receipt.fingerprint;
  const first = await readPersonalCommandOutput(f.options.directory, f.options.ref, fingerprint, "stdout");
  assert.equal(first.nextOffset, 3072); assert.equal(first.complete, true);
  const second = await readPersonalCommandOutput(f.options.directory, f.options.ref, fingerprint, "stdout", first.nextOffset);
  assert.equal(second.nextOffset, undefined); assert.equal(Buffer.from(second.data, "base64").length, 928);
  assert.deepEqual(Buffer.from((await readPersonalCommandOutput(f.options.directory, f.options.ref, fingerprint, "stderr")).data, "base64"), Buffer.from([255, 101, 114, 114]));
  await assert.rejects(readPersonalCommandOutput(f.options.directory, f.options.ref, "0".repeat(64), "stdout"), PersonalError);
  await assert.rejects(readPersonalCommandOutput(f.options.directory, f.options.ref, fingerprint, "stdout", -1), PersonalError);
  fs.appendFileSync(path.join(f.record, "stdout"), "tampered");
  await assert.rejects(readPersonalCommandOutput(f.options.directory, f.options.ref, fingerprint, "stdout"), PersonalError);
});

for (const kind of ["timeout", "cancel"] as const) test(`${kind} 停止原引用但没有完成回执，已捕获输出仍保留`, async t => {
  const f = await fixture(t), controller = new AbortController();
  const command = "printf started; sleep 30";
  const pending = runPersonalCommand({ ...f.options, command, signal: controller.signal, timeoutMs: kind === "timeout" ? 200 : 10_000 });
  const rejected = assert.rejects(pending, error => error instanceof PersonalError && error.code === "command_result_unknown");
  if (kind === "cancel") {
    while (!fs.existsSync(path.join(f.record, "stdout")) || fs.statSync(path.join(f.record, "stdout")).size === 0) await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
  }
  await rejected;
  assert.equal(await readPersonalCommandReceipt(f.options.directory, f.options.ref), undefined);
  assert.equal((await stopPersonalCommand(f.options.directory, f.options.ref)).exited, true);
  assert.equal(fs.existsSync(f.input.tempDir), false); assert.equal(f.count(), 1);
});

test("停止查询失败保留原临时目录，命令回执与停止是两个事实", async t => {
  const f = await fixture(t); f.failStop();
  const result = await f.run("exit 0");
  assert.equal(result.exited, false); assert.equal(result.cleaned, false); assert.equal(fs.existsSync(f.input.tempDir), true);
  assert.deepEqual(await readPersonalCommandReceipt(f.options.directory, f.options.ref), result.receipt);
});

for (const failure of ["capture", "receipt"] as const) test(`${failure} 落盘失败不发布完成，仍按原引用核实停止`, async t => {
  const f = await fixture(t);
  if (failure === "capture") {
    const create = nodeFs.createWriteStream;
    t.mock.method(nodeFs, "createWriteStream", (target: fs.PathLike, options?: Parameters<typeof fs.createWriteStream>[1]) => create(String(target).endsWith("/stdout") ? path.join(f.root, "missing", "out") : target, options));
  } else {
    const rename = nodeFs.renameSync;
    t.mock.method(nodeFs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith("/receipt.json")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return rename(from, to);
    });
  }
  syncBuiltinESMExports();
  await assert.rejects(f.run("printf data"), error => error instanceof PersonalError && error.code === "command_result_unknown");
  assert.equal(await readPersonalCommandReceipt(f.options.directory, f.options.ref), undefined);
  assert.equal((await stopPersonalCommand(f.options.directory, f.options.ref)).exited, true);
  assert.equal(fs.existsSync(f.input.tempDir), false);
});

test("损坏输出、链接及异版本回执拒绝，未知结果不获得第二次执行权", async t => {
  const f = await fixture(t); await f.run("printf data");
  const output = path.join(f.record, "stdout"), original = fs.readFileSync(output);
  fs.appendFileSync(output, "tampered"); await assert.rejects(readPersonalCommandReceipt(f.options.directory, f.options.ref), PersonalError);
  fs.writeFileSync(output, original); fs.linkSync(output, path.join(f.record, "alias"));
  await assert.rejects(readPersonalCommandReceipt(f.options.directory, f.options.ref), PersonalError); fs.unlinkSync(path.join(f.record, "alias"));
  const receipt = path.join(f.record, "receipt.json"), raw = JSON.parse(fs.readFileSync(receipt, "utf8"));
  fs.writeFileSync(receipt, JSON.stringify({ ...raw, version: 2 })); await assert.rejects(readPersonalCommandReceipt(f.options.directory, f.options.ref), PersonalError);
  await assert.rejects(f.run("touch rerun"), PersonalError); assert.equal(f.count(), 1);
});

test("停止先手和缺绑定只核实原引用，不清理或执行", async t => {
  const f = await fixture(t);
  assert.deepEqual(await stopPersonalCommand(f.options.directory, f.options.ref), { ref: f.options.ref, exited: true, cleaned: false });
  await assert.rejects(f.run("touch rerun"), PersonalError); assert.equal(f.count(), 0);
  assert.equal(await readPersonalCommandReceipt(f.options.directory, f.options.ref), undefined);
  assert.equal(fs.existsSync(f.input.tempDir), true);
});

test("取消先于 launch 返回仍不提交命令，并保留原绑定核实停止", async t => {
  const f = await fixture(t), controller = new AbortController();
  f.beforeLaunch(() => controller.abort());
  await assert.rejects(runPersonalCommand({ ...f.options, command: "touch rerun", signal: controller.signal }), error => error instanceof PersonalError && error.code === "command_result_unknown");
  assert.equal(f.count(), 0); assert.equal(fs.existsSync(path.join(f.workspace, "rerun")), false);
  assert.equal((await stopPersonalCommand(f.options.directory, f.options.ref)).exited, true);
});

test("替换临时目录后停止只保留现场，不删除替代目录", async t => {
  const f = await fixture(t); f.failStop(); await f.run("exit 0");
  const old = f.input.tempDir + "-old"; fs.renameSync(f.input.tempDir, old); fs.mkdirSync(f.input.tempDir);
  fs.writeFileSync(path.join(f.input.tempDir, "keep"), "retained");
  f.failStop(false);
  const result = await stopPersonalCommand(f.options.directory, f.options.ref);
  assert.equal(result.exited, true); assert.equal(result.cleaned, false);
  assert.equal(fs.readFileSync(path.join(f.input.tempDir, "keep"), "utf8"), "retained");
  fs.rmSync(old, { recursive: true });
});

test("不同执行引用不能共用原临时目录，也不能清理其他执行的目录", async t => {
  const f = await fixture(t); f.failStop(); await f.run("exit 0");
  const other = { ...f.options.ref, executionId: `native_${"d".repeat(24)}` };
  await assert.rejects(runPersonalCommand({ ...f.options, ref: other, command: "touch rerun" }), PersonalError);
  assert.equal(f.count(), 1);
  assert.deepEqual(await stopPersonalCommand(f.options.directory, other), { ref: other, exited: true, cleaned: false });
  assert.equal(fs.existsSync(f.input.tempDir), true);
});

test("独立停止正在执行的命令不发布完成回执", async t => {
  const f = await fixture(t); f.systemdExit();
  const pending = f.run("printf started; sleep 30");
  const rejected = assert.rejects(pending, error => error instanceof PersonalError && error.code === "command_result_unknown");
  while (!fs.existsSync(path.join(f.record, "stdout")) || fs.statSync(path.join(f.record, "stdout")).size === 0) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await stopPersonalCommand(f.options.directory, f.options.ref)).exited, true);
  await rejected;
  assert.equal(await readPersonalCommandReceipt(f.options.directory, f.options.ref), undefined);
});

test("坏命令、完全访问和可见证据目录在启动前拒绝", async t => {
  const f = await fixture(t);
  for (const command of [" ", "touch marker\0", "x".repeat(4 * 1024 * 1024)]) await assert.rejects(f.run(command), PersonalError);
  await assert.rejects(runPersonalCommand({ ...f.options, command: "touch marker", spec: { ...f.options.spec, mode: "full_access" } }), PersonalError);
  await assert.rejects(runPersonalCommand({ ...f.options, command: "touch marker", input: { ...f.input, runtimeReadRoots: [...f.input.runtimeReadRoots, f.options.directory] } }), PersonalError);
  assert.equal(f.count(), 0); assert.equal(fs.existsSync(f.record), false);
});

for (const missing of ["native-claim", "request", "expected-fingerprint", "native-fingerprint", "stop-first"] as const) test(`严格停止：${missing} 不把仍存活的原命令报为退出，恢复原证据后才能停止`, async t => {
  const f = await fixture(t), command = "printf started; sleep 0.2; echo survived > surviving-process; sleep 30";
  const fingerprint = personalCommandFingerprint(command, f.options.spec, f.options.input);
  const pending = f.run(command);
  const outcome = pending.then(() => "returned", error => error instanceof PersonalError ? error.code : "unexpected_error");
  while (!fs.existsSync(path.join(f.record, "stdout")) || fs.statSync(path.join(f.record, "stdout")).size === 0) await new Promise(resolve => setTimeout(resolve, 5));
  const claim = path.join(f.options.directory, f.options.ref.executionId), retained = path.join(f.root, "retained-claim");
  const request = path.join(f.record, "request.json"), retainedRequest = path.join(f.root, "retained-request.json");
  const claimFile = path.join(claim, "claim.json");
  let original: string | undefined;
  if (missing === "native-claim" || missing === "stop-first") {
    fs.renameSync(claim, retained);
    if (missing === "stop-first") assert.equal((await stopLinuxExecution(f.options.directory, f.options.ref)).exited, true);
  } else if (missing === "request") fs.renameSync(request, retainedRequest);
  else if (missing === "native-fingerprint") { original = fs.readFileSync(claimFile, "utf8"); fs.writeFileSync(claimFile, JSON.stringify({ ...JSON.parse(original), fingerprint: "0".repeat(64) })); }
  const expected = missing === "expected-fingerprint" ? "0".repeat(64) : fingerprint;
  if (missing === "request" || missing === "expected-fingerprint") await assert.rejects(readPersonalCommandReceipt(f.options.directory, f.options.ref, expected), PersonalError);
  if (missing === "native-claim" || missing === "request" || missing === "expected-fingerprint") await assert.rejects(stopPersonalCommand(f.options.directory, f.options.ref, expected), PersonalError);
  else assert.deepEqual(await stopPersonalCommand(f.options.directory, f.options.ref, expected), { ref: f.options.ref, exited: false, cleaned: false });
  assert.equal(fs.existsSync(f.input.tempDir), true);
  assert.equal(fs.existsSync(path.join(claim, "stop-requested")), missing === "stop-first");
  if (missing === "native-claim") assert.equal(fs.existsSync(claim), false);
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(path.join(f.workspace, "surviving-process"))) { assert.ok(Date.now() < deadline, "原命令在严格停止拒绝后应仍可继续运行"); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(fs.readFileSync(path.join(f.workspace, "surviving-process"), "utf8"), "survived\n");
  if (missing === "stop-first") fs.rmSync(claim, { recursive: true });
  if (missing === "native-claim" || missing === "stop-first") fs.renameSync(retained, claim);
  else if (missing === "request") fs.renameSync(retainedRequest, request);
  else if (original !== undefined) fs.writeFileSync(claimFile, original);
  const stopped = await stopPersonalCommand(f.options.directory, f.options.ref, fingerprint);
  assert.equal(stopped.exited, true); assert.equal(stopped.cleaned, true);
  assert.equal(await outcome, "command_result_unknown");
  assert.equal(f.count(), 1);
});

test("活调用：launch 后丢失原 claim 不认 stop-first，原临时目录与后代留待核实", async t => {
  const f = await fixture(t), command = "printf started; while [ ! -e release-worker ]; do sleep 0.01; done; (sleep 0.1; echo survived > surviving-process; sleep 30) >/dev/null 2>&1 &";
  const outcome = f.run(command).then(value => ({ value }), error => ({ error }));
  while (!fs.existsSync(path.join(f.record, "stdout")) || fs.statSync(path.join(f.record, "stdout")).size === 0) await new Promise(resolve => setTimeout(resolve, 5));
  const claim = path.join(f.options.directory, f.options.ref.executionId);
  const launcher = JSON.parse(fs.readFileSync(path.join(claim, "launcher.json"), "utf8"));
  let cleanupError: unknown;
  try {
    fs.renameSync(claim, path.join(f.root, "retained-claim"));
    fs.writeFileSync(path.join(f.workspace, "release-worker"), "release");
    const result = await outcome;
    assert.ok("error" in result && result.error instanceof PersonalError && result.error.code === "command_stop_unverified", "派发后缺少原 claim 不能获得停止或清理证明");
    assert.equal(fs.existsSync(f.input.tempDir), true);
    assert.equal(fs.existsSync(claim), false);
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(f.workspace, "surviving-process"))) { assert.ok(Date.now() < deadline, "原后代应在未核实停止时继续运行"); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(fs.readFileSync(path.join(f.workspace, "surviving-process"), "utf8"), "survived\n");
  } finally {
    try { process.kill(-Number(launcher.pid), "SIGKILL"); }
    catch (error) { cleanupError = error; }
  }
  if (cleanupError !== undefined) assert.ok(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ESRCH");
});
