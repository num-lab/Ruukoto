import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { acquireInstanceLock, InstanceLockError, probeLockHolder } from "@ruukoto/core/instance-lock.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-"));
  const lockDir = path.join(root, "runtime.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  return { root, lockDir, ownerFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("实例锁以真实启动身份核实当前进程，不依赖检出名；只读探测和重复获取不改写 owner", () => {
  const f = fixture();
  const held = acquireInstanceLock(f.root);
  try {
    const owner = fs.readFileSync(f.ownerFile, "utf8");
    assert.equal(typeof JSON.parse(owner).processIdentity, "string", "新锁登记不可变的进程启动标识");
    assert.equal(probeLockHolder(f.lockDir).held, true);
    assert.throws(() => acquireInstanceLock(f.root), InstanceLockError);
    assert.equal(fs.readFileSync(f.ownerFile, "utf8"), owner, "只读探测和拒绝竞争都保留原始锁");
  } finally {
    held.release();
    f.cleanup();
  }
});

test("真实子进程改名后仍持锁，退出后允许接管", { timeout: 10_000 }, async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module"], {
    cwd: new URL("../", import.meta.url), stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("locked\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`子进程未完成持锁：${code} ${stderr}`)));
  });
  child.stdin.end(`
    const { acquireInstanceLock } = await import(${JSON.stringify(new URL("../packages/core/src/instance-lock.ts", import.meta.url).href)});
    process.title = "hold(er) name";
    acquireInstanceLock(${JSON.stringify(f.root)});
    process.title = "changed (name)";
    process.stdout.write("locked\\n");
    setInterval(() => {}, 1000);
  `);
  try {
    await ready;
    const owner = fs.readFileSync(f.ownerFile, "utf8");
    const probe = probeLockHolder(f.lockDir);
    assert.equal(probe.held, true, "进程标题改变不代表 PID 被回收");
    assert.equal(probe.unverifiable, false);
    assert.equal(probe.pid, child.pid);
    assert.throws(() => acquireInstanceLock(f.root), InstanceLockError);
    assert.equal(fs.readFileSync(f.ownerFile, "utf8"), owner);
    child.kill();
    await exited;
    assert.equal(probeLockHolder(f.lockDir).held, false, "已退出进程的锁可接管");
    const taken = acquireInstanceLock(f.root);
    assert.equal(JSON.parse(fs.readFileSync(f.ownerFile, "utf8")).pid, process.pid);
    taken.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => {});
    f.cleanup();
  }
});

test("相同 PID 的启动标识不同表示遗留锁，损坏的新身份保持待核实", () => {
  const f = fixture();
  let held = acquireInstanceLock(f.root);
  try {
    const owner = JSON.parse(fs.readFileSync(f.ownerFile, "utf8"));
    const original = owner.processIdentity;
    owner.processIdentity = process.platform === "linux"
      ? original.replace(/:\d+$/, ":0")
      : "darwin:Thu Jan  1 00:00:00 1970";
    fs.writeFileSync(f.ownerFile, JSON.stringify(owner));
    assert.equal(probeLockHolder(f.lockDir).held, false, "合法但不匹配的启动标识可证明 PID 已复用");
    held = acquireInstanceLock(f.root);
    for (const pid of [0, -1, 1.5]) {
      fs.writeFileSync(f.ownerFile, JSON.stringify({ ...owner, pid, processIdentity: original }));
      assert.equal(probeLockHolder(f.lockDir).held, false, "无效 PID 按损坏 owner 处理，不探测进程组");
      held = acquireInstanceLock(f.root);
    }
    for (const invalid of [null, "", "invalid", "darwin:0", "darwin:1", "darwin:Sun Feb 30 00:00:00 2025", "linux:------------------------------------:1", { start: "unknown" }]) {
      fs.writeFileSync(f.ownerFile, JSON.stringify({ ...owner, processIdentity: invalid }));
      const probe = probeLockHolder(f.lockDir);
      assert.equal(probe.held, true);
      assert.equal(probe.unverifiable, true, "损坏的新字段不退回旧命名启发式");
      assert.throws(() => acquireInstanceLock(f.root), (error: any) => error instanceof InstanceLockError && error.unverifiable);
    }
  } finally {
    held.release();
    f.cleanup();
  }
});

