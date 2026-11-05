import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { once } from "node:events";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, defineTask, defineExtension, ROOT_CONVERSATION_ID, type TaskId, type SubmissionId } from "@earendil-works/pi-durable";
import { recordedModels, personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalToolDoc, PersonalToolsDoc, ToolAdmission, toolOperation, toolUnresolved, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { personalDesktopActions, personalDesktopTarget, parsePersonalDesktopAction, PersonalDesktopActionDoc } from "../apps/ruukoto/src/personal-desktop-actions.ts";
import { PersonalOwnerClaim, verifyPersonalOwnerClaim } from "../apps/ruukoto/src/personal-recovery-claims.ts";
import { personalAppData, PersonalAppDataDoc, PersonalAppDataOperationDoc, AppDataAdmission, AppDataObservation } from "../apps/ruukoto/src/personal-app-data.ts";
import type { PersonalDesktopAction } from "@ruukoto/view/personal-protocol.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalCommandDoc, CommandAdmission, CommandObservation, personalCommand, personalCommandWork, type PersonalCommandRef } from "../apps/ruukoto/src/personal-command-work.ts";
import { PersonalInspectionDoc, PersonalPendingInspectionsDoc, ServiceInspectionAdmission, ServiceInspectionEntry, ServiceInspectionStopEntry } from "../apps/ruukoto/src/personal-service-inspection.ts";
import { PersonalMcpDoc, PersonalMcpConfigDoc, McpAdmission } from "../apps/ruukoto/src/personal-mcp.ts";
import { parsePersonalMcp } from "../apps/ruukoto/src/personal-mcp-config.ts";
import type { ServiceInspectionId } from "../apps/ruukoto/src/service-helper.ts";
import { personalBackground, PersonalBackgroundDoc, PersonalBackgroundProcessDoc } from "../apps/ruukoto/src/personal-background-processes.ts";
import { acquirePersonalDirectory } from "../apps/ruukoto/src/personal-directory-claims.ts";

const context = BACKGROUND_CONTEXT;
async function fixture(t: TestContext, endpoint = "http://127.0.0.1:1/old", serviceOverrides: Partial<import("../apps/ruukoto/src/personal-desktop-actions.ts").PersonalDesktopActionServices> = {}) {
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "RECOVERY_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => assert.fail("Recovery never calls a model"));
  let harness!: Harness;
  const appData = personalAppData("/tmp/unused-action-profile", () => harness), actions = personalDesktopActions("/tmp/unused-action-profile", () => harness, () => ({ appData, ...serviceOverrides }));
  const registry = createRegistry(); registry.install(actions.extension);
  harness = await Harness.open(new MemoryStorage(), { registry, models }, context); await harness.root(context);
  t.after(async () => { await harness.close(context); await appData.close(); });
  const operation = 100 as TaskId;
  const admission = await harness.commit(async tx => {
    const original = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "Original write", timestamp: 1 }] })).id;
    const origin = { conversationId: ROOT_CONVERSATION_ID, generation: 99 as TaskId, inputs: [], sources: [], source: { entryId: original, requestId: "original", submissionId: 1 as SubmissionId }, permission: { mode: "confirm" as const, version: 1 } };
    const admitted = { operation, origin, kind: "http_request" as const, params: { method: "POST", url: endpoint, body: "original-write" }, prepared: { kind: "http" as const, request: { method: "POST", url: endpoint, body: "original-write", headers: {}, pinnedAddress: "127.0.0.1", pinnedFamily: 4 } }, grantVersion: 1, approval: "approved" as const };
    const entry = await tx.appendEntry(ToolAdmission, ROOT_CONVERSATION_ID, { data: admitted });
    (await tx.doc(PersonalToolsDoc)).operations.push(operation);
    (await tx.doc(PersonalToolDoc, String(operation), null)).operation = { ...admitted, admission: entry.id, started: true, stopped: false, effect: "effect_unknown", code: "http_timeout" };
    return entry.id;
  }, context);
  const input = (action: PersonalDesktopAction["action"], extra: Partial<PersonalDesktopAction> = {}): PersonalDesktopAction => ({ v: 1, requestId: randomUUID(), family: "tools", operation, admission, occurrence: admission, action, ...extra });
  return { registry, harness, actions, operation, admission, input };
}
async function until(check: () => Promise<boolean>) { const end = Date.now() + 5000; while (!await check()) { assert.ok(Date.now() < end, "Recovery action deadline"); await new Promise(resolve => setTimeout(resolve, 5)); } }

