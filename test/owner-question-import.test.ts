import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import { sha256File } from "@ruukoto/core/import-support.ts";
import { cancelOwnerQuestion, createOwnerQuestion } from "@ruukoto/core/owner-questions.ts";
import { applyLegacyImport, previewLegacyImport } from "../apps/ruukoto-code/src/legacy-import.ts";

for (const status of ["pending", "canceled"] as const) test(`旧实例导入拒绝${status}问题与回执，源字节不变且目标没有导入`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-question-import-")), data = path.join(root, "source");
  fs.mkdirSync(data);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new Db(data), store = new Store(db), instanceId = db.getInstanceId();
  store.withTx(() => {
    const stat = fs.statSync(root), project = store.createProject("source");
    const session = store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: "source", confirmTools: [] });
    const task = store.insertQueuedTask({ sessionId: session.id, requestId: "source", input: "原始拥有者输入", submissionDigest: "source", modelSelection: null }).task;
    store.transitionTask(task.id, ["queued"], "running");
    const questions = [{ question: "请说明目标" }];
    store.recordToolIntent({ id: "ask", taskId: task.id, sessionId: session.id, toolName: "ask_user", params: { questions } });
    const question = createOwnerQuestion(store, { taskId: task.id, sessionId: session.id, projectId: project.id, hostOpId: "ask", questions });
    if (status === "canceled") cancelOwnerQuestion(store, { questionId: question.id, sessionId: session.id, version: 1, requestKey: "cancel", requestDigest: "cancel" });
  });
  db.close();
  const digest = sha256File(path.join(data, "ruukoto.db")), target = path.join(root, "target"), deps = { targetDataDir: target, targetAgentDir: path.join(root, "target-agent") };
  assert.throws(() => previewLegacyImport(deps, { from: data }), { code: "owner_questions_import_unavailable" });
  assert.equal(fs.existsSync(target), false);
  fs.mkdirSync(target);
  new Db(target).close();
  assert.throws(() => applyLegacyImport(deps, { plan: { from: data }, source_instance_id: instanceId, revision: "unused", request_id: "unused" }), { code: "owner_questions_import_unavailable" });
  assert.equal(sha256File(path.join(data, "ruukoto.db")), digest);
  const targetDb = new Db(target);
  try { assert.equal((targetDb.prepare("SELECT COUNT(*) AS n FROM instance_imports").get() as { n: number }).n, 0); }
  finally { targetDb.close(); }
});
