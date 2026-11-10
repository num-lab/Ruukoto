import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { array, boolean, entry, exact, invalid, number, object, occupied, parse, pick, same, singleton, string, task, unsupported, type Entry, type ObjectValue, type Snapshot } from "./profile-predecessor-durable-records.ts";

const resourceFields: Readonly<Record<string, string>> = {
  "ruukoto.command": "command", "ruukoto.tool-operation": "operation", "ruukoto.file-io-job": "job",
  "ruukoto.app-data-operation": "operation", "ruukoto.background-process": "process", "ruukoto.browser-operation": "operation",
  "ruukoto.mcp": "operation", "ruukoto.service-execution": "inspection", "ruukoto.service-operation": "operation",
};
const indexes: readonly (readonly [string, string, string])[] = [
  ["ruukoto.tools", "operations", "ruukoto.tool-operation"], ["ruukoto.file-io", "jobs", "ruukoto.file-io-job"],
  ["ruukoto.app-data", "operations", "ruukoto.app-data-operation"], ["ruukoto.background-processes", "ids", "ruukoto.background-process"],
  ["ruukoto.browser", "operations", "ruukoto.browser-operation"], ["ruukoto.mcp-config", "operations", "ruukoto.mcp"],
  ["ruukoto.interactive-resources", "resources", "ruukoto.interactive-resource"],
];
export function inspectResources(snapshot: Snapshot): void {
  const resources = new Map<string, Map<string, ObjectValue>>();
  for (const doc of snapshot.documents) {
    const field = resourceFields[doc.kind];
    if (field) {
      exact(doc.value, [field]);
      if (doc.value[field] === undefined) continue;
      if (doc.retired) occupied("retired resource ownership");
      const value = object(doc.value[field]), family = resources.get(doc.kind) ?? new Map<string, ObjectValue>();
      if (family.has(doc.key)) invalid("duplicate resource");
      family.set(doc.key, value); resources.set(doc.kind, family);
      const identity = doc.kind === "ruukoto.command" || doc.kind === "ruukoto.service-operation" ? object(value.ref).requestId : doc.kind === "ruukoto.file-io-job" || doc.kind === "ruukoto.background-process" ? value.id : doc.kind === "ruukoto.service-execution" ? value.taskId : value.operation;
      if (String(identity) !== doc.key) invalid("resource address");
    }
  }
  for (const [indexKind, field, kind] of indexes) {
    const index = singleton(snapshot, indexKind), ids = index ? array(index[field]).map(value => String(value)) : [];
    const keys = kind === "ruukoto.interactive-resource" ? snapshot.documents.filter(doc => doc.kind === kind && !doc.retired).map(doc => doc.key) : [...resources.get(kind)?.keys() ?? []];
    if (new Set(ids).size !== ids.length) invalid("duplicate resource index");
    same(ids.sort(), keys.sort());
  }
  const referenced = new Set<number>(), stopped = new Set<number>();
  function proof(id: unknown, kind: string, after = 0, conversation?: number): Entry { const result = entry(snapshot, id, kind, after, conversation); referenced.add(result.id); return result; }
  function operationTask(value: ObjectValue, kind?: string): void { const saved = task(snapshot, value.operation, kind); if (!saved.terminal && (value.started || value.consumed || value.startEntry !== undefined || value.startedEntry !== undefined)) occupied("resource task"); }
  function admission(value: ObjectValue, prefix: string): number {
    operationTask(value, "pi.tool");
    const origin = object(value.origin), saved = proof(value.admission, `ruukoto.${prefix}-admission`, 0, number(origin.conversationId));
    same(saved.data.operation, value.operation);
    for (const [key, item] of Object.entries(saved.data)) if (!(prefix === "tool" && key === "approval")) same(value[key], item);
    return saved.id;
  }
  function observation(value: ObjectValue, prefix: string, after: number, fields: readonly string[]): Entry {
    const saved = proof(value.observation, `ruukoto.${prefix}-observation`, after, number(object(value.origin).conversationId));
    same(saved.data, { ...pick(value, fields), stopped: saved.data.stopped });
    boolean(saved.data.stopped); if (saved.data.stopped) stopped.add(saved.id);
    return saved;
  }
  function directoryClaim(kind: string, operation: unknown, claimId: unknown): void {
    if (claimId === undefined) return;
    const claims = array(singleton(snapshot, "ruukoto.directory-claims")?.claims), claim = claims.map(object).find(item => item.acquired === claimId);
    if (!claim) invalid("missing directory claim");
    same(claim.owner, { kind, operation });
    if (!claim.released) occupied("directory claim");
    const acquired = proof(claim.acquired, "ruukoto.directory-claim", 0, 1), released = proof(claim.released, "ruukoto.directory-claim", acquired.id, 1);
    same(acquired.data, { owner: claim.owner, directory: claim.directory, action: "acquire" });
    same(released.data, { owner: claim.owner, directory: claim.directory, action: "release", acquired: acquired.id });
    const directory = object(claim.directory); string(directory.path); number(directory.dev, 0); number(directory.ino, 0);
  }
  for (const value of resources.get("ruukoto.file-io-job")?.values() ?? []) {
    if (value.v !== 1) unsupported("file job version");
    if (!["prepare", "revalidate", "execute"].includes(string(value.phase)) || !["read", "read_write"].includes(string(value.access))) invalid("file job phase");
    const host = object(value.host); number(host.pid); string(host.incarnation); if (host.startIdentity !== null) string(host.startIdentity);
    string(value.id); number(value.deadlineAt, 0);
    same(value.requestSha256, createHash("sha256").update(JSON.stringify(value.request)).digest("hex"));
    const meta = pick(value, ["v", "id", "host", "phase", "access", "requestSha256", "request", "operation", "origin", "deadlineAt"]);
    const conversation = value.origin === undefined ? 1 : number(object(value.origin).conversationId), admitted = proof(value.admission, "ruukoto.file-io-admission", 0, conversation);
    same(admitted.data, meta);
    const projected: ObjectValue = { ...meta, admission: admitted.id, seq: 0, events: [] };
    let previous = admitted.id;
    for (const id of array(value.events)) {
      const saved = proof(id, "ruukoto.file-io-lifecycle", previous, conversation), event = saved.data, kind = string(event.kind);
      same([event.jobId, event.host, event.seq], [value.id, value.host, number(projected.seq, 0) + 1]);
      exact(event, ["kind", "jobId", "host", "seq", ...(kind === "settle" ? ["outcome", "code"] : kind === "result" ? ["ok", "payload"] : kind === "exit" ? ["code"] : [])]);
      switch (kind) {
        case "starting": if (projected.starting || projected.settle || projected.released) invalid("file starting event"); projected.starting = saved.id; break;
        case "dispatch": if (!projected.starting || projected.dispatch || projected.settle || projected.noDispatch) invalid("file dispatch event"); projected.dispatch = saved.id; break;
        case "no-dispatch": if (projected.noDispatch || projected.result) invalid("file no-dispatch event"); projected.noDispatch = saved.id; break;
        case "release": if (projected.released || !projected.noDispatch) invalid("file release event"); projected.released = saved.id; stopped.add(saved.id); break;
        case "terminate": if (!projected.starting || projected.terminate || projected.exit) invalid("file terminate event"); projected.terminate = saved.id; break;
        case "result": {
          if (!projected.dispatch || projected.noDispatch || projected.result) invalid("file result event");
          const payload = object(event.payload), ok = boolean(event.ok);
          if (!ok) { const error = object(payload.error); string(error.code); string(error.message); }
          else if (value.phase === "execute") { if (!["returned", "not_executed", "no_write", "effect_unknown"].includes(string(payload.effect))) invalid("file result effect"); string(payload.code); boolean(payload.partial); number(payload.bytesLength, 0); if (!/^[0-9a-f]{64}$/.test(string(payload.bytesSha256))) invalid("file result digest"); }
          else object(payload.request);
          projected.result = { ok, payload, entry: saved.id }; stopped.add(saved.id); break;
        }
        case "exit": if (!projected.starting || projected.exit) invalid("file exit event"); projected.exit = { code: number(event.code, 0), entry: saved.id }; stopped.add(saved.id); break;
        case "host-ended": if (projected.hostEnded) invalid("file host-ended event"); projected.hostEnded = saved.id; stopped.add(saved.id); break;
        case "settle": {
          if (projected.settle || !["result", "timeout", "canceled", "error", "released"].includes(string(event.outcome))) invalid("file settlement");
          if (event.outcome === "result") { const result = object(projected.result), payload = object(result.payload); same(event.code, result.ok ? value.phase === "execute" ? payload.code : "returned" : object(payload.error).code); }
          if (event.outcome === "released" && !projected.noDispatch && !projected.released && !(!projected.dispatch && projected.hostEnded) || event.outcome === "timeout" && event.code !== "file_io_timeout") invalid("file settlement evidence");
          projected.settle = { outcome: event.outcome, code: string(event.code), entry: saved.id }; break;
        }
        default: unsupported("file lifecycle event");
      }
      projected.seq = event.seq; array(projected.events).push(saved.id); previous = saved.id;
    }
    same(projected, value);
    if (!value.result && !value.exit && !value.hostEnded && !value.released) occupied("file worker");
    if (value.operation !== undefined) {
      const operation = resources.get("ruukoto.tool-operation")?.get(String(value.operation));
      if (!operation || !isDeepStrictEqual(value.origin, operation.origin)) invalid("orphan file job");
      if (value.phase === "execute" && (operation.fileJob !== value.id || !isDeepStrictEqual(value.request, object(operation.prepared).request))) invalid("file operation job link");
    }
  }
  for (const value of resources.get("ruukoto.tool-operation")?.values() ?? []) {
    const admitted = admission(value, "tool"), origin = object(value.origin), conversation = number(origin.conversationId);
    if (!["read_file", "write_file", "http_request", "web_search", "list_files", "search_files"].includes(string(value.kind))) unsupported("native tool kind");
    if (!["returned", "not_executed", "no_write", "effect_unknown"].includes(string(value.effect))) invalid("tool effect");
    if (value.fileIoVersion !== undefined && value.fileIoVersion !== 1) unsupported("file operation version");
    if (value.fileIoVersion === 1 && object(value.prepared).kind !== "file") invalid("file operation family");
    if (value.fileJobUnverified === true) occupied("file job stop");
    if (value.fileJob !== undefined) { const job = resources.get("ruukoto.file-io-job")?.get(string(value.fileJob)); if (!job || value.fileIoVersion !== 1 || job.operation !== value.operation || job.phase !== "execute") invalid("file job link"); }
    const started = boolean(value.started); boolean(value.stopped); same(started, value.startEntry !== undefined);
    if (started) {
      const start = proof(value.startEntry, "ruukoto.tool-start", admitted, conversation); same(start.data, { operation: value.operation, admission: admitted, ...pick(value, ["fileJob"]) });
      if (value.fileIoVersion === 1 && value.fileJob === undefined) invalid("missing file job");
    } else if (value.effect !== "not_executed") invalid("unstarted tool effect");
    if (value.observation !== undefined) observation(value, "tool", value.startEntry === undefined ? admitted : number(value.startEntry), ["operation", "admission", "effect", "code", "artifact", "status", "headers", "view"]);
    if (started && (!value.stopped || value.code === "started" || value.observation === undefined)) occupied("tool execution");
    if (value.stopEvidence !== undefined) {
      const stop = object(value.stopEvidence), evidence = proof(stop.entry, "ruukoto.tool-resolution", number(stop.fileEvent === undefined ? value.observation ?? value.admission : value.startEntry ?? value.admission), conversation);
      same(evidence.data, { operation: value.operation, ...pick(stop, ["evidence", "claim", "actor", "fileJob", "fileEvent"]) });
      if (stop.fileEvent !== undefined) { const fileEvent = proof(stop.fileEvent, "ruukoto.file-io-lifecycle", 0, conversation); if (!stopped.has(fileEvent.id) || fileEvent.id >= evidence.id || fileEvent.data.jobId !== stop.fileJob || value.fileJob !== stop.fileJob) invalid("file stop link"); }
      stopped.add(evidence.id);
    }
    if (started && !stopped.has(number(value.observation)) && value.stopEvidence === undefined) occupied("tool stopping evidence");
    directoryClaim("file", value.operation, value.directoryClaim);
  }
  for (const value of resources.get("ruukoto.command")?.values() ?? []) {
    const ref = object(value.ref), owner = task(snapshot, ref.taskId, "ruukoto.command"); if (value.started && !owner.terminal) occupied("command task");
    const admitted = proof(value.admission, "ruukoto.command-admission"); same(admitted.data.ref, ref); same(admitted.data.execution, value.execution);
    boolean(value.started); boolean(value.stopped); same(value.started, value.startEntry !== undefined); same(value.started, value.prepared !== undefined);
    if (value.started) {
      const prepared = object(value.prepared), start = proof(value.startEntry, "ruukoto.command-start", admitted.id, 1); same(start.data, { ref, prepared });
      if (!value.stopped || object(value.result).code === "started") occupied("command execution");
      const observed = proof(value.observation, "ruukoto.command-observation", start.id, 1); same(observed.data, { ref, execution: value.execution, fingerprint: prepared.fingerprint, result: value.result, stopped: true }); stopped.add(observed.id);
    } else if (value.directoryClaim !== undefined || value.preparationStop !== undefined) {
      const saved = proof(value.preparationStop, "ruukoto.command-preparation-stop", admitted.id); same(saved.data, { ref, result: value.result }); if (object(value.result).effect !== "not_executed") occupied("command preparation");
    }
    if (!value.started && value.result !== undefined && object(value.result).effect !== "not_executed") invalid("unstarted command result");
    directoryClaim("command", ref.taskId, value.directoryClaim);
  }
  for (const value of resources.get("ruukoto.app-data-operation")?.values() ?? []) {
    const admitted = admission(value, "app-data"), conversation = number(object(value.origin).conversationId);
    if (value.started !== undefined) { const start = proof(value.started, "ruukoto.app-data-start", admitted, conversation); same(start.data, { operation: value.operation, admission: admitted }); }
    if (value.started !== undefined && value.result === undefined) occupied("app-data worker result");
    if (value.started !== undefined || value.result !== undefined) {
      const result = object(value.result); if (!["committed", "not_committed"].includes(string(result.effect))) occupied("app-data worker result");
      same(result.op_id, value.opId); const observed = proof(value.observation, "ruukoto.app-data-observation", number(value.started ?? value.admission), conversation); same(observed.data, { operation: value.operation, result }); stopped.add(observed.id);
    }
  }
  if (singleton(snapshot, "ruukoto.app-data")?.initializing === true) occupied("app-data initialization");
  for (const value of resources.get("ruukoto.background-process")?.values() ?? []) {
    const admitted = proof(value.admission, "ruukoto.background-admission"); same(admitted.data.id, value.id); same(admitted.data.execution, value.execution);
    if (value.state !== "stopped" || value.stopped !== true) occupied("background process");
    const observed = proof(value.observation, "ruukoto.background-observation", admitted.id); same(observed.data, pick(value, ["id", "state", "stopped", "partial", "reason", "logs", "exit"])); stopped.add(observed.id);
    task(snapshot, value.taskId, "ruukoto.background-start"); task(snapshot, value.operation, "pi.tool");
    if (value.launchClaim !== undefined) { const launch = proof(value.launchClaim, "ruukoto.background-launch", admitted.id, 1); same(launch.data, { id: value.id, fingerprint: value.fingerprint }); }
    for (const id of value.observations === undefined ? [] : array(value.observations)) { const history = proof(id, "ruukoto.background-observation", admitted.id, 1); same(history.data.id, value.id); if (history.id > observed.id) invalid("stale background observation"); }
    directoryClaim("background", value.operation, value.claim);
  }
  inspectBrowser(snapshot, resources, proof, stopped, admission, observation);
  inspectMcp(snapshot, resources, proof, stopped, admission);
  inspectServices(snapshot, resources, proof, stopped);
  inspectClaims(snapshot, resources, proof, stopped);
  for (const doc of snapshot.documents) {
    if (doc.kind === "pi.live") {
      if (doc.value.generation !== undefined || doc.value.run !== undefined) occupied("live generation");
      for (const key of ["tools", "nestedTools"]) for (const slot of doc.value[key] === undefined ? [] : array(doc.value[key])) { const value = object(slot); if (value.status !== "done") occupied("live tool"); if (value.taskId !== undefined && !task(snapshot, value.taskId, "pi.tool").terminal) occupied("live tool task"); }
      for (const slot of doc.value.compactions === undefined ? [] : array(doc.value.compactions)) if (!task(snapshot, object(slot).taskId, "pi.compaction").terminal) occupied("live compaction");
    }
    if (doc.kind === "pi.tool.nested-call") { const owner = task(snapshot, doc.owner, "pi.tool"); if (!owner.terminal) occupied("nested tool"); }
    if (doc.kind === "ruukoto.subagents") for (const raw of array(doc.value.agents)) { const agent = object(raw); if (!snapshot.conversations.has(number(agent.id))) invalid("SubAgent identity"); boolean(agent.closed); if (agent.work !== undefined) occupied("SubAgent work ownership"); }
    if (doc.kind === "ruukoto.work" && doc.value.ref !== undefined) { const ref = object(doc.value.ref); same(ref.requestId, doc.key); if (!task(snapshot, ref.taskId, "ruukoto.background-work").terminal || !array(singleton(snapshot, "ruukoto.subagents")?.agents).some(raw => object(raw).id === ref.agentId)) occupied("work ownership"); }
  }
  for (const saved of snapshot.tasks.values()) {
    const family = saved.kind === "ruukoto.command" ? "ruukoto.command" : saved.kind === "ruukoto.service-operation" ? "ruukoto.service-operation" : saved.kind === "ruukoto.background-start" ? "ruukoto.background-process" : undefined;
    if (family && ![...resources.get(family)?.values() ?? []].some(value => family === "ruukoto.background-process" ? value.taskId === saved.id : object(value.ref).taskId === saved.id)) invalid("orphan resource task");
  }
  // Earlier observations remain history, but a later unprojected observation is not a stopped snapshot.
  for (const saved of snapshot.entries.values()) {
    if (referenced.has(saved.id) || !saved.kind.endsWith("-observation")) continue;
    const prefix = saved.kind.slice("ruukoto.".length, -"-observation".length), family = prefix === "tool" ? "ruukoto.tool-operation" : prefix === "app-data" ? "ruukoto.app-data-operation" : prefix === "browser" ? "ruukoto.browser-operation" : prefix === "background" ? "ruukoto.background-process" : prefix === "command" ? "ruukoto.command" : prefix === "mcp" ? "ruukoto.mcp" : undefined;
    if (!family) continue;
    const value = [...resources.get(family)?.values() ?? []].find(value => prefix === "command" ? isDeepStrictEqual(saved.data.ref, value.ref) : prefix === "background" ? saved.data.id === value.id : saved.data.operation === value.operation);
    if (!value || saved.id > number(value.observation) || saved.id <= number(value.admission)) invalid("orphan or stale resource observation");
    if (saved.data.admission !== undefined) same(saved.data.admission, value.admission);
    referenced.add(saved.id);
  }
  for (const saved of snapshot.entries.values()) {
    if (saved.kind !== "ruukoto.browser-binding-changed" || referenced.has(saved.id)) continue;
    const session = snapshot.documents.find(doc => !doc.retired && (saved.conversation === 1 ? doc.kind === "ruukoto.browser" : doc.kind === "ruukoto.browser-session" && doc.key === String(saved.conversation)));
    if (!session || saved.id > number(session.value.bindingEntry)) invalid("orphan browser binding entry");
    const state = object(parse(saved.data.stateJson)); if (state.version !== 1) unsupported("browser history version");
    const bindings = array(state.bindings); if (bindings.length !== 1) invalid("browser history binding");
    same(pick(object(bindings[0]), ["sessionId", "generation", "state"]), pick(saved.data, ["sessionId", "generation", "state"]));
  }
  const ownedEntryKinds = /^(?:ruukoto\.(?:tool|command|app-data|background|browser)-(?:admission|start|launch|observation|preparation-stop)|ruukoto\.(?:file-io-(?:admission|lifecycle)|directory-claim|interactive-(?:admission|ownership)|service-inspection-(?:admission|stop)|mcp-(?:admission|start|request|observation|result|cua-launch|cua-launch-stopped|cua-recovery|cua-takeover)))$/;
  for (const saved of snapshot.entries.values()) if (ownedEntryKinds.test(saved.kind) && !referenced.has(saved.id)) invalid("orphan resource entry");
}

