import { fixtureSubAgentRoleCatalog } from "./helpers/subagent-definition.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { sha256File } from "@ruukoto/core/import-support.ts";
import { createWorkflowRun, saveWorkflowDefinition, workflowDigest } from "@ruukoto/core/workflow.ts";
import { applyLegacyImport, previewLegacyImport } from "../apps/ruukoto-code/src/legacy-import.ts";
import { applyPersonalImport, previewPersonalImport } from "@ruukoto/channels/personal-import.ts";

for (const [direction, preview, apply] of [["coding", previewLegacyImport, applyLegacyImport], ["personal", previewPersonalImport, applyPersonalImport]] as const) {
  test(`${direction} preview 与 apply 均拒绝丢弃工作流执行绑定，源字节不变且不导入资料`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-import-"));
    const data = path.join(root, "data");
    fs.mkdirSync(data);
    const db = new Db(data);
    const sourceInstanceId = db.getInstanceId();
    const store = new Store(db);
    try {
      store.withTx(() => {
        const stat = fs.statSync(root);
        const project = store.createProject("source");
        const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "source", confirmTools: [] });
        const modelSelection = { provider: "fake", modelId: "fake", thinkingLevel: "off" } as const;
        const task = store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "source", modelSelection, submissionDigest: "source" }).task;
        const definition = saveWorkflowDefinition(store, "return 1;");
        createWorkflowRun(store, { roleCatalog: fixtureSubAgentRoleCatalog(), id: "workflow", requestKey: "workflow", paramsDigest: "workflow", definitionId: definition.id, scriptDigest: definition.digest,
          input: null, inputDigest: workflowDigest(null), displayName: "固定运行名称", description: "保留来源实例的说明", modelSelection, status: "queued", version: 1, reason: null, attempts: 0, maxAttempts: 100,
          durationMs: 3_600_000, usedMs: 0, clockStartedAt: null, clockVerified: true, scriptUnits: [], scriptStopVerified: null, result: null, resultRecorded: false,
          createdAt: new Date().toISOString(), endedAt: null, source: { product: "ruukoto", projectId: project.id, sessionId: session.id, taskId: task.id,
            accessMode: "confirm", permissionVersion: 1, grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null } });
      });
    } finally { db.close(); }
    try {
      const digest = sha256File(path.join(data, "ruukoto.db"));
      const target = path.join(root, "target");
      assert.throws(() => preview({ targetDataDir: target, targetAgentDir: path.join(root, "target-agent") }, { from: data }), { code: "workflow_import_unavailable" });
      assert.equal(sha256File(path.join(data, "ruukoto.db")), digest);
      assert.equal(fs.existsSync(target), false);
      fs.mkdirSync(target);
      const targetDb = new Db(target);
      targetDb.close();
      assert.throws(() => apply({ targetDataDir: target, targetAgentDir: path.join(root, "target-agent") }, {
        plan: { from: data }, source_instance_id: sourceInstanceId, revision: "unapplied", request_id: "unapplied",
      }), { code: "workflow_import_unavailable" });
      assert.equal(sha256File(path.join(data, "ruukoto.db")), digest);
      const verified = new Db(target);
      try {
        assert.equal((verified.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, 0);
        assert.equal((verified.prepare("SELECT COUNT(*) AS n FROM instance_imports").get() as { n: number }).n, 0);
      } finally { verified.close(); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
