/**
 * issue 25：工作清单（todo_write 整表替换、装配范围、无审批、可重试、上下文保底、TUI 面板）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { parseTodos } from "../src/agent/todo.ts";
import {
  DEFAULT_BUDGET_CONFIG, estimateMessageTokens, getContextCandidates, selectContext, type SelectorInput,
} from "../src/agent/context-selector.ts";
import { EventFlow, type FlowEntry } from "../src/tui/event-flow.ts";
import { EventFlowView } from "../src/tui/event-flow-view.ts";
import { latestTodos, TodoPanel } from "../src/tui/todo-panel.ts";
import type { Responder } from "./helpers/mock-provider.ts";
import { createProjectSession, lastUserText, startTestRuntime, taskStatus, waitFor, type TestRuntime } from "./helpers/testkit.ts";

initTheme("dark");
const MODEL = { provider: "mock", modelId: "mock-model", thinkingLevel: "off" };
type Todo = { content: string; status: string };
const todos = (...items: Array<[string, string]>): Todo[] => items.map(([content, status]) => ({ content, status }));

function toolNames(req: { tools?: Array<Record<string, unknown>> }): string[] {
  return (req.tools ?? []).map((t: any) => t?.function?.name ?? t?.name);
}

/** 当前任务（最后一条 user 之后）已有的工具结果数。 */
function toolResultsSinceUser(req: { messages: Array<Record<string, unknown>> }): number {
  const last = req.messages.map((m) => m.role).lastIndexOf("user");
  return req.messages.slice(last + 1).filter((m) => m.role === "tool").length;
}

const todoCall = (id: string, list: unknown) => ({ kind: "tool_calls" as const, calls: [{ id, name: "todo_write", arguments: { todos: list } }] });

async function submit(t: TestRuntime, sessionId: string, requestId: string, input: string, extra: Record<string, unknown> = {}): Promise<any> {
  return t.client.request<any>("submit", { model_selection: MODEL, session_id: sessionId, request_id: requestId, input, ...extra });
}

async function waitDone(t: TestRuntime, taskId: string): Promise<any> {
  await waitFor("任务终态", async () => ["completed", "failed", "interrupted", "canceled"].includes((await taskStatus(t.client, taskId)).task.status));
  return taskStatus(t.client, taskId);
}

/** TUI 的恢复路径：按会话已加载的工具记录投影，再取最近一次成功 todo_write。 */
async function currentList(t: TestRuntime, sessionId: string): Promise<unknown[] | null> {
  const flow = new EventFlow();
  const listed = await t.client.request<any>("list_tasks", { session_id: sessionId, limit: 50 });
  for (const task of listed.tasks) for (const op of (await taskStatus(t.client, task.id)).toolOps) flow.tool(op);
  return latestTodos(flow.tools);
}

// ---------- 校验（单元） ----------

test("parseTodos：整表校验，超限/空/过长/非法状态明确报错不截断", () => {
  assert.deepEqual(parseTodos([]), []);
  assert.deepEqual(parseTodos(todos(["读代码", "completed"], ["改代码", "in_progress"], ["跑测试", "pending"])).map((x) => x.status),
    ["completed", "in_progress", "pending"]);
  assert.equal(parseTodos(todos(["x".repeat(120), "pending"]))[0]!.content.length, 120, "120 字符为上限内");
  assert.equal(parseTodos(Array.from({ length: 20 }, (_, i) => ({ content: `步骤${i}`, status: "pending" }))).length, 20);
  assert.throws(() => parseTodos(Array.from({ length: 21 }, (_, i) => ({ content: `步骤${i}`, status: "pending" }))), /最多 20 项.*21/);
  assert.throws(() => parseTodos(todos(["   ", "pending"])), /第 1 项.*不能为空/);
  assert.throws(() => parseTodos(todos(["ok", "pending"], ["x".repeat(121), "pending"])), /第 2 项.*超过 120 字符/);
  assert.throws(() => parseTodos(todos(["ok", "done"])), /第 1 项.*status.*done/);
  assert.throws(() => parseTodos([{ status: "pending" }]), /第 1 项.*content/);
  assert.throws(() => parseTodos("a,b"), /数组/);
  assert.throws(() => parseTodos(todos(["   ", "pending"])), /当前清单不变/);
});

