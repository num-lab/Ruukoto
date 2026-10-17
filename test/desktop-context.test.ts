import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpParams } from "@ruukoto/control/ops.ts";
import type { PersistentEvent, SelectionRecord, Session } from "@ruukoto/core/types.ts";
import { selectionBreakdown } from "@ruukoto/agent/context-selector.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { DesktopContext } from "../apps/desktop/src/renderer/context-state.ts";
import { DESKTOP_OPS, handleRequest, ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

const at = "2026-10-16T00:00:00.000Z";
function session(id: string): Session {
  return { id, projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: id, sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, createdAt: at };
}
function record(sessionId = "a", id = "latest", overrides: Partial<SelectionRecord> = {}): SelectionRecord {
  return { id, sessionId, taskId: "task", callIndex: 1, strategy: "deterministic-v1", configVersion: 1, model: "mock/model", totalMessages: 3, includedIndices: [0, 1, 2], excluded: [], includedMemories: [], excludedMemories: [], instructionVersion: "", cappedToolResults: [], estimates: { systemPrompt: 100, toolSchemas: 200, memories: 100, mandatoryTurn: 600 }, budget: 1000, estimatedTotal: 1000, usage: { input: 999_999, output: 111 }, promptArtifactId: null, windowSnapshot: { contextWindow: 2000, maxTokens: 500, thinkingBudget: 100, toolResultReserve: 300, safetyMargin: 100 }, createdAt: at, ...overrides };
}
const detail = (value = record()) => ({ record: value, breakdown: selectionBreakdown(value), checkpoint: null });
function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
function harness(handlers: FakeHandlers = {}, target: "code" | "personal" = "code") {
  const transport = new FakeTransport({ handlers: { list_prompt_requests: params => ({ records: [record(params.session_id)], hasMore: false }), get_context_breakdown: params => detail(record(params.session_id, params.record_id)), ...handlers } });
  const view = new ViewState();
  view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [session("a"), session("b")] }), replay: [], seq: 0 }, false);
  const bridge: Pick<DesktopBridge, "request"> = { request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) };
  let changed = 0;
  const context = new DesktopContext(bridge, view, () => { changed++; }, target);
  const snapshot = (instanceId = "inst-1") => {
    const update: Extract<DesktopUpdate, { type: "snapshot" }> = { type: "snapshot", result: { snapshot: fakeSnapshot({ instanceId, sessions: [session("a"), session("b")] }), replay: [], seq: 100 }, instanceChanged: view.instanceId !== instanceId };
    view.applySnapshot(update.result, update.instanceChanged);
    context.update(update);
  };
  return { context, view, transport, snapshot, changes: () => changed };
}

test("Desktop Context 读取最新选择记录，三分类与窗口来自当时估算而非 provider usage", async () => {
  const h = harness();
  assert.deepEqual(h.context.get("a"), { loading: false, error: null, missing: false, value: null });
  const loading = h.context.load("a");
  assert.equal(h.context.get("a").loading, true);
  assert.equal(h.context.load("a"), loading, "在途读取去重");
  await loading;
  assert.deepEqual(h.transport.requests.map(request => ({ op: request.op, params: request.params })), [
    { op: "list_prompt_requests", params: { session_id: "a", limit: 1 } },
    { op: "get_context_breakdown", params: { session_id: "a", record_id: "latest" } },
  ]);
  const state = h.context.get("a");
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  assert.equal(state.value?.record.usage?.input, 999_999, "保留原始记录，不拿 usage 推算用量");
  assert.deepEqual(state.value?.display, { systemTokens: 100, toolTokens: 200, messageTokens: 700, usedTokens: 1000, maxTokens: 2000, usedPercent: 50 });
  assert.equal(h.context.get("b").value, null);
  await h.context.load("a");
  assert.equal(h.transport.requests.length, 4, "显式打开详情重新读取");
  assert.ok(h.changes() >= 4);
});

test("Desktop Context 无记录和旧记录无窗口保持未知，不替补容量或伪造零占用", async () => {
  const missing = harness({ list_prompt_requests: () => ({ records: [], hasMore: false }) });
  await missing.context.load("a");
  assert.deepEqual(missing.context.get("a"), { loading: false, error: null, missing: true, value: null });
  assert.equal(missing.transport.requests.length, 1);
  const old = harness({ get_context_breakdown: () => detail(record("a", "latest", { windowSnapshot: null })) });
  await old.context.load("a");
  assert.equal(old.context.get("a").value?.display.usedTokens, 1000);
  assert.equal(old.context.get("a").value?.display.maxTokens, null);
  assert.equal(old.context.get("a").value?.display.usedPercent, null);
  assert.ok(old.context.get("a").value?.breakdown.windowUnavailableReason);
});

test("Desktop Context 读取错误可见且可手动重试，不保留过期数字", async () => {
  let fail = false;
  const h = harness({ get_context_breakdown: () => { if (fail) throw new Error("读取失败"); return detail(); } });
  await h.context.load("a");
  fail = true;
  await h.context.load("a");
  assert.equal(h.context.get("a").loading, false);
  assert.equal(h.context.get("a").value, null);
  assert.match(h.context.get("a").error!, /读取 Context 失败.*重试/);
  fail = false;
  await h.context.load("a");
  assert.equal(h.context.get("a").error, null);
  assert.equal(h.context.get("a").value?.display.usedPercent, 50);
});

