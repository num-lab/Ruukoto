import { personalServiceSourceBlocker } from "../apps/ruukoto/src/personal-service-operations.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { LocalInputDoc } from "../apps/ruukoto/src/personal-local-records.ts";
import { PersonalSchedulesDoc, PersonalScheduleRunDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { appDataDecide, appDataList, appDataOperations, appDataRecheck, PersonalAppDataDoc, PERSONAL_APP_DATA_TOOLS } from "../apps/ruukoto/src/personal-app-data.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { AppDataStore } from "../packages/agent/src/app-data/store.ts";
import { AppDataQueryRunner } from "../packages/agent/src/app-data/query.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const define = { table: "todos", fields: [{ name: "title", type: "text" }], expected_schema_version: 0, reason: "记录待办" };
const insert = { table: "todos", records: [{ title: "买茶" }, { title: "买米" }], expected_schema_version: 1, reason: "新增待办" };
const call = (name: string, args: Record<string, unknown>, id = name) => ({ kind: "tool_calls" as const, calls: [{ id, name, arguments: args }] });
async function fixture(t: TestContext, responder: Responder, extra: Partial<Pick<Parameters<typeof openPersonalHarness>[0], "telegram" | "qq">> = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "ruukoto-app-data-"))), server = new MockModelServer(responder), previous = process.env.APP_DATA_TEST_KEY;
  const baseUrl = await server.start(); process.env.APP_DATA_TEST_KEY = "test-only";
  const options = { directory, provider: personalProvider({ api: "openai-completions", baseUrl, modelId: "app-data-model", apiKeyEnv: "APP_DATA_TEST_KEY", contextWindow: 128000, maxTokens: 2048 }), modelId: "app-data-model", ...extra };
  let p: PersonalHarness; const open = async () => p = await openPersonalHarness(options);
  t.after(async () => { await p?.close(); await server.close(); if (previous === undefined) delete process.env.APP_DATA_TEST_KEY; else process.env.APP_DATA_TEST_KEY = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  await open();
  return { directory, server, options, baseUrl, open, get p() { return p; }, file: path.join(directory, "agent-data", "main.db"), operations: () => p.harness.commit(async tx => JSON.parse(JSON.stringify(await appDataOperations(tx))) as Awaited<ReturnType<typeof appDataOperations>>, context) };
}
async function until<T>(fn: () => Promise<T | undefined>, message = "等待状态") { for (let i = 0; i < 400; i++) { const value = await fn(); if (value) return value; await delay(10); } throw new Error(message); }
function sql(file: string, query: string) { const db = new DatabaseSync(file); try { return db.prepare(query).all().map(row => ({ ...row })); } finally { db.close(); } }

test("应用数据：六工具真实SQLite接线，同轮多调用有独立回执及请求快照", async t => {
  const f = await fixture(t, (_request, i) => [call("app_data_query", { mode: "schema" }), call("app_data_define_table", define), { kind: "tool_calls" as const, calls: [{ id: "one", name: "app_data_insert", arguments: { ...insert, records: [insert.records[0]] } }, { id: "two", name: "app_data_insert", arguments: { ...insert, records: [insert.records[1]] } }] }, call("app_data_update", { table: "todos", rows: [{ id: 1, expected_version: 1, set: { title: "绿茶" } }], reason: "更正" }), call("app_data_delete", { table: "todos", rows: [{ id: 2, expected_version: 1 }], reason: "完成" }), call("app_data_migrate", { expected_schema_version: 1, steps: [{ op: "add_field", table: "todos", field: { name: "memo", type: "text", nullable: true } }], reason: "增加备注" }), call("app_data_query", { mode: "rows", table: "todos" }), call("app_data_query", { mode: "changes" })][i] ?? { kind: "text", text: "已更新待办" });
  assert.equal(await f.p.answer("保存并更新待办", "app-data-source"), "已更新待办");
  const ops = await f.operations(); assert.equal(ops.length, 6); assert.equal(new Set(ops.map(op => op.opId)).size, 6); assert.ok(ops.every(op => op.result?.effect === "committed"));
  assert.deepEqual(sql(f.file, 'SELECT title, memo, _version FROM todos'), [{ title: "绿茶", memo: null, _version: 2 }]);
  const audit = sql(f.file, "SELECT task_id, session_id, operation FROM app_audit"); assert.equal(audit.length, 6); assert.ok(audit.every(row => String(row.task_id).startsWith("durable:") && String(row.operation).includes("requestFingerprint")));
  assert.deepEqual(sql(f.file, "SELECT value FROM app_meta WHERE key='schema_version'"), [{ value: "2" }]);
  const tools = JSON.stringify(f.server.calls[0]); for (const name of PERSONAL_APP_DATA_TOOLS) assert.match(tools, new RegExp(name));
  await f.p.close(); await f.open(); assert.deepEqual(await f.operations(), ops);
});

test("应用数据：破坏性操作三模式，批准单次消费且修订变化拒绝", async t => {
  for (const mode of ["auto-review", "confirm", "full_access"] as const) await t.test(mode, async t => {
    const f = await fixture(t, (_request, i) => [call("app_data_define_table", define), call("app_data_insert", insert), call("app_data_update", { table: "todos", rows: [{ id: 1, expected_version: 1, set: { title: "甲" } }, { id: 2, expected_version: 1, set: { title: "乙" } }], reason: "批量更正" }), call("app_data_migrate", { expected_schema_version: 1, steps: [{ op: "drop_table", table: "todos" }], reason: "清理表" })][i] ?? { kind: "text", text: "结束" });
    await f.p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = mode; }, context);
    const answer = f.p.answer("批量整理待办", `mode-${mode}`);
    const op = await until(async () => (await f.operations()).find(op => op.name === "app_data_update"));
    if (mode !== "full_access") {
      assert.equal(op.decision, "pending"); assert.equal(op.started, undefined); assert.equal(sql(f.file, "SELECT title FROM todos")[0].title, "买茶");
      await f.p.harness.commit(tx => appDataDecide(tx, f.directory, op.operation, "approved"), context);
      await assert.rejects(f.p.harness.commit(tx => appDataDecide(tx, f.directory, op.operation, "approved"), context));
    }
    const migration = await until(async () => (await f.operations()).find(op => op.name === "app_data_migrate"));
    if (mode !== "full_access") { assert.equal(migration.decision, "pending"); await f.p.harness.commit(tx => appDataDecide(tx, f.directory, migration.operation, "approved"), context); }
    await answer; const changed = (await f.operations()).find(value => value.operation === op.operation)!;
    assert.equal(changed.result?.effect, "committed"); assert.equal((await f.operations()).at(-1)!.result?.effect, "committed"); assert.equal(sql(f.file, "SELECT name FROM sqlite_master WHERE name='todos'").length, 0);
  });
});

