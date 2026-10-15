import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { verifyImportedWorkCopyHosts } from "@ruukoto/core/import-support.ts";
import { requireWorkCopyHost, workCopyHostFor, type WorkCopyHostSnapshot } from "@ruukoto/core/work-copy-host.ts";

const snapshot: WorkCopyHostSnapshot = { version: 1, parentTaskId: "parent", workId: "work", operation: "capture",
  source: { path: "/source", dev: 1, ino: 2 }, units: [{ kind: "process_group", id: "123", label: "捕获" }], stopVerified: true };

test("宿主记录保存真实来源和停止身份，缺失或损坏不能退成模型任务", () => {
  assert.deepEqual(requireWorkCopyHost(JSON.parse(JSON.stringify(snapshot))), snapshot);
  assert.equal(workCopyHostFor({ requestId: "ordinary", readScope: null }), null);
  assert.throws(() => workCopyHostFor({ requestId: "work-copy-host:work:capture:op", readScope: null }), { code: "work_copy_host_missing" });
  for (const corrupt of [null, [], { ...snapshot, version: 2 }, { ...snapshot, parentTaskId: "" }, { ...snapshot, operation: "bash" },
    { ...snapshot, source: { ...snapshot.source, path: "relative" } }, { ...snapshot, units: [{ kind: "unknown", id: "id", label: "unit" }] },
    { ...snapshot, stopVerified: undefined }]) assert.throws(() => requireWorkCopyHost(corrupt), { code: "work_copy_host_corrupt" });
});

test("宿主归档必须包含完整来源，允许父任务之后切换权限及尚未登记工作", () => {
  const parent = { id: "parent", session_id: "source", permission_version: 2 };
  const host = { id: "host", session_id: "source", parent_task_id: "parent", source_permission_version: 1, model_selection: "null",
    request_id: "work-copy-host:work:capture:op", read_scope: JSON.stringify({ paths: [], sourceRefs: [], workCopyHost: snapshot }) };
  const sessions = [{ id: "source" }];
  verifyImportedWorkCopyHosts([parent, host], sessions);
  for (const tasks of [[host], [parent, { ...host, parent_task_id: "other" }], [parent, { ...host, source_permission_version: 3 }],
    [parent, { ...host, sub_agent_id: "agent" }], [parent, { ...host, model_selection: JSON.stringify({ provider: "mock" }) }]]) {
    assert.throws(() => verifyImportedWorkCopyHosts(tasks, sessions), { code: "work_copy_host_source_missing" });
  }
  assert.throws(() => verifyImportedWorkCopyHosts([parent, { ...host, read_scope: null }], sessions), { code: "work_copy_host_missing" });
});

test("普通队列和旧模型补填排除宿主任务，即使宿主记录已丢失", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-host-queue-")));
  const db = new Db(root), store = new Store(db);
  try {
    const stat = fs.statSync(root), project = store.withTx(() => store.createProject("宿主队列"));
    const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root,
      cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "source", confirmTools: [] }));
    const create = (requestId: string, host: boolean) => store.withTx(() => store.insertQueuedTask({ sessionId: session.id,
      requestId, input: "任务", modelSelection: null, submissionDigest: requestId,
      readScope: host ? { paths: [], sourceRefs: [], workCopyHost: snapshot } : null }).task);
    const host = create("work-copy-host:work:capture:one", true), missing = create("work-copy-host:work:create:two", false), ordinary = create("ordinary", false);
    db.prepare("UPDATE tasks SET model_selection = NULL").run();
    assert.deepEqual(store.listQueuedTasksFifo(session.id).map(task => task.id), [ordinary.id]);
    assert.equal(store.countLegacyQueuedTasks(session.id), 1);
    store.withTx(() => store.fillLegacyQueuedModelSelections(session.id, { provider: "mock", modelId: "mock", thinkingLevel: "off" }));
    assert.equal(store.getTask(host.id)!.modelSelection, null);
    assert.equal(store.getTask(missing.id)!.modelSelection, null);
    assert.equal(store.getTask(ordinary.id)!.modelSelection!.modelId, "mock");
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