// ---------- 上下文保底（选择器） ----------

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 0 });
const result = (id: string, name: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 });

function selectorInput(messages: any[], budget = 1_000_000): SelectorInput {
  return {
    messages, systemPrompt: "", tools: [], memories: [],
    budget: { ...DEFAULT_BUDGET_CONFIG, contextWindow: budget + 1, maxTokens: 1, thinkingBudget: 0,
      toolResultReserve: 0, safetyMargin: 0, memoryBudget: 0, calibration: 1, toolResultViewChars: 100_000 },
  };
}

test("选择器：当前任务最近一次成功 todo_write 所在批次必留、不作 Jev 候选、计入当前任务", () => {
  const big = (tag: string) => `${tag}${"甲".repeat(800)}`;
  const messages = [
    user("旧任务"), call("old", "todo_write", { todos: todos(["旧步骤", "pending"]) }), result("old", "todo_write", "已更新：完成 0/1"),
    user("当前任务"),
    call("t1", "todo_write", { todos: todos(["步骤一", "in_progress"]) }), result("t1", "todo_write", "已更新：完成 0/1"), // 4,5
    call("b1", "bash", { command: "x" }), result("b1", "bash", big("批次一")), // 6,7
    call("b2", "bash", { command: "x" }), result("b2", "bash", big("批次二")), // 8,9
    call("t2", "todo_write", { todos: "坏参数" }), result("t2", "todo_write", "todos 必须是数组", true), // 10,11 失败的调用不算
    call("b3", "bash", { command: "x" }), result("b3", "bash", big("批次三")), // 12,13
  ];
  const tokens = (indices: number[]) => indices.reduce((n, i) => n + estimateMessageTokens(messages[i], 1), 0);
  const fixed = selectContext(selectorInput(messages)).estimates.systemPrompt;
  const mandatory = [3, 4, 5, 12, 13];
  // 预算：必留 + 失败 todo 批次，放不下批次二
  const out = selectContext(selectorInput(messages, fixed + tokens(mandatory) + tokens([10, 11]) + 10));
  assert.ok(out.ok, out.failure);
  assert.deepEqual(out.includedIndices, [3, 4, 5, 10, 11, 12, 13]);
  assert.equal(out.estimates.mandatoryTurn, tokens(mandatory), "todo 批次计入「当前任务」");
  const reasons = new Map(out.excluded.map((e) => [e.index, e.reason]));
  for (const i of [6, 7, 8, 9]) assert.equal(reasons.get(i), "budget", `更早的普通批次 ${i} 按原规则移出`);
  assert.equal(reasons.get(1), "budget", "以往任务整轮移出，不单独保底旧清单");

  const candidates = getContextCandidates(selectorInput(messages)).map((c) => c.id);
  assert.deepEqual(candidates, ["unit_10", "unit_8", "unit_6", "unit_0"], "todo 批次不在 Jev 候选中");
  assert.throws(() => selectContext(selectorInput(messages), new Map([["unit_4", false]])), /无效候选/);

  // 最新批次本身就是 todo_write：不重复计入
  const tail = [user("任务"), call("b", "bash", {}), result("b", "bash", "ok"), call("t", "todo_write", { todos: [] }), result("t", "todo_write", "已清空")];
  const tailOut = selectContext(selectorInput(tail));
  assert.equal(tailOut.estimates.mandatoryTurn, [0, 3, 4].reduce((n, i) => n + estimateMessageTokens(tail[i], 1), 0));
  assert.deepEqual(getContextCandidates(selectorInput(tail)).map((c) => c.id), ["unit_1"]);
});

// ---------- TUI（单元） ----------

const toolEntry = (params: Record<string, unknown>, status: "done" | "error" | "running" = "done", name = "todo_write") =>
  ({ name, status, params });

