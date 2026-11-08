import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createServer, type ViteDevServer } from "./helpers/vite.ts";
import { DropdownMenu } from "radix-ui";
import react from "@vitejs/plugin-react";
import type { OpParams, OpResult } from "@ruukoto/control/ops.ts";
import type { ModelSelection, Project, SelectionRecord, Session, SessionDefaultMode, ThinkingLevel } from "@ruukoto/core/types.ts";
import type { TaskView } from "@ruukoto/core/views.ts";
import type { OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";
import type { HistoryEntryView } from "@ruukoto/core/history.ts";
import type { CodeSchedulePlan, CodeScheduleRun } from "@ruukoto/core/code-scheduler.ts";
import type { DesktopAttachment } from "../apps/desktop/src/shared/bridge.ts";
import { selectionBreakdown } from "@ruukoto/agent/context-selector.ts";
import { ViewState } from "@ruukoto/view/state.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { CodeWrites, queueOrderAfterMove } from "../apps/desktop/src/renderer/code-writes.ts";
import type { DesktopContextState } from "../apps/desktop/src/renderer/context-state.ts";
import { draftForSchedule } from "../apps/desktop/src/renderer/scheduled-state.ts";
import type { DesktopBridge, DesktopUpdate } from "../apps/desktop/src/shared/bridge.ts";
import { ipcResult, type DesktopOp } from "../apps/desktop/src/main/ipc.ts";
import { FakeTransport, fakeSnapshot, type FakeHandlers } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

type ModelOption = OpResult<"list_models">["models"][number];
let server: ViteDevServer;
let Composer: ComponentType<{ model: CodeState; session: Session }>;
let composerInputHeight: (scrollHeight: number, viewportHeight: number, minHeight?: number) => number;
let Scheduled: ComponentType<{ model: CodeState; onOpenSession: (id: string) => void }>;
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
let QueuePanel: ComponentType<{ model: CodeState; session: Session; defaultOpen?: boolean }>;
let MessageScrollerProvider: ComponentType<{ children?: ReactNode }>;
let useComposerCommands: (props: { model: CodeState; session?: Session; text: string; edit: (text: string) => void; input: { current: HTMLTextAreaElement | null }; locked: boolean; onNew?: () => void; onSkills?: () => void }) => { execute: () => Promise<void>; help: ReactNode };
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../apps/desktop/src/renderer/", import.meta.url)), plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ Composer, composerInputHeight, selectionForModel, EffortSlider } = await server.ssrLoadModule("/composer.tsx"));
  ({ useComposerCommands } = await server.ssrLoadModule("/composer-commands.tsx"));
  ({ Scheduled } = await server.ssrLoadModule("/scheduled.tsx"));
  ({ QueuePanel } = await server.ssrLoadModule("/queue-panel.tsx"));
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
  return { id: "a", projectId: "workspace", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: selection, modelSelectionVersion: 1, defaultAccessMode: "auto-review", defaultAccessModeVersion: 1, queueState: "active", queuePauseReason: null, queueRevision: 0, archivedAt: null, createdAt: at };
}
function queuedTask(id: string, input: string, queueOrder: number): TaskView {
  return { id, sessionId: "a", requestId: `request-${id}`, input, inputPurpose: "user", modelSelection: selection, submissionDigest: null, status: "queued", queueOrder, accessMode: "confirm", planMode: false, permissionVersion: 1, sourcePermissionVersion: null, grantedPaths: [], pendingAccessMode: null, interruptReason: null, cancelRequested: false, effectUnknown: false, errorMessage: null, historyEntryIds: [], resumesTaskId: null, agentId: null, parentTaskId: null, sourceEventId: null, deadline: null, resultSummary: null, resultRef: null, workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null, createdAt: at, startedAt: null, endedAt: null };
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
  const question: OwnerQuestionView = { id: "question", sessionId: current.id, taskId: "source", hostOpId: "question-op", version: 1, status: "pending", questions: [{ question: "选择做法", options }], createdAt: at };
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
  assert.equal((html.match(/Answered/g) ?? []).length, 1);
  assert.match(html, /自己的回答/);
});
test("Desktop 提问卡片分为题头、编号选项、自由输入和底部导航，翻页后保留回答", () => {
  const { model, current } = harness();
  const question: OwnerQuestionView = { id: "question", sessionId: current.id, taskId: "source", hostOpId: "question-op", version: 1, status: "pending", questions: [{ question: "你更喜欢哪种协作方式？", options: ["直接给结论", "先给方案"] }, { question: "还有什么要求？" }, { question: "最后确认范围", options: ["本地", "共享"] }], createdAt: at };
  const render = () => renderToStaticMarkup(createElement(OwnerQuestionCard, { model, question }));
  let html = render();
  assert.ok(html.indexOf("你更喜欢哪种协作方式？") < html.indexOf("直接给结论"));
  assert.ok(html.indexOf("直接给结论") < html.indexOf("owner-question-free-input"));
  assert.ok(html.indexOf("owner-question-free-input") < html.indexOf("owner-question-footer"));
  const radios = elements(html).filter(element => attr(element, "role") === "radio");
  assert.deepEqual(radios.map(element => element.childNodes.filter(node => "tagName" in node && attr(node, "aria-hidden") === "true").length), [1, 1], "编号不重复进入可访问选项名");
  assert.ok(!button(html, "Collapse question") && !button(html, "Expand question") && !button(html, "Cancel question"));
  assert.doesNotMatch(html, /Question 1\/3/);
  assert.equal(elements(html).filter(element => attr(element, "class")?.includes("owner-question-progress")).length, 1);
  assert.ok(hasAttr(button(html, "Previous question"), "disabled"));
  assert.ok(hasAttr(button(html, "Next question"), "disabled"));
  model.questions.choose(question, 1); html = render();
  assert.ok(!hasAttr(button(html, "Next question"), "disabled"));
  assert.equal((html.match(/先给方案/g) ?? []).length, 1, "选中的选项不重复填入自由输入行");
  model.questions.next(question); html = render();
  assert.match(html, />2\/3</);
  assert.match(html, /还有什么要求？/);
  assert.ok(!elements(html).some(element => attr(element, "role") === "radio"));
  assert.ok(!hasAttr(button(html, "Previous question"), "disabled"));
  model.questions.back(question); html = render();
  assert.deepEqual(elements(html).filter(element => attr(element, "role") === "radio").map(element => attr(element, "aria-checked")), ["false", "true"]);
  model.questions.edit(question, "按实际情况决定");
  model.questions.next(question);
  model.questions.edit(question, "保持简洁");
  model.questions.next(question); html = render();
  assert.match(html, />3\/3</);
  assert.ok(hasAttr(button(html, "Review answers"), "disabled"));
  model.questions.choose(question, 0);
  model.questions.next(question); html = render();
  assert.match(html, /按实际情况决定/);
  assert.match(html, /保持简洁/);
  assert.match(html, /Submit answers/);
  assert.ok(!elements(html).some(element => element.tagName === "textarea" || attr(element, "role") === "radio"));
  model.questions.back(question);
  model.questions.next(question, true); html = render();
  assert.match(html, /Skipped/);
  assert.deepEqual(model.questions.draft(question).answers[2], { text: "" }, "Skip 清除最后一题选择并进入核对");
});
test("Desktop 选项显示说明与推荐标签，多选保留顺序，Skip 保存空答案", () => {
  const { model, current } = harness();
  const question: OwnerQuestionView = { id: "question", sessionId: current.id, taskId: "source", hostOpId: "question-op", version: 1, status: "pending", questions: [{ question: "选择交付内容", multiple: true, options: [{ label: "页面", description: "实现完整页面", recommended: true }, { label: "接口", description: "服务端接口", recommended: false }, "文档"] }, { question: "发布位置", options: ["本地", "共享"] }, { question: "补充说明" }], createdAt: at };
  const render = () => renderToStaticMarkup(createElement(OwnerQuestionCard, { model, question }));
  let html = render();
  const choices = () => elements(html).filter(element => attr(element, "role") === "checkbox");
  assert.equal(choices().length, 3);
  assert.ok(choices().every(element => attr(element, "aria-checked") === "false"));
  assert.doesNotMatch(html, />Multiple</);
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
  assert.ok(hasAttr(button(html, "Next question"), "disabled"));
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
  assert.equal((html.match(/Skipped/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Recommended|owner-question-progress/);
});
test("Desktop question batches stay at their original tool results without replacing the requirement", () => {
  const { model, current } = harness();
  const entry = (id: string, role: string, text: string, second: number, op?: string): HistoryEntryView => ({ entryId: id, taskId: "source", role, text, timestamp: new Date(Date.parse(at) + second * 1000).toISOString(), inputPurpose: "user", parentId: null, offset: 0, totalBytes: Buffer.byteLength(text), truncated: false, toolCalls: [], toolCallId: op ? `call-${op}` : null, hostToolOpId: op, toolName: op ? "ask_user" : null, isError: null, hasNonTextContent: false });
  const question: OwnerQuestionView = { id: "first", sessionId: current.id, taskId: "source", hostOpId: "op-first", version: 2, status: "answered", questions: [{ question: "发布范围？" }], answers: [{ text: "共享" }], createdAt: at };
  const second: OwnerQuestionView = { ...question, id: "second", hostOpId: "op-second", questions: [{ question: "发布位置？" }], answers: [{ text: "本地" }] };
  const history = [entry("requirement", "user", "请确认发布范围", 0), entry("first-result", "toolResult", "first answer", 1, "op-first"), entry("between", "assistant", "继续确认", 2), entry("second-result", "toolResult", "second answer", 3, "op-second"), entry("after", "assistant", "已按回答继续", 4)];
  const render = () => renderToStaticMarkup(createElement(Conversation, { model, sessionId: current.id }));
  for (const order of ["event-first", "history-first", "cold"] as const) {
    model.view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [current], ownerQuestions: order === "cold" ? [question, second] : [] }), replay: [], seq: 0 }, false);
    if (order === "event-first") model.view.ownerQuestions = [question, second];
    for (const item of history) model.view.openSession(current.id).flow.addHistory(item);
    if (order === "history-first") model.view.ownerQuestions = [question, second];
    const html = render();
    assert.equal((html.match(/aria-label="Owner question"/g) ?? []).length, 2);
    assert.match(html, /请确认发布范围/);
    assert.ok(html.indexOf("发布范围？") < html.indexOf("继续确认"));
    assert.ok(html.indexOf("继续确认") < html.indexOf("发布位置？"));
    assert.ok(html.indexOf("发布位置？") < html.indexOf("已按回答继续"));
  }
});

