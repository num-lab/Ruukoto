import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ModelSelection, SelectionRecord, Session } from "@ruukoto/core/types.ts";
import { selectionBreakdown } from "@ruukoto/agent/context-selector.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { CodeWrites } from "../apps/desktop/src/renderer/code-writes.ts";
import type { DesktopContextState } from "../apps/desktop/src/renderer/context-state.ts";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

type ModelOption = OpResult<"list_models">["models"][number];
let server: ViteDevServer;
let Composer: ComponentType<{ model: CodeState; session: Session }>;
let ContextDetails: ComponentType<{ context: DesktopContextState }>;
let ContextIndicator: ComponentType<{ context: DesktopContextState; onOpen: () => void }>;
let selectionForModel: (option: ModelOption, current: ModelSelection | null) => ModelSelection | null;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ Composer, selectionForModel } = await server.ssrLoadModule("/composer.tsx"));
  ({ ContextDetails, ContextIndicator } = await server.ssrLoadModule("/context-indicator.tsx"));
});
after(async () => { await server?.close(); });

const selection: ModelSelection = { provider: "mock", modelId: "model", thinkingLevel: "high" };
const option = (overrides: Partial<ModelOption> = {}): ModelOption => ({ provider: "mock", modelId: "model", name: "Current model", contextWindow: 200_000, maxTokens: 1000, thinkingLevels: ["off", "high"], available: true, errorCode: null, ...overrides });
const at = "2026-10-16T00:00:00.000Z";
function session(): Session {
  return { id: "a", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: selection, modelSelectionVersion: 1, defaultAccessMode: "auto-review", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, createdAt: at };
}
function harness(handlers: FakeHandlers = {}, request?: DesktopBridge["request"]) {
  const transport = new FakeTransport({ handlers });
  const bridge: Pick<DesktopBridge, "request"> = { request: request ?? ((_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>))) };
  const model = new CodeState(bridge, () => {});
  const current = session();
  model.view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [current] }), replay: [], seq: 0 }, false);
  model.status = { type: "state", state: "online" };
  model.writes.models = [option()];
  return { model, current, transport };
}
function elements(html: string): DefaultTreeAdapterTypes.Element[] {
  const found: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(html));
  return found;
}
const attr = (element: DefaultTreeAdapterTypes.Element, name: string) => element.attrs.find(item => item.name === name)?.value;
const button = (html: string, name: string) => elements(html).find(element => element.tagName === "button" && attr(element, "aria-label") === name)!;
const hasAttr = (element: DefaultTreeAdapterTypes.Element, name: string) => element.attrs.some(item => item.name === name);
function context(overrides: Partial<SelectionRecord> = {}): DesktopContextState {
  const record: SelectionRecord = { id: "record", sessionId: "a", taskId: "task", callIndex: 1, strategy: "deterministic-v1", configVersion: 1, model: "mock/model", totalMessages: 1, includedIndices: [0], excluded: [], includedMemories: [], excludedMemories: [], instructionVersion: "", cappedToolResults: [], estimates: { systemPrompt: 100, toolSchemas: 200, mandatoryTurn: 700 }, budget: 1000, estimatedTotal: 1000, usage: { input: 99_999, output: 10 }, promptArtifactId: null, windowSnapshot: { contextWindow: 2000, maxTokens: 500, thinkingBudget: 100, toolResultReserve: 300, safetyMargin: 100 }, createdAt: at, ...overrides };
  const breakdown = selectionBreakdown(record);
  const maxTokens = breakdown.window?.contextWindow ?? null;
  return { loading: false, error: null, missing: false, value: { record, breakdown, checkpoint: null, display: { systemTokens: record.estimates.systemPrompt ?? 0, toolTokens: record.estimates.toolSchemas ?? 0, messageTokens: record.estimatedTotal - (record.estimates.systemPrompt ?? 0) - (record.estimates.toolSchemas ?? 0), usedTokens: record.estimatedTotal, maxTokens, usedPercent: maxTokens === null ? null : record.estimatedTotal / maxTokens * 100 } } };
}

test("Desktop 模型切换保留支持的真实档位，否则选目录首档，不假设 Medium", () => {
  assert.deepEqual(selectionForModel(option({ provider: "other", modelId: "same-name" }), selection), { provider: "other", modelId: "same-name", thinkingLevel: "high" });
  assert.deepEqual(selectionForModel(option({ thinkingLevels: ["minimal", "low"] }), selection), { provider: "mock", modelId: "model", thinkingLevel: "minimal" });
  assert.deepEqual(selectionForModel(option({ thinkingLevels: ["off"] }), null), { provider: "mock", modelId: "model", thinkingLevel: "off" });
  assert.equal(selectionForModel(option({ available: false }), selection), null);
  assert.equal(selectionForModel(option({ thinkingLevels: [] }), selection), null);
});

test("Desktop 输入区匹配 demo 控件结构，四模式有图标且只保留一个模式 Select", () => {
  const h = harness();
  for (const [value, label, icon] of [["confirm", "Ask for approval", "message-circle-question"], ["auto-review", "Auto review", "shield-check"], ["full_access", "Full access", "zap"], ["plan", "Plan", "list-todo"]] as const) {
    h.current.defaultAccessMode = value;
    const html = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
    assert.match(attr(button(html, "附加文件"), "class")!, /attachment-button/);
    assert.match(attr(button(html, "会话默认模式"), "class")!, /mode-selector/);
    assert.equal(attr(button(html, "会话默认模式"), "aria-description"), label);
    assert.match(html, new RegExp(`lucide-${icon}`));
    assert.match(html, /mode-selector-label/);
    assert.equal(elements(html).filter(element => attr(element, "data-slot") === "select-trigger").length, 1);
    assert.equal(attr(button(html, "会话模型"), "data-slot"), "dropdown-menu-trigger");
    assert.match(html, /model-selector-icon/);
    assert.match(html, /Current model/);
    assert.equal(attr(button(html, "会话模型"), "aria-description"), "Current model · Effort: High");
    assert.ok(hasAttr(button(html, "发送消息"), "disabled"), "无输入仍禁止发送");
  }
});