test("旧 owner 沿命令兼容核实；ps 不可用保留锁，身份采集失败不创建新锁", (ctx) => {
  const f = fixture();
  const held = acquireInstanceLock(f.root);
  const owner = JSON.parse(fs.readFileSync(f.ownerFile, "utf8"));
  const currentOwner = fs.readFileSync(f.ownerFile, "utf8");
  delete owner.processIdentity;
  fs.writeFileSync(f.ownerFile, JSON.stringify(owner));
  const realExec = childProcess.execFileSync;
  let unavailable = false;
  const ps = ctx.mock.method(childProcess, "execFileSync", (...args: any[]) => {
    if (args[0] === "ps") {
      if (unavailable) throw new Error("ps unavailable");
      if (args[1].includes("command=")) return "node /fixture/cli.ts server\n";
    }
    return Reflect.apply(realExec, childProcess, args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(probeLockHolder(f.lockDir).held, true, "升级前的活 CLI 实例保持持锁");
    assert.throws(() => acquireInstanceLock(f.root), (error: any) => error instanceof InstanceLockError && !error.unverifiable);
    unavailable = true;
    const before = fs.readFileSync(f.ownerFile, "utf8");
    assert.equal(probeLockHolder(f.lockDir).unverifiable, true);
    assert.throws(() => acquireInstanceLock(f.root), (error: any) => error instanceof InstanceLockError && error.unverifiable);
    assert.equal(fs.readFileSync(f.ownerFile, "utf8"), before);
    fs.writeFileSync(f.ownerFile, currentOwner);
    if (process.platform === "linux") {
      const read = fs.readFileSync;
      let missingFields = true;
      const proc = ctx.mock.method(fs, "readFileSync", (...args: any[]) => {
        if (String(args[0]).startsWith("/proc/")) {
          if (!missingFields) throw new Error("proc unavailable");
          if (String(args[0]).endsWith("/stat")) return `${process.pid} (incomplete (title)) R 1 2\n`;
        }
        return Reflect.apply(read, fs, args);
      });
      syncBuiltinESMExports();
      try {
        const fresh = path.join(f.root, "fresh");
        fs.mkdirSync(fresh);
        assert.throws(() => acquireInstanceLock(fresh), (error: any) => error instanceof InstanceLockError && error.unverifiable);
        assert.equal(fs.existsSync(path.join(fresh, "runtime.lock")), false, "采集失败在 mkdir 锁之前返回");
        missingFields = false;
        assert.equal(probeLockHolder(f.lockDir).unverifiable, true, "已有新身份无法核实时保留持锁");
        assert.throws(() => acquireInstanceLock(f.root), (error: any) => error instanceof InstanceLockError && error.unverifiable);
        assert.equal(fs.readFileSync(f.ownerFile, "utf8"), currentOwner);
      } finally {
        proc.mock.restore();
        syncBuiltinESMExports();
      }
    } else {
      assert.equal(probeLockHolder(f.lockDir).unverifiable, true, "已有新身份无法核实时保留持锁");
      assert.throws(() => acquireInstanceLock(f.root), (error: any) => error instanceof InstanceLockError && error.unverifiable);
      assert.equal(fs.readFileSync(f.ownerFile, "utf8"), currentOwner);
      const fresh = path.join(f.root, "fresh");
      fs.mkdirSync(fresh);
      assert.throws(() => acquireInstanceLock(fresh), (error: any) => error instanceof InstanceLockError && error.unverifiable);
      assert.equal(fs.existsSync(path.join(fresh, "runtime.lock")), false);
    }
  } finally {
    ps.mock.restore();
    syncBuiltinESMExports();
    held.release();
    f.cleanup();
  }
});