function context(overrides: Partial<SelectionRecord> = {}): DesktopContextState {
  const record: SelectionRecord = { id: "record", sessionId: "a", taskId: "task", callIndex: 1, strategy: "deterministic-v1", configVersion: 1, model: "mock/model", totalMessages: 1, includedIndices: [0], excluded: [], includedMemories: [], excludedMemories: [], instructionVersion: "", cappedToolResults: [], estimates: { systemPrompt: 100, toolSchemas: 200, mandatoryTurn: 700 }, budget: 1000, estimatedTotal: 1000, usage: { input: 99_999, output: 10 }, promptArtifactId: null, windowSnapshot: { contextWindow: 2000, maxTokens: 500, thinkingBudget: 100, toolResultReserve: 300, safetyMargin: 100 }, createdAt: at, ...overrides };
  const breakdown = selectionBreakdown(record);
  const maxTokens = breakdown.window?.contextWindow ?? null;
  return { loading: false, error: null, missing: false, value: { record, breakdown, checkpoint: null, display: { systemTokens: record.estimates.systemPrompt ?? 0, toolTokens: record.estimates.toolSchemas ?? 0, messageTokens: record.estimatedTotal - (record.estimates.systemPrompt ?? 0) - (record.estimates.toolSchemas ?? 0), usedTokens: record.estimatedTotal, maxTokens, usedPercent: maxTokens === null ? null : record.estimatedTotal / maxTokens * 100 } } };
}

