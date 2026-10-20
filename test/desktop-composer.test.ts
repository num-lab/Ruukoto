import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ModelSelection, Project, SelectionRecord, Session, SessionDefaultMode } from "@ruukoto/core/types.ts";
import type { DesktopAttachment } from "../apps/desktop/src/shared/bridge.ts";
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
type DraftValue = { workspaceId: string; text: string; mode: SessionDefaultMode; modelSelection: ModelSelection | null; attachments: DesktopAttachment[]; attaching?: boolean };
let NewChatDraft: ComponentType<{ model: CodeState; workspaces: Project[]; value: DraftValue; fallbackSelection: ModelSelection | null; onChange: (value: DraftValue) => void; onSend: () => void; onAddWorkspace: () => void; starting: boolean; blocked: boolean }>;
let filterWorkspaces: (workspaces: Project[], query: string) => Project[];
let ContextDetails: ComponentType<{ context: DesktopContextState }>;
let ContextIndicator: ComponentType<{ context: DesktopContextState; onOpen: () => void }>;
let selectionForModel: (option: ModelOption, current: ModelSelection | null) => ModelSelection | null;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ Composer, selectionForModel } = await server.ssrLoadModule("/composer.tsx"));
  ({ NewChatDraft, filterWorkspaces } = await server.ssrLoadModule("/new-chat.tsx"));
  ({ ContextDetails, ContextIndicator } = await server.ssrLoadModule("/context-indicator.tsx"));
});
after(async () => { await server?.close(); });

const selection: ModelSelection = { provider: "mock", modelId: "model", thinkingLevel: "high" };
const option = (overrides: Partial<ModelOption> = {}): ModelOption => ({ provider: "mock", modelId: "model", name: "Current model", contextWindow: 200_000, maxTokens: 1000, thinkingLevels: ["off", "high"], available: true, errorCode: null, ...overrides });
const at = "2026-10-16T00:00:00.000Z";
function session(): Session {
  return { id: "a", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: selection, modelSelectionVersion: 1, defaultAccessMode: "auto-review", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, archivedAt: null, createdAt: at };
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
  for (const [value, label, icon] of [["confirm", "Ask for approval", "message-circle-question"], ["auto-review", "Auto review", "shield-check"], ["full_access", "Full access", "shield-off"], ["plan", "Plan", "list-todo"]] as const) {
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
    assert.match(attr(button(html, "会话模型"), "class")!, /model-selector/);
    assert.match(html, /model-selector-name">Current model<\/span><span class="model-selector-effort">High<\/span>/, "思考强度跟在模型名后显示");
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

test("Desktop 新对话草稿：工作区选择在输入框外，未选工作区禁止发送，控件与会话输入区一致", () => {
  const projects: Project[] = [{ id: "p1", name: "ruukoto", createRequestId: null, rootDir: { cwd: "/work", cwdReal: "/work", dev: 1, ino: 1 }, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at }];
  const h = harness();
  const draft = (workspaceId: string, modelSelection: ModelSelection | null = selection) => renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId, text: "写一个测试", mode: "auto-review", modelSelection, attachments: [] }, fallbackSelection: null, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  const empty = draft("");
  assert.match(attr(button(empty, "选择工作区"), "class")!, /workspace-picker/);
  assert.equal(attr(button(empty, "选择工作区"), "aria-description"), undefined);
  assert.match(empty, /选择工作区后开始对话/);
  assert.ok(hasAttr(button(empty, "发送消息"), "disabled"), "未选工作区不能开始对话");
  const chosen = draft("p1");
  assert.equal(attr(button(chosen, "选择工作区"), "aria-description"), "ruukoto");
  assert.ok(!hasAttr(button(chosen, "发送消息"), "disabled"));
  // 工作区选择器在 composer 表单之外，输入区仍带附件、模式与模型控件。
  assert.match(chosen, /workspace-picker[\s\S]*<form class="surface-composer composer"/);
  for (const name of ["附加文件", "会话默认模式", "会话模型", "发送消息"]) assert.ok(button(chosen, name), name);
  assert.equal(attr(button(chosen, "会话默认模式"), "aria-description"), "Auto review");
  assert.equal(elements(chosen).filter(element => attr(element, "data-slot") === "select-trigger").length, 1);
  assert.match(chosen, /Current model/);
  // 草稿未选模型时沿用当前会话/后台默认值，模型名后不加额外标注。
  const inherited = renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId: "p1", text: "写一个测试", mode: "confirm", modelSelection: null, attachments: [] }, fallbackSelection: selection, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  assert.doesNotMatch(inherited, /model-selector-note|继承/);
  assert.match(inherited, /Current model/);
  assert.ok(!hasAttr(button(inherited, "发送消息"), "disabled"));
  const noModel = renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId: "p1", text: "写一个测试", mode: "confirm", modelSelection: null, attachments: [] }, fallbackSelection: null, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  assert.ok(hasAttr(button(noModel, "发送消息"), "disabled"), "没有可用模型时不能开始");
});

test("工作区菜单按名称筛选，空结果与未登记工作区都有明确文案", () => {
  const projects: Project[] = ["ruukoto", "ruukoto-avatar", "dev"].map((name, index) => ({ id: `p${index}`, name, createRequestId: null, rootDir: { cwd: `/${name}`, cwdReal: `/${name}`, dev: 1, ino: index + 1 }, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: at }));
  assert.deepEqual(filterWorkspaces(projects, "").map(project => project.name), ["ruukoto", "ruukoto-avatar", "dev"]);
  assert.deepEqual(filterWorkspaces(projects, "  AVATAR ").map(project => project.name), ["ruukoto-avatar"]);
  assert.deepEqual(filterWorkspaces(projects, "zzz"), []);
  // 菜单内容经 Radix 门户在打开后才挂载，SSR 只验证触发器仍是选择器本身。
  const h = harness();
  const html = renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId: "", text: "", mode: "confirm", modelSelection: selection, attachments: [] }, fallbackSelection: null, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  assert.equal(attr(button(html, "选择工作区"), "aria-expanded"), "false");
});
