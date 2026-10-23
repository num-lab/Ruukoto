import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { answerPersonalQuestion, PersonalQuestionDoc, PersonalQuestionsDoc } from "../apps/ruukoto/src/personal-questions.ts";
import { personalSource } from "../apps/ruukoto/src/personal-source.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BackgroundExecution, type BackgroundExecutionObserver } from "@ruukoto/agent/execution/background.ts";
import { startMockOneBot, MOCK_QQ_ACCOUNT, MOCK_QQ_SECRET } from "./helpers/mock-onebot.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalDirectoryClaimsDoc, acquirePersonalDirectory, personalDirectoriesConflict } from "../apps/ruukoto/src/personal-directory-claims.ts";
import { PersonalBackgroundProcessDoc, PersonalBackgroundDoc } from "../apps/ruukoto/src/personal-background-processes.ts";
import { toolOperations, toolResolve } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { managePersonalBackground } from "../apps/ruukoto/src/personal-background-cli.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalMockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 20_000; while (!await check()) { assert.ok(Date.now() < deadline, "等待后台事实超时"); await delay(10); } }
async function fixture(t: TestContext, respond?: Responder, real = false, short = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(short ? "/tmp" : os.tmpdir(), "rk-personal-background-"))), directory = path.join(root, "profile"), workspace = path.join(root, "work"); fs.mkdirSync(workspace, { mode: 0o700 });
  const identity = fs.statSync(workspace), machineId = real ? fs.readFileSync("/etc/machine-id", "utf8").trim() : "a".repeat(32), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let observer: BackgroundExecutionObserver | undefined, failStop = false, launches = 0, stops = 0;
  if (!real) {
    Object.defineProperty(process, "platform", { value: "linux" });
    const read = nodeFs.readFileSync; t.mock.method(nodeFs, "readFileSync", (file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => file === "/etc/machine-id" ? machineId + "\n" : read(file, options)); syncBuiltinESMExports();
    t.mock.method(BackgroundExecution, "launch", async (_prepared: Parameters<typeof BackgroundExecution.launch>[0], _command: string, _operation: string, value: BackgroundExecutionObserver) => { launches++; observer = value; value.data("stdout", Buffer.from([0x61, 0xff, 0x62])); value.data("stderr", Buffer.from("stderr-value")); return { async stop() { stops++; return { exited: !failStop, outputComplete: true }; } }; });
  }
  const model: PersonalModelConfig = { api: "openai-completions", baseUrl: "", modelId: "mock-model", apiKeyEnv: "RUUKOTO_BACKGROUND_TEST_KEY", contextWindow: 128000, maxTokens: 1024 };
  const server = new PersonalMockModelServer(respond ?? ((request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: "printf hello; sleep 300" } }] } : { kind: "text", text: "已接纳" })); model.baseUrl = await server.start();
  const oldKey = process.env[model.apiKeyEnv]; process.env[model.apiKeyEnv] = "test-only";
  const config = { version: 1 as const, workspace, identity: { dev: identity.dev, ino: identity.ino }, machineId, tmpdir: fs.realpathSync(os.tmpdir()) };
  let personal: PersonalHarness | undefined;
  t.after(async () => { await personal?.close(); await server.close(); t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", platform); if (oldKey === undefined) delete process.env[model.apiKeyEnv]; else process.env[model.apiKeyEnv] = oldKey; fs.rmSync(root, { recursive: true, force: true }); });
  return { directory, workspace, server, config, model, launches: () => launches, stops: () => stops, output: (bytes: Buffer) => observer!.data("stdout", bytes), failStop: (value: boolean) => { failStop = value; },
    async open(overrides: Pick<Parameters<typeof openPersonalHarness>[0], "openStorage" | "telegram" | "qq"> = {}) { personal = await openPersonalHarness({ ...overrides, directory, commands: config, provider: personalProvider(model), modelId: model.modelId, tools: { version: 1, generation: "test", workspace, identity: config.identity, credentials: [] } }); return personal; },
  };
}
async function active(p: PersonalHarness) { const index = await p.harness.snapshot(PersonalBackgroundDoc, context); assert.equal(index!.ids.length, 1); return (await p.harness.snapshot(PersonalBackgroundProcessDoc, index!.ids[0], context))!.process!; }
async function allow(p: PersonalHarness) { await p.harness.commit(async tx => { (await tx.doc(PersonalPermissionsDoc)).mode = "full_access"; }, context); }

test("个人后台：跨轮保留独立Task和目录，原字节日志可读；同轮业务工具被挡，停止核实后写入恢复", async t => {
  let workspace = "";
  const f = await fixture(t, (request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: "sleep 300" } }, { id: "write", name: "write_file", arguments: { path: path.join(workspace, "blocked.txt"), content: "bad" } }] } : request.messages.at(-1)?.role === "user" && request.messages.at(-1)?.content === "恢复写入" ? { kind: "tool_calls", calls: [{ id: "resume-write", name: "write_file", arguments: { path: path.join(workspace, "resume.txt"), content: "after-stop" } }] } : { kind: "text", text: "已接纳" }); workspace = f.workspace; fs.writeFileSync(path.join(workspace, "resume.txt"), "before-stop");
  const p = await f.open(); await allow(p); await p.answer("启动服务", "start-source");
  let process = await active(p);
  assert.equal(process.state, "running"); assert.equal(process.stopped, false); assert.equal(f.launches(), 1); assert.equal(fs.existsSync(path.join(workspace, "blocked.txt")), false);
  assert.equal((await p.harness.getTask(process.taskId, context))!.background, true); assert.equal((await p.harness.getTask(process.taskId, context))!.owner, undefined);
  assert.match(JSON.stringify(f.server.calls.at(-1)?.messages), /后台仍持有目录/);
  const names = f.server.calls.at(-1)!.tools!.map(tool => (tool.function as { name: string }).name).sort(); assert.deepEqual(names, ["ask_user", "process_output", "process_status", "process_stop"]);
  assert.deepEqual(Buffer.from((await p.background!.output(process.id, "stdout")).base64, "base64"), Buffer.from([0x61, 0xff, 0x62]));
  assert.equal((await p.harness.snapshot(PersonalDirectoryClaimsDoc, context))!.claims.filter(value => !value.released).length, 1);
  await p.answer("后续普通聊天", "later-owner"); assert.equal(f.launches(), 1); assert.equal((await active(p)).state, "running");
  await p.background!.stop(process.id); await until(async () => (await active(p)).stopped);
  process = await active(p); assert.equal(process.state, "stopped"); assert.equal((await p.harness.snapshot(PersonalDirectoryClaimsDoc, context))!.claims.filter(value => !value.released).length, 0);
  await p.answer("恢复写入", "after-stop-owner"); assert.equal(fs.readFileSync(path.join(workspace, "resume.txt"), "utf8"), "after-stop");
});

