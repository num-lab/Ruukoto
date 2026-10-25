import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, ProviderDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { personalMedia, PersonalMediaMessageDoc, PersonalMediaDoc, type PersonalMediaDownload } from "../apps/ruukoto/src/personal-media.ts";
import { personalProvider, recordedModels, type RequestEvidence } from "../apps/ruukoto/src/personal-model.ts";
import { personalTelegram, PersonalTelegramDoc, PersonalTelegramReceiptDoc } from "../apps/ruukoto/src/personal-telegram.ts";
import { telegramMessage, personalTelegramApi, type TelegramUpdate, type PersonalTelegramApi } from "../apps/ruukoto/src/personal-telegram-api.ts";
import type { PersonalQqApi } from "../apps/ruukoto/src/personal-qq-api.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { lockPersonalProfile } from "../apps/ruukoto/src/personal-profile.ts";
import { savePersonalArtifact } from "../apps/ruukoto/src/personal-artifacts.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
const source = { platform: "qq" as const, accountId: "bot", ownerId: "owner", generation: "generation" };
const photo = (id = 1, caption = "看看图片"): TelegramUpdate => ({ update_id: id, message: { message_id: id, from: { id: 456, is_bot: false }, chat: { id: 456, type: "private" }, caption, photo: [{ file_id: "small", file_unique_id: "small-unique", width: 1, height: 1 }, { file_id: "large", file_unique_id: "large-unique", width: 100, height: 100, file_size: png.length }] } });
const download = (bytes = png, declaredMime = "image/png"): PersonalMediaDownload => ({ identity: randomUUID(), declaredMime, download: async () => new Response(bytes, { headers: { "content-type": declaredMime } }) });

