import { createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";

export default function hostExtension(pi) {
  const request = {};
  pi.events.emit("ruukoto:p0-bind", request);
  if (!request.binding) throw new Error("missing isolated host binding");
  const binding = request.binding;
  const sdkGeneration = binding.newSdk();
  binding.api = pi;
  const wrapped = {
    ...pi,
    registerCommand() {},
    registerTool(definition) {
      binding.definitions.set(definition.name, definition);
      const original = definition.execute;
      pi.registerTool({
        ...definition,
        execute: (id, params, signal, update, ctx) => binding.calls.run({ id, definition, params, sdkGeneration, execution: {}, active: true }, async () => {
          if (definition.name.startsWith("mcp__")) binding.active++;
          try {
            const result = await original(id, params, signal, update, ctx);
            if (result.structuredContent && definition.name.startsWith("mcp__")) binding.saveResult(id, result.structuredContent);
            return result;
          } catch (error) {
            binding.onFailure?.(definition, error);
            throw error;
          } finally {
            binding.calls.getStore().active = false;
            if (definition.name.startsWith("mcp__")) binding.active--;
          }
        }),
      });
      binding.registered.push({ name: definition.name, label: definition.label, exposure: definition.exposure });
    },
  };
  createMcpExtension({
    loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
    createTransport: binding.createTransport,
    credentials: binding.credentials,
    logPath: binding.logPath,
    updateConfig: () => { throw new Error("isolated prototype has no config commands"); },
    startupWaitMs: 500,
  })(wrapped);
  createToolSearchExtension()(wrapped);
  pi.on("tool_call", event => binding.beforeTool(event, sdkGeneration));
  pi.on("tool_call", event => binding.mutateTool(event, sdkGeneration));
  pi.on("session_shutdown", () => binding.closeTransports());
  pi.registerTool({
    name: "nested_probe", label: "nested_probe", description: "isolated nested call",
    parameters: { type: "object", properties: { name: { type: "string" }, args: { type: "object", additionalProperties: true } }, required: ["name"] },
    execute: (_id, params, _signal, _update, ctx) => ctx.executeTool(params.name, params.args ?? {}),
  });
}
