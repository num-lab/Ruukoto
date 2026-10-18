import { product as personalProduct } from "./helpers/legacy-product.ts";
/**
 * issue 30：上下文压缩（压缩点、第一层清理、滚动摘要、兜底移出标记）。
 *
 * 选择器层：规划与视图组装是纯函数，直接构造消息验证；
 * 组装层：经模型上下文组装的模块接口（摘要经真实模型栈发往 mock），验证落盘、事件、
 *   摘要失败与中止；
 * 宿主层：完整后台只验证跨接缝的部分——会话文件与工具读回、重启、停止联动。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { checkToolPairing, type ContextAssembly } from "@ruukoto/agent/context-assembly.ts";
import {
  DEFAULT_BUDGET_CONFIG,
  planCompaction,
  selectContext,
  selectionBreakdown,
  type CheckpointInput,
  type SelectorInput,
} from "@ruukoto/agent/context-selector.ts";
import { configRevision, saveSummaryModel } from "@ruukoto/agent/model-config.ts";
import { createMockTools } from "@ruukoto/agent/mock-tools.ts";
import { OfflineModelBackend } from "@ruukoto/tui/config-tui/index.ts";
import { ControlServer } from "@ruukoto/control/server.ts";
import { parseSessionFile } from "@ruukoto/core/history.ts";
import { compactionText, EventFlow } from "@ruukoto/tui/tui/event-flow.ts";
import { contextBarLines } from "@ruukoto/tui/tui/app.ts";
import { Runtime, type RuntimeConfig } from "@ruukoto/runtime/runtime.ts";
import { MockModelServer, type MockResponse, type RecordedRequest } from "./helpers/mock-provider.ts";
import {
  afterTool,
  cleanupDirs,
  connectAuthedClient,
  createProjectSession,
  makeTestDirs,
  routeResponder,
  startAssemblyKit,
  taskStatus,
  waitFor,
  writeModelsJson,
  type RecordedRequestLike,
  type TestDirs,
} from "./helpers/testkit.ts";

// ---------- 选择器层 ----------

let clock = Date.parse("2026-09-26T00:00:00.000Z");
const user = (text: string) => ({ role: "user", content: text, timestamp: clock++ });
const call = (id: string, name = "bash", args: Record<string, unknown> = { command: `run ${id}` }) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
  stopReason: "toolUse",
  timestamp: clock++,
});
const result = (id: string, text: string, toolName = "bash") => ({
  role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError: false, timestamp: clock++,
});
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: clock++ });
/** 约 tokens 个估算 token 的 ASCII 正文（calibration = 1 时 chars/4）。 */
const big = (tokens: number, tag = "x") => `${tag} `.padEnd(tokens * 4, "abcd");

const H = 40_000;
/** H' = 40,000：输入预算远大于高水位，只测压缩（不触发兜底移出）；摘要块上限约 0.1 H'。 */
function input(messages: any[], checkpoint: CheckpointInput | null = null, overrides: Partial<SelectorInput["budget"]> = {}): SelectorInput {
  return {
    messages,
    systemPrompt: "sys",
    tools: [],
    memories: [],
    budget: {
      ...DEFAULT_BUDGET_CONFIG,
      contextWindow: 100_000,
      maxTokens: 1_000,
      calibration: 1,
      compactionHighWater: H,
      ...overrides,
    },
    compaction: { sessionId: "sess_1", checkpoint },
  };
}

/** 一轮已完成的交互：user → 调用 → 大结果（约 7,000 估算 token）→ 回答。 */
function turn(n: number): any[] {
  return [user(`任务 ${n}`), call(`c${n}`), result(`c${n}`, big(7_000, `输出${n}`)), reply(`完成 ${n}`)];
}

const textOf = (m: any): string => (typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? JSON.stringify(p)).join(""));

function checkpointFrom(plan: NonNullable<ReturnType<typeof planCompaction>>, summary: string | null, id = "cp_1"): CheckpointInput {
  return {
    id,
    summarizedCount: summary ? plan.summarizedCount : 0,
    clearedCount: plan.clearedCount,
    summary,
    summaryUntil: summary ? "2026-09-26T00:00:00.000Z" : null,
    clearedRefs: {},
  };
}

test("选择器：视图估算不超过 H' 时不规划压缩点", () => {
  const messages = [...turn(1), user("当前")];
  const before = selectContext(input(messages));
  assert.ok(before.unboundedTotal < H);
  assert.equal(planCompaction(input(messages), before), null);
});

test("选择器：越过 H' 后第一层清理旧的大工具结果，skill/todo_write 与 toolCall 参数不动，配对合法", () => {
  const messages = [
    user("任务 0"),
    call("sk", "skill", { name: "alpha" }),
    result("sk", big(3_000, "技能正文"), "skill"),
    call("td", "todo_write", { todos: [{ content: "步骤", status: "in_progress" }] }),
    result("td", big(3_000, "清单"), "todo_write"),
    reply("好"),
    ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5), ...turn(6),
    user("当前任务"),
  ];
  const cpIn = input(messages);
  const before = selectContext(cpIn);
  assert.ok(before.unboundedTotal > H);
  const plan = planCompaction(cpIn, before);
  assert.ok(plan, "应规划压缩点");
  const after = selectContext(input(messages, checkpointFrom(plan, null)));
  const view = after.messages;
  const cleared = view.filter((m: any) => m.role === "toolResult" && textOf(m).startsWith("[已清理 · bash"));
  assert.ok(cleared.length >= 4, "较早的大结果被清理");
  assert.match(textOf(cleared[0]), /^\[已清理 · bash · 原 \d+ 字符 · 成功 · 原文需重新执行工具获取\]$/);
  assert.ok(textOf(view.find((m: any) => m.toolCallId === "sk")).startsWith("技能正文"), "skill 结果不清理");
  assert.ok(textOf(view.find((m: any) => m.toolCallId === "td")).startsWith("清单"), "todo_write 结果不清理");
  assert.deepEqual(view.find((m: any) => m.role === "assistant" && m.content[0]?.id === "c1"), messages[7], "toolCall 参数不动");
  assert.equal(checkToolPairing(view), null);
  assert.equal(plan.summarizedCount, 0, "只清理即可压到低水位");
  assert.ok(after.unboundedTotal <= 0.5 * H, "估算降到低水位以下");
  assert.equal(after.checkpointId, "cp_1");
  // 保护尾部内的最近结果不清理
  assert.ok(textOf(view.find((m: any) => m.toolCallId === "c6")).startsWith("输出6"));
});

