import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "vite";
import { DropdownMenu } from "radix-ui";
import react from "@vitejs/plugin-react";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ModelSelection, Project, SelectionRecord, Session, SessionDefaultMode, ThinkingLevel } from "@ruukoto/core/types.ts";
import type { OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
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
let showsNewChat: (target: "code" | "personal", online: boolean, hasCurrent: boolean, hasDraft: boolean) => boolean;
let ContextDetails: ComponentType<{ context: DesktopContextState }>;
let ContextIndicator: ComponentType<{ context: DesktopContextState; onOpen: () => void }>;
let selectionForModel: (option: ModelOption, current: ModelSelection | null) => ModelSelection | null;
let EffortSlider: ComponentType<{ levels: ThinkingLevel[]; current: ThinkingLevel | null; disabled: boolean; onChange: (level: ThinkingLevel) => void }>;
let OwnerQuestionCard: ComponentType<{ model: CodeState; question: OwnerQuestionView }>;
let Conversation: ComponentType<{ model: CodeState; sessionId: string; child?: boolean }>;
let MessageScrollerProvider: ComponentType<{ children?: ReactNode }>;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ Composer, selectionForModel, EffortSlider } = await server.ssrLoadModule("/composer.tsx"));
  ({ NewChatDraft, filterWorkspaces, showsNewChat } = await server.ssrLoadModule("/new-chat.tsx"));
  ({ ContextDetails, ContextIndicator } = await server.ssrLoadModule("/context-indicator.tsx"));
  ({ OwnerQuestionCard } = await server.ssrLoadModule("/owner-question-cards.tsx"));
  ({ Conversation } = await server.ssrLoadModule("/conversation.tsx"));
  ({ MessageScrollerProvider } = await server.ssrLoadModule("/components/ui/message-scroller.tsx"));
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

