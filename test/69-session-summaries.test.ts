import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Db } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { routeResponder, startTestRuntime } from "./helpers/testkit.ts";

test("会话摘要：首条用户输入与最后任务活动持久化，设置事件不改变活跃时间", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-session-summary-"));
  let db = new Db(root);
  try {
    let store = new Store(db);
    const project = store.createProject("summary");
    const otherProject = store.createProject("other");
    let n = 0;
    const session = (projectId = project.id) => store.createSession({
      projectId, cwd: root, cwdReal: root, cwdDev: 1, cwdIno: 1, piSessionId: `pi-${++n}`, confirmTools: [],
    });
    const active = session();
    const empty = session();
    const outside = session(otherProject.id);
    const task = (input: string, parentTaskId: string | null = null) => store.insertQueuedTask({
      sessionId: active.id, requestId: `req-${++n}`, input, parentTaskId,
      modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: `digest-${n}`,
    }).task;
    const child = task("子任务输入", "parent");
    const first = task("第一条用户消息");
    const second = task("后续消息不能替换会话名");
    const created = "2026-09-01T00:00:00.000Z";
    db.prepare("UPDATE sessions SET created_at = ?").run(created);
    db.prepare("UPDATE tasks SET created_at = ?").run(created);
    db.prepare("UPDATE tasks SET started_at = ?, ended_at = ? WHERE id = ?")
      .run("2026-09-02T00:00:00.000Z", "2026-09-03T00:00:00.000Z", second.id);
    db.prepare("UPDATE events SET created_at = ?").run(created);
    const eventTime = "2026-09-04T00:00:00.000Z";
    db.prepare("INSERT INTO events (task_id, session_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run(first.id, active.id, JSON.stringify({ type: "task.fake" }), eventTime);
    // 纯设置事件时间更晚；不能让会话列表显示为刚刚活跃。
    store.setSessionDefaultMode(active.id, "full_access", 0);
    db.close();
    db = new Db(root);
    store = new Store(db);
    const summaries = store.listSessionSummaries(project.id);
    assert.deepEqual(summaries.map(s => s.sessionId), [active.id, empty.id]);
    assert.deepEqual({ ...summaries.find(s => s.sessionId === active.id) }, {
      sessionId: active.id, name: "第一条用户消息", lastActiveAt: eventTime,
    });
    assert.deepEqual({ ...summaries.find(s => s.sessionId === empty.id) }, {
      sessionId: empty.id, name: null, lastActiveAt: created,
    });
    assert.equal(summaries.some(s => s.sessionId === outside.id), false);
    // 同一毫秒以插入顺序决定首条；任务时间也可以成为最新活动。
    db.prepare("UPDATE tasks SET ended_at = ? WHERE id = ?").run("2026-09-05T00:00:00.000Z", child.id);
    assert.equal(store.listSessionSummaries(project.id)[0]!.lastActiveAt, "2026-09-05T00:00:00.000Z");
    db.prepare("UPDATE tasks SET input = ? WHERE id = ?").run("中".repeat(600), first.id);
    assert.equal(store.listSessionSummaries(project.id)[0]!.name, "中".repeat(512));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("会话摘要控制面：项目参数与不存在项目有明确错误，空项目返回空列表", async () => {
  const t = await startTestRuntime("session-summary", routeResponder([]));
  try {
    for (const project_id of [undefined, "", 1]) {
      await assert.rejects(t.client.request("list_session_summaries", { project_id }),
        (err: any) => err.code === "invalid_params");
    }
    await assert.rejects(t.client.request("list_session_summaries", { project_id: "missing" }),
      (err: any) => err.code === "not_found");
    const project = await t.client.request<any>("create_project", { name: "empty-summary" });
    assert.deepEqual(await t.client.request("list_session_summaries", { project_id: project.id }), []);
  } finally {
    await t.shutdown();
  }
});

test("组织归属摘要：workspace_project_id ?? project_id 归属；映射事件不算任务活跃（issue 07 步骤 4）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-ws-summary-"));
  const db = new Db(root);
  try {
    const store = new Store(db);
    const ws = store.withTx(() => store.createProject("工作区", null, { cwd: "/w", cwdReal: "/w", dev: 1, ino: 2 }));
    const legacy = store.withTx(() => store.createProject("旧项目"));
    const own = store.withTx(() => store.createSession({ projectId: ws.id, cwd: "/w", cwdReal: "/w", cwdDev: 1, cwdIno: 2, piSessionId: "pi-own", confirmTools: [] }));
    const mapped = store.withTx(() => store.createSession({ projectId: legacy.id, cwd: "/w", cwdReal: "/w", cwdDev: 1, cwdIno: 2, piSessionId: "pi-mapped", confirmTools: [] }));
    const plain = store.withTx(() => store.createSession({ projectId: legacy.id, cwd: "/l", cwdReal: "/l", cwdDev: 3, cwdIno: 4, piSessionId: "pi-plain", confirmTools: [] }));
    // mapped 有更晚的任务活动时间
    const task = store.withTx(() => store.insertQueuedTask({
      sessionId: mapped.id, requestId: "req-ws-1", input: "旧会话的任务",
      modelSelection: { provider: "mock", modelId: "mock", thinkingLevel: "off" }, submissionDigest: "d",
    }).task);
    db.prepare("UPDATE sessions SET created_at = '2026-09-01T00:00:00.000Z'").run();
    db.prepare("UPDATE tasks SET created_at = '2026-09-01T00:00:00.000Z', ended_at = '2026-09-02T00:00:00.000Z' WHERE id = ?").run(task.id);
    // 事件时间钉在任务活动时间（与既有摘要测试同款，否则事件真实时间影响断言）
    db.prepare("UPDATE events SET created_at = '2026-09-02T00:00:00.000Z'").run();
    // 映射（产生当前时间的 session.workspace_mapped 事件，远晚于任务时间）
    store.withTx(() => store.mapSessionToWorkspace(mapped.id, ws.id));

    const byWorkspace = store.listSessionSummariesForWorkspace(ws.id);
    assert.deepEqual(byWorkspace.map((s) => s.sessionId).sort(), [own.id, mapped.id].sort(), "归属 = workspace_project_id ?? project_id");
    assert.equal(byWorkspace.find((s) => s.sessionId === mapped.id)!.lastActiveAt, "2026-09-02T00:00:00.000Z", "映射事件不算任务活跃");
    assert.equal(byWorkspace.find((s) => s.sessionId === mapped.id)!.name, "旧会话的任务", "摘要算法不变");
    const bySource = store.listSessionSummaries(legacy.id);
    assert.deepEqual(bySource.map((s) => s.sessionId).sort(), [mapped.id, plain.id].sort(), "按原身份查询语义保留");
    assert.equal(byWorkspace.some((s) => s.sessionId === plain.id), false, "未映射会话不进工作区");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
