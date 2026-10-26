import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import { isDeepStrictEqual } from "node:util";

const root = path.dirname(fileURLToPath(import.meta.url));
const privateDir = fs.mkdtempSync(path.join(root, "private-"));
const workDir = fs.mkdtempSync(path.join(root, "workspace-"));
fs.mkdirSync(path.join(workDir, ".pi", "extensions"), { recursive: true });
fs.writeFileSync(path.join(workDir, ".pi", "extensions", "evil.mjs"), "throw new Error('untrusted extension loaded')\n");
fs.writeFileSync(path.join(workDir, "AGENTS.md"), "untrusted instructions\n");
const accesses = [];
const resourceRoots = [path.join(os.homedir(), ".agents"), path.join(os.homedir(), ".pi"), path.join(workDir, ".pi"), path.join(workDir, ".agents"), path.join(workDir, "AGENTS.md"), path.join(workDir, "CLAUDE.md")];
const originals = new Map();
const traceTarget = (method, target) => {
  const value = target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : target;
  if (typeof value !== "string") return;
  const absolute = path.resolve(value);
  accesses.push({ method, target: absolute });
  assert.ok(!resourceRoots.some(prefix => absolute === prefix || absolute.startsWith(`${prefix}${path.sep}`)), `forbidden resource access ${method}: ${absolute}`);
};
for (const method of ["existsSync", "readFileSync", "readdirSync", "statSync", "lstatSync", "openSync", "realpathSync", "readFile", "readdir", "stat", "lstat", "open", "realpath", "access"]) {
  const original = fs[method];
  originals.set(method, original);
  fs[method] = function (target, ...args) {
    traceTarget(method, target);
    return original.call(this, target, ...args);
  };
}
const promiseOriginals = new Map();
for (const method of ["readFile", "readdir", "stat", "lstat", "open", "realpath", "access"]) {
  const original = fs.promises[method];
  promiseOriginals.set(method, original);
  fs.promises[method] = function (target, ...args) { traceTarget(`promises.${method}`, target); return original.call(this, target, ...args); };
}
syncBuiltinESMExports();
const { createEventBus, discoverAndLoadExtensions, createAgentSession, ModelRuntime, SettingsManager, SessionManager } = await import("@earendil-works/pi-coding-agent");
const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { StreamableHttpTransport, StdioTransport, McpClient, McpSessionExpiredError } = await import("@earendil-works/pi-mcp");

class IntentGateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const rpcCalls = [];
let remoteTools = ["echo", "dangerous", "extra", "long", "image", "error_image"];
const rpcMethods = [];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB8sAAAAASUVORK5CYII=";
const remoteResults = new Map();
let hold;
let held;
let expiredOnce = false;
let peerExpiredOnce = false;
let peerRetry;
let sessionSequence = 0;
const server = http.createServer(async (request, response) => {
  if (request.method === "DELETE") { response.writeHead(204).end(); return; }
  if (request.method === "GET") { response.writeHead(405).end(); return; }
  let body = "";
  for await (const chunk of request) body += chunk;
  const message = JSON.parse(body);
  rpcMethods.push(message.method);
  if (message.method.startsWith("notifications/")) { response.writeHead(202).end(); return; }
  let result;
  if (message.method === "initialize") { sessionSequence++; result = { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "p0", version: "1" } }; }
  else if (message.method === "tools/list") result = { tools: remoteTools.map(name => ({ name, description: name, inputSchema: { type: "object", properties: { value: { type: "string" } }, required: [] } })) };
  else if (message.method === "tools/call") {
    rpcCalls.push({ path: request.url, session: request.headers["mcp-session-id"], ...message });
    const value = message.params.arguments.value;
    if ((value === "expire" && !expiredOnce) || (value === "peer-expire" && !peerExpiredOnce)) {
      if (value === "expire") expiredOnce = true;
      else peerExpiredOnce = true;
      rpcCalls.at(-1).rejectedBeforeExecution = true;
      response.writeHead(404, { "content-type": "text/plain" }).end("expired session");
      return;
    }
    if (["held", "peer-held"].includes(value)) { held.resolve(); await hold.promise; }
    result = message.params.name === "long" ? { content: [{ type: "text", text: "large".repeat(7000) }], structuredContent: { complete: true }, _meta: { internal: "not in scripts" } }
      : message.params.name === "image" ? { content: [{ type: "image", mimeType: "image/png", data: png }] }
      : message.params.name === "error_image" ? { content: [{ type: "image", mimeType: "image/png", data: png }], isError: true }
      : { content: [{ type: "text", text: message.params.arguments.value ?? "ok" }] };
    remoteResults.set(message.params.name, result);
  }
  else result = { resources: [] };
  response.writeHead(200, { "content-type": "application/json", "mcp-session-id": `isolated-${sessionSequence}` });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "tools/call" && message.params.arguments.value === "peer-expire") peerRetry.resolve();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const sources = [];
