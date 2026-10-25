import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { personalToolControl, verifyToolControls } from "../apps/ruukoto/src/personal-tools-controls.ts";
import { configurePersonalTools, configurePersonalWebSearch, managePersonalTools } from "../apps/ruukoto/src/personal-tools-cli.ts";
import { PersonalToolDoc, PersonalToolsDoc, toolUnresolved, toolList, toolDetail, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalTelegramDoc, PersonalTelegramReceiptDoc, type TelegramControlInput, type TelegramResult } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";

const context = BACKGROUND_CONTEXT;
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
function directory(t: TestContext): string { const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-tool-ui-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const receiptTask = defineTask<{ requestId: string }, { phase: "done" }, TelegramResult>({ name: "ruukoto.telegram-input", version: 1, initial: () => ({ phase: "done" }), phases: { async done(_current, runtime, context) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { delivery: "sent" } } }), context); } }, async abort(_current, runtime, context) { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: { delivery: "canceled" } } }), context); } });
const operationTask = defineTask({ ...receiptTask.definition, name: "test.tool-operation" });

async function fixture(t: TestContext) {
  const root = directory(t), registry = createRegistry(); registry.install(defineExtension({ name: "test-controls", tasks: [receiptTask, operationTask] }));
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "UNUSED_TOOL_UI_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => { assert.fail("宿主控制不能调用模型"); });
  const storage = await openNodeSqliteStorage(path.join(root, "test.sqlite")), harness = await Harness.open(storage, { models, registry }, context);
  t.after(async () => { await harness.close(context); await storage.close(context); });
  const main = await harness.root(context), source = await main.submit({ type: "write", requestId: "source", entry: { kind: "test.source" } }, context), original = await source.status(context);
  const binding = { generation: randomUUID(), botId: "123", ownerId: "456" };
  const operation = await harness.commit(async tx => {
    const operation = await tx.createTask(operationTask, { requestId: "operation-fixture" }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" } });
    const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.operation" });
    const telegram = { ...binding, mode: "confirm" as const, version: 1 };
    const op: PersonalToolOperation = { operation, admission: entry.id, origin: { conversationId: ROOT_CONVERSATION_ID, generation: operation, inputs: [source.id], sources: [source.id], source: { requestId: "source", submissionId: source.id, entryId: original.entry! }, permission: { mode: "confirm", version: 1 }, telegram }, kind: "http_request", params: { method: "POST", url: "https://example.com/action" }, config: { version: 1, generation: randomUUID(), workspace: root, identity: { dev: fs.statSync(root).dev, ino: fs.statSync(root).ino }, credentials: [] }, grantVersion: 1, prepared: { kind: "http", request: { method: "POST", url: "https://example.com/action", headers: {}, pinnedAddress: "1.1.1.1", pinnedFamily: 4 } }, approval: "approved", started: true, stopped: false, effect: "effect_unknown", code: "timeout" };
    (await tx.doc(PersonalToolDoc, String(operation), null)).operation = op;
    (await tx.doc(PersonalToolsDoc)).operations.push(operation);
    (await tx.doc(PersonalTelegramDoc)).config = { version: 1, enabled: true, ...binding, apiBase: "https://api.telegram.org", tokenEnv: "TEST_TOOL_BOT_TOKEN", tokenDigest: "a".repeat(64), boundary: 0 };
    return operation;
  }, context);
  const keys: string[] = []; let next = 0;
  async function receive(content: string, replyTo?: number, changes: Partial<TelegramControlInput> = {}) {
    const id = ++next, requestId = `telegram:123:456:${id}`, value: TelegramControlInput = { ...binding, requestId, messageId: id, updateId: id, content, direct: true, control: true, delivery: "sent", platformMessageId: String(1000 + id), ...(replyTo === undefined ? {} : { replyTo, replyBotId: binding.botId }), ...changes };
    await harness.commit(async tx => { assert.equal(await personalToolControl(tx, value, root), true); const taskId = await tx.createTask(receiptTask, { requestId }, { conversationId: ROOT_CONVERSATION_ID, ownership: { kind: "conversation" } }); (await tx.doc(PersonalTelegramReceiptDoc, requestId, null)).receipt = { ...value, taskId }; }, context);
    keys.push(requestId); return { value, key: requestId, sent: 1000 + id };
  }
  return { root, harness, operation, binding, keys, receive };
}

test("工具宿主控制：未装配与非直接入口只给指引，不登记选择", async t => {
  const f = await fixture(t);
  const value: TelegramControlInput = { requestId: "absent", ...f.binding, messageId: 99, updateId: 99, content: "/工具", direct: true, control: true, delivery: "waiting" };
  await f.harness.commit(tx => personalToolControl(tx, value), context);
  assert.match(value.reply!, /尚未装配/); assert.equal(value.selection, undefined);
  const forwarded = await f.receive("/工具", undefined, { direct: false });
  assert.match(forwarded.value.reply!, /转发和引用摘录不能管理/); assert.equal(forwarded.value.selection, undefined);
});

test("工具审批能力：本机不代批IM，原IM菜单保留本次批准", async t => {
  const f = await fixture(t);
  await f.harness.commit(async tx => { const value = (await tx.doc(PersonalToolDoc, String(f.operation), null)).operation!; value.approval = "pending"; value.started = false; value.effect = "not_executed"; value.code = "admitted"; }, context);
  const menu = await f.receive("/工具"), detail = await f.receive("工具1", menu.sent);
  await f.harness.commit(async tx => {
    assert.equal((await toolList(tx)).items[0].canDecide, false);
    assert.equal((await toolDetail(tx, f.operation)).summary.canDecide, false);
    assert.equal((await toolList(tx, 0, menu.value)).items[0].canDecide, true);
  }, context);
  assert.match(detail.value.reply!, /工具批准本次、工具拒绝/);
});

test("工具宿主控制：原菜单分别核实效果与结束，错回复不保存且回链缺失拒绝恢复", async t => {
  const f = await fixture(t), list = await f.receive("/工具"), menu = await f.receive("工具1", list.sent);
  assert.equal(menu.value.selection?.kind, "tool"); assert.match(menu.value.reply!, /工具确认已生效/); assert.match(menu.value.reply!, /核实工具原请求结束/);
  for (const changes of [{}, { replyTo: 9999, replyBotId: "123" }, { replyTo: menu.sent, replyBotId: "789" }, { replyTo: menu.sent, replyBotId: "123", direct: false }, { replyTo: menu.sent, replyBotId: "123", generation: randomUUID() }, { replyTo: menu.sent, replyBotId: "123", platform: "qq" as const }]) {
    const rejected = await f.receive("工具确认已生效", undefined, changes);
    assert.equal(rejected.value.selection, undefined); assert.equal(rejected.value.toolResolution, undefined);
  }
  const effect = await f.receive("工具确认已生效", menu.sent);
  assert.equal(effect.value.selection?.kind, "tool-resolution");
  const wrong = await f.receive("工具核实说明 已核实", menu.sent); assert.equal(wrong.value.toolResolution, undefined);
  const resolved = await f.receive("工具核实说明 外部业务记录已核对", effect.sent);
  assert.equal(resolved.value.toolResolution?.operation, f.operation);
  let op = (await f.harness.snapshot(PersonalToolDoc, String(f.operation), context))!.operation!;
  assert.equal(op.resolution?.effect, "applied"); assert.equal(op.stopped, false); assert.equal(toolUnresolved(op), true);
  const stop = await f.receive("核实工具原请求结束", resolved.sent); assert.equal(stop.value.selection?.kind, "tool-stop");
  const stopped = await f.receive("工具结束说明 服务端请求已结束且无排队任务", stop.sent);
  assert.equal(stopped.value.toolStop?.operation, f.operation);
  op = (await f.harness.snapshot(PersonalToolDoc, String(f.operation), context))!.operation!;
  assert.equal(op.stopped, true); assert.equal(toolUnresolved(op), false);
  const duplicate = await f.receive("工具结束说明 覆盖旧证据", stop.sent); assert.equal(duplicate.value.toolStop, undefined);
  await f.harness.commit(tx => verifyToolControls(tx, f.keys, true), context);
  await f.harness.commit(async tx => { delete (await tx.doc(PersonalTelegramReceiptDoc, stopped.key, null)).receipt!.toolStop; }, context);
  await assert.rejects(f.harness.commit(tx => verifyToolControls(tx, f.keys, true), context), code("tool_control_invalid"));
});

test("工具宿主控制：长目标摘要有界，完整原记录沿原菜单翻页", async t => {
  const f = await fixture(t);
  await f.harness.commit(async tx => { const op = (await tx.doc(PersonalToolDoc, String(f.operation), null)).operation!; if (op.prepared.kind === "http") op.prepared.request.url = `https://example.com/${"🙂".repeat(2048)}/original`; }, context);
  const list = await f.receive("/工具"), menu = await f.receive("工具1", list.sent);
  assert.ok(Array.from(list.value.reply!).length < 2000); assert.ok(Array.from(menu.value.reply!).length < 4096);
  assert.equal(menu.value.selection?.kind, "tool"); assert.ok(menu.value.selection && "nextOffset" in menu.value.selection && menu.value.selection.nextOffset !== undefined);
  const next = await f.receive("下一页工具原记录", menu.sent); assert.equal(next.value.selection?.kind, "tool");
  await f.harness.commit(tx => verifyToolControls(tx, f.keys, true), context);
});

test("工具配置向导：资料与HTTP凭据保存不捆绑搜索，键由程序生成", async t => {
  const root = directory(t), workspace = directory(t), answers = [workspace, "1", "documents", "api.example.com", "1", "DOCUMENT_API_AUTH", "3", "2"]; let output = "";
  await configurePersonalTools({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: text => { output += text; } }, root);
  const value = JSON.parse(fs.readFileSync(path.join(root, "tools.json"), "utf8"));
  assert.equal(answers.length, 0); assert.equal(value.workspace, workspace); assert.match(value.generation, /^[0-9a-f-]{36}$/);
  assert.deepEqual(value.credentials, [{ name: "documents", host: "api.example.com", header: "authorization", env: "DOCUMENT_API_AUTH" }]); assert.equal(value.search, undefined);
  assert.doesNotMatch(output, new RegExp(value.generation)); assert.match(output, /完整头值/);
});

test("搜索配置向导：无需资料目录保存凭据引用，程序管理代次", async t => {
  const root = directory(t), answers = ["1", "TAVILY_API_KEY", "2"]; let output = "";
  await configurePersonalWebSearch({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: text => { output += text; } }, root);
  const value = JSON.parse(fs.readFileSync(path.join(root, "web-search.json"), "utf8"));
  assert.equal(answers.length, 0); assert.equal(value.enabled, true); assert.equal(value.apiKeyEnv, "TAVILY_API_KEY");
  assert.equal(fs.existsSync(path.join(root, "tools.json")), false); assert.doesNotMatch(output, new RegExp(value.generation));
});

test("工具管理向导：选择原操作翻页，分别提交批准、效果与结束，不要求填写身份", async t => {
  const root = directory(t); fs.writeFileSync(path.join(root, "control.token"), "a".repeat(64));
  const routes: string[] = [], bodies: unknown[] = []; let phase = 0;
  const item = { operation: 12, kind: "http_request", target: "https://example.com/action", approval: "pending", effect: "not_executed", stopped: false, code: "admitted", canDecide: true, canResolve: false, canVerifyStop: false };
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${"a".repeat(64)}`); routes.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method === "POST") { bodies.push(JSON.parse(Buffer.concat(chunks).toString())); phase++; res.end(JSON.stringify({ v: 1, ok: true, result: { saved: true } })); return; }
    let result;
    if (req.url?.startsWith("/tools/operation?")) result = { summary: { ...item, canDecide: phase === 0, canResolve: phase === 1, canVerifyStop: phase === 2 }, text: req.url.includes("offset=0") ? "原请求" : "原结果", ...(req.url.includes("offset=0") ? { nextOffset: 1200 } : {}) };
    else result = { items: phase === 3 ? [] : req.url?.endsWith("offset=0") ? Array(8).fill(item) : [item], ...(phase < 3 && req.url?.endsWith("offset=0") ? { nextOffset: 8 } : {}) };
    res.end(JSON.stringify({ v: 1, ok: true, result }));
  });
  server.listen(path.join(root, "control.sock")); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const answers = ["1", "9", "1", "2", "2", "3", "业务记录已核对", "3", "服务端请求已结束", "3", "1", "4"]; let output = "";
  await managePersonalTools({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: text => { output += text; } }, root);
  assert.equal(answers.length, 0); assert.equal(phase, 3);
  assert.deepEqual(bodies, [{ operation: 12, decision: "approved" }, { operation: 12, effect: "applied", evidence: "业务记录已核对" }, { operation: 12, evidence: "服务端请求已结束" }]);
  assert.ok(routes.includes("GET /tools/operations?offset=8")); assert.ok(routes.includes("GET /tools/operation?operation=12&offset=1200"));
  assert.match(output, /业务效果说明不证明原外部请求已结束/); assert.doesNotMatch(output, /taskId|UUID|请输入.*[Ii][Dd]/);
});

test("工具管理向导：选择资料授权和完整产物，撤销与导出只提交所选引用", async t => {
  const root = directory(t); fs.writeFileSync(path.join(root, "control.token"), "b".repeat(64));
  const bodies: Array<{ route: string; value: unknown }> = []; let revoked = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${"b".repeat(64)}`);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let result;
    if (req.method === "POST") { bodies.push({ route: req.url!, value: JSON.parse(Buffer.concat(chunks).toString()) }); if (req.url === "/tools/revoke") revoked = true; result = { saved: true }; }
    else if (req.url?.startsWith("/tools/grants")) result = { items: [{ id: "private-grant-reference", path: "/owner/shared", revoked }] };
    else result = { items: [{ artifact: "private-partial-reference", kind: "read_file", target: "片段资料", bytes: 3, partial: true }, { artifact: "private-complete-reference", kind: "read_file", target: "完整资料", bytes: 8, partial: false }] };
    res.end(JSON.stringify({ v: 1, ok: true, result }));
  });
  server.listen(path.join(root, "control.sock")); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const destination = path.join(root, "new-export.bin"), answers = ["2", "1", "/owner/new", "2", "2", "2", "3", "3", "1", "2", destination, "2", "3", "4"]; let output = "";
  await managePersonalTools({ question: async () => { assert.ok(answers.length); return answers.shift()!; }, write: text => { output += text; } }, root);
  assert.equal(answers.length, 0); assert.equal(revoked, true);
  assert.deepEqual(bodies, [{ route: "/tools/grant", value: { path: "/owner/new" } }, { route: "/tools/revoke", value: { id: "private-grant-reference" } }, { route: "/tools/export", value: { artifact: "private-complete-reference", destination } }]);
  assert.match(output, /仅捕获片段，不能完整导出/); assert.doesNotMatch(output, /private-(?:grant|partial|complete)-reference/);
});
