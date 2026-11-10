import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
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


test("The ordinary queue excludes host tasks even when their host record is missing", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-host-queue-")));
  const db = new Db(root), store = new Store(db);
  try {
    const stat = fs.statSync(root), project = store.withTx(() => store.createProject("宿主队列"));
    const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root,
      cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "source", confirmTools: [] }));
    const create = (requestId: string, host: boolean) => store.withTx(() => store.insertQueuedTask({ sessionId: session.id,
      requestId, input: "任务", modelSelection: null, submissionDigest: requestId,
      readScope: host ? { paths: [], sourceRefs: [], workCopyHost: snapshot } : null }).task);
    create("work-copy-host:work:capture:one", true);
    create("work-copy-host:work:create:two", false);
    const ordinary = create("ordinary", false);
    assert.deepEqual(store.listQueuedTasksFifo(session.id).map(task => task.id), [ordinary.id]);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