test("个人后台：交接后取消创建轮不停止独立后台，后续显式停止才释放", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: "sleep 300" } }] } : { kind: "text", text: "等待取消的长回答".repeat(100), chunkDelayMs: 100 });
  const p = await f.open(); await allow(p); const submission = await p.submit("启动", "cancel-owner");
  await until(async () => f.server.calls.length >= 2); const background = await active(p); assert.equal(background.state, "running");
  await p.main.abort(context); assert.equal((await submission.wait(context)).status, "unanswered"); await delay(700);
  assert.equal((await active(p)).state, "running"); assert.equal(f.stops(), 0); assert.equal((await p.harness.snapshot(PersonalDirectoryClaimsDoc, context))!.claims.filter(value => !value.released).length, 1);
  await p.background!.stop(background.id); await until(async () => (await active(p)).stopped);
});

test("个人后台：完全访问启动和持续监督不扫描保护树，目录身份变化仍停止", async t => {
  const f = await fixture(t), p = await f.open(); await allow(p);
  const readdir = nodeFs.readdirSync, readFile = nodeFs.readFileSync;
  let scans = 0, checks = 0;
  t.mock.method(nodeFs, "readdirSync", (...args: Parameters<typeof nodeFs.readdirSync>) => {
    if (String(args[0]) === f.directory) scans++;
    return Reflect.apply(readdir, nodeFs, args);
  });
  t.mock.method(nodeFs, "readFileSync", (target: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    if (target === "/etc/machine-id") checks++;
    return readFile(target, options);
  }); syncBuiltinESMExports();
  await p.answer("启动后台", "full-access-owner"); assert.equal((await active(p)).state, "running");
  const startedChecks = checks; await until(async () => checks >= startedChecks + 2);
  assert.equal(scans, 0); assert.equal(f.stops(), 0);
  fs.renameSync(f.workspace, f.workspace + "-original"); fs.mkdirSync(f.workspace);
  await until(async () => (await active(p)).stopped);
  assert.equal((await active(p)).reason, "command_config_changed"); assert.ok(f.stops() > 0);
});