test("Desktop 问题选项直接单选，输入文字清除选项且卡片不重复说明内部任务", () => {
  const { model, current } = harness();
  const options = ["共同前缀".repeat(40) + "甲范围", "共同前缀".repeat(40) + "乙范围"];
  const question: OwnerQuestionView = { id: "question", sessionId: current.id, taskId: "source", version: 1, status: "pending", questions: [{ question: "选择做法", options }], createdAt: at };
  model.view.ownerQuestions = [question];
  const render = () => renderToStaticMarkup(createElement(MessageScrollerProvider, null, createElement(OwnerQuestionCard, { model, question: model.view.ownerQuestions[0] })));
  let html = render();
  const choices = () => elements(html).filter(element => attr(element, "role") === "radio");
  assert.equal(choices().length, 2);
  assert.ok(choices().every(element => element.tagName === "button" && attr(element, "aria-checked") === "false"));
  assert.ok(!elements(html).some(element => ["select", "ul", "ol"].includes(element.tagName) || ["combobox", "listbox"].includes(attr(element, "role") ?? "")));
  assert.ok(options.every(option => html.includes(option)));
  assert.doesNotMatch(html, /每题都可以自由输入|后续任务|续接/);
  model.questions.choose(question, 1); html = render();
  assert.deepEqual(choices().map(element => attr(element, "aria-checked")), ["false", "true"]);
  model.questions.edit(question, "自己的回答"); html = render();
  assert.ok(choices().every(element => attr(element, "aria-checked") === "false"));
  assert.deepEqual(model.questions.draft(question).answers, [{ text: "自己的回答" }]);
  model.status = { type: "state", state: "reconnecting" }; html = render();
  assert.ok(choices().every(element => hasAttr(element, "disabled")));
  model.view.ownerQuestions = [{ ...question, status: "answered", version: 2, answers: [{ text: "自己的回答" }] }]; html = render();
  assert.equal((html.match(/已回答/g) ?? []).length, 1);
  assert.match(html, /自己的回答/);
});
test("Desktop 提问卡片分为题头、编号选项、自由输入和底部导航，翻页后保留回答", () => {
  const { model, current } = harness();
  const question: OwnerQuestionView = { id: "question", sessionId: current.id, taskId: "source", version: 1, status: "pending", questions: [{ question: "你更喜欢哪种协作方式？", options: ["直接给结论", "先给方案"] }, { question: "还有什么要求？" }, { question: "最后确认范围", options: ["本地", "共享"] }], createdAt: at };
  const render = () => renderToStaticMarkup(createElement(OwnerQuestionCard, { model, question }));
  let html = render();
  assert.ok(html.indexOf("你更喜欢哪种协作方式？") < html.indexOf("直接给结论"));
  assert.ok(html.indexOf("直接给结论") < html.indexOf("owner-question-free-input"));
  assert.ok(html.indexOf("owner-question-free-input") < html.indexOf("owner-question-footer"));
  const radios = elements(html).filter(element => attr(element, "role") === "radio");
  assert.deepEqual(radios.map(element => element.childNodes.filter(node => "tagName" in node && attr(node, "aria-hidden") === "true").length), [1, 1], "编号不重复进入可访问选项名");
  assert.ok(!button(html, "收起问题") && !button(html, "展开问题") && !button(html, "取消问题"));
  assert.doesNotMatch(html, /问题 1\/3/);
  assert.equal(elements(html).filter(element => attr(element, "class")?.includes("owner-question-progress")).length, 1);
  assert.ok(hasAttr(button(html, "上一题"), "disabled"));
  assert.ok(hasAttr(button(html, "下一题"), "disabled"));
  model.questions.choose(question, 1); html = render();
  assert.ok(!hasAttr(button(html, "下一题"), "disabled"));
  assert.equal((html.match(/先给方案/g) ?? []).length, 1, "选中的选项不重复填入自由输入行");
  model.questions.next(question); html = render();
  assert.match(html, />2\/3</);
  assert.match(html, /还有什么要求？/);
  assert.ok(!elements(html).some(element => attr(element, "role") === "radio"));
  assert.ok(!hasAttr(button(html, "上一题"), "disabled"));
  model.questions.back(question); html = render();
  assert.deepEqual(elements(html).filter(element => attr(element, "role") === "radio").map(element => attr(element, "aria-checked")), ["false", "true"]);
  model.questions.edit(question, "按实际情况决定");
  model.questions.next(question);
  model.questions.edit(question, "保持简洁");
  model.questions.next(question); html = render();
  assert.match(html, />3\/3</);
  assert.ok(hasAttr(button(html, "核对回答"), "disabled"));
  model.questions.choose(question, 0);
  model.questions.next(question); html = render();
  assert.match(html, /按实际情况决定/);
  assert.match(html, /保持简洁/);
  assert.match(html, /提交回答/);
  assert.ok(!elements(html).some(element => element.tagName === "textarea" || attr(element, "role") === "radio"));
  model.questions.back(question);
  model.questions.next(question, true); html = render();
  assert.match(html, /已跳过/);
  assert.deepEqual(model.questions.draft(question).answers[2], { text: "" }, "Skip 清除最后一题选择并进入核对");
});
test("Desktop 选项显示说明与推荐标签，多选保留顺序，Skip 保存空答案", () => {
  const { model, current } = harness();
  const question: OwnerQuestionView = { id: "question", sessionId: current.id, taskId: "source", version: 1, status: "pending", questions: [{ question: "选择交付内容", multiple: true, options: [{ label: "页面", description: "实现完整页面", recommended: true }, { label: "接口", description: "服务端接口", recommended: false }, "文档"] }, { question: "发布位置", options: ["本地", "共享"] }, { question: "补充说明" }], createdAt: at };
  const render = () => renderToStaticMarkup(createElement(OwnerQuestionCard, { model, question }));
  let html = render();
  const choices = () => elements(html).filter(element => attr(element, "role") === "checkbox");
  assert.equal(choices().length, 3);
  assert.ok(choices().every(element => attr(element, "aria-checked") === "false"));
  assert.doesNotMatch(html, />多选</);
  assert.ok(!elements(html).some(element => attr(element, "class") === "owner-question-number" && element.childNodes.some(node => "value" in node && /^[123]$/.test(node.value))));
  assert.ok(html.indexOf("页面") < html.indexOf("实现完整页面"));
  assert.equal((html.match(/Recommended/g) ?? []).length, 1);
  assert.ok(html.indexOf("文档") < html.indexOf("Skip"));
  model.questions.choose(question, [2, 0]); html = render();
  assert.deepEqual(choices().map(element => attr(element, "aria-checked")), ["true", "false", "true"]);
  assert.deepEqual(model.questions.draft(question).answers[0], { text: "页面\n文档", options: [0, 2] });
  model.questions.next(question); model.questions.back(question); html = render();
  assert.deepEqual(choices().map(element => attr(element, "aria-checked")), ["true", "false", "true"]);
  model.questions.choose(question, []); html = render();
  assert.ok(choices().every(element => attr(element, "aria-checked") === "false"));
  assert.ok(hasAttr(button(html, "下一题"), "disabled"));
  model.questions.choose(question, [1]);
  model.questions.edit(question, "自己填写的回答"); html = render();
  assert.ok(choices().every(element => attr(element, "aria-checked") === "false"));
  assert.deepEqual(model.questions.draft(question).answers[0], { text: "自己填写的回答" });
  model.questions.next(question, true);
  model.questions.choose(question, 1);
  model.questions.next(question, true);
  model.status = { type: "state", state: "reconnecting" }; html = render();
  const skip = elements(html).find(element => element.tagName === "button" && element.childNodes.some(node => "value" in node && node.value === "Skip"))!;
  assert.ok(hasAttr(skip, "disabled"));
  model.status = { type: "state", state: "online" };
  model.questions.next(question, true); html = render();
  assert.deepEqual(model.questions.draft(question).answers, [{ text: "" }, { text: "" }, { text: "" }]);
  assert.equal((html.match(/已跳过/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Recommended|owner-question-progress/);
});
test("Desktop 已答卡片替换对应用户消息并留在回答时序，不重复在底部出现", () => {
  const { model, current } = harness();
  const original = "[拥有者问题回答]\n1. 发布范围？\n回答：共享";
  const question: OwnerQuestionView = { id: "question", sessionId: current.id, taskId: "source", continuationTaskId: "answer", version: 2, status: "answered", questions: [{ question: "发布范围？", options: ["本地", "共享"] }], answers: [{ text: "共享", option: 1 }], createdAt: at };
  const entry = (id: string, taskId: string, role: string, text: string, second: number): HistoryEntryView => ({ entryId: id, taskId, role, text, timestamp: new Date(Date.parse(at) + second * 1000).toISOString(), inputPurpose: "user", parentId: null, offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: null, hasNonTextContent: false });
  const history = [entry("before", "source", "user", "请确认发布范围", 0), entry("answer-entry", "answer", "user", original, 1), entry("after", "answer", "assistant", "已按回答继续", 2), entry("later", "chat", "user", "之后的普通消息", 3)];
  const flow = model.view.openSession(current.id).flow;
  for (const item of history) flow.addHistory(item);
  const render = (child = false) => renderToStaticMarkup(createElement(Conversation, { model, sessionId: current.id, child }));
  assert.match(render(), /拥有者问题回答/, "缺少问题资料时保留原用户正文");
  model.view.ownerQuestions = [question];
  const html = render();
  assert.equal((html.match(/aria-label="拥有者问题"/g) ?? []).length, 1);
  assert.ok(html.indexOf("请确认发布范围") < html.indexOf("已回答"));
  assert.ok(html.indexOf("已回答") < html.indexOf("已按回答继续"));
  assert.ok(html.indexOf("已回答") < html.indexOf("之后的普通消息"));
  assert.doesNotMatch(html, /拥有者问题回答/);
  const card = elements(html).find(element => attr(element, "aria-label") === "拥有者问题")!;
  let parent = card.parentNode, scrollers = 0;
  while (parent) {
    if ("tagName" in parent && attr(parent, "data-slot") === "message-scroller-item") scrollers++;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  assert.equal(scrollers, 1, "卡片复用原用户消息的滚动容器");
  assert.equal(flow.historyEntries.find(item => item.entryId === "answer-entry")!.text, original);
  assert.equal(flow.items.find(item => item.key === "input:answer")!.kind, "message");
  assert.match(render(true), /拥有者问题回答/, "子会话保持原消息");
  assert.doesNotMatch(render(true), /aria-label="拥有者问题"/);
  const normal = entry("normal", "normal-task", "user", original, 4);
  flow.addHistory(normal);
  assert.equal((render().match(/拥有者问题回答/g) ?? []).length, 1, "同正文的普通输入不能被猜成业务回答");
  model.view.ownerQuestions = [{ ...question, sessionId: "other-session" }];
  assert.doesNotMatch(render(), /aria-label="拥有者问题"/, "跨会话不能借任务引用替换消息");
  const personal = new CodeState({ request: async () => ({ ok: false, error: { code: "unused", outcome: "not_sent", message: "不发送请求" } }) }, () => {}, "personal");
  personal.view.ownerQuestions = [question];
  for (const item of history) personal.view.openSession(current.id).flow.addHistory(item);
  const personalHtml = renderToStaticMarkup(createElement(Conversation, { model: personal, sessionId: current.id }));
  assert.match(personalHtml, /拥有者问题回答/);
  assert.doesNotMatch(personalHtml, /aria-label="拥有者问题"/);
  model.view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [current], ownerQuestions: [question] }), replay: [], seq: 0 }, false);
  for (const item of history) model.view.openSession(current.id).flow.addHistory(item);
  assert.equal((render().match(/aria-label="拥有者问题"/g) ?? []).length, 1, "快照先到、历史后到仍按原位置恢复");
  assert.doesNotMatch(render(), /拥有者问题回答/);
  for (const [status, label] of [["pending", "Skip"], ["canceled", "已取消"], ["stale", "已失效"]] as const) {
    model.view.ownerQuestions = [question, { ...question, id: "unanswered", status, answers: undefined, continuationTaskId: undefined }];
    const withUnanswered = render();
    assert.equal((withUnanswered.match(/aria-label="拥有者问题"/g) ?? []).length, 2);
    assert.ok(withUnanswered.indexOf(label) > withUnanswered.indexOf("之后的普通消息"), "没有续接消息的状态保留原展示位置");
  }
});

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

