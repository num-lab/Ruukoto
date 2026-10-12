import { createScriptInterpreter } from "./interpreter.ts";
import { ScriptWriter, readScriptFrames, isRecord, SCRIPT_LIMITS, ScriptExecutionError, type ScriptRequest } from "./protocol.ts";

const writer = new ScriptWriter(process.stdout);
let interpreter: Awaited<ReturnType<typeof createScriptInterpreter>> | undefined;
let finished = false;
let seq = 0;
let chain = Promise.resolve();
let queued = 0;

async function fatal(error: unknown) {
  if (finished) return;
  finished = true;
  const code = error instanceof ScriptExecutionError ? error.code : "script_worker_failed";
  try { await writer.send({ type: "fatal", code }); }
  catch { /* 宿主已断开时，退出进程仍回收 WASM。 */ }
  finally {
    // 异常中断可能留下 QuickJS 内部 Promise 循环；由进程退出回收整个 WASM。
    process.exit(1);
  }
}

function send(value: unknown) {
  void writer.send(value).catch(fatal);
}

try {
  interpreter = await createScriptInterpreter(new URL("./workflow-script.wasm", import.meta.url), call => send({ type: "call", call }));
  readScriptFrames(process.stdin, value => {
    if (finished) return;
    if (!isRecord(value) || value.seq !== seq + 1) throw new ScriptExecutionError("script_protocol");
    if (value.type === "start") {
      if (seq !== 0 || typeof value.script !== "string" || Buffer.byteLength(value.script) > SCRIPT_LIMITS.scriptBytes ||
          typeof value.cpuMs !== "number" || !Number.isInteger(value.cpuMs) || value.cpuMs <= 0 || value.cpuMs > SCRIPT_LIMITS.cpuMs || !("input" in value)) {
        throw new ScriptExecutionError("script_protocol");
      }
    } else if (value.type === "reply") {
      if (seq === 0 || !Number.isSafeInteger(value.id) || !("value" in value) ||
          (value.error !== undefined && (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string"))) {
        throw new ScriptExecutionError("script_protocol");
      }
    } else throw new ScriptExecutionError("script_protocol");
    seq++;
    if (++queued > SCRIPT_LIMITS.pendingCalls) throw new ScriptExecutionError("script_queue_limit");
    chain = chain.then(async () => {
      queued--;
      if (finished) return;
      const result = await interpreter!.run(value as ScriptRequest);
      if (result.done) {
        finished = true;
        void writer.send({ type: "done", value: result.value }).then(() => {
          interpreter!.dispose();
          process.stdin.destroy();
        }, error => { finished = false; void fatal(error); });
      } else send({ type: "idle", seq: value.seq });
    });
    void chain.catch(fatal);
  }, error => { void fatal(error); });
  send({ type: "ready" });
} catch (error) { await fatal(error); }