test("输入框随内容增高但不超过窗口高度的三分之一", () => {
  assert.equal(composerInputHeight(40, 900), 48);
  assert.equal(composerInputHeight(200, 900), 200);
  assert.equal(composerInputHeight(1000, 900), 300);
  assert.equal(composerInputHeight(1000, 120), 48);
  assert.equal(composerInputHeight(20, 900, 24), 24);
  assert.equal(composerInputHeight(40, 900, 24), 40);
  assert.equal(composerInputHeight(1000, 900, 24), 300);
});

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
    assert.match(attr(button(html, "Attach files"), "class")!, /attachment-button/);
    assert.match(attr(button(html, "Chat default mode"), "class")!, /mode-selector/);
    assert.equal(attr(button(html, "Chat default mode"), "aria-description"), label);
    assert.match(html, new RegExp(`lucide-${icon}`));
    assert.match(html, /mode-selector-label/);
    assert.equal(elements(html).filter(element => attr(element, "data-slot") === "select-trigger").length, 1);
    assert.equal(attr(button(html, "Chat model"), "data-slot"), "dropdown-menu-trigger");
    assert.match(html, /model-selector-icon/);
    assert.match(html, /Current model/);
    assert.equal(attr(button(html, "Chat model"), "aria-description"), "Current model · Effort: High");
    assert.match(attr(button(html, "Chat model"), "class")!, /model-selector/);
    assert.match(html, /model-selector-name">Current model<\/span><span class="model-selector-effort">High<\/span>/, "思考强度跟在模型名后显示");
    assert.ok(hasAttr(button(html, "Send message"), "disabled"), "无输入仍禁止发送");
  }
});

test("Desktop 拖拽落点生成完整队列顺序，原地落点不发请求", async () => {
  assert.deepEqual(queueOrderAfterMove(["task-1", "task-2", "task-3"], "task-3", "task-1", "before"), ["task-3", "task-1", "task-2"]);
  assert.deepEqual(queueOrderAfterMove(["task-1", "task-2", "task-3"], "task-1", "task-3", "after"), ["task-2", "task-3", "task-1"]);
  assert.equal(queueOrderAfterMove(["task-1", "task-2", "task-3"], "task-3", "task-2", "after"), null);
  assert.equal(queueOrderAfterMove(["task-1", "task-2"], "task-1", "task-1", "before"), null);

  const detail = { queue: { revision: 7, retrievableTaskIds: [], tasks: ["task-1", "task-2", "task-3"].map((taskId, index) => ({ taskId, queueOrder: index + 1 })) }, reorderableTaskIds: ["task-1", "task-2", "task-3"], steerableTaskIds: ["task-1", "task-2", "task-3"], guidance: [] };
  const h = harness({
    task_queue: async () => detail,
    queue_reorder: async params => ({ revision: 8, retrievableTaskIds: [], tasks: params.task_ids.map((taskId, index) => ({ taskId, queueOrder: index + 1 })) })
  });
  await h.model.writes.loadQueue(h.current.id);
  await h.model.writes.reorderQueued(h.current.id, "task-3", "task-1", "before");
  await h.model.writes.reorderQueued(h.current.id, "task-3", "task-2", "after");
  const requests = h.transport.requests.filter(request => request.op === "queue_reorder");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, { session_id: h.current.id, task_ids: ["task-3", "task-1", "task-2"], expected_revision: 7 });
});