async function fixture(t: TestContext, options: { imageInput?: boolean; capture?: boolean; compaction?: boolean; holdInbound?: boolean; inboundMime?: "image/jpeg" } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync("/tmp/ruukoto-media-")), lock = lockPersonalProfile(directory), requests: RequestEvidence[] = [], sends: string[] = [];
  let downloads = 0, h: Harness;
  const model = new MockModelServer((_input, index) => options.capture && index === 0 ? { kind: "tool_calls", calls: [{ id: "image-call", name: "capture", arguments: {} }] } : { kind: "text", text: "图片回答" });
  const config = { api: "openai-completions" as const, baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_MEDIA_TEST_KEY", contextWindow: 128000, maxTokens: 4096, imageInput: options.imageInput ?? true };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const provider = personalProvider(config), media = personalMedia(lock.directory, () => h, () => config.imageInput);
  const tgConfig = { version: 1 as const, enabled: true, generation: "generation", apiBase: "https://api.telegram.org", tokenEnv: "TOKEN", tokenDigest: "0".repeat(64), botId: "123", ownerId: "456", boundary: 0, boundaryMessageId: "0" };
  const inboundMime = options.inboundMime ?? "image/png", inboundBytes = options.inboundMime ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]) : png;
  const api: PersonalTelegramApi = { me: async () => ({ id: "123", username: "bot" }), updates: async () => [], send: async (_owner, _id, text) => { sends.push(text); return String(sends.length); }, photo: input => ({ identity: input.identity, declaredMime: inboundMime, download: async () => { downloads++; return new Response(inboundBytes, { headers: { "content-type": inboundMime } }); } }) };
  const qqConfig = { version: 1 as const, enabled: true, generation: randomUUID(), endpoint: "ws://127.0.0.1:1", tokenEnv: "TOKEN", tokenDigest: "0".repeat(64), botId: "123", ownerId: "456", boundary: 0, boundaryMessageId: "0" };
  const qqApi: PersonalQqApi = { online: true, verify: async () => {}, close: async () => {}, poll: async () => {}, send: api.send, photo: input => api.photo({ identity: input.identity, fileId: input.identity }) };
  const tg = personalTelegram(tgConfig, api, undefined, media, qqConfig, qqApi);
  // 暂停真实收件任务，让手动提交落在 admission 与媒体 bind 之间；重开后恢复原任务执行。
  const phases = tg.extension.tasks![0].definition.phases, run = phases.run;
  if (options.holdInbound) Object.defineProperty(phases, "run", { value: async (_task: unknown, runtime: { signal: AbortSignal }) => { await new Promise<void>(resolve => { runtime.signal.addEventListener("abort", () => resolve(), { once: true }); }); } });
  const capture = defineTool({ name: "capture", description: "返回测试图片", parameters: Type.Object({}), replay: "safe", execute: async (_input, execution, callContext) => {
    const artifact = await savePersonalArtifact(lock.directory, png, { mime: "image/png" });
    const image = await execution.commit(tx => media.registerImage(tx, artifact, { conversationId: execution.conversationId, taskId: execution.taskId }), callContext);
    return { output: [image] };
  } });
  const extension = defineExtension({ name: "media-test", tools: options.capture ? [capture] : [] }), registry = createRegistry(); registry.install(extension); registry.install(tg.extension);
  const open = async () => {
    const storage = await openNodeSqliteStorage(path.join(directory, "personal.sqlite"));
    h = await Harness.open(storage, { models: recordedModels(provider, async value => { requests.push(value); await h.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.request", data: value }), context); }, media.modelMedia), registry, ...(options.compaction ? { settings: { compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 1, backgroundTokens: 0 } } } : {}) }, context);
    const main = await h.root(context, { agent: { model: { provider: provider.id, modelId: config.modelId }, extensions: [extension, tg.extension], tools: options.capture ? [capture] : [] } });
    await h.commit(async tx => { const state = await tx.doc(PersonalTelegramDoc); state.config = { ...tgConfig }; state.qqConfig = { ...qqConfig }; }, context);
    await media.recover(); h.resume(); return { h, main, telegram: tg.api(h) };
  };
  let p = await open();
  t.after(async () => { await h.close(context); await model.close(); lock.release(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, media, model, requests, config, sends, tgConfig, api, get downloads() { return downloads; }, get p() { return p; }, async reopen() { if (options.holdInbound) Object.defineProperty(phases, "run", { value: run }); await h.close(context); p = await open(); return p; } };
}
async function receipt(f: Awaited<ReturnType<typeof fixture>>, id = 1) {
  const value = (await f.p.h.snapshot(PersonalTelegramReceiptDoc, `telegram:123:456:${id}`, context))!.receipt!;
  await f.p.h.waitForTask(value.taskId, context);
  return (await f.p.h.snapshot(PersonalTelegramReceiptDoc, value.requestId, context))!.receipt!;
}

test("个人图片：最大Telegram照片、caption不执行控制、原生图输入与证据按引用重建", async t => {
  const f = await fixture(t);
  assert.equal(telegramMessage(photo())!.media![0].fileId, "large");
  await f.p.telegram.receive(photo(1, "完全访问"));
  const saved = await receipt(f);
  assert.equal(saved.delivery, "sent"); assert.equal(saved.control, undefined); assert.ok(saved.accepted);
  assert.equal((await f.p.h.snapshot(PersonalPermissionsDoc, context))!.mode, "auto-review");
  assert.equal(f.downloads, 1); assert.equal(f.model.calls.length, 1);
  assert.match(JSON.stringify(f.model.calls[0].raw), new RegExp(png.toString("base64")));
  const entry = await f.p.h.commit(async tx => tx.entry((await tx.submissionByRequest(ROOT_CONVERSATION_ID, saved.requestId))!.entry!), context);
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(png.toString("base64")));
  assert.doesNotMatch(JSON.stringify(f.requests), new RegExp(png.toString("base64")));
  assert.match(JSON.stringify(f.requests), /ruukotoImage/);
  await f.p.telegram.receive(photo(1, "完全访问")); assert.equal(f.downloads, 1); assert.equal(f.model.calls.length, 1);
  await f.reopen();
  await (await f.p.main.submit({ type: "input", content: "原图是什么？", requestId: "after-reopen" }, context)).wait(context);
  assert.equal(f.model.calls.length, 2); assert.match(JSON.stringify(f.model.calls[1].raw), new RegExp(png.toString("base64")));
});

test("个人图片：纯文本模型固定拒绝、错拥有者不下载、旧代次重投不重新包装", async t => {
  const f = await fixture(t, { imageInput: false });
  const wrong = photo(); (wrong.message as { from: { id: number }; chat: { id: number } }).from.id = 789; (wrong.message as { chat: { id: number } }).chat.id = 789;
  await f.p.telegram.receive(wrong); assert.equal(f.downloads, 0);
  await f.p.telegram.receive(photo()); const saved = await receipt(f);
  assert.equal(saved.mediaRejected, true); assert.equal(saved.submissionId, undefined); assert.equal(f.model.calls.length, 0); assert.equal(f.downloads, 0); assert.match(f.sends[0], /不支持图片/);
  f.tgConfig.generation = "new-generation";
  await f.p.h.commit(async tx => { (await tx.doc(PersonalTelegramDoc)).config = { ...f.tgConfig }; }, context);
  await f.p.telegram.receive(photo()); assert.equal(f.downloads, 0); assert.equal(f.model.calls.length, 0); assert.equal((await f.p.h.snapshot(PersonalTelegramReceiptDoc, saved.requestId, context))!.receipt!.generation, "generation");
});

test("个人图片：格式、上限、下载失败、取消和未绑定过期保留明确事实", async t => {
  const f = await fixture(t);
  const stage = (key: string, media: PersonalMediaDownload[], signal?: AbortSignal) => f.media.stage({ key, source, body: "", media }, signal);
  assert.equal((await stage("count", Array.from({ length: 5 }, () => download()))).reason, "too_many_images");
  assert.equal((await stage("large", [{ ...download(), sizeBytes: 8 * 1024 * 1024 + 1 }])).reason, "image_too_large");
  assert.equal((await stage("mime", [download(png, "image/gif")])).reason, "mime_unsupported");
  assert.equal((await stage("magic", [download(Buffer.from("not png"))])).reason, "mime_mismatch");
  let attempts = 0;
  assert.equal((await stage("network", [{ identity: "network", download: async () => { attempts++; throw new Error("secret URL"); } }])).reason, "download_failed"); assert.equal(attempts, 3);
  const controller = new AbortController(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = stage("cancel", [{ identity: "cancel", download: async () => { started(); return new Promise(() => {}); } }], controller.signal);
  await ready; controller.abort(); await assert.rejects(pending);
  await f.media.recover(); assert.equal((await f.media.message("cancel"))!.reason, "download_interrupted");
  const orphan = await stage("orphan", [download()]);
  await f.p.h.commit(async tx => { (await tx.doc(PersonalMediaMessageDoc, "orphan", null)).message!.receivedAt = Date.now() - 25 * 60 * 60 * 1000; }, context);
  await f.media.recover(); assert.equal((await f.media.message("orphan"))!.state, "expired"); assert.equal(fs.existsSync(path.join(f.directory, "artifacts", `${orphan.artifacts[0].id}.bin`)), false);
});

test("个人图片：toolResult原生归属、缺失/损坏/伪造/partial均不发模型请求", async t => {
  const f = await fixture(t, { capture: true });
  await (await f.p.main.submit({ type: "input", content: "截图", requestId: "capture" }, context)).wait(context);
  assert.equal(f.model.calls.length, 2); assert.match(JSON.stringify(f.model.calls[1].raw), new RegExp(png.toString("base64"))); assert.doesNotMatch(JSON.stringify(f.requests), new RegExp(png.toString("base64")));
  const artifacts = await f.p.h.commit(tx => f.media.mediaArtifacts(tx), context); assert.equal(artifacts.length, 1);
  fs.writeFileSync(path.join(f.directory, "artifacts", `${artifacts[0].artifact.id}.bin`), Buffer.alloc(png.length));
  const before = f.model.calls.length;
  await (await f.p.main.submit({ type: "input", content: "继续", requestId: "corrupt" }, context)).wait(context);
  assert.equal(f.model.calls.length, before);
  await assert.rejects(f.media.modelMedia.prepare({ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: JSON.stringify({ ruukotoImage: { version: 1, artifact: { id: "forged", partial: true, mime: "image/png" } } }) }], timestamp: Date.now() }] }, "forged"), error => error instanceof PersonalError && error.code === "image_reference_invalid");
  const index = await f.p.h.snapshot(PersonalMediaDoc, context); assert.equal(index!.images.length, 1);
});

test("个人图片：Telegram下载仅固定getFile路径，声明与真实字节均校验", async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async input => { calls++; const url = String(input); return url.endsWith("getFile") ? Response.json({ ok: true, result: { file_path: "photos/file.png" } }) : new Response(png, { headers: { "content-type": "application/octet-stream" } }); };
  try {
    const api = personalTelegramApi("https://api.telegram.org", "secret"); const file = await api.photo({ identity: "photo", fileId: "file" }).download(new AbortController().signal); assert.equal(file.headers.get("content-type"), "image/png"); assert.deepEqual(Buffer.from(await file.arrayBuffer()), png); assert.equal(calls, 2);
    globalThis.fetch = async () => Response.json({ ok: true, result: { file_path: "../secret" } });
    await assert.rejects(api.photo({ identity: "photo", fileId: "file" }).download(new AbortController().signal), error => error instanceof PersonalError && error.code === "download_unavailable");
  } finally { globalThis.fetch = previous; }
});


