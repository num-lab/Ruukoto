import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { toolDecide, toolOperations, type PersonalToolOperation } from "../apps/ruukoto/src/personal-tools.ts";
import { PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalDelegationDoc, listPersonalDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
const YIELD = { terminate: true } as const;
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < end, "等待交接验证超时"); await delay(5); } }

// 最小 pi 夹具：仅一个自定义扩展与工具，记录模型请求次数，直接驱动底层公共契约。
async function piFixture(t: TestContext, respond: Responder) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-handoff-pi-")));
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_HANDOFF_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const provider = personalProvider(config);
  const endRound = defineTool({ name: "end_round", description: "结束后返回终止标记。", parameters: Type.Object({}), replay: "safe", execute: async () => ({ output: [{ type: "text" as const, text: "ended" }], control: YIELD }) });
  const cutContext = defineTool({ name: "cut_context", description: "请求交接上下文。", parameters: Type.Object({}), replay: "safe", execute: async () => ({ output: [{ type: "text" as const, text: "cut" }], control: { handoff: "handoff context" } }) });
  const extension = defineExtension({ name: "gate-tools", tools: [endRound, cutContext] });
  const registry = createRegistry(); registry.install(extension);
  const models = createModels(); models.setProvider(provider);
  const storage = await openNodeSqliteStorage(path.join(directory, "pi.sqlite"));
  const harness = await Harness.open(storage, { models, registry }, context);
  const main = await harness.root(context, { agent: { model: { provider: provider.id, modelId: config.modelId }, thinkingLevel: "off", extensions: [extension], tools: [endRound, cutContext] } });
  t.after(async () => { await harness.close(context); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { server, harness, main };
}

test("交接门禁：单槽让出可结束输入，混合轮否决让出，handoff 是上下文重置而非让出", async t => {
  const calls = [{ id: "y", name: "end_round", arguments: {} }, { id: "ghost", name: "no_such_tool", arguments: {} }];
  const f = await piFixture(t, request => {
    const last = String(request.messages.at(-1)?.content);
    if (last === "mixed") return { kind: "tool_calls", calls };
    if (last === "handoff") return { kind: "tool_calls", calls: [{ id: "h", name: "cut_context", arguments: {} }] };
    if (last === "single") return { kind: "tool_calls", calls: [calls[0]] };
    return { kind: "text", text: `回复:${last}` };
  });
  // 单槽 control.terminate：运行直接结束且不再请求模型。
  const requests = f.server.calls.length;
  const single = await f.main.submit({ type: "input", content: "single", requestId: "single", whenBusy: "followUp" }, context);
  assert.equal((await single.wait(context)).status, "done");
  assert.equal(f.server.calls.length, requests + 1);
  const settled = await single.status(context);
  const entry = await f.main.commit(tx => tx.entry(AssistantEntry, settled.answer!), context);
  const message = entry?.model?.[0];
  assert.equal(message?.role, "assistant"); assert.equal(partsOf(message, "text").length, 0);
  assert.equal(partsOf(message, "toolCall").length, 1);
  // 混合轮：不可用槽位无 control，否决全票让出；运行继续并发出第二次模型请求。
  const mixed = await f.main.submit({ type: "input", content: "mixed", requestId: "mixed", whenBusy: "followUp" }, context);
  assert.equal((await mixed.wait(context)).status, "done");
  assert.ok(f.server.calls.length >= requests + 3);
  const mixedAnswer = (await mixed.status(context)).answer!;
  const mixedEntry = await f.main.commit(tx => tx.entry(AssistantEntry, mixedAnswer), context);
  assert.match(textOf(mixedEntry?.model?.[0]), /^回复:/);
  // control.handoff：写入 pi.reset 并裁剪上下文，不是普通让出。
  const handoff = await f.main.submit({ type: "input", content: "handoff", requestId: "handoff", whenBusy: "followUp" }, context);
  assert.equal((await handoff.wait(context)).status, "done");
  const entries = (await f.main.entries({ order: "ascending" }, 256, undefined, context)).items;
  assert.ok(entries.some(entry => entry.kind === "pi.reset"));
  const follow = await f.main.submit({ type: "input", content: "single", requestId: "after-handoff", whenBusy: "followUp" }, context);
  assert.equal((await follow.wait(context)).status, "done");
  const lastRequest = f.server.calls.at(-1)!;
  // 后续请求的上下文只剩交接上下文与新输入：原对话不在模型可见历史内。
  assert.deepEqual(lastRequest.messages.map(message => String(message.content)), ["handoff context", "single"]);
});

// Personal 夹具：完整宿主装配（含 background_work 与文件工具）。
async function fixture(t: TestContext, respond: Responder, tools = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-handoff-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_HANDOFF_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const identity = fs.statSync(workspace);
  const toolsConfig = tools ? parsePersonalTools({ version: 1, generation: "handoff-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] }) : undefined;
  const options = { directory, provider: personalProvider(config), modelId: config.modelId, tools: toolsConfig };
  let p: PersonalHarness;
  t.after(async () => { await p?.close(); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, workspace, outside, server, config, options, open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ ...options, ...overrides }) };
}
const workCall = (args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ id: `call-${args.action}`, name: "background_work", arguments: args }] });
const childRequest = (request: { system: string | null }) => request.system?.includes("你是个人助手的子 Agent");
const textOf = (message: { role: string; content: unknown } | undefined) => Array.isArray(message?.content) ? (message.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text ?? "").join("") : "";
const partsOf = (message: { role: string; content: unknown } | undefined, type: string) => Array.isArray(message?.content) ? (message.content as { type: string }[]).filter(part => part.type === type) : [];