test("选择器：推进 S 后摘要块位置正确，同一压缩点的视图稳定且追加消息保持前缀", () => {
  // 纯文本交互无可清理结果：只能靠摘要
  const messages: any[] = [];
  for (let n = 0; n < 12; n++) messages.push(user(big(1_800, `问题${n}`)), reply(big(1_800, `回答${n}`)));
  messages.push(user("当前任务"));
  const withRefs = (cp: CheckpointInput | null): SelectorInput => ({
    ...input(messages, cp),
    references: [{ category: "projectInstructions", placement: "prefix", text: "[项目指令]\n约定\n[/项目指令]" }],
  });
  const before = selectContext(withRefs(null));
  const plan = planCompaction(withRefs(null), before);
  assert.ok(plan && plan.summarizedCount > 0 && plan.summarizedCount <= plan.clearedCount);
  assert.equal(messages[plan.summarizedCount].role, "user", "S 落在完整交互开头");
  const cp = checkpointFrom(plan, "SUMMARY-TEXT");
  const view = selectContext(withRefs(cp)).messages;
  assert.deepEqual(selectContext(withRefs(cp)).messages, view);
  assert.ok(textOf(view[0]).startsWith("[项目指令]"));
  assert.equal(textOf(view[1]), `[压缩摘要 · 较早的 ${plan.summarizedCount} 条消息 · 至 2026-09-26T00:00:00.000Z]\nSUMMARY-TEXT\n[/压缩摘要]`);
  assert.equal(textOf(view[2]), textOf(messages[plan.summarizedCount]), "摘要块之后接 [S, n) 的历史");
  assert.equal(textOf(view.at(-1)), "当前任务");
  messages.push(call("next"), result("next", "小结果"));
  assert.deepEqual(selectContext(withRefs(cp)).messages.slice(0, view.length), view);
});

test("选择器：S 伸进当前任务时，任务输入原样排在摘要块之后，继续来源仍在它之前", () => {
  const messages: any[] = [user("长任务")];
  for (let n = 0; n < 10; n++) messages.push(call(`b${n}`, "read", { path: `f${n}` }), result(`b${n}`, `片段${n}`.repeat(10)), reply(big(300, `想法${n}`)));
  // 每个批次 = assistant 调用 + 结果；回答文本单独成批次（assistant 开头）
  const cp: CheckpointInput = { id: "cp_x", summarizedCount: 7, clearedCount: 7, summary: "前段摘要", summaryUntil: "t", clearedRefs: {} };
  assert.equal(messages[7].role, "assistant");
  const view = selectContext({ ...input(messages, cp), references: [{ category: "resumedFrom", placement: "task", text: "[继续来源：本任务继续已中断任务 task_old；其原始要求如下]\n原要求\n[/继续来源]" }] }).messages;
  assert.ok(textOf(view[0]).startsWith("[压缩摘要 · 较早的 7 条消息"));
  assert.ok(textOf(view[1]).startsWith("[继续来源"));
  assert.equal(textOf(view[2]), "长任务", "任务输入原文紧接在摘要块（与任务级块）之后");
  assert.deepEqual(view[3], messages[7]);
  assert.equal(checkToolPairing(view), null);
});

test("选择器：连续 100 次调用、每次新增约 0.05 H'，压缩不超过 10 次，两次压缩之间逐次为前缀", () => {
  const messages: any[] = [user("长任务")];
  let cp: CheckpointInput | null = null;
  let compactions = 0;
  let prev: any[] | null = null;
  for (let callNo = 0; callNo < 100; callNo++) {
    const plan = planCompaction(input(messages, cp), selectContext(input(messages, cp)));
    const compacted = plan !== null;
    if (plan) {
      compactions++;
      // 摘要按上一版延续：有新 S 或已有摘要时带摘要，否则只清理
      const summary: string | null = plan.summarizedCount > 0 ? `摘要 ${compactions}` : null;
      cp = { id: `cp_${compactions}`, summarizedCount: plan.summarizedCount, clearedCount: plan.clearedCount, summary, summaryUntil: "t", clearedRefs: {} };
    }
    const view: any[] = selectContext(input(messages, cp)).messages;
    const replay = selectContext(input(messages, cp));
    assert.deepEqual(replay.messages, view, `第 ${callNo} 次调用的相同输入得到相同视图`);
    assert.ok(replay.unboundedTotal <= H, `第 ${callNo} 次调用压缩后不超过 H'`);
    if (prev && !compacted) assert.deepEqual(view.slice(0, prev.length), prev, `第 ${callNo} 次调用保持前缀`);
    prev = view;
    // 每次调用新增一个批次，约 0.05 H'
    messages.push(call(`k${callNo}`), result(`k${callNo}`, big(0.05 * H, `x${callNo}`)));
  }
  assert.ok(compactions >= 1 && compactions <= 10, `压缩 ${compactions} 次`);
});