const transportLifetime = [];
const createdTransports = [];
let detachedBeforeCleanup = 0;
const operationCalls = [];
const approvalConsumptions = [];
const intents = new Map();
let persistenceEntered;
let persistenceRelease;
let persistenceFinished;
const snapshots = [];
const binding = {
  calls: new AsyncLocalStorage(), active: 0, registered: [], definitions: new Map(), api: undefined, logPath: os.devNull, cuaObserved: false, cuaFrozen: false,
  sdkGeneration: 0, intentScopes: new Map(),
  newSdk() { const generation = ++binding.sdkGeneration; binding.intentScopes.set(generation, generation === 1 ? intents : new Map()); return generation; },
  credentials: { forServer() { return { load: () => ({}), save() { throw new Error("OAuth write forbidden"); }, withRefreshLock: fn => fn() }; }, tokens() {}, remove() { return false; } },
  beforeTool(event, sdkGeneration) {
    if (["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(event.toolName)) return { block: true, reason: "isolated resources not granted" };
    if (!event.toolName.startsWith("mcp__")) return;
    const scopedIntents = binding.intentScopes.get(sdkGeneration);
    const previous = scopedIntents.get(event.toolCallId);
    if (previous) { previous.duplicateAttempts++; return { block: true, reason: "isolated intent already exists" }; }
    const definition = binding.definitions.get(event.toolName);
    const serverName = definition.namespace.aliases[0];
    const entry = binding.api.getMcpServers().find(server => server.name === serverName);
    const snapshot = Object.freeze({ name: event.toolName, label: definition.label, service: serverName, endpoint: entry.config.url, arguments: structuredClone(event.input) });
    const denied = event.toolCallId === "gate-unauthorized" || event.toolName === "mcp__fixture__dangerous" || (event.toolName.startsWith("mcp__cua__") && binding.cuaFrozen) || (event.toolName === "mcp__cua__click" && !binding.cuaObserved);
    const rejected = event.toolCallId === "gate-rejected";
    const intent = { snapshot, phase: denied ? "unauthorized" : rejected ? "rejected" : "pending", approved: false, consumed: false, started: false, duplicateAttempts: 0, approvalAttempts: 0, recoveryAllowed: false };
    scopedIntents.set(event.toolCallId, intent);
    if (denied || rejected) return { block: true, reason: "isolated intent not approved" };
    binding.approve(event.toolCallId, sdkGeneration);
  },
  approve(id, sdkGeneration = 1) {
    const intent = binding.intentScopes.get(sdkGeneration).get(id);
    intent.approvalAttempts++;
    if (intent.phase !== "pending") return false;
    intent.approved = true;
    intent.phase = "approved";
    return true;
  },
  mutateTool(event, sdkGeneration) {
    const intent = binding.intentScopes.get(sdkGeneration).get(event.toolCallId);
    if (!intent) return;
    if (event.toolCallId === "gate-revoked") { intent.approved = false; intent.phase = "revoked"; }
    if (event.toolCallId === "gate-mutated") event.input.value = "changed after approval";
    if (event.toolCallId === "gate-duplicate") assert.equal(binding.approve(event.toolCallId, sdkGeneration), false);
  },
  async beforeSend(call, message, options, scope) {
    const intent = binding.intentScopes.get(call.sdkGeneration).get(call.id);
    assert.ok(intent, "official tool_call must record immutable intent");
    const check = () => {
      if (!call.active || options?.signal?.aborted) throw new IntentGateError("canceled_before_send");
      if (!intent.approved) throw new IntentGateError("approval_unavailable");
      if (intent.snapshot.service !== scope.entry || intent.snapshot.endpoint !== scope.url || intent.snapshot.label !== `${scope.entry}/${message.params.name}`) throw new IntentGateError("target_changed");
      if (!isDeepStrictEqual(intent.snapshot.arguments, message.params.arguments)) throw new IntentGateError("parameters_changed");
    };
    try {
      check();
      if (call.id === "gate-slow-cancel") {
        intent.phase = "persisting";
        persistenceEntered.resolve();
        await persistenceRelease.promise;
      }
      if (call.id === "gate-persistence-failed") throw new IntentGateError("persistence_failed");
      check();
      if (intent.started) {
        if (intent.execution !== call.execution || !intent.recoveryAllowed) throw new IntentGateError("approval_already_consumed");
        intent.recoveryAllowed = false;
      } else {
        intent.execution = call.execution;
        intent.consumed = true;
        intent.started = true;
        intent.phase = "started";
        approvalConsumptions.push(call.id);
      }
    } catch (error) {
      intent.failureCode = error.code;
      if (!intent.started) intent.phase = "not_started";
      throw error;
    } finally {
      if (call.id === "gate-slow-cancel") persistenceFinished.resolve();
    }
  },
  saveResult(id, result) {
    fs.writeFileSync(path.join(privateDir, `${id}.json`), JSON.stringify(result));
    const scopedIntents = binding.intentScopes.get(binding.calls.getStore().sdkGeneration);
    if (scopedIntents.has(id)) scopedIntents.get(id).phase = "completed";
    if (binding.calls.getStore().definition.label === "cua/screenshot") binding.cuaObserved = true;
  },
  onFailure(definition, error) {
    const call = binding.calls.getStore();
    const intent = binding.intentScopes.get(call.sdkGeneration).get(call.id);
    if (intent?.started) { intent.phase = "effect_unknown"; intent.failureCode = error.code; }
    if (definition.label === "cua/click") binding.cuaFrozen = true;
  },
  async closeTransports() {
    assert.equal(binding.active, 0);
    detachedBeforeCleanup += transportLifetime.filter(scope => scope.started && !scope.closed).length;
    await Promise.all(createdTransports.map(transport => transport.close()));
  },
  createTransport(entry, cwd, authProvider) {
    assert.equal(cwd, workDir);
    const transport = "url" in entry.config ? new StreamableHttpTransport({ url: entry.config.url, headers: entry.config.headers, openGetStream: false }) : new StdioTransport({ command: entry.config.command, args: entry.config.args, cwd, inheritEnv: false, env: {}, onStderr: () => undefined, maxStderrBytes: 0 });
    const scope = { incarnation: transportLifetime.length + 1, entry: entry.name, url: entry.config.url, started: false, closed: false };
    transportLifetime.push(scope);
    createdTransports.push(transport);
    transport.onClose(() => { scope.closed = true; });
    return {
      async start() { scope.started = true; await transport.start(); scope.pid = transport.pid; }, async close() { scope.closed = true; await transport.close(); },
      onMessage: handler => transport.onMessage(handler), onError: handler => transport.onError(handler), onClose: handler => transport.onClose(handler), setProtocolVersion: version => transport.setProtocolVersion?.(version),
      async send(message, options) {
        if (message.method === "tools/call") {
          const call = binding.calls.getStore();
          assert.ok(call, "official execute wrapper must carry operation identity");
          assert.deepEqual(message.params.arguments, call.params);
          assert.equal(call.definition.label, `${entry.name}/${message.params.name}`);
          await binding.beforeSend(call, message, options, scope);
          operationCalls.push({ operation: call.id, incarnation: scope.incarnation, entry: entry.name, remote: message.params.name, rpc: message.id, url: entry.config.url });
        }
        try {
          await transport.send(message, options);
        } catch (error) {
          const call = binding.calls.getStore();
          if (call && error instanceof McpSessionExpiredError) binding.intentScopes.get(call.sdkGeneration).get(call.id).recoveryAllowed = true;
          throw error;
        }
      },
    };
  },
};
const bus = createEventBus();
const stopBinding = bus.on("ruukoto:p0-bind", request => { request.binding = binding; });
const loaded = await discoverAndLoadExtensions([path.join(root, "host-extension.mjs")], privateDir, privateDir, bus);
stopBinding();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const loader = {
  getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "isolated host", getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
  extendResources() { throw new Error("resource discovery not allowed"); }, async reload() {},
};
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: path.join(privateDir, "models-store.json"), refreshOnCreate: false });
const faux = fauxProvider({ provider: "isolated", api: "isolated", models: [{ id: "p0", input: ["text", "image"] }] });
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.setRuntimeApiKey("isolated", "isolated");
binding.api.registerMcpServer("fixture", { url: `${url}/a`, exposure: "hidden", toolExposure: { echo: "direct" } });
const { session } = await createAgentSession({ cwd: workDir, agentDir: privateDir, modelRuntime, model: faux.getModel(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), sessionManager: SessionManager.create(workDir, path.join(privateDir, "sessions")), resourceLoader: loader, tools: ["tool_search", "nested_probe", "mcp__*"] });
process.stdout.write(JSON.stringify({stage: "mcp-pre-bind", registered: loaded.runtime.mcpServers.list()}) + "\n");
await session.bindExtensions({ mode: "rpc", uiContext: { notify: (text, kind) => sources.push({text,kind}) }, onError: error => sources.push(error) });
assert.equal(session.getToolDefinition("mcp__fixture__echo"), undefined);
const waitTool = async (name, predicate = definition => definition.exposure !== "hidden") => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const definition = session.getToolDefinition(name);
    if (definition && predicate(definition)) return definition;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.stdout.write(JSON.stringify({ all: session.getAllTools(), registered: binding.registered, sources, lifetime: transportLifetime }) + "\n");
  assert.fail(`tool not ready: ${name}`);
};
const first = await waitTool("mcp__fixture__echo");
assert.equal(first.exposure, "direct");
assert.equal(faux.state.callCount, 0);
  const requireTools = names => {
    for (const name of names) if (!session.getToolDefinition(name) || !session.getCallableToolNames().includes(name)) throw new Error(`required tool unavailable: ${name}`);
  };
  const beforeMissing = faux.state.callCount;
  assert.throws(() => requireTools(["mcp__fixture__missing"]));
  assert.equal(faux.state.callCount, beforeMissing);
  requireTools(["mcp__fixture__echo"]);
