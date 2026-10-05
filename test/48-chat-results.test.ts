/** 群结果经 main 明确接收；仅使用本地 SQLite，不启动模型或 QQ 连接。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Db, SCHEMA_VERSION } from "../src/core/db.ts";
import { Store } from "../src/core/store.ts";
import { AccessScope } from "../src/core/access.ts";
import { QqStore } from "../src/qq/store.ts";
import type { Session } from "../src/core/types.ts";
import type { HostToolContext } from "../src/agent/host-tools.ts";
import { chatResultOpCheck, createChatResultTools, resolveAcceptedChatResult } from "../src/agent/chat-result-tools.ts";
import { ToolOpLedger } from "../src/agent/tool-op-ledger.ts";
import { seedGroupSessionRow, seedInboxRow, seedLinkInboxTask, seedPendingOutbox } from "./helpers/legacy-group-archive.ts";

const at = (seconds: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + seconds * 1000).toISOString();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-chat-results-"));
  const db = new Db(root);
  const store = new Store(db);
  const qq = new QqStore(db);
  const modelSelection = { provider: "mock", modelId: "mock", thinkingLevel: "off" as const };
  const sessions = {} as Record<"main" | "coding" | "a" | "b", Session>;
  for (const name of ["main", "coding", "a", "b"] as const) {
    const project = store.createProject(name);
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    const stat = fs.statSync(cwd);
    const group = name === "a" || name === "b";
    const session = store.createSession({
      projectId: project.id, kind: group ? "qq_group" : "dev", cwd, cwdReal: fs.realpathSync(cwd),
      cwdDev: stat.dev, cwdIno: stat.ino, piSessionId: name, sessionFile: null, confirmTools: [], modelSelection,
    });
    sessions[name] = session;
    if (name === "main" || name === "coding") {
      store.insertAgentRole({ id: name, projectId: project.id, sessionId: session.id, workDir: cwd, modelSelection, tools: [], createdAt: session.createdAt });
    } else {
      seedGroupSessionRow(store, { account: "1000", groupId: name === "a" ? "2000" : "3000", sessionId: session.id, projectId: project.id, workDir: cwd });
    }
  }
  const mainTask = store.insertQueuedTask({ sessionId: sessions.main.id, requestId: "owner", input: "整理群摘要", modelSelection, submissionDigest: "owner" }).task;
  store.transitionTask(mainTask.id, ["queued"], "running", { startedAt: at(0) });
  let ctx: HostToolContext = { taskId: mainTask.id, sessionId: sessions.main.id, projectId: sessions.main.projectId, hostOpId: "" };
  let seq = 0;
  const tools = createChatResultTools({ coreStore: store, qqStore: qq, taskContext: () => ctx, verifyMain: () => null });
  const call = async (name: string, params: Record<string, unknown>, override?: Partial<HostToolContext>) => {
    ctx = { taskId: mainTask.id, sessionId: sessions.main.id, projectId: sessions.main.projectId, hostOpId: `op-${++seq}`, ...override };
    store.recordToolIntent({ id: ctx.hostOpId, taskId: ctx.taskId, sessionId: ctx.sessionId, toolName: name, params });
    const result = await tools.find((tool) => tool.name === name)!.execute(ctx.hostOpId, params, undefined, undefined, {} as ExtensionContext);
    return JSON.parse(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
  };
  const source = (name: "a" | "b", messageId: string, summary: string, time: number, complete = true) => {
    const session = sessions[name];
    const groupId = name === "a" ? "2000" : "3000";
    const { row } = seedInboxRow(store, qq, { account: "1000", groupId, userId: "4000", senderName: "PRIVATE-NAME", messageId,
      text: `PRIVATE-INPUT-${messageId}`, taskInput: `PRIVATE-INPUT-${messageId}`, messageTime: at(time) });
    db.prepare("UPDATE qq_inbox SET created_at = ? WHERE dedup_key = ?").run(at(time), row.dedupKey);
    const { event } = store.registerInboundEvent({ source: "qq_group", externalId: row.dedupKey, actor: row.userId, targetRole: "chat", body: row.input });
    const { task } = store.insertQueuedTask({ sessionId: session.id, requestId: row.requestId, input: row.input, modelSelection,
      submissionDigest: row.dedupKey, agentId: "chat", sourceEventId: event.id });
    seedLinkInboxTask(store, row.dedupKey, session.id, task.id);
    store.markInboundQueued(event.id, task.id);
    store.transitionTask(task.id, ["queued"], "running", { startedAt: at(time + 1) });
    if (complete) {
      store.transitionTask(task.id, ["running"], "completed", { endedAt: at(time + 2) });
      store.setTaskResult(task.id, summary, JSON.stringify({ taskId: task.id, sessionId: session.id }));
      store.setInboundTerminal(event.id, "done");
    }
    return { task: store.getTask(task.id)!, event, row };
  };
  return { db, store, qq, sessions, mainTask, source, call, lastOp: () => ctx.hostOpId,
    close: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("群结果：列表仅元数据、分页；main 显式接收有界快照，不外发或开放原始群资料", async () => {
  const f = fixture();
  try {
    const first = f.source("a", "1", "SUMMARY-SECRET-" + "😀".repeat(1100), 1);
    const second = f.source("b", "2", "OTHER-SUMMARY", 5);
    const page = await f.call("chat_result_list", { limit: 1 });
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0].task_id, second.task.id);
    assert.equal(page.results[0].accepted, false);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE|SUMMARY/);
    const next = await f.call("chat_result_list", { limit: 1, cursor: page.next_cursor });
    assert.equal(next.results[0].task_id, first.task.id);
    assert.equal(next.next_cursor, null);
    assert.throws(() => resolveAcceptedChatResult(f.store, f.qq, f.sessions.main.projectId, first.task.id), /尚未经 main/);
    const accepted = await f.call("chat_result_accept", { task_id: first.task.id, reason: "记录群讨论结论" });
    const opId = f.lastOp();
    assert.equal([...accepted.summary].length, 1000);
    assert.ok(!accepted.summary.includes("\uFFFD"), "Unicode 字符不被截断");
    assert.deepEqual(accepted.source, { kind: "chat_result", task_id: first.task.id });
    assert.equal(accepted.source_event_id, first.event.id);
    assert.equal(accepted.group_id, "2000");
    const record = f.store.getAcceptedChatResult(f.sessions.main.projectId, first.task.id)!;
    assert.equal(record.acceptedByTaskId, f.mainTask.id);
    assert.equal(record.acceptedByOpId, opId);
    assert.equal(record.reason, "记录群讨论结论");
    f.db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run("MUTATED-SUMMARY", first.task.id);
    const repeated = await f.call("chat_result_accept", { task_id: first.task.id, reason: "再次查看" });
    assert.equal(repeated.summary, accepted.summary, "重复接收复用首次快照");
    assert.equal(repeated.accepted_at, accepted.accepted_at);
    assert.equal(f.store.getAcceptedChatResult(f.sessions.main.projectId, first.task.id)!.reason, record.reason);
    assert.equal(resolveAcceptedChatResult(f.store, f.qq, f.sessions.main.projectId, first.task.id).summary, accepted.summary);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM notification_ops").get() as any).count, 0);
    const access = new AccessScope(f.db);
    for (const name of ["main", "coding"] as const) {
      access.createGrant({ fromProjectId: f.sessions.a.projectId, toProjectId: f.sessions[name].projectId, category: "history" });
      assert.equal(access.canAccess({ kind: "agent", projectId: f.sessions[name].projectId }, f.sessions.a.projectId, "history"), false);
    }
    assert.throws(() => resolveAcceptedChatResult(f.store, f.qq, f.sessions.coding.projectId, first.task.id), /仅 main/);
    assert.equal((await f.call("chat_result_list", {})).results.find((r: any) => r.task_id === first.task.id).accepted, true);
  } finally { f.close(); }
});

test("群结果：拒绝错误身份、未完成任务和伪造来源；停止恢复按接收账本核实", async () => {
  const f = fixture();
  try {
    const source = f.source("a", "1", "READY", 1);
    const running = f.source("a", "2", "NOT-READY", 5, false);
    await assert.rejects(f.call("chat_result_accept", { task_id: running.task.id, reason: "未完成" }), /已完成且已记录结果/);
    await assert.rejects(f.call("chat_result_accept", { task_id: source.task.id, reason: " " }), /reason/);
    await assert.rejects(f.call("chat_result_list", { limit: 51 }), /limit/);
    await assert.rejects(f.call("chat_result_accept", { task_id: source.task.id, reason: "伪装 main" }, { sessionId: f.sessions.coding.id, projectId: f.sessions.coding.projectId }), /仅宿主绑定的 main/);
    f.db.prepare("UPDATE inbound_events SET actor = 'forged' WHERE id = ?").run(source.event.id);
    await assert.rejects(f.call("chat_result_accept", { task_id: source.task.id, reason: "伪造来源" }), /映射不匹配/);
    assert.equal((await f.call("chat_result_list", {})).results.length, 0);
    f.db.prepare("UPDATE inbound_events SET actor = ? WHERE id = ?").run(source.row.userId, source.event.id);
    f.db.prepare("UPDATE qq_inbox SET session_id = ? WHERE task_id = ?").run(f.sessions.b.id, source.task.id);
    await assert.rejects(f.call("chat_result_accept", { task_id: source.task.id, reason: "跨群映射" }), /映射不匹配/);
    f.db.prepare("UPDATE qq_inbox SET session_id = ? WHERE task_id = ?").run(f.sessions.a.id, source.task.id);
    await f.call("chat_result_accept", { task_id: source.task.id, reason: "正常接收" });
    const committed = f.store.getToolOp(f.lastOp())!;
    const missingId = "accept-never-committed";
    f.store.recordToolIntent({ id: missingId, taskId: f.mainTask.id, sessionId: f.sessions.main.id, toolName: "chat_result_accept", params: { task_id: running.task.id } });
    const ledger = new ToolOpLedger(f.store, { chat_result: chatResultOpCheck(f.store) });
    f.store.withTx(() => ledger.settleAll());
    assert.match(f.store.getToolOp(committed.id)!.resultSummary!, /^已提交/);
    assert.match(f.store.getToolOp(missingId)!.resultSummary!, /^已知未提交/);
    assert.equal(f.store.getToolOp(committed.id)!.effectUnknown, false);
    const seq = f.store.getMaxSeq();
    f.store.withTx(() => ledger.settleAll());
    assert.equal(f.store.getMaxSeq(), seq, "重复恢复不重复发布回执");
  } finally { f.close(); }
});

test("schema v16 → v17 保留群任务、收件与发送事实，旧撤回时间保守回填且迁移幂等", () => {
  const f = fixture();
  const root = path.dirname(f.db.file);
  let db: Db | undefined = f.db;
  try {
    const source = f.source("a", "old", "OLD-RESULT", 1);
    f.qq.markRecalled("1000", "2000", "old");
    seedPendingOutbox(f.store, f.qq, { taskId: source.task.id, account: "1000", groupId: "2000", replyToMessageId: "old", text: "原发送正文" });
    const task = f.store.getTask(source.task.id);
    const groups = f.qq.listGroupSessions();
    const sends = f.qq.listOutbox();
    const instance = db.getInstanceId();
    db.exec(`DROP TABLE chat_result_acceptances;
      ALTER TABLE qq_inbox DROP COLUMN recalled_at;
      ALTER TABLE qq_inbox DROP COLUMN reply_to_message_id;
      ALTER TABLE qq_inbox DROP COLUMN config_version;
      UPDATE meta SET value = '16' WHERE key = 'schema_version'`);
    db.close();
    db = undefined;
    let recalledAt: string | null = null;
    for (let round = 0; round < 2; round++) {
      db = new Db(root);
      const qq = new QqStore(db);
      assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any).value, String(SCHEMA_VERSION));
      assert.equal(db.getInstanceId(), instance);
      assert.deepEqual(new Store(db).getTask(source.task.id), task);
      assert.deepEqual(qq.listGroupSessions(), groups);
      assert.deepEqual(qq.listOutbox(), sends);
      const row = qq.getInbox(source.row.dedupKey)!;
      assert.ok(row.recalledAt);
      if (recalledAt) assert.equal(row.recalledAt, recalledAt);
      recalledAt = row.recalledAt;
      assert.equal(row.configVersion, null);
      assert.equal(row.replyToMessageId, null);
      assert.equal(row.requestId, source.row.requestId);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal((db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chat_result_acceptances").get() as any).n, 0);
      db.close();
      db = undefined;
    }
  } finally {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("群结果：来源及先前交互撤回使旧摘要失效，其他群及撤回后新任务仍可接收", async () => {
  const f = fixture();
  try {
    const prior = f.source("a", "1", "PRIOR", 1);
    const derived = f.source("a", "2", "DERIVED", 5);
    const other = f.source("b", "1", "OTHER-GROUP", 5);
    for (const item of [prior, derived, other]) await f.call("chat_result_accept", { task_id: item.task.id, reason: "记录结果" });
    f.qq.markRecalled("1000", "2000", "1");
    f.db.prepare("UPDATE qq_inbox SET recalled_at = ? WHERE dedup_key = ?").run(at(10), prior.row.dedupKey);
    for (const item of [prior, derived]) {
      assert.throws(() => resolveAcceptedChatResult(f.store, f.qq, f.sessions.main.projectId, item.task.id), /撤回/);
      await assert.rejects(f.call("chat_result_accept", { task_id: item.task.id, reason: "重试接收" }), /撤回/);
    }
    assert.equal(resolveAcceptedChatResult(f.store, f.qq, f.sessions.main.projectId, other.task.id).summary, "OTHER-GROUP");
    assert.deepEqual((await f.call("chat_result_list", {})).results.map((r: any) => r.task_id), [other.task.id]);
    const fresh = f.source("a", "3", "FRESH-AFTER-RECALL", 11);
    assert.equal((await f.call("chat_result_accept", { task_id: fresh.task.id, reason: "撤回后新结果" })).summary, "FRESH-AFTER-RECALL");
    assert.equal(f.store.getAcceptedChatResult(f.sessions.main.projectId, derived.task.id)!.summary, "DERIVED", "保留原接收审计快照");
  } finally { f.close(); }
});