test("个人图片：提交后尚未bind即可按原entry恢复，重开补bind不重复模型或下载", async t => {
  const f = await fixture(t, { holdInbound: true }), key = "qq:123:456:-1";
  await f.p.telegram.qq.receive({ post_type: "message", message_type: "private", sub_type: "friend", self_id: 123, user_id: 456, message_id: -1, time: 1, message: [{ type: "text", data: { text: "窗口图片" } }, { type: "image", data: { file: "gap-image" } }] });
  const submission = await f.p.main.submit({ type: "input", content: await f.media.input(key), requestId: key }, context);
  await submission.wait(context);
  assert.equal((await f.media.message(key))!.state, "ready"); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads, 1);
  await f.reopen();
  await f.p.h.waitForTask((await f.p.h.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!.taskId, context);
  const message = (await f.media.message(key))!;
  assert.equal(message.state, "bound"); assert.equal(message.submissionId, submission.id); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads, 1);
  const sessionId = (await f.p.h.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, context))!.sessionId!;
  const input = await f.media.input(key);
  assert.ok(Array.isArray(input));
  await assert.rejects(f.media.modelMedia.prepare({ messages: [{ role: "user", content: input, timestamp: 1 }] }, sessionId + "other"), error => error instanceof PersonalError && error.code === "image_reference_invalid");
});

