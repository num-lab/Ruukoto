import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, createRegistry, Harness, MemoryStorage, ROOT_CONVERSATION_ID, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { personalProvider, recordedModels } from "../apps/ruukoto/src/personal-model.ts";
import { PersonalAgentsDoc } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalSchedulesDoc, PersonalScheduleRunDoc, PersonalScheduledConversationDoc } from "../apps/ruukoto/src/personal-scheduler-records.ts";
import { activePersonalReferenceTool, historyVisible, personalHistoryEntry, personalHistory, readPersonalHistory, searchPersonalHistory } from "../apps/ruukoto/src/personal-history.ts";
import { PersonalMockModelServer as MockModelServer } from "./helpers/mock-provider.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";

const context = BACKGROUND_CONTEXT;
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
async function fixture(t: TestContext) {
  const registry = createRegistry(); registry.install(personalHistory());
  const models = recordedModels(personalProvider({ api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "unused", apiKeyEnv: "HISTORY_UNUSED_KEY", contextWindow: 4096, maxTokens: 1024 }), async () => assert.fail("直接历史读取不应调用模型"));
  const harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
  await harness.root(context); t.after(() => harness.close(context));
  const append = (conversationId: ConversationId, content: string) => harness.commit(tx => tx.appendEntry(conversationId, { kind: "pi.user", model: [{ role: "user", content, timestamp: 1 }] }), context);
  const child = await harness.commit(async tx => { const child = await tx.createConversation({ ownership: { kind: "ownerless" } }); (await tx.doc(PersonalAgentsDoc)).agents.push({ id: child.id, label: "历史子Agent", closed: false }); return child.id; }, context);
  return { harness, append, child };
}

test("历史：主会话只读已登记新会话，子身份只读自身且复用保留原文", async t => {
  const f = await fixture(t), parent = await f.append(ROOT_CONVERSATION_ID, "父聊天私有资料"), old = await f.append(f.child, "第一次工作原文");
  const stranger = await f.harness.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), context), hidden = await f.append(stranger.id, "未登记资料");
  await f.harness.commit(async tx => {
    assert.equal(await historyVisible(tx, ROOT_CONVERSATION_ID, f.child), true);
    assert.equal(await historyVisible(tx, f.child, ROOT_CONVERSATION_ID), false);
    assert.equal(await historyVisible(tx, stranger.id, stranger.id), false);
    assert.equal((await personalHistoryEntry(tx, ROOT_CONVERSATION_ID, old.id)).id, old.id);
    assert.equal((await personalHistoryEntry(tx, f.child, old.id)).id, old.id);
    await assert.rejects(personalHistoryEntry(tx, f.child, parent.id), code("history_reference_invalid"));
    await assert.rejects(personalHistoryEntry(tx, ROOT_CONVERSATION_ID, hidden.id), code("history_reference_invalid"));
  }, context);
  await f.append(f.child, "复用身份后的第二次工作");
  const page = await f.harness.commit(tx => searchPersonalHistory(tx, f.child, { query: "第一次" }), context);
  assert.equal(page.items[0]?.entry, old.id); assert.doesNotMatch(JSON.stringify(page), /父聊天|未登记资料/);
});

test("历史：压缩仅改变模型上下文，原始消息仍能查找和完整分页读取", async t => {
  const f = await fixture(t), text = "原始长消息".repeat(1100), old = await f.append(ROOT_CONVERSATION_ID, text), retained = await f.append(ROOT_CONVERSATION_ID, "保留的最近消息");
  await f.harness.commit(tx => tx.appendEntry(CompactionEntry, ROOT_CONVERSATION_ID, { head: retained.id, model: [{ role: "user", content: "压缩摘要", timestamp: 2 }], data: { reason: "manual" } }), context);
  const active = await (await f.harness.conversation(ROOT_CONVERSATION_ID, context))!.context(context);
  assert.equal(active.entries.some(entry => entry.id === old.id), false);
  assert.equal((await f.harness.commit(tx => searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: "原始长消息" }), context)).items[0]?.entry, old.id);
  let offset: number | undefined = 0, joined = "";
  while (offset !== undefined) { const page = await f.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry: old.id, offset }), context); assert.ok(page.text.length <= 4096); joined += page.text; offset = page.nextOffset; }
  assert.equal(joined, text);
  await assert.rejects(f.harness.commit(tx => readPersonalHistory(tx, ROOT_CONVERSATION_ID, { entry: old.id, offset: text.length + 1 }), context), code("history_offset_invalid"));
});

test("历史：检索扫描有界，空页仍给续页并且不漏较早消息", async t => {
  const f = await fixture(t), old = await f.append(ROOT_CONVERSATION_ID, "非常早的目标");
  await f.harness.commit(async tx => { for (let i = 0; i < 300; i++) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "后来的无关消息", timestamp: i + 10 }] }); }, context);
  const first = await f.harness.commit(tx => searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: "目标" }), context);
  assert.equal(first.scanned, 256); assert.equal(first.items.length, 0); assert.ok("nextCursor" in first && first.nextCursor);
  const next = await f.harness.commit(tx => searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: "目标", cursor: "nextCursor" in first ? first.nextCursor : undefined }), context);
  assert.equal(next.items[0]?.entry, old.id);
  await assert.rejects(f.harness.commit(tx => searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: "另一关键词", cursor: "nextCursor" in first ? first.nextCursor : undefined }), context), code("history_cursor_invalid"));
  await assert.rejects(f.harness.commit(tx => searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: "目标", cursor: "bad-json" }), context), code("history_cursor_invalid"));
});