test("Desktop 排队面板使用拖拽手柄和行内动作，输入区与空队列保持一体圆角", async () => {
  const tasks = [queuedTask("task-1", "第一条排队输入", 1), queuedTask("task-2", "第二条排队输入", 2)];
  const detail = { queue: { revision: 7, retrievableTaskIds: [], tasks: tasks.map((task, index) => ({ taskId: task.id, queueOrder: index + 1 })) }, reorderableTaskIds: tasks.map(task => task.id), steerableTaskIds: ["task-1"], guidance: [] };
  const h = harness({ task_queue: async () => detail });
  h.model.view.applySnapshot({ snapshot: fakeSnapshot({ sessions: [h.current], tasks }), replay: [], seq: 0 }, false);
  await h.model.writes.loadQueue(h.current.id);

  const panel = renderToStaticMarkup(createElement(QueuePanel, { model: h.model, session: h.current, defaultOpen: true }));
  assert.match(panel, /queue-summary/);
  assert.match(panel, /lucide-grip-vertical/);
  assert.match(panel, /drag or use arrow keys to reorder/);
  assert.match(panel, /queue-panel-actions/);
  assert.match(panel, /lucide-waypoints/);
  assert.doesNotMatch(panel, /Move up|Move down/);
  assert.equal(elements(panel).filter(element => attr(element, "draggable") === "true").length, 2);
  h.model.status = { type: "state", state: "reconnecting" };
  const offlinePanel = renderToStaticMarkup(createElement(QueuePanel, { model: h.model, session: h.current, defaultOpen: true }));
  assert.equal(elements(offlinePanel).filter(element => attr(element, "draggable") === "true").length, 0);
  assert.ok(hasAttr(button(offlinePanel, "Send item 1 as guidance"), "disabled"));

  const composer = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  assert.match(composer, /<div class="composer-stack surface-composer has-queue">/);
  assert.ok(composer.indexOf("queue-panel") < composer.indexOf("<form class=\"composer\""));
  const empty = harness();
  const emptyComposer = renderToStaticMarkup(createElement(Composer, { model: empty.model, session: empty.current }));
  assert.match(emptyComposer, /<div class="composer-stack surface-composer"><form class="composer"/);
});

