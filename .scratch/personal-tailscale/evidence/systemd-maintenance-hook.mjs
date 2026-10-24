import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// 只注入隔离容器的remote单元，在真实持久阶段后暂停或模拟进程崩溃。
const original = fs.renameSync;
const gate = "/var/lib/rktest/gate.json", observed = "/var/lib/rktest/observed.json";
fs.renameSync = function (source, destination) {
  original(source, destination);
  if (!String(destination).endsWith("/maintenance.json") || !fs.existsSync(gate)) return;
  const instruction = JSON.parse(fs.readFileSync(gate, "utf8"));
  const state = JSON.parse(fs.readFileSync(destination, "utf8")), receipt = state.receipts[instruction.id];
  if (!receipt || receipt.stage !== instruction.stage) return;
  fs.writeFileSync(observed, JSON.stringify({ id: receipt.id, stage: receipt.stage }), { mode: 0o600 });
  if (instruction.action === "crash") { fs.unlinkSync(gate); process.kill(process.pid, "SIGKILL"); return; }
  const deadline = Date.now() + 15_000;
  while (fs.existsSync(gate)) {
    if (Date.now() > deadline) throw new Error("probe_gate_timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
syncBuiltinESMExports();