test("个人后台：SDK规范化原始数字参数后接纳，恢复仍按实际工具定义核实且不重放", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: 123 } }] } : { kind: "text", text: "已接纳" });
  const p = await f.open(); await allow(p); await p.answer("启动", "numeric-owner"); assert.equal((await active(p)).command, "123");
  await p.close(); const reopened = await f.open(); assert.equal((await active(reopened)).state, "stopped"); assert.equal(f.launches(), 1);
});

test("个人后台本机：认证socket与逐步CLI可查双流及结束，未决稳定键只查原回执", async t => {
  const f = await fixture(t, undefined, false, true), p = await f.open(); await allow(p); await p.answer("启动", "cli-owner"); const background = await active(p); await p.close();
  const values = { "model.json": f.model, "command.json": f.config, "tools.json": { version: 1, generation: "test", workspace: f.workspace, identity: f.config.identity, credentials: [] } };
  for (const [name, value] of Object.entries(values)) fs.writeFileSync(path.join(f.directory, name), JSON.stringify(value) + "\n", { mode: 0o600 });
  const server = await startPersonalServer(f.directory); t.after(() => server.stop());
  const restored = (await personalControl<{ processes: Array<{ state: string; process_id: string }> }>(f.directory, "GET", "/background")).processes[0]; assert.equal(restored.state, "stopped"); assert.equal(restored.process_id, background.id);
  const answers = ["1", "2", "3", "5", "2", "2", "3"], transcript: string[] = [];
  await managePersonalBackground({ write: text => transcript.push(text), async question() { assert.ok(answers.length); return answers.shift()!; } }, f.directory);
  assert.equal(answers.length, 0); assert.match(transcript.join(""), /原字节base64：Yf9i/); assert.match(transcript.join(""), /stderr-value/); assert.match(transcript.join(""), /本次涉及的会话后台停止已核实/); assert.equal(fs.existsSync(path.join(f.directory, "pending-background-end.json")), false);
  const requestId = randomUUID(); await personalControl(f.directory, "POST", `/background/end?request=${requestId}`);
  fs.writeFileSync(path.join(f.directory, "pending-background-end.json"), JSON.stringify({ requestId }) + "\n", { mode: 0o600 });
  const retry = ["2", "3"], receipts: string[] = [];
  await managePersonalBackground({ write: text => receipts.push(text), async question() { assert.ok(retry.length); return retry.shift()!; } }, f.directory);
  assert.equal(retry.length, 0); assert.doesNotMatch(receipts.join(""), /停止并核实本次结束请求涉及的后台/); assert.equal(fs.existsSync(path.join(f.directory, "pending-background-end.json")), false);
  const receipt = await personalControl<{ accepted: boolean; processes: Array<{ process_id: string }> }>(f.directory, "GET", `/background/end?request=${requestId}`); assert.equal(receipt.accepted, true); assert.deepEqual(receipt.processes, []);
  await server.stop();
});

test("个人后台结束屏障：Telegram结束不拦住此前接纳的本机输入", async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (_request, index) => { if (index === 0) { await held; return { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: "sleep 300" } }] }; } return { kind: "text", text: "已接纳" }; });
  const p = await f.open(); await allow(p); const answer = p.answer("启动", "local-before-telegram-end"); await until(async () => f.server.calls.length === 1);
  await p.harness.commit(tx => p.background!.closeIn(tx, randomUUID(), { botId: "123", ownerId: "456", generation: "telegram-entry" }), context); release(); await answer;
  assert.equal(f.launches(), 1); assert.equal((await active(p)).state, "running");
});

