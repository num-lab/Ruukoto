import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, Harness, MemoryStorage, ROOT_CONVERSATION_ID, createRegistry, type EntryId, type SnapshotEvent } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { personalTimeline, readPersonalHistory } from "../apps/ruukoto/src/personal-history.ts";
import { PERSONAL_DESKTOP_FRAME_LIMIT, PERSONAL_DESKTOP_BUFFER_LIMIT, personalDesktopCanSend, personalDesktopEvent, personalDesktopEvents, personalDesktopLive } from "../apps/ruukoto/src/personal-desktop-events.ts";
import type { PersonalDesktopFrame, PersonalTimelineEntry } from "@ruukoto/view/personal-protocol.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { personalControl, readPersonalToken, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalMockModelServer } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}
async function fixture(t: TestContext) {
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "DESKTOP_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => assert.fail("历史投影不得调用模型"));
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models }, context);
  await harness.root(context);
  t.after(() => harness.close(context));
  const append = (text: string) => harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1 }] }), context);
  return { harness, append };
}

async function socketFixture(t: TestContext) {
  const f = await fixture(t), directory = fs.mkdtempSync("/tmp/rk-events-"), socketPath = path.join(directory, "control.sock");
  const server = http.createServer(), token = "test-token", runId = randomUUID();
  const events = personalDesktopEvents(server, f.harness, token, runId);
  server.listen(socketPath); await once(server, "listening");
  const clients: WebSocket[] = [];
  t.after(async () => { for (const client of clients) client.terminate(); await events.close(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  const connect = (headers: Record<string, string> = { authorization: `Bearer ${token}` }, autoPong = true) => {
    const client = new WebSocket(`ws+unix:${socketPath}:/events`, { headers, autoPong });
    clients.push(client); return client;
  };
  return { ...f, server, token, runId, connect, events };
}

function messages(client: WebSocket) {
  const frames: PersonalDesktopFrame[] = [];
  client.on("message", data => { const text = data.toString(); assert.ok(Buffer.byteLength(text) <= PERSONAL_DESKTOP_FRAME_LIMIT); frames.push(JSON.parse(text)); });
  return frames;
}

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, "等待会话投影超时"); await delay(5); }
}

test("桌面历史：超过16条及总帧预算的历史分页完整，后续提交不进入原切点", async t => {
  const f = await fixture(t), text = "\u0000中文🙂".repeat(2200);
  await f.harness.commit(async tx => {
    for (let index = 0; index < 73; index++) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: `${index}:${text}`, timestamp: index }] });
    await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.system", model: [{ role: "system", content: "绝不输出的系统提示", timestamp: 1 }] });
  }, context);
  const first = await f.harness.commit(tx => personalTimeline(tx, {}), context);
  await f.append("切点之后的消息");
  let page = first;
  const entries: PersonalTimelineEntry[] = [];
  for (;;) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 128 * 1024);
    assert.ok(page.items.length <= 32);
    entries.push(...page.items);
    if (!page.nextCursor) break;
    page = await f.harness.commit(tx => personalTimeline(tx, { through: first.through, cursor: page.nextCursor }), context);
  }
  assert.equal(entries.length, 73); assert.equal(new Set(entries.map(entry => entry.entry)).size, 73);
  assert.ok(entries.every(entry => entry.truncated));
  assert.doesNotMatch(JSON.stringify(entries), /切点之后|绝不输出/);
  const oldest = entries.at(-1)!;
  let offset: number | undefined = 0, original = "";
  while (offset !== undefined) { const chunk = await f.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry: oldest.entry as EntryId, offset }), context); original += chunk.text; offset = chunk.nextOffset; }
  assert.equal(original, `0:${text}`);
  await assert.rejects(f.harness.commit(tx => personalTimeline(tx, { cursor: first.nextCursor!, through: first.through + 1 }), context), error => error instanceof PersonalError && error.code === "timeline_cursor_invalid");
  await assert.rejects(f.harness.commit(tx => personalTimeline(tx, { cursor: "bad-json" }), context), error => error instanceof PersonalError && error.code === "timeline_cursor_invalid");
});