type Proof = (id: unknown, kind: string, after?: number, conversation?: number) => Entry;
type Resources = Map<string, Map<string, ObjectValue>>;
type Admission = (value: ObjectValue, prefix: string) => number;
type Observation = (value: ObjectValue, prefix: string, after: number, fields: readonly string[]) => Entry;

function inspectBrowser(snapshot: Snapshot, resources: Resources, proof: Proof, stopped: Set<number>, admission: Admission, observation: Observation): void {
  const sessions = snapshot.documents.filter(doc => ["ruukoto.browser", "ruukoto.browser-session"].includes(doc.kind) && !doc.retired);
  const sessionKeys = sessions.filter(doc => doc.kind === "ruukoto.browser-session").map(doc => doc.key).sort();
  const index = singleton(snapshot, "ruukoto.browser"); same((index?.sessions === undefined ? [] : array(index.sessions)).map(String).filter(id => id !== "1").sort(), sessionKeys);
  for (const doc of sessions) {
    const conversation = doc.kind === "ruukoto.browser" ? 1 : number(Number(doc.key));
    if (doc.value.stateJson === undefined && doc.value.bindingEntry === undefined) continue;
    const state = object(parse(doc.value.stateJson)); if (state.version !== 1) unsupported("browser binding version");
    exact(state, ["version", "bindings", "fingerprints"]); const bindings = array(state.bindings); if (bindings.length !== 1) invalid("browser binding count");
    const binding = object(bindings[0]); if (binding.state !== "closed" || binding.chromePending !== false || binding.daemonPending !== false || binding.dashboardPending !== false) occupied("browser binding");
    if (!["owned", "attached"].includes(string(binding.kind))) unsupported("browser binding kind");
    same(binding.sessionId, String(conversation)); string(binding.generation); string(binding.socketDir); string(binding.cliSession);
    const saved = proof(doc.value.bindingEntry, "ruukoto.browser-binding-changed", 0, conversation); same(saved.data, { stateJson: doc.value.stateJson, sessionId: binding.sessionId, generation: binding.generation, state: "closed" }); stopped.add(saved.id);
    for (const later of snapshot.entries.values()) if (later.kind === saved.kind && later.conversation === conversation && later.id > saved.id) invalid("stale browser binding");
  }
  for (const value of resources.get("ruukoto.browser-operation")?.values() ?? []) {
    const admitted = admission(value, "browser"), conversation = number(object(value.origin).conversationId);
    boolean(value.started); boolean(value.stopped); same(value.started, value.startEntry !== undefined);
    if (value.started) { const saved = proof(value.startEntry, "ruukoto.browser-start", admitted, conversation); same(saved.data, { operation: value.operation, admission: admitted }); }
    if (value.observation !== undefined) observation(value, "browser", number(value.startEntry ?? value.admission), ["operation", "admission", "effect", "code", "artifact", "image", "result"]);
    if (value.stopEvidence !== undefined) { const saved = proof(value.stopEvidence, "ruukoto.browser-resolution", number(value.observation ?? value.admission), conversation); if (saved.data.operation !== value.operation || saved.data.effect !== undefined) invalid("browser stop evidence"); stopped.add(saved.id); }
    if (value.started && (value.stopped !== true || value.code === "started" || value.observation === undefined || !stopped.has(number(value.observation)) && value.stopEvidence === undefined)) occupied("browser operation");
    if (value.claim !== undefined && !snapshot.documents.some(doc => doc.kind === "ruukoto.interactive-resource" && doc.key === "browser" && array(doc.value.claims).some(raw => object(raw).claim === value.claim))) invalid("browser claim link");
  }
}