test("交接门禁：委派自动登记汇总，显式汇总调用仍按原事实让出", async t => {
  let delegation!: number;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员分析完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (content.startsWith("宿主委托汇总参考")) return { kind: "text", text: "最终汇总正文" };
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "等待成员的分析", label: "分析员" });
    if (content === "封组") return workCall({ action: "report", delegation });
    return { kind: "text", text: `普通:${content}` };
  }, false);
  const p = await f.open();
  // The arrangement-only batch yields with persisted work and host reporting intent.
  assert.match(await p.answer("委派", "owner-a"), /让出/);
  delegation = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref.entryId;
  const registered = (await p.harness.snapshot(PersonalDelegationDoc, String(delegation), context))!.delegation!.report!;
  assert.equal(registered.version, 2);
  // Explicit registration reuses the automatic report and retains its actual handoff.
  const answer = await p.answer("封组", "owner-seal");
  assert.match(answer, /让出/); assert.match(answer, new RegExp(`委托 ${delegation} 的最终汇总安排`));
  const saved = (await p.harness.snapshot(PersonalDelegationDoc, String(delegation), context))!.delegation!;
  assert.ok(saved.report); assert.equal(saved.members.length, 1);
  assert.equal(saved.report.taskId, registered.taskId);
  // Later owner input remains independent of report generation.
  assert.equal(await p.answer("继续", "chat"), "普通:继续");
  await until(() => f.server.calls.some(request => String(request.messages.at(-1)?.content).startsWith("宿主委托汇总参考")));
  await until(async () => (await p.harness.snapshot(PersonalDelegationDoc, String(delegation), context))!.delegation!.report!.delivery === "local");
  assert.equal((await p.harness.snapshot(PersonalDelegationDoc, String(delegation), context))!.delegation!.report!.reply, "最终汇总正文");
});

test("交接门禁：混合轮否决让出仍登记封组，两个后续输入保持独立运行", async t => {
  let delegation = 0;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (content === "混合") return { kind: "tool_calls", calls: [{ id: "seal", name: "background_work", arguments: { action: "report", delegation } }, { id: "ghost", name: "no_such_tool", arguments: {} }] };
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "甲") return workCall({ action: "delegate", content: "独立分析" });
    if (content === "丙") return workCall({ action: "list" });
    return { kind: "text", text: `普通:${content}` };
  }, false);
  const p = await f.open();
  assert.match(await p.answer("甲", "owner-a"), /让出/);
  delegation = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref.entryId;
  // 混合轮：report 有终止标记但不可用槽位否决；运行继续，登记效果仍已提交。
  const answer = await p.answer("混合", "owner-mixed");
  assert.equal(answer.startsWith("回执:"), true);
  const groups = await p.harness.commit(tx => listPersonalDelegations(tx), context);
  assert.equal(groups.items.length, 1); assert.ok(groups.items[0].report);
  // 两个后续输入：不同 requestId 各自成为独立 run。
  const slow = await p.main.submit({ type: "input", content: "丙", requestId: "later-b", whenBusy: "followUp" }, context);
  const last = await p.main.submit({ type: "input", content: "丁", requestId: "later-c", whenBusy: "followUp" }, context);
  assert.notEqual((await slow.status(context)).id, (await last.status(context)).id);
  assert.equal((await slow.wait(context)).status, "done"); assert.equal((await last.wait(context)).status, "done");
  const slowId = (await slow.status(context)).answer!, lastId = (await last.status(context)).answer!;
  const slowAnswer = await p.main.commit(tx => tx.entry(AssistantEntry, slowId), context);
  const lastAnswer = await p.main.commit(tx => tx.entry(AssistantEntry, lastId), context);
  assert.match(textOf(slowAnswer?.model?.[0]), /agents/);
  assert.equal(textOf(lastAnswer?.model?.[0]), "普通:丁");
});

