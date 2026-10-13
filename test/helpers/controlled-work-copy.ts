import { PassThrough, Writable } from "node:stream";
import type { LaunchedUnit, LaunchSpec, WorkerLauncher } from "@ruukoto/agent/execution/launchers.ts";
import type { WorkerRequest } from "@ruukoto/agent/tool-worker/protocol.ts";

/** 只模拟 worker 协议和停止结论，Git 文件变化由用例显式安排。 */
export function controlledWorkCopy(stop: () => Promise<boolean>, output: string, ready = true, automaticResult = true) {
  const stdout = new PassThrough();
  const requests: WorkerRequest[] = [];
  const specs: LaunchSpec[] = [];
  let finish!: (value: { code: number | null; signal: string | null }) => void;
  const reply = () => {
    const call = requests.find((request) => request.type === "tool_call");
    if (call?.type === "tool_call") stdout.write(JSON.stringify({ type: "result", opId: call.opId, ok: true, content: [{ type: "text", text: output }] }) + "\n");
  };
  const unit: LaunchedUnit = {
    entry: { kind: "systemd_unit", id: "controlled-work-copy", label: "模拟工作副本 worker", stop },
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()) as WorkerRequest;
      requests.push(request);
      if (request.type === "tool_call" && automaticResult) setImmediate(reply);
      if (request.type === "shutdown") finish({ code: 0, signal: null });
      callback();
    } }),
    stdout,
    stderr: new PassThrough(),
    exit: new Promise((resolve) => { finish = resolve; }),
  };
  const launcher: WorkerLauncher = { kind: "native", async launch(spec) {
    specs.push(spec);
    if (ready) setImmediate(() => stdout.write(JSON.stringify({ type: "ready", pid: 123 }) + "\n"));
    return unit;
  } };
  return { launcher, requests, specs, reply, finish: () => finish({ code: 0, signal: null }) };
}