function inspectMcp(snapshot: Snapshot, resources: Resources, proof: Proof, stopped: Set<number>, admission: Admission): void {
  for (const value of resources.get("ruukoto.mcp")?.values() ?? []) {
    const admitted = admission(value, "mcp"), conversation = number(object(value.origin).conversationId), config = object(value.config);
    if (![1, 2, 3, 4].includes(number(config.version))) unsupported("MCP configuration version");
    const service = array(config.services).map(object).find(item => item.id === value.service); if (!service) invalid("MCP service identity");
    if (value.recordVersion !== undefined && value.recordVersion !== 2) unsupported("MCP operation version");
    boolean(value.started); boolean(value.remoteEnded);
    if (value.recordVersion === 2) {
      if (config.version !== 4 || service.cua !== undefined || value.cua !== undefined) invalid("HTTP MCP record family");
      same(value.started, value.startedEntry !== undefined);
      if (value.startedEntry !== undefined) { const saved = proof(value.startedEntry, "ruukoto.mcp-start", admitted, conversation); same(saved.data, pick(value, ["operation", "admission", "service", "tool", "args", "localEffect"])); }
    } else if (value.startedEntry !== undefined || value.result !== undefined || value.remoteError !== undefined) invalid("legacy MCP record family");
    if (value.observation !== undefined) {
      const saved = proof(value.observation, value.recordVersion === 2 ? "ruukoto.mcp-result" : "ruukoto.mcp-observation", admitted, conversation);
      same(saved.data, pick(value, ["operation", "admission", "effect", "code", "remoteEnded", ...(value.recordVersion === 2 ? ["result", "remoteError"] : ["evidence"])]));
    }
    if (value.started && !service.cua && (value.remoteEnded !== true || value.observation === undefined)) occupied("MCP remote request");
    if (value.recordVersion === 2 && value.remoteEnded && value.result === undefined && value.remoteError === undefined) invalid("HTTP MCP result");
    if (value.started && value.recordVersion !== 2 && !service.cua) {
      const evidence = object(value.evidence), request = object(parse(evidence.request)), response = object(parse(evidence.response));
      same([request.jsonrpc, response.jsonrpc, request.id], ["2.0", "2.0", response.id]);
      if (response.result === undefined && response.error === undefined) occupied("MCP response completion");
    }
    for (const raw of value.cuaLaunches === undefined ? [] : array(value.cuaLaunches)) {
      const launch = object(raw), saved = proof(launch.entry, "ruukoto.mcp-cua-launch", admitted, 1); same(saved.data, { operation: value.operation, scope: launch.scope, description: launch.description });
      if (launch.stopped === undefined) occupied("Cua CLI launch");
      const stop = proof(launch.stopped, "ruukoto.mcp-cua-launch-stopped", saved.id, 1); same(stop.data, { operation: value.operation, launch: saved.id }); stopped.add(stop.id);
    }
    const executions = new Map<string, { value: ObjectValue; after: number }>();
    if (service.cua !== undefined && value.started) { const cua = object(value.cua); executions.set(JSON.stringify(cua.execution), { value: object(cua.execution), after: admitted }); }
    for (const saved of snapshot.entries.values()) {
      if (saved.data.operation !== value.operation || !["ruukoto.mcp-request", "ruukoto.mcp-cua-recovery", "ruukoto.mcp-cua-takeover"].includes(saved.kind)) continue;
      proof(saved.id, saved.kind, admitted);
      const data = saved.data;
      if (saved.kind === "ruukoto.mcp-request") { same(data.admission, admitted); if (data.execution !== undefined) executions.set(JSON.stringify(data.execution), { value: object(data.execution), after: saved.id }); }
      else if (["begin", "observe-request", "observe-response", "observe"].includes(string(data.action))) { const execution = data.nextExecution ?? (saved.kind === "ruukoto.mcp-cua-takeover" ? data.execution : undefined); if (execution !== undefined) executions.set(JSON.stringify(execution), { value: object(execution), after: saved.id }); }
    }
    for (const execution of executions.values()) {
      const cli = object(execution.value.cli), sandbox = object(execution.value.sandbox); string(cli.scope); string(cli.description); string(cli.invocationId); string(cli.group); number(cli.dev, 0); number(cli.ino, 0); string(sandbox.containerId); string(sandbox.startedAt); string(sandbox.bootId); number(sandbox.pid); string(sandbox.processIdentity);
      const saved = [...snapshot.entries.values()].find(item => item.kind === "ruukoto.mcp-cua-recovery" && item.data.operation === value.operation && item.data.action === "stopped" && item.id > execution.after && isDeepStrictEqual(item.data.execution, execution.value));
      if (!saved) occupied("Cua sandbox generation");
      proof(saved.id, saved.kind, execution.after, 1); same(saved.data, { operation: value.operation, execution: execution.value, action: "stopped" }); stopped.add(saved.id);
    }
    if (value.cua !== undefined && service.cua === undefined) invalid("foreign Cua execution");
    if (value.interactive !== undefined) { const interactive = object(value.interactive); if (!snapshot.documents.some(doc => doc.kind === "ruukoto.interactive-resource" && doc.key === interactive.resource && array(doc.value.claims).some(raw => object(raw).claim === interactive.claim))) invalid("Cua interactive claim"); }
  }
}

