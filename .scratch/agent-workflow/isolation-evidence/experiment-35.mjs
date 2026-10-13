// ../../../../../../private/tmp/ruukoto-script-isolation.AY4CGx/test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

// ../../../../../../private/tmp/ruukoto-script-isolation.AY4CGx/host.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// packages/agent/src/managed-processes.ts
import * as childProcess from "node:child_process";
async function processGroupAlive(pgid, timeoutMs) {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return error.code === "ESRCH" ? false : null;
  }
  return new Promise((resolve) => {
    childProcess.execFile("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      for (const line of stdout.trim().split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
        if (!match) {
          resolve(null);
          return;
        }
        if (Number(match[1]) === pgid && !match[2].startsWith("Z")) {
          resolve(true);
          return;
        }
      }
      resolve(false);
    });
  });
}
async function killProcessGroup(pgid, opts = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  const signalGroup = (signal) => {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (error) {
      return error.code === "ESRCH";
    }
  };
  const waitForExit = async (graceMs) => {
    const deadline = Date.now() + graceMs;
    do {
      const alive = await processGroupAlive(pgid, Math.max(1, Math.min(2e3, deadline - Date.now())));
      if (alive === false) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    } while (Date.now() < deadline);
    return false;
  };
  const termSignaled = signalGroup("SIGTERM");
  if (termSignaled && await waitForExit(opts.termGraceMs ?? 3e3)) return true;
  const killSignaled = signalGroup("SIGKILL");
  return killSignaled && await waitForExit(opts.killGraceMs ?? 3e3);
}

// packages/agent/src/execution/native.ts
import { fileURLToPath } from "node:url";

// packages/agent/src/execution/approved-ops.ts
var MAX_HTTP_RESPONSE_BYTES = 1024 * 1024;
var MAX_FILE_CONTENT_BYTES = 8 * 1024 * 1024;

// packages/agent/src/execution/native.ts
var NATIVE_WORKER_PATH = fileURLToPath(new URL("../../../../worker/worker.mjs", import.meta.url));
var NATIVE_MACOS_HELPER_PATH = fileURLToPath(new URL("../../../../worker/native-macos-supervisor", import.meta.url));

// packages/agent/src/execution/launchers.ts
var ExecutionError = class extends Error {
  constructor(code, message, unit, reason, options) {
    super(message, options);
    this.unit = unit;
    this.reason = reason;
    this.code = code;
  }
  unit;
  reason;
  code;
};

// ../../../../../../private/tmp/ruukoto-script-isolation.AY4CGx/protocol.ts
var SCRIPT_LIMITS = {
  scriptBytes: 128 * 1024,
  frameBytes: 1024 * 1024,
  queuedBytes: 4 * 1024 * 1024,
  pendingCalls: 32,
  progressCalls: 256,
  progressBytes: 256 * 1024,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  cpuMs: 1e4
};
var ScriptExecutionError = class extends Error {
  constructor(code, options) {
    super(`\u5DE5\u4F5C\u6D41\u811A\u672C\u6267\u884C\u5931\u8D25\uFF1A${code}`, options);
    this.code = code;
  }
  code;
};
var ScriptCallError = class extends Error {
  constructor(code) {
    super(`\u5DE5\u4F5C\u6D41\u6B65\u9AA4\u62D2\u7EDD\uFF1A${code}`);
    this.code = code;
  }
  code;
};
function frame(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new ScriptExecutionError("script_value_invalid");
  }
  if (json === void 0 || Buffer.byteLength(json) > SCRIPT_LIMITS.frameBytes) throw new ScriptExecutionError("script_frame_limit");
  return Buffer.from(json + "\n");
}
var ScriptWriter = class {
  constructor(output) {
    this.output = output;
  }
  output;
  chain = Promise.resolve();
  bytes = 0;
  send(value) {
    const data = frame(value);
    if (this.bytes + data.length > SCRIPT_LIMITS.queuedBytes) throw new ScriptExecutionError("script_queue_limit");
    this.bytes += data.length;
    const write = this.chain.then(() => new Promise((resolve, reject) => {
      this.output.write(data, (error) => error ? reject(error) : resolve());
    }));
    this.chain = write.finally(() => {
      this.bytes -= data.length;
    });
    return this.chain;
  }
};
function readScriptFrames(input, receive, fail) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  input.on("data", (chunk) => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end === -1 ? chunk.length : end);
        if (buffer.length + part.length > SCRIPT_LIMITS.frameBytes) throw new ScriptExecutionError("script_frame_limit");
        buffer = Buffer.concat([buffer, part]);
        if (end === -1) break;
        let value;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
        } catch {
          throw new ScriptExecutionError("script_protocol");
        }
        buffer = Buffer.alloc(0);
        receive(value);
        offset = end + 1;
      }
    } catch (error) {
      failed = true;
      fail(error);
    }
  });
  input.on("error", fail);
  input.on("end", () => fail(new ScriptExecutionError(buffer.length ? "script_protocol" : "script_channel_closed")));
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isScriptCall(value) {
  return isRecord(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0 && typeof value.method === "string" && ["agent", "ask", "integrate", "progress"].includes(value.method) && typeof value.key === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.key) && "params" in value;
}

