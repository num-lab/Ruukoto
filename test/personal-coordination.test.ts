import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID, type EntryRecord } from "@earendil-works/pi-durable";
import { openPersonalHarness, type PersonalHarness } from "../apps/ruukoto/src/personal-harness.ts";
import { personalProvider, type PersonalModelConfig } from "../apps/ruukoto/src/personal-model.ts";
import { parsePersonalTools, savePersonalTools } from "../apps/ruukoto/src/personal-tools-config.ts";
import { toolOperations } from "../apps/ruukoto/src/personal-tools.ts";
import { listPersonalWorks, PersonalWorkDoc } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalAnalysisAdmission, PersonalDelegationDoc, listPersonalDelegations } from "../apps/ruukoto/src/personal-delegation.ts";
import { personalReportResult } from "../apps/ruukoto/src/personal-report.ts";
import type { PersonalWorkRef } from "../apps/ruukoto/src/personal-work.ts";
import { PersonalCoordinationDoc, PERSONAL_COORDINATION_ENTRY, PERSONAL_MAIN_TOOL_ROUNDS, personalCoordinationCutoffText, type PersonalCoordinationCutoff } from "../apps/ruukoto/src/personal-coordination.ts";
import { PersonalError } from "../apps/ruukoto/src/personal-error.ts";
import { PersonalPermissionsDoc } from "../apps/ruukoto/src/personal-permissions.ts";
import { personalLocalInput } from "../apps/ruukoto/src/personal-local-records.ts";
import { personalControl, startPersonalServer } from "../apps/ruukoto/src/personal-control.ts";
import { savePersonalConfig } from "../apps/ruukoto/src/personal-config.ts";
import { PersonalMockModelServer as MockModelServer, type Responder } from "./helpers/mock-provider.ts";

const context = BACKGROUND_CONTEXT;
// 已移交子 Agent 的等待业务工具：主会话请求不再提供，仍发出的调用在执行边界拒绝。
const MIGRATED = ["read_file", "write_file", "http_request", "web_search", "read_artifact", "list_files", "search_files"];
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!await check()) { assert.ok(Date.now() < end, "等待协调核实超时"); await delay(5); } }

// Personal 夹具：完整宿主装配（含 background_work 与已移交的等待业务工具）。
async function fixture(t: TestContext, respond: Responder) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-coord-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), outside = path.join(root, "outside");
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  const server = new MockModelServer(respond);
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: await server.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_COORD_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const previous = process.env[config.apiKeyEnv]; process.env[config.apiKeyEnv] = "test-only";
  const identity = fs.statSync(workspace);
  const tools = parsePersonalTools({ version: 1, generation: "coord-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  const options = { directory, provider: personalProvider(config), modelId: config.modelId, tools };
  let p: PersonalHarness | undefined;
  t.after(async () => { await p?.close(); await server.close(); if (previous === undefined) delete process.env[config.apiKeyEnv]; else process.env[config.apiKeyEnv] = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, workspace, outside, server, config, options, open: async (overrides: Partial<Omit<Parameters<typeof openPersonalHarness>[0], "directory" | "profile">> = {}) => p = await openPersonalHarness({ ...options, ...overrides }) };
}

const workCall = (args: Record<string, unknown>) => ({ kind: "tool_calls" as const, calls: [{ id: `call-${String(args.action)}`, name: "background_work", arguments: args }] });
const childRequest = (request: { system: string | null }) => request.system?.includes("你是个人助手的子 Agent");
const toolNames = (request: { tools: Array<Record<string, unknown>> | undefined }) => (request.tools ?? []).map(tool => String((tool.function as { name?: string } | undefined)?.name ?? tool.name));
const isUser = (entry: EntryRecord) => (entry.model ?? []).some(message => message?.role === "user");
const isBatch = (entry: EntryRecord) => entry.kind === AssistantEntry.kind && (entry.model ?? []).some(message => message?.role === "assistant" && Array.isArray(message.content) && message.content.some(part => part?.type === "toolCall"));
async function entries(p: PersonalHarness) { return (await p.main.entries({ order: "ascending" }, 512, undefined, context)).items; }
async function markers(p: PersonalHarness) { return (await entries(p)).filter(entry => entry.kind === PERSONAL_COORDINATION_ENTRY); }

test("协调预算：主会话请求不携已移交工具，仍发出的等待调用在执行边界拒绝且不接纳", async t => {
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "分析", label: "分析员" });
    if (content === "读文件") return { kind: "tool_calls", calls: [{ id: "rf-1", name: "read_file", arguments: { path: "/nope" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  assert.match(await p.answer("委派", "owner-a"), /让出/);
  // 主会话仍把模型发出的 read_file 落成普通工具错误：不产生操作与效果，回执保留原拒绝事实。
  assert.match(await p.answer("读文件", "owner-read"), /personal_tool_main_ineligible/);
  assert.equal((await p.harness.commit(tx => toolOperations(tx), context)).length, 0);
  // 主请求从不提供迁移工具（含拒绝调用所在的请求）；子请求保留全部等待业务工具。
  const mains = f.server.calls.filter(request => !childRequest(request) && !request.system?.includes("审批审查员"));
  assert.ok(mains.length >= 2);
  for (const request of mains) {
    assert.match(request.system ?? "", /子 Agent 可用 read_file、write_file 直接读写文件，无需命令/);
    for (const name of toolNames(request)) assert.ok(!MIGRATED.includes(name), `主请求不应提供 ${name}`);
  }
  const children = f.server.calls.filter(childRequest);
  assert.ok(children.length > 0);
  for (const request of children) for (const name of MIGRATED) assert.ok(toolNames(request).includes(name), `子请求应保留 ${name}`);
});

test("协调预算：安排批回执不等子工作，等待期间主会话继续回答", async t => {
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await delay(400); return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "慢慢分析", label: "分析员" });
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  // 纯安排批按持久化事实让出：回答立即返回，不等仍在运行的子工作。
  assert.match(await p.answer("委派", "owner-a"), /让出/);
  const ref = (await p.work.list())[0].work!;
  const status = await p.work.status(ref);
  assert.notEqual(status.task.state.status, "terminal");
  // 子工作等待期间主会话不阻塞：独立输入立即完成。
  assert.equal(await p.answer("普通", "owner-b"), "普通:普通");
});

test("协调预算：含查询批不终止，模型正文按工具结果落地", async t => {
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    const results = request.messages.filter(message => message.role === "tool").length;
    if (content === "连续" || (last?.role === "tool" && results < 3)) return workCall({ action: "list" });
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  // 查询批不让出：每批工具结果回到模型，最终回答是模型正文而非交接事实。
  const answer = await p.answer("连续", "owner-list");
  assert.match(answer, /^回执:/);
  assert.ok(!answer.includes("让出"));
  const record = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-list"), context);
  const batches = (await entries(p)).filter(entry => entry.id > record!.entry! && isBatch(entry));
  assert.equal(batches.length, 3);
});

test("协调预算：第五批拒绝效果，只取消本输入工作并留下单次公开标记", { timeout: 30_000 }, async t => {
  let looping = false;
  // 子工作持有到登记核实之后：取消登记的成员数不依赖子任务自身终止时序。
  let releaseChildren!: () => void;
  const childrenHeld = new Promise<void>(resolve => { releaseChildren = resolve; });
  t.after(() => releaseChildren());
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await childrenHeld; return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    // 混合批让运行继续：每批一次委派加一次查询，第五批由宿主在空工具请求上发出仍被拒绝。
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `loop-d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `loop-q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    if (content === "委派") return workCall({ action: "delegate", content: "先验分析", label: "分析员" });
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  // 其他输入先登记的工作：超预算取消不得牵连。
  assert.match(await p.answer("委派", "owner-a"), /让出/);
  // 本机输入先经原接纳再提交，与真实入口一致；首轮拒绝码随切断提交时序不定。
  await p.harness.commit(tx => personalLocalInput(tx, "owner-loop", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-loop", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  const record = await owner.status(context);
  await until(async () => Array.isArray((await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))?.cutoff?.cancelled));
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))!.cutoff!;
  assert.equal(cutoff.version, 1);
  assert.equal(cutoff.submission, record.id);
  assert.equal(cutoff.targets.length, 4);
  // 空收件箱公开标记：model 为空，宿主提交内追加，切断、标记与队列推进全程不再向主会话发模型请求。
  const mains = () => f.server.calls.filter(request => !childRequest(request) && !request.system?.includes("审批审查员") && String(request.messages.findLast(message => message.role === "user")?.content).includes("\n循环\n")).length;
  const baseline = mains();
  await until(async () => (await markers(p)).length === 1);
  const marker = (await markers(p))[0];
  assert.deepEqual(marker.model, []);
  assert.equal((await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))!.cutoff!.marker, marker.id);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(mains(), baseline);
  const data = marker.data as { submission: unknown; requestId: unknown; targets: unknown };
  assert.equal(data.requestId, "owner-loop");
  assert.equal(data.submission, record.id);
  assert.deepEqual(new Set(data.targets as number[]), new Set(cutoff.targets.map(ref => ref.taskId)));
  // 精确目标：本输入接纳的四项工作登记取消，先验工作保持原状；第五批委派未生效，工作总数不变。
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  assert.equal(works.length, 5);
  // 取消标记与登记清单一一对应：已登记者才被标记，终态跳过不计入也不标记。
  assert.equal(cutoff.cancelled!.length, 4);
  for (const item of works) assert.equal(item.cancelRequested, cutoff.cancelled!.some(ref => ref.taskId === item.ref.taskId));
  // 五个持久化批次：前四批执行；第五批拒绝效果——不再新增接纳证据，落成的工具结果一律为拒绝事实。
  const all = await entries(p);
  const own = all.filter(entry => entry.id > record!.entry!);
  const batches = own.filter(entry => isBatch(entry) && !isUser(entry));
  assert.equal(batches.length, 5);
  const lastBatch = batches.at(-1)!;
  assert.ok(!own.some(entry => entry.id > lastBatch.id && entry.kind === PersonalAnalysisAdmission.kind));
  for (const entry of own) if (entry.id > lastBatch.id) for (const message of entry.model ?? []) if (message?.role === "toolResult") assert.equal(message.isError, true);
  // 已登记目标逐项核实：取消登记只计非终态成员，终态目标留原状不计入。
  for (const ref of cutoff.cancelled!) assert.ok(cutoff.targets.some(target => target.taskId === ref.taskId));
  // 同请求重试不重复协调：切断回答以持久化事实为准。
  await assert.rejects(p.answer("循环", "owner-loop"), error => error instanceof PersonalError && error.code === "input_coordination_cutoff" && /已登记 \d+ 项工作/.test(error.message));
});