function helperReply(data: ObjectValue): ObjectValue | undefined {
  if (data.truncated !== false || data.code !== "ok") return undefined;
  const raw = string(data.stderr), bytes = Buffer.from(raw, "base64"); if (bytes.toString("base64") !== raw) invalid("service evidence encoding");
  const lines = bytes.toString("utf8").split("\n").filter(line => line.startsWith("RUUKOTO_SERVICE_REPLY "));
  if (lines.length !== 1) return undefined;
  const reply = object(parse(lines[0].slice("RUUKOTO_SERVICE_REPLY ".length))); if (reply.v !== 1) unsupported("service reply version"); boolean(reply.ok); return reply;
}
function inspectServices(snapshot: Snapshot, resources: Resources, proof: Proof, stopped: Set<number>): void {
  const pending = singleton(snapshot, "ruukoto.service-executions");
  if (pending && array(pending.tasks).length !== 0) occupied("service inspection index");
  for (const value of resources.get("ruukoto.service-execution")?.values() ?? []) {
    task(snapshot, value.taskId); const admitted = proof(value.admission, "ruukoto.service-inspection-admission", 0, number(value.conversationId));
    same(admitted.data, pick(value, ["taskId", "conversationId", "taskKind", "unit", "machineId", "inspectionId", "sources", "configRevision", "configVersion", "generation", "work", "instructions"]));
    if (value.stopped !== true) occupied("service inspection");
    const saved = proof(value.stopEvidence, "ruukoto.service-inspection-stop", admitted.id, number(value.conversationId)), reply = object(saved.data.reply);
    same([saved.data.inspectionId, saved.data.machineId, reply.v, reply.verb, reply.ok, reply.inspectionId, reply.machineId, reply.exited], [value.inspectionId, value.machineId, 1, "stop-inspect", true, value.inspectionId, value.machineId, true]);
    same(helperReply(saved.data), reply); stopped.add(saved.id);
  }
  for (const value of resources.get("ruukoto.service-operation")?.values() ?? []) {
    const ref = object(value.ref), owner = task(snapshot, ref.taskId, "ruukoto.service-operation"); if (value.consumed && !owner.terminal) occupied("service operation task");
    if (!boolean(value.consumed)) continue;
    const result = object(value.result), machine = object(value.snapshot).machineId; string(machine); string(value.hostOpId);
    let verified = false;
    for (const saved of snapshot.entries.values()) if (saved.kind === "ruukoto.service-operation-evidence" && saved.data.requestId === ref.requestId) {
      const reply = helperReply(saved.data); if (!reply) continue;
      same(saved.data.verb, reply.verb);
      if (result.effect === "not_executed" && reply.verb === "restart" && reply.ok === false && reply.launched === false) verified = true;
      const bound = reply.machineId === machine && reply.hostOpId === value.hostOpId && reply.opUnit === `ruukoto-service-op-${string(value.hostOpId)}.service`;
      if (bound && reply.verb === "restart" && reply.ok === true && reply.launched === true && result.effect === "executed" && Number.isInteger(reply.exitCode) && Number(reply.exitCode) >= 0 && Number(reply.exitCode) <= 255 && result.exitCode === reply.exitCode && typeof reply.observedAt === "string" && Number.isFinite(Date.parse(reply.observedAt))) verified = true;
      if (bound && reply.verb === "stop-op" && reply.ok === true && reply.exited === true && reply.launcherExited === true) { verified = true; stopped.add(saved.id); }
    }
    if (!verified) occupied("service operation launcher");
  }
}

