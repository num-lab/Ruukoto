import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, CompactionEntry, ROOT_CONVERSATION_ID, type EntryId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { personalArtifactEntries } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalAgentsDoc } from "../apps/ruukoto/src/personal-work.ts";
import { changePersonalMemory, ownerPersonalMemory, PersonalMemoryDoc, preparePersonalMemory, readPersonalMemory, searchPersonalMemory, verifyPersonalMemorySelection } from "../apps/ruukoto/src/personal-memory.ts";
import { searchPersonalHistory } from "../apps/ruukoto/src/personal-history.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const code = (value: string) => (error: unknown) => error instanceof PersonalError && error.code === value;
async function fixture(t: TestContext, responder: Responder = () => ({ kind: "text", text: "已收到" })) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "ruukoto-memory-"))), server = new MockModelServer(responder);
  const config = { api: "openai-completions" as const, baseUrl: await server.start(), modelId: "memory-model", apiKeyEnv: "MEMORY_TEST_KEY", contextWindow: 128000, maxTokens: 1024 }, previous = process.env.MEMORY_TEST_KEY;
  process.env.MEMORY_TEST_KEY = "test-only";
  const options = { directory, provider: personalProvider(config), modelId: config.modelId };
  let personal: PersonalHarness;
  const open = async (overrides: Pick<Parameters<typeof openPersonalHarness>[0], "tools"> = {}) => personal = await openPersonalHarness({ ...options, ...overrides });
  t.after(async () => { await personal?.close(); await server.close(); if (previous === undefined) delete process.env.MEMORY_TEST_KEY; else process.env.MEMORY_TEST_KEY = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  await open();
  return { directory, server, options, open, get p() { return personal; }, owner: (operation = "owner-create", content = "喜欢简短中文答复") => personal.harness.commit(tx => ownerPersonalMemory(tx, directory, operation, "preference", content, "拥有者在本机确认的个人偏好"), context) };
}

test("记忆：版本冲突、同操作重放与撤销均持久，撤销不再查询或注入", async t => {
  const f = await fixture(t), created = await f.owner();
  assert.deepEqual(await f.owner(), created);
  await assert.rejects(f.owner("owner-create", "异文"), code("memory_request_conflict"));
  const revise = { action: "revise" as const, memory: created.memory, expectedVersion: 1, content: "偏好详细中文答复", sources: [{ kind: "owner" as const, note: "拥有者在本机修订" }] };
  const revised = await f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "revise", revise), context);
  assert.equal(revised.version, 2);
  assert.deepEqual(await f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "revise", revise), context), revised);
  await assert.rejects(f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "stale", revise), context), code("memory_conflict"));
  const selected = await f.p.harness.commit(tx => preparePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID), context);
  assert.match(selected.text, /详细中文/);
  const revoked = await f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "revoke", { action: "revoke", memory: created.memory, expectedVersion: 2 }), context);
  assert.equal(revoked.version, 3);
  assert.deepEqual((await f.p.harness.commit(tx => searchPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID), context)).items, []);
  assert.equal((await f.p.harness.commit(tx => preparePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID), context)).text, "");
  await assert.rejects(f.p.harness.commit(tx => readPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, created.memory), context), code("memory_revoked"));
  await assert.rejects(f.p.harness.commit(tx => verifyPersonalMemorySelection(tx, f.directory, ROOT_CONVERSATION_ID, selected.selected), context), code("memory_selection_changed"));
  await f.p.close(); await f.open();
  const saved = await f.p.harness.snapshot(PersonalMemoryDoc, String(created.memory), context);
  assert.equal(saved!.memory!.version, 3); assert.equal(saved!.memory!.revisions.length, 3);
});

test("记忆：来源缺失、类别及正文边界拒绝，不能凭模型伪造拥有者记录", async t => {
  const f = await fixture(t);
  await assert.rejects(f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "missing", { action: "create", category: "decision", content: "记忆", sources: [{ kind: "history", entry: 999 as EntryId }] }), context), code("history_reference_invalid"));
  await assert.rejects(f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "artifact", { action: "create", category: "experience", content: "记忆", sources: [{ kind: "artifact", artifact: "missing" }] }), context), code("memory_source_forbidden"));
  await assert.rejects(f.owner("empty", " "), code("memory_input_invalid"));
  await assert.rejects(f.owner("large", "字".repeat(12000)), code("memory_input_invalid"));
  assert.deepEqual((await f.p.harness.commit(tx => searchPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID), context)).items, []);
});