test("Desktop 保留未在目录的真实模型和档位，离线与核实时禁止写控件", async () => {
  const h = harness({}, async (_target, _op, params) => { await blocked; return { ok: true, value: { kind: "not_sent", requestId: params.request_id, message: "未发送" } }; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  h.current.modelSelection = { provider: "retired", modelId: "old-real-model", thinkingLevel: "xhigh" };
  h.model.writes.models = [];
  let html = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  assert.equal(attr(button(html, "会话模型"), "aria-description"), "old-real-model · Effort: Xhigh");
  assert.match(html, /old-real-model/);
  assert.doesNotMatch(html, /Medium|认证不可用/);
  h.model.status = { type: "state", state: "reconnecting" };
  html = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  for (const name of ["附加文件", "会话默认模式", "会话模型", "发送消息"]) assert.ok(hasAttr(button(html, name), "disabled"));
  h.model.status = { type: "state", state: "online" };
  h.model.writes.edit("a", "保留待核实输入");
  const sending = h.model.writes.send("a");
  html = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  assert.ok(elements(html).some(element => element.tagName === "textarea" && hasAttr(element, "readonly")));
  for (const name of ["附加文件", "会话默认模式", "会话模型", "正在核实输入"]) assert.ok(hasAttr(button(html, name), "disabled"));
  assert.equal(attr(button(html, "正在核实输入"), "aria-busy"), "true");
  release();
  await sending;
  assert.equal(h.model.writes.draft("a").text, "保留待核实输入");
});

test("Desktop Context 明细保留三分类渐变和原始用量，环形入口不显示百分比文本", () => {
  const state = context();
  const details = renderToStaticMarkup(createElement(ContextDetails, { context: state }));
  assert.match(details, /50%/);
  assert.match(details, /~1K.*2K/);
  assert.match(details, /--context-system-end:55%;--context-tools-end:65%/);
  assert.match(details, /aria-valuenow="50"/);
  assert.match(details, /System prompt.*~100.*Tool definitions.*~200.*Messages.*~700/);
  const indicator = renderToStaticMarkup(createElement(ContextIndicator, { context: state, onOpen() {} }));
  assert.equal(attr(button(indicator, "上下文使用量"), "aria-description"), "1,000 / 2,000 tokens");
  assert.match(indicator, /data-slot="context-ring-value"[^>]*stroke-dashoffset="50"/);
  assert.doesNotMatch(indicator, /50%|99,999/);
});

test("Desktop Context 缺记录、容量或失败保持未知；已知零值仍可与未知区分", () => {
  const empty: DesktopContextState = { loading: false, error: null, missing: true, value: null };
  for (const state of [empty, { ...empty, loading: true, missing: false }, { ...empty, missing: false, error: "读取失败，请重新打开详情重试。" }, context({ windowSnapshot: null })]) {
    const details = renderToStaticMarkup(createElement(ContextDetails, { context: state }));
    const indicator = renderToStaticMarkup(createElement(ContextIndicator, { context: state, onOpen() {} }));
    assert.match(details, /—/);
    assert.doesNotMatch(details, /aria-valuenow|>0%|NaN|Infinity/);
    assert.doesNotMatch(indicator, /data-slot="context-ring-value"/);
    if (state.error) assert.match(details, /role="alert"/);
  }
  const zero = context({ estimates: {}, estimatedTotal: 0 });
  const details = renderToStaticMarkup(createElement(ContextDetails, { context: zero }));
  assert.match(details, /0%/);
  assert.match(details, /aria-valuenow="0"/);
  assert.doesNotMatch(details, /NaN|Infinity/);
});

for (const instanceChanged of [false, true]) for (const fails of [false, true]) test(`Desktop 模型目录${instanceChanged ? "换实例" : "同实例快照"}不安装旧${fails ? "错误" : "分页"}`, async () => {
  let release!: () => void;
  let began = false;
  let fresh = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const transport = new FakeTransport({ handlers: { list_models: async () => { const old = !fresh; if (old) { began = true; await blocked; if (fails) throw new Error("旧目录错误"); } return { models: [option({ name: old ? "旧模型" : "新模型" })], total: 1, nextOffset: old ? 1 : null }; } } });
  const view = new ViewState();
  view.applySnapshot({ snapshot: fakeSnapshot(), replay: [], seq: 0 }, false);
  const writes = new CodeWrites({ request: (_target, op, params) => ipcResult(() => transport.request(op as DesktopOp, params as OpParams<DesktopOp>)) }, view, () => true, () => {}, "code");
  writes.models = [option({ name: "原目录" })];
  const old = writes.loadModels();
  await waitFor("目录旧请求已开始", () => began);
  fresh = true;
  const update: Extract<DesktopUpdate, { type: "snapshot" }> = { type: "snapshot", instanceChanged, result: { snapshot: fakeSnapshot({ instanceId: instanceChanged ? "other" : "inst-1" }), replay: [], seq: 10 } };
  view.applySnapshot(update.result, instanceChanged);
  writes.update(update);
  assert.equal(writes.models.length, 0);
  await writes.loadModels();
  release();
  await old;
  assert.equal(writes.models[0].name, "新模型");
  assert.equal(writes.message, null);
  assert.equal(transport.requests.length, 2, "不继续旧目录的下一页");
});