test("应用数据：绑定库缺失或换库不会重建，其他聊天仍可继续，查询子进程复核身份", async t => {
  const f = await fixture(t, (_request, i) => i === 0 ? call("app_data_define_table", define) : i === 2 ? call("app_data_insert", insert) : { kind: "text", text: "继续聊天" });
  await f.p.answer("建表", "create"); await f.p.close();
  fs.renameSync(f.file, `${f.file}.saved`); await f.open();
  assert.equal(fs.existsSync(f.file), false); await f.p.answer("新增", "missing"); assert.equal(fs.existsSync(f.file), false);
  assert.equal(await f.p.answer("聊天", "independent"), "继续聊天");
  await f.p.close(); fs.renameSync(`${f.file}.saved`, f.file); await f.open();
  const binding = (await f.p.harness.snapshot(PersonalAppDataDoc, context))!;
  const other = new AppDataStore(path.join(f.directory, "other.db")); const otherId = other.getInstanceId(); other.close();
  const runner = new AppDataQueryRunner(); try { await assert.rejects(runner.run(path.join(f.directory, "other.db"), { mode: "schema" }, { expectedInstanceId: binding.instanceId }), error => error instanceof Error && "code" in error && error.code === "app_data_identity_changed"); } finally { await runner.dispose(); }
  assert.notEqual(binding.instanceId, otherId);
});

