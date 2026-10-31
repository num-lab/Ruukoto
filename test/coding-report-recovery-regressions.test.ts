import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { bindAgentReportFallback, getAgentReport, listAgentReports, registerAgentReport } from "@ruukoto/core/agent-wait.ts";
import { Runtime } from "@ruukoto/runtime/runtime.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { fixtureSubAgentDefinition, fixtureSubAgentScope } from "./helpers/subagent-definition.ts";
import { lastUserText, startTestRuntime, waitFor } from "./helpers/testkit.ts";

function latch() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

async function reportInFlight() {
  const first = latch(), second = latch();
  const t = await startTestRuntime("report-proof-regression", async request => {
    if (lastUserText(request) === "ACTIVE") { await first.promise; return { kind: "text", text: "request N" }; }
    await second.promise;
    return { kind: "text", text: "final report" };
  }, { config: { product: product.runtime } });
  const rt = t.runtime, session = (await rt.openWorkspace({ cwd: t.work[0] })).session;
  const origin = rt.store.withTx(() => {
    rt.store.setSessionQueueState(session.id, "paused", "fixture");
    const task = rt.store.insertQueuedTask({ sessionId: session.id, requestId: "origin", input: "owner work", accessMode: "full_access",
      modelSelection: rt.defaultSelection, submissionDigest: "origin" }).task;
    rt.store.transitionTask(task.id, ["queued"], "running");
    return rt.store.getTask(task.id)!;
  });
  const source = rt["workflowSource"](origin.id, false, true);
  rt.store.withTx(() => rt.store.endTask(origin.id, ["running"], "completed"));
  await rt.resumeQueue(session.id);
  const receiver = await rt.submit({ sessionId: session.id, requestId: "receiver", input: "ACTIVE", modelSelection: rt.defaultSelection });
  await waitFor("request N", () => t.server.calls.length === 1);
  const report = rt.store.withTx(() => {
    const sub = rt.store.createSession({ projectId: session.projectId, cwd: session.cwdReal, cwdReal: session.cwdReal,
      cwdDev: session.cwdDev, cwdIno: session.cwdIno, piSessionId: "report-child", confirmTools: [] });
    rt.store.insertSubAgent({ definition: fixtureSubAgentDefinition(), id: "report-agent", parentSessionId: session.id, sessionId: sub.id,
      workDir: sub.cwdReal, activeWorkId: "report-work", currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: sub.createdAt });
    rt.store.insertWorkDelegation({ id: "report-work", parentSessionId: session.id, originTaskId: origin.id, subAgentId: "report-agent",
      requestKey: "report-work", paramsDigest: "report-work", canceledAt: null, canceledBy: null, cancelReason: null, writeTarget: null, createdAt: sub.createdAt });
    const child = rt.store.insertQueuedTask({ sessionId: sub.id, requestId: "child", input: "fact", accessMode: "full_access", modelSelection: rt.defaultSelection,
      submissionDigest: "child", parentTaskId: origin.id, subAgentId: "report-agent", workId: "report-work", readScope: fixtureSubAgentScope(source) }).task;
    rt.store.endTask(child.id, ["queued"], "completed"); rt.store.setTaskResult(child.id, "CHILD_FACT", "{}");
    const registered = registerAgentReport(rt.store, { target: { kind: "task", taskId: child.id }, source, parentSessionId: session.id });
    const fallback = rt.store.insertQueuedTask({ sessionId: session.id, requestId: `wake:${child.id}`, input: "CHILD_FACT", modelSelection: rt.defaultSelection,
      submissionDigest: "fallback", parentTaskId: child.id, inputPurpose: "internal_report" }).task;
    return bindAgentReportFallback(rt.store, registered.key, fallback.id);
  });
  first.release();
  await waitFor("request N+1 includes the report", () => t.server.calls.length === 2);
  assert.equal(getAgentReport(rt.store, report.key)!.claimTaskId, receiver.id);
  assert.equal(getAgentReport(rt.store, report.key)!.consumption, null);
  return { t, rt, receiver, report, release: second.release, async close() { first.release(); second.release(); await t.shutdown(); } };
}

test("canceling original work while a dynamic report response is in flight blocks report acceptance", async () => {
  const f = await reportInFlight();
  try {
    f.rt.store.withTx(() => f.rt.store.cancelWorkDelegation("report-work", new Date().toISOString(), "owner", "owner canceled source work"));
    assert.equal(f.rt["verifyAgentReportSources"](f.receiver.id), "agent_report_work_canceled");
    f.release();
    await waitFor("canceled source report becomes undelivered", () => getAgentReport(f.rt.store, f.report.key)!.status === "undelivered");
    const report = getAgentReport(f.rt.store, f.report.key)!;
    assert.equal(report.consumption, null);
    assert.notEqual(report.proof?.taskId, f.receiver.id);
    assert.equal(f.t.server.calls.length, 2);
    assert.equal(f.rt.store.getTask(f.report.fallbackTaskId!)!.startedAt, null);
  } finally { await f.close(); }
});

for (const corruption of ["missing", "malformed", "null"] as const) test(`restart retains a dynamic report as undelivered when its request snapshot is ${corruption}`, async () => {
  const f = await reportInFlight();
  let restarted: Runtime | null = null;
  try {
    f.release();
    await waitFor("report completes before the crash fixture", () => getAgentReport(f.rt.store, f.report.key)!.status === "reported");
    const snapshotId = f.rt.store.listSelectionRecordsByTask(f.receiver.id).at(-1)!.promptArtifactId!;
    assert.ok(snapshotId);
    const config = f.rt.config;
    f.t.client.close(); await f.rt.stop("crash_fixture_offline");
    const db = new Db(f.t.dirs.dataDir), store = new Store(db);
    try {
      store.withTx(() => {
        store.db.prepare("UPDATE tasks SET status = 'running', ended_at = NULL, result_summary = NULL, result_ref = NULL WHERE id = ?").run(f.receiver.id);
        const report = getAgentReport(store, f.report.key)!;
        store.db.prepare("UPDATE agent_reports SET payload = ? WHERE report_key = ?").run(JSON.stringify({ ...report, status: "pending", consumption: null, proof: null }), report.key);
      });
    } finally { db.close(); }
    const file = path.join(f.t.dirs.dataDir, "artifacts", `${snapshotId}.bin`);
    if (corruption === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, corruption === "malformed" ? "{invalid" : "null");
    restarted = await Runtime.start(config);
    assert.equal(restarted.store.getTask(f.receiver.id)!.status, "completed");
    const report = getAgentReport(restarted.store, f.report.key)!;
    assert.equal(report.status, "undelivered");
    assert.equal(report.reason, "agent_report_input_invalid");
    assert.equal(report.consumption, null);
    assert.equal(restarted.store.getTask(f.report.fallbackTaskId!)!.startedAt, null);
    assert.equal(listAgentReports(restarted.store).length, 1);
    assert.equal(f.t.server.calls.length, 2, "unverifiable input cannot cause another model call");
  } finally { await restarted?.stop("test_end"); await f.close(); }
});