test("个人后台：停止未核实保留claim，后续write和普通命令认领均拒绝，可信重核才释放", async t => {
  const f = await fixture(t), p = await f.open(); await allow(p); await p.answer("启动", "owner"); const process = await active(p); f.failStop(true);
  await p.background!.stop(process.id); await until(async () => (await active(p)).state === "stop_unverified");
  await assert.rejects(p.harness.commit(tx => acquirePersonalDirectory(tx, { kind: "command", operation: process.taskId }, { path: f.workspace, ...f.config.identity }), context), code("directory_claim_busy"));
  await assert.rejects(p.harness.commit(tx => acquirePersonalDirectory(tx, { kind: "file", operation: process.taskId }, { path: path.join(f.workspace, "file.txt"), ...f.config.identity }), context), code("directory_claim_busy"));
  f.failStop(false); await p.background!.stop(process.id); await until(async () => (await active(p)).stopped); assert.equal(f.launches(), 1); assert.ok(f.stops() >= 2);
});

test("个人后台：预算停止保留16MiB原字节和partial，篡改日志明确拒绝", async t => {
  const f = await fixture(t), p = await f.open(); await allow(p); await p.answer("启动", "owner"); const process = await active(p);
  const chunk = Buffer.alloc(1024, 0x65), before = (await active(p)).observations!.length;
  for (let index = 0; index < 20_000; index++) f.output(chunk);
  await until(async () => (await active(p)).stopped);
  const saved = await active(p); assert.equal(saved.partial, true); assert.ok(saved.observations!.length - before < 10, "同步洪流只合并为有界落盘批次"); assert.equal(saved.stopIntents!.length, 1); assert.equal(saved.logs!.stdout.bytes + saved.logs!.stderr.bytes, 16 * 1024 * 1024);
  const page = await p.background!.output(process.id, "stdout"); assert.equal(Buffer.from(page.base64, "base64").length, 32 * 1024); assert.equal(page.nextOffset, 32 * 1024);
  fs.writeFileSync(path.join(f.directory, "background", "logs", process.id, "stdout"), "tampered");
  await assert.rejects(p.background!.output(process.id, "stdout"), code("background_evidence_invalid"));
});

for (const corruption of ["missing", "pointer"] as const) test(`个人后台：结束原键固定目标；恢复拒绝${corruption}认领断链且零新增派发`, async t => {
  const f = await fixture(t), p = await f.open(); await allow(p); await p.answer("启动", "owner"); const process = await active(p), key = randomUUID();
  const closure = await p.background!.end(key); await until(async () => (await active(p)).stopped);
  assert.deepEqual(await p.background!.end(key), closure); assert.equal((await p.background!.endStatus(key)).stopVerified, true);
  await p.harness.commit(async tx => { if (corruption === "missing") (await tx.doc(PersonalDirectoryClaimsDoc)).claims.length = 0; else (await tx.doc(PersonalBackgroundProcessDoc, process.id, null)).process!.claim = process.admission; }, context); await p.close();
  const calls = f.server.calls.length; await assert.rejects(f.open(), code("directory_claim_invalid")); assert.equal(f.server.calls.length, calls); assert.equal(f.launches(), 1);
  assert.ok(process.admission < closure.entry);
});

test("个人后台：日志事实提交失败关闭Harness并停止原unit，后续查询明确失败且不重放", async t => {
  const f = await fixture(t); let fail = false;
  const p = await f.open({ openStorage: async filename => {
    const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage);
    storage.commit = (writes, context) => fail && writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.background-observation") ? Promise.reject(new Error("injected-background-storage-failure")) : commit(writes, context);
    return storage;
  } });
  await allow(p); await p.answer("启动", "owner"); const process = await active(p); fail = true; f.output(Buffer.from("uncommitted-output"));
  assert.equal((await p.harness.closed).reason, "failed"); await until(async () => f.stops() > 0);
  await assert.rejects(p.background!.output(process.id, "stdout"), code("background_persistence_failed")); assert.equal(f.launches(), 1);
});

