import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { PROTOCOL_VERSION } from "@ruukoto/core/types.ts";
import { routeResponder, startTestRuntime } from "./helpers/testkit.ts";
import { WORKFLOW_INTERFACE_VERSION, controlWorkflow, createWorkflowRun, getWorkflowDefinition, requireWorkflowInterface, requireWorkflowRunDefinition,
  saveWorkflowDefinition, setWorkflowState, workflowDigest, type WorkflowRun } from "@ruukoto/core/workflow.ts";

test("旧接口不能新建或恢复运行，仍可查询和取消；损坏正文不取得新版资格", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-interface-"));
  const db = new Db(root), store = new Store(db);
  try {
    store.withTx(() => {
      const stat = fs.statSync(root), project = store.createProject("source");
      const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "source", confirmTools: [] });
      const modelSelection = { provider: "fake", modelId: "fake", thinkingLevel: "off" } as const;
      const task = store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "source", modelSelection, submissionDigest: "source" }).task;
      const legacy = saveWorkflowDefinition(store, "return 1;", 1), current = saveWorkflowDefinition(store, "return 1;");
      const run: WorkflowRun = { id: "current", interfaceVersion: WORKFLOW_INTERFACE_VERSION, requestKey: "current", paramsDigest: "current", definitionId: current.id, scriptDigest: current.digest,
        input: null, inputDigest: workflowDigest(null), modelSelection, status: "paused", version: 1, reason: "owner_pause", attempts: 0, maxAttempts: 100,
        durationMs: 3_600_000, usedMs: 0, clockStartedAt: null, clockVerified: true, scriptUnits: [], scriptStopVerified: null, result: null, resultRecorded: false,
        createdAt: new Date().toISOString(), endedAt: null, source: { product: "ruukoto", projectId: project.id, sessionId: session.id, taskId: task.id,
          accessMode: "confirm", permissionVersion: 1, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null } };
      assert.throws(() => requireWorkflowInterface({}), { code: "interface_upgrade_required" });
      assert.throws(() => createWorkflowRun(store, { ...run, interfaceVersion: undefined }), { code: "interface_upgrade_required" });
      assert.throws(() => createWorkflowRun(store, { ...run, definitionId: legacy.id, scriptDigest: legacy.digest }), { code: "interface_upgrade_required" });
      assert.equal(createWorkflowRun(store, run).interfaceVersion, WORKFLOW_INTERFACE_VERSION);
      assert.equal(requireWorkflowRunDefinition(store, run).id, current.id);
      const oldRun = { ...run, id: "legacy", requestKey: "legacy", reason: "interface_upgrade_required", interfaceVersion: undefined, definitionId: legacy.id, scriptDigest: legacy.digest };
      store.db.prepare("INSERT INTO workflow_runs (id, source_session_id, request_key, params_digest, status, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(oldRun.id, session.id, oldRun.requestKey, oldRun.paramsDigest, oldRun.status, JSON.stringify(oldRun));
      assert.equal(getWorkflowDefinition(store, legacy.id)!.script, "return 1;");
      assert.throws(() => controlWorkflow(store, oldRun.id, "resume", 1, { action: "resume" }), { code: "interface_upgrade_required" });
      assert.equal(setWorkflowState(store, oldRun.id, "paused", "clock_unverified").reason, "interface_upgrade_required");
      assert.equal((store.db.prepare("SELECT payload FROM workflow_runs WHERE id = ?").get(oldRun.id) as { payload: string }).payload, JSON.stringify(oldRun));
      const canceled = controlWorkflow(store, oldRun.id, "cancel", 1, { action: "cancel" });
      assert.equal(canceled.status, "canceled");
      assert.equal(canceled.interfaceVersion, undefined);
      assert.equal(controlWorkflow(store, oldRun.id, "cancel", 1, { action: "cancel" }).version, canceled.version);
      store.db.prepare("UPDATE workflow_definitions SET payload = ? WHERE id = ?").run(JSON.stringify({ ...current, script: "return 2;" }), current.id);
      assert.throws(() => requireWorkflowRunDefinition(store, run), { code: "definition_missing" });
      assert.throws(() => controlWorkflow(store, run.id, "resume", 1, { action: "resume" }), { code: "definition_missing" });
    });
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("旧客户端在分派写请求前得到协议升级拒绝", async () => {
  const t = await startTestRuntime("workflow-old-client", routeResponder([]));
  const socket = net.createConnection(t.runtime.socketPath());
  try {
    const reply = await new Promise<{ v: number; ok: boolean; error: { code: string } }>((resolve, reject) => {
      let body = "";
      socket.setEncoding("utf8");
      socket.setTimeout(5000, () => reject(new Error("旧协议拒绝应答超时")));
      socket.on("error", reject);
      socket.on("data", chunk => {
        body += chunk;
        if (body.includes("\n")) resolve(JSON.parse(body.slice(0, body.indexOf("\n"))));
      });
      socket.on("connect", () => socket.write(JSON.stringify({ v: PROTOCOL_VERSION - 1, id: "old", op: "workflow_start", params: {} }) + "\n"));
    });
    assert.equal(reply.v, PROTOCOL_VERSION);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, "protocol_version");
    assert.equal((t.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() as { n: number }).n, 0);
    assert.equal(t.server.calls.length, 0);
  } finally { socket.destroy(); await t.shutdown(); }
});