test("选择器：压缩后仍超输入预算时整轮移出并加移出标记；不压缩的会话不加标记", () => {
  const messages: any[] = [];
  for (let n = 0; n < 8; n++) messages.push(user(big(300, `问${n}`)), reply(`答 ${n}`));
  messages.push(user("当前"));
  // 输入预算 = 100_000 − 1_000 − 8_000 − 89_000 = 2_000
  const tight = input(messages, null, { safetyMargin: 89_000 });
  const withMarker = selectContext(tight);
  assert.ok(withMarker.ok && withMarker.excluded.length > 0);
  const marker = withMarker.messages.find((m: any) => textOf(m).startsWith("[较早的 "));
  assert.match(textOf(marker), /^\[较早的 \d+ 轮交互未进入本次上下文 · 2026-\S+Z 至 2026-\S+Z\]$/);
  assert.ok(withMarker.estimatedTotal <= withMarker.budget);
  const restricted = selectContext({ ...tight, compaction: null });
  assert.ok(!restricted.messages.some((m: any) => textOf(m).startsWith("[较早的 ")), "qq_group/chat 维持现状");
});

test("选择器：必留内容超预算仍返回 ok=false，不规划压缩", () => {
  const messages = [...turn(1), user(big(5_000))];
  const tight = input(messages, null, { safetyMargin: 89_000 });
  const before = selectContext(tight);
  assert.equal(before.ok, false);
  assert.equal(planCompaction(tight, before), null);
});

test("/context：分解含「压缩摘要」一类，并显示压缩点信息或摘要失败原因", () => {
  const record = {
    id: "sel_1", taskId: "task_1", sessionId: "sess_1", callIndex: 5, strategy: "deterministic-v1", configVersion: 1,
    model: "mock/mock-model", totalMessages: 20, includedIndices: [12, 13], excluded: [], includedMemories: [], excludedMemories: [],
    instructionVersion: "", skillVersion: "", cappedToolResults: [], estimates: { systemPrompt: 100, compactionSummary: 600, mandatoryTurn: 300 },
    budget: 10_000, estimatedTotal: 1_000, usage: null, experiment: null, promptArtifactId: null, windowSnapshot: null,
    checkpointId: "ckpt_1", createdAt: "2026-09-26T00:00:00.000Z",
  };
  const checkpoint = {
    summarizedCount: 12, summaryUntil: "2026-09-26T01:02:03.000Z", clearedResults: 3, taskId: "task_abcdefghijkl",
    callIndex: 4, summaryModel: "mock/mock-model", summaryStatus: "ok", summaryError: null,
  };
  const render = (cp: any) => stripTerminalSequences(contextBarLines(record as any, selectionBreakdown(record as any), 200, cp).join("\n"));
  const ok = render(checkpoint);
  assert.match(ok, /压缩摘要/);
  assert.match(ok, /压缩点：摘要替代 12 条（至 2026-09-26T01:02:03\.000Z） · 清理 3 条 · 建于任务 task_abcdefgh 第 4 次调用/);
  assert.match(ok, /摘要模型：mock\/mock-model/);
  assert.match(render({ ...checkpoint, summaryStatus: "failed", summaryError: "摘要超时（180 s）" }), /摘要失败，只做了清理：摘要超时（180 s）/);
  assert.doesNotMatch(render(null), /压缩点/);
  assert.match(render({ ...checkpoint, summaryStatus: "none", summaryModel: null }), /摘要沿用上一压缩点/);
});

test("事件流：未产生新摘要时不写「摘要 N 条」；摘要等待中停止任务，进行中的提示收尾", () => {
  const base = { type: "task.context_compaction", taskId: "task_1", sessionId: "sess_1", compactionId: "cmp_1", summaryModel: null, estimateBefore: 214_000 } as const;
  assert.equal(compactionText({ ...base, phase: "finished", checkpointId: "ckpt_1", estimateAfter: 98_000, clearedResults: 37, summarizedCount: 412, summaryStatus: "ok" }),
    "上下文已压缩：清理 37 条结果、摘要 412 条消息，估算 21.4 万 → 9.8 万");
  assert.equal(compactionText({ ...base, phase: "finished", checkpointId: "ckpt_1", estimateAfter: 98_000, clearedResults: 37, summarizedCount: 412, summaryStatus: "none" }),
    "上下文已压缩：清理 37 条结果，估算 21.4 万 → 9.8 万");
  const flow = new EventFlow();
  const task: any = { id: "task_1", sessionId: "sess_1", status: "running", input: "", createdAt: "2026-09-26T00:00:00.000Z", startedAt: "2026-09-26T00:00:00.000Z", endedAt: null };
  flow.task(task);
  flow.apply({ seq: 1, createdAt: "2026-09-26T00:00:01.000Z", sessionId: "sess_1", body: { ...base, phase: "started", checkpointId: null } } as any);
  const note = () => flow.items.find((e) => e.key === "compaction:cmp_1") as any;
  assert.equal(note().text, "正在压缩上下文…");
  flow.task({ ...task, status: "interrupted", endedAt: "2026-09-26T00:00:02.000Z" });
  assert.equal(note().text, "上下文压缩未完成：任务已结束");
});

// ---------- 组装层（模块接口，不起 Runtime；摘要经真实模型栈发往 mock） ----------

const HOST_H = 60_000;
const hostText = (m: Record<string, unknown>): string =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";
const promptOf = (req: RecordedRequest): string => hostText(req.messages.at(-1)!);
const longInput = (n: number): string => `长文 ${n} ${"z".repeat(30_000)}`;