function inspectClaims(snapshot: Snapshot, resources: Resources, proof: Proof, stopped: Set<number>): void {
  const directories = singleton(snapshot, "ruukoto.directory-claims");
  for (const raw of directories ? array(directories.claims) : []) {
    const claim = object(raw), owner = object(claim.owner), kind = string(owner.kind); number(owner.operation);
    const family = kind === "file" ? "ruukoto.tool-operation" : kind === "command" ? "ruukoto.command" : kind === "background" ? "ruukoto.background-process" : unsupported("directory owner kind");
    const exists = [...resources.get(family)?.values() ?? []].some(value => kind === "file" ? value.operation === owner.operation && value.directoryClaim === claim.acquired : kind === "command" ? object(value.ref).taskId === owner.operation && value.directoryClaim === claim.acquired : value.operation === owner.operation && value.claim === claim.acquired);
    if (!exists) invalid("orphan directory claim");
    if (claim.released === undefined) occupied("directory ownership");
  }
  for (const doc of snapshot.documents.filter(doc => doc.kind === "ruukoto.interactive-resource")) {
    if (doc.key !== "browser" && !/^cua:local:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(doc.key)) unsupported("interactive resource kind");
    if (doc.value.owner !== undefined) occupied("interactive owner");
    let previous = 0;
    for (const raw of array(doc.value.claims)) {
      const claim = object(raw), admitted = proof(claim.claim, "ruukoto.interactive-admission", previous, 1);
      same(admitted.data, { version: 1, resource: doc.key, origin: claim.origin, ...pick(claim, ["instructions"]) });
      if (claim.acquired !== undefined) { const acquired = proof(claim.acquired, "ruukoto.interactive-ownership", admitted.id, 1); same(acquired.data, { resource: doc.key, claim: admitted.id, action: "acquire" }); }
      if (claim.released === undefined) occupied("interactive claim");
      const released = proof(claim.released, "ruukoto.interactive-ownership", number(claim.acquired ?? claim.claim), 1);
      same(released.data, { resource: doc.key, claim: admitted.id, action: "release", stopped: claim.stopped });
      if (claim.acquired !== undefined && array(claim.stopped).length === 0) occupied("interactive release without stopping evidence");
      const stopIds = array(claim.stopped); if (new Set(stopIds).size !== stopIds.length) invalid("duplicate interactive stop evidence");
      for (const id of stopIds) {
        if (number(id) <= admitted.id || number(id) >= released.id || !stopped.has(number(id))) invalid("interactive stopped evidence");
        const evidence = snapshot.entries.get(number(id))!;
        if (doc.key === "browser") { if (!evidence.kind.startsWith("ruukoto.browser-") || evidence.conversation !== object(claim.origin).conversationId) invalid("foreign browser stop evidence"); }
        else { const operation = resources.get("ruukoto.mcp")?.get(String(evidence.data.operation)), interactive = operation?.interactive === undefined ? undefined : object(operation.interactive); if (!evidence.kind.startsWith("ruukoto.mcp-") || interactive?.resource !== doc.key || interactive.claim !== admitted.id) invalid("foreign Cua stop evidence"); }
      }
      previous = released.id;
    }
  }
}