test("记忆：子身份复用只参考自身；主修订不能把父聊天注入子记忆", async t => {
  const f = await fixture(t);
  const child = await f.p.harness.commit(async tx => { const child = await tx.createConversation({ ownership: { kind: "ownerless" } }); const main = await tx.doc(AgentDoc, ROOT_CONVERSATION_ID); Object.assign(await tx.doc(AgentDoc, child.id), { ...main, extensions: ["personal-subagent", "personal-background-work", "personal-memory", "personal-history", "personal-skills", "personal-media"], tools: ["memory", "history_search", "history_read", "skill"] }); (await tx.doc(PersonalAgentsDoc)).agents.push({ id: child.id, label: "自身记忆", closed: false }); return child.id; }, context);
  const source = await f.p.harness.commit(tx => tx.appendEntry(child, { kind: "pi.user", model: [{ role: "user", content: "第一次工作确认的经验", timestamp: 1 }] }), context);
  const memory = await f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, child, "child-memory", { action: "create", category: "experience", content: "自身经验", sources: [{ kind: "history", entry: source.id }] }), context);
  const parent = await f.p.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "父聊天私有内容", timestamp: 2 }] }), context);
  await assert.rejects(f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "cross-source", { action: "revise", memory: memory.memory, expectedVersion: 1, content: "父聊天资料", sources: [{ kind: "history", entry: parent.id }] }), context), code("history_reference_invalid"));
  await assert.rejects(f.p.harness.commit(tx => searchPersonalMemory(tx, f.directory, child, "", 0, true), context), code("memory_forbidden"));
  await f.owner();
  const own = await f.p.harness.commit(tx => preparePersonalMemory(tx, f.directory, child), context);
  assert.match(own.text, /自身经验/); assert.doesNotMatch(own.text, /喜欢简短|父聊天/);
  await f.p.close(); await f.open();
  assert.equal((await f.p.harness.commit(tx => readPersonalMemory(tx, f.directory, child, memory.memory), context)).text, "自身经验");
});

test("记忆：模型实际保存后重启仍注入同版本，压缩保留原历史与来源", async t => {
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "save-memory", name: "memory", arguments: { action: "create", category: "preference", content: "偏好米色界面" } }] } : { kind: "text", text: "已保存" });
  await f.p.answer("请记住我偏好米色界面", "save-source");
  const memories = await f.p.harness.commit(tx => searchPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "米色"), context);
  assert.equal(memories.items.length, 1);
  await f.p.close(); await f.open();
  await f.p.answer("我的偏好是什么", "read-after-restart");
  assert.match(String(f.server.calls.at(-1)?.system), /偏好米色界面/);
  const evidence = (await f.p.main.entries({ order: "ascending" }, 256, undefined, context)).items.filter(entry => entry.kind === "ruukoto.model-request");
  assert.ok(evidence.some(entry => JSON.stringify(entry.data).includes(`"memory":${memories.items[0].memory}`)));
  const retained = await f.p.harness.commit(tx => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "pi.user", model: [{ role: "user", content: "最近消息", timestamp: 3 }] }), context);
  await f.p.harness.commit(tx => tx.appendEntry(CompactionEntry, ROOT_CONVERSATION_ID, { head: retained.id, model: [{ role: "user", content: "有损摘要", timestamp: 4 }], data: { reason: "manual" } }), context);
  assert.ok((await f.p.harness.commit(tx => searchPersonalHistory(tx, ROOT_CONVERSATION_ID, { query: "请记住我偏好" }), context)).items.length);
  await f.p.answer("压缩后继续", "after-compaction");
  assert.match(String(f.server.calls.at(-1)?.system), /偏好米色界面/);
});

test("记忆：引用entry被破坏时重启拒绝，provider未收到请求", async t => {
  const f = await fixture(t), memory = await f.owner();
  await f.p.harness.commit(async tx => { (await tx.doc(PersonalMemoryDoc, String(memory.memory), null)).memory!.revisions[0] = 999 as EntryId; }, context);
  await f.p.close(); await assert.rejects(f.open(), code("memory_record_invalid"));
  assert.equal(f.server.calls.length, 0);
});

test("记忆：带参考的两处证据提交失败均阻止实际provider请求", async t => {
  for (const failAt of [1, 2]) await t.test(String(failAt), async t => {
    const f = await fixture(t); await f.owner(); await f.p.close(); let count = 0;
    const personal = await openPersonalHarness({ ...f.options, openStorage: async filename => { const storage = await openNodeSqliteStorage(filename), commit = storage.commit.bind(storage); storage.commit = (writes, context) => writes.some(write => write.type === "entry" && write.value.kind === "ruukoto.model-request") && ++count === failAt ? Promise.reject(new Error("reference-evidence-failed")) : commit(writes, context); return storage; } });
    await assert.rejects(personal.answer("不要发送无证据请求", "failed-reference"));
    assert.equal((await personal.harness.closed).reason, "failed"); assert.equal(count, failAt); assert.equal(f.server.calls.length, 0);
    await personal.close();
  });
});