type Kit = Awaited<ReturnType<typeof startAssemblyKit>>;
type Sent = Awaited<ReturnType<Kit["send"]>>;

/** 高水位 HOST_H 的组装夹具；kit.server 只收到摘要请求。 */
async function startKit(prefix: string, summary: (req: RecordedRequest) => MockResponse | Promise<MockResponse>, contextWindow?: number): Promise<Kit> {
  const kit = await startAssemblyKit(prefix, { responder: summary, contextWindow });
  kit.deps.budgetOverrides = { compactionHighWater: HOST_H };
  return kit;
}

const compactionEvents = (kit: Kit): any[] =>
  kit.store.getEventsAfter(0).map((e) => e.body as any).filter((b) => b.type === "task.context_compaction");

test("组装：第一层——越过 H' 后建压缩点，旧结果换成占位、toolCall 参数不动、不请求摘要；记录与事件；两次压缩之间前缀不变；指纹不符作废重建", async () => {
  const kit = await startKit("compact-l1", () => ({ kind: "text", text: "不应请求摘要" }));
  try {
    const { session } = kit.project();
    const messages: any[] = [];
    let last!: Sent;
    for (let n = 1; n <= 8 && !kit.store.getActiveCheckpoint(session.id); n++) {
      messages.push(user(`大输出 ${n}`), call(`big${n}`, "mock_big", { size: 40_000, tag: `T${n}` }), result(`big${n}`, `T${n}:${"y".repeat(40_000)}`, "mock_big"));
      last = await kit.send(kit.begin(kit.task(session, `大输出 ${n}`), session), messages);
      messages.push(reply("ok"));
    }
    const cp = kit.store.getActiveCheckpoint(session.id)!;
    assert.ok(cp, "应建立压缩点");
    assert.equal(cp.summaryStatus, "none");
    assert.equal(cp.summarizedCount, 0);
    assert.ok(cp.clearedResults >= 2 && cp.estimateBefore > HOST_H && cp.estimateAfter <= HOST_H / 2, JSON.stringify(cp));
    assert.equal(kit.server.calls.length, 0, "只清理即可，不调用摘要模型");

    const placeholders = last.view.map(textOf).filter((t) => t.startsWith("[已清理"));
    assert.equal(placeholders.length, cp.clearedResults);
    assert.ok(placeholders[0]!.startsWith(`[已清理 · mock_big · 原 ${"T1:".length + 40_000} 字符 · 成功 · `), placeholders[0]);
    assert.ok(last.view.some((m) => m.role === "assistant" && m.content.some((p: any) => p.type === "toolCall" && p.id === "big1" && p.arguments.size === 40_000)), "toolCall 参数不动");
    assert.equal(checkToolPairing(last.view), null);
    assert.equal(last.record.checkpointId, cp.id);
    const events = compactionEvents(kit);
    assert.equal(events.filter((e) => e.phase === "started").length, 0);
    const finished = events.filter((e) => e.phase === "finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].checkpointId, cp.id);
    assert.ok(compactionText(finished[0]).startsWith(`上下文已压缩：清理 ${cp.clearedResults} 条结果，估算 `), compactionText(finished[0]));

    // 同一任务两次调用之间视图逐次为前缀
    const reading = kit.begin(kit.task(session, "读回"), session);
    messages.push(user("读回"));
    const c1 = await kit.send(reading, messages);
    messages.push(call("hr1", "history_read", {}), result("hr1", "条目原文", "history_read"));
    const c2 = await kit.send(reading, messages);
    assert.deepEqual(c2.view.slice(0, c1.view.length), c1.view, "两次压缩之间前缀不变");

    // 指纹不符：当场作废并重建
    kit.store.db.prepare("UPDATE context_checkpoints SET fingerprint = 'bad' WHERE id = ?").run(cp.id);
    messages.push(reply("读完"), user("作废后"));
    await kit.send(kit.begin(kit.task(session, "作废后"), session), messages);
    assert.equal(kit.store.getCheckpoint(cp.id)!.status, "invalidated");
    const rebuilt = kit.store.getActiveCheckpoint(session.id)!;
    assert.ok(rebuilt && rebuilt.id !== cp.id, "重新建立压缩点");
  } finally {
    await kit.close();
  }
});

test("组装：第二层——摘要发往会话模型（不带思考参数），视图为摘要块 → 历史 → 当前任务；换上摘要模型后改发该模型，上一版摘要进入输入", async () => {
  let k = 0;
  const kit = await startKit("compact-l2", () => ({ kind: "text", text: `SUMMARY-${++k}` }));
  try {
    const { session } = kit.project();
    const messages: any[] = [];
    let n = 0;
    let last!: Sent;
    const next = async () => {
      messages.push(user(longInput(++n)));
      last = await kit.send(kit.begin(kit.task(session, longInput(n)), session), messages);
      messages.push(reply(`done:${n}`));
    };
    while (!kit.store.getActiveCheckpoint(session.id) && n < 10) await next();
    const cp = kit.store.getActiveCheckpoint(session.id)!;
    assert.ok(cp && cp.summaryStatus === "ok" && cp.summary === "SUMMARY-1" && cp.summarizedCount > 0, JSON.stringify(cp));
    assert.equal(cp.summaryModel, "mock/mock-model");
    assert.equal(cp.promptVersion, "compaction-v2");
    const [s1] = kit.server.calls;
    assert.equal(s1!.raw.model, "mock-model");
    assert.ok(!("reasoning_effort" in s1!.raw) && !("reasoning" in s1!.raw), "摘要请求不带思考参数");
    assert.ok(promptOf(s1!).includes("长文 1 ") && !promptOf(s1!).includes("<previous-summary>"));
    assert.equal(textOf(last.view[0]), `[压缩摘要 · 较早的 ${cp.summarizedCount} 条消息 · 至 ${cp.summaryUntil}]\nSUMMARY-1\n[/压缩摘要]`);
    assert.ok(textOf(last.view[1]).startsWith("长文 "), "摘要块之后是 [S, n) 的历史");
    assert.ok(textOf(last.view.at(-1)).startsWith(`长文 ${n} `), "最后是当前任务");
    assert.deepEqual(compactionEvents(kit).map((e) => e.phase), ["started", "finished"]);

    // 目录加一个模型并设为摘要模型；换上的模型栈经同一个 deps 对象生效（同 driver.updateModelDeps）
    const file = path.join(kit.dirs.agentDir, "models.json");
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    catalog.providers.mock.models.push({ ...catalog.providers.mock.models[0], id: "mock-summary", name: "Mock Summary" });
    fs.writeFileSync(file, JSON.stringify(catalog));
    await kit.reloadModels();
    saveSummaryModel(kit.dirs.agentDir, { provider: "mock", modelId: "mock-summary" });
    while (kit.store.getActiveCheckpoint(session.id)!.summary === "SUMMARY-1" && n < 20) await next();
    const cp2 = kit.store.getActiveCheckpoint(session.id)!;
    assert.equal(cp2.summary, "SUMMARY-2");
    assert.equal(cp2.summaryModel, "mock/mock-summary");
    const s2 = kit.server.calls.at(-1)!;
    assert.equal(s2.raw.model, "mock-summary");
    assert.ok(promptOf(s2).includes("<previous-summary>\nSUMMARY-1\n</previous-summary>"), "上一版摘要进入输入");
    assert.ok(cp2.summarizedCount > cp.summarizedCount);
    assert.equal(last.record.checkpointId, cp2.id);
    assert.ok(last.record.estimates.compactionSummary > 0);
    assert.equal(last.record.totalMessages, last.record.includedIndices.length + last.record.excluded.length + cp2.summarizedCount);
  } finally {
    await kit.close();
  }
});

test("组装：S 伸进当前任务时，任务输入原文紧接在摘要块之后", async () => {
  const kit = await startKit("compact-intask", () => ({ kind: "text", text: "前段摘要" }));
  try {
    const { session } = kit.project();
    const assembly = kit.begin(kit.task(session, "长任务"), session);
    const messages: any[] = [user("长任务")];
    let last!: Sent;
    for (let i = 1; i <= 10; i++) {
      messages.push(call(`p${i}`, "mock_big", { size: 10, tag: `P${i}`, pad: "p".repeat(24_000) }), result(`p${i}`, `P${i}:${"y".repeat(10)}`, "mock_big"));
      last = await kit.send(assembly, messages);
    }
    const cp = kit.store.getActiveCheckpoint(session.id)!;
    assert.ok(cp && cp.summaryStatus === "ok" && cp.summarizedCount > 1, JSON.stringify(cp));
    assert.ok(promptOf(kit.server.calls[0]!).includes("长任务"), "任务输入在被摘要的范围内");
    assert.ok(textOf(last.view[0]).startsWith("[压缩摘要 · 较早的 "));
    assert.equal(textOf(last.view[1]), "长任务", "任务输入原文紧接在摘要块之后");
    assert.equal(last.view[2].role, "assistant");
    assert.equal(checkToolPairing(last.view), null);
  } finally {
    await kit.close();
  }
});

for (const variant of [
  { name: "报错", summary: async (): Promise<MockResponse> => { throw new Error("boom"); }, error: /^摘要调用失败/, requests: 1 },
  { name: "超时", summary: async (): Promise<MockResponse> => { await new Promise((r) => setTimeout(r, 3_000)); return { kind: "text", text: "迟到" }; }, error: /^摘要超时（0\.3 s）$/, requests: 1 },
  { name: "输出触顶", summary: async (): Promise<MockResponse> => ({ kind: "text", text: "半截", finishReason: "length" }), error: /token cap/, requests: 1 },
  { name: "摘要模型不可用", summary: async (): Promise<MockResponse> => ({ kind: "text", text: "不应请求" }), error: /^摘要模型不可用/, requests: 0, missingModel: true },
]) {
  test(`组装：摘要${variant.name}时只保留第一层；冷却期内不再请求摘要；压缩后仍超预算时视图含移出标记`, async () => {
    // 窄窗口：输入预算低于高水位
    const kit = await startKit(`compact-fail-${variant.requests}-${variant.error.source.length}`, variant.summary, 40_000);
    kit.deps.compaction = { summaryTimeoutMs: 300 };
    try {
      if (variant.missingModel) fs.writeFileSync(path.join(kit.dirs.agentDir, "summary-model.json"), JSON.stringify({ provider: "mock", modelId: "missing" }));
      const { session } = kit.project();
      const finishedEvent = () => compactionEvents(kit).find((e) => e.phase === "finished");
      const messages: any[] = [];
      let last!: Sent;
      // 每个长文任务先调一次小工具再回答：同一任务第二次调用落在冷却期内
      for (let n = 1; n <= 6 && !finishedEvent(); n++) {
        const assembly = kit.begin(kit.task(session, longInput(n)), session);
        messages.push(user(longInput(n)));
        await kit.send(assembly, messages);
        messages.push(call(`d${n}`, "mock_delay", { ms: 1 }), result(`d${n}`, "delayed:1", "mock_delay"));
        last = await kit.send(assembly, messages);
        messages.push(reply("读完"));
      }
      const finished = finishedEvent();
      assert.ok(finished, "应有压缩完成事件");
      assert.equal(finished.summaryStatus, "failed");
      assert.match(finished.summaryError, variant.error);
      assert.equal(finished.checkpointId, null, "长文无可清理结果：只做清理收益不足，不建压缩点");
      assert.match(compactionText(finished), /^上下文未压缩：摘要失败/);
      assert.equal(kit.server.calls.length, variant.requests, "同一任务第二次调用在冷却期内，不再请求摘要；已配置的摘要模型不可用时不改用会话模型");
      assert.ok(last.view.map(textOf).some((t) => /^\[较早的 \d+ 轮交互未进入本次上下文 · \S+ 至 \S+\]$/.test(t)), "视图含移出标记");
      assert.equal(kit.store.getActiveCheckpoint(session.id), null);
    } finally {
      await kit.close();
    }
  });
}

test("组装：摘要等待期间中止，摘要请求随之中止，不交出视图也不建压缩点", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const kit = await startKit("compact-abort", async () => { await gate; return { kind: "text", text: "迟到" }; }, 40_000);
  try {
    const { session } = kit.project();
    const messages: any[] = [];
    let waiting: { assembly: ContextAssembly; assembling: Promise<unknown> } | null = null;
    for (let n = 1; n <= 6 && !waiting; n++) {
      const assembly = kit.begin(kit.task(session, longInput(n)), session);
      messages.push(user(longInput(n)));
      let done = false;
      const assembling = assembly.assemble(messages, kit.sdk()).finally(() => { done = true; });
      await waitFor("本次组装结束或摘要请求发出", () => done || kit.server.calls.length > 0, 30_000);
      if (kit.server.calls.length > 0) waiting = { assembly, assembling };
      messages.push(reply("读完"));
    }
    assert.ok(waiting, "应发出摘要请求");
    waiting.assembly.abort();
    const settled = await Promise.race([waiting.assembling, new Promise((r) => setTimeout(r, 5_000, "still-waiting").unref())]);
    assert.equal(settled, undefined, "中止即结束等待（未放行摘要响应），不交出视图");
    release();
    assert.equal(kit.store.getActiveCheckpoint(session.id), null);
    assert.deepEqual(compactionEvents(kit).map((e) => e.phase), ["started"], "没有完成事件");
  } finally {
    release();
    await kit.close();
  }
});