test("个人文件claim：同步写入效果未知保留认领，人工核实同commit释放并可恢复", async t => {
  let target = "";
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "write", name: "write_file", arguments: { path: target, content: "new-content" } }] } : { kind: "text", text: "已接纳" });
  target = path.join(f.workspace, "unknown.txt"); fs.writeFileSync(target, "old-content"); const identity = fs.statSync(target), originalWrite = nodeFs.writeSync;
  const mockedWrite = t.mock.method(nodeFs, "writeSync", (fd: number, buffer: string | Buffer, ...args: unknown[]) => { const stat = nodeFs.fstatSync(fd); if (stat.dev === identity.dev && stat.ino === identity.ino) throw Object.assign(new Error("injected-file-write-failure"), { code: "EIO" }); return Reflect.apply(originalWrite, nodeFs, [fd, buffer, ...args]); }); syncBuiltinESMExports();
  const p = await f.open(); await allow(p); await p.answer("写文件", "file-owner");
  const operation = await p.harness.commit(async tx => (await toolOperations(tx)).map(value => ({ id: value.operation, effect: value.effect, stopped: value.stopped }))[0], context); assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, true);
  assert.equal((await p.harness.snapshot(PersonalDirectoryClaimsDoc, context))!.claims.filter(value => !value.released).length, 1);
  mockedWrite.mock.restore(); syncBuiltinESMExports(); await p.harness.commit(tx => toolResolve(tx, operation.id, "not_applied", "独立核实文件写入失败"), context);
  assert.equal((await p.harness.snapshot(PersonalDirectoryClaimsDoc, context))!.claims.filter(value => !value.released).length, 0); await p.close(); await f.open();
});