test("Native effect claims need no evidence, consume once, preserve unknown stopping and retain provenance", async t => {
  const f = await fixture(t), request = f.input("claim_applied"), credential = randomUUID();
  const value = await f.harness.commit(tx => f.actions.admit(tx, request, { kind: "native", credential }), context);
  assert.equal(value.state, "completed"); assert.deepEqual(value.request, request);
  const operation = await f.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))), context);
  assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, false); assert.equal(toolUnresolved(operation), true);
  assert.equal(operation.resolution?.evidence, undefined); assert.ok(operation.resolution?.claim);
  const claim = await f.harness.commit(tx => verifyPersonalOwnerClaim(tx, operation.resolution!.claim!, { family: "tools", operation: f.operation, admission: f.admission, effect: "applied" }), context);
  assert.deepEqual(claim.actor, { kind: "native", credential }); assert.equal(claim.action, value.entry); assert.equal(claim.occurrence, f.admission); assert.ok(claim.at > 0);
  assert.deepEqual(await f.harness.commit(tx => f.actions.admit(tx, request, { kind: "native", credential }), context), value);
  await assert.rejects(f.harness.commit(tx => f.actions.admit(tx, f.input("claim_not_applied")), context), { code: "desktop_action_unavailable" });
  await assert.rejects(f.harness.commit(tx => f.actions.admit(tx, { ...request, occurrence: f.admission + 1 }, { kind: "native", credential }), context), { code: "desktop_action_conflict" });
  const target = await f.harness.commit(async tx => JSON.parse(JSON.stringify(await personalDesktopTarget(tx, "tools", f.operation))), context); assert.equal(target.summary.claim?.effect, "applied");
  await f.harness.commit(tx => f.actions.verify(tx, true), context);
  const entries = await f.harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100), context); assert.equal(entries.items.filter(PersonalOwnerClaim.is).length, 1);
});

test("A fixed URL check uses HEAD on the original target and remains an observation after an owner claim", async t => {
  const methods: string[] = [], urls: string[] = [];
  const server = http.createServer((request, response) => { methods.push(request.method!); urls.push(request.url!); response.writeHead(204).end(); }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const f = await fixture(t, `http://127.0.0.1:${address.port}/original`), request = f.input("check");
  const value = await f.harness.commit(tx => f.actions.admit(tx, request), context); assert.equal(value.state, "admitted");
  await assert.rejects(f.harness.commit(tx => f.actions.admit(tx, f.input("check")), context), { code: "desktop_action_unavailable" });
  f.harness.resume();
  await until(async () => (await f.harness.commit(tx => f.actions.receipt(tx, request.requestId), context))?.state !== "admitted");
  const checked = (await f.harness.commit(tx => f.actions.receipt(tx, request.requestId), context))!;
  assert.equal(checked.state, "completed"); assert.equal(checked.check?.kind, "observation"); assert.deepEqual(methods, ["HEAD"]); assert.deepEqual(urls, ["/original"]);
  const op = await f.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))), context); assert.equal(op.effect, "effect_unknown"); assert.equal(op.stopped, false);
  await f.harness.commit(tx => f.actions.admit(tx, f.input("claim_not_applied", { check: checked.check!.entry })), context);
  await f.harness.commit(tx => f.actions.verify(tx, true), context);
  const replay = await f.harness.commit(tx => f.actions.admit(tx, request), context); assert.deepEqual(replay, checked); assert.equal(methods.length, 1);
});

test("Native affirmative choices cannot decide an IM-origin recovery card", async t => {
  const f = await fixture(t);
  await f.harness.commit(async tx => { (await toolOperation(tx, f.operation)).origin.telegram = { botId: "bot", ownerId: "owner", generation: "entry", mode: "confirm", version: 1 }; }, context);
  await assert.rejects(f.harness.commit(tx => f.actions.admit(tx, f.input("claim_applied")), context), { code: "desktop_action_original_entry" });
  assert.equal((await f.harness.snapshot(PersonalDesktopActionDoc, f.input("check").requestId, context))?.action, undefined);
  assert.throws(() => parsePersonalDesktopAction({ ...f.input("check"), command: "replay old write" }), error => error instanceof PersonalError && error.code === "desktop_action_invalid");
});