test("组装：资料受限会话（chat 角色、QQ 群）不压缩", async () => {
  const kit = await startKit("compact-chat", () => ({ kind: "text", text: "摘要" }));
  try {
    // 越过 H' 的历史：普通会话在这里会建压缩点（对照）
    const messages = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
      user(`大输出 ${n}`), call(`big${n}`, "mock_big"), result(`big${n}`, "y".repeat(40_000), "mock_big"), reply("ok"),
    ]).concat(user("闲聊"));
    const { projectId, session } = kit.project();
    const chat = kit.begin(kit.task(session, "闲聊"), session, { restricted: true, accessor: { kind: "role_restricted", projectId } });
    const { record } = await kit.send(chat, messages);
    assert.ok(record.estimatedTotal > HOST_H, "视图估算越过高水位");
    assert.equal(kit.server.calls.length, 0);
    assert.equal(compactionEvents(kit).length, 0);
    assert.equal((kit.store.db.prepare("SELECT COUNT(*) AS n FROM context_checkpoints").get() as any).n, 0);

    const dev = kit.project();
    await kit.send(kit.begin(kit.task(dev.session, "闲聊"), dev.session), messages);
    assert.ok(kit.store.getActiveCheckpoint(dev.session.id), "对照：普通会话建压缩点");
  } finally {
    await kit.close();
  }
});

