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