test("Effort uses real model stops and keeps unavailable selections read-only", () => {
  const render = (props: { levels: ThinkingLevel[]; current: ThinkingLevel | null; disabled: boolean }) => renderToStaticMarkup(createElement(DropdownMenu.Root, { open: true }, createElement(DropdownMenu.Content, null, createElement(EffortSlider, { ...props, onChange() {} }))));
  const slider = (html: string) => elements(html).find(element => element.tagName === "input" && attr(element, "type") === "range")!;
  const filled = render({ levels: ["off", "minimal", "medium", "xhigh"], current: "medium", disabled: false });
  assert.equal(attr(slider(filled), "max"), "3"); assert.equal(attr(slider(filled), "value"), "2"); assert.equal(attr(slider(filled), "aria-valuetext"), "Medium");
  assert.equal(elements(filled).filter(element => attr(element, "class") === "effort-dot").length, 4);
  assert.equal(hasAttr(slider(filled), "disabled"), false);
  const locked = slider(render({ levels: ["off", "high"], current: "off", disabled: true }));
  assert.ok(hasAttr(locked, "disabled"));
  const fallback = slider(render({ levels: [], current: "xhigh", disabled: false }));
  assert.equal(attr(fallback, "aria-valuetext"), "Xhigh"); assert.ok(hasAttr(fallback, "disabled"));
  assert.ok(hasAttr(slider(render({ levels: ["off"], current: "off", disabled: false })), "disabled"));
  assert.equal(render({ levels: [], current: null, disabled: false }).includes("effort-panel"), false);
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
  assert.doesNotMatch(html, /View history|Back to latest/);
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
  assert.equal(attr(button(html, "Chat model"), "aria-description"), "old-real-model · Effort: Xhigh");
  assert.match(html, /old-real-model/);
  assert.doesNotMatch(html, /Medium|Auth unavailable/);
  h.model.status = { type: "state", state: "reconnecting" };
  html = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  for (const name of ["Attach files", "Chat default mode", "Chat model", "Send message"]) assert.ok(hasAttr(button(html, name), "disabled"));
  h.model.status = { type: "state", state: "online" };
  h.model.writes.edit("a", "保留待核实输入");
  const sending = h.model.writes.send("a");
  html = renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  assert.ok(elements(html).some(element => element.tagName === "textarea" && hasAttr(element, "readonly")));
  for (const name of ["Attach files", "Chat default mode", "Chat model", "Verifying input"]) assert.ok(hasAttr(button(html, name), "disabled"));
  assert.equal(attr(button(html, "Verifying input"), "aria-busy"), "true");
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
  assert.equal(attr(button(indicator, "Context usage"), "aria-description"), "1,000 / 2,000 tokens");
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

test("Desktop new-chat draft sends without workspace selection and retains ordinary controls", () => {
  const projects: Project[] = [{ id: "p1", name: "ruukoto", createRequestId: null, rootDir: { cwd: "/work", cwdReal: "/work", dev: 1, ino: 1 }, instructionFiles: [], settingsVersion: 1, createdAt: at }];
  const h = harness();
  const draft = (workspaceId: string, modelSelection: ModelSelection | null = selection) => renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId, text: "写一个测试", mode: "auto-review", modelSelection, attachments: [] }, fallbackSelection: null, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  const empty = draft("");
  assert.match(attr(button(empty, "Select workspace"), "class")!, /workspace-picker/);
  assert.equal(attr(button(empty, "Select workspace"), "aria-description"), undefined);
  assert.match(empty, /Task or question/);
  assert.ok(!hasAttr(button(empty, "Send message"), "disabled"));
  assert.match(empty, /No workspace/);
  const chosen = draft("p1");
  assert.equal(attr(button(chosen, "Select workspace"), "aria-description"), "ruukoto");
  assert.ok(!hasAttr(button(chosen, "Send message"), "disabled"));
  // 工作区选择器在 composer 表单之外，输入区仍带附件、模式与模型控件。
  assert.match(chosen, /workspace-picker[\s\S]*<form class="surface-composer composer"/);
  for (const name of ["Attach files", "Chat default mode", "Chat model", "Send message"]) assert.ok(button(chosen, name), name);
  assert.equal(attr(button(chosen, "Chat default mode"), "aria-description"), "Auto review");
  assert.equal(elements(chosen).filter(element => attr(element, "data-slot") === "select-trigger").length, 1);
  assert.match(chosen, /Current model/);
  // 草稿未选模型时沿用当前会话/后台默认值，模型名后不加额外标注。
  const inherited = renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId: "p1", text: "写一个测试", mode: "confirm", modelSelection: null, attachments: [] }, fallbackSelection: selection, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  assert.doesNotMatch(inherited, /model-selector-note|[Ii]nherited/);
  assert.match(inherited, /Current model/);
  assert.ok(!hasAttr(button(inherited, "Send message"), "disabled"));
  const noModel = renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId: "p1", text: "写一个测试", mode: "confirm", modelSelection: null, attachments: [] }, fallbackSelection: null, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  assert.ok(hasAttr(button(noModel, "Send message"), "disabled"), "没有可用模型时不能开始");
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
  const projects: Project[] = ["ruukoto", "ruukoto-avatar", "dev"].map((name, index) => ({ id: `p${index}`, name, createRequestId: null, rootDir: { cwd: `/${name}`, cwdReal: `/${name}`, dev: 1, ino: index + 1 }, instructionFiles: [], settingsVersion: 1, createdAt: at }));
  assert.deepEqual(filterWorkspaces(projects, "").map(project => project.name), ["ruukoto", "ruukoto-avatar", "dev"]);
  assert.deepEqual(filterWorkspaces(projects, "  AVATAR ").map(project => project.name), ["ruukoto-avatar"]);
  assert.deepEqual(filterWorkspaces(projects, "zzz"), []);
  // 菜单内容经 Radix 门户在打开后才挂载，SSR 只验证触发器仍是选择器本身。
  const h = harness();
  const html = renderToStaticMarkup(createElement(NewChatDraft, { model: h.model, workspaces: projects, value: { workspaceId: "", text: "", mode: "confirm", modelSelection: selection, attachments: [] }, fallbackSelection: null, onChange() {}, onSend() {}, onAddWorkspace() {}, starting: false, blocked: false }));
  assert.equal(attr(button(html, "Select workspace"), "aria-expanded"), "false");
});

test("Scheduled 列表使用摘要卡片和下次触发进度，不再提供手动刷新", () => {
  const { model } = harness();
  const config = { title: "定时检查", instructions: "检查目录", workspaceId: "workspace", permission: "confirm" as const, modelSelection: selection, rule: { kind: "daily" as const, time: "09:00", timeZone: "Asia/Tokyo", disambiguation: "compatible" as const } };
  const plan: CodeSchedulePlan = { id: "plan", config, workspace: { cwd: "/work", cwdReal: "/work", dev: 1, ino: 1 }, version: 1, status: "active", nextDueAt: at, reason: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: at };
  model.scheduled.plans = [plan];
  const html = renderToStaticMarkup(createElement(Scheduled, { model, onOpenSession() {} }));
  assert.match(html, /定时检查/); assert.match(html, /检查目录/); assert.match(html, /Daily 09:00/); assert.match(html, />Active</); assert.match(html, />Archived</);
  assert.doesNotMatch(html, />Refresh|>Current plan<|>History</);
  assert.match(html, /data-slot="tabs-list"/); assert.equal(elements(html).filter(element => attr(element, "data-slot") === "tabs-trigger" && attr(element, "data-state") === "active").length, 1, "Active/Archived 只有一个选中项");
  const progress = elements(html).filter(element => attr(element, "role") === "progressbar");
  assert.equal(progress.length, 1); assert.equal(attr(progress[0], "aria-valuenow"), "100");
});