test("记忆：首次记录后撤销，在payload边界阻止HTTP且不沿旧选择继续", async t => {
  const f = await fixture(t), memory = await f.owner(); await f.p.close();
  const original = f.options.provider;
  f.options.provider = { ...original, streamSimple: (model, input, options) => original.streamSimple(model, input, { ...options, onPayload: async (payload, model) => {
    await f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "revoke-before-payload", { action: "revoke", memory: memory.memory, expectedVersion: 1 }), context);
    return options?.onPayload?.(payload, model);
  } }) };
  await f.open(); await assert.rejects(f.p.answer("撤销竞态", "revoke-race"), code("input_unanswered"));
  assert.equal(f.server.calls.length, 0);
});

test("记忆：运行中当前修订原证据丢失，不重启也必须阻断provider", async t => {
  const f = await fixture(t), memory = await f.owner();
  await f.p.harness.commit(async tx => { (await tx.doc(PersonalMemoryDoc, String(memory.memory), null)).memory!.revisions[0] = 999999 as EntryId; }, context);
  await assert.rejects(f.p.answer("不能使用无原证据记忆", "missing-online-revision"), code("input_unanswered"));
  assert.equal(f.server.calls.length, 0);
  await assert.rejects(f.p.harness.commit(tx => readPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, memory.memory), context), code("memory_record_invalid"));
  await assert.rejects(f.p.harness.commit(tx => searchPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "", 0, true), context), code("memory_record_invalid"));
});

test("个人参考：未知显式技能只阻断本轮，后续普通主聊天和重启可继续", async t => {
  const f = await fixture(t);
  await assert.rejects(f.p.answer("/skill:missing 参数", "unknown-skill"), code("input_unanswered"));
  assert.equal(f.server.calls.length, 0);
  assert.equal(await f.p.answer("普通后续聊天", "after-unknown-skill"), "已收到");
  await f.p.close(); await f.open();
  assert.equal(await f.p.answer("重启继续聊天", "after-unknown-restart"), "已收到");
  assert.equal(f.server.calls.length, 2);
});


test("记忆：来源产物丢失仍可从可信管理列表撤销，模型读取保持拒绝", async t => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-memory-source-"))); t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const filename = path.join(workspace, "reference.txt"); fs.writeFileSync(filename, "偏好来源原文");
  const f = await fixture(t, (_request, index) => index === 0 ? { kind: "tool_calls", calls: [{ id: "read-source", name: "read_file", arguments: { path: filename } }] } : { kind: "text", text: "已收到" });
  await f.p.close();
  const stat = fs.statSync(workspace);
  await f.open({ tools: parsePersonalTools({ version: 1, generation: "memory-source", workspace, identity: { dev: stat.dev, ino: stat.ino }, credentials: [] }) });
  await f.p.answer("读取偏好资料", "artifact-source");
  const artifact = await f.p.harness.commit(async tx => (await personalArtifactEntries(tx))[0].artifact.id, context);
  const memory = await f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "artifact-memory", { action: "create", category: "preference", content: "有资料来源的偏好", sources: [{ kind: "artifact", artifact }] }), context);
  fs.rmSync(path.join(f.directory, "artifacts", `${artifact}.bin`));
  for (const read of [() => f.p.harness.commit(tx => readPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, memory.memory), context), () => f.p.harness.commit(tx => searchPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID), context), () => f.p.harness.commit(tx => preparePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID), context)]) await assert.rejects(read(), code("artifact_unavailable"));
  const before = f.server.calls.length;
  await assert.rejects(f.p.answer("不能依赖缺失来源", "missing-artifact"), code("input_unanswered")); assert.equal(f.server.calls.length, before);
  const page = await f.p.harness.commit(tx => searchPersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "", 0, true), context); assert.equal(page.items[0].memory, memory.memory); assert.equal(page.items[0].sourceUnavailable, true);
  await f.p.harness.commit(tx => changePersonalMemory(tx, f.directory, ROOT_CONVERSATION_ID, "revoke-missing-artifact", { action: "revoke", memory: page.items[0].memory, expectedVersion: page.items[0].version }), context);
  assert.equal(await f.p.answer("不再依赖本条记忆", "after-revoke-missing"), "已收到"); assert.equal(f.server.calls.length, before + 1);
});