test("个人图片：实际payload变造、删除和未登记外链图片都在HTTP前拒绝", async t => {
  const f = await fixture(t);
  await f.p.telegram.receive(photo()); await receipt(f);
  const view = await f.p.main.context(context), sessionId = (await f.p.h.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, context))!.sessionId!;
  const models = recordedModels(personalProvider(f.config), async () => {}, f.media.modelMedia), model = models.getModel("personal", f.config.modelId)!;
  const before = f.model.calls.length;
  for (const change of ["bytes", "drop", "remote", "placeholder"]) {
    const result = await models.streamSimple(model, { messages: [...view.messages] }, { sessionId, onPayload: async payload => {
      if (change === "bytes") return JSON.parse(JSON.stringify(payload).replaceAll(png.toString("base64"), Buffer.from("changed").toString("base64")));
      if (change === "placeholder") {
        const user = view.messages.find(message => message.role === "user" && Array.isArray(message.content) && message.content.some(part => part.type === "image"));
        const image = user && Array.isArray(user.content) ? user.content.find(part => part.type === "image") : undefined;
        assert.ok(image && image.type === "image");
        return JSON.parse(JSON.stringify(payload).replaceAll(`data:image/png;base64,${png.toString("base64")}`, image.data));
      }
      const value = JSON.parse(JSON.stringify(payload)) as { messages: { role: string; content: string | { type: string; image_url?: { url: string } }[] }[] };
      for (const message of value.messages) if (Array.isArray(message.content)) message.content = change === "drop" ? message.content.filter(part => part.type !== "image_url") : [...message.content, { type: "image_url", image_url: { url: "https://unregistered.invalid/image.png" } }];
      return value;
    } }).result();
    assert.equal(result.stopReason, "error"); assert.equal(f.model.calls.length, before);
  }
});

test("个人图片：普通文字中的图片JSON不被解释成媒体输入", async t => {
  const f = await fixture(t);
  await (await f.p.main.submit({ type: "input", content: JSON.stringify({ type: "image", mimeType: "image/png", data: JSON.stringify({ ruukotoImage: { artifact: { id: "unregistered" } } }) }), requestId: "text-only-reference" }, context)).wait(context);
  assert.equal(f.model.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.model.calls[0].raw), /"type":"image_url"/);
});


test("个人图片：相同字节不同来源的payload归一映射保留全部原引用", async t => {
  const f = await fixture(t);
  await f.p.telegram.receive(photo(1)); await receipt(f, 1);
  await f.p.telegram.receive(photo(2)); await receipt(f, 2);
  const request = f.requests.filter(value => value.payload !== undefined).at(-1)!;
  assert.ok(Array.isArray(request.imageMappings));
  const mapping = request.imageMappings[0];
  assert.ok(mapping && typeof mapping === "object" && !Array.isArray(mapping) && Array.isArray(mapping.references));
  assert.equal(mapping.references.length, 2);
  assert.notDeepEqual(mapping.references[0], mapping.references[1]);
  assert.deepEqual(mapping.payloadReference, mapping.references[0]);
  assert.doesNotMatch(JSON.stringify(request), new RegExp(png.toString("base64")));
});

