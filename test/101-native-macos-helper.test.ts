import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { launchMacosNative } from "@ruukoto/agent/execution/native-macos.ts";
import { ExecutionError } from "@ruukoto/agent/execution/launchers.ts";
import type { PreparedNativeLaunch } from "@ruukoto/agent/execution/native.ts";

const helper = fileURLToPath(new URL("../worker/native-macos-supervisor", import.meta.url));
const available = process.platform === "darwin" && fs.existsSync(helper);
type Status = { type: string; pid?: number; reaped?: boolean; reason?: string };

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("监督器夹具等待超时");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function supervise(command: string[]) {
  const child = spawn(helper, ["--", ...command], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], detached: true });
  const messages: Status[] = [];
  let output = "";
  let errors = "";
  let buffer = "";
  child.stdout!.on("data", data => { output += data.toString(); });
  child.stderr!.on("data", data => { errors += data.toString(); });
  const status = child.stdio[3] as Readable;
  const control = child.stdio[4] as Writable;
  status.on("data", data => {
    buffer += data.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  return { child, messages, output: () => output, errors: () => errors, closed, stop: () => control.end("stop\n") };
}

async function finish(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await closed;
}

test("macOS 监督器核实 libproc、原子信号、版本回卷与跨 UID 的 PID 1 身份", { skip: !available }, () => {
  const checked = spawnSync(helper, ["--check"], { encoding: "utf8" });
  assert.equal(checked.status, 0, "--check 自检 UINT32_MAX→1、正常顺序及有符号边界，不强迫真实内核回卷");
  assert.equal(JSON.parse(checked.stdout).launchdVerified, true, "PID 1 不使用只允许同 UID 的 flavor 18");
  assert.equal(spawnSync(helper, ["--", "/bin/true"], { encoding: "utf8" }).status, 2, "缺宿主控制 FD 时不启动工具进程");
});

test("macOS 监督器不把宿主状态和控制 FD 传给执行进程", { skip: !available }, async () => {
  const run = supervise(["/bin/sh", "-c", "if (printf leak >&3) 2>/dev/null; then exit 31; fi; if (printf leak >&4) 2>/dev/null; then exit 32; fi; printf closed"]);
  try {
    await run.closed;
    assert.equal(run.child.exitCode, 0, run.errors());
    assert.equal(run.output(), "closed");
    assert.equal(run.messages.at(-1)?.reaped, true, JSON.stringify(run.messages));
  } finally { await finish(run.child, run.closed); }
});

test("macOS 真实 Seatbelt 中 Node 完成启动标记后才加载 worker，启动前失败保留机器原因", { skip: !available }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/rk-native-bootstrap-"));
  const workspace = path.join(dir, "work"), tempDir = path.join(dir, "tmp");
  fs.mkdirSync(workspace); fs.mkdirSync(tempDir);
  const workerPath = path.join(workspace, "fixture.mjs");
  const secret = fs.openSync(path.join(dir, "virtual-control"), "w+");
  const secretStat = fs.fstatSync(secret);
  fs.writeFileSync(workerPath, `import fs from 'node:fs';let inherited=false;for(let fd=3;fd<64;fd++){try{const s=fs.fstatSync(fd);if(s.dev===${secretStat.dev}&&s.ino===${secretStat.ino})inherited=true;}catch{}}process.stdout.write(JSON.stringify({inherited})+'\\n');setTimeout(()=>{},20000);`);
  const nodePath = fs.realpathSync(process.execPath);
  const prepared: PreparedNativeLaunch = {
    workspace, tempDir, workerPath, nodePath,
    runtimeReadRoots: ["/System/Library", "/usr/lib", "/usr/bin", "/bin", path.dirname(path.dirname(nodePath))],
    toolAliases: [], mounts: [{ path: workspace, access: "read_write" }],
    env: { PATH: "/usr/bin:/bin", HOME: tempDir, TMPDIR: tempDir },
  };
  const spec = { taskId: "bootstrap-check", mode: "confirm" as const, workspace, grantedPaths: [] };
  let unit: Awaited<ReturnType<typeof launchMacosNative>> | null = null;
  let reaped = true;
  try {
    unit = await launchMacosNative(prepared, spec, helper);
    let output = "";
    unit.stdout.on("data", data => { output += data.toString(); });
    await waitFor(() => output.includes("\n"));
    assert.equal(JSON.parse(output.trim()).inherited, false, "敏感宿主 FD 未传入 worker");
    assert.equal(fs.readFileSync(path.join(tempDir, "native-started"), "utf8"), "started");
    reaped = await unit.entry.stop();
    assert.equal(reaped, true);
    unit = null;
    fs.unlinkSync(path.join(tempDir, "native-started"));
    await assert.rejects(launchMacosNative({ ...prepared, nodePath: "/usr/bin/false" }, spec, helper), error => {
      assert.ok(error instanceof ExecutionError);
      assert.equal(error.reason, "sandbox_rejected");
      assert.ok(error.unit, "失败仍提供停止身份");
      return true;
    });
  } finally {
    if (unit) reaped = await unit.entry.stop();
    fs.closeSync(secret);
    if (reaped) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("macOS 控制通道关闭回收独立进程组内忽略 TERM 的已累计后代", { skip: !available }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/rk-native-stop-"));
  const beats = path.join(dir, "heartbeat");
  const shell = `trap "" TERM; i=0; while [ "$i" -lt 150 ]; do printf beat >> '${beats}'; sleep 0.02; i=$((i+1)); done`;
  const script = `require('child_process').spawn('/bin/sh',['-c',${JSON.stringify(shell)}],{detached:true,stdio:'ignore'});setTimeout(()=>{},20000);`;
  const run = supervise([process.execPath, "-e", script]);
  try {
    await waitFor(() => fs.existsSync(beats) && fs.statSync(beats).size > 8);
    const before = fs.statSync(beats).size;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.statSync(beats).size > before, "停止前心跳确实增长");
    run.stop();
    await run.closed;
    assert.equal(run.messages.at(-1)?.reaped, true, `${JSON.stringify(run.messages)} ${run.errors()}`);
    const after = fs.statSync(beats).size;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(fs.statSync(beats).size, after, "停止后心跳冻结");
  } finally {
    await finish(run.child, run.closed);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("macOS 轮询漏记短命父亲后的新孤儿保留为未核实，且不向未知归属发信号", { skip: !available }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/rk-native-orphan-"));
  const beats = path.join(dir, "heartbeat");
  const pidFile = path.join(dir, "pid");
  const gate = path.join(dir, "go");
  const python = [
    "import os,time",
    "pid=os.fork()",
    "if pid == 0:",
    " os.setsid()",
    ` open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))`,
    ` output=open(${JSON.stringify(beats)},'a',buffering=1)`,
    " end=time.monotonic()+3",
    " while time.monotonic()<end:",
    "  output.write('beat\\n');time.sleep(0.02)",
    " os._exit(0)",
    "os._exit(0)",
  ].join("\n");
  const script = `const fs=require('fs'),cp=require('child_process');process.stdout.write('ready');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);cp.spawn('/usr/bin/python3',['-I','-c',${JSON.stringify(python)}],{stdio:'ignore'});}},2);setTimeout(()=>{},20000);`;
  const run = supervise([process.execPath, "-e", script]);
  let suspended = false;
  try {
    await waitFor(() => run.output().includes("ready"));
    process.kill(run.child.pid!, "SIGSTOP");
    suspended = true;
    fs.writeFileSync(gate, "go");
    await waitFor(() => fs.existsSync(beats) && fs.statSync(beats).size > 0);
    process.kill(run.child.pid!, "SIGCONT");
    suspended = false;
    run.stop();
    await run.closed;
    const result = run.messages.at(-1);
    assert.equal(result?.reaped, false, JSON.stringify(run.messages));
    assert.match(result?.reason ?? "", /unknown_new_orphan|observation_interrupted/);
    const before = fs.statSync(beats).size;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(fs.statSync(beats).size > before, "未知归属孤儿在返回后仍写心跳，没有被监督器误杀");
  } finally {
    if (suspended) process.kill(run.child.pid!, "SIGCONT");
    await finish(run.child, run.closed);
    // 虚拟孤儿自行限时退出；不以裸 PID 信号清理可能被复用的身份。
    await new Promise(resolve => setTimeout(resolve, 3200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
