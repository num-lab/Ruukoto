import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireConfigLock, acquireInstanceLock, InstanceLockError, probeLockHolder, type AcquiredLock } from "@ruukoto/core/instance-lock.ts";

for (const [name, acquire] of [["instance", acquireInstanceLock], ["configuration", acquireConfigLock]] as const) {
  test(`${name}: a contender cannot share ownership before owner publication`, { timeout: 15_000 }, async (ctx) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-publication-"));
    const ready = path.join(root, "contender-ready");
    const originalWrite = fs.writeFileSync;
    let child: ChildProcess | undefined;
    let exited: Promise<unknown> | undefined;
    let intercepted = false;
    const write = ctx.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (!intercepted && String(args[0]).endsWith("owner.json")) {
        intercepted = true;
        child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
          import fs from 'node:fs';
          import { ${acquire.name} } from ${JSON.stringify(new URL("../packages/core/src/instance-lock.ts", import.meta.url).href)};
          ${acquire.name}(${JSON.stringify(root)});
          fs.writeFileSync(${JSON.stringify(ready)}, 'held');
          process.on('message', () => {});
        `], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "ignore", "ignore", "ipc"] });
        exited = once(child, "exit");
        const until = Date.now() + 10_000;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(pause, 0, 0, 10);
        assert.equal(fs.readFileSync(ready, "utf8"), "held", "the contender holds its lock while the first publisher is paused");
      }
      return originalWrite(...args);
    });
    syncBuiltinESMExports();
    let incorrectlyAcquired: AcquiredLock | undefined;
    try {
      assert.throws(() => { incorrectlyAcquired = acquire(root); }, InstanceLockError);
      assert.equal(intercepted, true);
      const lockPath = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
      assert.equal(probeLockHolder(lockPath).pid, child!.pid);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
      incorrectlyAcquired?.release();
      child?.kill();
      if (exited) await exited;
      const stale = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
      if (fs.existsSync(stale)) fs.chmodSync(stale, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${name}: ownerless and malformed legacy locks remain unverifiable`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-ownerless-"));
    const directory = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
    fs.mkdirSync(directory);
    try {
      for (const owner of [null, "{", JSON.stringify({ pid: 0 }), JSON.stringify({ pid: -1 })]) {
        if (owner !== null) fs.writeFileSync(path.join(directory, "owner.json"), owner);
        assert.equal(probeLockHolder(directory).unverifiable, true);
        assert.throws(() => acquire(root), (error: unknown) => error instanceof InstanceLockError && error.unverifiable);
        assert.equal(fs.existsSync(directory), true);
        if (owner !== null) assert.equal(fs.readFileSync(path.join(directory, "owner.json"), "utf8"), owner);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test(`${name}: releasing an old handle preserves its successor`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-successor-"));
    const first = acquire(root);
    try {
      first.release();
      const second = acquire(root);
      first.release();
      const lockPath = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
      assert.equal(probeLockHolder(lockPath).held, true);
      assert.throws(() => acquire(root), InstanceLockError);
      second.release();
      assert.equal(fs.existsSync(lockPath), false);
    } finally { first.release(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test(`${name}: atomic appearance after a missing snapshot is verified contention`, ctx => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-appearance-")));
    const lockPath = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
    const original = fs.lstatSync;
    let injected = false;
    let competitor: AcquiredLock | undefined;
    const stat = ctx.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      try { return original(...args); }
      catch (error) {
        if (!injected && String(args[0]) === lockPath) {
          injected = true;
          competitor = acquire(root);
        }
        throw error;
      }
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => acquire(root), (error: unknown) => error instanceof InstanceLockError && !error.unverifiable);
      assert.equal(injected, true);
      assert.equal(probeLockHolder(lockPath).held, true);
    } finally {
      stat.mock.restore(); syncBuiltinESMExports(); competitor?.release(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${name}: long CLI arguments never make a published owner unreadable`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-arguments-"));
    process.argv.push("x".repeat(40_000));
    let lock: AcquiredLock | undefined;
    try {
      lock = acquire(root);
      const lockPath = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
      assert.equal(probeLockHolder(lockPath).unverifiable, false);
      assert.throws(() => acquire(root), (error: unknown) => error instanceof InstanceLockError && !error.unverifiable);
      lock.release();
      assert.equal(fs.existsSync(lockPath), false);
    } finally { process.argv.pop(); lock?.release(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test(`${name}: delayed predecessor recursive takeover cannot remove the new owner`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-predecessor-"));
    const held = acquire(root);
    const lockPath = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
    try {
      const before = fs.readFileSync(path.join(lockPath, "owner.json"));
      assert.throws(() => { fs.rmSync(lockPath, { recursive: true, force: true }); fs.mkdirSync(lockPath); });
      assert.deepEqual(fs.readFileSync(path.join(lockPath, "owner.json")), before);
      assert.equal(probeLockHolder(lockPath).held, true);
    } finally { held.release(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test(`${name}: delayed predecessor owner publication cannot acquire over a new owner`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-delayed-owner-"));
    const held = acquire(root);
    const lockPath = path.join(root, name === "instance" ? "runtime.lock" : "config.lock");
    const owner = path.join(lockPath, "owner.json");
    let predecessorAcquired = false;
    try {
      const before = fs.readFileSync(owner);
      assert.throws(() => {
        fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, command: "old", startedAt: new Date().toISOString() }));
        predecessorAcquired = true;
      });
      assert.equal(predecessorAcquired, false);
      assert.deepEqual(fs.readFileSync(owner), before);
      assert.equal(probeLockHolder(lockPath).held, true);
    } finally { held.release(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  test(`${name}: a first release cannot remove a replaced lock inode`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-lock-replaced-"));
    const first = acquire(root);
    const lockPath = path.join(root, name === "instance" ? "runtime.lock" : "config.lock"), retired = path.join(root, "saved-lock");
    fs.renameSync(lockPath, retired);
    const second = acquire(root);
    try {
      const bytes = fs.readFileSync(path.join(lockPath, "owner.json"));
      first.release();
      assert.equal(probeLockHolder(lockPath).held, true);
      assert.deepEqual(fs.readFileSync(path.join(lockPath, "owner.json")), bytes);
    } finally { second.release(); fs.chmodSync(retired, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