test("个人图片：Responses原生工具图片与入站图均可重建，变造仍在HTTP前拒绝", async t => {
  const f = await fixture(t, { capture: true, inboundMime: "image/jpeg" });
  await f.p.telegram.receive(photo()); await receipt(f);
  const view = await f.p.main.context(context), sessionId = (await f.p.h.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, context))!.sessionId!;
  const before = f.model.calls.length;
  for (const change of ["valid", "bytes", "drop", "remote", "duplicate"] as const) {
    const recorded: RequestEvidence[] = [], controller = new AbortController();
    const models = recordedModels(personalProvider({ ...f.config, api: "openai-responses" }), async value => { await f.p.h.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.responses-request", data: value }), context); recorded.push(value); if (value.payload) controller.abort(); }, f.media.modelMedia);
    const model = models.getModel("personal", f.config.modelId)!;
    const result = await models.streamSimple(model, { messages: [...view.messages] }, { sessionId, signal: controller.signal, onPayload: payload => {
      const value = JSON.parse(JSON.stringify(payload)) as { input: { type?: string; output?: { type: string; image_url?: string }[] }[] };
      const tool = value.input.find(item => item.type === "function_call_output");
      assert.ok(tool && Array.isArray(tool.output));
      const image = tool.output.find(part => part.type === "input_image"); assert.ok(image);
      if (change === "bytes") image.image_url = `data:image/png;base64,${Buffer.from("changed").toString("base64")}`;
      if (change === "drop") tool.output = tool.output.filter(part => part !== image);
      if (change === "remote") image.image_url = "https://unregistered.invalid/image.png";
      if (change === "duplicate") tool.output.push({ ...image });
      return value;
    } }).result();
    assert.equal(result.stopReason, change === "valid" ? "aborted" : "error");
    assert.equal(recorded.filter(value => value.payload).length, change === "valid" ? 1 : 0);
    assert.equal(f.model.calls.length, before);
    if (change === "valid") {
      const saved = recorded.at(-1)!, mappings = saved.imageMappings; assert.ok(Array.isArray(mappings)); assert.equal(mappings.length, 2);
      assert.match(JSON.stringify(saved.payload), /ruukoto-image:/); assert.match(JSON.stringify(saved.payload), /image\/jpeg/); assert.match(JSON.stringify(saved.payload), /image\/png/);
      assert.doesNotMatch(JSON.stringify(recorded), /data:image\//); assert.doesNotMatch(JSON.stringify(recorded), new RegExp(png.toString("base64")));
    }
  }
});


test("个人图片：原生压缩只用文本且保留图片产物引用，原视觉输入历史不删", async t => {
  const f = await fixture(t, { compaction: true });
  await f.p.telegram.receive(photo()); const saved = await receipt(f);
  const image = (await f.media.message(saved.requestId))!.artifacts[0];
  const original = await f.p.h.commit(async tx => (await tx.submissionByRequest(ROOT_CONVERSATION_ID, saved.requestId))!.entry!, context);
  await (await f.p.main.submit({ type: "input", content: "后续问题", requestId: "later" }, context)).wait(context);
  const before = f.model.calls.length;
  await f.p.h.waitForTask(await f.p.main.compact("保留原图片引用", context), context);
  assert.equal(f.model.calls.length, before + 1);
  const summaryInput = JSON.stringify(f.model.calls.at(-1)!.raw);
  assert.match(summaryInput, new RegExp(image.id)); assert.match(summaryInput, /压缩摘要不包含图片的视觉细节/); assert.doesNotMatch(summaryInput, new RegExp(png.toString("base64")));
  assert.match(JSON.stringify(await f.p.h.commit(tx => tx.entry(original), context)), /ruukotoImage/);
});

test("个人图片接纳顺序：文字菜单先完成读取，再追加accepted，审批选择仍可用", async t => {
  const f = await fixture(t);
  const text = (id: number, content: string, reply = false): TelegramUpdate => ({ update_id: id, message: { message_id: id, from: { id: 456, is_bot: false }, chat: { id: 456, type: "private" }, text: content, ...(reply ? { reply_to_message: { message_id: 1, from: { id: 123, is_bot: true } } } : {}) } });
  await f.p.telegram.receive(text(1, "/权限")); await receipt(f, 1);
  await f.p.telegram.receive(text(2, "完全访问", true)); const selected = await receipt(f, 2);
  assert.equal(selected.control, true); assert.ok(selected.accepted); assert.equal((await f.p.h.snapshot(PersonalPermissionsDoc, context))!.mode, "full_access"); assert.equal(f.model.calls.length, 0);
});

test("个人图片：普通工具参数中的type/image/data不被图片快照误解释", async t => {
  const f = await fixture(t, { capture: true });
  await (await f.p.main.submit({ type: "input", content: "截图", requestId: "ordinary-tool-args" }, context)).wait(context);
  const view = await f.p.main.context(context), sessionId = (await f.p.h.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, context))!.sessionId!;
  const messages = JSON.parse(JSON.stringify(view.messages)) as typeof view.messages;
  const assistant = messages.find(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall"));
  assert.ok(assistant && assistant.role === "assistant");
  const call = assistant.content.find(part => part.type === "toolCall"); assert.ok(call && call.type === "toolCall");
  call.arguments = { service: "image-editor", params: { type: "image", data: "asset-123" }, schema: { type: "image_url", image_url: { url: "business-value" } } };
  const prepared = await f.media.modelMedia.prepare({ messages: [...messages] }, sessionId);
  assert.match(JSON.stringify(prepared.snapshot({ messages })), /asset-123/);
  assert.doesNotThrow(() => prepared.snapshot({ messages: [{ role: "assistant", content: [{ type: "tool_use", input: call.arguments }] }, { role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] }] }] }, true));
  assert.throws(() => prepared.snapshot({ messages: [{ role: "user", content: [{ type: "image", data: JSON.stringify({ ruukotoImage: "placeholder" }) }] }] }, true), error => error instanceof PersonalError && error.code === "image_reference_invalid");
});