test("桌面投影：原子快照和订阅边界并发提交只出现一次，消息不带系统提示", async t => {
  const f = await socketFixture(t);
  await f.append("原历史");
  await f.harness.commit(async tx => { (await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).instructions = "不发送的agent配置"; }, context);
  const client = f.connect(), frames = messages(client);
  const append = f.append("边界新消息");
  await once(client, "open"); await append;
  await until(() => frames.length > 0);
  await f.append("随后消息");
  await until(() => frames.some(frame => frame.type === "events" && frame.events.some(event => event.type === "message_end" && event.entry.text === "随后消息")));
  assert.equal(frames[0].type, "snapshot");
  const snapshot = frames[0]; assert.equal(snapshot.runId, f.runId);
  const text = frames.flatMap(frame => frame.type === "snapshot" ? frame.timeline.items.map(entry => entry.text) : frame.events.flatMap(event => event.type === "message_end" ? [event.entry.text] : []));
  assert.equal(text.filter(value => value === "边界新消息").length, 1);
  assert.equal(text.filter(value => value === "原历史").length, 1);
  assert.equal(text.filter(value => value === "随后消息").length, 1);
  assert.doesNotMatch(JSON.stringify(frames), /不发送的agent配置/);
  assert.ok(frames.every((frame, index) => frame.seq === index && frame.subscription === snapshot.subscription));
  const ping = once(client, "pong"); client.ping(); await ping;
  const closed = once(client, "close"); client.send("write"); assert.equal((await closed)[0], 1008);
  const preserved = await f.harness.commit(tx => personalTimeline(tx, {}), context);
  assert.equal(preserved.items.length, 3);
});

