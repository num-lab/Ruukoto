import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Db } from "@ruukoto/core/db.ts";
import { Store } from "@ruukoto/core/store.ts";
import type { Task } from "@ruukoto/core/types.ts";
import type { AgentReferenceSnapshot } from "@ruukoto/core/agent-wait.ts";
import {
  claimBackgroundLaunch, closeSessionBackgroundBarrier, findBackgroundProcessByOp, finishBackgroundStop,
  getBackgroundProcess, handoffBackgroundProcess, latestBackgroundReferenceSnapshot, listActiveBackgroundProcesses,
  pageBackgroundProcesses, registerBackgroundProcess, requestBackgroundStop, updateBackgroundObserved,
} from "@ruukoto/core/background-processes.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-background-core-"));
  const db = new Db(root), store = new Store(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = store.withTx(() => store.createProject("background"));
  const session = store.withTx(() => store.createSession({ projectId: project.id, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: "pi", confirmTools: [] }));
  const workspace = { path: root, dev: 1, ino: 1 };
  let index = 0;
  const queued = () => store.withTx(() => store.insertQueuedTask({ sessionId: session.id, requestId: `request-${++index}`, input: "启动本地服务", accessMode: "full_access", grantedPaths: [], submissionDigest: "test", modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" } })).task;
  function activate(task: Task): Task {
    store.withTx(() => {
      store.transitionTask(task.id, ["queued"], "running");
      assert.equal(store.tryAcquireOccupancy({ cwdReal: root, cwdDev: 1, cwdIno: 1, sessionId: session.id, taskId: task.id }), true);
    });
    return store.getTask(task.id)!;
  }
  function register(task: Task, command = "node server.mjs") {
    const hostOpId = `op-${task.id}`;
    store.withTx(() => store.recordToolIntent({ id: hostOpId, taskId: task.id, sessionId: session.id, toolName: "process_start", params: { command } }));
    return store.withTx(() => registerBackgroundProcess(store, { taskId: task.id, sessionId: session.id, hostOpId, workspace, ref: { platform: "darwin", executionId: task.id } }));
  }
  const snapshot = (task: Task): AgentReferenceSnapshot => ({ taskId: task.id, permissionVersion: task.permissionVersion, selectionRecordId: null, promptArtifactId: null, instructions: { text: "已记录指令", version: "v1", problems: [] }, skills: null });
  return { db, store, session, workspace, queued, activate, register, snapshot };
}

test("独立反证：关闭之后旧已接纳Task不能登记后台", t => {
const f=fixture(t), old=f.queued();
f.store.withTx(()=>closeSessionBackgroundBarrier(f.store,{sessionId:f.session.id,requestKey:"close-before-register"}));
f.activate(old);assert.throws(()=>f.register(old),{code:"background_closed"});
});
