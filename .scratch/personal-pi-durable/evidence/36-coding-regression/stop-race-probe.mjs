import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
const { ToolWorkerHost } = await import(pathToFileURL(process.argv[2]).href);
const outcomes = [];
for (const expectedFrame of [true, false, null]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit;
  let frameDelivered = false;
  const unit = {
    entry: { kind: "process_group", id: "123456", label: "memory-only delayed stopped frame", stop: async () => true },
    stdin: new Writable({ write(chunk, encoding, callback) {
      if (JSON.parse(chunk.toString()).type === "shutdown") {
        exit({ code: 0, signal: null });
        setImmediate(() => {
          if (expectedFrame !== null) {
            frameDelivered = true;
            stdout.write(JSON.stringify({ type: "stopped", reaped: expectedFrame }) + "\n");
          }
          stdout.end();
        });
      }
      callback();
    }}),
    stdout, stderr,
    exit: new Promise(resolve => { exit = resolve; }),
  };
  const host = await ToolWorkerHost.start({ kind: "local", async launch() {
    setImmediate(() => stdout.write(JSON.stringify({ type: "ready", pid: 123456 }) + "\n"));
    return unit;
  }}, { taskId: "memory-only", mode: "full_access", workspace: process.cwd(), grantedPaths: [] });
  const initial = await host.stop();
  await new Promise(resolve => setImmediate(resolve));
  const repeated = await host.stop();
  assert.equal(frameDelivered, expectedFrame !== null);
  assert.equal(initial, expectedFrame === true, "完整停止证明经 stdout 迟到仍应被消费");
  assert.equal(repeated, expectedFrame === true);
  if (expectedFrame !== true) assert.equal(host.stopFailure?.code, "worker_stop_unverified");
  outcomes.push({ frame: expectedFrame, initial, frameDelivered, repeated, code: host.stopFailure?.code });
}
process.stdout.write(JSON.stringify({ source: process.argv[2], outcomes }) + "\n");