test("桌面投影：无本机令牌及浏览器Origin拒绝Upgrade，停止回收订阅和已升级socket", async t => {
  const f = await socketFixture(t);
  const denied: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${f.token}`, origin: "https://untrusted.invalid" }];
  for (const headers of denied) {
    const client = f.connect(headers);
    const status = new Promise<number>(resolve => client.once("unexpected-response", (_req, response) => { resolve(response.statusCode!); response.resume(); client.terminate(); }));
    client.on("error", () => { /* 拒绝握手后的主动销毁会产生客户端错误，状态由HTTP响应断言。 */ });
    assert.equal(await status, 401);
  }
  const client = f.connect(), frames = messages(client);
  await once(client, "open"); await until(() => frames.length > 0);
  const closed = once(client, "close");
  await f.events.close(); await closed;
  assert.equal(client.readyState, WebSocket.CLOSED);
  await f.append("观察断开不停止后台");
  assert.equal((await f.harness.commit(tx => personalTimeline(tx, {}), context)).items[0].text, "观察断开不停止后台");
});

test("桌面投影：帧和待发送预算守住上限，活动工具/大正文投影有界", () => {
  assert.equal(personalDesktopCanSend(PERSONAL_DESKTOP_FRAME_LIMIT, PERSONAL_DESKTOP_BUFFER_LIMIT - PERSONAL_DESKTOP_FRAME_LIMIT), true);
  assert.equal(personalDesktopCanSend(PERSONAL_DESKTOP_FRAME_LIMIT + 1, 0), false);
  assert.equal(personalDesktopCanSend(1, PERSONAL_DESKTOP_BUFFER_LIMIT), false);
  const snapshot: SnapshotEvent = { type: "snapshot", entries: [], generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "前段" }, { type: "thinking", thinking: "推理" }, { type: "text", text: "后段" }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } }, tools: Array.from({ length: 200 }, (_, index) => ({ callId: String(index), name: "tool", status: "running", output: "\u0000".repeat(100_000) })), nestedTools: [], compactions: [], inbox: [], agent: { instructions: "private" }, usage: { models: {}, tools: {} } };
  const live = personalDesktopLive(snapshot);
  assert.equal(live.toolCount, 200); assert.ok(live.tools.length < live.toolCount);
  assert.ok(Buffer.byteLength(JSON.stringify(live)) < 100 * 1024);
  assert.doesNotMatch(JSON.stringify(live), /private/);
  assert.deepEqual(live.generation?.message?.blocks?.map(value => [value.index, value.type, "text" in value ? value.text : ""]), [[0, "text", "前段"], [1, "thinking", "推理"], [2, "text", "后段"]]);
  const event = personalDesktopEvent({ type: "tool_execution_update", toolCallId: "original", toolName: "tool", output: { set: "x".repeat(100_000) } });
  assert.ok(event?.type === "tool_execution_update" && event.truncated && event.output?.set?.length === 4096);
});

test("桌面投影：原生订阅积压替换快照时关闭要求重同步，已落盘历史保持完整", async t => {
  const release = deferred(); t.after(() => release.resolve());
  const f = await socketFixture(t), captured = deferred(), original = f.harness.commit.bind(f.harness);
  let first = true;
  f.harness.commit = async (fn, ctx) => { const result = await original(fn, ctx); if (first) { first = false; captured.resolve(); await release.promise; } return result; };
  const client = f.connect(), frames = messages(client), closed = once(client, "close");
  await captured.promise;
  for (let index = 0; index < 110; index++) await original(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: String(index), timestamp: index }] }), context);
  release.resolve();
  await once(client, "open");
  assert.equal((await closed)[0], 1013); assert.equal(frames[0].type, "snapshot");
  f.harness.commit = original;
  let page = await original(tx => personalTimeline(tx, {}), context), count = page.items.length;
  while (page.nextCursor) { page = await original(tx => personalTimeline(tx, { cursor: page.nextCursor }), context); count += page.items.length; }
  assert.equal(count, 110);
});

test("桌面投影：30秒心跳未在10秒内收到pong就关闭观察流", async t => {
  const f = await socketFixture(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const client = f.connect(undefined, false), initial = once(client, "message");
  await once(client, "open"); await initial;
  const closed = once(client, "close");
  t.mock.timers.tick(30_000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  await closed;
  assert.equal(client.readyState, WebSocket.CLOSED);
  t.mock.timers.reset();
});

test("桌面投影：正常心跳仍在五分钟后重新认证", async t => {
  const f = await socketFixture(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const client = f.connect(), initial = once(client, "message");
  await once(client, "open"); await initial;
  const closed = once(client, "close");
  for (let index = 0; index < 9; index++) {
    const ping = once(client, "ping");
    t.mock.timers.tick(30_000);
    await ping;
    const pong = once(client, "pong"); client.ping(); await pong;
  }
  t.mock.timers.tick(30_000);
  assert.equal((await closed)[0], 1000);
  t.mock.timers.reset();
});

test("桌面接线：正式后台返回档案与运行代次，WS停止后档案可重新持锁", async t => {
  const directory = fs.mkdtempSync("/tmp/rk-events-server-"), key = "PA_DESKTOP_EVENTS_TEST_KEY", old = process.env[key];
  process.env[key] = "test-only";
  const model = new PersonalMockModelServer(() => ({ kind: "text", text: "answer" }));
  let server: Awaited<ReturnType<typeof startPersonalServer>> | undefined;
  t.after(async () => { await server?.stop(); await model.close(); if (old === undefined) delete process.env[key]; else process.env[key] = old; fs.rmSync(directory, { recursive: true, force: true }); });
  const baseUrl = await model.start();
  await savePersonalConfig(directory, { api: "openai-completions", baseUrl, modelId: "mock-model", apiKeyEnv: key, contextWindow: 8192, maxTokens: 1024 });
  server = await startPersonalServer(directory);
  const first = await personalControl<{ v: number; product: string; profile: { id: string; directory: string }; runId: string }>(directory, "GET", "/desktop/identity");
  assert.equal(first.product, "ruukoto"); assert.equal(first.profile.directory, fs.realpathSync(directory));
  const client = new WebSocket(`ws+unix:${path.join(directory, "control.sock")}:/events`, { headers: { authorization: `Bearer ${readPersonalToken(directory)}` } }), frames = messages(client);
  await once(client, "open"); await until(() => frames.length > 0);
  assert.equal(frames[0].runId, first.runId);
  const closed = once(client, "close"); await server.stop(); await closed;
  server = await startPersonalServer(directory);
  const next = await personalControl<typeof first>(directory, "GET", "/desktop/identity");
  assert.equal(next.profile.id, first.profile.id); assert.notEqual(next.runId, first.runId);
  const timeline = await personalControl<{ through: number; items: PersonalTimelineEntry[] }>(directory, "GET", "/timeline");
  assert.ok(timeline.through >= 0); assert.deepEqual(timeline.items, []);
});