// ---------- 宿主层（完整后台：会话文件、工具读回、重启与停止联动） ----------

const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };

/** 返回指定大小正文的工具；pad 参数只用来放大 toolCall 参数（参数不清理）。 */
const bigTool = defineTool({
  name: "mock_big",
  label: "Mock Big",
  description: "返回 size 个字符的正文。",
  parameters: Type.Object({ size: Type.Number(), tag: Type.String(), pad: Type.Optional(Type.String()) }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: `${p.tag}:${"y".repeat(p.size)}` }], details: {} }),
});

const isSummaryReq = (req: RecordedRequestLike & { system?: string | null }): boolean =>
  typeof req.system === "string" && req.system.includes("context summarization assistant");

type Routes = Parameters<typeof routeResponder>[0];
function responder(onSummary: (req: RecordedRequest) => MockResponse | Promise<MockResponse>, routes: Routes) {
  const main = routeResponder(routes);
  return (req: RecordedRequest, i: number) => (isSummaryReq(req) ? onSummary(req) : main(req, i));
}

interface Host {
  dirs: TestDirs;
  /** 会话工作目录。 */
  work: string;
  server: MockModelServer;
  runtime: Runtime;
  client: Awaited<ReturnType<typeof connectAuthedClient>>;
  config: Partial<RuntimeConfig>;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
  summaries(): RecordedRequest[];
  mains(): RecordedRequest[];
  events(): any[];
}