test("Scheduled 详情把下次触发、任务内容和执行设置分层展示", () => {
  const { model } = harness();
  const config = { title: "定时检查", instructions: "检查目录", workspaceId: "workspace", permission: "confirm" as const, modelSelection: selection, rule: { kind: "daily" as const, time: "09:00", timeZone: "Asia/Tokyo", disambiguation: "compatible" as const } };
  const plan: CodeSchedulePlan = { id: "plan", config, workspace: { cwd: "/work", cwdReal: "/work", dev: 1, ino: 1 }, version: 1, status: "active", nextDueAt: at, reason: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: at };
  const run: CodeScheduleRun = { id: "run", scheduleId: plan.id, planVersion: 1, snapshot: config, workspace: plan.workspace, sessionId: "session", rootTaskId: "root", scheduledAt: at, coalescedFrom: at, coalescedThrough: at, status: "active", cancelRequested: false, reason: null, version: 1, createdAt: at, closedAt: null };
  model.scheduled.selectedId = plan.id; model.scheduled.detail = { plan, runs: [run], activeRun: null, nextRunOffset: null };
  const html = renderToStaticMarkup(createElement(Scheduled, { model, onOpenSession(id) { assert.equal(id, "session"); } }));
  for (const text of ["Overview", "Runs", "Next trigger", "Task", "Run settings", "Model", "Effort", "High", "Asia/Tokyo"]) assert.match(html, new RegExp(text));
  assert.equal(attr(button(html, "Pause schedule"), "role"), "switch");
  assert.equal(attr(button(html, "Pause schedule"), "aria-checked"), "true");
  assert.equal(elements(html).filter(element => attr(element, "aria-label") === "Pause schedule").length, 1, "switch props belong only to the control, not its decorative thumb");
  assert.match(attr(button(html, "Cancel schedule"), "class")!, /is-danger/);
  assert.equal(elements(html).filter(element => attr(element, "role") === "progressbar").length, 1);
});

test("Scheduled edits the whole plan on one page and validates every field before saving", () => {
  const { model, transport } = harness();
  model.scheduled.draft = draftForSchedule({ title: "定时检查", instructions: "检查目录", workspaceId: "workspace", permission: "confirm", modelSelection: selection,
    rule: { kind: "weekly", time: "09:30", weekdays: [1, 5], timeZone: "Asia/Tokyo", disambiguation: "compatible" } });
  const render = () => renderToStaticMarkup(createElement(Scheduled, { model, onOpenSession() {} }));
  const save = (html: string) => elements(html).find(element => element.tagName === "button" && attr(element, "type") === "submit")!;
  let html = render(); assert.match(html, /scheduled-page is-form/); assert.match(html, /scheduled-back/);
  for (const text of ["Task", "Time", "Name", "Asia/Tokyo"]) assert.match(html, new RegExp(text));
  assert.doesNotMatch(html, /scheduled-steps|scheduled-review|>Continue<|>Previous</);
  assert.equal(elements(html).filter(element => element.tagName === "button" && attr(element, "aria-pressed") !== undefined).length, 10);
  assert.equal(attr(button(html, "Schedule permission"), "aria-description"), "Ask for approval");
  assert.equal(attr(button(html, "Chat model"), "aria-description"), "Current model · Effort: High");
  assert.equal(hasAttr(save(html), "disabled"), false);
  const original = structuredClone(model.scheduled.draft);
  for (const patch of [{ title: " " }, { instructions: " " }, { instructions: "界".repeat(22_000) }, { workspaceId: "" }, { modelSelection: null }, { time: "24:00" }, { weekdays: [] }, { repeat: "once" as const, date: "2000-01-01" }]) {
    model.scheduled.draft = { ...original, ...patch };
    assert.equal(hasAttr(save(render()), "disabled"), true, `Invalid ${Object.keys(patch)[0]} cannot be submitted`);
  }
  model.scheduled.draft = { ...original, instructions: "界".repeat(22_000) };
  assert.match(render(), /role="alert">Instructions are too long/);
  model.scheduled.draft = { ...original, repeat: "once", date: "2000-01-01" };
  assert.match(render(), /role="alert">A one-time schedule needs a future time/);
  model.scheduled.draft = original; model.scheduled.needsReview = true;
  assert.equal(hasAttr(save(render()), "disabled"), true);
  model.scheduled.needsReview = false; model.status = { type: "state", state: "failed" };
  html = render(); assert.equal(hasAttr(save(html), "disabled"), true);
  assert.equal(transport.requests.length, 0);
});

