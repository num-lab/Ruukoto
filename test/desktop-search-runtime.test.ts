import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { OpResult } from "@ruukoto/control/ops.ts";
import { product } from "../apps/ruukoto-code/src/product.ts";
import { handleRequest } from "../apps/desktop/src/main/ipc.ts";
import { startTestRuntime } from "./helpers/testkit.ts";

const record = (id: string, text: string, role = "user") => ({ type: "message", id, parentId: null, timestamp: "2026-10-21T00:00:00Z", message: { role, content: [{ type: "text", text }] } });

test("工作区搜索：后台普通身份、组织归属、存档与旧搜索语义", async () => {
  const t = await startTestRuntime("spotlight-runtime", async () => ({ kind: "text", text: "unused" }), { config: { product: product.runtime } });
  try {
    const first = await t.runtime.openWorkspace({ cwd: t.work[0] });
    const second = await t.runtime.openWorkspace({ cwd: t.work[1] });
    const archived = t.runtime.store.setSessionArchived(second.session.id, true);
    t.runtime.store.db.prepare("UPDATE sessions SET workspace_project_id = ? WHERE id = ?").run(first.session.projectId, archived.id);
    const retired = t.runtime.store.createSession({ projectId: first.session.projectId, cwd: t.work[0], cwdReal: t.work[0], cwdDev: 1, cwdIno: 1, piSessionId: "retired", confirmTools: [], kind: "qq_group" });
    const roleSession = t.runtime.store.createSession({ projectId: first.session.projectId, cwd: t.work[0], cwdReal: t.work[0], cwdDev: 1, cwdIno: 1, piSessionId: "role", confirmTools: [] });
    t.runtime.store.insertAgentRole({ id: "coding", projectId: first.session.projectId, sessionId: roleSession.id, workDir: t.work[0], modelSelection: null, tools: [], createdAt: "2026-10-21T00:00:00Z" });
    for (const session of [first.session, second.session, retired, roleSession]) {
      const file = path.join(t.dirs.dataDir, `${session.id}.jsonl`);
      fs.writeFileSync(file, `${JSON.stringify(record(`${session.id}-user`, "中文 NeEdLe"))}\n${JSON.stringify(record(`${session.id}-tool`, "hidden-tool-needle", "toolResult"))}\n`);
      t.runtime.store.setSessionFile(session.id, file);
    }
    const summaries = await t.client.request<OpResult<"list_session_summaries">>("list_session_summaries", { scope: "workspace_chats" });
    assert.deepEqual(new Set(summaries.map(item => item.sessionId)), new Set([first.session.id, second.session.id]));
    assert.equal(summaries.find(item => item.sessionId === second.session.id)?.workspaceId, first.session.projectId);
    assert.ok(summaries.find(item => item.sessionId === second.session.id)?.archivedAt);
    const found: OpResult<"search_history">["hits"] = [];
    let cursor: OpResult<"search_history">["cursor"] = null;
    for (let n = 0; n < 20; n++) {
      const page: OpResult<"search_history"> = await t.client.request("search_history", { scope: "workspace_chats", query: "needle", scan_limit: 1, cursor: cursor && { session_id: cursor.sessionId, byte_offset: cursor.byteOffset, ...("phase" in cursor ? { phase: cursor.phase, read_offset: cursor.readOffset, query_key: cursor.queryKey, source: { file_dev: cursor.source.fileDev, file_ino: cursor.source.fileIno, min_size: cursor.source.minSize } } : {}) } });
      found.push(...page.hits);
      cursor = page.cursor;
      if (page.complete) break;
      assert.ok(cursor, "未完成页必须有可推进游标");
      assert.ok(n < 19, "固定语料必须终止");
    }
    assert.deepEqual(new Set(found.map(hit => hit.entryId)), new Set([`${first.session.id}-user`, `${second.session.id}-user`]));
    assert.equal(found.length, 2);
    const legacy = await t.client.request<OpResult<"search_history">>("search_history", { query: "hidden-tool-needle", session_id: retired.id });
    assert.equal(legacy.hits.length, 1);
    for (const params of [{ scope: "other", query: "中文" }, { scope: "workspace_chats", query: "中文", session_id: first.session.id }, { scope: "workspace_chats", query: "中文", cursor: { session_id: first.session.id, byte_offset: NaN } }, { query: "中文", scan_limit: 1.5 }]) {
      await assert.rejects(t.client.request("search_history", params), (error: { code?: string }) => error.code === "invalid_params");
    }
    await assert.rejects(t.client.request("list_session_summaries", { scope: "workspace_chats", workspace_id: first.session.projectId }), (error: { code?: string }) => error.code === "invalid_params");
  } finally { await t.shutdown(); }
});

test("Personal 拒绝工作区搜索，双壳共用白名单只向 Code 放行", async () => {
  const t = await startTestRuntime("spotlight-personal", async () => ({ kind: "text", text: "unused" }));
  try {
    for (const op of ["search_history", "list_session_summaries"]) await assert.rejects(t.client.request(op, { query: "x", scope: "workspace_chats" }), (error: { code?: string }) => error.code === "unavailable");
    let calls = 0;
    const forward = async () => { calls++; return {}; };
    assert.equal((await handleRequest("code", "search_history", { query: "x", scope: "workspace_chats" }, async () => {}, forward)).ok, true);
    assert.equal((await handleRequest("personal", "search_history", { query: "x", scope: "workspace_chats" }, async () => {}, forward)).ok, false);
    assert.equal(calls, 1);
  } finally { await t.shutdown(); }
});

