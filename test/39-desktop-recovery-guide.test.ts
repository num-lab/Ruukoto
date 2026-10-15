import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { socketLookupCommand } from "../apps/desktop/src/main/recovery.ts";

// 此用例只查本次创建的 socket，不占用全局进程夹具，保留普通并行分批。
test("macOS 人工恢复按控制 socket 定位：默认启动、同前缀目录与 A/B 错配", { skip: process.platform !== "darwin" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-guide '"));
  const children: ChildProcess[] = [];
  async function child(script: string, args: string[]) {
    const process = spawn(globalThis.process.execPath, ["-e", script, ...args], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(process);
    await once(process, "message");
    return process;
  }
  const server = 'require("node:net").createServer(()=>{}).listen(process.argv[1],()=>process.send("ready"))';
  const client = 'require("node:net").connect(process.argv[1],()=>process.send("ready"))';
  try {
    const socketA = path.join(dir, "control.sock");
    const socketB = path.join(dir, "other.sock");
    const a = await child(server, [socketA]);
    const connected = await child(client, [socketA]);
    const b = await child(server, [socketB, "server", "--data-dir", path.join(dir, "data-other")]);
    for (const scenario of ["默认目录", "同前缀目录", "dataDir 指向 B、controlDir 指向 A"]) {
      const output = execFileSync("/bin/sh", ["-c", socketLookupCommand(socketA)], { encoding: "utf8" });
      const pids = new Set(output.trim().split("\n").slice(1).map(line => Number(line.trim().split(/\s+/)[1])));
      assert.deepEqual([...pids], [a.pid], scenario);
      assert.ok(!pids.has(b.pid!));
      assert.ok(!pids.has(connected.pid!));
    }
  } finally {
    await Promise.all(children.map(async child => { if (child.exitCode !== null) return; const closed = once(child, "close"); child.kill("SIGTERM"); await closed; }));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