test("协调预算：切断中止让位于排队输入，新输入窗口独立计数", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await delay(400); return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `loop-d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `loop-q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  await p.harness.commit(tx => personalLocalInput(tx, "owner-loop", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-loop", whenBusy: "followUp" }, context);
  await until(async () => (await p.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run !== undefined);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next", "继续"), context);
  const follow = await p.main.submit({ type: "input", content: "继续", requestId: "owner-next", whenBusy: "followUp" }, context);
  assert.equal((await follow.status(context)).status, "queued");
  assert.equal((await owner.wait(context)).status, "unanswered");
  // 排队输入在切断后独立成运：自身窗口从零计批，回答为模型正文。
  assert.equal((await follow.wait(context)).status, "done");
  assert.equal((await follow.status(context)).requestId, "owner-next");
  const request = f.server.calls.find(call => String(call.messages.at(-1)?.content).includes("继续"));
  assert.ok(request !== undefined && toolNames(request).includes("background_work"));
  await until(async () => Array.isArray((await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))?.cutoff?.cancelled));
  await until(async () => (await markers(p)).length === 1);
});

test("协调预算：切断重开后标记仍唯一、取消不重复，后续输入沿用正常协调", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await delay(400); return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `loop-d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `loop-q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    return { kind: "text", text: `普通:${content}` };
  });
  let p = await f.open();
  await p.harness.commit(tx => personalLocalInput(tx, "owner-loop", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-loop", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(async () => (await markers(p)).length === 1);
  const targets = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))!.cutoff!.targets.map(ref => ref.taskId);
  await p.close();
  // 重开恢复扫描未决输入：既有成员记录直接返回，取消与标记都不重演。
  p = await f.open();
  await delay(100);
  assert.equal((await markers(p)).length, 1);
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))!.cutoff!;
  assert.ok(Array.isArray(cutoff.cancelled));
  // 同一输入的完成提交重演由持久 marker 成员拦截：追加不会二次落成。
  assert.equal(cutoff.marker, (await markers(p))[0].id);
  assert.deepEqual(cutoff.targets.map(ref => ref.taskId), targets);
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  assert.equal(works.length, 4);
  // Exact-work cancellation: every admitted work either carried the cancel request or had already
  // terminated before it landed — nothing may escape both paths under load.
  for (const item of works) {
    const task = await p.harness.getTask(item.ref.taskId, context);
    assert.ok(item.cancelRequested || task?.state.status === "terminal");
  }
  // 后续输入新窗口：正常协调资格与模型回答不受影响。
  assert.equal(await p.answer("普通", "owner-after"), "普通:普通");
});

