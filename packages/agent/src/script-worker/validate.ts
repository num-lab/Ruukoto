/// <reference lib="dom" />
/** 与实际脚本相同的 QuickJS 包装只编译，不能调用任何步骤。
 * Note: 见 .agents/notes/implemented/feature/2026-10-13-workflow-library-and-controls.md
 */
import * as fs from "node:fs";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { WORKFLOW_LIMITS, WorkflowError } from "@ruukoto/core/workflow.ts";
import { SCRIPT_LIMITS } from "./protocol.ts";

let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;

export async function validateWorkflowScript(script: string): Promise<void> {
  if (typeof script !== "string" || !script.trim() || Buffer.byteLength(script) > WORKFLOW_LIMITS.scriptBytes ||
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(script)) !== script) throw new WorkflowError("invalid_script");
  if (!modulePromise) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(new URL("../../../../worker/workflow-script.wasm", import.meta.url)); }
    catch (cause) { throw new WorkflowError("script_validator_unavailable", { cause }); }
    modulePromise = newQuickJSWASMModuleFromVariant(newVariant(variant, {
      wasmBinary: Uint8Array.from(bytes).buffer, wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 1024 }),
    }));
  }
  let module: Awaited<typeof modulePromise>;
  try { module = await modulePromise; }
  catch (cause) { modulePromise = undefined; throw new WorkflowError("script_validator_unavailable", { cause }); }
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SCRIPT_LIMITS.memoryBytes);
  runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
  const deadline = Date.now() + 1000;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    let compiled: ReturnType<typeof context.evalCode>;
    try { compiled = context.evalCode(`(async function(input) {\n${script}\n})`, "workflow.js", { type: "global", compileOnly: true }); }
    catch (cause) { throw new WorkflowError("invalid_script_syntax", { cause }); }
    if (compiled.error) { compiled.error.dispose(); throw new WorkflowError("invalid_script_syntax"); }
    compiled.value.dispose();
  } finally { context.dispose(); runtime.dispose(); }
}