async function crashInsert(f: Awaited<ReturnType<typeof fixture>>, directory = f.directory, phase = "write") {
  await f.p.close();
  const child = spawn(process.execPath, ["--import", "tsx", "test/helpers/personal-app-data-crash.mts", directory, f.baseUrl, phase], { env: { ...process.env, APP_DATA_TEST_KEY: "test-only" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal })); });
  assert.equal(ended.signal, "SIGKILL", stderr);
}
test("应用数据：提交后durable结果前强杀，重启原键核实且只写一次", async t => {
  const f = await fixture(t, (_request, i) => i === 0 ? call("app_data_define_table", define) : i === 2 ? call("app_data_insert", insert) : { kind: "text", text: "已核实" });
  await f.p.answer("准备表", "prepare"); await crashInsert(f);
  assert.equal(sql(f.file, "SELECT * FROM todos").length, 2);
  await f.open(); await f.p.harness.waitForIdle(context);
  const ops = await f.operations(); assert.equal(ops.length, 2); assert.ok(ops.every(op => op.result?.effect === "committed"));
  assert.equal(sql(f.file, "SELECT * FROM todos").length, 2); assert.equal(sql(f.file, "SELECT * FROM app_audit WHERE tool_name='app_data_insert'").length, 1);
  const original = ops[1].result;
  await f.p.harness.commit(tx => appDataRecheck(tx, f.directory, ops[1].operation), context);
  assert.deepEqual((await f.operations())[1].result, original);
});

test("应用数据：强杀后缺库、换库和合法JSON损坏回执保持未知，不重放且其他工作继续", async t => {
  for (const fault of ["missing", "identity", "receipt", "receipt-key", "receipt-removed"] as const) await t.test(fault, async t => {
    const f = await fixture(t, (_request, i) => i === 0 ? call("app_data_define_table", define) : i === 2 ? call("app_data_insert", insert) : { kind: "text", text: "独立工作继续" });
    await f.p.answer("准备表", "prepare"); await crashInsert(f);
    const original = fs.readFileSync(f.file); const wal = fs.existsSync(`${f.file}-wal`) ? fs.readFileSync(`${f.file}-wal`) : undefined;
    if (fault === "missing") { for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${f.file}${suffix}`, { force: true }); }
    else { const db = new DatabaseSync(f.file); try { if (fault === "identity") db.exec("UPDATE app_meta SET value='appdb_changed' WHERE key='instance_id'"); else if (fault === "receipt-key") db.exec("UPDATE app_audit SET op_id='corrupted-key' WHERE tool_name='app_data_insert'"); else if (fault === "receipt-removed") db.exec("DELETE FROM app_audit WHERE tool_name='app_data_insert'"); else db.exec("UPDATE app_audit SET affected='corrupt-but-valid-text' WHERE tool_name='app_data_insert'"); } finally { db.close(); } }
    await f.open(); await f.p.harness.waitForIdle(context);
    const op = (await f.operations())[1]; assert.equal(op.result?.effect, "effect_unknown");
    assert.deepEqual(await f.p.harness.commit(tx => personalServiceSourceBlocker(tx, "crash-source"), context), { appData: String(op.operation), admission: op.admission });
    await assert.rejects(f.p.work.delegate({ content: "不能换子工作重试", requestId: "blocked-child", sourceRequestId: "crash-source" }), error => error instanceof Error && "code" in error && error.code === "work_source_paused");
    assert.equal(await f.p.answer("另一件独立工作", "independent"), "独立工作继续");
    if (fault === "missing") assert.equal(fs.existsSync(f.file), false);
    await f.p.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${f.file}${suffix}`, { force: true });
    fs.writeFileSync(f.file, original); if (wal) fs.writeFileSync(`${f.file}-wal`, wal);
    await f.open(); await f.p.harness.commit(tx => appDataRecheck(tx, f.directory, op.operation), context);
    assert.equal((await f.operations())[1].result?.effect, "committed"); assert.equal(sql(f.file, "SELECT * FROM todos").length, 2);
  });
});