test("协调预算：安排批内被拒调用以未生效事实交接，不伪造登记或模型答案", async t => {
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "混合安排") return { kind: "tool_calls" as const, calls: [{ id: "ok", name: "background_work", arguments: { action: "delegate", content: "可接纳成员" } }, { id: "bad", name: "background_work", arguments: { action: "append", work: 99999, content: "说明" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  const answer = await p.answer("混合安排", "owner-mixed");
  // 已登记成员给出原事实，被拒调用给出未生效事实与原错误文本；两者都不伪装成模型答案。
  assert.match(answer, /让出/); assert.match(answer, /"state":"registered"/);
  assert.match(answer, /未生效/); assert.match(answer, /work_missing|work_inactive|work_input_invalid/);
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  assert.equal(works.length, 1); assert.equal(works[0].cancelRequested, false);
});

test("协调预算：压缩摘要不重置输入窗口，越预算后压缩前后登记的工作全被精确取消", { timeout: 30_000 }, async t => {
  let looping = false, gate!: () => void;
  const held = new Promise<void>(resolve => { gate = resolve; });
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await delay(400); return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    // 压缩摘要也以 user 角色入史：只对真拥有者输入翻转，不受宿主写入消息影响。
    if (last?.role === "user" && content === "循环") looping = true;
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) {
      if (results === 4) await held;
      return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `压缩循环-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    }
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  await p.harness.commit(tx => personalLocalInput(tx, "owner-compact", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-compact", whenBusy: "followUp" }, context);
  await until(async () => (await entries(p)).filter(isBatch).length === 2);
  // 运行中落一条压缩摘要：它是宿主写入不是新输入，原输入窗口与尾部预算继续累计。
  await p.main.submit({ type: "write", requestId: "compact-sim", entry: { kind: CompactionEntry.kind, model: [{ role: "user", content: [{ type: "text", text: "摘要" }], timestamp: Date.now() }] } }, context);
  gate();
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(async () => (await markers(p)).length === 1);
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-compact", context))!.cutoff!;
  assert.equal(cutoff.targets.length, 4);
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  assert.equal(works.length, 4);
  for (const item of works) {
    const task = await p.harness.getTask(item.ref.taskId, context);
    assert.ok(item.cancelRequested || task?.state.status === "terminal");
  }
});

test("协调预算：第四批内如实文本回答正常完成，不产生切断或标记", async t => {
  let sawEmptyOffer = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user" && content === "四轮") return { kind: "tool_calls" as const, calls: [{ id: "w-0", name: "background_work", arguments: { action: "list" } }] };
    // 每个含查询的批继续：前三轮各补一次查询，第四轮后工具为空只能文本回答。
    if (last?.role === "tool") { if (!request.tools?.length) sawEmptyOffer = true; return request.tools?.length ? { kind: "tool_calls" as const, calls: [{ id: `w-${request.messages.length}`, name: "background_work", arguments: { action: "list" } }] } : { kind: "text", text: "四轮后如实回答" }; }
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  const answer = await p.answer("四轮", "owner-four");
  assert.equal(answer, "四轮后如实回答");
  assert.equal(sawEmptyOffer, true);
  const all = await entries(p);
  assert.equal(all.filter(entry => isBatch(entry) && !isUser(entry)).length, 4);
  assert.equal((await p.harness.snapshot(PersonalCoordinationDoc, "owner-four", context))?.cutoff, undefined);
  assert.equal((await markers(p)).length, 0);
});

test("Coordination: the no-tools final response cannot complete with empty text", async t => {
  const f = await fixture(t, request => request.tools?.length ? workCall({ action: "list" }) : { kind: "text", text: "" });
  const p = await f.open();
  await assert.rejects(p.answer("Query until the final answer", "empty-final"), error => error instanceof PersonalError && error.code === "answer_missing");
  assert.equal(f.server.calls.length, PERSONAL_MAIN_TOOL_ROUNDS + 1);
  assert.deepEqual(toolNames(f.server.calls.at(-1)!), []);
  assert.equal((await entries(p)).filter(isBatch).length, PERSONAL_MAIN_TOOL_ROUNDS);
  assert.equal((await markers(p)).length, 0);
});

test("Coordination: entirely unavailable and invalid batches exhaust the same budget without effects", async t => {
  for (const invalid of [false, true]) await t.test(invalid ? "invalid arguments" : "unavailable tool", async t => {
    const f = await fixture(t, request => ({ kind: "tool_calls", calls: [{ id: `invalid-${request.messages.length}`, name: invalid ? "background_work" : "unavailable_wait", arguments: invalid ? { action: "invalid_action" } : {} }] }));
    const p = await f.open();
    await assert.rejects(p.answer("Unusable calls", "invalid-budget"), error => error instanceof PersonalError && error.code === "input_coordination_cutoff");
    await until(async () => (await markers(p)).length === 1);
    assert.equal((await entries(p)).filter(isBatch).length, PERSONAL_MAIN_TOOL_ROUNDS + 1);
    assert.deepEqual(toolNames(f.server.calls.at(-1)!), []);
    const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "invalid-budget", context))!.cutoff!;
    assert.deepEqual(cutoff.targets, []); assert.deepEqual(cutoff.cancelled, []);
    assert.equal((await p.harness.commit(tx => toolOperations(tx), context)).length, 0);
    assert.equal((await p.work.list()).length, 0);
    await p.close(); const restored = await f.open();
    await assert.rejects(restored.answer("Unusable calls", "invalid-budget"), error => error instanceof PersonalError && error.code === "input_coordination_cutoff");
    assert.equal((await markers(restored)).length, 1);
    assert.equal(f.server.calls.length, PERSONAL_MAIN_TOOL_ROUNDS + 1);
  });
});

test("Coordination: an appended failed input grants no child effect before cancellation registration", { timeout: 30_000 }, async t => {
  let work!: PersonalWorkRef, childRequests = 0, mainRounds = 0, completionReached = false;
  let releaseChild!: () => void, releaseCompletion!: () => void;
  const childHeld = new Promise<void>(resolve => { releaseChild = resolve; });
  const completionHeld = new Promise<void>(resolve => { releaseCompletion = resolve; });
  t.after(() => { releaseChild(); releaseCompletion(); });
  const f = await fixture(t, async request => {
    if (childRequest(request)) {
      if (++childRequests === 1) { await childHeld; return { kind: "text", text: "Original answer" }; }
      if (request.messages.at(-1)?.role === "tool") return { kind: "text", text: "The late write completed" };
      return { kind: "tool_calls", calls: [{ id: "failed-note-write", name: "write_file", arguments: { path: target, content: "FORBIDDEN_WRITE" } }] };
    }
    const content = request.messages.findLast(message => message.role === "user")?.content;
    if (content === "append-then-overrun") {
      mainRounds++;
      return { kind: "tool_calls", calls: [...(mainRounds === 1 ? [{ id: "accepted-append", name: "background_work", arguments: { action: "append", work: work.taskId, content: "Write the changed requirements" } }] : []), { id: `query-${mainRounds}`, name: "background_work", arguments: { action: "list" } }] };
    }
    if (content === "delegate-original") return workCall({ action: "delegate", content: "Wait for amended requirements", label: "Original child" });
    return { kind: "text", text: "Normal answer" };
  });
  const target = path.join(f.workspace, "failed-source.txt"); fs.writeFileSync(target, "UNCHANGED");
  const p = await f.open({ coordinationProbe: async (record, stage) => { if (record.requestId === "failed-note-source" && stage === "before-completion") { completionReached = true; await completionHeld; } } });
  await p.harness.commit(async tx => { const permissions = await tx.doc(PersonalPermissionsDoc); permissions.mode = "full_access"; permissions.version++; }, context);
  await p.answer("delegate-original", "healthy-source");
  work = (await p.work.list())[0].work!; await until(() => childRequests === 1);
  const offender = await p.submit("append-then-overrun", "failed-note-source");
  assert.equal((await offender.wait(context)).status, "unanswered");
  await until(() => completionReached);
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "failed-note-source", context))!.cutoff!;
  assert.deepEqual(cutoff.targets, [work]); assert.equal(cutoff.cancelled, undefined);
  assert.equal((await p.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.cancelRequested, false);
  releaseChild();
  await p.harness.waitForTask(work.taskId, context);
  assert.equal(childRequests, 1, "An unanswered appended source cannot start another child model request.");
  assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED");
  assert.equal((await p.harness.commit(tx => toolOperations(tx), context)).length, 0);
  releaseCompletion(); await until(async () => (await markers(p)).length === 1);
  await p.close(); const restored = await f.open();
  assert.equal(fs.readFileSync(target, "utf8"), "UNCHANGED"); assert.equal(childRequests, 1);
  assert.equal((await restored.harness.snapshot(PersonalWorkDoc, work.requestId, context))!.notes!.length, 1);
});

test("协调预算：取消登记回执区分意图与完成，终态目标不计入", () => {
  const ref = { requestId: "w", taskId: 7, agentId: 9 } as PersonalWorkRef;
  const intent: PersonalCoordinationCutoff = { version: 1, submission: 1 as PersonalCoordinationCutoff["submission"], targets: [ref] };
  assert.match(personalCoordinationCutoffText(intent), /取消登记尚未完成/);
  const terminal = personalCoordinationCutoffText({ ...intent, cancelled: [] });
  assert.match(terminal, /没有新增取消登记/); assert.match(terminal, /已完成的结果与效果保留/); assert.ok(!terminal.includes("重新提交"));
  assert.match(personalCoordinationCutoffText({ ...intent, cancelled: [ref] }), /已登记 1 项工作的取消请求/);
});

test("协调预算：评估读数期间落达的事件不丢弃，超预算输入仍被切断", { timeout: 30_000 }, async t => {
  let looping = false, released = false, probed4 = false, gate!: () => void;
  const held = new Promise<void>(resolve => { gate = resolve; });
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    // 空工具请求上仍发调用：第五批落成后被拒，第六次请求准备即越界。
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  // 评估读到第四批时挂起：批次五落成与输入终结的事件都落在 pending 期间，必须合并成重查而非丢弃。
  const p = await f.open({ coordinationProbe: async (_record, stage, rounds) => { if (stage === "rounds" && rounds === PERSONAL_MAIN_TOOL_ROUNDS && !released) { probed4 = true; await held; } } });
  await p.harness.commit(tx => personalLocalInput(tx, "owner-drop", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-drop", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  assert.equal(probed4, true);
  released = true; gate();
  await until(async () => Array.isArray((await p.harness.snapshot(PersonalCoordinationDoc, "owner-drop", context))?.cutoff?.cancelled));
  await until(async () => (await markers(p)).length === 1);
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  assert.ok(works.length > 0);
  // 终态目标跳过登记：每项工作要么携带取消请求，要么在登记前已终结。
  for (const item of works) {
    const task = await p.harness.getTask(item.ref.taskId, context);
    assert.ok(item.cancelRequested || task?.state.status === "terminal");
  }
});

test("协调预算：完成提交失败由宿主有界重试，取消与标记仍一次落成", { timeout: 30_000 }, async t => {
  let looping = false, failed = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  // 第一次完成提交在持久化边界前注入失败：重试后取消登记与公开标记仍各落一次。
  const p = await f.open({ coordinationProbe: async (record, stage) => {
    if (record.requestId === "owner-marker" && stage === "before-completion" && !failed) { failed = true; throw new PersonalError("coordination_probe", "注入的完成提交失败"); }
  } });
  await p.harness.commit(tx => personalLocalInput(tx, "owner-marker", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-marker", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(async () => (await markers(p)).length === 1);
  assert.equal(failed, true);
  await until(async () => Array.isArray((await p.harness.snapshot(PersonalCoordinationDoc, "owner-marker", context))?.cutoff?.cancelled));
  await assert.rejects(p.answer("循环", "owner-marker"), error => error instanceof PersonalError && error.code === "input_coordination_cutoff");
});

test("协调预算：取消回答不等物理停止，登记意图即如实回执", { timeout: 30_000 }, async t => {
  let workId = 0, gate!: () => void;
  const held = new Promise<void>(resolve => { gate = resolve; });
  const f = await fixture(t, async request => {
    // 子会话模型请求挂起：工作的物理停止无法核实，取消输入仍须按已登记事实回执。
    if (childRequest(request)) { await held; return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "待取消分析", label: "分析员" });
    if (content === "取消") return workCall({ action: "cancel", work: workId });
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  assert.match(await p.answer("委派", "owner-del"), /让出/);
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  assert.equal(works.length, 1);
  workId = works[0].ref.taskId;
  const answer = await p.answer("取消", "owner-cancel");
  assert.match(answer, /已登记工作 \d+ 的取消，停止与效果以原记录为准/);
  // 子请求仍挂起时回答已落：登记意图是持久事实，物理停止未核实前不假装完成。
  const item = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items[0];
  assert.equal(item.cancelRequested, true);
  gate();
});

test("协调预算：完成后的追加显式关联同一身份的新工作，原结果保留", async t => {
  let workId: PersonalWorkRef["taskId"] = 0 as PersonalWorkRef["taskId"];
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "短分析", label: "分析员" });
    if (content === "补说明") return workCall({ action: "append", work: workId, content: "迟到说明" });
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  assert.match(await p.answer("委派", "owner-del"), /让出/);
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  assert.equal(works.length, 1);
  workId = works[0].ref.taskId;
  await until(async () => (await p.harness.getTask(workId, context))?.state.status === "terminal");
  const original = await p.harness.getTask(workId, context);
  const answer = await p.answer("补说明", "owner-note");
  assert.match(answer, /原工作.*结果保留.*后续工作/);
  assert.doesNotMatch(answer, /未接纳/);
  const continued = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items.find(item => item.ref.taskId !== workId)!;
  assert.equal(continued.ref.agentId, works[0].ref.agentId);
  const record = await p.harness.snapshot(PersonalWorkDoc, continued.ref.requestId, context);
  assert.deepEqual(record?.continuation?.predecessor, works[0].ref);
  assert.deepEqual(await p.harness.getTask(workId, context), original);
  await p.harness.waitForTask(continued.ref.taskId, context);
  await p.close(); await f.open();
});

test("协调预算：完成后的续接越界只取消新工作，不取消原结果", { timeout: 30_000 }, async t => {
  let predecessor: PersonalWorkRef | undefined, looping = false, round = 0;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, async request => {
    if (childRequest(request)) {
      if (String(request.messages.findLast(message => message.role === "user")?.content) === "续接要求") await held;
      return { kind: "text", text: "成员完成" };
    }
    if (String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考")) return { kind: "text", text: "原要求已完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") { looping = content === "循环续接"; round = 0; }
    if (looping) {
      round++;
      return { kind: "tool_calls", calls: [
        ...(round === 1 ? [{ id: "continue", name: "background_work", arguments: { action: "append", work: predecessor!.taskId, content: "续接要求" } }] : []),
        { id: `query-${round}`, name: "background_work", arguments: { action: "list" } },
      ] };
    }
    if (content === "委派") return workCall({ action: "delegate", content: "原要求" });
    return { kind: "text", text: "普通回答" };
  });
  const p = await f.open(); await p.answer("委派", "original");
  predecessor = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items[0].ref;
  await p.harness.waitForTask(predecessor.taskId, context);
  const original = await p.harness.getTask(predecessor.taskId, context);
  const loopingInput = await p.submit("循环续接", "continuation-cutoff");
  assert.equal((await loopingInput.wait(context)).status, "unanswered");
  await until(async () => (await p.harness.snapshot(PersonalCoordinationDoc, "continuation-cutoff", context))?.cutoff?.cancelled !== undefined);
  await assert.rejects(p.answer("循环续接", "continuation-cutoff"), error => error instanceof PersonalError && error.code === "input_coordination_cutoff");
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "continuation-cutoff", context))!.cutoff!;
  const continued = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items.find(item => item.ref.taskId !== predecessor!.taskId)!;
  assert.deepEqual(cutoff.targets, [continued.ref]);
  assert.deepEqual(await p.harness.getTask(predecessor.taskId, context), original);
  assert.equal(continued.cancelRequested, true);
  release();
});

test("协调预算：越预算输入的追加归属也被精确取消，旁路与被拒追加不牵连", { timeout: 30_000 }, async t => {
  let looping = false, appended = false, oldWork: PersonalWorkRef["taskId"] = 0 as PersonalWorkRef["taskId"], sibling: PersonalWorkRef["taskId"] = 0 as PersonalWorkRef["taskId"];
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await delay(1500); return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) {
      // 第一个循环批带一条对旧工作的成功追加和一条被拒追加：只有成功接纳的才进入目标。
      const calls: { id: string; name: string; arguments: Record<string, unknown> }[] = [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }];
      if (!appended) { appended = true; calls.push({ id: "a-old", name: "background_work", arguments: { action: "append", work: oldWork, content: "越预算追加" } }); calls.push({ id: "a-bad", name: "background_work", arguments: { action: "append", work: 99999, content: "被拒追加" } }); }
      return { kind: "tool_calls" as const, calls };
    }
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "慢分析", label: "分析员" });
    if (content === "旁路") return workCall({ action: "delegate", content: "旁路分析", label: "分析员" });
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  // 旧工作与旁路工作分属其他输入：追加归属使旧工作成为目标，旁路保持原状。
  assert.match(await p.answer("委派", "owner-a"), /让出/);
  oldWork = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items[0].ref.taskId;
  assert.match(await p.answer("旁路", "owner-b"), /让出/);
  sibling = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items.find(item => item.ref.taskId !== oldWork)!.ref.taskId;
  await p.harness.commit(tx => personalLocalInput(tx, "owner-note", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-note", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(async () => Array.isArray((await p.harness.snapshot(PersonalCoordinationDoc, "owner-note", context))?.cutoff?.cancelled));
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-note", context))!.cutoff!;
  // 目标 = 本输入委派的成员 + 本输入成功追加的旧工作；被拒追加无接纳记录，旁路工作无归属。
  assert.ok(cutoff.targets.some(ref => ref.taskId === oldWork));
  assert.ok(!cutoff.targets.some(ref => ref.taskId === sibling));
  assert.ok(!cutoff.targets.some(ref => ref.taskId === 99999));
  const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
  // 登记清单一一对应标记：已登记者才被标记；终态跳过不计入也不标记。
  for (const item of works) assert.equal(item.cancelRequested, cutoff.cancelled!.some(ref => ref.taskId === item.ref.taskId));
});

test("协调预算：评估跨越换代不中止后序输入，双排队照常完成且物理停止不冒充已核实", { timeout: 30_000 }, async t => {
  let looping = false, released = false, gate!: () => void, releaseChildren!: () => void;
  const held = new Promise<void>(resolve => { gate = resolve; });
  const childrenHeld = new Promise<void>(resolve => { releaseChildren = resolve; });
  t.after(() => { released = true; gate(); releaseChildren(); });
  const f = await fixture(t, async request => {
    if (childRequest(request)) { await childrenHeld; return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content.includes("循环");
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  let completionReached = false;
  // 探针把评估停在完成提交之前：意图已持久、取消登记尚未落盘——这正是"先登记后推进"的检验窗口。
  const p = await f.open({ coordinationProbe: async (record, stage) => { if (record.requestId === "owner-roll" && stage === "before-completion" && !released) { completionReached = true; await held; } } });
  const aborted: number[] = [];
  const abortTask = p.harness.abortTask.bind(p.harness);
  p.harness.abortTask = (id, callContext) => { aborted.push(id); return abortTask(id, callContext); };
  await p.harness.commit(tx => personalLocalInput(tx, "owner-roll", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-roll", whenBusy: "followUp" }, context);
  // 两条后续输入在越预算运行仍存活时入队：取消登记发生时它们已经排队，不得被中止。
  await until(async () => (await owner.status(context)).status === "placed");
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next-a", "继续一"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next-b", "继续二"), context);
  const nextA = await p.main.submit({ type: "input", content: "继续一", requestId: "owner-next-a", whenBusy: "followUp" }, context);
  const nextB = await p.main.submit({ type: "input", content: "继续二", requestId: "owner-next-b", whenBusy: "followUp" }, context);
  assert.equal((await nextA.status(context)).status, "queued");
  assert.equal((await nextB.status(context)).status, "queued");
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(() => completionReached);
  // 取消登记未落盘期间队列不得前进：后序输入保持 queued，意图的 cancelled 成员仍缺席。
  await delay(300);
  assert.equal((await nextA.status(context)).status, "queued");
  assert.equal((await nextB.status(context)).status, "queued");
  assert.equal((await p.harness.snapshot(PersonalCoordinationDoc, "owner-roll", context))!.cutoff!.cancelled, undefined);
  released = true; gate();
  // 登记落盘后队列才推进：后序输入脱离 queued 时，cancelled 与公开标记必然已经持久。
  await until(async () => (await markers(p)).length === 1);
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-roll", context))!.cutoff!;
  assert.ok(Array.isArray(cutoff.cancelled));
  await until(async () => (await nextA.status(context)).status !== "queued");
  assert.ok(Array.isArray((await p.harness.snapshot(PersonalCoordinationDoc, "owner-roll", context))!.cutoff!.cancelled));
  assert.equal((await nextA.wait(context)).status, "done");
  assert.equal((await nextB.wait(context)).status, "done");
  releaseChildren();
  assert.equal(cutoff.cancelled!.length, 4);
  // 宿主只碰本输入登记的工作：后序输入的运行代次绝不在中止目标内。
  for (const id of aborted) assert.ok(cutoff.targets.some(ref => ref.taskId === id), `中止越界:${id}`);
  // 登记完成不等于物理停止已核实：回执文本只说登记事实。
  assert.match(personalCoordinationCutoffText(cutoff), /已登记 4 项工作的取消请求/);
});

test("协调预算：真实强杀落在意图与完成之间，重开补接取消登记与标记各一次", { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rk-coord-kill-"))), directory = path.join(root, "profile"), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const url = (relative: string) => new URL(relative, import.meta.url).href;
  // 子进程持独立模型与完整宿主：探针把评估停在意图已落盘、完成提交未发生的持久化边界上，
  // SIGKILL 在此窗口真实中断——不是切断完成后的事后重开证据。
  const script = `
    import * as fs from "node:fs";
    import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
    import { openPersonalHarness } from ${JSON.stringify(url("../apps/ruukoto/src/personal-harness.ts"))};
    import { personalProvider } from ${JSON.stringify(url("../apps/ruukoto/src/personal-model.ts"))};
    import { parsePersonalTools } from ${JSON.stringify(url("../apps/ruukoto/src/personal-tools-config.ts"))};
    import { personalLocalInput } from ${JSON.stringify(url("../apps/ruukoto/src/personal-local-records.ts"))};
    import { PersonalMockModelServer } from ${JSON.stringify(url("./helpers/mock-provider.ts"))};
    const context = BACKGROUND_CONTEXT, directory = ${JSON.stringify(directory)}, workspace = ${JSON.stringify(workspace)};
    let looping = false;
    const model = new PersonalMockModelServer(request => {
      // 子请求永不返回：目标工作保持活动，取消登记窗口不能退化成终态跳过。
      if (request.system?.includes("你是个人助手的子 Agent")) return new Promise(() => {});
      const last = request.messages.at(-1), content = String(last?.content);
      if (last?.role === "user") looping = content.includes("循环");
      const results = request.messages.filter(message => message.role === "tool").length;
      if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls", calls: [{ id: "d-" + results, name: "background_work", arguments: { action: "delegate", content: "循环-" + results, label: "分析员" } }, { id: "q-" + results, name: "background_work", arguments: { action: "list" } }] };
      return { kind: "text", text: "普通" };
    });
    const identity = fs.statSync(workspace);
    const tools = parsePersonalTools({ version: 1, generation: "kill-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
    const p = await openPersonalHarness({ directory, provider: personalProvider({ api: "openai-completions", baseUrl: await model.start(), modelId: "mock-model", apiKeyEnv: "RUUKOTO_KILL_MODEL_KEY", contextWindow: 128000, maxTokens: 8192 }), modelId: "mock-model", tools, coordinationProbe: async (record, stage) => {
      // 停在完成提交之前：意图已在盘上，cancelled 与 marker 必然缺席，随后被杀。
      if (record.requestId === "owner-kill" && stage === "before-completion") { console.log("held"); await new Promise(() => {}); }
    } });
    await p.harness.commit(tx => personalLocalInput(tx, "owner-kill", "循环"), context);
    const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-kill", whenBusy: "followUp" }, context);
    owner.wait(context).catch(() => {});
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, RUUKOTO_KILL_MODEL_KEY: "kill-only" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { errors += String(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 45000;
  while (!output.includes("held") && child.exitCode === null) { assert.ok(Date.now() < deadline, `子进程未到达完成前边界：${errors.slice(-2000)}`); await delay(20); }
  assert.ok(output.includes("held"), `子进程未停在持久化边界上：${errors.slice(-2000)}`);
  child.kill("SIGKILL");
  await once(child, "exit");
  // 进程尸体上的重开：先核实强杀前的未竟状态——意图在、取消登记与公开标记都缺席；
  // 再由清扫补接：意图不重放，取消登记与公开标记各补一次。
  const f = await fixture(t, () => ({ kind: "text", text: "固定回答" }));
  const identity = fs.statSync(workspace);
  const tools = parsePersonalTools({ version: 1, generation: "kill-test", workspace, identity: { dev: identity.dev, ino: identity.ino }, credentials: [] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let heldAtBoundary = false;
  const p = await openPersonalHarness({ directory, provider: f.options.provider, modelId: f.options.modelId, tools, coordinationProbe: async (record, stage) => {
    if (record.requestId === "owner-kill" && stage === "before-completion" && !heldAtBoundary) { heldAtBoundary = true; await gate; }
  } });
  try {
    // 强杀现场：意图持久存在，完成提交的原子成员（cancelled、marker）一并缺席。
    await until(() => heldAtBoundary);
    const intent = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-kill", context))!.cutoff!;
    assert.equal(intent.cancelled, undefined);
    assert.equal(intent.marker, undefined);
    assert.equal((await markers(p)).length, 0);
    release();
    await until(async () => (await markers(p)).length === 1);
    await until(async () => Array.isArray((await p.harness.snapshot(PersonalCoordinationDoc, "owner-kill", context))?.cutoff?.cancelled));
    const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-kill", context))!.cutoff!;
    const works = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items;
    assert.ok(works.length > 0);
    for (const item of works) {
      const task = await p.harness.getTask(item.ref.taskId, context);
      assert.ok(cutoff.targets.some(ref => ref.taskId === item.ref.taskId));
      assert.ok(item.cancelRequested || task?.state.status === "terminal");
    }
    // 补接完成：登记成员全部来自目标，标记只落一次。
    for (const ref of cutoff.cancelled!) assert.ok(cutoff.targets.some(target => target.taskId === ref.taskId));
    assert.equal(typeof cutoff.marker, "number");
  } finally { await p.close(); }
});

test("协调预算：完成标记不排队等待后序运行，后序运行失败也不滞留标记", { timeout: 30_000 }, async t => {
  let looping = false, completionReached = false, secondPlaced = false, releaseCompletion!: () => void, releaseSecond!: () => void;
  const completionHeld = new Promise<void>(resolve => { releaseCompletion = resolve; });
  const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  t.after(() => { releaseCompletion(); releaseSecond(); });
  const f = await fixture(t, async request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    if (content === "第二") { secondPlaced = true; await secondHeld; throw new Error("注入的第二输入供应故障"); }
    return { kind: "text", text: `普通:${content}` };
  });
  // 评估停在完成提交之前：标记一旦受排队支配，后序活动的运行会让它永远滞留。
  const p = await f.open({ coordinationProbe: async (record, stage) => { if (record.requestId === "owner-live" && stage === "before-completion") { completionReached = true; await completionHeld; } } });
  await p.harness.commit(tx => personalLocalInput(tx, "owner-live", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-live", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(() => completionReached);
  // 第二输入运行存活、第三输入排队时放行完成提交：标记必须直接落盘而不是排在第二运行之后。
  await p.harness.commit(tx => personalLocalInput(tx, "owner-second", "第二"), context);
  const second = await p.main.submit({ type: "input", content: "第二", requestId: "owner-second", whenBusy: "followUp" }, context);
  await until(() => secondPlaced);
  assert.equal((await second.status(context)).status, "placed");
  await p.harness.commit(tx => personalLocalInput(tx, "owner-third", "第三"), context);
  const third = await p.main.submit({ type: "input", content: "第三", requestId: "owner-third", whenBusy: "followUp" }, context);
  assert.equal((await third.status(context)).status, "queued");
  releaseCompletion();
  await until(async () => (await markers(p)).length === 1);
  assert.equal((await second.status(context)).status, "placed");
  // 第二运行随后自行供应失败：队列进程照常推进，第三输入不受影响地完成。
  releaseSecond();
  assert.equal((await second.wait(context)).status, "unanswered");
  assert.equal((await third.wait(context)).status, "done");
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-live", context))!.cutoff!;
  assert.equal(typeof cutoff.marker, "number");
  assert.equal(cutoff.targets.length, 4);
  for (const ref of cutoff.cancelled!) assert.ok(cutoff.targets.some(target => target.taskId === ref.taskId));
});

test("协调预算：跨重开的两次切断各自推进排队输入", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content.includes("循环");
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  let p = await f.open();
  // 第一轮切断：排队输入由协调器的推进边界落位完成。
  await p.harness.commit(tx => personalLocalInput(tx, "owner-one", "循环一"), context);
  const one = await p.main.submit({ type: "input", content: "循环一", requestId: "owner-one", whenBusy: "followUp" }, context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next-1", "继续一"), context);
  const next1 = await p.main.submit({ type: "input", content: "继续一", requestId: "owner-next-1", whenBusy: "followUp" }, context);
  assert.equal((await one.wait(context)).status, "unanswered");
  assert.equal((await next1.wait(context)).status, "done");
  await until(async () => (await markers(p)).length === 1);
  await p.close();
  // 重开后第二轮切断：协调器再次把排队输入放到登记之后，照常落位完成。
  p = await f.open();
  await p.harness.commit(tx => personalLocalInput(tx, "owner-two", "循环二"), context);
  const two = await p.main.submit({ type: "input", content: "循环二", requestId: "owner-two", whenBusy: "followUp" }, context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next-2", "继续二"), context);
  const next2 = await p.main.submit({ type: "input", content: "继续二", requestId: "owner-next-2", whenBusy: "followUp" }, context);
  assert.equal((await two.wait(context)).status, "unanswered");
  await until(async () => (await markers(p)).length === 2);
  assert.equal((await next2.wait(context)).status, "done");
});

test("协调预算：调用前正文不冒充执行结果，被拒安排的提交事实随让出交接", async t => {
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "假委派") return { kind: "tool_calls" as const, text: "已委派分析", calls: [{ id: "claim", name: "background_work", arguments: { action: "delegate", content: "分析", agent: 99999 } }] };
    if (content === "真委派") return { kind: "tool_calls" as const, text: "已委派分析", calls: [{ id: "real", name: "background_work", arguments: { action: "delegate", content: "分析", label: "分析员" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  // /input 状态查询同一路径：先落齐配置档案，重开的后台才能从持久历史重建回答。
  await savePersonalConfig(f.directory, f.config);
  await savePersonalTools(f.directory, { version: 1, generation: "coord-test", workspace: f.workspace, identity: { dev: fs.statSync(f.workspace).dev, ino: fs.statSync(f.workspace).ino }, credentials: [] });
  let p = await f.open();
  // 模型正文声称已委派、提交事实是拒绝：所有者同时看到正文与提交事实，拒绝不被正文遮盖。
  const claimId = "8d6c7b5a-4e3f-4a1b-8c2d-9e0f1a2b3c4d";
  const refused = await p.answer("假委派", claimId);
  assert.match(refused, /已委派分析；本轮以工具调用让出/);
  assert.match(refused, /未生效/);
  // 成功的混合批同样保留正文并补提交事实；普通查询正文路径不受影响。
  const accepted = await p.answer("真委派", "owner-real");
  assert.match(accepted, /已委派分析；本轮以工具调用让出：/);
  assert.match(accepted, /registered/);
  // 重开的后台从持久历史重建：调用前正文同样不被当成结果，提交事实优先送达。
  await p.close();
  const backend = await startPersonalServer(f.directory);
  try {
    const status = await personalControl<{ status: string; answer?: string }>(f.directory, "GET", `/input?requestId=${claimId}`);
    assert.match(status.answer ?? "", /未生效/);
  } finally { await backend.stop(); }
  p = await f.open();
});

test("协调预算：同号调用按所属批定位结果，回放原输入不重读后序结果", { timeout: 30_000 }, async t => {
  let workId: PersonalWorkRef["taskId"] = 0 as PersonalWorkRef["taskId"], held = true, releaseChildren!: () => void;
  const childrenHeld = new Promise<void>(resolve => { releaseChildren = resolve; });
  t.after(() => { held = false; releaseChildren(); });
  const f = await fixture(t, async request => {
    if (childRequest(request)) { if (held) await childrenHeld; return { kind: "text", text: "成员完成" }; }
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "短分析", label: "分析员" });
    if (content === "补说明" || content === "再补") return { kind: "tool_calls" as const, calls: [{ id: "call-append", name: "background_work", arguments: { action: "append", work: workId, content: "说明" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  assert.match(await p.answer("委派", "owner-del"), /让出/);
  workId = (await p.harness.commit(tx => listPersonalWorks(tx), context)).items[0].ref.taskId;
  // The same provider call ID belongs to separate batches: the active append and a later continuation.
  assert.match(await p.answer("补说明", "owner-note-a"), /已补充/);
  held = false; releaseChildren();
  await until(async () => (await p.harness.getTask(workId, context))?.state.status === "terminal");
  assert.match(await p.answer("再补", "owner-note-b"), /原工作.*结果保留.*后续工作/);
  // Replaying the first input must resolve its own accepted append, rather than the later continuation.
  const replay = await p.answer("补说明", "owner-note-a");
  assert.match(replay, /已补充/);
  assert.doesNotMatch(replay, /后续工作|未接纳/);
});

test("协调预算：内部汇总输入自身越预算被切断，委托成员不牵连且终报不伪造", { timeout: 30_000 }, async t => {
  let delegation = 0;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    // 内部汇总生成输入：其窗口内逐批只发查询调用，五批后栅栏终结——按最后一条用户消息归属。
    if (String(request.messages.findLast(message => message.role === "user")?.content).startsWith("宿主委托汇总参考")) return { kind: "tool_calls" as const, calls: [{ id: `rq-${request.messages.length}`, name: "background_work", arguments: { action: "progress", delegation } }] };
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "委派") return workCall({ action: "delegate", content: "汇总对象", label: "分析员" });
    if (content === "汇总") return workCall({ action: "report", delegation });
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  assert.match(await p.answer("委派", "owner-base"), /让出/);
  const ref = (await p.harness.commit(tx => listPersonalDelegations(tx), context)).items[0].ref;
  delegation = Number(ref.entryId);
  assert.match(await p.answer("汇总", "owner-seal"), /最终汇总安排/);
  // 内部汇总输入按自己的窗口计数：五批查询后栅栏终结，协调器对它单独留下空目标切断。
  const item = async () => (await p.harness.snapshot(PersonalDelegationDoc, String(ref.entryId), context))!.delegation!;
  await until(async () => (await item()).report?.submissionId !== undefined);
  const report = (await item()).report!;
  const record = await (await p.harness.submission(report.submissionId!, context))!.status(context);
  assert.equal(record.type, "input");
  await until(async () => (await (await p.harness.submission(report.submissionId!, context))!.status(context)).status === "unanswered");
  let cutoff: PersonalCoordinationCutoff | undefined;
  await until(async () => {
    const value = (await p.harness.snapshot(PersonalCoordinationDoc, record.requestId!, context))?.cutoff;
    if (value?.cancelled === undefined || value.marker === undefined) return false;
    cutoff = value;
    return true;
  });
  assert.deepEqual(cutoff!.targets, []);
  assert.deepEqual(cutoff!.cancelled, []);
  // 汇总输入的切断不牵连委托成员：没有任何工作被登记取消，终报也不伪造——结果页按成员真实状态回报。
  for (const workItem of (await p.harness.commit(tx => listPersonalWorks(tx), context)).items) assert.equal(workItem.cancelRequested, false);
  await until(async () => (await item()).report?.delivery === "unanswered");
  const result = await p.harness.commit(tx => personalReportResult(tx, ref), context);
  assert.equal(result.delivery, "unanswered");
  assert.equal(result.text, undefined);
});

test("协调预算：同请求标识换正文提交被拒，协调记录不重演", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  await p.harness.commit(tx => personalLocalInput(tx, "owner-reuse", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-reuse", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(async () => (await markers(p)).length === 1);
  // 同键换正文与原接纳冲突：不新开窗口、不重演协调、不再落标记。
  await assert.rejects(p.answer("另一正文", "owner-reuse"), error => error instanceof PersonalError && error.code === "input_conflict");
  assert.equal((await markers(p)).length, 1);
  // 同键同正文的诚实重放仍按原切断事实回执。
  await assert.rejects(p.answer("循环", "owner-reuse"), error => error instanceof PersonalError && error.code === "input_coordination_cutoff");
});

test("协调预算：排队中撤回的输入终结于无条目，不算待协调且后序照常推进", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  let p = await f.open();
  await p.harness.commit(tx => personalLocalInput(tx, "owner-loop", "循环"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-drop", "撤回"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next", "后续"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-loop", whenBusy: "followUp" }, context);
  await until(async () => (await owner.status(context)).status === "placed");
  const withdrawn = await p.main.submit({ type: "input", content: "撤回", requestId: "owner-drop", whenBusy: "followUp" }, context);
  const next = await p.main.submit({ type: "input", content: "后续", requestId: "owner-next", whenBusy: "followUp" }, context);
  assert.equal((await withdrawn.status(context)).status, "queued");
  // 公共撤回把排队输入终结为无条目 unanswered：终结即完成，不再回到待评估集合自旋。
  await withdrawn.abort(context);
  assert.equal((await withdrawn.status(context)).status, "unanswered");
  assert.equal((await withdrawn.status(context)).entry, undefined);
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(async () => (await markers(p)).length === 1);
  // 撤回记录不阻塞推进：排在它后面的输入照常脱离 queued 并完成。
  assert.equal((await next.wait(context)).status, "done");
  // 重开后打开扫描同样把它当已完成：持久撤回记录不被删除也不被重评，新的输入照常完成。
  await p.close();
  p = await f.open();
  const record = await (await p.harness.submission(withdrawn.id, context))!.status(context);
  assert.equal(record.status, "unanswered");
  assert.equal(record.entry, undefined);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-after", "重开后"), context);
  const after = await p.main.submit({ type: "input", content: "重开后", requestId: "owner-after", whenBusy: "followUp" }, context);
  assert.equal((await after.wait(context)).status, "done");
});

test("协调预算：推进扫描失败被按次重试且不污染共享队列，后续输入仍推进", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  let phase = 0, scans = 0, gate!: () => void, parked!: () => void;
  const held = new Promise<void>(resolve => { gate = resolve; }), parkedSignal = new Promise<void>(resolve => { parked = resolve; });
  t.after(() => gate());
  // 首次推进尝试停在读数前，切断评估落在其后；下一次尝试在读数点注入一次真实失败。
  const p = await f.open({ progressionProbe: async stage => {
    if (stage !== "queued-scan") return;
    scans++;
    if (phase === 0) { phase = 1; parked(); await held; }
    else if (phase === 1) { phase = 2; throw new PersonalError("coordination_probe", "注入的推进扫描失败"); }
  } });
  await until(() => phase === 1);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-loop", "循环"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next", "后续"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-loop", whenBusy: "followUp" }, context);
  const next = await p.main.submit({ type: "input", content: "后续", requestId: "owner-next", whenBusy: "followUp" }, context);
  gate();
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(async () => (await markers(p)).length === 1);
  // 一次读数失败进入自有有界重试：重试的推进尝试仍放置后续输入，共享队列未被拒绝传染。
  assert.equal((await next.wait(context)).status, "done");
  assert.ok(phase === 2, `注入的失败应发生过:${phase}`);
  assert.ok(scans >= 3, `应有停顿、失败与重试三次读数:${scans}`);
  await p.close();
});

test("协调预算：推进读数窗口内落达的结算先于后序推进，登记先于放置", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  let holdOpen = false, heldAtScan = false, gate!: () => void;
  const held = new Promise<void>(resolve => { gate = resolve; });
  t.after(() => { holdOpen = false; gate(); });
  const p = await f.open({ progressionProbe: async stage => { if (stage === "queued-scan" && holdOpen) { heldAtScan = true; await held; } } });
  await p.harness.commit(tx => personalLocalInput(tx, "owner-first", "首轮"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-loop", "循环"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next", "后续"), context);
  // 首轮输入正常完成：其评估结束触发的推进尝试停在读数前，循环输入在停顿窗口内越预算落达。
  holdOpen = true;
  const first = await p.main.submit({ type: "input", content: "首轮", requestId: "owner-first", whenBusy: "followUp" }, context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-loop", whenBusy: "followUp" }, context);
  const next = await p.main.submit({ type: "input", content: "后续", requestId: "owner-next", whenBusy: "followUp" }, context);
  assert.equal((await next.status(context)).status, "queued");
  await until(() => heldAtScan);
  assert.equal((await first.wait(context)).status, "done");
  assert.equal((await owner.wait(context)).status, "unanswered");
  // 释放后推进门重新核实：越预算结算的登记必须先于后续输入的放置落成。
  holdOpen = false; gate();
  await until(async () => (await markers(p)).length === 1);
  await until(async () => (await next.status(context)).entry !== undefined);
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))!.cutoff!;
  assert.ok(Array.isArray(cutoff.cancelled));
  const nextRecord = await next.status(context);
  assert.ok(cutoff.marker! < nextRecord.entry!, `取消登记须先于后续放置:marker=${cutoff.marker},entry=${nextRecord.entry}`);
  assert.equal((await next.wait(context)).status, "done");
});

test("协调预算：持续失败的评估按有界次数后暂停，协调器自身扫描不重启计数", { timeout: 30_000 }, async t => {
  let looping = false;
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content === "循环";
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  let released = false, evaluations = 0;
  const p = await f.open({ coordinationProbe: (record, stage) => { if (record.requestId === "owner-loop" && stage === "before-completion" && !released) { evaluations++; throw new PersonalError("coordination_probe", "持续注入的完成提交失败"); } } });
  await p.harness.commit(tx => personalLocalInput(tx, "owner-loop", "循环"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-next", "后续"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-loop", whenBusy: "followUp" }, context);
  const next = await p.main.submit({ type: "input", content: "后续", requestId: "owner-next", whenBusy: "followUp" }, context);
  assert.equal((await owner.wait(context)).status, "unanswered");
  // 持久故障按有界重试后暂停：评估计数停在所选边界，协调器自身的扫描不再重启它。
  await until(() => evaluations === 4);
  await delay(400);
  assert.equal(evaluations, 4);
  // 暂停的重试不是已完成的取消登记：意图缺 cancelled 期间，排队后续输入不得推进。
  const intent = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))!.cutoff!;
  assert.equal(intent.cancelled, undefined);
  assert.equal((await next.status(context)).status, "queued");
  const nextId = next.id;
  // 暂停评估期间再接纳一个普通输入：也只排队而不阻塞——随后整包关闭必须照常返回，没有任何等待。
  const late = await p.submit("迟到", "owner-late");
  assert.equal((await late.status(context)).status, "queued");
  // 真实恢复来自重开：打开扫描重新评估同一意图，取消登记与标记各只落一次，后续输入随后完成。
  released = true;
  await p.close();
  const reopened = await f.open();
  await until(async () => (await markers(reopened)).length === 1);
  const cutoff = (await reopened.harness.snapshot(PersonalCoordinationDoc, "owner-loop", context))!.cutoff!;
  assert.ok(Array.isArray(cutoff.cancelled));
  assert.equal(evaluations, 4);
  const nextReopened = await reopened.harness.submission(nextId, context);
  assert.equal((await nextReopened!.wait(context)).status, "done");
  const lateReopened = await reopened.harness.submission(late.id, context);
  assert.equal((await lateReopened!.wait(context)).status, "done");
});

test("协调预算：取消登记未完成时普通新输入被接纳为排队，登记落盘后按序执行", { timeout: 30_000 }, async t => {
  let looping = false, released = false, completionReached = false, gate!: () => void;
  const held = new Promise<void>(resolve => { gate = resolve; });
  t.after(() => { released = true; gate(); });
  const f = await fixture(t, request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content.includes("循环");
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `d-${results}`, name: "background_work", arguments: { action: "delegate", content: `循环分析-${results}`, label: "分析员" } }, { id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  // 探针把评估停在完成提交之前：意图已持久、取消登记尚未落盘——接纳屏障挡的正是这个窗口。
  const p = await f.open({ coordinationProbe: async (record, stage) => { if (record.requestId === "owner-admit" && stage === "before-completion" && !released) { completionReached = true; await held; } } });
  await p.harness.commit(tx => personalLocalInput(tx, "owner-admit", "循环"), context);
  const owner = await p.main.submit({ type: "input", content: "循环", requestId: "owner-admit", whenBusy: "followUp" }, context);
  await until(async () => (await owner.status(context)).status === "placed");
  await p.harness.commit(tx => personalLocalInput(tx, "owner-queued", "排队"), context);
  const queued = await p.main.submit({ type: "input", content: "排队", requestId: "owner-queued", whenBusy: "followUp" }, context);
  assert.equal((await queued.status(context)).status, "queued");
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(() => completionReached);
  // 屏障在接纳提交内判断：cancelled 缺席期间新输入照常落盘但只能排队，绝不自我放置或推进队列。
  const arrived = await p.submit("后到达", "owner-arrive");
  assert.equal((await arrived.status(context)).status, "queued");
  await delay(300);
  assert.equal((await queued.status(context)).status, "queued");
  const waiting = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-arrive"), context);
  assert.equal(waiting!.status, "queued");
  assert.equal(waiting!.entry, undefined);
  assert.equal((await p.harness.snapshot(PersonalCoordinationDoc, "owner-admit", context))!.cutoff!.cancelled, undefined);
  // 登记与公开标记落盘后屏障放开：队列先放排队项再放它，两者条目都晚于标记。
  released = true; gate();
  await until(async () => (await markers(p)).length === 1);
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-admit", context))!.cutoff!;
  assert.ok(Array.isArray(cutoff.cancelled));
  assert.equal((await queued.wait(context)).status, "done");
  assert.equal((await arrived.wait(context)).status, "done");
  const queuedRecord = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-queued"), context);
  const arrivedRecord = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-arrive"), context);
  assert.ok(cutoff.marker! < queuedRecord!.entry!, `登记须先于后序放置:marker=${cutoff.marker},entry=${queuedRecord!.entry}`);
  assert.ok(cutoff.marker! < arrivedRecord!.entry!, `登记须先于新输入放置:marker=${cutoff.marker},entry=${arrivedRecord!.entry}`);
});

test("协调预算：空闲带排队项的窗口内普通输入照常接纳，先排队者先放置", { timeout: 30_000 }, async t => {
  let releaseFirst!: () => void, holdOpen = false, heldAtScan = false, gateScan!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const scanHeld = new Promise<void>(resolve => { gateScan = resolve; });
  t.after(() => { holdOpen = false; gateScan(); releaseFirst(); });
  const f = await fixture(t, async request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "tool") return { kind: "text", text: `回执:${content}` };
    if (content === "首轮") await firstHeld;
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open({ progressionProbe: async stage => { if (stage === "queued-scan" && holdOpen) { heldAtScan = true; await scanHeld; } } });
  await p.harness.commit(tx => personalLocalInput(tx, "owner-first", "首轮"), context);
  await p.harness.commit(tx => personalLocalInput(tx, "owner-queued", "排队"), context);
  const first = await p.main.submit({ type: "input", content: "首轮", requestId: "owner-first", whenBusy: "followUp" }, context);
  await until(async () => (await first.status(context)).status === "placed");
  // 首轮运行存活期间排队第二输入；首轮结束后推进在读数点被停住：空闲、队列非空。
  const queued = await p.submit("排队", "owner-queued");
  assert.equal((await queued.status(context)).status, "queued");
  holdOpen = true; releaseFirst();
  await until(() => heldAtScan);
  assert.equal((await first.wait(context)).status, "done");
  // 空闲带排队项的窗口内新输入必须正常落库：头标记读数先于提交写，随后边界先放排队项。
  const late = await p.submit("迟到", "owner-late");
  const waiting = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-late"), context);
  assert.equal(waiting!.status, "queued");
  assert.equal(waiting!.entry, undefined);
  await until(async () => (await queued.status(context)).status === "placed");
  // 推进恢复后两输入按序完成：先排队项、后新输入。
  gateScan();
  assert.equal((await queued.wait(context)).status, "done");
  assert.equal((await late.wait(context)).status, "done");
  const queuedRecord = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-queued"), context);
  const lateRecord = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-late"), context);
  assert.ok(queuedRecord!.entry! < lateRecord!.entry!, `先排队者须先放置:${queuedRecord!.entry},${lateRecord!.entry}`);
});

test("协调预算：原生接纳的活拼写排队项在下一次宿主提交内被驻车", { timeout: 30_000 }, async t => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  t.after(() => releaseFirst());
  const f = await fixture(t, async request => {
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (content === "首轮") await firstHeld;
    return { kind: "text", text: `普通:${content}` };
  });
  const p = await f.open();
  await p.harness.commit(tx => personalLocalInput(tx, "owner-first", "首轮"), context);
  const first = await p.main.submit({ type: "input", content: "首轮", requestId: "owner-first", whenBusy: "followUp" }, context);
  await until(async () => (await first.status(context)).status === "placed");
  // 原生提交在忙期间排成活拼写——上游选择器认得它，宿主提交须先驻车再谈边界。
  const native = await p.main.submit({ type: "input", content: "原生排队", requestId: "owner-native", whenBusy: "followUp" }, context);
  assert.equal((await native.status(context)).status, "queued");
  await until(async () => p.harness.commit(async tx => (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.some(item => item.id === native.id && item.mode === "followUp"), context));
  // 下一次宿主接纳提交驻车它：此后任何上游边界都选不中这条输入。
  const coord = await p.submit("协调排队", "owner-coord");
  const modes = await p.harness.commit(async tx => (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.map(item => item.mode), context);
  assert.deepEqual(modes, ["ruukoto.parked-followUp", "ruukoto.parked-followUp"]);
  releaseFirst();
  assert.equal((await native.wait(context)).status, "done");
  assert.equal((await coord.wait(context)).status, "done");
});

test("协调预算：后台压缩摘要的原生写不在登记前推进排队输入", { timeout: 60_000 }, async t => {
  let releaseSummary!: () => void, summaryRequested = false, looping = false;
  const summaryHeld = new Promise<void>(resolve => { releaseSummary = resolve; });
  const f = await fixture(t, async request => {
    if (request.system?.includes("context summarization")) { summaryRequested = true; await summaryHeld; return { kind: "text", text: "压缩总结" }; }
    if (childRequest(request)) return { kind: "text", text: "成员完成" };
    const last = request.messages.at(-1), content = String(last?.content);
    if (last?.role === "user") looping = content.includes("循环");
    const results = request.messages.filter(message => message.role === "tool").length;
    if (looping && (last?.role === "user" || last?.role === "tool")) return { kind: "tool_calls" as const, calls: [{ id: `q-${results}`, name: "background_work", arguments: { action: "list" } }] };
    return { kind: "text", text: `普通:${content}` };
  });
  let released = false, completionReached = false, gateCompletion!: () => void;
  const completionHeld = new Promise<void>(resolve => { gateCompletion = resolve; });
  t.after(() => { released = true; gateCompletion(); releaseSummary(); });
  const p = await f.open({ coordinationProbe: async (record, stage) => { if (record.requestId === "owner-big" && stage === "before-completion" && !released) { completionReached = true; await completionHeld; } } });
  // 种子输入先于大输入落史：压缩范围选中它，大输入自身越过后台阈值触发原生压缩任务。
  await p.harness.commit(tx => personalLocalInput(tx, "owner-seed", "种子"), context);
  const seed = await p.main.submit({ type: "input", content: "种子", requestId: "owner-seed", whenBusy: "followUp" }, context);
  assert.equal((await seed.wait(context)).status, "done");
  const big = `循环${"填".repeat(300_000)}`;
  await p.harness.commit(tx => personalLocalInput(tx, "owner-big", big), context);
  const owner = await p.main.submit({ type: "input", content: big, requestId: "owner-big", whenBusy: "followUp" }, context);
  // 后台压缩任务在大输入运行的准备期孵化：摘要模型请求挂起时，原输入越预算落达。
  await until(() => summaryRequested);
  assert.equal((await owner.wait(context)).status, "unanswered");
  await until(() => completionReached);
  // 登记尚未完成时接纳一个普通输入：只能排队驻留，压缩写抵达也不得提前放置它。
  const queued = await p.submit("排队", "owner-queued");
  assert.equal((await queued.status(context)).status, "queued");
  releaseSummary();
  await until(async () => (await entries(p)).some(entry => entry.kind === CompactionEntry.kind));
  await delay(300);
  assert.equal((await queued.status(context)).status, "queued");
  assert.equal((await queued.status(context)).entry, undefined);
  assert.equal((await p.harness.snapshot(PersonalCoordinationDoc, "owner-big", context))!.cutoff!.cancelled, undefined);
  // 登记与公开标记落盘后队列才推进：排队输入的放置必然晚于取消登记。
  released = true; gateCompletion();
  await until(async () => (await markers(p)).length === 1);
  const cutoff = (await p.harness.snapshot(PersonalCoordinationDoc, "owner-big", context))!.cutoff!;
  assert.ok(Array.isArray(cutoff.cancelled));
  assert.equal((await queued.wait(context)).status, "done");
  const queuedRecord = await p.harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, "owner-queued"), context);
  assert.ok(cutoff.marker! < queuedRecord!.entry!, `登记须先于后序放置:marker=${cutoff.marker},entry=${queuedRecord!.entry}`);
});