test("Effort 档位渲染为分段粗滑杆：选中档填充、目录外只读、无选择不渲染", () => {
  const render = (props: { levels: ThinkingLevel[]; current: ThinkingLevel | null; disabled: boolean }) => renderToStaticMarkup(createElement(DropdownMenu.Root, { open: true }, createElement(DropdownMenu.Content, null, createElement(EffortSlider, { ...props, onChange() {} }))));
  const stops = (html: string) => elements(html).filter(element => attr(element, "role") === "menuitemradio");
  const filled = render({ levels: ["off", "medium", "high"], current: "medium", disabled: false });
  assert.deepEqual(stops(filled).map(element => attr(element, "aria-checked")), ["false", "true", "false"]);
  assert.deepEqual(stops(filled).map(element => attr(element, "class")!.includes("is-filled")), [true, true, false], "选中档及其左侧填充为滑块位置");
  assert.ok(stops(filled).every(element => !hasAttr(element, "data-disabled")));
  const locked = stops(render({ levels: ["off", "high"], current: "off", disabled: true }));
  assert.ok(locked.every(element => hasAttr(element, "data-disabled")), "模型不可用时整体禁选");
  const fallback = stops(render({ levels: [], current: "xhigh", disabled: false }));
  assert.deepEqual(fallback.map(element => [attr(element, "aria-checked"), hasAttr(element, "data-disabled")]), [["true", true]], "目录外模型只读展示当前档");
  assert.equal(render({ levels: [], current: null, disabled: false }).includes("effort-slider"), false);
});