test("应用数据：批准后revision或权限变化不执行；默认模式变化不扩大旧输入", async t => {
  for (const fault of ["revision", "permission"] as const) await t.test(fault, async t => {
    const f = await fixture(t, (_request, i) => [call("app_data_define_table", define), call("app_data_insert", insert), call("app_data_delete", { table: "todos", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "批量完成" })][i] ?? { kind: "text", text: "已停止原操作" });
    const answer = f.p.answer("批量完成", "pending-source");
    const op = await until(async () => (await f.operations()).find(op => op.name === "app_data_delete"));
    await f.p.harness.commit(async tx => {
      await appDataDecide(tx, f.directory, op.operation, "approved");
      if (fault === "revision") { const store = new AppDataStore(f.file); try { store.insert({ table: "todos", records: [{ title: "并发记录" }], reason: "合法并发写", opId: "concurrent", ctx: { taskId: "test", sessionId: "test", agentId: "test" } }); } finally { store.close(); } }
      else (await tx.doc(LocalInputDoc, "pending-source", "")).permission!.version++;
    }, context);
    await answer;
    assert.equal((await f.operations())[2].result?.effect, "not_committed");
    assert.equal(sql(f.file, "SELECT * FROM todos").length, fault === "revision" ? 3 : 2);
    assert.equal(sql(f.file, "SELECT * FROM app_audit WHERE tool_name='app_data_delete'").length, 0);
  });
});

test("应用数据：子工作显式资格，复用身份不继承，SDK规范化参数可恢复", async t => {
  const f = await fixture(t, request => {
    if (request.system?.includes("你是个人助手的子 Agent")) {
      if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: "子操作结束" };
      return call("app_data_define_table", { ...define, expected_schema_version: "0" });
    }
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: String(request.messages.at(-1)?.content) };
    const text = String(request.messages.at(-1)?.content);
    return call("background_work", { action: "delegate", content: "处理业务表", ...(text.startsWith("复用:") ? { agent: Number(text.split(":")[1]) } : { appData: true }) });
  });
  const first = JSON.parse(await f.p.answer("委派应用数据", "delegate-first")) as { agent: number; work: number };
  await f.p.harness.waitForTask(first.work as TaskId, context);
  assert.equal((await f.operations()).length, 1); assert.equal((await f.operations())[0].result?.effect, "committed");
  const child = await f.p.harness.snapshot(AgentDoc, first.agent as ConversationId, context);
  assert.ok(Array.isArray(child?.tools) && !child.tools.includes("app_data_define_table"));
  const second = JSON.parse(await f.p.answer(`复用:${first.agent}`, "delegate-second")) as { work: number };
  await f.p.harness.waitForTask(second.work as TaskId, context); assert.equal((await f.operations()).length, 1);
  const requests = f.server.calls.filter(request => request.system?.includes("你是个人助手的子 Agent"));
  assert.ok(JSON.stringify(requests[0].tools).includes("app_data_define_table")); assert.ok(!JSON.stringify(requests.at(-1)!.tools).includes("app_data_define_table"));
  await f.p.close(); await f.open(); assert.equal((await f.operations())[0].result?.effect, "committed");
});