assert.ok(!session.getCallableToolNames().includes("mcp__fixture__dangerous"));
assert.ok(!session.getToolDefinition("list_mcp_resources"));
assert.ok(!session.getToolDefinition("read_mcp_resource"));
assert.ok(!session.getToolDefinition("codemode"));
process.stdout.write(JSON.stringify({ stage: "loaded", allTools: session.getAllTools().map(tool => ({ name: tool.name, exposure: tool.exposure })), active: session.getActiveToolNames(), callable: session.getCallableToolNames(), resourceAccesses: accesses.filter(item => resourceRoots.some(root => item.target.startsWith(root))).length, loadedErrors: loaded.errors, modelCalls: faux.state.callCount }) + "\n");
try {
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "first" }, { id: "call-first" })), fauxAssistantMessage("done")]);
  await session.prompt("first call");
  assert.equal(rpcCalls.length, 1);
  assert.equal(operationCalls[0].operation, "call-first");
  snapshots.push(structuredClone(session.messages));
  const gateResults = [];
  for (const id of ["gate-unauthorized", "gate-rejected", "gate-revoked", "gate-mutated", "gate-persistence-failed"]) {
    const before = rpcCalls.length;
    faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "original" }, { id })), fauxAssistantMessage("done")]);
    await session.prompt(`immutable intent ${id}`);
    assert.equal(rpcCalls.length, before);
    const intent = intents.get(id);
    assert.equal(intent.started, false);
    assert.equal(intent.consumed, false);
    assert.deepEqual(intent.snapshot.arguments, { value: "original" });
    gateResults.push({ id, phase: intent.phase, started: intent.started, consumed: intent.consumed, failure: intent.failureCode, businessSends: rpcCalls.length - before });
  }
  for (const id of ["gate-approved", "gate-duplicate"]) {
    const before = rpcCalls.length;
    faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "allowed" }, { id })), fauxAssistantMessage("done")]);
    await session.prompt(`approved intent ${id}`);
    assert.equal(rpcCalls.length, before + 1);
    assert.equal(intents.get(id).started, true);
    assert.equal(intents.get(id).consumed, true);
    assert.equal(approvalConsumptions.filter(operation => operation === id).length, 1);
    if (id === "gate-approved") gateResults.push({ id, phase: intents.get(id).phase, started: true, consumed: true, businessSends: 1 });
  }
  const duplicateBefore = rpcCalls.length;
  assert.equal(binding.approve("gate-duplicate"), false);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "allowed" }, { id: "gate-duplicate" })), fauxAssistantMessage("done")]);
  await session.prompt("same approval and intent cannot run again");
  assert.equal(rpcCalls.length, duplicateBefore);
  assert.equal(intents.get("gate-duplicate").duplicateAttempts, 1);
  assert.equal(approvalConsumptions.filter(operation => operation === "gate-duplicate").length, 1);
  gateResults.push({ id: "gate-duplicate", phase: intents.get("gate-duplicate").phase, started: true, consumed: true, approvalAttempts: intents.get("gate-duplicate").approvalAttempts, originalBusinessSends: 1, repeatBusinessSends: 0 });

  persistenceEntered = Promise.withResolvers();
  persistenceRelease = Promise.withResolvers();
  persistenceFinished = Promise.withResolvers();
  const canceledBefore = rpcCalls.length;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "original" }, { id: "gate-slow-cancel" })), fauxAssistantMessage("done")]);
  const canceledPrompt = session.prompt("cancel during immutable intent persistence");
  await persistenceEntered.promise;
  assert.equal(intents.get("gate-slow-cancel").phase, "persisting");
  assert.equal(intents.get("gate-slow-cancel").consumed, false);
  await session.abort();
  await canceledPrompt;
  persistenceRelease.resolve();
  await persistenceFinished.promise;
  assert.equal(rpcCalls.length, canceledBefore);
  assert.equal(intents.get("gate-slow-cancel").started, false);
  assert.equal(intents.get("gate-slow-cancel").consumed, false);
  assert.equal(intents.get("gate-slow-cancel").failureCode, "canceled_before_send");
  gateResults.push({ id: "gate-slow-cancel", phase: intents.get("gate-slow-cancel").phase, started: false, consumed: false, businessSends: 0 });
  fs.writeFileSync(path.join(privateDir, "intent-gate-results.json"), JSON.stringify(gateResults));
  process.stdout.write(JSON.stringify({ stage: "immutable-intent-gates", gateResults }) + "\n");
  // 嵌套调用使用同一资格；hidden工具不能经另一工具绕过。
  const beforeNested = rpcCalls.length;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("nested_probe", { name: "mcp__fixture__dangerous", args: {} }, { id: "nested-denied" })), fauxAssistantMessage("done")]);
  await session.prompt("denied nested call");
  assert.equal(rpcCalls.length, beforeNested);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("nested_probe", { name: "mcp__fixture__echo", args: { value: "nested" } }, { id: "nested-allowed" })), fauxAssistantMessage("done")]);
  await session.prompt("allowed nested call");
  assert.equal(rpcCalls.length, beforeNested + 1);
  assert.equal(rpcCalls.at(-1).params.arguments.value, "nested");
  assert.notEqual(operationCalls.at(-1).operation, "nested-allowed");

  binding.api.registerMcpServer("fixture", { url: `${url}/b`, exposure: "hidden", toolExposure: { echo: "deferred", extra: "direct" } });
  await waitTool("mcp__fixture__echo", definition => definition.exposure === "deferred");
  await waitTool("mcp__fixture__extra");
  assert.ok(session.getCallableToolNames().includes("mcp__fixture__echo"));
  faux.setResponses([fauxAssistantMessage(fauxToolCall("tool_search", { query: "fixture echo", limit: 1 }, { id: "search" })), fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "b" }, { id: "call-b" })), fauxAssistantMessage("done")]);
  await session.prompt("search then call changed endpoint");
  assert.equal(rpcCalls.at(-1).path, "/b");
  assert.ok(transportLifetime[0].closed);

  binding.api.registerMcpServer("added", { url: `${url}/b`, exposure: "hidden", toolExposure: { extra: "direct" } });
  await waitTool("mcp__added__extra");
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__added__extra", {}, { id: "added-call" })), fauxAssistantMessage("done")]);
  await session.prompt("new service same SDK");
  assert.equal(operationCalls.at(-1).entry, "added");
  binding.api.unregisterMcpServer("added");
  await waitTool("mcp__added__extra", definition => definition.exposure === "hidden");
  assert.ok(!session.getCallableToolNames().includes("mcp__added__extra"));

  binding.api.registerMcpServer("fixture", { url: `${url}/a`, enabled: false, exposure: "hidden", toolExposure: { echo: "direct" } });
  await waitTool("mcp__fixture__echo", definition => definition.exposure === "hidden");
  const beforeDisabled = rpcCalls.length;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("nested_probe", { name: "mcp__fixture__echo", args: { value: "disabled" } })), fauxAssistantMessage("done")]);
  await session.prompt("disabled service");
  assert.equal(rpcCalls.length, beforeDisabled);
  binding.api.registerMcpServer("fixture", { url: `${url}/a`, exposure: "hidden", toolExposure: { echo: "direct", long: "direct", image: "direct", error_image: "direct" } });
  await waitTool("mcp__fixture__echo");
  await waitTool("mcp__fixture__long");
  assert.ok(!session.getCallableToolNames().includes("mcp__fixture__extra"));

  session.agent.toolExecution = "parallel";
  faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__fixture__echo", { value: "same" }, { id: "parallel-one" }), fauxToolCall("mcp__fixture__echo", { value: "same" }, { id: "parallel-two" })]), fauxAssistantMessage("done")]);
  await session.prompt("parallel same name and params");
  const parallel = operationCalls.filter(call => call.operation.startsWith("parallel-"));
  assert.equal(parallel.length, 2);
  assert.equal(new Set(parallel.map(call => call.rpc)).size, 2);

  for (const name of ["long", "image", "error_image"]) {
    const id = `raw-${name}`;
    faux.setResponses([fauxAssistantMessage(fauxToolCall(`mcp__fixture__${name}`, {}, { id })), fauxAssistantMessage("done")]);
    await session.prompt(`raw result ${name}`);
    const saved = JSON.parse(fs.readFileSync(path.join(privateDir, `${id}.json`), "utf8"));
    const { _meta, ...expected } = remoteResults.get(name);
    assert.deepEqual(saved, expected);
    const message = session.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
    assert.ok(message);
    if (name === "long") assert.ok(message.content[0].text.length < saved.content[0].text.length);
    else assert.ok(message.content.some(block => block.type === "image" && block.data === png));
    if (name === "error_image") assert.equal(message.isError, true);
  }
  const sessionFile = session.sessionFile;
  assert.ok(sessionFile);
  const historyBytes = fs.readFileSync(sessionFile);
  const reopened = SessionManager.open(sessionFile, path.join(privateDir, "sessions"));
  const reopenedMessages = reopened.buildSessionContext().messages;
  for (const name of ["long", "image", "error_image"]) assert.ok(reopenedMessages.some(message => message.role === "toolResult" && message.toolCallId === `raw-${name}`));
  assert.deepEqual(fs.readFileSync(sessionFile), historyBytes);
  assert.ok(!rpcMethods.some(method => method.startsWith("resources/")));
  assert.ok(!fs.existsSync(path.join(privateDir, "mcp-auth.json")));
  assert.equal(sources.filter(item => item.kind === "error" || item.event).length, 0);
  // 配置发布等原调用完成，再调用官方register，不让保存切断已发送操作。
  hold = Promise.withResolvers();
  held = Promise.withResolvers();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "held" }, { id: "held" })), fauxAssistantMessage("done")]);
  const inFlight = session.prompt("held original call");
  await held.promise;
  const originalScope = transportLifetime.at(-1);
  let published = false;
  const publish = (async () => {
    while (binding.active > 0) await new Promise(resolve => setTimeout(resolve, 5));
    binding.api.registerMcpServer("fixture", { url: `${url}/b`, exposure: "hidden", toolExposure: { echo: "direct" } });
    published = true;
  })();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(published, false);
  assert.equal(originalScope.closed, false);
  hold.resolve();
  await inFlight;
  await publish;
  await waitTool("mcp__fixture__echo");
  assert.equal(rpcCalls.at(-1).path, "/a");
  assert.equal(originalScope.closed, true);

  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { value: "expire" }, { id: "expired-reconnect" })), fauxAssistantMessage("done")]);
  await session.prompt("expired session reconnect");
  const expirationAttempts = operationCalls.filter(call => call.operation === "expired-reconnect");
  const expirationPosts = rpcCalls.filter(call => call.params.arguments.value === "expire");
  assert.equal(expirationAttempts.length, 2);
  assert.equal(new Set(expirationAttempts.map(call => call.incarnation)).size, 2);
  assert.equal(new Set(expirationAttempts.map(call => call.rpc)).size, 1);
  assert.equal(approvalConsumptions.filter(operation => operation === "expired-reconnect").length, 1);
  assert.equal(expirationPosts[0].rejectedBeforeExecution, true);
  assert.notEqual(expirationPosts[0].session, expirationPosts[1].session);
  assert.deepEqual(expirationPosts[0].params, expirationPosts[1].params);
  process.stdout.write(JSON.stringify({ stage: "expired", expirationAttempts, expirationPosts, consumedOnce: true }) + "\n");

  hold = Promise.withResolvers();
  held = Promise.withResolvers();
  peerRetry = Promise.withResolvers();
  const peerScope = transportLifetime.at(-1);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("mcp__fixture__echo", { value: "peer-held" }, { id: "peer-held" }), fauxToolCall("mcp__fixture__echo", { value: "peer-expire" }, { id: "peer-expire" })]), fauxAssistantMessage("done")]);
  const peerPrompt = session.prompt("expired call must preserve another in flight call");
  await held.promise;
  await peerRetry.promise;
  assert.equal(peerScope.closed, false);
  assert.ok(binding.active > 0);
  hold.resolve();
  await peerPrompt;
  const peerResult = session.messages.find(message => message.role === "toolResult" && message.toolCallId === "peer-held");
  assert.equal(peerResult.content[0].text, "peer-held");
  assert.equal(rpcCalls.filter(call => call.params.arguments.value === "peer-held").length, 1);
  assert.equal(rpcCalls.filter(call => call.params.arguments.value === "peer-expire").length, 2);
  assert.equal(approvalConsumptions.filter(operation => operation === "peer-expire").length, 1);

  const cuaRecord = path.join(privateDir, "cua-calls.jsonl");
  binding.api.registerMcpServer("cua", { command: process.execPath, args: [path.join(root, "cua-fixture.mjs"), cuaRecord], exposure: "hidden", toolExposure: { screenshot: "direct", click: "direct" } });
  await waitTool("mcp__cua__screenshot");
  await waitTool("mcp__cua__click");
  const cuaScope = transportLifetime.find(scope => scope.entry === "cua");
  const cuaCalls = () => fs.readFileSync(cuaRecord, "utf8").trim().split("\n").map(line => JSON.parse(line));
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__cua__click", {}, { id: "unobserved-click" })), fauxAssistantMessage("done")]);
  await session.prompt("unobserved click denied");
  assert.equal(cuaCalls().filter(message => message.method === "tools/call").length, 0);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__cua__screenshot", {}, { id: "cua-observe" })), fauxAssistantMessage("done")]);
  await session.prompt("computer observe");
  faux.setResponses([fauxAssistantMessage("ordinary response")]);
  await session.prompt("ordinary round");
  assert.equal(cuaScope.closed, false);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__cua__click", {}, { id: "cua-click" })), fauxAssistantMessage("done")]);
  await session.prompt("computer click same client");
  assert.equal(cuaCalls().filter(message => message.method === "initialize").length, 1);
  assert.ok(cuaCalls().every(message => message.pid === cuaScope.pid));
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp__cua__click", { fail: true }, { id: "cua-lost" })), fauxAssistantMessage("done")]);
  await session.prompt("computer wrote but lost answer");
  assert.equal(binding.cuaFrozen, true);
  assert.equal(cuaCalls().filter(message => message.method === "tools/call" && message.params.name === "click").length, 2);
  let stopped = false;
  try { process.kill(cuaScope.pid, 0); } catch (error) { assert.equal(error.code, "ESRCH"); stopped = true; }
  assert.equal(stopped, true);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
  process.stdout.write(JSON.stringify({ stage: "shutdown", transportLifetime }) + "\n");
  assert.ok(transportLifetime.every(scope => scope.closed));
  session.dispose();

  const oldHistory = fs.readFileSync(sessionFile);
  const nextBus = createEventBus();
  const removeNextBinding = nextBus.on("ruukoto:p0-bind", request => { request.binding = binding; });
  const nextLoaded = await discoverAndLoadExtensions([path.join(root, "host-extension.mjs")], privateDir, privateDir, nextBus);
  removeNextBinding();
  assert.equal(nextLoaded.errors.length, 0);
  const { session: reopenedSdk } = await createAgentSession({ cwd: workDir, agentDir: privateDir, modelRuntime, model: faux.getModel(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), sessionManager: SessionManager.open(sessionFile, path.join(privateDir, "sessions")), resourceLoader: { ...loader, getExtensions: () => nextLoaded }, tools: ["tool_search", "nested_probe", "mcp__*"] });
  await reopenedSdk.bindExtensions({ mode: "rpc", uiContext: { notify: (text, kind) => sources.push({ text, kind }) }, onError: error => sources.push(error) });
  const priorModelCalls = faux.state.callCount;
  let reopenedRequest;
  faux.setResponses([context => { reopenedRequest = structuredClone(context); return fauxAssistantMessage("reopened"); }]);
  try {
    await reopenedSdk.prompt("read reopened history");
    assert.equal(faux.state.callCount, priorModelCalls + 1);
    assert.ok(JSON.stringify(reopenedRequest).includes(png));
    assert.deepEqual(fs.readFileSync(sessionFile).subarray(0, oldHistory.length), oldHistory);
  } finally {
    await reopenedSdk.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
    reopenedSdk.dispose();
  }

  const recoveryTransport = new StdioTransport({ command: process.execPath, args: [path.join(root, "cua-fixture.mjs"), cuaRecord], cwd: workDir, inheritEnv: false, env: {}, onStderr: () => undefined, maxStderrBytes: 0 });
  const recoveryClient = new McpClient({ name: "isolated-recovery", version: "1" });
  const recovery = {
    start: () => recoveryTransport.start(), close: () => recoveryTransport.close(), onMessage: listener => recoveryTransport.onMessage(listener), onError: listener => recoveryTransport.onError(listener), onClose: listener => recoveryTransport.onClose(listener),
    send: async (message, options) => {
      if (message.method === "tools/call" && message.params.name !== "screenshot") throw new Error("isolated recovery is read only");
      return recoveryTransport.send(message, options);
    },
  };
  try {
    await recoveryClient.connect(recovery);
    const recoveryPid = recoveryTransport.pid;
    const observation = await recoveryClient.callTool("screenshot", {});
    assert.equal(observation.content[0].data, png);
    fs.writeFileSync(path.join(privateDir, "recovery-observation.json"), JSON.stringify(observation));
    await assert.rejects(recoveryClient.callTool("click", {}));
    assert.notEqual(recoveryPid, cuaScope.pid);
    assert.equal(cuaCalls().filter(message => message.method === "tools/call" && message.params.name === "click").length, 2);
    const recoveryExited = Promise.withResolvers();
    recoveryTransport.onClose(() => recoveryExited.resolve());
    process.kill(recoveryPid, "SIGTERM");
    await recoveryExited.promise;
    assert.throws(() => process.kill(recoveryPid, 0), error => error.code === "ESRCH");
  } finally {
    await recoveryClient.close();
  }
  assert.equal(detachedBeforeCleanup, 2);
  process.stdout.write(JSON.stringify({ stage: "passed", modelCalls: faux.state.callCount, businessCalls: rpcCalls.length, officialOperationCalls: operationCalls.length, registrations: binding.registered.length, transportCount: transportLifetime.length, detachedTransportClosedByHost: detachedBeforeCleanup, realResourceAccesses: 0, hiddenResourcesNetworkCalls: 0, rawResults: ["long", "image", "error_image"], historyBytesUnchangedOnRead: true, errors: sources }) + "\n");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
  session.dispose();
  await new Promise(resolve => server.close(resolve));
  for (const [method, original] of originals) fs[method] = original;
  for (const [method, original] of promiseOriginals) fs.promises[method] = original;
  syncBuiltinESMExports();
}
