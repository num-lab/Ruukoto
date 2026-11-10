import { createHash } from "node:crypto";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProfileError } from "./profile-files.ts";

// Frozen e7838ea5 schema58, including indexes, constraints and sqlite_sequence.
// Its independent DDL and provenance live in test/fixtures/profile-predecessor/shared-*.
const SCHEMA_SHA256 = "a618d9633648f5f4bcd5c74774e064cca8d1d257ce2dcc9fc654ab781ccad73c";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL: Record<string, true> = { completed: true, failed: true, canceled: true, interrupted: true };
const TOOLS: Record<string, true> = Object.fromEntries([
  "read", "edit", "write", "bash", "list_files", "search_files", "request_file_access", "http_request", "web_fetch", "read_artifact", "present", "tool_search",
  "history_search", "history_read", "memory_list", "memory_read", "memory_save", "memory_revoke", "skill", "todo_write", "web_search", "ask_user", "wait", "agent_wait",
  "subagent_delegate", "subagent_result", "subagent_close", "subagent_cancel", "subagent_integrate", "subagent_message", "coding_delegate", "coding_result",
  "workflow_instructions", "workflow_save", "workflow_start", "workflow_query", "workflow_cancel", "worktree_start", "worktree_capture", "worktree_create", "worktree_freeze", "worktree_verify", "worktree_integrate",
  "process_start", "process_status", "process_output", "process_stop", "browser", "desktop_browser", "cua_connection", "cua_recovery_observe",
  "app_data_define_table", "app_data_migrate", "app_data_query", "app_data_insert", "app_data_update", "app_data_delete",
  "schedule_create", "schedule_query", "schedule_cancel", "notification_enqueue", "notification_query", "notification_cancel", "chat_result_list", "chat_result_accept", "service_inspect", "service_manage",
  "mock_delay", "mock_gate", "mock_spawn", "mock_mark",
].map(name => [name, true as const]));
type JsonObject = { [key: string]: unknown };
interface TaskFact { id: string; sessionId: string; queued: boolean; started: boolean }
interface CuaFact { opId: string; executionId: string; fingerprint: string; directory: string; serviceId: string; state: string; stopped: boolean; recovers?: string; observation?: string }