test("打开会话保留草稿和附件，正常输入不需要退出历史模式", () => {
  const h = harness();
  h.model.writes.edit(h.current.id, "尚未发送的草稿");
  const draft = h.model.writes.draft(h.current.id);
  draft.attachments = [{ id: "attachment", name: "原附件.txt", size: 10 }];
  h.model.openSession(h.current.id);
  const html = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  assert.match(html, /<textarea/);
  assert.match(html, /尚未发送的草稿/);
  assert.doesNotMatch(html, /查看历史|返回最新/);
  assert.equal(h.model.writes.blocked(h.current.id), false);
  assert.strictEqual(h.model.writes.draft(h.current.id), draft);
  assert.equal(draft.attachments[0].id, "attachment");
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
  assert.match(empty, /Task or question/);
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

test("在线且未选会话时主画布默认是新对话草稿页，空态页只留给离线与 PA", () => {
  assert.equal(showsNewChat("code", true, false, false), true, "启动后未打开或关掉全部标签都直接落在草稿页");
  assert.equal(showsNewChat("code", true, false, true), true);
  assert.equal(showsNewChat("code", true, true, false), false, "已选会话仍显示会话页");
  assert.equal(showsNewChat("code", false, false, false), false, "离线保留连接空态页");
  assert.equal(showsNewChat("code", false, true, true), true, "离线时已打开的草稿不收起");
  assert.equal(showsNewChat("personal", true, false, false), false, "PA 主会话未就绪保留原空态页");
  assert.equal(showsNewChat("personal", false, false, true), false);
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
