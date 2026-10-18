import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { BrowserManager, BrowserError, type BrowserBinding } from "@ruukoto/agent/browser-manager.ts";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalBrowser, savePersonalBrowser } from "../apps/ruukoto/src/personal-browser-config.ts";
import { browserOperations, browserResolve, PERSONAL_BROWSER, type PersonalBrowserOperation } from "../apps/ruukoto/src/personal-browser.ts";
import { PERSONAL_MEDIA } from "../apps/ruukoto/src/personal-media.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { LocalInputDoc } from "../apps/ruukoto/src/personal-local-records.ts";
import { parsePersonalTools, savePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, startPersonalServer, type PersonalInputStatus } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram-records.ts";
import type { PersonalTelegramConfig } from "../apps/ruukoto/src/personal-telegram-config.ts";
import type { TelegramUpdate } from "../apps/ruukoto/src/personal-telegram-api.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { MockModelServer, type RecordedRequest, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
const invoke = (name: string, args: Record<string, unknown>) => `tool:${JSON.stringify({ name, args })}`;
const browser = (action: string, args: Record<string, unknown> = {}) => invoke("browser", { action, ...args });
const toolNames = (request: RecordedRequest) => (request.tools ?? []).map(value => String((value.function as { name?: string } | undefined)?.name));
const code = (expected: string) => (error: unknown) => error instanceof PersonalError && error.code === expected;
const respond: Responder = request => {
  const last = request.messages.at(-1), text = typeof last?.content === "string" ? last.content : "";
  if (last?.role === "user" && text.startsWith("tool:")) {
    const { name, args } = JSON.parse(text.slice(5)) as { name: string; args: Record<string, unknown> };
    return { kind: "tool_calls", calls: [{ id: "integration-call", name, arguments: args }] };
  }
  return { kind: "text", text: last?.role === "tool" ? text : "完成" };
};
async function until(check: () => boolean | Promise<boolean>) { const deadline = Date.now() + 15000; while (!await check()) { assert.ok(Date.now() < deadline, "组合验证等待超时"); await delay(5); } }
function binding(): BrowserBinding { return { sessionId: String(ROOT_CONVERSATION_ID), generation: "integration-browser", kind: "owned", state: "ready", profileDir: null, socketDir: "", cliSession: "", cdpUrl: null, targetId: null, chrome: null, daemon: null, dashboard: null, chromePending: false, daemonPending: false, dashboardPending: false, lockDir: null, pauseTaskId: null, pauseAfterSeq: null, outcomeUnknown: false, failureCode: null, dashboardUrl: null, headed: false }; }