test("应用数据：独立定时与汇总读原库，子工作明确授权", async t => {
  let initial = false, summary = false, child = false;
  const f = await fixture(t, request => {
    if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: "阶段完成" };
    if (request.system?.includes("你是个人助手的子 Agent")) { child = true; return call("app_data_query", { mode: "schema" }); }
    if (request.system?.includes("你是个人助手的一次独立定时执行")) {
      if (!initial) { initial = true; return { kind: "tool_calls", calls: [{ id: "scheduled-table", name: "app_data_define_table", arguments: define }, { id: "scheduled-child", name: "background_work", arguments: { action: "delegate", content: "检查业务结构", appData: true } }] }; }
      summary = true; assert.ok(!JSON.stringify(request.tools).includes("app_data_insert")); return call("app_data_query", { mode: "rows", table: "todos" });
    }
    return { kind: "text", text: "主聊天" };
  });
  const plan = await f.p.harness.commit(tx => f.p.scheduler.create(tx, { requestId: "scheduled-app-data", label: "业务数据", instruction: "创建业务表并汇总", rule: { kind: "once", at: new Date(Date.now() - 1000).toISOString(), timeZone: "Asia/Tokyo" } }, { kind: "local", requestId: "scheduled-app-data" }), context);
  const run = await until(async () => { const runs = (await f.p.harness.snapshot(PersonalSchedulesDoc, context))?.runs ?? []; for (const id of runs) { const run = (await f.p.harness.snapshot(PersonalScheduleRunDoc, id, context))?.run; if (run?.planId === plan.id && run.result) return run; } return undefined; });
  assert.equal(run.result?.status, "completed"); assert.ok(initial && summary && child); assert.equal((await f.operations())[0].origin.conversationId, run.conversationId);
  const entries = (await (await f.p.harness.conversation(run.conversationId, context))!.entries({ order: "ascending" }, 256, undefined, context)).items;
  const results = entries.filter(entry => entry.kind === "pi.tool-result"); assert.ok(!JSON.stringify(results).includes("app_data_forbidden"));
  await f.p.close(); await f.open(); assert.equal((await f.operations()).length, 1);
});

test("应用数据：共享回执同键同参及完整请求指纹冲突", () => {
  const store = new AppDataStore(":memory:"), ctx = { taskId: "durable:1", sessionId: "durable:0", agentId: "main", requestFingerprint: "fingerprint-one" }, input = { ...define, opId: "durable:1", ctx };
  try { const first = store.defineTable(input); assert.equal(first.applied, true); assert.equal(store.defineTable(input).applied, false); assert.throws(() => store.defineTable({ ...input, reason: "异参", ctx: { ...ctx, requestFingerprint: "different" } }), error => error instanceof Error && "code" in error && error.code === "op_conflict"); } finally { store.close(); }
});

test("应用数据：真实Telegram宿主菜单失效批准仍可恢复，错回复不消费", async t => {
  const bot = http.createServer(async (req, res) => { for await (const _chunk of req) { /* 传输替身只需完成读取。 */ } res.end(JSON.stringify({ ok: true, result: { message_id: ++sent, chat: { id: 456, type: "private" } } })); });
  let sent = 1000; bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address !== "string");
  const previous = process.env.APP_DATA_BOT_KEY; process.env.APP_DATA_BOT_KEY = "123:test-only";
  t.after(async () => { bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); if (previous === undefined) delete process.env.APP_DATA_BOT_KEY; else process.env.APP_DATA_BOT_KEY = previous; });
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "APP_DATA_BOT_KEY", tokenDigest: createHash("sha256").update("123:test-only").digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const f = await fixture(t, (_request, i) => [call("app_data_define_table", define), call("app_data_insert", insert), call("app_data_delete", { table: "todos", rows: [{ id: 1, expected_version: 1 }, { id: 2, expected_version: 1 }], reason: "批量删除" })][i] ?? { kind: "text", text: "本次已停止" }, { telegram });
  let message = 0;
  const receive = async (text: string, replyTo?: number, control = true) => {
    const id = ++message; await f.p.telegram.receive({ update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }) } });
    const key = `telegram:123:456:${id}`, value = (await f.p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
    if (control) await f.p.harness.waitForTask(value.taskId, context);
    return (await f.p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
  };
  await receive("批量完成", undefined, false); const op = await until(async () => (await f.operations()).find(value => value.name === "app_data_delete"));
  await f.p.harness.commit(async tx => {
    assert.equal((await appDataList(tx)).items.find(item => item.operation === op.operation)?.canDecide, false);
    assert.equal((await appDataList(tx, 0, telegram)).items.find(item => item.operation === op.operation)?.canDecide, true);
  }, context);
  const menu = await receive("/应用数据"), detail = await receive("数据1", Number(menu.platformMessageId));
  const wrong = await receive("数据批准本次", 9999); assert.equal(wrong.appDataDecision, undefined); assert.equal((await f.operations())[2].started, undefined);
  const store = new AppDataStore(f.file); try { store.insert({ table: "todos", records: [{ title: "并发" }], reason: "变化", opId: "concurrent", ctx: { taskId: "test", sessionId: "test", agentId: "test" } }); } finally { store.close(); }
  const decided = await receive("数据批准本次", Number(detail.platformMessageId));
  assert.equal(decided.appDataDecision?.operation, op.operation); await f.p.harness.waitForIdle(context);
  assert.equal((await f.operations())[2].result?.effect, "not_committed"); assert.equal((await f.operations())[2].started, undefined);
  assert.equal(sql(f.file, "SELECT * FROM todos").length, 3);
  await f.p.close(); await f.open(); assert.equal((await f.operations())[2].result?.code, "app_data_version_changed");
});