test("A check settles its original receipt when the final target becomes unavailable", async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let saved: PersonalToolOperation;
  const server = http.createServer((_request, response) => {
    void f.harness.commit(async tx => { saved = JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))) as PersonalToolOperation; delete (await tx.doc(PersonalToolDoc, String(f.operation), null)).operation; }, context).then(() => response.writeHead(204).end());
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  f = await fixture(t, `http://127.0.0.1:${address.port}/original`);
  const request = f.input("check"); await f.harness.commit(tx => f.actions.admit(tx, request), context); f.harness.resume();
  await until(async () => (await f.harness.commit(tx => f.actions.receipt(tx, request.requestId), context))?.state !== "admitted");
  const receipt = (await f.harness.commit(tx => f.actions.receipt(tx, request.requestId), context))!;
  assert.equal(receipt.state, "completed"); assert.equal(receipt.check?.kind, "observation");
  await f.harness.commit(async tx => { (await tx.doc(PersonalToolDoc, String(f.operation), null)).operation = saved; }, context);
  await f.harness.commit(tx => f.actions.verify(tx, true), context);
});

test("Original command recovery history retains terminal receipt reconciliation without exposing healthy commands", async t => {
  type Result = NonNullable<Awaited<ReturnType<typeof personalCommand>>["result"]>;
  const f = await fixture(t), task = defineTask<{ requestId: string }, { phase: "run" }, Result>({ name: "ruukoto.command", version: 1, initial: () => ({ phase: "run" }), phases: { async run(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { effect: "returned", code: "command_returned", exitCode: 0 } } }), callContext); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
  const workTask = defineTask<null, { phase: "run" }, { submissionId: SubmissionId }>({ name: "test.command-work", version: 1, initial: () => ({ phase: "run" }), phases: { async run() { assert.fail("Projection does not execute work"); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
  f.registry.install(defineExtension({ name: "test-command-history", tasks: [task, workTask] }));
  const tokens = await f.harness.commit(async tx => { const workId = await tx.createTask(workTask, null, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }); const refs: PersonalCommandRef[] = []; for (const requestId of ["unknown", "stopping", "healthy"]) refs.push({ requestId, taskId: await tx.createTask(task, { requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) }); return { work: { requestId: "original-work", taskId: workId, agentId: ROOT_CONVERSATION_ID }, refs }; }, context), refs = tokens.refs;
  const add = (ref: PersonalCommandRef, foreignRef: PersonalCommandRef, mode: "unknown" | "stopping" | "healthy") => f.harness.commit(async tx => {
    const work = { ref: tokens.work, inputs: [], sources: [], tool: ref.taskId, generation: ref.taskId, permission: { mode: "full_access" as const, version: 1 } }, execution = { executionId: `execution-${ref.taskId}`, machineId: "original-machine" };
    const admission = (await tx.appendEntry(CommandAdmission, ROOT_CONVERSATION_ID, { data: { ref, command: "original-command", execution, work } })).id;
    const prepared = { spec: { taskId: `personal-command:${ref.taskId}`, mode: "full_access" as const, workspace: "/tmp/original", grantedPaths: [] }, input: { workspace: "/tmp/original", mounts: [], runtimeReadRoots: [], toolAliases: [], env: {}, tempDir: "/tmp/original-launch", nodePath: process.execPath, workerPath: "/tmp/original-worker" }, fingerprint: `fingerprint-${ref.taskId}` };
    await tx.appendEntry(CommandObservation, ROOT_CONVERSATION_ID, { data: { ref: foreignRef, execution, fingerprint: prepared.fingerprint, result: { effect: "effect_unknown", code: "interrupted" }, stopped: false } });
    const result = mode === "unknown" ? { effect: "effect_unknown" as const, code: "interrupted" } : { effect: "returned" as const, code: "command_returned", exitCode: 0 }, stopped = mode === "healthy";
    const observation = (await tx.appendEntry(CommandObservation, ROOT_CONVERSATION_ID, { data: { ref, execution, fingerprint: prepared.fingerprint, result, stopped } })).id;
    (await tx.doc(PersonalCommandDoc, ref.requestId, null)).command = { ref, command: "original-command", execution, work, admission, prepared, started: true, stopped, cancelRequested: false, result, observation };
  }, context);
  await add(refs[0], refs[1], "unknown"); await add(refs[1], refs[2], "stopping"); await add(refs[2], refs[0], "healthy");
  for (const ref of refs.slice(0, 2)) {
    assert.equal((await f.harness.commit(tx => personalDesktopTarget(tx, "commands", ref.taskId), context)).retained, true);
    await f.harness.commit(async tx => { const value = (await tx.doc(PersonalCommandDoc, ref.requestId, null)).command!; value.result = { effect: "returned", code: "command_returned", exitCode: 0 }; value.stopped = true; value.observation = (await tx.appendEntry(CommandObservation, ROOT_CONVERSATION_ID, { data: { ref, execution: value.execution, fingerprint: value.prepared!.fingerprint, result: value.result, stopped: true } })).id; }, context);
    const after = await f.harness.commit(tx => personalDesktopTarget(tx, "commands", ref.taskId), context); assert.equal(after.retained, true); assert.equal(after.summary.effect, "returned"); assert.equal(after.summary.stopped, true);
  }
  assert.equal((await f.harness.commit(tx => personalDesktopTarget(tx, "commands", refs[2].taskId), context)).retained, undefined);
});

test("Application-data recovery retains its original unknown receipt while healthy in-flight writes stay implicit", async t => {
  const f = await fixture(t), task = defineTask<null, { phase: "run" }, null>({ name: "test.app-data-write", version: 1, initial: () => ({ phase: "run" }), phases: { async run(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), callContext); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
  f.registry.install(defineExtension({ name: "test-app-data-history", tasks: [task] }));
  const operations = await f.harness.commit(async tx => {
    const ids = []; for (let i = 0; i < 2; i++) ids.push(await tx.createTask(task, null, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }));
    const origin = JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))).origin as PersonalToolOperation["origin"];
    const doc = await tx.doc(PersonalAppDataDoc); doc.instanceId = "original-instance";
    for (const operation of ids) {
      const data = { operation, opId: `durable:${operation}`, name: "app_data_insert" as const, params: { table: "original-table", rows: [], reason: "original" }, fingerprint: `original-${operation}`, origin, instanceId: doc.instanceId, versions: { schemaVersion: 1, revision: 1 }, destructive: false };
      const admission = (await tx.appendEntry(AppDataAdmission, ROOT_CONVERSATION_ID, { data })).id, started = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.app-data-start" })).id;
      (await tx.doc(PersonalAppDataOperationDoc, String(operation), null)).operation = { ...data, admission, started, decision: "unneeded" }; doc.operations.push(operation);
    }
    return ids;
  }, context);
  const healthy = await f.harness.commit(tx => personalDesktopTarget(tx, "app-data", operations[0]), context); assert.equal(healthy.summary.code, "started"); assert.equal(healthy.retained, undefined);
  await f.harness.commit(async tx => { const value = (await tx.doc(PersonalAppDataOperationDoc, String(operations[1]), null)).operation!; value.result = { effect: "effect_unknown", code: "app_data_receipt_invalid", op_id: value.opId }; value.observation = (await tx.appendEntry(AppDataObservation, ROOT_CONVERSATION_ID, { data: { operation: value.operation, result: value.result } })).id; }, context);
  assert.equal((await f.harness.commit(tx => personalDesktopTarget(tx, "app-data", operations[1]), context)).retained, true);
  for (const operation of operations) await f.harness.commit(async tx => { const value = (await tx.doc(PersonalAppDataOperationDoc, String(operation), null)).operation!; value.result = { effect: "committed", code: "committed", op_id: value.opId }; value.observation = (await tx.appendEntry(AppDataObservation, ROOT_CONVERSATION_ID, { data: { operation, result: value.result } })).id; }, context);
  assert.equal((await f.harness.commit(tx => personalDesktopTarget(tx, "app-data", operations[0]), context)).retained, undefined);
  const recovered = await f.harness.commit(tx => personalDesktopTarget(tx, "app-data", operations[1]), context); assert.equal(recovered.retained, true); assert.equal(recovered.summary.effect, "committed"); assert.ok(!recovered.summary.actions?.includes("claim_applied"));
});

test("Inspection recovery retains an exact failed stop after automatic success and hides healthy stops", async t => {
  const f = await fixture(t), task = defineTask<null, { phase: "run" }, null>({ name: "test.inspection-history", version: 1, initial: () => ({ phase: "run" }), phases: { async run(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), callContext); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
  f.registry.install(defineExtension({ name: "test-inspection-history", tasks: [task] }));
  const operations = await f.harness.commit(async tx => { const ids = []; for (let i = 0; i < 3; i++) ids.push(await tx.createTask(task, null, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true })); return ids; }, context);
  f.harness.resume(); for (const operation of operations) await f.harness.waitForTask(operation, context);
  for (const [index, operation] of operations.entries()) await f.harness.commit(async tx => {
    const inspectionId: ServiceInspectionId = `inspect_${String(operation).padStart(24, "0")}`, machineId = "original-machine";
    const identity = { taskId: operation, conversationId: ROOT_CONVERSATION_ID, taskKind: task.definition.name, unit: "original.service", machineId, inspectionId, sources: [] };
    const admission = (await tx.appendEntry(ServiceInspectionAdmission, ROOT_CONVERSATION_ID, { data: identity })).id;
    const evidence = (await tx.appendEntry(ServiceInspectionEntry, ROOT_CONVERSATION_ID, { data: { unit: identity.unit, inspectionId, machineId, admission, stdout: "", stderr: "", truncated: false, code: "ok" } })).id;
    const capture = { stdout: "", stderr: "", truncated: false, code: "ok" };
    let stopEvidence;
    if (index < 2) await tx.appendEntry(ServiceInspectionStopEntry, ROOT_CONVERSATION_ID, { data: { inspectionId, machineId, ...capture, ...(index === 0 ? { reply: { v: 1, ok: true, verb: "stop-inspect", inspectionId, machineId, exited: false } } : {}) } });
    else {
      await tx.appendEntry(ServiceInspectionStopEntry, ROOT_CONVERSATION_ID, { data: { inspectionId, machineId: "other-machine", ...capture } });
      await tx.appendEntry(ServiceInspectionStopEntry, ROOT_CONVERSATION_ID, { data: { inspectionId: "inspect_ffffffffffffffffffffffff", machineId, ...capture } });
      stopEvidence = (await tx.appendEntry(ServiceInspectionStopEntry, ROOT_CONVERSATION_ID, { data: { inspectionId, machineId, ...capture, reply: { v: 1, ok: true, verb: "stop-inspect", inspectionId, machineId, exited: true } } })).id;
    }
    (await tx.doc(PersonalInspectionDoc, String(operation), null)).inspection = { ...identity, admission, stopped: index === 2, ...(stopEvidence ? { stopEvidence } : {}), result: { evidence, code: "ok" } };
    if (index < 2) (await tx.doc(PersonalPendingInspectionsDoc)).tasks.push(operation);
  }, context);
  for (const operation of operations.slice(0, 2)) {
    const before = await f.harness.commit(tx => personalDesktopTarget(tx, "inspections", operation), context); assert.equal(before.retained, true); assert.ok(before.summary.actions?.includes("cleanup"));
    await f.harness.commit(async tx => { const value = (await tx.doc(PersonalInspectionDoc, String(operation), null)).inspection!; value.stopEvidence = (await tx.appendEntry(ServiceInspectionStopEntry, value.conversationId, { data: { inspectionId: value.inspectionId, machineId: value.machineId, stdout: "", stderr: "", truncated: false, code: "ok", reply: { v: 1, ok: true, verb: "stop-inspect", inspectionId: value.inspectionId, machineId: value.machineId, exited: true } } })).id; value.stopped = true; const pending = await tx.doc(PersonalPendingInspectionsDoc); pending.tasks = pending.tasks.filter(id => id !== operation); }, context);
    const after = await f.harness.commit(tx => personalDesktopTarget(tx, "inspections", operation), context); assert.equal(after.retained, true); assert.equal(after.summary.code, "inspection_stopped"); assert.equal(after.summary.stopped, true); assert.ok(!after.summary.actions?.includes("cleanup"));
  }
  assert.equal((await f.harness.commit(tx => personalDesktopTarget(tx, "inspections", operations[2]), context)).retained, undefined);
});

test("Cua CLI stop recovery retains its pending marker after automatic cleanup and hides healthy stops", async t => {
  const f = await fixture(t), config = parsePersonalMcp({ version: 3, generation: "original-cua", services: [{ id: "desktop", label: "Computer", cua: { kind: "cua-linux", executable: "/usr/local/bin/cua", version: "0.7.0", sha256: "a".repeat(64), sandbox: "local:desktop", sandboxId: "b".repeat(64) }, enabled: true, tools: [{ name: "computer_screenshot", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }] });
  const operations = [101, 102] as TaskId[];
  const origin = (await f.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))) as PersonalToolOperation, context)).origin;
  for (const [index, operation] of operations.entries()) await f.harness.commit(async tx => {
    const data = { operation, origin, config, service: "desktop", tool: "computer_screenshot", args: {}, localEffect: "read" as const };
    const admission = (await tx.appendEntry(McpAdmission, ROOT_CONVERSATION_ID, { data })).id, launch = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.mcp-cua-launch", data: { operation, scope: `original-${operation}`, description: "original" } })).id;
    const evidence = { request: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_screenshot", arguments: {} } }), response: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "original scene" }] } }) };
    const observation = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.mcp-observation", data: { operation, admission, evidence, effect: "returned", code: "returned", remoteEnded: true } })).id;
    const cuaStopPending = index === 0 ? (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.mcp-cua-stop-pending", data: { operation, launches: [launch] } })).id : undefined;
    const stopped = index === 1 ? (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.mcp-cua-launch-stopped", data: { operation, launch } })).id : undefined;
    (await tx.doc(PersonalMcpDoc, String(operation), null)).operation = { ...data, admission, decision: "approved", started: true, remoteEnded: true, effect: "returned", code: "returned", evidence, observation, cuaLaunches: [{ entry: launch, scope: `original-${operation}`, description: "original", ...(stopped ? { stopped } : {}) }], ...(cuaStopPending ? { cuaStopPending } : {}) };
    const doc = await tx.doc(PersonalMcpConfigDoc); doc.config = config; doc.operations.push(operation);
  }, context);
  const before = await f.harness.commit(tx => personalDesktopTarget(tx, "mcp", operations[0]), context); assert.ok(before.summary.actions?.includes("cleanup"));
  await f.harness.commit(async tx => { const value = (await tx.doc(PersonalMcpDoc, String(operations[0]), null)).operation!, launch = value.cuaLaunches![0]; launch.stopped = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.mcp-cua-launch-stopped", data: { operation: value.operation, launch: launch.entry } })).id; }, context);
  const after = await f.harness.commit(tx => personalDesktopTarget(tx, "mcp", operations[0]), context); assert.equal(after.retained, true); assert.equal(after.summary.stopped, true); assert.ok(!after.summary.actions?.includes("cleanup"));
  assert.equal((await f.harness.commit(tx => personalDesktopTarget(tx, "mcp", operations[1]), context)).retained, undefined);
});

test("Full-access MCP admission and healthy completion offer no approval or recovery card", async t => {
  const f = await fixture(t), operation = 101 as TaskId, config = parsePersonalMcp({ version: 4, generation: "original-mcp", services: [{ id: "original", label: "Original", endpoint: "http://127.0.0.1:9/mcp", enabled: true, toolEffects: { write: "write" }, tools: [{ name: "write", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }] });
  await f.harness.commit(async tx => {
    const origin = JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))).origin as PersonalToolOperation["origin"]; origin.permission.mode = "full_access";
    const data = { operation, origin, config, service: "original", tool: "write", args: {}, localEffect: "write" as const, recordVersion: 2 as const }, admission = (await tx.appendEntry(McpAdmission, ROOT_CONVERSATION_ID, { data })).id;
    (await tx.doc(PersonalMcpDoc, String(operation), null)).operation = { ...data, admission, decision: "pending", started: false, remoteEnded: false, effect: "not_executed", code: "awaiting_approval", evidence: {} };
    const doc = await tx.doc(PersonalMcpConfigDoc); doc.config = config; doc.operations.push(operation);
  }, context);
  for (const phase of ["admitted", "started", "returned"]) {
    if (phase !== "admitted") await f.harness.commit(async tx => { const value = (await tx.doc(PersonalMcpDoc, String(operation), null)).operation!; value.started = true; value.effect = phase === "started" ? "effect_unknown" : "returned"; value.code = phase; if (phase === "returned") { value.remoteEnded = true; value.observation = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.mcp-result", data: { operation, admission: value.admission, effect: value.effect, code: value.code, remoteEnded: true } })).id; } }, context);
    const target = await f.harness.commit(tx => personalDesktopTarget(tx, "mcp", operation), context); assert.equal(target.summary.approval, "unneeded"); assert.equal(target.summary.canDecide, false); assert.equal(target.retained, undefined); assert.ok(!target.summary.actions?.includes("approve")); assert.ok(!target.summary.actions?.includes("reject"));
    await assert.rejects(f.harness.commit(tx => f.actions.admit(tx, { v: 1, requestId: randomUUID(), family: "mcp", operation, admission: target.summary.admission, occurrence: target.summary.occurrence, action: "approve" }), context), { code: "desktop_action_unavailable" });
  }
  assert.equal((await f.harness.snapshot(PersonalMcpDoc, String(operation), context))!.operation!.decision, "pending");
});

test("Native background checks and command cleanup keep original scalar facts beyond their transaction", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rk-native-background-"))), workspace = path.join(root, "work"), profile = path.join(root, "profile"); fs.mkdirSync(workspace); fs.mkdirSync(profile);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, machineId = "a".repeat(32), read = nodeFs.readFileSync;
  Object.defineProperty(process, "platform", { value: "linux" }); t.mock.method(nodeFs, "readFileSync", (file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => file === "/etc/machine-id" ? machineId + "\n" : read(file, options)); syncBuiltinESMExports();
  let background!: ReturnType<typeof personalBackground>;
  let commands!: ReturnType<typeof personalCommandWork>;
  const f = await fixture(t, undefined, { get background() { return background; }, get commands() { return commands; } }), identity = fs.statSync(workspace), config = { version: 1 as const, workspace, identity: { dev: identity.dev, ino: identity.ino }, machineId, tmpdir: fs.realpathSync(os.tmpdir()) };
  background = personalBackground(profile, config, () => f.harness); f.registry.install(background.extension); commands = personalCommandWork(profile, config);
  try {
    const admission = await f.harness.commit(async tx => {
      const origin = JSON.parse(JSON.stringify(await toolOperation(tx, f.operation))).origin as PersonalToolOperation["origin"], directory = { path: workspace, dev: identity.dev, ino: identity.ino };
      const admission = (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.background-admission" })).id, claim = await acquirePersonalDirectory(tx, { kind: "background", operation: f.operation }, directory);
      (await tx.doc(PersonalBackgroundProcessDoc, "process_original", null)).process = { id: "process_original", operation: f.operation, taskId: f.operation, command: "original-command", origin, config: { version: 1, workspace, identity: { dev: identity.dev, ino: identity.ino }, machineId, tmpdir: fs.realpathSync(os.tmpdir()) }, directory, admission, accepted: admission, claim, state: "stop_unverified", createdAt: 1, execution: { platform: "linux", executionId: "native_original", machineId }, stopped: false, partial: false, observation: admission };
      (await tx.doc(PersonalBackgroundDoc)).ids.push("process_original"); return admission;
    }, context);
    const request = (action: "check" | "cleanup"): PersonalDesktopAction => ({ v: 1, requestId: randomUUID(), family: "background", operation: f.operation, admission, occurrence: admission, action });
    const cleanup = request("cleanup"); await f.harness.commit(tx => f.actions.admit(tx, cleanup), context); f.harness.resume();
    await until(async () => (await f.harness.commit(tx => f.actions.receipt(tx, cleanup.requestId), context))?.state !== "admitted");
    assert.equal((await f.harness.commit(tx => f.actions.receipt(tx, cleanup.requestId), context))!.state, "completed");
    await until(async () => (await f.harness.snapshot(PersonalBackgroundProcessDoc, "process_original", context))!.process!.stopped);
    const check = request("check"); await f.harness.commit(tx => f.actions.admit(tx, check), context);
    await until(async () => (await f.harness.commit(tx => f.actions.receipt(tx, check.requestId), context))?.state !== "admitted");
    const checked = (await f.harness.commit(tx => f.actions.receipt(tx, check.requestId), context))!; assert.equal(checked.state, "completed"); assert.equal(checked.check?.code, "stopped"); assert.equal(checked.check?.kind, "receipt");
    type Result = NonNullable<Awaited<ReturnType<typeof personalCommand>>["result"]>;
    const task = defineTask<{ requestId: string }, { phase: "run" }, Result>({ name: "ruukoto.command", version: 1, initial: () => ({ phase: "run" }), phases: { async run(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { effect: "effect_unknown", code: "interrupted" } } }), callContext); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
    const workTask = defineTask<null, { phase: "run" }, { submissionId: SubmissionId }>({ name: "test.scalar-command-work", version: 1, initial: () => ({ phase: "run" }), phases: { async run() { assert.fail("Cleanup does not execute work"); } }, async abort(_current, runtime, callContext) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext); } });
    f.registry.install(defineExtension({ name: "test-scalar-command", tasks: [task, workTask] }));
    const ref = await f.harness.commit(async tx => ({ requestId: "scalar-command", taskId: await tx.createTask(task, { requestId: "scalar-command" }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }) }), context); await f.harness.waitForTask(ref.taskId, context);
    const workId = await f.harness.commit(tx => tx.createTask(workTask, null, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" }, background: true }), context);
    await f.harness.commit(async tx => {
      const work = { ref: { requestId: "scalar-work", taskId: workId, agentId: ROOT_CONVERSATION_ID }, inputs: [], sources: [], tool: ref.taskId, generation: ref.taskId, permission: { mode: "full_access" as const, version: 1 } }, execution = { executionId: "scalar-execution", machineId };
      const admission = (await tx.appendEntry(CommandAdmission, ROOT_CONVERSATION_ID, { data: { ref, command: "original-command", execution, work } })).id, result = { effect: "effect_unknown" as const, code: "interrupted" };
      const prepared = { spec: { taskId: `personal-command:${ref.taskId}`, mode: "full_access" as const, workspace, grantedPaths: [] }, input: { workspace, mounts: [], runtimeReadRoots: [], toolAliases: [], env: {}, tempDir: root, nodePath: process.execPath, workerPath: commands.workerPath }, fingerprint: "original-fingerprint" };
      const observation = (await tx.appendEntry(CommandObservation, ROOT_CONVERSATION_ID, { data: { ref, execution, fingerprint: prepared.fingerprint, result, stopped: false } })).id;
      (await tx.doc(PersonalCommandDoc, ref.requestId, null)).command = { ref, command: "original-command", execution, work, admission, prepared, started: true, stopped: false, cancelRequested: false, result, observation };
    }, context);
    t.mock.method(commands, "reconcile", async (_harness: Parameters<typeof commands.reconcile>[0], original: PersonalCommandRef, callContext: Parameters<typeof commands.reconcile>[2]) => { assert.deepEqual(original, ref); await f.harness.commit(async tx => { const value = await personalCommand(tx, original); value.stopped = true; value.observation = (await tx.appendEntry(CommandObservation, ROOT_CONVERSATION_ID, { data: { ref: original, execution: value.execution, fingerprint: value.prepared!.fingerprint, result: value.result!, stopped: true } })).id; return undefined; }, callContext); });
    const target = await f.harness.commit(tx => personalDesktopTarget(tx, "commands", ref.taskId), context), command: PersonalDesktopAction = { v: 1, requestId: randomUUID(), family: "commands", operation: ref.taskId, admission: target.summary.admission, occurrence: target.summary.occurrence, action: "cleanup" };
    await f.harness.commit(tx => f.actions.admit(tx, command), context); await until(async () => (await f.harness.commit(tx => f.actions.receipt(tx, command.requestId), context))?.state !== "admitted");
    assert.equal((await f.harness.commit(tx => f.actions.receipt(tx, command.requestId), context))!.state, "completed");
  } finally { await background.close(); Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});