async function startHost(prefix: string, respond: ReturnType<typeof responder>, config: Partial<RuntimeConfig> = {
    product: personalProduct.runtime,}, contextWindow = 200_000): Promise<Host> {
  const { dirs, work } = await makeTestDirs(prefix, 1);
  const server = new MockModelServer(respond);
  await writeModelsJson(dirs, await server.start(), contextWindow);
  const full: Partial<RuntimeConfig> = {
    product: personalProduct.runtime,
    toolFactory: (ctx) => [...createMockTools(ctx), bigTool],
    ...config,
    budgetOverrides: { compactionHighWater: HOST_H, ...config.budgetOverrides },
  };
  const boot = async () => {
    const runtime = await Runtime.start({
    product: personalProduct.runtime,
      dataDir: dirs.dataDir, agentDir: dirs.agentDir, socketPath: path.join(dirs.root, "c.sock"),
      thinkingLevel: "off", modelProvider: "mock", modelId: "mock-model", ...full,
    });
    await ControlServer.start(runtime);
    const client = await connectAuthedClient(runtime);
    await client.handshake();
    return { runtime, client };
  };
  const host: Host = {
    dirs, work: work[0]!, server, config: full, ...(await boot()),
    async restart() {
      host.client.close();
      await host.runtime.stop("restart");
      Object.assign(host, await boot());
    },
    async shutdown() {
      host.client.close();
      await host.runtime.stop("test_end");
      await server.close();
      await cleanupDirs(dirs);
    },
    summaries: () => server.calls.filter(isSummaryReq),
    mains: () => server.calls.filter((r) => !isSummaryReq(r)),
    events: () => host.runtime.store.getEventsAfter(0).map((e) => e.body).filter((b: any) => b.type === "task.context_compaction"),
  };
  return host;
}

async function run(h: Host, sessionId: string, input: string, requestId = `r-${Math.random().toString(36).slice(2)}`): Promise<any> {
  const task = await h.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: requestId, input });
  await waitFor(`任务终态：${input.slice(0, 20)}`, async () => !["queued", "running", "awaiting_confirmation"].includes((await taskStatus(h.client, task.id)).task.status), 30_000);
  return (await taskStatus(h.client, task.id)).task;
}

test("集成：第一层——压缩点经完整后台生效：占位可用 history_read 读回、会话 JSONL 不变、发送后补记 usage、/context 显示、重启后继续生效", async () => {
  const h = await startHost("compact-l1", responder(() => ({ kind: "text", text: "不应请求摘要" }), [
    { match: /^大输出 (\d+)$/, respond: (req, text) => afterTool(req)
      ? { kind: "text", text: "ok" }
      : { kind: "tool_calls", calls: [{ id: `big${text.split(" ")[1]}`, name: "mock_big", arguments: { size: 40_000, tag: `T${text.split(" ")[1]}` } }] } },
    { match: /^读回 (\S+) (\S+)$/, respond: (req, text) => afterTool(req)
      ? { kind: "text", text: "读完" }
      : { kind: "tool_calls", calls: [{ id: "hr1", name: "history_read", arguments: { session_id: text.split(" ")[1], entry_id: text.split(" ")[2] } }] } },
  ]));
  try {
    const { sessionId } = await createProjectSession(h.client, h.work);
    let jsonlBefore = "";
    for (let n = 1; n <= 8 && !h.runtime.store.getActiveCheckpoint(sessionId); n++) {
      const file = h.runtime.store.getSession(sessionId)!.sessionFile;
      jsonlBefore = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      assert.equal((await run(h, sessionId, `大输出 ${n}`)).status, "completed");
    }
    const cp = h.runtime.store.getActiveCheckpoint(sessionId)!;
    assert.ok(cp, "应建立压缩点");
    const file = h.runtime.store.getSession(sessionId)!.sessionFile!;
    assert.ok(fs.readFileSync(file, "utf8").startsWith(jsonlBefore), "会话 JSONL 既有字节前缀不变");

    // 按占位里的条目 id 读回，与历史原文一致
    const placeholder = h.mains().at(-1)!.messages.map(hostText).find((t) => t.startsWith("[已清理"))!;
    const m = /^\[已清理 · mock_big · 原 (\d+) 字符 · 成功 · history_read session_id=(\S+) entry_id=(\S+)\]$/.exec(placeholder);
    assert.ok(m, placeholder);
    assert.equal(m[2], sessionId);
    assert.equal((await run(h, sessionId, `读回 ${m[2]} ${m[3]}`)).status, "completed");
    const readBack = hostText(h.mains().at(-1)!.messages.at(-1)!);
    assert.ok(readBack.includes(`条目 ${m[3]}`) && readBack.includes(`T1:${"y".repeat(200)}`), readBack.slice(0, 200));
    const entry = parseSessionFile(file).find((e) => e.id === m[3]) as any;
    assert.equal(entry.message.content[0].text, `T1:${"y".repeat(40_000)}`);

    // 选择记录与 /context
    const record = (await h.client.request<any>("list_selection_records", { session_id: sessionId, limit: 1 })).records[0];
    assert.equal(record.checkpointId, cp.id);
    assert.ok(record.usage, "发送后补记 usage");
    const ctx = await h.client.request<any>("get_context_breakdown", { session_id: sessionId, record_id: record.id });
    assert.ok(ctx.breakdown.categories.some((c: any) => c.key === "compactionSummary" && c.label === "压缩摘要"));
    assert.equal(ctx.checkpoint.clearedResults, cp.clearedResults);
    assert.equal(ctx.checkpoint.summary, undefined, "不回传摘要正文");

    // 重启后继续生效，不重新摘要
    await h.restart();
    assert.equal((await run(h, sessionId, "重启后")).status, "completed");
    assert.equal(h.mains().at(-1)!.messages.map(hostText).filter((t) => t.startsWith("[已清理")).length, cp.clearedResults);
    assert.equal(h.runtime.store.getActiveCheckpoint(sessionId)!.id, cp.id);
    assert.equal(h.summaries().length, 0);
  } finally {
    await h.shutdown();
  }
});

