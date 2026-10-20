import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { launchLinuxExecution, stopLinuxExecution } from "./packages/agent/src/execution/native-linux-identity.ts";

const root = process.argv[3];
if (process.argv[2] === "owner") {
  const input = JSON.parse(fs.readFileSync(path.join(root, "input.json"), "utf8"));
  const unit = await launchLinuxExecution(path.join(root, "claims"), input.ref, input.prepared, input.spec);
  unit.stdout.resume(); unit.stderr.pipe(process.stderr);
  fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify({ scope: unit.entry.id, owner: process.pid }));
  setInterval(() => {}, 1000);
} else {
  const results = [];
  const machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
  const self = fileURLToPath(import.meta.url);
  const waitFor = async predicate => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("等待真实进程证据超时");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  for (const crash of [false, true]) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-native-22-")));
    const workspace = path.join(directory, "work"), tempDir = path.join(directory, "temp"), claims = path.join(directory, "claims");
    for (const dir of [workspace, tempDir, claims]) fs.mkdirSync(dir, { mode: 0o700 });
    const workerPath = path.join(directory, "worker.mjs");
    const heart = path.join(workspace, "heart");
    const python = `import os,time
os.setsid()
f=open(${JSON.stringify(heart)},'a',buffering=1)
while True:
 f.write('tick\\n');time.sleep(.02)
`;
    fs.writeFileSync(workerPath, `import {spawn} from 'node:child_process';
const python = ${JSON.stringify(python)};
spawn('/usr/bin/python3',['-I','-c',python],{stdio:'ignore'});
setInterval(()=>{},1000);
`);
    const ref = { executionId: `native_${randomBytes(12).toString("hex")}`, machineId };
    const nodePath = fs.realpathSync(process.execPath);
    const runtimeReadRoots = [...new Set(["/usr", "/bin", "/lib", "/lib64", nodePath, workerPath].filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)))];
    const prepared = { workspace, tempDir, env: { PATH: "/usr/bin:/bin", HOME: tempDir, TMPDIR: tempDir },
      mounts: [{ path: workspace, access: "read_write" }], runtimeReadRoots, toolAliases: [], nodePath, workerPath };
    const spec = { taskId: "real-native-identity", mode: "confirm", workspace, grantedPaths: [] };
    fs.writeFileSync(path.join(directory, "input.json"), JSON.stringify({ ref, prepared, spec }));
    const owner = spawn(process.execPath, ["--experimental-transform-types", self, "owner", directory], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; owner.stderr.on("data", data => { errors += data; }); owner.stdout.resume();
    const exit = new Promise(resolve => owner.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      await waitFor(() => fs.existsSync(path.join(directory, "ready.json")) || owner.exitCode !== null);
      assert.ok(fs.existsSync(path.join(directory, "ready.json")), errors);
      await waitFor(() => fs.existsSync(heart) && fs.statSync(heart).size > 20);
      const ready = JSON.parse(fs.readFileSync(path.join(directory, "ready.json"), "utf8"));
      const claimDir = path.join(claims, ref.executionId);
      const observed = JSON.parse(fs.readFileSync(path.join(claimDir, "observation.json"), "utf8"));
      assert.ok(fs.readFileSync(path.join(observed.group, "cgroup.events"), "utf8").includes("populated 1"));
      if (crash) { owner.kill("SIGKILL"); await exit; }
      const stopped = await stopLinuxExecution(claims, ref);
      assert.equal(stopped.exited, true, `${errors}\n${JSON.stringify(stopped)}`);
      const size = fs.statSync(heart).size;
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(fs.statSync(heart).size, size, "setsid 后代心跳须冻结");
      assert.equal((await stopLinuxExecution(claims, ref)).exited, true);
      await assert.rejects(launchLinuxExecution(claims, ref, prepared, spec));
      results.push({ crash, ref, scope: ready.scope, observation: observed, stopped: true, heartbeatBytes: size, ownerExit: crash ? await exit : null });
    } finally {
      owner.kill("SIGKILL"); await exit;
      const stopped = await stopLinuxExecution(claims, ref);
      assert.equal(stopped.exited, true, "清理必须先证明原执行退出");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  process.stdout.write(JSON.stringify({ platform: process.platform, node: process.version, results, cleaned: true }, null, 2) + "\n");
}