// ../../../../../../private/tmp/ruukoto-script-isolation.AY4CGx/host.ts
function launchScriptProcess(label) {
  const entry = fileURLToPath2(new URL("./workflow-script.mjs", import.meta.url));
  if (!fs.existsSync(entry)) return Promise.reject(new ScriptExecutionError("script_entry_missing"));
  const child = spawn(process.execPath, ["--max-old-space-size=64", entry], {
    cwd: fileURLToPath2(new URL("./", import.meta.url)),
    env: { LANG: "C.UTF-8" },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new ScriptExecutionError("script_launch_failed")));
    child.once("spawn", () => {
      const pid = child.pid;
      resolve({
        entry: {
          kind: "process_group",
          id: String(pid),
          label,
          stop: () => killProcessGroup(pid, { termGraceMs: 100, killGraceMs: 1e3 })
        },
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exit: new Promise((done) => child.once("close", (code, signal) => done({ code, signal })))
      });
    });
  });
}
var WorkflowScriptHost = class {
  constructor(label, launch = () => launchScriptProcess(label)) {
    this.label = label;
    this.launch = launch;
  }
  label;
  launch;
  launchPromise;
  unit;
  stopPromise;
  writer;
  stopped = false;
  started = false;
  rejectRun;
  timer;
  activeSince;
  usedMs = 0;
  seq = 0;
  cpuMs = SCRIPT_LIMITS.cpuMs;
  controller = new AbortController();
  calls = /* @__PURE__ */ new Set();
  lastId = 0;
  startingId = randomUUID();
  completed = false;
  stopFailure;
  output;
  /** 先登记此占位，再运行；实际单元身份在停止后仍可查。 */
  entry() {
    return { kind: "starting", id: this.startingId, label: this.label, stop: () => this.stop() };
  }
  identity() {
    return this.unit?.entry;
  }
  fail(error) {
    if (this.completed && error instanceof ScriptExecutionError && error.code === "script_channel_closed") return;
    this.rejectRun?.(error);
    void this.stop();
  }
  armTimer() {
    clearTimeout(this.timer);
    if (this.activeSince === void 0) this.activeSince = performance.now();
    const remaining = this.cpuMs - this.usedMs - (performance.now() - this.activeSince);
    this.timer = setTimeout(() => this.fail(new ScriptExecutionError("script_cpu_limit")), Math.max(1, remaining));
  }
  send(request) {
    if (this.stopped) return;
    this.armTimer();
    try {
      void this.writer.send(request).catch((error) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }
  async run(script, input, invoke, options = {}) {
    if (this.started || this.stopped) throw new ScriptExecutionError("script_stopped");
    if (typeof script !== "string" || Buffer.byteLength(script) > SCRIPT_LIMITS.scriptBytes) throw new ScriptExecutionError("script_source_limit");
    this.cpuMs = options.cpuMs ?? SCRIPT_LIMITS.cpuMs;
    if (!Number.isInteger(this.cpuMs) || this.cpuMs <= 0 || this.cpuMs > SCRIPT_LIMITS.cpuMs) throw new ScriptExecutionError("script_invalid_limit");
    const start = { type: "start", seq: 1, script, input, cpuMs: this.cpuMs };
    frame(start);
    this.started = true;
    const onAbort = () => this.fail(new ScriptExecutionError("script_canceled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let resolveRun;
    const result = new Promise((resolve, reject) => {
      resolveRun = resolve;
      this.rejectRun = reject;
    });
    void result.catch(() => void 0);
    this.timer = setTimeout(() => this.fail(new ScriptExecutionError("script_start_timeout")), 1e4);
    if (options.signal?.aborted) onAbort();
    try {
      if (!this.stopped) {
        this.launchPromise = this.launch();
        try {
          this.unit = await this.launchPromise;
        } catch (error) {
          if (error instanceof ExecutionError && error.unit) this.unit = error.unit;
          throw error;
        }
        if (!this.stopped) {
          this.writer = new ScriptWriter(this.unit.stdin);
          this.unit.stdin.on("error", (error) => this.fail(error));
          let stderrBytes = 0;
          this.unit.stderr.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes > SCRIPT_LIMITS.progressBytes) this.fail(new ScriptExecutionError("script_stderr_limit"));
          });
          this.unit.exit.then((status) => {
            if (this.completed && status.code === 0 && status.signal === null) resolveRun(this.output);
            else this.fail(new ScriptExecutionError("script_exited"));
          }, (error) => this.fail(error));
          let ready = false;
          readScriptFrames(this.unit.stdout, (value2) => {
            if (this.stopped) return;
            if (!isRecord(value2)) throw new ScriptExecutionError("script_protocol");
            if (this.completed) throw new ScriptExecutionError("script_protocol");
            if (value2.type === "ready" && !ready) {
              ready = true;
              this.seq = 1;
              this.send(start);
            } else if (value2.type === "call" && ready && isScriptCall(value2.call)) {
              const call = value2.call;
              if (call.id !== this.lastId + 1 || this.calls.size >= SCRIPT_LIMITS.pendingCalls) throw new ScriptExecutionError("script_protocol");
              this.lastId = call.id;
              this.calls.add(call.id);
              void Promise.resolve().then(() => {
                if (this.stopped) return;
                return invoke(call, this.controller.signal);
              }).then((reply) => {
                if (this.stopped) return;
                this.calls.delete(call.id);
                this.send({ type: "reply", seq: ++this.seq, id: call.id, value: reply });
              }, (error) => {
                if (this.stopped) return;
                this.calls.delete(call.id);
                if (!(error instanceof ScriptCallError)) {
                  this.fail(error instanceof ScriptExecutionError ? error : new ScriptExecutionError("script_host_failed", { cause: error }));
                  return;
                }
                this.send({ type: "reply", seq: ++this.seq, id: call.id, value: null, error: { code: error.code, message: error.message } });
              });
            } else if (value2.type === "idle" && ready && Number.isSafeInteger(value2.seq) && Number(value2.seq) <= this.seq && Number(value2.seq) > 0) {
              if (value2.seq === this.seq && this.activeSince !== void 0) {
                if (this.calls.size === 0) throw new ScriptExecutionError("script_protocol");
                this.usedMs += performance.now() - this.activeSince;
                this.activeSince = void 0;
                clearTimeout(this.timer);
              }
            } else if (value2.type === "done" && ready && "value" in value2 && this.calls.size === 0) {
              this.output = value2.value;
              this.completed = true;
              this.armTimer();
            } else if (value2.type === "fatal" && typeof value2.code === "string") throw new ScriptExecutionError(value2.code);
            else throw new ScriptExecutionError("script_protocol");
          }, (error) => this.fail(error));
        }
      }
      const value = await result;
      const reaped = await this.stop();
      if (!reaped) throw this.stopFailure;
      return { value, reaped };
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(this.timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.rejectRun = void 0;
    }
  }
  /** 重复停止共享核实结果；false 保留单元身份与失败原因。 */
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller.abort();
    this.rejectRun?.(new ScriptExecutionError("script_stopped"));
    this.stopPromise = (async () => {
      if (!this.unit && this.launchPromise) {
        try {
          this.unit = await this.launchPromise;
        } catch (error) {
          if (error instanceof ExecutionError && error.unit) this.unit = error.unit;
          else return true;
        }
      }
      if (!this.unit) return true;
      this.unit.stdin.destroy();
      const reaped = await this.unit.entry.stop();
      if (!reaped) this.stopFailure = new ScriptExecutionError("script_stop_unverified");
      return reaped;
    })().catch((error) => {
      this.stopFailure = new ScriptExecutionError("script_stop_unverified", { cause: error });
      process.stderr.write(`[ruukoto:workflow-script] stop=script_stop_unverified\uFF1B\u9000\u51FA\u672A\u6838\u5B9E\uFF0C\u4FDD\u7559\u6267\u884C\u8EAB\u4EFD
`);
      return false;
    });
    return this.stopPromise;
  }
};

// ../../../../../../private/tmp/ruukoto-script-isolation.AY4CGx/test.ts
var fake = async (call) => call.params;
function run(script, input = null, invoke = fake, options = {}) {
  const host = new WorkflowScriptHost("fake-workflow");
  return { host, result: host.run(script, input, invoke, options) };
}
test("\u540C\u6B65 WASM \u652F\u6301\u4E32\u884C\u3001\u5E76\u53D1\u3001\u5206\u652F\u548C\u5FAA\u73AF\uFF0C\u56DB\u79CD\u539F\u8BED\u4EC5\u4F20 JSON", async () => {
  const { host, result } = run(`
    const a = await agent("first", input);
    const values = await Promise.all([agent("a", 2), ask("b", 3)]);
    let sum = a;
    for (const value of values) { if (value > 0) sum += value; }
    await progress("progress", {sum});
    return await integrate("merge", {sum});
  `, 1);
  assert.deepEqual(await result, { value: { sum: 6 }, reaped: true });
  assert.equal(await host.stop(), true);
  assert.ok(host.identity()?.id);
});
test("\u5BBF\u4E3B\u62D2\u7EDD\u4E3A\u89E3\u91CA\u5668\u5185\u9519\u8BEF\uFF0C\u5176\u4ED6\u5206\u652F\u7EE7\u7EED", async () => {
  const { result } = run(`
    const bad = agent("bad", {}).catch(error => error.code);
    const good = agent("good", {ok:true});
    return await Promise.all([bad, good]);
  `, null, async (call) => {
    if ("key" in call && call.key === "bad") throw new ScriptCallError("fake_rejected");
    return call.params;
  });
  assert.deepEqual((await result).value, ["fake_rejected", { ok: true }]);
});
test("\u811A\u672C\u6CA1\u6709 Node\u3001\u6587\u4EF6\u3001\u7F51\u7EDC\u3001\u51ED\u636E\u3001\u65F6\u949F\u3001\u968F\u673A\u6570\u548C\u5B9A\u65F6\u5668", async () => {
  const { result } = run(`return [typeof process, typeof require, typeof Buffer, typeof fetch, typeof XMLHttpRequest, typeof WebAssembly, typeof Date, typeof Math.random, typeof setTimeout, agent.constructor("return typeof process")(), typeof __host];`);
  assert.deepEqual((await result).value, Array(11).fill("undefined"));
});
for (const [name, script] of [
  ["\u9759\u6001\u6A21\u5757", `import x from "node:fs"; return x;`],
  ["\u52A8\u6001\u6A21\u5757", `return await import("node:fs");`],
  ["\u8BED\u6CD5", `return (;`],
  ["\u8C03\u7528\u53C2\u6570", `try { await agent("", {}); } catch {} return 1;`],
  ["\u672A\u7B49\u5F85\u5DE5\u4F5C", `agent("lost", {}); return 1;`],
  ["\u60AC\u7A7A Promise", `return await new Promise(() => {});`],
  ["\u7EAF\u8BA1\u7B97", `for (;;) {}`],
  ["\u5FAE\u4EFB\u52A1", `return await new Promise(() => { function loop() { Promise.resolve().then(loop); } loop(); });`],
  ["\u957F\u5185\u5EFA", `return new Array(1e9) + "";`],
  ["\u5185\u5B58", `const a=[]; for (;;) a.push(new Array(10000).fill("memory"));`],
  ["\u6808", `function recur() { return recur(); } return recur();`],
  ["\u8F93\u51FA", `return "x".repeat(2 * 1024 * 1024);`],
  ["\u5E76\u53D1\u8BF7\u6C42", `return await Promise.all(Array.from({length: 33}, (_,i) => agent("p"+i, {})));`],
  ["\u65E5\u5FD7", `for (let i=0; i<257; i++) await progress("p"+i, {}); return 1;`]
]) {
  test(`${name}\u6545\u610F\u5931\u8D25\u540E\uFF0C\u8FDB\u7A0B\u5DF2\u56DE\u6536`, async () => {
    const { host, result } = run(script, null, async (call) => {
      if (name === "\u5E76\u53D1\u8BF7\u6C42" || name === "\u672A\u7B49\u5F85\u5DE5\u4F5C") return await new Promise(() => {
      });
      return call.params;
    }, { cpuMs: 500 });
    await assert.rejects(result, (error) => error instanceof ScriptExecutionError);
    assert.equal(await host.stop(), true);
    assert.ok(host.identity());
  });
}
test("\u7B49\u5F85\u5BBF\u4E3B\u4E0D\u8017\u811A\u672C\u9884\u7B97\uFF0C\u53D6\u6D88\u540E\u8FDF\u5230\u7ED3\u679C\u4E0D\u80FD\u7EE7\u7EED\u811A\u672C", async () => {
  const controller = new AbortController();
  let resolve;
  let arrived;
  const called = new Promise((done) => {
    arrived = done;
  });
  let calls = 0;
  const { host, result } = run(`await ask("q", {}); return await agent("late", {});`, null, async () => {
    calls++;
    arrived();
    return await new Promise((done) => {
      resolve = done;
    });
  }, { signal: controller.signal, cpuMs: 100 });
  await called;
  await new Promise((done) => setTimeout(done, 150));
  controller.abort();
  await assert.rejects(result, { code: "script_canceled" });
  resolve(1);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(calls, 1);
  assert.equal(await host.stop(), true);
});
test("\u542F\u52A8\u524D\u53D6\u6D88\u4E0D\u521B\u5EFA\u8FDB\u7A0B", async () => {
  let launches = 0;
  const host = new WorkflowScriptHost("early", async () => {
    launches++;
    throw new Error("unexpected");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(host.run("return 1", null, fake, { signal: controller.signal }), { code: "script_canceled" });
  assert.equal(launches, 0);
  assert.equal(await host.stop(), true);
});
test("\u5355\u5E27 UTF-8 \u5B57\u8282\u53CA\u65E0\u6362\u884C\u7F13\u51B2\u6709\u754C\uFF0C\u975E\u6CD5 JSON \u4E0D\u88AB\u5FFD\u7565", () => {
  for (const data of [Buffer.alloc(SCRIPT_LIMITS.frameBytes + 1, 120), Buffer.from("oops\n")]) {
    const stream = new PassThrough();
    let failure;
    readScriptFrames(stream, () => assert.fail("unexpected"), (error) => {
      failure = error;
    });
    stream.write(data);
    assert.ok(failure instanceof ScriptExecutionError);
  }
});
test("\u80CC\u538B\u963B\u585E\u65F6\uFF0C\u8F93\u51FA\u961F\u5217\u5230\u9650\u660E\u786E\u62D2\u7EDD", async () => {
  const output = new Writable({ write() {
  } });
  const writer = new ScriptWriter(output);
  const writes = [];
  for (let i = 0; i < 4; i++) writes.push(writer.send("x".repeat(SCRIPT_LIMITS.frameBytes - 3)));
  assert.throws(() => writer.send("x".repeat(SCRIPT_LIMITS.frameBytes - 3)), { code: "script_queue_limit" });
  for (const write of writes) void write.catch(() => void 0);
  output.destroy(new Error("closed"));
  output.on("error", () => void 0);
});
test("\u8D85\u5927\u8F93\u5165\u4E0E\u811A\u672C\u5728\u542F\u52A8\u524D\u62D2\u7EDD", async () => {
  const { host, result } = run("return input", "x".repeat(SCRIPT_LIMITS.frameBytes));
  await assert.rejects(result, { code: "script_frame_limit" });
  assert.equal(host.identity(), void 0);
  await assert.rejects(run("x".repeat(SCRIPT_LIMITS.scriptBytes + 1)).result, { code: "script_source_limit" });
});
test("JSON __proto__ \u5728\u5165\u53C2\u548C\u8FD4\u56DE\u4E2D\u4FDD\u6301\u666E\u901A\u5B57\u6BB5", async () => {
  const value = JSON.parse('{"__proto__":{"inherited":"unexpected"},"ok":true}');
  const { result } = run(`
    const reply = await agent("json", input);
    return [Object.keys(input), input.inherited === undefined, Object.keys(reply), reply.inherited === undefined, reply];
  `, value);
  assert.deepEqual((await result).value, [["__proto__", "ok"], true, ["__proto__", "ok"], true, value]);
  assert.equal(isScriptCall({ id: 1, method: ["agent"], key: "a", params: null }), false);
});
test("\u811A\u672C\u6539\u5199\u5168\u5C40 JSON \u548C Promise \u4E0D\u5F71\u54CD\u5BBF\u4E3B\u8F6C\u6362\u53CA\u63A8\u8FDB", async () => {
  const { result } = run(`
    JSON.parse = () => ({bad:true}); JSON.stringify = () => "false";
    const reply = await agent("x", {ok:true});
    Promise.resolve = () => { throw new Error("replaced"); };
    return reply;
  `);
  assert.deepEqual((await result).value, { ok: true });
});
test("\u89E3\u91CA\u5668\u5185\u5B58\u548C\u6808\u5206\u522B\u62D2\u7EDD\u5206\u914D\u4E0E\u9012\u5F52\uFF0C\u4E0D\u501F\u8BA1\u65F6\u5931\u8D25\u4EE3\u66FF", async () => {
  const memory = await run(`try { return new Array(10000000).fill(1).length; } catch(error) { return error.name; }`).result;
  const stack = await run(`try { function recur(){ return recur(); } recur(); } catch(error) { return error.name; }`).result;
  assert.equal(memory.value, "InternalError");
  assert.equal(stack.value, "InternalError");
});
function controlled(outcome, messages, launchError = false, exitCode = 0) {
  const stdout = new PassThrough();
  let stops = 0;
  let finish;
  const unit = {
    entry: { kind: "process_group", id: "fake", label: "fake", async stop() {
      stops++;
      finish();
      if (outcome === "throws") throw new Error("query failed");
      return outcome;
    } },
    stdin: new Writable({ write(_chunk, _encoding, callback) {
      callback();
      setImmediate(() => {
        for (const value of messages) stdout.write(JSON.stringify(value) + "\n");
        if (messages.some((value) => typeof value === "object" && value !== null && "type" in value && value.type === "done")) finish();
      });
    } }),
    stdout,
    stderr: new PassThrough(),
    exit: new Promise((resolve) => {
      finish = () => resolve({ code: exitCode, signal: null });
    })
  };
  const launch = async () => {
    if (launchError) throw new ExecutionError("fake_launch_failed", "fake", unit);
    setImmediate(() => stdout.write('{"type":"ready"}\n'));
    return unit;
  };
  return { unit, launch, stops: () => stops };
}
for (const outcome of [false, "throws"]) {
  test(`\u7ED3\u679C\u4FDD\u7559\uFF0C\u505C\u6B62\u672A\u6838\u5B9E\u53CA\u91CD\u590D\u505C\u6B62\u4E0D\u53D8\uFF1A${outcome}`, async () => {
    const fake2 = controlled(outcome, [{ type: "done", value: 42 }]);
    const host = new WorkflowScriptHost("unverified", fake2.launch);
    await assert.rejects(host.run("return 42", null, async () => null), { code: "script_stop_unverified" });
    assert.equal(host.output, 42);
    assert.equal(host.identity()?.id, "fake");
    assert.deepEqual(await Promise.all([host.stop(), host.stop()]), [false, false]);
    assert.equal(fake2.stops(), 1);
  });
}
test("\u5DF2\u521B\u5EFA\u5355\u5143\u540E\u7684\u542F\u52A8\u5931\u8D25\u4ECD\u505C\u6B62\u4E14\u4FDD\u7559\u672A\u6838\u5B9E\u8EAB\u4EFD", async () => {
  const fake2 = controlled(false, [], true);
  const host = new WorkflowScriptHost("launch-failed", fake2.launch);
  await assert.rejects(host.run("return 1", null, async () => null), { code: "fake_launch_failed" });
  assert.equal(await host.stop(), false);
  assert.equal(host.identity()?.id, "fake");
  assert.equal(fake2.stops(), 1);
});
test("\u542F\u52A8\u671F\u95F4\u53D6\u6D88\u8986\u76D6\u8FDF\u5230\u5355\u5143", async () => {
  const fake2 = controlled(true, []);
  let release;
  const host = new WorkflowScriptHost("late-launch", () => new Promise((resolve) => {
    release = resolve;
  }));
  const controller = new AbortController();
  const result = host.run("return 1", null, async () => null, { signal: controller.signal });
  controller.abort();
  release(fake2.unit);
  await assert.rejects(result, { code: "script_canceled" });
  assert.equal(await host.stop(), true);
  assert.equal(fake2.stops(), 1);
});
test("\u96F6\u8BF7\u6C42\u7684 idle \u4E0E\u635F\u574F\u534F\u8BAE\u505C\u6B62\u8FDB\u7A0B\uFF0C\u4E0D\u6267\u884C\u540C\u5E27\u8FDF\u5230\u8BF7\u6C42", async () => {
  for (const messages of [
    [{ type: "idle", seq: 1 }],
    [{ type: "unknown" }, { type: "call", call: { id: 1, method: "agent", key: "late", params: null } }],
    [{ type: "done", value: 1 }, { type: "fatal", code: "script_protocol" }]
  ]) {
    const fake2 = controlled(true, messages);
    const host = new WorkflowScriptHost("bad-protocol", fake2.launch);
    let calls = 0;
    await assert.rejects(host.run("return 1", null, async () => {
      calls++;
      return null;
    }), { code: "script_protocol" });
    assert.equal(calls, 0);
    assert.equal(await host.stop(), true);
  }
});
test("\u540C\u540D\u8FD0\u884C\u7684\u542F\u52A8\u5360\u4F4D\u4E0D\u8986\u76D6", () => {
  assert.notEqual(new WorkflowScriptHost("same").entry().id, new WorkflowScriptHost("same").entry().id);
});
test("\u7ED3\u679C\u5DF2\u5230\u4F46\u8FDB\u7A0B\u5F02\u5E38\u9000\u51FA\u4FDD\u7559\u7ED3\u679C\u5E76\u62A5\u5931\u8D25", async () => {
  const fake2 = controlled(true, [{ type: "done", value: 42 }], false, 1);
  const host = new WorkflowScriptHost("failed-exit", fake2.launch);
  await assert.rejects(host.run("return 42", null, async () => null), { code: "script_exited" });
  assert.equal(host.output, 42);
  assert.equal(await host.stop(), true);
});
test("\u6388\u6743\u62D2\u7EDD\u4E0D\u80FD\u88AB\u811A\u672C catch \u53D8\u6210\u6210\u529F", async () => {
  const { host, result } = run(`try { await agent("denied", {}); } catch {} return 1;`, null, async () => {
    throw new ScriptExecutionError("access_denied");
  });
  await assert.rejects(result, { code: "access_denied" });
  assert.equal(await host.stop(), true);
});
test("\u8D85\u5927\u5BBF\u4E3B\u7ED3\u679C\u505C\u6B62\u8FDB\u7A0B\u4E14\u4E0D\u7EE7\u7EED\u4E0B\u4E00\u6B65\u9AA4", async () => {
  let calls = 0;
  const { host, result } = run(`await agent("large", {}); return await agent("late", {});`, null, async () => {
    calls++;
    return "x".repeat(SCRIPT_LIMITS.frameBytes);
  });
  await assert.rejects(result, { code: "script_frame_limit" });
  assert.equal(calls, 1);
  assert.equal(await host.stop(), true);
});
test("\u8F6C\u6362\u4E2D\u7684\u65E0\u9650 getter \u6216 toJSON \u4E5F\u88AB\u7236\u8FDB\u7A0B\u505C\u6B62", async () => {
  for (const script of [`return {toJSON(){for(;;){}}};`, `return await agent("getter", {get value(){for(;;){}}});`]) {
    const { host, result } = run(script, null, fake, { cpuMs: 100 });
    await assert.rejects(result, { code: "script_cpu_limit" });
    assert.equal(await host.stop(), true);
  }
});
