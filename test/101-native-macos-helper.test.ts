import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { finished } from "node:stream/promises";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { launchMacosNative } from "@ruukoto/agent/execution/native-macos.ts";
import { ExecutionError, type LaunchedUnit } from "@ruukoto/agent/execution/launchers.ts";
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

// Note: 见 .agents/notes/implemented/bug-fix/2026-10-24-native-marker-atomic-publish.md
test("macOS 真实 Seatbelt 中 Node 完成启动标记后才加载 worker，启动前失败保留机器原因", { skip: !available }, async context => {
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
  const marker = path.join(tempDir, "native-started"), opened = path.join(tempDir, "marker-opened"), release = path.join(tempDir, "marker-release");
  const preload = path.join(workspace, "marker-write-gate.cjs");
  fs.writeFileSync(preload, `const fs=require('node:fs'),write=fs.writeFileSync;
    fs.writeFileSync=(file,value,options)=>{
      if(file!==${JSON.stringify(marker)}&&file!==${JSON.stringify(marker + ".tmp")})return write(file,value,options);
      const fd=fs.openSync(file,'w');
      try{
        write(${JSON.stringify(opened + ".tmp")},JSON.stringify({pid:process.pid}));fs.renameSync(${JSON.stringify(opened + ".tmp")},${JSON.stringify(opened)});
        const deadline=Date.now()+5000;
        while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw new Error('启动标记夹具未释放');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
        return write(fd,value,options);
      }finally{fs.closeSync(fd);}
    };`);
  let visibleDuringWrite: number | null | undefined;
  const read = nodeFs.readFileSync;
  context.mock.method(nodeFs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (args[0] !== marker || visibleDuringWrite !== undefined || !fs.existsSync(opened)) return read(...args);
    visibleDuringWrite = fs.existsSync(marker) ? fs.statSync(marker).size : null;
    try { return read(...args); } finally { fs.writeFileSync(release, "release"); }
  });
  syncBuiltinESMExports();

  let unit: LaunchedUnit | null = null;
  let reaped = true;
  try {
    try { unit = await launchMacosNative({ ...prepared, env: { ...prepared.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } }, spec, helper); }
    catch (error) { if (error instanceof ExecutionError && error.unit) unit = error.unit; throw error; }
    assert.equal(visibleDuringWrite, null, "完整标记发布前，真实宿主读取只应看到尚不存在");
    let output = "";
    unit.stdout.on("data", data => { output += data.toString(); });
    await waitFor(() => output.includes("\n"));
    assert.equal(JSON.parse(output.trim()).inherited, false, "敏感宿主 FD 未传入 worker");
    assert.equal(fs.readFileSync(path.join(tempDir, "native-started"), "utf8"), "started");
    reaped = await unit.entry.stop();
    assert.equal(reaped, true);
    unit.stdout.resume(); unit.stderr.resume();
    await Promise.all([unit.exit, finished(unit.stdout), finished(unit.stderr)]);
    unit = null;
    fs.unlinkSync(marker);
    await assert.rejects(launchMacosNative({ ...prepared, nodePath: "/usr/bin/false" }, spec, helper), error => {
      assert.ok(error instanceof ExecutionError);
      unit = error.unit ?? null;
      assert.equal(error.reason, "sandbox_rejected");
      assert.ok(error.unit, "失败仍提供停止身份");
      return true;
    });
  } finally {
    try {
      try { fs.writeFileSync(release, "release"); }
      finally {
        if (unit) {
          let stopped = false;
          try { stopped = await unit.entry.stop(); }
          finally {
            reaped = stopped && reaped;
            unit.stdout.resume(); unit.stderr.resume();
            await Promise.all([unit.exit, finished(unit.stdout), finished(unit.stderr)]);
          }
        }
      }
    } finally {
      try { context.mock.restoreAll(); syncBuiltinESMExports(); }
      finally {
        fs.closeSync(secret);
        if (reaped) fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

// Note: 见 .agents/notes/implemented/testing/2026-10-11-await-observed-async-phases.md
test("macOS 控制通道关闭回收独立进程组内忽略 TERM 的已累计后代", { skip: !available }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/rk-native-stop-"));
  const beats = path.join(dir, "heartbeat");
  const ready = path.join(dir, "ready");
  const termReceived = path.join(dir, "term-received");
  const release = path.join(dir, "release");
  const descendant = `const fs=require('node:fs');let termHandled=false;process.on('SIGTERM',()=>{if(!termHandled){fs.writeFileSync(${JSON.stringify(termReceived)},'TERM');termHandled=true;}});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({ppid:process.ppid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);fs.appendFileSync(${JSON.stringify(beats)},'beat');},500);setTimeout(()=>process.exit(0),20000);`;
  // 后代从不关闭 stdout；共享管道 EOF 独立证明它退出，避免用短观察窗推断心跳冻结。
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','ignore']});setTimeout(()=>{},20000);`;
  const run = supervise([process.execPath, "-e", script]);
  let closed = false;
  void run.closed.then(() => { closed = true; });
  try {
    await waitFor(() => fs.existsSync(ready) && fs.existsSync(beats) && fs.statSync(beats).size > 0);
    assert.equal(JSON.parse(fs.readFileSync(ready, "utf8")).ppid, run.messages.find(message => message.type === "started")?.pid);
    const before = fs.statSync(beats).size;
    await waitFor(() => fs.statSync(beats).size > before);
    assert.ok(fs.statSync(beats).size > before, "停止前心跳确实增长");
    run.stop();
    await waitFor(() => run.messages.some(message => message.type === "stopped"));
    assert.equal(run.messages.at(-1)?.reaped, true, `${JSON.stringify(run.messages)} ${run.errors()}`);
    assert.equal(fs.readFileSync(termReceived, "utf8"), "TERM", "后代实际收到并忽略 TERM");
    const after = fs.statSync(beats).size;
    await waitFor(() => closed);
    assert.equal(fs.statSync(beats).size, after, "停止后心跳冻结");
  } finally {
    fs.writeFileSync(release, "release");
    await finish(run.child, run.closed);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Note: 见 .agents/notes/implemented/testing/2026-10-11-await-observed-async-phases.md
test("macOS 轮询漏记短命父亲后的新孤儿保留为未核实，且不向未知归属发信号", { skip: !available }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/rk-native-orphan-"));
  const beats = path.join(dir, "heartbeat");
  const pidFile = path.join(dir, "pid");
  const gate = path.join(dir, "go");
  const release = path.join(dir, "release");
  const finished = path.join(dir, "finished");
  const python = [
    "import os,time",
    "pid=os.fork()",
    "if pid == 0:",
    " os.setsid()",
    " end=time.monotonic()+20",
    " while os.getppid()!=1 and time.monotonic()<end: time.sleep(0.01)",
    " if os.getppid()!=1: os._exit(1)",
    ` open(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))`,
    ` output=open(${JSON.stringify(beats)},'a',buffering=1)`,
    ` while not os.path.exists(${JSON.stringify(release)}) and time.monotonic()<end:`,
    // 慢心跳检出固定短窗把调度延迟误判为退出的回归。
    "  output.write('beat\\n');time.sleep(0.5)",
    " output.close()",
    ` open(${JSON.stringify(finished)},'w').write('finished')`,
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
    await waitFor(() => fs.statSync(beats).size > before);
    assert.ok(fs.statSync(beats).size > before, "未知归属孤儿在返回后仍写心跳，没有被监督器误杀");
  } finally {
    fs.writeFileSync(release, "release");
    if (suspended) process.kill(run.child.pid!, "SIGCONT");
    await finish(run.child, run.closed);
    // 就绪身份已脱离父亲；只通过夹具文件释放并确认停止写入，不向裸 PID 发信号。
    if (fs.existsSync(pidFile)) await waitFor(() => fs.existsSync(finished));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
