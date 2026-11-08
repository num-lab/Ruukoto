import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpParams } from "@ruukoto/control/ops.ts";
import { ControlClientError } from "@ruukoto/control/client.ts";
import { PendingRequestStore, type PendingRequest } from "@ruukoto/control/pending-requests.ts";
import type { SessionCompactionRequest } from "@ruukoto/core/types.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { DesktopSubmissions } from "../apps/desktop/src/main/submissions.ts";
import { DESKTOP_OPS, ipcResult } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge, DesktopCompactionResult, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { DesktopCompactions } from "../apps/desktop/src/renderer/compaction-state.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";

const at = "2026-11-08T00:00:00.000Z";
function receipt(status: SessionCompactionRequest["status"] = "running", requestId = "compact-1"): SessionCompactionRequest {
  return { requestId, sessionId: "session-1", prompt: "Preserve the goal\nand open work", paramsDigest: "digest", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, summaryModel: { provider: "mock", modelId: "summary" }, source: null, expectedCheckpointId: null, status, checkpointId: status === "succeeded" ? "checkpoint" : null, summarizedCount: 3, estimateBefore: status === "running" ? null : 1000, estimateAfter: status === "running" ? null : 400, errorCode: null, errorMessage: null, createdAt: at, endedAt: status === "running" ? null : at };
}
function pending(instanceId = "inst-1"): PendingRequest { return { requestId: "compact-1", op: "compact_session", instanceId, params: { session_id: "session-1", request_id: "compact-1", prompt: receipt().prompt }, createdAt: at }; }
function host(handlers: FakeHandlers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-desktop-compact-"));
  const store = new PendingRequestStore(dir), transport = new FakeTransport({ handlers });
  const connection = { instanceId: "inst-1", request: transport.request.bind(transport) };
  const updates: DesktopUpdate[] = [];
  const submissions = new DesktopSubmissions(store, () => connection, update => updates.push(update), connection.request);
  return { store, transport, connection, submissions, updates, close() { submissions.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function renderer(request: DesktopBridge["request"]) {
  const view = new ViewState(); view.applySnapshot({ snapshot: fakeSnapshot(), replay: [], seq: 0 }, false);
  let online = true;
  const compactions = new DesktopCompactions({ request }, view, () => online, () => {});
  return { view, compactions, offline() { online = false; } };
}

test("Desktop exposes only the existing manual compaction operations", () => {
  for (const op of ["compact_session", "get_session_compaction", "interrupt_session_compaction"] as const) assert.ok(DESKTOP_OPS.includes(op));
});

test("native compaction journals before sending and recovers a lost response without another model request", async () => {
  let accepted: SessionCompactionRequest | null = null, calls = 0;
  const h = host({ compact_session(params) {
    assert.equal(h.store.read(params.request_id).kind, "record");
    accepted = receipt("running", params.request_id); calls++;
    throw new ControlClientError("timeout", "response lost", "unknown");
  }, get_session_compaction(params) { assert.equal(params.request_id, "compact-1"); return accepted; } });
  try {
    const result = await h.submissions.compact(pending().params as OpParams<"compact_session">);
    assert.equal(result.outcome.kind, "pending_verification");
    await h.submissions.reconcile();
    assert.equal(calls, 1); assert.equal(h.store.read("compact-1").kind, "record");
    assert.ok(h.updates.some(update => update.type === "pending" && update.entries.some(entry => entry.record.op === "compact_session")));
    accepted = receipt("succeeded");
    await h.submissions.reconcile();
    assert.equal(h.store.read("compact-1").kind, "absent");
    assert.ok(h.updates.some(update => update.type === "compaction" && update.result.outcome.kind === "accepted" && update.result.outcome.request.status === "succeeded"));
  } finally { h.close(); }
});

test("native cold reopening queries the original key and retains foreign-instance operations", async () => {
  const h = host({ get_session_compaction(params) { assert.equal(params.request_id, "compact-1"); return receipt("interrupted"); } });
  try {
    h.store.save(pending()); h.submissions.close();
    const reopened = new DesktopSubmissions(new PendingRequestStore(h.store.dir), () => h.connection, update => h.updates.push(update), h.connection.request);
    await reopened.reconcile();
    assert.equal(h.transport.requests.length, 1); assert.equal(h.transport.requests[0].op, "get_session_compaction");
    assert.equal(h.store.read("compact-1").kind, "absent");
    h.store.save(pending("original-instance"));
    await reopened.reconcile();
    assert.equal(h.transport.requests.length, 1); assert.equal(h.store.read("compact-1").kind, "record");
    assert.ok(h.updates.some(update => update.type === "compaction" && update.result.outcome.kind === "foreign_instance"));
    reopened.close();
  } finally { h.close(); }
});

test("a missing receipt requires an explicit retry with the saved key and guidance; a failed query never sends", async () => {
  let missing = false, calls = 0;
  const h = host({ get_session_compaction() { if (!missing) throw new ControlClientError("timeout", "query failed", "unknown"); return null; }, compact_session(params) { calls++; assert.deepEqual(params, pending().params); return receipt("noop"); } });
  try {
    h.store.save(pending()); await h.submissions.reconcile();
    assert.equal(calls, 0); assert.equal(h.store.read("compact-1").kind, "record");
    missing = true; await h.submissions.reconcile();
    assert.equal(calls, 0); assert.equal(h.store.read("compact-1").kind, "record");
    await h.submissions.compact(pending().params as OpParams<"compact_session">);
    assert.equal(calls, 1); assert.equal(h.store.read("compact-1").kind, "absent");
  } finally { h.close(); }
});

test("reconnect never replays a rejected command whose journal cleanup failed", async () => {
  let calls = 0;
  const h = host({ compact_session() { ++calls; throw new ControlClientError("session_busy", "Wait for current work", "rejected"); }, get_session_compaction() { return null; } });
  h.store.clear = () => {};
  try {
    const result = await h.submissions.compact(pending().params as OpParams<"compact_session">);
    assert.equal(result.outcome.kind, "rejected");
    await h.submissions.reconcile();
    assert.equal(calls, 1);
    assert.equal(h.store.read("compact-1").kind, "record");
    assert.ok(h.updates.some(update => update.type === "compaction" && update.result.outcome.kind === "pending_verification"));
  } finally { h.close(); }
});

test("native journal failures never send and known rejection retains no pending operation", async () => {
  const h = host({ compact_session() { throw new ControlClientError("session_busy", "queued task", "rejected"); } });
  try {
    const result = await h.submissions.compact(pending().params as OpParams<"compact_session">);
    assert.equal(result.outcome.kind, "rejected"); assert.equal(h.store.read("compact-1").kind, "absent");
    fs.rmSync(h.store.dir, { recursive: true }); fs.writeFileSync(h.store.dir, "blocked");
    await assert.rejects(h.submissions.compact({ session_id: "session-1", request_id: "compact-2" }));
    assert.equal(h.transport.requests.filter(request => request.op === "compact_session").length, 1);
  } finally { h.close(); }
});

test("renderer retains unknown request identity, fences instances and stops only the original running operation", async () => {
  const requests: { op: string; params: Record<string, unknown> }[] = [];
  let current: SessionCompactionRequest | null = null;
  const h = renderer(async (_target, op, params) => {
    requests.push({ op, params });
    if (op === "compact_session") { current = receipt("running", String(params.request_id)); throw new Error("host response lost"); }
    if (op === "interrupt_session_compaction") { assert.equal(params.request_id, current!.requestId); current = { ...current!, status: "cancelled" }; }
    return { ok: true, value: current };
  });
  assert.equal(await h.compactions.start("session-1", "multiline\nguidance"), false);
  const original = h.compactions.get("session-1").pending!;
  assert.ok(original); assert.equal(h.compactions.occupied("session-1"), true);
  assert.equal(await h.compactions.start("session-1", "another"), false);
  assert.equal(requests.length, 1);
  await h.compactions.load("session-1");
  assert.equal(requests[1].params.request_id, original.requestId);
  assert.equal(h.compactions.get("session-1").request?.status, "running");
  h.offline(); h.compactions.update({ type: "state", state: "reconnecting" });
  assert.equal(requests.filter(request => request.op === "interrupt_session_compaction").length, 0);
  h.view.applySnapshot({ snapshot: fakeSnapshot({ instanceId: "other" }), replay: [], seq: 0 }, true);
  assert.equal(h.compactions.occupied("session-1"), false);
  assert.equal(h.compactions.get("session-1").request, null);
});

test("renderer uses host acceptance and original terminal records for every outcome", async () => {
  let status: SessionCompactionRequest["status"] = "running", requestId = "";
  const h = renderer(async (_target, op, params) => {
    if (op === "compact_session") {
      requestId = String(params.request_id);
      return { ok: true, value: { record: { ...pending(), requestId, params }, outcome: { kind: "accepted", request: receipt(status, requestId) } } satisfies DesktopCompactionResult };
    }
    if (op === "interrupt_session_compaction") status = "cancelled";
    return ipcResult(() => receipt(status, requestId));
  });
  assert.equal(await h.compactions.start("session-1", "focus"), true);
  assert.equal(h.compactions.occupied("session-1"), true);
  await h.compactions.stop("session-1");
  assert.equal(h.compactions.get("session-1").request?.status, "cancelled"); assert.equal(h.compactions.occupied("session-1"), false);
  for (const terminal of ["succeeded", "noop", "failed", "cancelled", "interrupted"] as const) {
    status = terminal; await h.compactions.load("session-1");
    assert.equal(h.compactions.get("session-1").request?.status, terminal); assert.equal(h.compactions.get("session-1").request?.estimateAfter, 400);
  }
});

test("late uncertainty and earlier reads cannot replace a newer compaction receipt", async () => {
  let state: DesktopCompactions;
  let releaseRead!: (value: unknown) => void;
  const h = renderer(async (_target, op, params) => {
    if (op === "get_session_compaction") return new Promise(resolve => { releaseRead = value => resolve({ ok: true, value }); });
    const record = { ...pending(), requestId: String(params.request_id), params };
    state.update({ type: "compaction", result: { record, outcome: { kind: "accepted", request: receipt("succeeded", record.requestId) } } });
    return { ok: true, value: { record, outcome: { kind: "pending_verification", message: "earlier lost response" } } satisfies DesktopCompactionResult };
  });
  state = h.compactions;
  const oldRead = state.load("session-1");
  assert.equal(await state.start("session-1", "new guidance"), true);
  const currentId = state.get("session-1").request!.requestId;
  releaseRead(receipt("running", "older-request"));
  await oldRead;
  assert.equal(state.get("session-1").request?.requestId, currentId);
  assert.equal(state.get("session-1").pending, null);
});

test("older operation receipts and pending records cannot replace a newer terminal result", () => {
  const h = renderer(async () => ({ ok: true, value: null }));
  const newer = { ...receipt("succeeded", "newer"), createdAt: "2026-11-08T00:10:00.000Z", estimateAfter: 250 };
  h.compactions.update({ type: "compaction", result: { record: { ...pending(), requestId: newer.requestId, createdAt: newer.createdAt }, outcome: { kind: "accepted", request: newer } } });
  for (const status of ["running", "succeeded", "failed"] as const) h.compactions.update({ type: "compaction", result: { record: pending(), outcome: { kind: "accepted", request: receipt(status) } } });
  h.compactions.update({ type: "compaction", result: { record: pending(), outcome: { kind: "pending_verification", message: "old request" } } });
  h.compactions.update({ type: "pending", entries: [{ record: pending() }], corrupt: [], dir: "/pending" });
  assert.equal(h.compactions.get("session-1").request?.requestId, "newer");
  assert.equal(h.compactions.get("session-1").request?.estimateAfter, 250);
  assert.equal(h.compactions.occupied("session-1"), false);
});