test("控制面历史定位：互斥方向、来源续页与长正文补读，旧最新页不变", async () => {
  const t = await startTestRuntime("spotlight-window", async () => ({ kind: "text", text: "unused" }), { config: { product: product.runtime } });
  try {
    const { session } = await t.runtime.openWorkspace({ cwd: t.work[0] });
    const file = path.join(t.dirs.dataDir, "window.jsonl");
    const body = "完整中文正文".repeat(5000);
    fs.writeFileSync(file, `${Array.from({ length: 420 }, (_, n) => JSON.stringify(record(`entry-${n}`, n === 10 ? body : String(n)))).join("\n")}\n`);
    t.runtime.store.setSessionFile(session.id, file);
    const page = await t.client.request<OpResult<"read_history">>("read_history", { session_id: session.id, around: "entry-10", limit: 5, entry_text_cap: 256 });
    assert.deepEqual(page.entries.map(entry => entry.entryId), ["entry-8", "entry-9", "entry-10", "entry-11", "entry-12"]);
    assert.ok(page.source);
    const next = await t.client.request<OpResult<"read_history">>("read_history", { session_id: session.id, after: page.nextAfter, source: page.source, limit: 2 });
    assert.deepEqual(next.entries.map(entry => entry.entryId), ["entry-13", "entry-14"]);
    let text = "";
    while (Buffer.byteLength(text) < Buffer.byteLength(body)) {
      const part: OpResult<"read_history_entry"> = await t.client.request<OpResult<"read_history_entry">>("read_history_entry", { session_id: session.id, entry_id: "entry-10", offset: Buffer.byteLength(text), length: 7000, source: page.source });
      assert.equal(part.offset, Buffer.byteLength(text));
      text += part.text;
    }
    assert.equal(text, body);
    assert.equal(t.runtime.readHistory({ sessionId: session.id, limit: 1 }).entries[0].entryId, "entry-419");
    await assert.rejects(t.client.request("read_history", { session_id: session.id, before: "entry-10", around: "entry-10" }), (error: { code?: string }) => error.code === "invalid_params");
    fs.writeFileSync(file, `${JSON.stringify(record("replacement", "new file"))}\n`);
    await assert.rejects(t.client.request("read_history", { session_id: session.id, before: page.nextBefore, source: page.source }), (error: { code?: string }) => error.code === "history_changed");
  } finally { await t.shutdown(); }
});

test("内部报告只隐藏宿主输入，可展示的 Agent 最终总结仍可搜索", async () => {
  const t = await startTestRuntime("spotlight-report", async () => ({ kind: "text", text: "unused" }), { config: { product: product.runtime } });
  try {
    const { session } = await t.runtime.openWorkspace({ cwd: t.work[0] });
    const task = t.runtime.store.insertQueuedTask({ sessionId: session.id, requestId: "report", input: "内部报告针", modelSelection: t.runtime.defaultSelection, submissionDigest: "synthetic" }).task;
    t.runtime.store.db.prepare("UPDATE tasks SET status = 'completed', history_entry_ids = ? WHERE id = ?").run(JSON.stringify(["report-user", "report-assistant"]), task.id);
    const report: import("@ruukoto/core/agent-wait.ts").AgentReport = {
      key: `task:${task.id}`, target: { kind: "task", taskId: task.id }, parentSessionId: session.id,
      source: { product: "ruukoto-code", projectId: session.projectId, sessionId: session.id, taskId: task.id, permissionVersion: 1, accessMode: "confirm", grantedPaths: [], capabilities: [], references: [], replyTarget: null, scheduledRunId: null },
      sourceEventId: null, dependencyTaskIds: [], claimTaskId: null, fallbackTaskId: task.id, parkedFallbackTaskIds: [], fallbackState: "completed", consumption: null, proof: null, status: "reported", reason: null,
    };
    t.runtime.store.db.prepare("INSERT INTO agent_reports (report_key, parent_session_id, payload) VALUES (?, ?, ?)").run(report.key, session.id, JSON.stringify(report));
    const file = path.join(t.dirs.dataDir, "report.jsonl");
    const { TASK_START_MARKER, TASK_END_MARKER } = await import("@ruukoto/core/types.ts");
    fs.writeFileSync(file, [
      { type: "custom", id: "start", customType: TASK_START_MARKER, data: { taskId: task.id } },
      record("report-user", "内部报告针"), record("report-assistant", "最终总结针", "assistant"),
      { type: "custom", id: "end", customType: TASK_END_MARKER, data: { taskId: task.id } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    t.runtime.store.setSessionFile(session.id, file);
    const visible = t.runtime.readHistory({ sessionId: session.id });
    assert.equal(visible.entries[0].inputPurpose, "internal_report");
    const page = await t.client.request<OpResult<"search_history">>("search_history", { query: "针", scope: "workspace_chats" });
    assert.deepEqual(page.hits.map(hit => hit.entryId), ["report-assistant"]);
    assert.deepEqual(page.sourceIssues, []);
  } finally { await t.shutdown(); }
});