for (const platform of ["telegram", "qq"] as const) test(`个人后台原菜单：${platform} 查询/双流/停止；拒绝未引用和跨平台，重投不重复，重开双向核实`, async t => {
  let release!: () => void, held: Promise<void> | undefined = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (_request, index) => { if (held) { const original = held; held = undefined; await original; return { kind: "tool_calls", calls: [{ id: `start-${index}`, name: "process_start", arguments: { command: "sleep 300" } }] }; } return { kind: "text", text: "已接纳" }; }), bot = await startMockOneBot({}), sends: string[] = [];
  const server = http.createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as { text: string; chat_id: string }; sends.push(body.text); response.end(JSON.stringify({ ok: true, result: { message_id: 1000 + sends.length, chat: { id: Number(body.chat_id), type: "private" } } })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const token = `${MOCK_QQ_ACCOUNT}:test-token`, env = { BACKGROUND_TEST_BOT: token, BACKGROUND_TEST_QQ: MOCK_QQ_SECRET }, prior = Object.keys(env).map(key => [key, process.env[key]] as const); Object.assign(process.env, env);
  const telegram = { version: 1 as const, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv: "BACKGROUND_TEST_BOT", tokenDigest: createHash("sha256").update(token).digest("hex"), botId: MOCK_QQ_ACCOUNT, ownerId: "456", boundary: 0 };
  const qq = { version: 1 as const, enabled: true, generation: randomUUID(), endpoint: bot.url, tokenEnv: "BACKGROUND_TEST_QQ", tokenDigest: createHash("sha256").update(MOCK_QQ_SECRET).digest("hex"), botId: MOCK_QQ_ACCOUNT, ownerId: "456", boundary: 0, boundaryMessageId: "0" };
  let p!: PersonalHarness, controller: AbortController, poll: Promise<void>, sequence = 0;
  async function open() { p = await f.open({ telegram, qq }); controller = new AbortController(); poll = p.qq.poll(controller.signal); await until(async () => (await p.qq.status()).online); await p.harness.commit(async tx => { const permission = await tx.doc(PersonalPermissionsDoc); permission.mode = "full_access"; permission.qq = { mode: "full_access", version: 1 }; }, context); }
  async function close() { controller?.abort(); await poll; await p?.close(); }
  t.after(async () => { await close(); await bot.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  async function receive(text: string, replyTo?: number, source: "telegram" | "qq" = platform) {
    const id = ++sequence, update = { update_id: id, message: { message_id: id, chat: { id: 456, type: "private" }, from: { id: 456, is_bot: false }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: Number(MOCK_QQ_ACCOUNT), is_bot: true } } }) } };
    const event = { post_type: "message", message_type: "private", sub_type: "friend", self_id: Number(MOCK_QQ_ACCOUNT), user_id: 456, message_id: id, time: 20, message: [...(replyTo === undefined ? [] : [{ type: "reply", data: { id: String(replyTo) } }]), { type: "text", data: { text } }] };
    const replay = () => source === "telegram" ? p.telegram.receive(update) : p.qq.receive(event); await replay(); const key = `${source}:${MOCK_QQ_ACCOUNT}:456:${id}`, receipt = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!; await p.harness.waitForTask(receipt.taskId, context);
    return { value: (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!, replay };
  }
  await open(); const initial = receive("启动后台"); await until(async () => f.server.calls.length === 1);
  const other = platform === "telegram" ? { platform: "qq" as const, ...qq } : telegram;
  await p.harness.commit(tx => p.background!.closeIn(tx, randomUUID(), other), context); release(); await initial;
  const backgroundProcess = await active(p), calls = f.server.calls.length;
  const list = await receive("/后台"), detail = await receive("后台1", Number(list.value.platformMessageId)); assert.match(detail.value.reply!, /running/);
  assert.match((await receive("后台输出", Number(detail.value.platformMessageId))).value.reply!, /a.*b/s);
  assert.equal((await receive("停止此后台")).value.backgroundAction, undefined);
  assert.equal((await receive("停止此后台", Number(detail.value.platformMessageId), platform === "telegram" ? "qq" : "telegram")).value.backgroundAction, undefined);
  const stopped = await receive("停止此后台", Number(detail.value.platformMessageId)); assert.ok(stopped.value.backgroundAction && "id" in stopped.value.backgroundAction); await until(async () => (await active(p)).stopped);
  const sent = sends.length; await stopped.replay(); assert.equal(sends.length, sent); assert.equal(f.server.calls.length, calls); assert.equal(f.launches(), 1);
  held = new Promise<void>(resolve => { release = resolve; }); const old = receive("再次启动后台"); await until(async () => f.server.calls.length === calls + 1);
  const same = platform === "qq" ? { platform: "qq" as const, ...qq } : telegram;
  await p.harness.commit(tx => p.background!.closeIn(tx, randomUUID(), same), context); release(); await old;
  assert.equal(f.launches(), 1); assert.equal((await p.harness.snapshot(PersonalBackgroundDoc, context))!.ids.length, 1);
  await close(); await open(); assert.equal((await active(p)).id, backgroundProcess.id); assert.equal((await active(p)).stopped, true); await close();
});

test("个人问题与后台：持有目录时提问收窄当前轮，答案新轮仍只有后台观测工具", async t => {
  const f = await fixture(t, request => {
    const last = request.messages.at(-1);
    if (last?.role !== "user") return { kind: "text", text: "已登记" };
    if (last.content === "start") return { kind: "tool_calls", calls: [{ id: "start", name: "process_start", arguments: { command: "sleep 300" } }] };
    if (last.content === "ask") return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: "下一步？" }] } }] };
    return { kind: "text", text: "后台仍在，先等待停止" };
  });
  const p = await f.open(); await allow(p); await p.answer("start", "start-owner"); await p.answer("ask", "ask-owner");
  const names = (request: typeof f.server.calls[number]) => request.tools!.map(tool => (tool.function as { name: string }).name).sort();
  assert.deepEqual(names(f.server.calls.at(-1)!), ["process_output", "process_status"]);
  const id = (await p.harness.snapshot(PersonalQuestionsDoc, context))!.ids[0], question = (await p.harness.snapshot(PersonalQuestionDoc, id, context))!.question!;
  const receipt = await p.harness.commit(tx => answerPersonalQuestion(tx, { question: id, version: question.version, requestId: randomUUID(), answers: [{ text: "仍要先停" }] }, { kind: "local" }), context); p.harness.resume(); await p.harness.waitForTask(receipt.taskId!, context);
  assert.deepEqual(names(f.server.calls.at(-1)!), ["ask_user", "process_output", "process_status", "process_stop"]);
  assert.equal((await active(p)).state, "running"); assert.equal(f.launches(), 1);
  await p.background!.stop((await active(p)).id); await until(async () => (await active(p)).stopped);
});