function reject(family: string, reason: string, code = "old_profile_execution_unverified"): never {
  throw new ProfileError(code, `Old shared profile ${family}: ${reason}; preserve the old profile and resolve its records before starting a fresh instance.`);
}
function requireFact(condition: unknown, family: string, reason = "inconsistent resource record"): asserts condition {
  if (!condition) reject(family, reason);
}
function object(value: unknown, family: string): JsonObject {
  requireFact(value !== null && typeof value === "object" && !Array.isArray(value), family, "invalid object");
  return value as JsonObject;
}
function json(value: unknown, family: string): JsonObject {
  requireFact(typeof value === "string", family, "missing JSON record");
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { reject(family, "invalid JSON"); }
  return object(parsed, family);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function date(value: unknown): value is string { return text(value) && Number.isFinite(Date.parse(value)); }
function nullableText(value: unknown): boolean { return value === null || typeof value === "string"; }
function keys(value: JsonObject, allowed: readonly string[], family: string): void {
  requireFact(Object.keys(value).every(key => allowed.includes(key)), family, "unknown resource fields");
}
function version(value: unknown, supported: readonly number[], family: string): void {
  if (!supported.includes(Number(value)) || typeof value !== "number") reject(family, "unsupported record version", "old_profile_version_unsupported");
}
function units(value: unknown, family: string): number {
  requireFact(Array.isArray(value), family, "missing unit inventory");
  for (const entry of value) {
    const unit = object(entry, family);
    keys(unit, ["kind", "id", "label"], family);
    requireFact(["starting", "process_group", "systemd_unit"].includes(String(unit.kind)) && text(unit.id) && text(unit.label), family, "invalid unit identity");
  }
  return value.length;
}
function taskFor(tasks: Map<string, TaskFact>, id: unknown, family: string): TaskFact {
  requireFact(text(id), family, "missing task identity");
  const task = tasks.get(id);
  requireFact(task, family, "orphan resource");
  return task;
}
function workspace(value: unknown, family: string): JsonObject {
  const result = object(value, family);
  requireFact(text(result.path) && path.isAbsolute(result.path) && count(result.dev) && count(result.ino), family, "invalid directory identity");
  return result;
}

function inspectBrowser(value: JsonObject, sessions: Set<string>, dataDir?: string): void {
  const family = "browser";
  version(value.version, [1], family);
  keys(value, ["version", "bindings", "fingerprints"], family);
  requireFact(Array.isArray(value.bindings), family, "missing binding inventory");
  const seen = new Set<string>();
  for (const entry of value.bindings) {
    const binding = object(entry, family);
    keys(binding, ["sessionId", "generation", "kind", "state", "profileDir", "socketDir", "cliSession", "cdpUrl", "targetId", "chrome", "daemon", "dashboard", "chromePending", "daemonPending", "dashboardPending", "lockDir", "pauseTaskId", "pauseAfterSeq", "outcomeUnknown", "failureCode", "dashboardUrl", "headed"], family);
    requireFact(text(binding.sessionId) && sessions.has(binding.sessionId) && !seen.has(binding.sessionId) && text(binding.generation) && UUID.test(binding.generation), family, "invalid binding identity");
    seen.add(binding.sessionId);
    requireFact(binding.kind === "owned" || binding.kind === "attached", family);
    requireFact(binding.state === "closed", family, "browser has not been closed");
    requireFact(binding.chromePending === false && binding.daemonPending === false && binding.dashboardPending === false && binding.pauseTaskId === null && (binding.pauseAfterSeq === null || binding.pauseAfterSeq === undefined) && binding.failureCode === null, family, "unresolved browser ownership");
    requireFact(typeof binding.outcomeUnknown === "boolean" && typeof binding.headed === "boolean", family);
    for (const field of ["profileDir", "cdpUrl", "targetId", "lockDir", "dashboardUrl"]) requireFact(nullableText(binding[field]), family);
    for (const field of ["chrome", "daemon", "dashboard"]) {
      if (binding[field] === null) continue;
      const process = object(binding[field], family);
      keys(process, ["pid", "pgid", "processIdentity"], family);
      requireFact(count(process.pid) && process.pid > 0 && count(process.pgid) && process.pgid > 0 && text(process.processIdentity), family, "invalid historical process identity");
      const identity = process.processIdentity;
      if (!/^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/.test(identity)) {
        requireFact(identity.startsWith("darwin:"), family, "unknown process identity format");
        const parsed = new Date(`${identity.slice(7)} UTC`);
        requireFact(Number.isFinite(parsed.getTime()), family, "invalid process start time");
        const [weekday, day, month, year, time] = parsed.toUTCString().split(" ");
        requireFact(identity === `darwin:${weekday.slice(0, -1)} ${month} ${String(Number(day)).padStart(2, " ")} ${time} ${year}`, family, "invalid process start identity");
      }
    }
    requireFact(text(binding.socketDir) && text(binding.cliSession), family);
    const socket = /^\/tmp\/ruukoto-browser-(\d+|unknown)-([a-f0-9]{24})$/.exec(binding.socketDir);
    requireFact(socket && binding.cliSession === `rk-${socket[2]}`, family, "inconsistent browser namespace");
    if (dataDir) {
      const id = createHash("sha256").update(`${dataDir}\0${binding.sessionId}`).digest("hex").slice(0, 24);
      requireFact(id === socket[2] && (binding.profileDir === null || binding.profileDir === path.join(dataDir, "browser", id, "profile")), family, "browser belongs to a different data directory");
    }
    requireFact(binding.kind !== "owned" || text(binding.profileDir), family);
    if (binding.lockDir !== null) {
      const target = typeof binding.targetId === "string" ? binding.targetId : "";
      requireFact(binding.lockDir === `/tmp/ruukoto-browser-locks-${socket[1]}/${createHash("sha256").update(target).digest("hex")}`, family, "inconsistent attachment lock identity");
    }
  }
  if (value.fingerprints !== undefined) {
    for (const [sessionId, entry] of Object.entries(object(value.fingerprints, family))) {
      const fingerprint = object(entry, family);
      keys(fingerprint, ["config", "version"], family);
      requireFact(seen.has(sessionId) && text(fingerprint.config) && /^[a-f0-9]{16}$/.test(fingerprint.config), family);
      if (fingerprint.version !== "0.39.1") reject(family, "unsupported browser release", "old_profile_version_unsupported");
    }
  }
}

function inspectMetadata(db: DatabaseSync, sessions: Set<string>, dataDir?: string): void {
  for (const row of db.prepare("SELECT key, value FROM meta").iterate()) {
    const key = String(row.key);
    if (["schema_version", "product.type", "instance_id"].includes(key)) continue;
    if (key === "browser_bindings_v1") { inspectBrowser(json(row.value, "browser"), sessions, dataDir); continue; }
    if (/^browser_bindings_v/.test(key)) reject("metadata", "unsupported browser record version", "old_profile_version_unsupported");
    if (key === "app_data.main_instance_id") { requireFact(typeof row.value === "string" && UUID.test(row.value), "app-data", "invalid instance identity"); continue; }
    if (key === "github_retirement_done") { requireFact(date(row.value), "metadata"); continue; }
    if (/^managed_workspace:.+/.test(key)) { requireFact(row.value === "true", "metadata"); continue; }
    const value = json(row.value, "metadata");
    if (key === "web_search") {
      keys(value, ["version", "state"], "metadata");
      requireFact(count(value.version) && value.version > 0 && ["enabled", "disabled"].includes(String(value.state)), "metadata");
    } else if (/^jev\.project\..+/.test(key)) {
      keys(value, ["enabled", "credential", "configVersion"], "metadata");
      requireFact(typeof value.enabled === "boolean" && nullableText(value.credential) && count(value.configVersion), "metadata");
    } else if (/^migration_receipt:.+/.test(key)) {
      version(value.version, [1], "migration receipt");
      keys(value, ["version", "requestDigest", "action", "sourceProjectId", "claim", "mappings", "createdWorkspaces", "revertedRequestId", "result", "createdAt"], "metadata");
      requireFact(["map_sessions", "claim_source", "revert"].includes(String(value.action)) && Array.isArray(value.mappings) && Array.isArray(value.createdWorkspaces) && date(value.createdAt), "metadata");
    } else if (/^managed_workspace_request:.+/.test(key)) {
      keys(value, ["requestId", "paramsDigest", "projectId", "root", "parent", "stage", "modelSelection", "mode", "sessionId", "error"], "metadata");
      requireFact(value.requestId === key.slice("managed_workspace_request:".length) && text(value.projectId) && text(value.root) && nullableText(value.sessionId) && nullableText(value.error), "metadata");
    } else reject("metadata", "unrecognized metadata family", "old_profile_unrecognized");
  }
}

function inspectTasks(db: DatabaseSync): Map<string, TaskFact> {
  const tasks = new Map<string, TaskFact>();
  for (const row of db.prepare("SELECT id,session_id,request_id,status,started_at,ended_at,read_scope,cancel_requested,effect_unknown FROM tasks").iterate()) {
    requireFact(text(row.id) && text(row.session_id) && text(row.request_id), "tasks", "invalid task identity");
    const queued = row.status === "queued";
    requireFact(queued || Object.hasOwn(TERMINAL, String(row.status)), "tasks", "task is not stopped");
    requireFact([0, 1].includes(Number(row.cancel_requested)) && [0, 1].includes(Number(row.effect_unknown)), "tasks");
    requireFact(row.started_at === null || date(row.started_at), "tasks");
    if (queued) requireFact(row.started_at === null && row.ended_at === null && row.effect_unknown === 0 && row.cancel_requested === 0, "tasks", "queued task has execution evidence");
    else requireFact(date(row.ended_at) && (row.started_at === null || Date.parse(row.ended_at) >= Date.parse(String(row.started_at))), "tasks", "invalid terminal timeline");
    const fact: TaskFact = { id: row.id, sessionId: row.session_id, queued, started: row.started_at !== null };
    tasks.set(fact.id, fact);
    const scope = row.read_scope === null ? null : json(row.read_scope, "task scope");
    if (scope) {
      keys(scope, ["paths", "sourceRefs", "execution", "workCopyHost", "readMemories"], "task scope");
      requireFact(Array.isArray(scope.paths) && Array.isArray(scope.sourceRefs), "task scope");
      if (scope.execution !== undefined) {
        const execution = object(scope.execution, "task scope");
        keys(execution, ["source", "roleDigest", "accessMode", "protectSource", "tools", "mcpSignature", "digest"], "task scope");
        requireFact(Array.isArray(execution.tools) && typeof execution.protectSource === "boolean" && text(execution.digest), "task scope");
      }
    }
    const host = scope?.workCopyHost;
    if (host === undefined) requireFact(!row.request_id.startsWith("work-copy-host:"), "work-copy host", "missing host snapshot");
    else {
      const value = object(host, "work-copy host");
      version(value.version, [1], "work-copy host");
      keys(value, ["version", "parentTaskId", "workId", "operation", "source", "units", "stopVerified"], "work-copy host");
      requireFact(text(value.parentTaskId) && text(value.workId) && ["capture", "create", "freeze", "verify", "integrate"].includes(String(value.operation)), "work-copy host");
      workspace(value.source, "work-copy host");
      const unitCount = units(value.units, "work-copy host");
      requireFact(value.stopVerified === null || typeof value.stopVerified === "boolean", "work-copy host");
      if (queued) requireFact(unitCount === 0 && value.stopVerified === null, "work-copy host", "queued host has execution evidence");
      else if (fact.started || unitCount > 0 || value.stopVerified === false) requireFact(value.stopVerified === true, "work-copy host", "host stopping is unverified");
    }
  }
  return tasks;
}

function inspectBackground(db: DatabaseSync, tasks: Map<string, TaskFact>): Set<string> {
  const operations = new Set<string>();
  for (const row of db.prepare("SELECT * FROM background_processes").iterate()) {
    const family = "background process", value = json(row.payload, family);
    keys(value, ["id", "sessionId", "taskId", "hostOpId", "command", "source", "state", "exit", "stopVerified", "reason", "stdoutBytes", "stderrBytes", "partial", "version", "createdAt", "updatedAt", "workspace", "permissionVersion", "handedOff", "launchClaimed", "launchFingerprint", "referenceSnapshot", "ref", "logEvidence"], family);
    requireFact(value.id === row.id && value.sessionId === row.session_id && value.taskId === row.task_id && value.hostOpId === row.host_op_id && value.state === row.state, family, "SQL and resource identity differ");
    const task = taskFor(tasks, value.taskId, family);
    requireFact(!task.queued && task.sessionId === value.sessionId && value.state === "stopped" && value.stopVerified === true, family, "background stopping is unverified");
    requireFact(count(value.version) && value.version > 0 && date(value.createdAt) && date(value.updatedAt) && typeof value.handedOff === "boolean" && typeof value.launchClaimed === "boolean" && typeof value.partial === "boolean", family);
    requireFact(text(value.command) && value.command.trim().length > 0 && value.command.length <= 16384 && nullableText(value.reason), family);
    const source = object(value.source, family);
    requireFact(source.kind === "coding-owner" || source.kind === "coding-schedule" && text(source.runId) && text(source.scheduleId) && count(source.planVersion) && source.planVersion > 0, family, "unknown source kind");
    requireFact(text(source.projectId) && typeof source.input === "string" && source.accessMode === "full_access" && count(value.permissionVersion) && value.permissionVersion > 0 && source.permissionVersion === value.permissionVersion && count(source.inputSeq) && source.inputSeq > 0 && Array.isArray(source.grantedPaths), family);
    for (const entry of source.grantedPaths) {
      const grant = object(entry, family);
      requireFact(text(grant.path) && ["read", "read_write"].includes(String(grant.access)) && typeof grant.purpose === "string", family);
    }
    if (value.logEvidence !== null) {
      const evidence = object(value.logEvidence, family);
      keys(evidence, ["stdout", "stderr"], family);
      for (const field of ["stdout", "stderr"]) {
        const stream = object(evidence[field], family);
        keys(stream, ["dev", "ino", "sha256"], family);
        requireFact(count(stream.dev) && count(stream.ino) && text(stream.sha256) && SHA256.test(stream.sha256), family, "invalid native log evidence identity");
      }
    }
    workspace(value.workspace, family);
    const ref = object(value.ref, family);
    keys(ref, ["platform", "executionId", "machineId"], family);
    requireFact(["linux", "darwin"].includes(String(ref.platform)) && text(ref.executionId) && (ref.machineId === undefined || text(ref.machineId)), family, "unknown native execution identity");
    requireFact(value.launchFingerprint === null || text(value.launchFingerprint) && SHA256.test(value.launchFingerprint), family);
    requireFact(!value.launchClaimed || value.handedOff, family);
    requireFact(count(value.stdoutBytes) && count(value.stderrBytes) && value.stdoutBytes + value.stderrBytes <= 16 * 1024 * 1024, family);
    if (value.exit !== null) {
      const exit = object(value.exit, family);
      requireFact((exit.code === null || Number.isInteger(exit.code)) && nullableText(exit.signal), family);
    }
    if (value.handedOff) {
      const snapshot = object(value.referenceSnapshot, family);
      requireFact(snapshot.taskId === task.id && snapshot.permissionVersion === value.permissionVersion, family, "handoff source differs");
    } else requireFact(value.referenceSnapshot === null && value.launchClaimed === false, family);
    const op = db.prepare("SELECT task_id,tool_name,params FROM tool_ops WHERE id=?").get(String(value.hostOpId));
    requireFact(op && op.task_id === task.id && op.tool_name === "process_start" && json(op.params, family).command === value.command, family, "missing launch operation");
    operations.add(String(value.hostOpId));
  }
  return operations;
}

function inspectWorkflows(db: DatabaseSync, tasks: Map<string, TaskFact>): void {
  for (const row of db.prepare("SELECT id,payload FROM workflow_definitions").iterate()) {
    const value = json(row.payload, "workflow definition");
    requireFact(value.id === row.id, "workflow definition");
    if (value.interfaceVersion !== undefined) version(value.interfaceVersion, [1, 2], "workflow definition");
  }
  const runs = new Set<string>();
  for (const row of db.prepare("SELECT * FROM workflow_runs").iterate()) {
    const family = "workflow run", value = json(row.payload, family);
    keys(value, ["id", "interfaceVersion", "requestKey", "paramsDigest", "definitionId", "scriptDigest", "input", "inputDigest", "displayName", "description", "source", "modelSelection", "roleCatalog", "status", "version", "reason", "attempts", "maxAttempts", "durationMs", "usedMs", "clockStartedAt", "clockVerified", "scriptUnits", "scriptStopVerified", "result", "resultRecorded", "createdAt", "endedAt", "terminalVersion", "delivery"], family);
    requireFact(text(row.id) && value.id === row.id && value.status === row.status && value.requestKey === row.request_key && value.paramsDigest === row.params_digest && object(value.source, family).sessionId === row.source_session_id, family, "SQL and resource identity differ");
    if (value.interfaceVersion !== undefined) version(value.interfaceVersion, [1, 2], family);
    requireFact(count(value.version) && value.version > 0 && count(value.attempts) && count(value.usedMs) && typeof value.clockVerified === "boolean" && (value.clockStartedAt === null || count(value.clockStartedAt)), family);
    const countUnits = units(value.scriptUnits, family);
    requireFact(value.scriptStopVerified === null || typeof value.scriptStopVerified === "boolean", family);
    const neverStarted = countUnits === 0 && value.clockStartedAt === null && value.usedMs === 0 && value.attempts === 0 && value.scriptStopVerified === null;
    if (value.status === "queued") requireFact(neverStarted && value.endedAt === null, family, "queued script has execution evidence");
    else {
      requireFact(["succeeded", "partial", "failed", "canceled"].includes(String(value.status)) && date(value.endedAt), family, "workflow is not terminal");
      requireFact(neverStarted || value.scriptStopVerified === true, family, "script stopping is unverified");
    }
    runs.add(row.id);
  }
  for (const row of db.prepare("SELECT * FROM workflow_executions").iterate()) {
    const family = "workflow execution", value = json(row.payload, family);
    keys(value, ["id", "runId", "stepKey", "kind", "taskId", "number", "status", "units", "stopVerified"], family);
    requireFact(value.id === row.id && value.runId === row.run_id && value.stepKey === row.step_key && value.kind === row.kind && value.taskId === row.task_id && value.number === row.number && runs.has(String(value.runId)), family, "SQL and execution identity differ");
    const task = taskFor(tasks, value.taskId, family), countUnits = units(value.units, family);
    requireFact(value.stopVerified === null || typeof value.stopVerified === "boolean", family);
    if (value.status === "queued") requireFact(!task.started && countUnits === 0 && value.stopVerified === null && !db.prepare("SELECT 1 FROM tool_ops WHERE task_id=? LIMIT 1").get(task.id), family, "queued execution has start evidence");
    else requireFact(value.status === "finished" && value.stopVerified === true && !task.queued, family, "execution stopping is unverified");
  }
}

function inspectMcp(value: JsonObject, opId: string, dataDir?: string): CuaFact | null {
  const family = "MCP";
  requireFact(text(value.serviceId) && count(value.configVersion) && value.configVersion > 0 && ["read", "write", "unknown"].includes(String(value.effect)), family);
  if (value.recordVersion !== undefined) {
    version(value.recordVersion, [2], family);
    keys(value, ["recordVersion", "transport", "serviceId", "configVersion", "remoteName", "effect", "state", "started", "remoteEnded", "remoteRejected", "resultArtifactId", "isError", "error"], family);
    requireFact(value.transport === "http" && text(value.remoteName) && typeof value.started === "boolean" && typeof value.remoteEnded === "boolean" && (value.remoteRejected === undefined || typeof value.remoteRejected === "boolean"), family);
    requireFact(["prepared", "not_sent", "sent", "finished", "frozen"].includes(String(value.state)), family);
    if (value.started) requireFact(value.remoteEnded === true && ["finished", "frozen"].includes(String(value.state)), family, "remote request termination is unverified");
    else requireFact(value.remoteEnded === false && value.remoteRejected !== true && ["prepared", "not_sent", "frozen"].includes(String(value.state)), family, "inconsistent unsent request");
    return null;
  }
  keys(value, ["serviceId", "configVersion", "configuration", "effect", "rawTool", "modelTool", "arguments", "execution", "state", "request", "response", "stoppedAt", "ownerStartedAt", "recoversOpId", "observationOpId", "observationArtifactIds", "acceptedAt"], family);
  const execution = object(value.execution, family);
  keys(execution, ["executionId", "fingerprint", "directory"], family);
  requireFact(text(execution.executionId) && text(execution.fingerprint) && SHA256.test(execution.fingerprint) && text(execution.directory) && path.isAbsolute(execution.directory), family, "invalid Cua execution identity");
  if (dataDir) requireFact(execution.directory === path.join(dataDir, "cua-executions"), family, "Cua belongs to another data directory");
  requireFact(["starting", "prepared", "not_sent", "sent", "finished", "frozen", "recovering", "recovered", "closed"].includes(String(value.state)), family);
  if (value.configuration !== undefined) {
    const config = object(value.configuration, family);
    keys(config, ["kind", "executable", "version", "sha256"], family);
    if (config.kind !== "cua-mac" || config.version !== "0.38.0") reject(family, "unsupported Cua resource version", "old_profile_version_unsupported");
    requireFact(text(config.executable) && text(config.sha256) && SHA256.test(config.sha256), family);
  }
  for (const key of ["rawTool", "modelTool", "arguments"]) object(value[key], family);
  requireFact(value.stoppedAt === undefined || date(value.stoppedAt), family);
  requireFact(value.recoversOpId === undefined || text(value.recoversOpId), family);
  requireFact(value.observationOpId === undefined || text(value.observationOpId), family);
  return { opId, executionId: execution.executionId, fingerprint: execution.fingerprint, directory: execution.directory, serviceId: value.serviceId,
    state: String(value.state), stopped: date(value.stoppedAt), ...(text(value.recoversOpId) ? { recovers: value.recoversOpId } : {}), ...(text(value.observationOpId) ? { observation: value.observationOpId } : {}) };
}

function inspectTools(db: DatabaseSync, tasks: Map<string, TaskFact>, backgrounds: Set<string>, dataDir?: string): void {
  const latest = new Map<string, CuaFact>(), allCua = new Map<string, CuaFact>();
  for (const row of db.prepare("SELECT * FROM tool_ops ORDER BY rowid").iterate()) {
    const family = "tool operation", task = taskFor(tasks, row.task_id, family);
    requireFact(!task.queued && text(row.id) && text(row.tool_name), family, "queued task owns a tool operation");
    requireFact(Object.hasOwn(TOOLS, row.tool_name) || /^mcp__[A-Za-z0-9_]+$/.test(row.tool_name), family, "unknown tool family");
    const params = json(row.params, family);
    requireFact(date(row.intent_recorded_at) && (row.recorded_result_at === null || date(row.recorded_result_at)) && [0, 1].includes(Number(row.effect_unknown)), family);
    const confirmations = db.prepare("SELECT id,task_id,session_id,tool_name,consumed_at FROM confirmations WHERE tool_op_id=?").all(row.id);
    for (const confirmation of confirmations) requireFact(confirmation.task_id === task.id && confirmation.session_id === task.sessionId && confirmation.tool_name === row.tool_name && (confirmation.consumed_at === null || date(confirmation.consumed_at)), family, "approval binding differs");
    const unconsumed = confirmations.length > 0 && confirmations.every(confirmation => confirmation.consumed_at === null);
    if (row.authorization !== null) {
      const auth = json(row.authorization, family);
      keys(auth, ["source", "taskId", "permissionVersion", "scope", "confirmationId"], family);
      requireFact(auth.taskId === task.id && count(auth.permissionVersion) && auth.permissionVersion > 0 && ["approval", "full_access"].includes(String(auth.source)), family);
      object(auth.scope, family);
      if (auth.source === "approval") requireFact(confirmations.some(confirmation => confirmation.id === auth.confirmationId && confirmation.consumed_at !== null), family, "authorization lacks consumption");
    }
    if (row.tool_name === "service_manage") requireFact(unconsumed && row.authorization === null, family, "historical service launch has no independent stop receipt");
    if (row.tool_name === "process_start" && !backgrounds.has(row.id)) requireFact(unconsumed, family, "missing background launch record");
    if (row.tool_name === "browser" && !unconsumed && params.action !== "status") {
      const state = db.prepare("SELECT value FROM meta WHERE key='browser_bindings_v1'").get();
      requireFact(state, "browser", "missing persisted binding for browser operation");
      const bindings = json(state.value, "browser").bindings;
      requireFact(Array.isArray(bindings) && bindings.some(binding => object(binding, "browser").sessionId === task.sessionId), "browser", "missing session binding");
    }
    if (row.mcp !== null) {
      const fact = inspectMcp(json(row.mcp, "MCP"), row.id, dataDir);
      if (fact) {
        const previous = latest.get(fact.executionId);
        requireFact(!previous || previous.fingerprint === fact.fingerprint && previous.directory === fact.directory && previous.serviceId === fact.serviceId, "Cua", "execution identity changes within ledger");
        latest.set(fact.executionId, fact);
        allCua.set(fact.opId, fact);
      }
    } else if (row.tool_name.startsWith("mcp__") || ["cua_connection", "cua_recovery_observe"].includes(row.tool_name)) {
      requireFact(unconsumed, "MCP", "missing versioned execution evidence");
    }
  }
  for (const fact of latest.values()) requireFact(fact.stopped && ["closed", "recovered", "frozen"].includes(fact.state), "Cua", "latest execution has no stopped receipt");
  for (const fact of allCua.values()) {
    if (fact.recovers) requireFact(allCua.has(fact.recovers) && allCua.get(fact.recovers)!.executionId !== fact.executionId, "Cua", "orphan recovery execution");
    if (fact.observation) requireFact(allCua.get(fact.observation)?.recovers === fact.opId, "Cua", "recovery observation does not match");
    if (fact.state === "recovered") requireFact(fact.stopped && fact.observation !== undefined, "Cua", "recovered record lacks stop and observation");
  }
}

/** Inspects only an already-private coherent copy. The caller owns original-profile exclusion and copy cleanup. */
export function inspectSharedPredecessor(copyDatabasePath: string, context?: { dataDir: string }): void {
  let db: DatabaseSync;
  try { db = new DatabaseSync(copyDatabasePath, { readOnly: true }); }
  catch { reject("database", "cannot open copied database", "old_profile_unrecognized"); }
  try {
    const marker = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    if (marker?.value !== "58") reject("database", "unsupported schema version", marker ? "old_profile_version_unsupported" : "old_profile_unrecognized");
    const snapshot = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all().map(row => [row.type, row.name, row.tbl_name, row.sql]);
    if (createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") !== SCHEMA_SHA256) reject("database", "schema fingerprint differs", "old_profile_unrecognized");
    const metadata = new Map(db.prepare("SELECT key,value FROM meta WHERE key IN ('product.type','instance_id')").all().map(row => [String(row.key), row.value]));
    if (!["ruukoto", "ruukoto-code"].includes(String(metadata.get("product.type"))) || !UUID.test(String(metadata.get("instance_id")))) reject("database", "missing product or instance identity", "old_profile_unrecognized");
    if (db.prepare("PRAGMA quick_check").all().some(row => row.quick_check !== "ok") || db.prepare("PRAGMA foreign_key_check").get()) reject("database", "corrupt or orphan records", "old_profile_unrecognized");
    const sessions = new Set(db.prepare("SELECT id FROM sessions").all().map(row => String(row.id)));
    inspectMetadata(db, sessions, context?.dataDir);
    requireFact(!db.prepare("SELECT 1 FROM occupancy LIMIT 1").get(), "occupancy", "directory ownership remains, regardless of backend or task state");
    const tasks = inspectTasks(db);
    for (const row of db.prepare("SELECT id,state,current_task_id,active_work_id,parent_session_id FROM sub_agents").iterate()) {
      requireFact(row.state === "idle" && row.current_task_id === null, "SubAgent", "execution ownership remains");
      if (row.active_work_id !== null) requireFact(db.prepare("SELECT 1 FROM work_delegations WHERE id=? AND sub_agent_id=? AND parent_session_id=?").get(row.active_work_id, row.id, row.parent_session_id), "SubAgent", "orphan work binding");
    }
    inspectWorkflows(db, tasks);
    inspectTools(db, tasks, inspectBackground(db, tasks), context?.dataDir);
    // Ordinary native execution has no separate stop table: terminal task plus released
    // occupancy is its frozen barrier. Historical PIDs, exit codes and unknown effects
    // never replace the explicit receipts required by independently owned resources.
    requireFact(!db.prepare("SELECT 1 FROM compaction_requests WHERE status='running' LIMIT 1").get(), "compaction", "execution remains running");
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    reject("database", "cannot interpret copied records", "old_profile_unrecognized");
  } finally { db.close(); }
}