test("active scheduled conversations retain draft editing and commands while blocking ordinary sends and setting changes", async () => {
  const { model, current, transport } = harness();
  current.codeScheduleActive = true; current.codeScheduleRunId = "run";
  model.writes.edit(current.id, "普通输入");
  await model.writes.send(current.id); await model.writes.setModel(current, selection); await model.writes.setMode(current, "full_access");
  assert.equal(transport.requests.length, 0);
  const render = () => renderToStaticMarkup(createElement(Composer, { model, session: current }));
  let html = render();
  assert.equal(hasAttr(elements(html).find(element => element.tagName === "textarea")!, "readonly"), false);
  assert.equal(hasAttr(button(html, "Send message"), "disabled"), true);
  assert.ok(hasAttr(button(html, "Chat default mode"), "disabled")); assert.ok(hasAttr(button(html, "Chat model"), "disabled"));
  assert.doesNotMatch(html, /Resuming the interrupted task|Send and continue/);
  current.modelSelection = null;
  model.writes.edit(current.id, "/help");
  assert.equal(hasAttr(button(render(), "Send message"), "disabled"), false, "local command does not require a model or ordinary-task eligibility");
});


test("the send button resumes only a nonempty paused queue with no input", () => {
  const h = harness();
  const queued = queuedTask("q1", "queued input", 1);
  const render = () => renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  for (const queueState of ["active", "paused"] as const) for (const hasQueue of [false, true]) {
    h.current.queueState = queueState;
    h.model.view.tasks = new Map(hasQueue ? [[queued.id, queued]] : []);
    const html = render();
    const primary = elements(html).find(element => element.tagName === "button" && attr(element, "class")?.split(" ").includes("send-button"))!;
    const resumes = queueState === "paused" && hasQueue;
    assert.equal(attr(primary, "aria-label"), resumes ? "Resume queue" : "Send message");
    assert.equal(attr(primary, "type"), "submit");
    assert.equal(hasAttr(primary, "disabled"), !resumes);
    assert.equal(html.includes("lucide-play"), resumes);
    assert.equal(elements(html).filter(element => element.tagName === "button" && attr(element, "aria-label") === "Resume queue").length, resumes ? 1 : 0);
    assert.doesNotMatch(html, /Queue paused|tasks waiting to resume/);
    assert.match(attr(button(html, "Context usage"), "aria-haspopup")!, /dialog/);
  }
  h.current.queueState = "paused";
  h.model.view.tasks.set(queued.id, queued);
  for (const draft of [{ text: "new queued input", attachments: [] }, { text: "", attachments: [{ id: "attachment", name: "input.txt", size: 10 }] }]) {
    Object.assign(h.model.writes.draft(h.current.id), draft);
    const html = render();
    assert.ok(button(html, "Send message"));
    assert.equal(hasAttr(button(html, "Send message"), "disabled"), false);
    assert.match(html, /lucide-arrow-up/);
    assert.doesNotMatch(html, /lucide-play/);
    assert.equal(button(html, "Resume queue"), undefined);
  }
});

test("queue resume retains fixed task models and composer locks while Stop takes priority", () => {
  const h = harness();
  h.current.queueState = "paused";
  const queued = queuedTask("q1", "queued input", 1);
  h.model.view.tasks.set(queued.id, queued);
  const render = () => renderToStaticMarkup(createElement(Composer, { model: h.model, session: h.current }));
  h.current.modelSelection = null;
  assert.equal(hasAttr(button(render(), "Resume queue"), "disabled"), false, "fixed queued models do not require a current selection");
  h.model.writes.busy.add(h.current.id);
  assert.equal(hasAttr(button(render(), "Resume queue"), "disabled"), true);
  h.model.writes.busy.clear();
  h.model.status = { type: "state", state: "reconnecting" };
  assert.equal(hasAttr(button(render(), "Resume queue"), "disabled"), true);
  h.model.status = { type: "state", state: "online" };
  h.model.writes.draft(h.current.id).attaching = true;
  assert.equal(hasAttr(button(render(), "Resume queue"), "disabled"), true);
  h.model.writes.draft(h.current.id).attaching = false;
  h.current.codeScheduleActive = true;
  let html = render();
  assert.equal(button(html, "Resume queue"), undefined);
  assert.equal(hasAttr(button(html, "Send message"), "disabled"), true);
  h.current.codeScheduleActive = false;
  const active = { ...queuedTask("active", "running input", 0), status: "running" as const };
  h.model.view.tasks.set(active.id, active);
  html = render();
  assert.equal(button(html, "Resume queue"), undefined);
  assert.equal(hasAttr(button(html, "Stop task"), "disabled"), false);
  assert.match(html, /lucide-square/);
  h.current.modelSelection = selection;
  h.model.writes.edit(h.current.id, "normal queued input");
  html = render();
  assert.equal(hasAttr(button(html, "Send message"), "disabled"), false);
  assert.doesNotMatch(html, /Send as guidance|lucide-play/);
});

test("text and attachment submissions preserve a paused queue without resuming it", async () => {
  const requests: Record<string, unknown>[] = [];
  const h = harness({}, async (_target, op, params) => {
    assert.equal(op, "submit");
    assert.ok(typeof params.request_id === "string" && typeof params.input === "string");
    requests.push(params);
    return { ok: true, value: { kind: "accepted", requestId: params.request_id, task: queuedTask(`submitted-${params.request_id}`, params.input, 2) } };
  });
  h.current.queueState = "paused";
  const queued = queuedTask("q1", "queued input", 1);
  h.model.view.tasks.set(queued.id, queued);
  const attachment = { id: "attachment", name: "input.txt", size: 10 };
  for (const draft of [{ text: "normal queued input", attachments: [] }, { text: "", attachments: [attachment] }]) {
    Object.assign(h.model.writes.draft(h.current.id), draft);
    await h.model.writes.send(h.current.id);
    assert.equal(h.current.queueState, "paused");
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input, "normal queued input");
  assert.equal(requests[1].input, "");
  assert.deepEqual(requests[1].attachments, [attachment]);
});