async function fixture(t: TestContext, options: { general?: boolean; browser?: boolean; imageInput?: boolean; responder?: Responder } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/rk-bi-")), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const model = new MockModelServer(options.responder ?? respond), config: PersonalModelConfig = { api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RK_BROWSER_INTEGRATION_MODEL_KEY", contextWindow: 128000, maxTokens: 8192, imageInput: options.imageInput ?? true }, previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const browserConfig = parsePersonalBrowser({ version: 1, generation: "integration-config", binaryPath: "/unused/agent-browser", chromePath: "/unused/chrome", headed: false }), identity = fs.statSync(workspace), tools = parsePersonalTools({ version: 1, generation: "integration-tools", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let current: PersonalHarness | undefined, backend: Awaited<ReturnType<typeof startPersonalServer>> | undefined, state = binding(), calls = 0, stopVerified = true, unknown = false;
  const previousMethods = { command: BrowserManager.prototype.command, status: BrowserManager.prototype.status, close: BrowserManager.prototype.close };
  BrowserManager.prototype.status = () => structuredClone(state);
  BrowserManager.prototype.close = async () => { if (stopVerified) state.state = "closed"; return stopVerified; };
  BrowserManager.prototype.command = async (_session, args) => { calls++; if (unknown) throw new BrowserError("outcome_unknown", "原网页应答丢失", true); if (args[0] === "screenshot") fs.writeFileSync(args[1], png); return { data: { refs: { e1: { role: "button", name: "确认" } } } }; };
  t.after(async () => { stopVerified = true; await backend?.stop(); await current?.close(); await model.close(); Object.assign(BrowserManager.prototype, previousMethods); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const open = async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => { current = await openPersonalHarness({ directory, provider: personalProvider(config), modelId: config.modelId, ...(options.browser === false ? {} : { browser: browserConfig }), ...(options.general ? { tools } : {}), ...overrides }); state = binding(); return current; };
  const mode = async (value: "confirm" | "full_access" | "auto-review") => { assert.ok(current); await current.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = value; doc.version++; }, context); };
  const operations = async () => { assert.ok(current); return current.harness.commit(async tx => JSON.parse(JSON.stringify(await browserOperations(tx))) as PersonalBrowserOperation[], context); };
  return { directory, root, workspace, config, browserConfig, tools, model, open, mode, operations, calls: () => calls, stop(value: boolean) { stopVerified = value; }, unknown(value: boolean) { unknown = value; },
    async server() { savePersonalConfig(directory, config); if (options.browser !== false) await savePersonalBrowser(directory, browserConfig); if (options.general) await savePersonalTools(directory, tools); backend = await startPersonalServer(directory); state = binding(); return backend; },
  };
}

test("个人组合：browser仅主会话原完全访问输入可见，默认变化不扩旧排队输入或子工作", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { responder: async (request, index) => { if (index === 0) await gate; return respond(request, index); } }), p = await f.open();
  await f.mode("confirm");
  const held = await p.submit("等待", "held"); await until(() => f.model.calls.length === 1);
  const queued = await p.submit(browser("open", { url: "https://example.com" }), "queued-restricted");
  await f.mode("full_access"); release(); await held.wait(context); await queued.wait(context);
  assert.ok(f.model.calls.slice(0, 2).every(request => !toolNames(request).includes("browser"))); assert.equal(f.calls(), 0);
  assert.equal((await p.harness.snapshot(LocalInputDoc, "queued-restricted", context))!.permission!.mode, "confirm");
  await p.answer(browser("open", { url: "https://example.com" }), "new-full");
  assert.ok(f.model.calls.some(request => toolNames(request).includes("browser"))); assert.equal(f.calls(), 1);
  await p.answer("交给子工作", "owner-for-child");
  const work = await p.work.delegate({ requestId: "integration-child", sourceRequestId: "owner-for-child", content: "子工作分析" }); await p.harness.waitForTask(work.taskId, context);
  const childCalls = f.model.calls.filter(request => request.system?.includes("你是个人助手的子 Agent")); assert.ok(childCalls.length > 0); assert.ok(childCalls.every(request => !toolNames(request).includes("browser")));
  const child = await p.harness.conversation(work.agentId, context); assert.ok(child); assert.ok(!(await child.agent(context)).tools.some(tool => tool.name === "browser"));
});

test("个人组合：截图经真实media/provider恢复，无general也能读产物且本机独占导出", async t => {
  const f = await fixture(t), p = await f.open(); await f.mode("full_access");
  await p.answer(browser("screenshot"), "screenshot"); const operation = (await f.operations())[0];
  assert.ok(operation.artifact && operation.image); assert.match(operation.image.data, /ruukotoImage/);
  assert.match(JSON.stringify(f.model.calls.at(-1)!.raw), new RegExp(png.toString("base64")));
  const originalEntries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.doesNotMatch(JSON.stringify(originalEntries), new RegExp(png.toString("base64")));
  const read = JSON.parse(await p.answer(invoke("read_artifact", { artifact: operation.artifact.id }), "read-screenshot")) as { base64: string; mime: string };
  assert.equal(read.base64, png.toString("base64")); assert.equal(read.mime, "image/png");
  await p.close(); const server = await f.server();
  const listed = await personalControl<{ items: { artifact: string; mime: string }[] }>(f.directory, "GET", "/tools/artifacts");
  assert.ok(listed.items.some(value => value.artifact === operation.artifact!.id && value.mime === "image/png"));
  const destination = path.join(f.root, "screenshot.png"); await personalControl(f.directory, "POST", "/tools/export", { artifact: operation.artifact.id, destination }); assert.deepEqual(fs.readFileSync(destination), png);
  await assert.rejects(personalControl(f.directory, "POST", "/tools/export", { artifact: operation.artifact.id, destination }), code("artifact_destination_exists"));
  await server.stop();
});