/** 窄窗口（输入预算 < 高水位）下的长文任务：每个任务先调一次小工具再回答。 */
const narrowRoutes: Routes = [
  { match: /^长文 /, respond: (req) => afterTool(req) ? { kind: "text", text: "读完" } : { kind: "tool_calls", calls: [{ id: `d${req.messages.length}`, name: "mock_delay", arguments: { ms: 1 } }] } },
];

test("集成：摘要等待期间停止任务，主模型请求数为零", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const h = await startHost("compact-stop", responder(async () => { await gate; return { kind: "text", text: "迟到" }; }, narrowRoutes), {}, 40_000);
  try {
    const { sessionId } = await createProjectSession(h.client, h.work);
    let stopped: any = null;
    for (let n = 1; n <= 6 && !stopped; n++) {
      const task = await h.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: `s${n}`, input: longInput(n) });
      await waitFor("任务结束或摘要请求发出", async () => h.summaries().length > 0 || (await taskStatus(h.client, task.id)).task.status === "completed", 30_000);
      if (h.summaries().length > 0) stopped = task;
    }
    assert.ok(stopped, "应发出摘要请求");
    const mainsBefore = h.mains().length;
    await h.client.request("interrupt", { task_id: stopped.id });
    await waitFor("任务中断", async () => (await taskStatus(h.client, stopped.id)).task.status === "interrupted");
    release();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.mains().length, mainsBefore, "停止后不发主模型请求");
  } finally {
    release();
    await h.shutdown();
  }
});

// ---------- 摘要模型配置 ----------

test("摘要模型配置（在线）：保存、清除、修订冲突、目录外模型拒绝；被引用的提供方或模型不能删除", async () => {
  const h = await startHost("summary-cfg", responder(() => ({ kind: "text", text: "x" }), []));
  const file = path.join(h.dirs.agentDir, "summary-model.json");
  try {
    const c = h.client;
    const v0 = await c.request<any>("get_model_config", {});
    assert.equal(v0.summaryModel, null);
    await assert.rejects(c.request("set_summary_model", { provider: "mock", model_id: "nope", expected_revision: v0.revision }), (err: any) => err.code === "invalid_params");
    await assert.rejects(c.request("set_summary_model", { provider: "mock", model_id: "mock-model", expected_revision: "stale" }), (err: any) => err.code === "config_conflict");
    const set = await c.request<any>("set_summary_model", { provider: "mock", model_id: "mock-model", expected_revision: v0.revision });
    assert.notEqual(set.revision, v0.revision, "修订指纹随 summary-model.json 变化");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { provider: "mock", modelId: "mock-model" });
    assert.deepEqual((await c.request<any>("get_model_config", {})).summaryModel, { provider: "mock", modelId: "mock-model" });

    // 另一个提供方被摘要模型引用时不能删除，也不能删掉其模型
    const providers = { ...(await c.request<any>("get_model_config", {})).providers };
    providers.alt = { ...providers.mock, name: "Alt", apiKey: "alt-key", models: [{ ...providers.mock.models[0], id: "alt-model" }] };
    const saved = await c.request<any>("save_model_catalog", { providers, expected_revision: set.revision });
    const onAlt = await c.request<any>("set_summary_model", { provider: "alt", model_id: "alt-model", expected_revision: saved.revision });
    await assert.rejects(c.request("remove_model_provider", { provider: "alt", expected_revision: onAlt.revision }),
      (err: any) => err.code === "provider_in_use" && err.message.includes("摘要模型"));
    await assert.rejects(c.request("save_model_catalog", { providers: { ...providers, alt: { ...providers.alt, models: [] } }, expected_revision: onAlt.revision }),
      (err: any) => err.code === "provider_in_use");
    const cleared = await c.request<any>("set_summary_model", { provider: null, model_id: null, expected_revision: onAlt.revision });
    assert.equal(cleared.summaryModel, null);
    assert.ok(!fs.existsSync(file), "清除即删除文件");
    await c.request("remove_model_provider", { provider: "alt", expected_revision: cleared.revision });
  } finally {
    await h.shutdown();
  }
});

test("摘要模型配置（离线）：保存、清除、目录外模型拒绝；被引用的提供方或模型不能删除；修订指纹随文件变化", async () => {
  const { dirs } = await makeTestDirs("summary-offline", 0);
  try {
    await writeModelsJson(dirs, "http://127.0.0.1:1");
    const backend = new OfflineModelBackend(dirs.agentDir);
    const rev0 = configRevision(dirs.agentDir);
    assert.equal((await backend.load()).summaryModel, null);
    await assert.rejects(backend.setSummaryModel({ provider: "mock", modelId: "nope" }), (err: any) => err.code === "invalid_params");
    await backend.setSummaryModel({ provider: "mock", modelId: "mock-model" });
    assert.notEqual(configRevision(dirs.agentDir), rev0);
    assert.deepEqual((await backend.load()).summaryModel, { provider: "mock", modelId: "mock-model" });
    await assert.rejects(backend.removeProvider("mock"), (err: any) => err.code === "provider_in_use" && err.message.includes("摘要模型"));
    const providers = (await backend.load()).providers;
    await assert.rejects(backend.saveCatalog({ ...providers, mock: { ...providers.mock, models: [] } }), (err: any) => err.code === "provider_in_use");
    await backend.setSummaryModel(null);
    assert.equal(configRevision(dirs.agentDir), rev0, "清除后回到原修订");
    await backend.removeProvider("mock");
  } finally {
    await cleanupDirs(dirs);
  }
});