for (const op of ["list_prompt_requests", "get_context_breakdown"] as const) for (const fails of [false, true]) test(`Desktop Context 快照换代丢弃 ${op} 迟到${fails ? "错误" : "结果"}`, async () => {
  const blocked = gate();
  let fresh = false;
  let waiting = false;
  const pause = async (name: string) => {
    if (name !== op || fresh) return;
    waiting = true;
    await blocked.wait;
    if (fails) throw new Error("旧代次错误");
  };
  const h = harness({
    list_prompt_requests: async () => { const id = fresh ? "fresh" : "stale"; await pause("list_prompt_requests"); return { records: [record("a", id)], hasMore: false }; },
    get_context_breakdown: async params => { await pause("get_context_breakdown"); return detail(record("a", params.record_id)); },
  });
  const old = h.context.load("a");
  await waitFor("旧 Context 请求在途", () => waiting);
  fresh = true;
  h.snapshot();
  await h.context.load("a");
  blocked.release();
  await old;
  assert.equal(h.context.get("a").value?.record.id, "fresh");
  assert.equal(h.context.get("a").error, null);
  if (op === "list_prompt_requests") assert.ok(!h.transport.requests.some(request => request.op === "get_context_breakdown" && (request.params as OpParams<"get_context_breakdown">).record_id === "stale"));
});

test("Desktop Context 实例与会话隔离，旧实例错误不覆盖当前实例", async () => {
  const blocked = gate();
  let oldInstance = true;
  const h = harness({ get_context_breakdown: async params => { const old = oldInstance; if (old && params.session_id === "a") { await blocked.wait; throw new Error("旧实例错误"); } return detail(record(params.session_id, params.record_id)); } });
  const old = h.context.load("a");
  await waitFor("原会话详情在途", () => h.transport.requests.some(request => request.op === "get_context_breakdown"));
  h.view.currentSessionId = "b";
  await h.context.load("b");
  assert.equal(h.context.get("b").value?.record.sessionId, "b");
  oldInstance = false;
  h.snapshot("other");
  assert.equal(h.context.get("a").value, null);
  await h.context.load("a");
  blocked.release();
  await old;
  assert.equal(h.context.get("a").value?.record.sessionId, "a");
  assert.equal(h.context.get("a").error, null);
});

test("Desktop Context 拒绝会话或记录不匹配的 wire 响应", async () => {
  for (const handlers of [
    { list_prompt_requests: () => ({ records: [record("b")], hasMore: false }) },
    { get_context_breakdown: () => detail(record("b")) },
    { get_context_breakdown: () => detail(record("a", "wrong")) },
  ]) {
    const h = harness(handlers);
    await h.context.load("a");
    assert.equal(h.context.get("a").value, null);
    assert.match(h.context.get("a").error!, /不属于|不一致/);
  }
});

test("Desktop Context 断线清除旧值，快照及当前会话终态刷新，其他会话和 replay 不触发", async () => {
  const h = harness();
  h.view.currentSessionId = "a";
  h.snapshot();
  await h.context.load("a");
  assert.equal(h.transport.requests.length, 2);
  h.context.update({ type: "state", state: "reconnecting" });
  assert.equal(h.context.get("a").value, null);
  await h.context.load("a");
  assert.equal(h.transport.requests.length, 2);
  h.context.update({ type: "state", state: "online" });
  await h.context.load("a");
  assert.equal(h.transport.requests.length, 4);
  const event: PersistentEvent = { seq: 101, taskId: "task", sessionId: "a", createdAt: at, body: { type: "task.completed", taskId: "task", sessionId: "a" } };
  h.context.update({ type: "event", event, kind: "replay" });
  assert.equal(h.transport.requests.length, 4);
  h.view.currentSessionId = "b";
  h.context.update({ type: "event", event, kind: "live" });
  assert.equal(h.transport.requests.length, 4);
  h.view.currentSessionId = "a";
  h.context.update({ type: "event", event, kind: "live" });
  await h.context.load("a");
  assert.equal(h.transport.requests.length, 6);
});

test("Desktop 双目标开放 Context 只读入口，不开放 prompt 原文", async () => {
  for (const op of ["list_prompt_requests", "get_context_breakdown"] as const) {
    assert.ok(DESKTOP_OPS.includes(op));
    const result = await handleRequest("code", op, {}, async () => {}, async name => name);
    assert.deepEqual(result, { ok: true, value: op });
    const personal = await handleRequest("personal", op, {}, async () => {}, async name => name);
    assert.deepEqual(personal, { ok: true, value: op });
  }
  const blocked = await handleRequest("code", "read_prompt_snapshot", {}, async () => {}, async () => { throw new Error("不应发送"); });
  assert.equal(blocked.ok, false);
  const personal = harness({}, "personal");
  await personal.context.load("a");
  assert.equal(personal.transport.requests.length, 2);
  assert.equal(personal.context.get("a").value?.record.sessionId, "a");
});

test("Desktop Context 在途读取遇到新终态后补读最新记录，合并重复刷新", async () => {
  const blocked = gate();
  let latest = "old";
  const h = harness({
    list_prompt_requests: () => ({ records: [record("a", latest)], hasMore: false }),
    get_context_breakdown: async params => { if (params.record_id === "old") await blocked.wait; return detail(record("a", params.record_id)); },
  });
  h.view.currentSessionId = "a";
  const reading = h.context.load("a");
  await waitFor("旧详情在途", () => h.transport.requests.some(request => request.op === "get_context_breakdown"));
  latest = "new";
  const event: PersistentEvent = { seq: 1, sessionId: "a", taskId: "task", createdAt: at, body: { type: "task.completed", sessionId: "a", taskId: "task" } };
  h.context.update({ type: "event", event, kind: "live" });
  h.context.update({ type: "event", event, kind: "live" });
  blocked.release();
  await reading;
  assert.equal(h.context.get("a").value?.record.id, "new");
  assert.equal(h.transport.requests.filter(request => request.op === "list_prompt_requests").length, 2);
});