test("latestTodos：取最近一次成功 todo_write 的参数；失败、运行中与其他工具不算", () => {
  const a = todos(["a", "pending"]);
  const b = todos(["b", "completed"]);
  assert.equal(latestTodos([]), null);
  assert.deepEqual(latestTodos([toolEntry({ todos: a }), toolEntry({ todos: "x" }, "error"), toolEntry({ todos: b }, "running"), toolEntry({ path: "x" }, "done", "read")]), a);
  assert.deepEqual(latestTodos([toolEntry({ todos: a }), toolEntry({ todos: b })]), b);
  assert.deepEqual(latestTodos([toolEntry({ todos: a }), toolEntry({ todos: [] })]), []);
  assert.deepEqual(latestTodos([toolEntry({ todos: a }), toolEntry({})]), a, "尚未补齐参数的历史行不覆盖");
});

test("工作清单面板：三种状态、已完成暗色；超过 8 行先省略已完成再截取；无清单/空/全部完成时隐藏", () => {
  const panel = new TodoPanel();
  const plain = () => panel.render(40).map((line) => stripTerminalSequences(line).trimEnd());
  assert.deepEqual(plain(), []);
  panel.set(todos(["读代码", "completed"], ["改代码", "in_progress"], ["跑测试", "pending"]));
  assert.deepEqual(plain(), [" ☑ 读代码", " ▶ 改代码", " ☐ 跑测试"]);
  assert.match(panel.render(40)[0]!, /\x1b\[2m/, "已完成暗色");
  assert.doesNotMatch(panel.render(40)[1]!, /\x1b\[2m/);

  const many = (done: number, open: number) => [
    ...Array.from({ length: done }, (_, i) => ({ content: `完成${i}`, status: "completed" })),
    ...Array.from({ length: open }, (_, i) => ({ content: `待做${i}`, status: i === 0 ? "in_progress" : "pending" })),
  ];
  panel.set(many(2, 6));
  assert.equal(plain().length, 8, "8 项不省略");
  panel.set(many(3, 7));
  assert.deepEqual(plain(), [" ▶ 待做0", ...Array.from({ length: 6 }, (_, i) => ` ☐ 待做${i + 1}`), " …另 3 项"]);
  panel.set(many(1, 8));
  assert.deepEqual(plain().slice(-2), [" ☐ 待做6", " …另 2 项"], "省略已完成后仍超 8 行：截取");
  panel.set(many(2, 12));
  assert.equal(plain().length, 8);
  assert.equal(plain().at(-1), " …另 7 项");

  panel.set(todos(["多行\n内容", "pending"]));
  assert.deepEqual(plain(), [" ☐ 多行 内容"], "内容单行显示");
  panel.set([]);
  assert.deepEqual(plain(), []);
  panel.set(todos(["a", "completed"], ["b", "completed"]));
  assert.deepEqual(plain(), [], "全部完成时隐藏");
  panel.set(null);
  assert.deepEqual(plain(), []);
});

test("事件流：todo_write 每次更新一行完成数/总数，不展开清单", () => {
  const flow = new EventFlow();
  flow.apply({ seq: 1, createdAt: new Date().toISOString(), sessionId: "s", taskId: "t", body: {
    type: "task.tool_intent", taskId: "t", toolOpId: "op1", sdkCallId: "c1", toolName: "todo_write",
    params: { todos: todos(["a", "completed"], ["b", "completed"], ["c", "completed"], ["d", "in_progress"], ["e", "pending"], ["f", "pending"], ["g", "pending"]) },
  } } as any);
  const view = new EventFlowView();
  view.setEntries(flow.items as FlowEntry[]);
  assert.deepEqual(view.render(80).map((line) => stripTerminalSequences(line).trimEnd()), ["● todo_write", "  ⎿ 3/7"]);
});

// ---------- 集成 ----------

test("集成：开发会话与 coding 装配 todo_write，main/chat 不装配", async () => {
  const t = await startTestRuntime("todo-roles", async () => ({ kind: "text", text: "ok" }));
  try {
    const orch = t.runtime.orchestrator!;
    await orch.registerInboundEvent({ source: "test", externalId: "chat-t", targetRole: "chat", body: "CHAT-TODO-MARK" });
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const dev = await submit(t, sessionId, "d1", "DEV-TODO-MARK");
    const main = t.runtime.store.getAgentRole("main")!;
    const coding = t.runtime.store.getAgentRole("coding")!;
    const m = await t.runtime.submit({ sessionId: main.sessionId, requestId: "m-t", input: "MAIN-TODO-MARK", modelSelection: t.runtime.defaultSelection });
    const c = await t.runtime.submit({ sessionId: coding.sessionId, requestId: "c-t", input: "CODING-TODO-MARK", modelSelection: t.runtime.defaultSelection });
    await waitDone(t, dev.id);
    await waitFor("main/coding 完成", () => t.runtime.store.getTask(m.id)!.status === "completed" && t.runtime.store.getTask(c.id)!.status === "completed");
    await waitFor("chat 完成", () => t.runtime.store.getInboundEvent(t.runtime.store.findInboundEvent("test", "chat-t")!.id)!.status === "done");
    const tools = (mark: string) => toolNames(t.server.calls.find((x) => lastUserText(x).includes(mark))!);
    assert.ok(tools("DEV-TODO-MARK").includes("todo_write"), "开发会话");
    assert.ok(tools("CODING-TODO-MARK").includes("todo_write"), "coding 角色");
    assert.ok(!tools("MAIN-TODO-MARK").includes("todo_write"), "main 不装配");
    assert.ok(!tools("CHAT-TODO-MARK").includes("todo_write"), "chat 不装配");
  } finally {
    await t.shutdown();
  }
});

test("集成：整表替换与校验、三种访问模式无审批、跨任务延续、新会话没有工作清单", async () => {
  const listA = todos(["读代码", "pending"], ["改代码", "pending"], ["跑测试", "pending"]);
  const listB = todos(["读代码", "completed"], ["改代码", "in_progress"], ["跑测试", "pending"]);
  const scripts: Record<string, unknown[]> = {
    "第一步": [listA, listB, Array.from({ length: 21 }, (_, i) => ({ content: `步骤${i}`, status: "pending" })),
      todos(["  ", "pending"]), todos(["x".repeat(121), "pending"]), todos(["读代码", "done"])],
    "继续": [todos(["", "pending"]), [{ content: "带额外字段", status: "pending", priority: "high" }]],
    "收尾": [todos(["读代码", "completed"], ["改代码", "completed"], ["跑测试", "completed"])],
    "清空": [[]],
  };
  const responder: Responder = async (req) => {
    const step = toolResultsSinceUser(req);
    const script = Object.entries(scripts).find(([mark]) => lastUserText(req).includes(mark))?.[1] ?? [];
    return step < script.length ? todoCall(`c${step}`, script[step]) : { kind: "text", text: "好的" };
  };
  const t = await startTestRuntime("todo-flow", responder);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const run = async (id: string, input: string, mode: string) => {
      const status = await waitDone(t, (await submit(t, sessionId, id, input, { access_mode: mode })).id);
      assert.equal(status.task.status, "completed", input);
      assert.equal(status.confirmations.length, 0, `${mode} 下不产生审批`);
      return status;
    };

    const first = await run("r1", "第一步", "confirm");
    const ops = first.toolOps as any[];
    assert.deepEqual(ops.map((op) => op.isError), [false, false, true, true, true, true]);
    assert.equal(ops[1].resultSummary, "已更新：完成 1/3", "结果只返回摘要");
    assert.match(ops[2].resultSummary, /最多 20 项/);
    assert.deepEqual(await currentList(t, sessionId), listB, "当前清单 = 最后一次成功调用；失败调用不改变");

    await run("r2", "继续", "full_access");
    assert.deepEqual(await currentList(t, sessionId), listB, "下一任务开始时仍是上一任务的清单；额外字段被拒绝");

    await run("r3", "收尾", "auto-review");
    assert.deepEqual((await currentList(t, sessionId))!.map((x: any) => x.status), ["completed", "completed", "completed"]);

    await run("r4", "清空", "confirm");
    assert.deepEqual(await currentList(t, sessionId), [], "空数组清空");

    const fresh = await createProjectSession(t.client, t.work[1]!);
    await waitDone(t, (await submit(t, fresh.sessionId, "n1", "你好")).id);
    assert.equal(await currentList(t, fresh.sessionId), null, "新会话没有清单");
  } finally {
    await t.shutdown();
  }
});

test("集成：委派的 analyze 子任务含 todo_write；工具记录只有 todo_write 时失败仍自动重试一次", async () => {
  let failed = false;
  const responder: Responder = async (req) => {
    const text = lastUserText(req);
    if (text.includes("请求-todo")) {
      if (toolResultsSinceUser(req) === 0) return todoCall("t", todos(["分析", "in_progress"]));
      if (!failed) {
        failed = true;
        throw new Error("模型故障（首次）");
      }
      return { kind: "text", text: "重试成功\n测试：未运行\n需要拥有者：否" };
    }
    if (text.includes("[编排器]")) return { kind: "text", text: "已汇报" };
    if (req.messages.some((m) => m.role === "tool")) return { kind: "text", text: "已委派" };
    return { kind: "tool_calls", calls: [{ id: "d", name: "coding_delegate", arguments: { request: "请求-todo", mode: "analyze", key: "td" } }] };
  };
  const t = await startTestRuntime("todo-retry", responder);
  try {
    const rt = t.runtime;
    const main = rt.store.getAgentRole("main")!;
    const parent = await rt.submit({ sessionId: main.sessionId, requestId: "p", input: "委派分析", modelSelection: rt.defaultSelection });
    await waitFor("委派已创建", () => rt.store.countDelegations(parent.id) === 1);
    await waitFor("重试子任务完成", () => {
      const retry = rt.store.findChildTask(parent.id, `deleg:${parent.id}:td:retry`);
      return retry !== null && rt.store.getTask(retry.id)!.status === "completed";
    }, 30_000);
    const child = rt.store.findChildTask(parent.id, `deleg:${parent.id}:td`)!;
    assert.equal(rt.store.getTask(child.id)!.status, "failed");
    assert.deepEqual(rt.store.listToolOpsByTask(child.id).map((op) => op.toolName), ["todo_write"]);
    const childCall = t.server.calls.find((x) => lastUserText(x).includes("请求-todo"))!;
    assert.ok(toolNames(childCall).includes("todo_write"), "委派子任务的工具集含 todo_write");
  } finally {
    await t.shutdown();
  }
});

test("集成：预算不足时最近一次成功 todo_write 所在批次仍在模型上下文，更早的普通批次移出", async () => {
  const batches = 8;
  // 模型视图会被修剪，按调用序号推进（不能数视图里的工具结果）
  const responder: Responder = async (_req, step) => {
    if (step === 0) return todoCall("todo", todos(["长任务", "in_progress"]));
    if (step <= batches) {
      return { kind: "tool_calls", calls: [{ id: `g${step}`, name: "mock_gate", arguments: { note: `GATE-${step}-${"甲".repeat(3000)}` } }] };
    }
    return { kind: "text", text: "完成" };
  };
  const t = await startTestRuntime("todo-budget", responder, { contextWindow: 40_000, config: { budgetOverrides: { toolResultReserve: 0, safetyMargin: 0 } } });
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    const status = await waitDone(t, (await submit(t, sessionId, "b1", "长任务")).id);
    assert.equal(status.task.status, "completed", status.task.interruptReason ?? status.task.errorMessage ?? "");
    const last = JSON.stringify(t.server.calls.at(-1)!.messages);
    assert.ok(last.includes("todo_write"), "todo_write 批次仍在模型视图");
    assert.ok(!last.includes("GATE-1-"), "更早的普通批次按原规则移出");
    assert.ok(last.includes(`GATE-${batches}-`), "最新批次必留");

    const records = t.runtime.listSelectionRecords({ taskId: status.task.id }) as any[];
    const record = records.find((r) => r.totalMessages === 2 * batches + 3)!;
    assert.ok(record.includedIndices.includes(1) && record.includedIndices.includes(2), "todo 批次（序号 1、2）被纳入");
    assert.ok(record.excluded.some((e: any) => e.index === 3 && e.reason === "budget"));
    const breakdown = await t.client.request<any>("get_context_breakdown", { session_id: sessionId, record_id: record.id });
    const current = breakdown.breakdown.categories.find((c: any) => c.key === "mandatoryTurn");
    assert.equal(current.label, "当前任务");
    assert.equal(current.tokens, record.estimates.mandatoryTurn);
  } finally {
    await t.shutdown();
  }
});