test("交接门禁：持有批准不吞权限，恢复后原操作可消费且后续输入继续", async t => {
  const f = await fixture(t, request => {
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "写入") return { kind: "tool_calls", calls: [{ id: "write", name: "write_file", arguments: { path: path.join(f.outside, "held"), content: "已写入" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  await p.harness.commit(async tx => { const doc = await tx.doc(PersonalPermissionsDoc); doc.mode = "confirm"; doc.version++; }, context);
  const target = path.join(f.outside, "held"); fs.writeFileSync(target, "旧内容");
  // 等待业务工具只在子工作执行：委派登记后子会话持有审批，主会话不被占用。
  await p.answer("准备", "owner-prep");
  const held = await p.work.delegate({ requestId: "child-write", sourceRequestId: "owner-prep", content: "写入" });
  await until(async () => (await p.harness.commit(tx => toolOperations(tx), context)).length > 0);
  const pending = await p.harness.commit(async tx => JSON.parse(JSON.stringify((await toolOperations(tx))[0])) as PersonalToolOperation, context);
  assert.equal(pending.approval, "pending");
  // 批准持有期间后续输入接纳为独立运行：子工作等待不占用主会话，追问先完成，批准后再核实写入。
  const follow = await p.main.submit({ type: "input", content: "追问", requestId: "follow-question", whenBusy: "followUp" }, context);
  assert.equal((await follow.status(context)).requestId, "follow-question");
  assert.equal((await follow.wait(context)).status, "done");
  await p.harness.commit(tx => toolDecide(tx, pending.operation, "approved", f.directory), context);
  await p.harness.waitForTask(held.taskId, context);
  assert.equal(fs.readFileSync(target, "utf8"), "已写入");
  const followId = (await follow.status(context)).answer!;
  const followAnswer = await p.main.commit(tx => tx.entry(AssistantEntry, followId), context);
  assert.equal(textOf(followAnswer?.model?.[0]), "普通:追问");
  assert.equal((await p.harness.commit(tx => toolOperations(tx), context)).length, 1);
});

test("交接门禁：让出后轮崩溃重开不重复登记、来源不失效，真未解释空文本不走识别", async t => {
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "崩溃前后分析" });
    if (content === "空") return { kind: "text", text: "" };
    return { kind: "text", text: `普通:${content}` };
  }, false);
  const p = await f.open();
  assert.match(await p.answer("委派", "owner-a"), /让出/);
  const registered = (await p.work.list())[0].work!;
  const requestId = await p.harness.commit(async tx => { const input = (await tx.task(registered.taskId as TaskId))?.input; return input && typeof input === "object" && !Array.isArray(input) ? String(input.requestId) : ""; }, context);
  assert.equal(requestId.startsWith("personal-tool:"), true);
  assert.equal((await p.work.list()).length, 1);
  // 真未解释空回答：模型文本为空且无让出事实，识别不声称为交接。
  assert.equal(await p.answer("空", "empty"), "");
  await p.close();
  const restored = await f.open();
  assert.equal((await restored.work.list()).length, 1);
  const source = await restored.harness.snapshot(PersonalWorkDoc, requestId, context);
  assert.ok(source); assert.equal(source.source!.requestId, "owner-a");
  assert.equal(await restored.answer("继续", "after"), "普通:继续");
});
