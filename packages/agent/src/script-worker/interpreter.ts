/// <reference lib="dom" />
// Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-script-isolation.md
import * as fs from "node:fs";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { SCRIPT_LIMITS, ScriptExecutionError, isScriptCall, type ScriptCall, type ScriptRequest } from "./protocol.ts";

export async function createScriptInterpreter(wasmPath: URL, emit: (call: ScriptCall) => void) {
  const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(variant, {
    wasmBinary: Uint8Array.from(fs.readFileSync(wasmPath)).buffer,
    wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 1024 }),
  }));
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(SCRIPT_LIMITS.memoryBytes);
  runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
  runtime.removeModuleLoader();
  const context = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  let main: QuickJSHandle | undefined;
  let deadline = 0, cpuMs = SCRIPT_LIMITS.cpuMs as number;
  let interrupted = false;
  let failure: ScriptExecutionError | undefined;
  let progressCount = 0, progressBytes = 0, nextId = 0;
  runtime.setInterruptHandler(() => {
    interrupted ||= Date.now() >= deadline;
    return interrupted;
  });

  const unwrap = (result: ReturnType<typeof context.evalCode>): QuickJSHandle => {
    if (result.error) {
      result.error.dispose();
      throw failure ?? new ScriptExecutionError(interrupted ? "script_cpu_limit" : "script_error");
    }
    return result.value;
  };
  const evaluate = (code: string) => unwrap(context.evalCode(code, "workflow.js", { type: "global" }));
  const call = context.newFunction("__host", (method, payload) => {
    try {
      if (context.typeof(method) !== "string" || context.typeof(payload) !== "string") throw new ScriptExecutionError("script_invalid_call");
      const json = context.getString(payload);
      if (Buffer.byteLength(json) > SCRIPT_LIMITS.frameBytes) throw new ScriptExecutionError("script_frame_limit");
      const data: unknown = JSON.parse(json);
      const request = { ...(typeof data === "object" && data !== null ? data : {}), id: ++nextId, method: context.getString(method) };
      if (!isScriptCall(request)) throw new ScriptExecutionError("script_invalid_call");
      if (pending.size >= SCRIPT_LIMITS.pendingCalls) throw new ScriptExecutionError("script_pending_limit");
      if (request.method === "progress") {
        progressBytes += Buffer.byteLength(json);
        if (++progressCount > SCRIPT_LIMITS.progressCalls || progressBytes > SCRIPT_LIMITS.progressBytes) throw new ScriptExecutionError("script_progress_limit");
      }
      const deferred = context.newPromise();
      pending.set(request.id, deferred);
      emit(request);
      return deferred.handle;
    } catch (error) {
      failure = error instanceof ScriptExecutionError ? error : new ScriptExecutionError("script_invalid_call");
      return { error: context.newError(failure.code) };
    }
  });
  context.setProp(context.global, "__host", call);
  call.dispose();

  const advance = async (): Promise<{ done: boolean; value?: unknown }> => {
    let count = 0;
    while (runtime.hasPendingJob()) {
      if (Date.now() >= deadline) throw new ScriptExecutionError("script_cpu_limit");
      const jobs = runtime.executePendingJobs(1);
      if (jobs.error) {
        jobs.error.dispose();
        throw failure ?? new ScriptExecutionError(interrupted ? "script_cpu_limit" : "script_error");
      }
      if (++count % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (failure) throw failure;
    if (!main) throw new ScriptExecutionError("script_protocol");
    const state = context.getPromiseState(main);
    if (state.type === "pending") {
      if (pending.size === 0) throw new ScriptExecutionError("script_stalled");
      return { done: false };
    }
    if (state.type === "rejected") {
      state.error.dispose();
      throw failure ?? new ScriptExecutionError(interrupted ? "script_cpu_limit" : "script_error");
    }
    try {
      if (pending.size) throw new ScriptExecutionError("script_unawaited_calls");
      const stringify = evaluate("__encode");
      let encoded: QuickJSHandle;
      try { encoded = unwrap(context.callFunction(stringify, context.undefined, state.value)); }
      finally { stringify.dispose(); }
      try {
        const json = context.getString(encoded);
        if (Buffer.byteLength(json) > SCRIPT_LIMITS.frameBytes) throw new ScriptExecutionError("script_frame_limit");
        return { done: true, value: JSON.parse(json) as unknown };
      } finally { encoded.dispose(); }
    } finally { state.value.dispose(); }
  };

  return {
    async run(request: ScriptRequest) {
      interrupted = false;
      if (request.type === "start") cpuMs = request.cpuMs;
      deadline = Date.now() + cpuMs;
      if (request.type === "start") {
        if (main) throw new ScriptExecutionError("script_protocol");
        evaluate(`
          globalThis.Date = undefined;
          Math.random = undefined;
          const __parse = JSON.parse;
          const __stringify = JSON.stringify;
          const __encode = value => {
            const json = __stringify(value);
            if (json === undefined || json.length > ${SCRIPT_LIMITS.frameBytes}) throw new Error("script_frame_limit");
            return json;
          };
          (() => {
            const bridge = globalThis.__host;
            delete globalThis.__host;
            for (const name of ["agent", "ask", "integrate", "progress"]) {
              Object.defineProperty(globalThis, name, { value: (key, params) => bridge(name, __encode({key, params})) });
            }
          })();
        `).dispose();
        main = evaluate(`(async function(input) {\n${request.script}\n})(__parse(${JSON.stringify(JSON.stringify(request.input))}))`);
      } else {
        const deferred = pending.get(request.id);
        if (!deferred) throw new ScriptExecutionError("script_protocol");
        pending.delete(request.id);
        const value = request.error ? context.newError(request.error.code) : evaluate(`__parse(${JSON.stringify(JSON.stringify(request.value))})`);
        try {
          if (request.error) {
            const code = context.newString(request.error.code);
            try { context.setProp(value, "code", code); }
            finally { code.dispose(); }
            deferred.reject(value);
          }
          else deferred.resolve(value);
        } finally { value.dispose(); deferred.dispose(); }
      }
      return await advance();
    },
    dispose() {
      for (const deferred of pending.values()) deferred.dispose();
      pending.clear();
      main?.dispose();
      context.dispose();
      runtime.dispose();
    },
  };
}