test("应用数据：初始化意图落盘后强杀，可按固定身份继续首次建库", async t => {
  const f = await fixture(t, () => ({ kind: "text", text: "就绪" })), directory = fs.mkdtempSync(path.join(tmpdir(), "rk-app-init-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await crashInsert(f, directory, "initialize");
  assert.equal(fs.existsSync(path.join(directory, "agent-data", "main.db")), false);
  const p = await openPersonalHarness({ ...f.options, directory });
  try { const binding = (await p.harness.snapshot(PersonalAppDataDoc, context))!; assert.equal(binding.initializing, undefined); const store = new AppDataStore(path.join(directory, "agent-data", "main.db"), { readOnly: true, expectedInstanceId: binding.instanceId }); try { assert.equal(store.getInstanceId(), binding.instanceId); assert.equal(store.getVersions().revision, 0); } finally { store.close(); } } finally { await p.close(); }
});

test("应用数据：查询完整预算大于默认工具预览，64KiB内结果不被二次截断", async t => {
  const records = ["甲", "乙", "丙"].map(prefix => ({ title: prefix + "x".repeat(8000) }));
  const f = await fixture(t, (_request, i) => [call("app_data_define_table", define), call("app_data_insert", { ...insert, records }), call("app_data_query", { mode: "rows", table: "todos" })][i] ?? { kind: "text", text: "完整读到三行" });
  await f.p.answer("保存后读完整结果", "query-budget");
  const message = f.server.calls.at(-1)!.messages.at(-1)!; assert.equal(message.role, "tool");
  const result = JSON.parse(String(message.content)) as { rows: { title: string }[]; complete: boolean };
  assert.equal(result.complete, true); assert.deepEqual(result.rows.map(row => row.title), records.map(row => row.title));
});

test("应用数据：start已提交但原工具未结束时人工重核拒绝，不提前释放暂停", async t => {
  const f = await fixture(t, (_request, i) => i === 0 ? call("app_data_define_table", define) : { kind: "text", text: "已提交" }); await f.p.close();
  let p: PersonalHarness, attempted: Promise<void> | undefined;
  p = await openPersonalHarness({ ...f.options, openStorage: async file => {
    const storage = await openNodeSqliteStorage(file), commit = storage.commit.bind(storage);
    storage.commit = async (writes, storageContext) => {
      const result = await commit(writes, storageContext);
      const start = writes.find(write => write.type === "entry" && write.value.kind === "ruukoto.app-data-start");
      if (start?.type === "entry") { const data = start.value.data as { operation: TaskId }; attempted = assert.rejects(p.harness.commit(tx => appDataRecheck(tx, f.directory, data.operation), context), error => error instanceof Error && "code" in error && error.code === "app_data_recheck_active"); }
      return result;
    };
    return storage;
  } });
  try { await p.answer("创建表", "active-recheck"); assert.ok(attempted); await attempted; assert.equal(sql(f.file, "SELECT * FROM app_audit").length, 1); } finally { await p.close(); }
});