test("个人问题与后台：答复接纳后关闭，排队续接不能借稍后main entry穿过关闭屏障", async t => {
  let release!: () => void, holding = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async request => {
    const last = request.messages.at(-1), text = String(last?.content);
    if (last?.role === "user" && text === "ask") return { kind: "tool_calls", calls: [{ id: "ask", name: "ask_user", arguments: { questions: [{ question: "继续启动？" }] } }] };
    if (last?.role === "user" && text === "hold") { holding = true; await gate; return { kind: "text", text: "释放主轮" }; }
    if (last?.role === "user" && text.includes("拥有者对原问题的回答")) return { kind: "tool_calls", calls: [{ id: "late-start", name: "process_start", arguments: { command: "sleep 300" } }] };
    return { kind: "text", text: "已记录" };
  });
  t.after(release);
  const p = await f.open(); await allow(p); await p.answer("ask", "question-origin");
  const id = (await p.harness.snapshot(PersonalQuestionsDoc, context))!.ids[0], question = (await p.harness.snapshot(PersonalQuestionDoc, id, context))!.question!;
  const hold = p.answer("hold", "held-owner"); await until(async () => holding);
  const receipt = await p.harness.commit(tx => answerPersonalQuestion(tx, { question: id, version: question.version, requestId: randomUUID(), answers: [{ text: "继续" }] }, { kind: "local" }), context); p.harness.resume();
  const requestId = `personal-question:${receipt.taskId}`;
  await until(async () => !!await p.harness.commit(async tx => { const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId); return submission?.status === "queued" && !submission.entry; }, context));
  const closure = await p.background!.end(randomUUID()); assert.ok(receipt.entry <= closure.through!);
  release(); await hold; await p.harness.waitForTask(receipt.taskId!, context);
  const source = await p.harness.commit(tx => personalSource(tx, requestId), context);
  assert.ok(!source.scheduled); assert.ok(source.entry.id > closure.entry); assert.equal(source.accepted, receipt.entry);
  assert.equal(f.launches(), 0); assert.equal((await p.harness.snapshot(PersonalBackgroundDoc, context))!.ids.length, 0);
  assert.equal((await p.harness.snapshot(PersonalDirectoryClaimsDoc, context))!.claims.filter(value => !value.released).length, 0);
  assert.match(JSON.stringify(f.server.calls), /原拥有者输入不具启动资格或已结束后台/);
  await p.close(); await f.open(); assert.equal(f.launches(), 0);
});

test("个人目录认领：父子路径与dev/ino别名冲突，相邻前缀不冲突", () => {
  const base = { path: "/tmp/work", dev: 1, ino: 1 };
  assert.equal(personalDirectoriesConflict(base, { path: "/tmp/work/sub", dev: 1, ino: 2 }), true);
  assert.equal(personalDirectoriesConflict(base, { path: "/other/alias", dev: 1, ino: 1 }), true);
  assert.equal(personalDirectoriesConflict(base, { path: "/tmp/worker", dev: 1, ino: 2 }), false);
  assert.equal(personalDirectoriesConflict(base, { path: "/", dev: 2, ino: 1 }), true);
});

test("个人后台真实Linux：原scope启动跨轮保留，停止并核实后唯一认领释放，重开不重放", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, undefined, true), p = await f.open(); await allow(p); await p.answer("启动真实本机后台", "real-owner");
  const process = await active(p); assert.equal(process.state, "running", JSON.stringify(process)); await until(async () => (await active(p)).logs!.stdout.bytes > 0);
  assert.match((await p.background!.output(process.id, "stdout")).text, /hello/);
  await p.answer("第二拥有者轮查询", "next-owner"); assert.equal((await active(p)).state, "running");
  await p.background!.stop(process.id); await until(async () => (await active(p)).stopped); await p.close();
  const restored = await f.open(); assert.equal((await active(restored)).state, "stopped"); assert.equal((await restored.harness.snapshot(PersonalDirectoryClaimsDoc, context))!.claims.filter(value => !value.released).length, 0);
});