function commandHandler(model: CodeState, current: Session, actions = { onNew() {}, onSkills() {} }) {
  let execute!: () => Promise<void>;
  function Capture() {
    const commands = useComposerCommands({ model, session: current, text: model.writes.draft(current.id).text, edit: text => model.writes.edit(current.id, text), input: { current: null }, locked: false, ...actions });
    execute = commands.execute;
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  return execute;
}

test("closing command help returns keyboard focus to the composer", () => {
  const h = harness();
  let help: ReactNode, focused = 0, prevented = 0;
  const textarea = { focus() { ++focused; } } as HTMLTextAreaElement;
  function Capture() {
    help = useComposerCommands({ model: h.model, session: h.current, text: "/help", edit() {}, input: { current: textarea }, locked: false }).help;
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  assert.ok(isValidElement<{ children?: ReactNode }>(help));
  const content = help.props.children;
  assert.ok(isValidElement<{ onCloseAutoFocus: (event: { preventDefault(): void }) => void }>(content));
  content.props.onCloseAutoFocus({ preventDefault() { ++prevented; } });
  assert.equal(focused, 1);
  assert.equal(prevented, 1);
});

test("application commands preserve attachments and never submit an owner task", async () => {
  const h = harness();
  const attachment = { id: "file", name: "notes.txt", size: 12 };
  const draft = h.model.writes.draft(h.current.id);
  draft.attachments = [attachment];
  h.current.modelSelection = null;
  let openedNew = 0, openedSkills = 0;
  for (const text of ["/help", "/model", "/mode", "/new", "/skills"]) {
    draft.text = text;
    await commandHandler(h.model, h.current, { onNew() { ++openedNew; }, onSkills() { ++openedSkills; } })();
    assert.equal(draft.text, "");
    assert.deepEqual(draft.attachments, [attachment]);
  }
  assert.equal(openedNew, 1); assert.equal(openedSkills, 1);
  assert.equal(h.transport.requests.length, 0);
});

test("invalid and unavailable commands retain text and attachments with feedback", async () => {
  const h = harness(), draft = h.model.writes.draft(h.current.id);
  const attachment = { id: "file", name: "notes.txt", size: 12 };
  draft.attachments = [attachment];
  for (const text of ["/model extra", "/new extra", "/skill:"]) {
    draft.text = text;
    await commandHandler(h.model, h.current)();
    assert.equal(draft.text, text);
    assert.ok(h.model.writes.message);
    assert.deepEqual(draft.attachments, [attachment]);
  }
  for (const text of ["/model", "/compact keep details", "/branch named"]) {
    h.model.status = { type: "state", state: "reconnecting" };
    draft.text = text;
    await commandHandler(h.model, h.current)();
    assert.equal(draft.text, text);
    assert.match(h.model.writes.message!, /Reconnect/);
  }
  h.model.status = { type: "state", state: "online" };
  h.current.codeScheduleActive = true;
  for (const text of ["/model", "/mode", "/compact", "/branch named"]) {
    draft.text = text;
    await commandHandler(h.model, h.current)();
    assert.equal(draft.text, text);
    assert.ok(h.model.writes.message);
  }
  h.current.codeScheduleActive = false;
  for (const status of ["queued", "running"] as const) {
    h.model.view.tasks.set("busy", { ...queuedTask("busy", "earlier input", 1), status });
    draft.text = "/compact keep details";
    await commandHandler(h.model, h.current)();
    assert.equal(draft.text, "/compact keep details");
    assert.match(h.model.writes.message!, /idle ordinary conversation/);
  }
  assert.equal(h.transport.requests.length, 0);
});

for (const command of ["compact", "branch"] as const) test(`late /${command} admission preserves replacement input and executes once`, async () => {
  const h = harness(), draft = h.model.writes.draft(h.current.id);
  draft.text = `/${command} focus`;
  draft.attachments = [{ id: "file", name: "notes.txt", size: 12 }];
  let calls = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  if (command === "compact") h.model.compactions.start = async (_sessionId, prompt) => { assert.equal(prompt, "focus"); ++calls; await hold; return true; };
  else h.model.branch = async (_sessionId, taskId, name) => { assert.equal(taskId, undefined); assert.equal(name, "focus"); ++calls; await hold; return true; };
  const execute = commandHandler(h.model, h.current);
  const pending = execute();
  await execute();
  h.model.writes.edit(h.current.id, "next task\nwith details");
  release(); await pending;
  assert.equal(calls, 1);
  assert.equal(draft.text, "next task\nwith details");
  assert.equal(draft.attachments?.[0].id, "file");
  assert.equal(h.transport.requests.length, 0);
});