test("个人组合：read_file沿本次授权原字节返回视觉块与可重建产物", async t => {
  const f = await fixture(t, { general: true, browser: false }), p = await f.open(), filename = path.join(f.workspace, "picture.png"); fs.writeFileSync(filename, png);
  await p.answer(invoke("read_file", { path: filename }), "read-picture");
  const operation = await p.harness.commit(async tx => JSON.parse(JSON.stringify(await toolOperations(tx)))[0] as { artifact: { id: string }; approval: string; effect: string }, context);
  assert.equal(operation.approval, "unneeded"); assert.equal(operation.effect, "returned");
  assert.match(JSON.stringify(f.model.calls.at(-1)!.raw), new RegExp(png.toString("base64")));
  const entries = (await p.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.match(JSON.stringify(entries), /ruukotoImage/); assert.doesNotMatch(JSON.stringify(entries), new RegExp(png.toString("base64")));
  assert.equal(JSON.parse(await p.answer(invoke("read_artifact", { artifact: operation.artifact.id }), "read-image-bytes")).base64, png.toString("base64"));
});

test("个人组合：认证本机HTTP选择模式只影响以后接纳的输入", async t => {
  const f = await fixture(t); const server = await f.server();
  const input = async (content: string) => { const requestId = randomUUID(); await personalControl(f.directory, "POST", "/inputs", { requestId, input: content }); let result: PersonalInputStatus | undefined; await until(async () => { const current = await personalControl<PersonalInputStatus>(f.directory, "GET", `/input?requestId=${requestId}`); result = current; return current.status === "done" || current.status === "unanswered"; }); return result!; };
  await personalControl(f.directory, "POST", "/permissions", { mode: "confirm" }); await input("受限文字");
  assert.ok(!toolNames(f.model.calls.at(-1)!).includes("browser"));
  const before = f.model.calls.length; await personalControl(f.directory, "POST", "/permissions", { mode: "full_access" }); assert.equal(f.model.calls.length, before);
  await input(browser("open", { url: "https://example.com" })); assert.ok(f.model.calls.slice(before).some(request => toolNames(request).includes("browser"))); assert.equal(f.calls(), 1);
  await server.stop();
});


test("个人组合：纯文字模型在截图前明确拒绝，文件图片保留原产物且不发送缺图请求", async t => {
  const f = await fixture(t, { general: true, imageInput: false }), p = await f.open(); await f.mode("full_access");
  const screenshot = await p.answer(browser("screenshot"), "unsupported-screenshot");
  assert.match(screenshot, /image_input_unsupported/); assert.equal(f.calls(), 0); assert.equal((await f.operations()).length, 0);
  const filename = path.join(f.workspace, "photo.png"); fs.writeFileSync(filename, png);
  const result = JSON.parse(await p.answer(invoke("read_file", { path: filename }), "unsupported-file")) as { code: string; artifact: string };
  assert.equal(result.code, "image_input_unsupported"); assert.ok(result.artifact); assert.ok(f.model.calls.every(request => !JSON.stringify(request.raw).includes('"type":"image_url"')));
});

test("个人组合：旧本机来源委派沿原模式，权限反链损坏不创建子工作并拒绝恢复", async t => {
  const f = await fixture(t), p = await f.open(); await f.mode("confirm"); await p.answer("原请求", "old-owner"); await f.mode("full_access");
  const child = await p.work.delegate({ requestId: "old-source-child", sourceRequestId: "old-owner", content: "只分析" }); await p.harness.waitForTask(child.taskId, context);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, child.requestId, context))!.permission!.mode, "confirm");
  await p.harness.commit(async tx => { (await tx.doc(LocalInputDoc, "old-owner", "")).permission!.mode = "full_access"; }, context);
  const before = f.model.calls.length; await assert.rejects(p.work.delegate({ requestId: "forged-source-child", sourceRequestId: "old-owner", content: "不能扩权" }), code("input_permission_invalid")); assert.equal(f.model.calls.length, before);
  await p.close(); await assert.rejects(f.open(), code("input_permission_invalid")); assert.equal(f.model.calls.length, before);
});

for (const missing of [PERSONAL_MEDIA, PERSONAL_BROWSER]) test(`个人组合：移除已用${missing}扩展在任何恢复请求前拒绝`, async t => {
  const f = await fixture(t), p = await f.open(); await f.mode("full_access"); await p.answer(browser("screenshot"), "registered-image");
  await p.harness.commit(async tx => { const agent = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); assert.ok(Array.isArray(agent.extensions)); agent.extensions = agent.extensions.filter(name => name !== missing); }, context);
  const before = f.model.calls.length; await p.close(); await assert.rejects(f.open(), code(missing === PERSONAL_MEDIA ? "media_record_invalid" : "browser_config_missing")); assert.equal(f.model.calls.length, before);
});