test("个人图片：在途重复共享一次下载，同键异参在复用前拒绝", async t => {
  const f = await fixture(t); let release!: () => void, started!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const input = { key: "in-flight", source, body: "原说明", media: [{ identity: "same-image", declaredMime: "image/png", download: async () => { calls++; started(); await gate; return new Response(png, { headers: { "content-type": "image/png" } }); } }] };
  const first = f.media.stage(input); await ready;
  const duplicate = f.media.stage(input);
  await assert.rejects(f.media.stage({ ...input, body: "不同说明" }), error => error instanceof PersonalError && error.code === "media_input_conflict");
  await assert.rejects(f.media.stage({ ...input, source: { ...source, generation: "changed" } }), error => error instanceof PersonalError && error.code === "media_input_conflict");
  release(); assert.deepEqual(await duplicate, await first); assert.equal(calls, 1);
});

test("个人图片：全部原字节已登记但缺ready提交时恢复原键，不重新下载", async t => {
  const f = await fixture(t, { holdInbound: true }), key = "qq:123:456:-1";
  const input = { post_type: "message", message_type: "private", sub_type: "friend", self_id: 123, user_id: 456, message_id: -1, time: 1, message: [{ type: "text", data: { text: "已下载" } }, { type: "image", data: { file: "ready-image" } }] };
  await f.p.telegram.qq.receive(input); const saved = (await f.media.message(key))!;
  await f.p.h.commit(async tx => { (await tx.doc(PersonalMediaMessageDoc, key, null)).message!.state = "staging"; }, context);
  await f.media.recover(); assert.equal((await f.media.message(key))!.state, "ready"); assert.equal(f.downloads, 1);
  await f.p.telegram.qq.receive(input); assert.deepEqual((await f.media.message(key))!.artifacts, saved.artifacts); assert.equal(f.downloads, 1);
  await (await f.p.main.submit({ type: "input", content: await f.media.input(key), requestId: key }, context)).wait(context);
  assert.equal(f.model.calls.length, 1); assert.match(JSON.stringify(f.model.calls[0].raw), new RegExp(png.toString("base64")));
  await f.reopen();
  await f.p.h.waitForTask((await f.p.h.snapshot(PersonalTelegramReceiptDoc, key, context))!.receipt!.taskId, context);
  assert.equal((await f.media.message(key))!.state, "bound"); assert.equal(f.model.calls.length, 1); assert.equal(f.downloads, 1);
});