test("历史：定时只读自身；系统提示与账本字段不作为消息来源", async t => {
  const f = await fixture(t), scheduled = await f.harness.commit(async tx => {
    const scheduled = await tx.createConversation({ ownership: { kind: "ownerless" } }), runId = "history-test-run";
    (await tx.doc(PersonalSchedulesDoc)).runs.push(runId);
    (await tx.doc(PersonalScheduledConversationDoc, String(scheduled.id), null)).runId = runId;
    (await tx.doc(PersonalScheduleRunDoc, runId, null)).run = { id: runId, planId: "plan", planVersion: 1, scheduledFor: "2026-10-18T00:00:00Z", mergedFrom: "2026-10-18T00:00:00Z", mergedThrough: "2026-10-18T00:00:00Z", admission: 1 as EntryId, taskId: 1 as import("@earendil-works/pi-durable").TaskId, conversationId: scheduled.id, requestId: "run", cancelRequested: false, sealed: true, members: [] };
    return scheduled.id;
  }, context), own = await f.append(scheduled, "定时自己的历史"), child = await f.append(f.child, "别人的历史");
  const bookkeeping = await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "ruukoto.private-ledger", data: { secret: "不能进入搜索" } }), context), system = await f.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.system", model: [{ role: "system", content: "不能进入搜索", timestamp: 1 }] }), context);
  await f.harness.commit(async tx => {
    assert.equal(await historyVisible(tx, ROOT_CONVERSATION_ID, scheduled), true);
    assert.equal((await personalHistoryEntry(tx, scheduled, own.id)).id, own.id);
    await assert.rejects(personalHistoryEntry(tx, scheduled, child.id), code("history_reference_invalid"));
    await assert.rejects(personalHistoryEntry(tx, ROOT_CONVERSATION_ID, bookkeeping.id), code("history_reference_invalid"));
    await assert.rejects(personalHistoryEntry(tx, ROOT_CONVERSATION_ID, system.id), code("history_reference_invalid"));
    assert.equal((await searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: "不能进入搜索" })).items.length, 0);
  }, context);
});

test("历史：工具入口拒绝不属于活动模型的伪造调用", async t => {
  const f = await fixture(t);
  await assert.rejects(f.harness.commit(tx => activePersonalReferenceTool(tx, { conversationId: ROOT_CONVERSATION_ID, taskId: 999 as import("@earendil-works/pi-durable").TaskId }, "history_read"), context), code("reference_tool_inactive"));
  assert.deepEqual(personalHistory().tools?.map(tool => tool.name), ["history_search", "history_read"]);
});


test("历史：实际模型工具调用持久保存定义和读取结果", { timeout: 15_000 }, async t => {
  let entry: EntryId;
  const mock = new MockModelServer(request => request.messages.at(-1)?.role === "tool" ? { kind: "text", text: String(request.messages.at(-1)?.content) } : { kind: "tool_calls", calls: [{ id: "history-read-call", name: "history_read", arguments: { entry } }] });
  const provider = personalProvider({ api: "openai-completions", baseUrl: await mock.start(), modelId: "history-model", apiKeyEnv: "HISTORY_MODEL_TEST_KEY", contextWindow: 8192, maxTokens: 1024 }), previous = process.env.HISTORY_MODEL_TEST_KEY;
  process.env.HISTORY_MODEL_TEST_KEY = "test-only";
  const registry = createRegistry(), extension = personalHistory(); registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { registry, models: recordedModels(provider, async () => undefined) }, context);
  t.after(async () => { await harness.close(context); await mock.close(); if (previous === undefined) delete process.env.HISTORY_MODEL_TEST_KEY; else process.env.HISTORY_MODEL_TEST_KEY = previous; });
  const main = await harness.root(context, { agent: { model: { provider: provider.id, modelId: "history-model" }, extensions: [extension], tools: extension.tools } });
  entry = (await harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "待查原始历史", timestamp: 1 }] }), context)).id;
  harness.resume();
  const submission = await main.submit({ type: "input", content: "查阅原文", requestId: "history-model-read" }, context), settled = await submission.wait(context);
  assert.equal(settled.status, "done");
  assert.ok(settled.status === "done" && settled.type === "input");
  const answer = await harness.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
  assert.match(JSON.stringify(answer?.model), /待查原始历史/);
  assert.equal(mock.calls.length, 2); assert.match(JSON.stringify(mock.calls[0].tools), /history_search/);
  const entries = await main.entries({ order: "ascending" }, 256, undefined, context);
  assert.ok(entries.items.some(item => item.kind === "pi.system" && JSON.stringify(item.model).includes("history_read")));
  assert.ok(entries.items.some(item => item.kind === "pi.tool-result" && JSON.stringify(item.model).includes("待查原始历史")));
});
