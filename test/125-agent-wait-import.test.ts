import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { bindAgentReportFallback, claimAgentReports, completeAgentReports, consumeAgentReport, getAgentReport, getAgentWait, isAgentReportFallback,
  registerAgentReport, registerAgentWait, setAgentWaitPhase, type AgentReport, type AgentWaitSnapshot } from "@ruukoto/core/agent-wait.ts";
import { sha256File } from "@ruukoto/core/import-support.ts";
import { PRODUCT_META_KEY } from "@ruukoto/core/product.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "@ruukoto/core/types.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { applyLegacyImport, previewLegacyImport, revertLegacyImport } from "../apps/ruukoto-code/src/legacy-import.ts";
import { applyPersonalImport, previewPersonalImport, revertPersonalImport } from "@ruukoto/channels/personal-import.ts";
import { AppDataStore } from "@ruukoto/agent/app-data/store.ts";

function fixture(personal: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wait-import-")), sourceDir = path.join(root, "source", "data");
  fs.mkdirSync(sourceDir, { recursive: true });
  const db = new Db(sourceDir), store = new Store(db), stat = fs.statSync(root);
  let n = 0;
  const project = store.withTx(() => store.createProject("archive"));
  const session = () => store.createSession({ projectId: project.id, cwd: root, cwdReal: fs.realpathSync(root), cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: `pi${++n}`, confirmTools: [] });
  const parentSession = store.withTx(session), subSession = store.withTx(session);
  const parent = store.withTx(() => {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(PRODUCT_META_KEY, "ruukoto");
    if (personal) store.insertAgentRole({ id: "main", projectId: project.id, sessionId: parentSession.id, workDir: root, modelSelection: null, tools: [], createdAt: parentSession.createdAt });
    const task = store.insertQueuedTask({ sessionId: parentSession.id, requestId: "parent", input: "等待两项工作", submissionDigest: "parent", modelSelection: { provider: "fake", modelId: "fake", thinkingLevel: "off" } }).task;
    store.transitionTask(task.id, ["queued"], "running");
    store.insertSubAgent({ id: "sub", parentSessionId: parentSession.id, sessionId: subSession.id, workDir: root, activeWorkId: "work", currentTaskId: null, state: "idle", closedAt: null, closedBy: null, createdAt: parentSession.createdAt });
    store.insertWorkDelegation({ id: "work", parentSessionId: parentSession.id, originTaskId: task.id, subAgentId: "sub", requestKey: "work", paramsDigest: "work", writeTarget: null, canceledAt: null, canceledBy: null, cancelReason: null, createdAt: parentSession.createdAt });
    return store.getTask(task.id)!;
  });
  const child = () => store.withTx(() => {
    const task = store.insertQueuedTask({ sessionId: subSession.id, requestId: `child${++n}`, input: "后台工作", submissionDigest: String(n), modelSelection: parent.modelSelection,
      workId: "work", subAgentId: "sub", parentTaskId: parent.id }).task;
    store.transitionTask(task.id, ["queued"], "completed");
    store.setTaskResult(task.id, "已完成的结果", JSON.stringify({ taskId: task.id }));
    return task;
  });
  const source: WorkflowSource = { product: "ruukoto", projectId: project.id, sessionId: parentSession.id, taskId: parent.id, permissionVersion: 1,
    accessMode: "confirm", grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null };
  const children = [child(), child()], reports: AgentReport[] = [];
  const snapshot: AgentWaitSnapshot = { taskId: parent.id, permissionVersion: 1, selectionRecordId: null, promptArtifactId: null,
    instructions: { text: "历史指令正文", version: "fixture", problems: [] }, skills: { skills: [], diagnostics: [], version: "fixture" } };
  store.withTx(() => {
    registerAgentWait(store, { id: "wait", sdkCallId: "call", deadline: null, taskId: parent.id, sessionId: parentSession.id,
      targets: children.map(child => ({ kind: "task", taskId: child.id })), source, snapshot });
    setAgentWaitPhase(store, "wait", "waiting");
    for (const child of children) {
      const report = registerAgentReport(store, { target: { kind: "task", taskId: child.id }, source, parentSessionId: parentSession.id });
      const fallback = store.insertQueuedTask({ sessionId: parentSession.id, requestId: `wake:${child.id}`, input: "[后台汇报] 内部输入", submissionDigest: child.id,
        modelSelection: parent.modelSelection, parentTaskId: child.id, sourcePermissionVersion: 1 }).task;
      bindAgentReportFallback(store, report.key, fallback.id);
      reports.push(getAgentReport(store, report.key)!);
    }
    claimAgentReports(store, { taskId: parent.id, keys: [reports[0].key] });
    consumeAgentReport(store, reports[0].key, { taskId: parent.id, entryId: "accepted-result" });
    completeAgentReports(store, parent.id, { status: "reported", entryId: "parent-final" });
    claimAgentReports(store, { taskId: parent.id, keys: [reports[1].key] });
  });
  const file = path.join(sourceDir, "sessions", `${parentSession.piSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: "session", version: 3, id: parentSession.piSessionId, timestamp: parent.createdAt, cwd: root },
    { type: "custom", id: "start", customType: TASK_START_MARKER, data: { taskId: parent.id } },
    { type: "message", id: "accepted-result", message: { role: "toolResult", toolCallId: "call", toolName: "agent_wait", content: [{ type: "text", text: "已消费结果" }], isError: false } },
    { type: "message", id: "parent-final", message: { role: "assistant", content: [{ type: "text", text: "最终总结" }], stopReason: "stop" } },
    { type: "custom", id: "end", customType: TASK_END_MARKER, data: { taskId: parent.id, status: "completed" } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  store.withTx(() => { store.setSessionFile(parentSession.id, file); store.addHistoryEntryIds(parent.id, ["accepted-result", "parent-final"]); });
  const proof = getAgentReport(store, reports[0].key)!;
  const instanceId = db.getInstanceId();
  db.close();
  const deps = { targetDataDir: path.join(root, "target", "data"), targetAgentDir: path.join(root, "target", "agent") };
  return { root, sourceDir, deps, parentSession, parent, children, reports, proof, file, instanceId, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const [direction, personal, preview, apply, revert] of [["coding", false, previewLegacyImport, applyLegacyImport, revertLegacyImport], ["personal", true, previewPersonalImport, applyPersonalImport, revertPersonalImport]] as const) {
  test(`${direction} 报告依赖的旧任务读取了未导入记忆时明确拒绝，完整记忆则随资料保留`, () => {
    const f = fixture(personal);
    try {
      const db = new Db(f.sourceDir), store = new Store(db), report = getAgentReport(store, f.reports[1].key)!;
      assert.equal(report.dependencyTaskIds.includes(f.children[0].id), true);
      db.prepare("DELETE FROM agent_waits").run();
      db.prepare("DELETE FROM agent_reports WHERE report_key = ?").run(f.reports[0].key);
      store.withTx(() => {
        store.recordToolIntent({ id: "memory-read", taskId: f.children[0].id, sessionId: f.children[0].sessionId, toolName: "memory_read", params: { memory_id: "memory" } });
        store.recordToolResult("memory-read", "已读取历史记忆正文", false);
      });
      db.close();
      const missingHash = sha256File(path.join(f.sourceDir, "ruukoto.db"));
      assert.throws(() => preview(f.deps, { from: f.sourceDir }), { code: "agent_wait_import_reference_missing" });
      assert.equal(fs.existsSync(f.deps.targetDataDir), false);
      assert.equal(sha256File(path.join(f.sourceDir, "ruukoto.db")), missingHash);
      const source = new Db(f.sourceDir), now = new Date().toISOString();
      source.prepare("INSERT INTO memories (id, project_id, scope, category, current_version, status, created_at, updated_at) VALUES ('memory', ?, 'project', 'decision', 1, 'active', ?, ?)").run(f.parentSession.projectId, now, now);
      source.prepare("INSERT INTO memory_versions (memory_id, version, content, source_refs, author, created_at) VALUES ('memory', 1, '历史记忆正文', ?, 'owner', ?)").run(JSON.stringify([{ kind: "owner_note" }]), now);
      source.close();
      const plan = preview(f.deps, { from: f.sourceDir });
      const result = apply(f.deps, { plan: { from: f.sourceDir }, source_instance_id: f.instanceId, revision: plan.revision!, request_id: "memory-complete" });
      assert.equal(result.counts.memories, 1);
      const target = new Db(f.deps.targetDataDir);
      try {
        assert.ok(target.prepare("SELECT 1 FROM memories WHERE id = 'memory'").get());
        assert.deepEqual(getAgentReport(new Store(target), report.key)!.dependencyTaskIds, report.dependencyTaskIds);
      } finally { target.close(); }
    } finally { f.cleanup(); }
  });

  test(`${direction} 应用数据来源必须有本方向实际保留的实例快照`, () => {
    const f = fixture(personal);
    try {
      const file = path.join(f.sourceDir, "agent-data", "main.db"), app = new AppDataStore(file), ctx = { taskId: f.parent.id, sessionId: f.parentSession.id, agentId: "main" };
      app.defineTable({ table: "items", fields: [{ name: "name", type: "text" }], expected_schema_version: 0, opId: "define", reason: "归档用例", ctx });
      const row = app.insert({ table: "items", records: [{ name: "历史资料" }], expected_schema_version: 1, opId: "insert", reason: "归档用例", ctx }).rows[0];
      const instanceId = app.getInstanceId();
      app.close();
      const source = new Db(f.sourceDir), store = new Store(source), report = getAgentReport(store, f.reports[1].key)!;
      const references = [{ kind: "app_data", ref: `app_data:${instanceId}/items#${row.id}.name`, version: "row v1 schema v1", sha256: "historical-text" }];
      source.prepare("UPDATE agent_reports SET payload = ? WHERE report_key = ?").run(JSON.stringify({ ...report, source: { ...report.source, references } }), report.key);
      source.close();
      const hash = sha256File(path.join(f.sourceDir, "ruukoto.db")), appHash = sha256File(file);
      if (!personal) {
        assert.throws(() => preview(f.deps, { from: f.sourceDir }), { code: "agent_wait_import_reference_missing" });
        assert.equal(fs.existsSync(f.deps.targetDataDir), false);
      } else {
        fs.renameSync(file, `${file}.saved`);
        assert.throws(() => preview(f.deps, { from: f.sourceDir }), { code: "agent_wait_import_reference_missing" });
        assert.equal(fs.existsSync(f.deps.targetDataDir), false);
        fs.renameSync(`${file}.saved`, file);
        const raw = new Db(f.sourceDir);
        raw.prepare("UPDATE agent_reports SET payload = ? WHERE report_key = ?").run(JSON.stringify({ ...report, source: { ...report.source, references: [{ ...references[0], ref: "app_data:missing-instance/items#1.name" }] } }), report.key);
        raw.close();
        assert.throws(() => preview(f.deps, { from: f.sourceDir }), { code: "agent_wait_import_reference_missing" });
        assert.equal(fs.existsSync(f.deps.targetDataDir), false);
        const original = new Db(f.sourceDir);
        original.prepare("UPDATE agent_reports SET payload = ? WHERE report_key = ?").run(JSON.stringify({ ...report, source: { ...report.source, references } }), report.key);
        original.close();
        const plan = preview(f.deps, { from: f.sourceDir });
        const result = apply(f.deps, { plan: { from: f.sourceDir }, source_instance_id: f.instanceId, revision: plan.revision!, request_id: "app-data-complete" });
        assert.equal(result.counts.agent_reports, 2);
        assert.equal(sha256File(path.join(f.deps.targetDataDir, "agent-data", "main.db")), appHash);
        const target = new Db(f.deps.targetDataDir);
        try { assert.deepEqual(getAgentReport(new Store(target), report.key)!.source.references, references); }
        finally { target.close(); }
      }
      assert.equal(sha256File(path.join(f.sourceDir, "ruukoto.db")), hash);
      assert.equal(sha256File(file), appHash);
    } finally { f.cleanup(); }
  });

  test(`${direction} 导入保留等待与报告 UUID、消费证明和 JSONL，归档后不重放且可回退`, () => {
    const f = fixture(personal);
    try {
      const originalDb = sha256File(path.join(f.sourceDir, "ruukoto.db")), originalHistory = fs.readFileSync(f.file);
      const plan = preview(f.deps, { from: f.sourceDir });
      assert.equal(fs.existsSync(f.deps.targetDataDir), false);
      const input = { plan: { from: f.sourceDir }, source_instance_id: f.instanceId, revision: plan.revision!, request_id: "archive" };
      const result = apply(f.deps, input);
      assert.equal(result.counts.agent_waits, 1);
      assert.equal(result.counts.agent_reports, 2);
      assert.equal(apply(f.deps, input).replayed, true);
      const db = new Db(f.deps.targetDataDir), store = new Store(db);
      try {
        const wait = getAgentWait(store, "wait")!;
        assert.equal(wait.phase, "ended");
        assert.equal(wait.reason, "instance_imported");
        assert.equal(wait.snapshot.instructions!.text, "历史指令正文");
        const done = getAgentReport(store, f.reports[0].key)!, pending = getAgentReport(store, f.reports[1].key)!;
        assert.equal(done.status, "reported");
        assert.deepEqual(done.consumption, f.proof.consumption);
        assert.deepEqual(done.proof, f.proof.proof);
        assert.equal(pending.status, "undelivered");
        assert.equal(pending.reason, "instance_imported");
        assert.equal(pending.claimTaskId, null);
        assert.equal(pending.fallbackState, "parked");
        assert.equal(isAgentReportFallback(store, pending.fallbackTaskId!), true);
        assert.equal(store.getTask(pending.fallbackTaskId!)!.status, "canceled");
        assert.deepEqual(fs.readFileSync(store.getSession(f.parentSession.id)!.sessionFile!), originalHistory);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notification_ops WHERE status = 'pending'").get() as { n: number }).n, 0);
      } finally { db.close(); }
      const repeated = preview(f.deps, { from: f.sourceDir });
      assert.equal(repeated.conflicts.ids.length, 0);
      if ("manifest" in repeated.conflicts) assert.equal(repeated.conflicts.manifest.length, 0);
      const reverted = revert(f.deps, result.import_id);
      assert.equal(reverted.ok, true);
      assert.equal(reverted.removed.agent_waits, 1);
      assert.equal(reverted.removed.agent_reports, 2);
      assert.equal(sha256File(path.join(f.sourceDir, "ruukoto.db")), originalDb);
      assert.deepEqual(fs.readFileSync(f.file), originalHistory);
    } finally { f.cleanup(); }
  });

  test(`${direction} 缺失依赖任务时预览明确拒绝，不写目标或丢弃来源绑定`, () => {
    const f = fixture(personal);
    try {
      const db = new Db(f.sourceDir);
      const report = getAgentReport(new Store(db), f.reports[1].key)!;
      db.prepare("UPDATE agent_reports SET payload = ? WHERE report_key = ?").run(JSON.stringify({ ...report, dependencyTaskIds: [...report.dependencyTaskIds, "missing"] }), report.key);
      db.close();
      const hash = sha256File(path.join(f.sourceDir, "ruukoto.db"));
      assert.throws(() => preview(f.deps, { from: f.sourceDir }), { code: "agent_wait_import_reference_missing" });
      assert.equal(fs.existsSync(f.deps.targetDataDir), false);
      assert.equal(sha256File(path.join(f.sourceDir, "ruukoto.db")), hash);
    } finally { f.cleanup(); }
  });

  test(`${direction} 等待行变化使原修订失效，导入后的报告改写阻挡回退`, () => {
    const f = fixture(personal);
    try {
      const plan = preview(f.deps, { from: f.sourceDir });
      const db = new Db(f.sourceDir), wait = getAgentWait(new Store(db), "wait")!;
      db.prepare("UPDATE agent_waits SET payload = ? WHERE id = 'wait'").run(JSON.stringify({ ...wait, reason: "source_changed" }));
      db.close();
      assert.throws(() => apply(f.deps, { plan: { from: f.sourceDir }, source_instance_id: f.instanceId, revision: plan.revision!, request_id: "stale" }), { code: "revision_conflict" });
      const fresh = preview(f.deps, { from: f.sourceDir });
      const result = apply(f.deps, { plan: { from: f.sourceDir }, source_instance_id: f.instanceId, revision: fresh.revision!, request_id: "fresh" });
      const target = new Db(f.deps.targetDataDir), report = getAgentReport(new Store(target), f.reports[1].key)!;
      target.prepare("UPDATE agent_reports SET payload = ? WHERE report_key = ?").run(JSON.stringify({ ...report, reason: "target_changed" }), report.key);
      target.close();
      assert.equal(revert(f.deps, result.import_id).ok, false);
      const conflicts = preview(f.deps, { from: f.sourceDir });
      assert.equal(conflicts.conflicts.ids.length > 0 || ("manifest" in conflicts.conflicts && conflicts.conflicts.manifest.length > 0), true);
    } finally { f.cleanup(); }
  });

  test(`${direction} 新源等待事实不覆盖已有归档，其他等待附着原父会话时回退明确拒绝`, () => {
    const f = fixture(personal);
    try {
      const plan = preview(f.deps, { from: f.sourceDir });
      const result = apply(f.deps, { plan: { from: f.sourceDir }, source_instance_id: f.instanceId, revision: plan.revision!, request_id: "original" });
      const source = new Db(f.sourceDir), before = getAgentWait(new Store(source), "wait")!;
      source.prepare("UPDATE agent_waits SET payload = ? WHERE id = 'wait'").run(JSON.stringify({ ...before, reason: "new-source-fact" }));
      source.close();
      const updated = preview(f.deps, { from: f.sourceDir });
      assert.equal(updated.conflicts.ids.length > 0 || ("manifest" in updated.conflicts && updated.conflicts.manifest.length > 0), true);
      const target = new Db(f.deps.targetDataDir), archived = getAgentWait(new Store(target), "wait")!;
      assert.equal(archived.reason, "instance_imported");
      target.prepare("INSERT INTO agent_waits (id, task_id, session_id, payload) VALUES (?, ?, ?, ?)").run("attached", archived.taskId, archived.sessionId, JSON.stringify({ ...archived, id: "attached" }));
      target.close();
      const rollback = revert(f.deps, result.import_id);
      assert.equal(rollback.ok, false);
      assert.equal((rollback.blockers ?? []).some(text => text.includes("其他等待或报告引用")), true);
      const kept = new Db(f.deps.targetDataDir);
      try { assert.ok(getAgentWait(new Store(kept), "attached")); }
      finally { kept.close(); }
    } finally { f.cleanup(); }
  });
}