for (const kind of ["ruukoto.media", "ruukoto.image", "ruukoto.browser", "ruukoto.browser-operation"]) test(`个人组合：${kind}新版本在恢复或外调前拒绝`, async t => {
  const f = await fixture(t), p = await f.open(); await f.mode("full_access"); await p.answer(browser("screenshot"), "registered-image"); await p.close(); const before = f.model.calls.length;
  const storage = await openNodeSqliteStorage(path.join(f.directory, "personal.sqlite"));
  try {
    const page = await storage.scanDocuments({ kind, scope: { kind: "session" }, at: "current" }, 1, undefined, context), record = page.items[0]; assert.ok(record);
    const saved = await storage.document(record.id, "current", context); assert.ok(saved);
    await storage.commit([{ type: "document.change", id: record.id, content: { kind: "base", version: 2, value: saved.value } }], context);
  } finally { await storage.close(context); }
  await assert.rejects(f.open(), code(kind.startsWith("ruukoto.media") || kind === "ruukoto.image" ? "media_record_invalid" : "browser_record_invalid")); assert.equal(f.model.calls.length, before);
});

test("个人组合：Telegram浏览器菜单沿原actor核实效果与后台停止，控制不调用模型", async t => {
  const f = await fixture(t), token = "123:integration_test", tokenEnv = "RK_BROWSER_INTEGRATION_TG_KEY", previousToken = process.env[tokenEnv]; process.env[tokenEnv] = token;
  const sends: { id: number; text: string }[] = [];
  const bot = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: string; chat_id?: string };
    if (req.url?.endsWith("/sendMessage")) { const id = 1000 + sends.length; sends.push({ id, text: input.text! }); res.end(JSON.stringify({ ok: true, result: { message_id: id, chat: { id: Number(input.chat_id), type: "private" } } })); return; }
    res.end(JSON.stringify({ ok: true, result: [] }));
  });
  bot.listen(0, "127.0.0.1"); await once(bot, "listening"); const address = bot.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { bot.closeAllConnections(); await new Promise<void>(resolve => bot.close(() => resolve())); if (previousToken === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previousToken; });
  const telegram: PersonalTelegramConfig = { version: 1, enabled: true, generation: randomUUID(), apiBase: `http://127.0.0.1:${address.port}`, tokenEnv, tokenDigest: createHash("sha256").update(token).digest("hex"), botId: "123", ownerId: "456", boundary: 0 };
  const p = await f.open({ telegram }); await f.mode("full_access");
  const receive = async (id: number, text: string, replyTo?: number) => {
    const update: TelegramUpdate = { update_id: id, message: { message_id: id, from: { id: 456, is_bot: false }, chat: { id: 456, type: "private" }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, from: { id: 123, is_bot: true } } }) } };
    await p.telegram.receive(update); const key = `telegram:123:456:${id}`, value = (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!; await p.harness.waitForTask(value.taskId, context); return (await p.harness.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!;
  };
  f.stop(false); f.unknown(true);
  await receive(1, browser("open", { url: "https://example.com" }));
  const operation = (await f.operations())[0]; assert.ok(operation); assert.equal(operation.effect, "effect_unknown"); assert.equal(operation.stopped, false);
  const before = f.model.calls.length;
  await receive(2, "/浏览器"); assert.match(sends.at(-1)!.text, /浏览器1/);
  await receive(3, "浏览器1", sends.at(-1)!.id); assert.match(sends.at(-1)!.text, /浏览器确认已生效/);
  await assert.rejects(p.harness.commit(tx => browserResolve(tx, operation.operation, "applied", "不能使用新代次", { requestId: "wrong-actor", generation: randomUUID(), botId: "123", ownerId: "456" }), context), code("browser_original_entry"));
  await assert.rejects(p.harness.commit(tx => browserResolve(tx, operation.operation, "applied", "不能使用另一平台", { requestId: "wrong-platform", platform: "qq", generation: telegram.generation, botId: "123", ownerId: "456" }), context), code("browser_original_entry"));
  await receive(4, "浏览器确认已生效", sends.at(-1)!.id);
  const resolution = await receive(5, "浏览器核实说明 已在独立网页确认目标变更", sends.at(-1)!.id); assert.equal(resolution.browserResolution!.operation, operation.operation);
  assert.equal((await f.operations())[0].resolution!.actor, "telegram:123:456:5");
  await receive(6, "刷新浏览器", sends.at(-1)!.id); f.stop(true);
  const stopped = await receive(7, "停止并核实浏览器", sends.at(-1)!.id); assert.ok(stopped.browserStop);
  await p.harness.waitForTask(stopped.browserStop.taskId, context); assert.equal((await f.operations())[0].stopped, true); assert.equal(f.model.calls.length, before); assert.equal(f.calls(), 1);
  await p.close(); await f.open({ telegram }); assert.equal(f.model.calls.length, before);
});
